#!/usr/bin/env node
/**
 * Compaction wait wiring check. Run: npx tsx tools/compaction-wait-check.ts
 *
 * `tools/lag-check.ts` pins the policy; this pins the wiring the policy sits inside, which a unit
 * test cannot see:
 *
 *   - a compaction that arrives while a write is in flight waits for it, and the boundary that ends
 *     the hook is the one recomputed from the landed write — `firstKeptEntryId` is the new cursor
 *     and `boundary: cursor`, where the same shape without the wait returns `undefined`;
 *   - a wait that misses its budget ends in one `compact_deferred`, not a second wait;
 *   - an aborted signal stops the wait;
 *   - overflow produces its own summary and is never considered for a wait;
 *   - an unhealthy writer, the rollback switch and an ETA past the budget each skip, and the reason
 *     is audited rather than lost;
 *   - a branch that is already safe is untouched: no wait, no skip line, no notification.
 *
 * The writer is a stub registry whose `complete` blocks on a gate the test opens, so "in flight" is
 * a state the test controls rather than a race it hopes to win.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hy-compaction-wait-"));
process.env.PI_HY_MEMORY_STATE = join(dir, "state");
process.env.PI_HY_MEMORY_CONFIG = join(dir, "config.json");

const { default: piHyMemory } = await import("../src/index.js");

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const auditOf = (sessionId: string): Record<string, unknown>[] => {
	try {
		return readFileSync(join(process.env.PI_HY_MEMORY_STATE as string, "audit.ndjson"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((row) => row.sessionId === sessionId);
	} catch {
		return [];
	}
};
const mirrorLedger = (sessionId: string): Record<string, unknown>[] => {
	try {
		const path = join(process.env.PI_HY_MEMORY_STATE as string, "sessions", `${sessionId}.ledger.jsonl`);
		return readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
};
const waitLines = (sessionId: string) => auditOf(sessionId).filter((r) => r.event === "compact_wait");
const skipLines = (sessionId: string) => auditOf(sessionId).filter((r) => r.event === "compact_wait_skipped");
const deferredLines = (sessionId: string) => auditOf(sessionId).filter((r) => r.event === "compact_deferred");

/** The watermark the mirror ledger last claims. */
const cursorOf = (sessionId: string): string | undefined => {
	const records = mirrorLedger(sessionId);
	for (let i = records.length - 1; i >= 0; i--) {
		const id = records[i].coversUpToId;
		if (typeof id === "string") return id;
	}
	return undefined;
};

