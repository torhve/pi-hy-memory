#!/usr/bin/env node
/**
 * Compaction hook check. Run: npx tsx tools/compaction-hook-check.ts
 *
 * `compaction-window-check` covers the boundary maths; this covers the wiring
 * that the maths depends on and that a unit test cannot see:
 *
 *   - pi's own cut (`preparation.firstKeptEntryId`) is what the boundary is
 *     measured against, and its real `tokensBefore` is what gets returned and
 *     audited, not our clipped estimate;
 *   - when the clamp gives way, a `hy.gap` record reaches the mirrored ledger,
 *     so a later reload resumes coverage at the right entry instead of claiming
 *     the lost range.
 *
 * Both were silent failure modes: a wrong field name would leave the old
 * behaviour intact while the unit tests stayed green.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hy-compaction-hook-"));
process.env.PI_HY_MEMORY_STATE = join(dir, "state");
process.env.PI_HY_MEMORY_CONFIG = join(dir, "config.json");
// A bank is required for the hook to answer at all.
writeFileSync(process.env.PI_HY_MEMORY_CONFIG, JSON.stringify({ model: "test/writer", timeoutMs: 1000 }));

const { default: piHyMemory } = await import("../src/index.js");

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
const pi = {
	on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
	registerTool: () => {},
	registerCommand: () => {},
};

/** ~`tokens` tokens of rendered user text. */
let seq = 0;
const message = (id: string, tokens: number) => ({
	id,
	type: "message",
	parentId: null,
	timestamp: new Date(1700000000000 + seq++).toISOString(),
	message: { role: "user", content: "x".repeat(tokens * 4) },
});

const extractRecord = {
	type: "hy.extract",
	chunkId: "hy-01234567-001",
	coversUpToId: "e-src-1",
	createdAt: "2026-10-18T00:00:00.000Z",
	drafts: [
		{
			task: "writer",
			statement: "the writer model answers on the primary endpoint",
			keys: ["writer"],
			confidence: 1,
			refs: [0],
			sourceEntryIds: ["e-src-1"],
		},
	],
	rejectedCount: 0,
	usage: { inTokens: 1, outTokens: 1, wallS: 1 },
};
const opsRecord = {
	type: "hy.ops",
	chunkId: "hy-01234567-001",
	coversUpToId: "e-src-1",
	createdAt: "2026-10-18T00:00:00.000Z",
	ops: [{ action: "ADD", draft: 0 }],
	rejectedCount: 0,
	usage: { inTokens: 1, outTokens: 1, wallS: 1 },
};

function branchWith(pending: number): unknown[] {
	return [
		{ id: "e-src-1", type: "message", message: { role: "user", content: "covered history" } },
		{ id: "c1", type: "custom", customType: "hy.extract", data: extractRecord },
		{ id: "c2", type: "custom", customType: "hy.ops", data: opsRecord },
		...Array.from({ length: pending }, (_, i) => message(`p${i}`, 200)),
	];
}

const start = (sessionId: string, branch: unknown[]) => {
	const ctx = {
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
			getEntry: () => undefined,
		},
		ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_c: string, t: string) => t } },
	};
	(handlers.get("session_start") as (e: unknown, c: unknown) => unknown)({}, ctx);
	return ctx;
};

const compact = (ctx: unknown, branch: unknown[], firstKeptEntryId: string, tokensBefore: number) =>
	(handlers.get("session_before_compact") as (e: unknown, c: unknown) => unknown)(
		{
			type: "session_before_compact",
			reason: "threshold",
			branchEntries: branch,
			preparation: { firstKeptEntryId, tokensBefore },
			willRetry: false,
		},
		ctx,
	) as { compaction: { firstKeptEntryId: string; tokensBefore: number } } | undefined;

const ledgerPath = (sessionId: string) =>
	join(process.env.PI_HY_MEMORY_STATE as string, "sessions", `${sessionId}.ledger.jsonl`);
const readLedger = (sessionId: string) =>
	readFileSync(ledgerPath(sessionId), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);

piHyMemory(pi as never);
check(
	"session_start and session_before_compact are registered",
	[handlers.has("session_start"), handlers.has("session_before_compact")],
	[true, true],
);

// 1. A backlog worth more than one chunk: pi's cut wins, and the loss is recorded.
{
	const sessionId = "01234567";
	const branch = branchWith(400); // ~80 000 estimated tokens pending
	const ctx = start(sessionId, branch);
	const proposed = "p367"; // pi keeps its own ~6 000-token tail
	const out = compact(ctx, branch, proposed, 98765);
	check("pi's boundary is used", out?.compaction.firstKeptEntryId, proposed);
	check("pi's real tokensBefore is returned", out?.compaction.tokensBefore, 98765);

	const gap = readLedger(sessionId).at(-1) as Record<string, unknown>;
	check("gap lands in the mirrored ledger", gap?.type, "hy.gap");
	check("gap names where coverage resumes", gap?.fromId, proposed);
	check("gap keeps the old watermark", gap?.coversUpToId, "e-src-1");
	check("gap counts the dropped entries", gap?.entries, 370);
}

// 2. A small backlog is still held: nothing is dropped for a few entries, and no
//    gap is invented.
{
	const sessionId = "89abcdef";
	const branch = branchWith(10); // ~2 000 tokens pending, under maxChunkTokens
	const ctx = start(sessionId, branch);
	const out = compact(ctx, branch, "p3", 4242);
	check("small backlog clamps to the watermark", out?.compaction.firstKeptEntryId, "e-src-1");
	check(
		"no gap for a small backlog",
		readLedger(sessionId).some((r) => r.type === "hy.gap"),
		false,
	);
}

console.log(failures === 0 ? "ok: compaction hook" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
