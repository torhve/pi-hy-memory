#!/usr/bin/env node
/**
 * Flush write check: run: npx tsx tools/flush-write-check.ts
 *
 * `tools/flush-tool-check.ts` deliberately runs against an unreachable writer, because the tool has
 * to answer before the model call. That leaves the useful half unproven: a queued flush has to
 * actually reach the bank, and `hy_recall` has to answer from it. This check drives the whole path
 * with a stub registry that answers both stages, so the claim "the model can fold settled work into
 * the bank a turn earlier" is tested rather than assumed.
 *
 * What is pinned here:
 *   - a ranged flush runs extract + reconcile once each and lands a fact in the bank;
 *   - the write is awaited by nothing in the tool call, and the ledger advances the watermark;
 *   - a flush of an already-covered window writes nothing;
 *   - a second call while a write is in flight is refused and queues nothing;
 *   - `hy_recall` answers from the fact the flush wrote.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hy-flush-write-check-"));
process.env.PI_HY_MEMORY_STATE = join(dir, "state");
process.env.PI_HY_MEMORY_CONFIG = join(dir, "config.json");

writeFileSync(
	join(dir, "config.json"),
	JSON.stringify({
		model: "test/writer",
		observeAfterTokens: 100_000,
		writeCooldownS: 0,
		timeoutMs: 5000,
		flushMinTokens: 0,
	}),
);

const { default: piHyMemory } = await import("../src/index.js");

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};
const has = (name: string, text: string, needle: string): void => check(name, text.includes(needle), true);

const STATEMENT = "Settings live in one JSON file under the agent directory, missing file means defaults.";

const message = (id: string, role: string, content: string) => ({ type: "message", id, message: { role, content } });
const branch = [
	message("e1", "user", "Decide where this CLI keeps its settings."),
	message("e2", "assistant", "One JSON file under the agent directory, and a missing file means all defaults."),
	message("e3", "user", "Write it down so a reload does not lose it."),
	message("e4", "assistant", "Merging over built-in defaults keeps a malformed file from emptying the bank."),
];

const extractRecord = {
	type: "hy.extract",
	chunkId: "hy-01234567-000",
	coversUpToId: "e1",
	createdAt: "2026-10-21T00:00:00.000Z",
	drafts: [{ task: "settings location", statement: "settings were already decided", keys: ["settings"], refs: [0] }],
	rejectedCount: 0,
	usage: { inTokens: 1, outTokens: 1, wallS: 1 },
};
const opsRecord = {
	type: "hy.ops",
	chunkId: "hy-01234567-000",
	coversUpToId: "e1",
	createdAt: "2026-10-21T00:00:00.000Z",
	ops: [{ action: "ADD", draft: 0 }],
	rejectedCount: 0,
	usage: { inTokens: 1, outTokens: 1, wallS: 1 },
};

const log: { calls: { label: string }[] } = { calls: [] };

/** Answers both writer stages: extract returns one draft, reconcile adds it. */
const registry = {
	getAll: () => [{ provider: "test", id: "writer", api: "openai-completions" }],
	refresh: async () => undefined,
	getApiKeyAndHeaders: async () => ({ ok: true }),
	async complete(_model: unknown, _opts: unknown, params: { sessionId: string }) {
		// A short delay, so "in flight" is a state the second call can actually observe rather than
		// a race with an instant stub. It is awaited before the call is recorded, so a count of
		// `log.calls` means a stage that *finished* — the tool must answer while the write runs.
		await new Promise((resolve) => setTimeout(resolve, 60));
		log.calls.push({ label: params.sessionId });
		const isReconcile = params.sessionId.startsWith("reconcile");
		const text = isReconcile
			? JSON.stringify({ ops: [{ action: "ADD", draft: 0, reason: "settled decision" }] })
			: JSON.stringify({
					drafts: [
						{
							task: "where settings live",
							statement: STATEMENT,
							keys: ["settings", "config"],
							refs: [0],
						},
					],
				});
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: "stop",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
		};
	},
};

const faux = () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const tools = new Map<string, ToolDef>();
	return {
		pi: {
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
			registerTool: (def: ToolDef) => tools.set(def.name, def),
			registerCommand: () => {},
			appendEntry: () => {},
		},
		handlers,
		tools,
	};
};

type ToolDef = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
};