/** A gate the test opens: the writer call waits on it, so a write is in flight on demand. */
const gate = () => {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

type WriterBehaviour = {
	/** The extract call: waits on a gate, or throws. */
	extract: { gate: ReturnType<typeof gate> } | { throws: string };
	/** The reconcile call: waits on a gate, or answers immediately. */
	reconcile: { gate: ReturnType<typeof gate> } | null;
};

const EXTRACT = {
	drafts: [{ task: "settings", statement: "settings live in one JSON file", keys: ["settings"], refs: [0] }],
};
const RECONCILE = { ops: [{ action: "ADD", draft: 0, reason: "settled decision" }] };

/** ~`tokens` tokens of rendered user text (chars/4, plus the `[User @ hh:mm]: ` prefix). */
let seq = 0;
let recSeq = 0;
const message = (id: string, tokens: number) => ({
	id,
	type: "message",
	parentId: null,
	timestamp: new Date(1700000000000 + seq++).toISOString(),
	message: { role: "user", content: "x".repeat(tokens * 4) },
});

/** One completed write's timings, as the ledger records them (`usage.wallS`, seconds). */
const seededPair = (chunkId: string, extractWallS: number, opsWallS: number) => [
	{
		id: `c-${chunkId}-extract`,
		type: "custom",
		customType: "hy.extract",
		data: {
			type: "hy.extract",
			chunkId,
			coversUpToId: "e-src-1",
			createdAt: "2026-10-26T00:00:00.000Z",
			drafts: [
				{
					task: "writer",
					statement: "a fact already in the bank",
					keys: ["writer"],
					refs: [0],
					sourceEntryIds: ["e-src-1"],
				},
			],
			rejectedCount: 0,
			usage: { inTokens: 1, outTokens: 1, wallS: extractWallS },
		},
	},
	{
		id: `c-${chunkId}-ops`,
		type: "custom",
		customType: "hy.ops",
		data: {
			type: "hy.ops",
			chunkId,
			coversUpToId: "e-src-1",
			createdAt: "2026-10-26T00:00:00.000Z",
			ops: [{ action: "ADD", draft: 0 }],
			rejectedCount: 0,
			usage: { inTokens: 1, outTokens: 1, wallS: opsWallS },
		},
	},
];

/** One covered entry plus an unread backlog. The seeded pair also seeds the ETA medians. */
const branchWith = (pending: number, tokens: number, extractWallS = 158, opsWallS = 30) => [
	message("e-src-1", 8),
	...seededPair("hy-01234567-001", extractWallS, opsWallS),
	...Array.from({ length: pending }, (_, i) => message(`p${i}`, tokens)),
];

type Scenario = {
	sessionId: string;
	config?: Record<string, unknown>;
	branch?: unknown[];
	/** pi's own cut, deliberately past the watermark. */
	proposedId?: string;
	reason?: "manual" | "threshold" | "overflow";
	/** Start a write at `turn_end`, let its extract answer, and leave the reconcile running. */
	startWrite?: boolean;
	/** Fired while the hook is waiting. */
	abortAfterMs?: number;
	/** Opens the reconcile gate while the hook is waiting, so the write lands. */
	resolveReconcileAfterMs?: number;
	/** The extract call throws instead of answering. */
	firstExtractFails?: boolean;
};

type Run = {
	notices: { text: string; kind: string }[];
	calls: string[];
	compact: () => Promise<{ compaction?: Record<string, unknown> } | undefined>;
	status: () => Promise<void>;
	turnEnd: () => Promise<void>;
	waitFor: (predicate: () => boolean, ms?: number) => Promise<boolean>;
	setBehaviour: (behaviour: WriterBehaviour) => void;
};

const runScenario = async (scenario: Scenario): Promise<Run> => {
	const notices: { text: string; kind: string }[] = [];
	const calls: string[] = [];
	let command: { handler: (args: string, ctx: unknown) => Promise<void> } | null = null;
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
		registerTool: () => {},
		registerCommand: (_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			command = def;
		},
		// Like pi's real `appendEntry`, a record lands on the branch as a custom entry — which is
		// what makes the hook recompute the branch instead of trusting pi's stale token count.
		appendEntry: (type: string, data: unknown) => {
			branch.push({
				id: `rec-${recSeq++}`,
				type: "custom",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: type,
				data,
			});
		},
	};

	// Mutable, because one scenario needs two attempts with different behaviour: one that fails, so
	// the writer is unhealthy, and one that hangs, so a write is in flight on top of that.
	const control: { behaviour: WriterBehaviour } = {
		behaviour: { extract: { gate: gate() }, reconcile: { gate: gate() } },
	};
	const registry = {
		getAll: () => [{ provider: "test", id: "writer", api: "openai-completions" }],
		refresh: async () => undefined,
		getApiKeyAndHeaders: async () => ({ ok: true }),
		async complete(_model: unknown, _context: unknown, params: { sessionId: string }) {
			const behaviour = control.behaviour;
			const isReconcile = String(params.sessionId).startsWith("reconcile");
			calls.push(isReconcile ? "reconcile" : "extract");
			const extract = behaviour.extract;
			if (!isReconcile && "throws" in extract) throw new Error(extract.throws);
			if (isReconcile && behaviour.reconcile) await behaviour.reconcile.gate.promise;
			if (!isReconcile && "gate" in extract) await extract.gate.promise;
			return {
				role: "assistant",
				content: [{ type: "text", text: JSON.stringify(isReconcile ? RECONCILE : EXTRACT) }],
				stopReason: "stop",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
			};
		},
	};

	const branch = scenario.branch ?? branchWith(40, 500);
	const ctx = {
		sessionManager: {
			getSessionId: () => scenario.sessionId,
			getBranch: () => branch,
			getEntry: (id: string) => branch.find((e) => (e as { id: string }).id === id),
		},
		hasUI: true,
		ui: {
			setStatus: () => {},
			notify: (text: string, kind: string) => notices.push({ text, kind }),
			theme: { fg: (_c: string, t: string) => t },
		},
		modelRegistry: registry,
		thinkingLevel: "off",
	};

	// The config is read inside `piHyMemory`, so each scenario is its own extension instance.
	writeFileSync(
		process.env.PI_HY_MEMORY_CONFIG as string,
		JSON.stringify({
			model: "test/writer",
			observeAfterTokens: 15_500,
			maxChunkTokens: 6000,
			maxEntryChars: 4000,
			keepRecentTokens: 2000,
			// Nothing here waits on a real writer, and a settled window must not chain a second
			// write into the scenario.
			timeoutMs: 60_000,
			writeCooldownS: 0,
			idleDrainAfterMs: 0,
			waitForWriteOnSettle: false,
			...scenario.config,
		}),
	);

	piHyMemory(pi as never);
	(handlers.get("session_start") as (e: unknown, c: unknown) => unknown)({}, ctx);
	const call = (name: string) => handlers.get(name) as (event: unknown, c: unknown) => Promise<unknown>;
	const waitFor = async (predicate: () => boolean, ms = 3000): Promise<boolean> => {
		for (let waited = 0; waited < ms; waited += 20) {
			if (predicate()) return true;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		return predicate();
	};
	const turnEnd = async (): Promise<void> => {
		await call("turn_end")({}, ctx);
	};

	if (scenario.startWrite) {
		if (scenario.firstExtractFails) control.behaviour.extract = { throws: "provider answered 502" };
		await turnEnd();
		// The extract has to answer for the writer to report its next stage; the reconcile half is
		// what the compaction then waits on.
		if (!scenario.firstExtractFails && control.behaviour.extract && "gate" in control.behaviour.extract) {
			control.behaviour.extract.gate.resolve();
		}
		await waitFor(
			() =>
				auditOf(scenario.sessionId).some((r) => r.event === "extract_persisted" || r.event === "write_error") ||
				calls.length >= 2,
			1500,
		);
		await new Promise((resolve) => setTimeout(resolve, 40));
	}

	if (scenario.resolveReconcileAfterMs !== undefined && control.behaviour.reconcile) {
		const target = control.behaviour.reconcile.gate;
		setTimeout(() => target.resolve(), scenario.resolveReconcileAfterMs);
	}
	const controller = new AbortController();
	if (scenario.abortAfterMs !== undefined) setTimeout(() => controller.abort(), scenario.abortAfterMs);

	const compact = async () =>
		(await call("session_before_compact")(
			{
				type: "session_before_compact",
				reason: scenario.reason ?? "threshold",
				// pi hands the hook a snapshot of the branch; `getBranch()` is the live one, which the
				// write has grown while the hook waited.
				branchEntries: [...branch],
				preparation: { firstKeptEntryId: scenario.proposedId ?? "p20", tokensBefore: 400_000 },
				willRetry: false,
				signal: controller.signal,
			},
			ctx,
		)) as { compaction?: Record<string, unknown> } | undefined;

	return {
		notices,
		calls,
		compact,
		status: async () => {
			if (!command) throw new Error("command not registered");
			await command.handler("", ctx);
		},
		turnEnd,
		waitFor,
		setBehaviour: (behaviour: WriterBehaviour) => {
			control.behaviour = behaviour;
		},
	};
};

/**
 * 1. The shape the live audit produced: a threshold compaction arrives while the write is in its
 *    reconcile stage, so the backlog pi would drop is seconds from being covered.
 */
{
	const sessionId = "0a0a0a0a";
	const run = await runScenario({ sessionId, startWrite: true, resolveReconcileAfterMs: 250 });
	const out = await run.compact();
	const line = waitLines(sessionId).at(-1);

	check("S1 the hook waited", waitLines(sessionId).length, 1);
	check("S1 the stage the wait was priced on", line?.stage, "reconcile");
	check("S1 the outcome", line?.outcome, "boundary_recomputed");
	check("S1 the cursor advanced", line?.cursorAdvanced, true);
	check("S1 no chained follow-up was needed", line?.chainDepth, 0);
	check("S1 it waited roughly for the write", (line?.waitedMs as number) >= 200, true);
	check("S1 the wait was announced once", run.notices.filter((n) => n.text.includes("waiting up to")).length, 1);
	check("S1 the notice names the lag", run.notices[0]?.text.includes("entries behind"), true);
	check("S1 nothing was deferred", deferredLines(sessionId).length, 0);
	check("S1 the compaction is the extension's", out?.compaction !== undefined, true);
	check("S1 firstKeptEntryId is the landed cursor", out?.compaction?.firstKeptEntryId, cursorOf(sessionId));
	check(
		"S1 the boundary is the cursor, not pi's cut",
		auditOf(sessionId).find((r) => r.event === "compact")?.boundary,
		"cursor",
	);
	check(
		"S1 the branch was recounted, not pi's stale total",
		(auditOf(sessionId).find((r) => r.event === "compact")?.tokensBefore as number) < 100_000,
		true,
	);
	check("S1 the reconcile call really ran", run.calls.includes("reconcile"), true);
}

/**
 * 2. A wait that misses its budget: one wait line, one deferral, no second attempt.
 */
{
	const sessionId = "0b0b0b0b";
	// Timings small enough that the ETA fits the budget, so the hook genuinely waits, and a
	// reconcile that never answers, so the deadline is what ends it.
	const run = await runScenario({
		sessionId,
		config: { compactWaitMs: 900 },
		branch: branchWith(40, 500, 0.5, 0.4),
		startWrite: true,
	});
	const out = await run.compact();
	const line = waitLines(sessionId).at(-1);

	check("S2 the outcome is a timeout", line?.outcome, "timeout");
	check("S2 it stopped at the budget", (line?.waitedMs as number) >= 800, true);
	check("S2 exactly one wait was attempted", waitLines(sessionId).length, 1);
	check("S2 the compaction went back to pi", out, undefined);
	check("S2 the deferral is audited once", deferredLines(sessionId).length, 1);
}

/**
 * 3. pi aborts the compaction: the wait stops and the hook returns a deferral rather than throwing.
 */
{
	const sessionId = "0c0c0c0c";
	const run = await runScenario({
		sessionId,
		config: { compactWaitMs: 5000 },
		branch: branchWith(40, 500, 0.5, 0.4),
		startWrite: true,
		abortAfterMs: 200,
	});
	const out = await run.compact();
	const line = waitLines(sessionId).at(-1);

	check("S3 the outcome is aborted", line?.outcome, "aborted");
	check("S3 the wait stopped early", (line?.waitedMs as number) < 1500, true);
	check("S3 the hook still answered normally", out, undefined);
	check("S3 the deferral is audited once", deferredLines(sessionId).length, 1);
}

/**
 * 4. Overflow: the extension produces its own summary, and a write in flight is never waited on.
 */
{
	const sessionId = "0d0d0d0d";
	const run = await runScenario({
		sessionId,
		reason: "overflow",
		startWrite: true,
		resolveReconcileAfterMs: 100,
		config: { compactWaitMs: 60_000 },
	});
	const out = await run.compact();

	check("S4 overflow produced a summary", out?.compaction !== undefined, true);
	check("S4 a write was in flight", run.calls.includes("reconcile"), true);
	check("S4 overflow was never a wait", waitLines(sessionId).length, 0);
	check("S4 overflow wrote no skip line either", skipLines(sessionId).length, 0);
	check("S4 nothing was deferred", deferredLines(sessionId).length, 0);
	check("S4 no waiting notification", run.notices.filter((n) => n.text.includes("waiting up to")).length, 0);
}

/**
 * 5. A writer that has just failed is not worth holding a compaction for, even with a write running.
 */
{
	const sessionId = "0e0e0e0e";
	const run = await runScenario({ sessionId, startWrite: true, firstExtractFails: true });
	check(
		"S5 the first attempt failed",
		auditOf(sessionId).some((r) => r.event === "write_error"),
		true,
	);

	// A second attempt now hangs on purpose, so the compaction sees an in-flight write on top of a
	// writer that is already unhealthy.
	run.setBehaviour({ extract: { gate: gate() }, reconcile: { gate: gate() } });
	await run.turnEnd();
	const out = await run.compact();

	check("S5 the reason is the writer, not the ETA", skipLines(sessionId).at(-1)?.reason, "writer unhealthy");
	check("S5 no wait was attempted", waitLines(sessionId).length, 0);
	check("S5 it deferred instead", out, undefined);
	check("S5 deferred once", deferredLines(sessionId).length, 1);
	check("S5 no waiting notification", run.notices.filter((n) => n.text.includes("waiting up to")).length, 0);
}

/**
 * 6. A backlog inside one chunk is already safe: no wait, no skip, no line.
 */
{
	const sessionId = "0f0f0f0f";
	const run = await runScenario({ sessionId, branch: branchWith(8, 250), proposedId: "p3" });
	const out = await run.compact();

	check("S6 the summary was produced", out?.compaction !== undefined, true);
	check("S6 no wait line", waitLines(sessionId).length, 0);
	check("S6 no skip line", skipLines(sessionId).length, 0);
	check("S6 nothing announced", run.notices.length, 0);
}

/**
 * 7. The rollback: `waitForWriterBeforeCompact: false` suppresses both the wait and the notice.
 */
{
	const sessionId = "10101010";
	const run = await runScenario({ sessionId, config: { waitForWriterBeforeCompact: false }, startWrite: true });
	const out = await run.compact();

	check("S7 the skip is audited", skipLines(sessionId).at(-1)?.reason, "disabled");
	check("S7 no wait happened", waitLines(sessionId).length, 0);
	check("S7 no waiting notification", run.notices.filter((n) => n.text.includes("waiting up to")).length, 0);
	check(
		"S7 the hand-off is announced anyway",
		run.notices.some((n) => n.text.includes("handed to pi")),
		true,
	);
	check("S7 the old deferral stands", out, undefined);
	check("S7 deferred once", deferredLines(sessionId).length, 1);
}

/**
 * 8. An ETA over the shared budget is skipped rather than pinning compaction on a long write.
 */
{
	const sessionId = "11111111";
	const run = await runScenario({ sessionId, config: { compactWaitMs: 1000 }, startWrite: true });
	const out = await run.compact();
	const skipped = skipLines(sessionId).at(-1);

	check("S8 the reason is the ETA", skipped?.reason, "eta over budget");
	check("S8 the ETA that caused it is recorded", skipped?.etaS, 30);
	check("S8 no wait happened", waitLines(sessionId).length, 0);
	check("S8 no waiting notification", run.notices.filter((n) => n.text.includes("waiting up to")).length, 0);
	check(
		"S8 the hand-off is announced anyway",
		run.notices.some((n) => n.text.includes("handed to pi")),
		true,
	);
	check("S8 it deferred instead", out, undefined);
}

/**
 * 9. `/hy` status carries the same lag the notification does, because the wait is otherwise
 *    invisible between compactions.
 */
{
	const sessionId = "12121212";
	const run = await runScenario({ sessionId, startWrite: true });
	await run.status();
	const text = run.notices.at(-1)?.text ?? "";

	// 29, not 40: the chunk in flight (11 entries, ~5 500 tokens of the 6 000 budget) is already
	// claimed by its extract record, and the writer's own records past the watermark are not
	// unread conversation.
	check("S9 the status line shows the backlog", text.includes("unread 29 entries"), true);
	check("S9 and the stage the write is in", text.includes("reconcile"), true);
	check("S9 and the estimate", text.includes("~30s left"), true);
}

/**
 * 10. Nothing unread: the line stays exactly as it was.
 */
{
	const sessionId = "13131313";
	const run = await runScenario({
		sessionId,
		branch: [message("e-src-1", 8), ...seededPair("hy-01234567-001", 158, 30)],
	});
	await run.status();

	check("S10 a covered branch adds no lag text", (run.notices.at(-1)?.text ?? "").includes("unread"), false);
}
console.log(failures === 0 ? "ok: compaction wait" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