const ctx = {
	sessionManager: {
		getSessionId: () => "01234567",
		getBranch: () => [
			{ id: "c0", type: "custom", customType: "hy.extract", data: extractRecord },
			{ id: "c1", type: "custom", customType: "hy.ops", data: opsRecord },
			...branch,
		],
		getEntry: (id: string) => branch.find((e) => e.id === id),
	},
	hasUI: false,
	ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_c: string, t: string) => t } },
	modelRegistry: registry,
	thinkingLevel: "off",
};

const bankPath = join(process.env.PI_HY_MEMORY_STATE as string, "sessions", "01234567.bank.json");
const bank = (): string => {
	try {
		return readFileSync(bankPath, "utf8");
	} catch {
		return "";
	}
};
const ledgerOps = (): number => {
	try {
		return readFileSync(join(process.env.PI_HY_MEMORY_STATE as string, "sessions", "01234567.ledger.jsonl"), "utf8")
			.split("\n")
			.filter((line) => line.includes('"hy.ops"')).length;
	} catch {
		return 0;
	}
};
/** The write runs in the background; wait for it to land rather than asserting on a race. */
const waitFor = async (predicate: () => boolean, ms = 4000): Promise<boolean> => {
	for (let waited = 0; waited < ms; waited += 100) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return predicate();
};
const audit = (): Record<string, unknown>[] =>
	readFileSync(join(process.env.PI_HY_MEMORY_STATE as string, "audit.ndjson"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);

const run = faux();
piHyMemory(run.pi as never);
const flush = () => run.tools.get("hy_flush") as ToolDef;
const recall = () => run.tools.get("hy_recall") as ToolDef;
const textOf = async (params: Record<string, unknown>): Promise<string> => {
	const result = await flush().execute("t", params, undefined, undefined, ctx);
	return result.content.map((b) => b.text).join("\n");
};

(run.handlers.get("session_start") as (e: unknown, c: unknown) => unknown)(undefined, ctx);

// 1. A bare call lists the window the writer has not read; nothing is written by listing.
const listing = await textOf({});
check("the listing shows the unwritten entries", listing.includes("[0] assistant:"), true);
check("listing writes nothing", [log.calls.length, ledgerOps()], [0, 0]);

// 2. A ranged flush queues and answers before the writer has finished, and a second call while
//    that write is in flight is refused rather than stacked.
const started = Date.now();
const queued = await flush().execute("t1", { to: 1 }, undefined, undefined, ctx);
const queuedMs = Date.now() - started;
has("the call reports a queued write", queued.content[0].text, "queued: entries [0]\u2013[1]");
check("the tool answered before the writer finished", queuedMs < 60, true);
check("no stage had finished when the tool answered", log.calls.length, 0);
const busy = await textOf({ to: 3 });
has("a busy writer refuses the second call", busy, "write in flight");
check("the refusal queued no further stage", log.calls.length, 0);

// 3. The queued write reaches the bank and the ledger advances.
check("the flush landed a fact in the bank", await waitFor(() => bank().includes(STATEMENT)), true);
const stages = (kind: string) => log.calls.filter((c) => c.label.startsWith(kind)).length;
check("both stages ran once", [stages("extract"), stages("reconcile")], [1, 1]);
check("the ledger advanced by one ops record", await waitFor(() => ledgerOps() === 2), true);

// 4. `hy_recall` answers from the fact the flush wrote.
const found = await recall().execute("t2", { query: "where settings live" }, undefined, undefined, ctx);
has("hy_recall answers the flushed fact", found.content.map((b) => b.text).join("\n"), STATEMENT.slice(0, 40));

// 5. Flushing the rest covers the window; from there the tool has nothing left to do.
await flush().execute("t3", { to: 9 }, undefined, undefined, ctx);
check("the rest of the window was written", await waitFor(() => stages("reconcile") === 2 && ledgerOps() === 3), true);
has("a covered window is listed as covered", await textOf({}), "Nothing is unwritten");
const empty = await textOf({ to: 3 });
has("a covered window refuses a ranged call", empty, "nothing is unwritten");
check("neither ran a writer stage", [stages("extract"), stages("reconcile")], [2, 2]);

const skipped = audit().filter((a) => a.event === "flush_skipped");
check("the busy refusal is audited", skipped.length >= 1, true);
check("the refusal named the reason", skipped[0]?.reason, "write in flight");

console.log(log.calls.map((c) => c.label).join(" | "));
console.log(failures === 0 ? "ok: flush write" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
