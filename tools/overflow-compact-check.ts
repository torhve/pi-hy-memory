#!/usr/bin/env node
/**
 * Overflow compaction check: run: npx tsx tools/overflow-compact-check.ts
 *
 * A compaction that leaves the next request oversized is not a recovery. Session 01a15d4e
 * (2026-10-21) is the case this pins: the writer's cursor lagged behind a 371 k-token session, the
 * boundary clamped to that cursor and kept a ~300 k-token tail, the extension reported a 5 041-token
 * summary, and the provider answered the retry with 400 "request exceeds the context window"
 * (196 608). Deferring to pi made it worse rather than better: pi's summariser has to send that same
 * oversized conversation to compress it, so both attempts failed and the session was unrecoverable.
 *
 * Pinned here:
 *   - the window is split between the kept tail, the summary and the digest before any of them is
 *     built, so the retry fits;
 *   - the kept tail is cut to its share even when that is past the writer's watermark;
 *   - what the cut removed while still unread is digested into the summary, bounded before counting;
 *   - the cut is recorded as an `hy.gap` and coverage resumes at the first kept entry;
 *   - overflow never defers to pi, while a manual compaction still does when it would drop unread
 *     entries;
 *   - a tail that fits is left alone, and a model with no known window keeps the old behaviour.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "../src/types.js";

const dir = mkdtempSync(join(tmpdir(), "hy-overflow-compact-check-"));
process.env.PI_HY_MEMORY_STATE = join(dir, "state");
process.env.PI_HY_MEMORY_CONFIG = join(dir, "config.json");
writeFileSync(
	join(dir, "config.json"),
	JSON.stringify({
		model: "test/writer",
		observeAfterTokens: 100_000,
		keepRecentTokens: 6000,
		summaryMaxTokens: 8000,
		overflowDigestTokens: 1500,
		maxChunkTokens: 6000,
	}),
);

const { default: piHyMemory } = await import("../src/index.js");
const { compactionBoundary, entryTokens } = await import("../src/entries.js");

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};
const has = (name: string, text: string, needle: string): void => check(name, text.includes(needle), true);

const stamp = (id: string, content: string, index: number): SessionEntry =>
	({
		type: "message",
		id,
		timestamp: 1_760_000_000_000 + index,
		message: { role: "user", content },
	}) as unknown as SessionEntry;
/** Roughly 1 000 estimated tokens. */
const fat = (id: string, index: number): SessionEntry => stamp(id, `${id} ${"x".repeat(4000)}`, index);
const thin = (id: string, index: number): SessionEntry => stamp(id, id, index);

// 1. The pure rule.
const branch: SessionEntry[] = [thin("c0", 0), ...Array.from({ length: 10 }, (_, i) => fat(`e${i}`, i + 1))];
const allTokens = branch.reduce((sum, e) => sum + entryTokens(e), 0);

check(
	"a tail within the budget is untouched",
	compactionBoundary(branch, {
		cursorId: "c0",
		keepRecentTokens: 100_000,
		maxUncoveredTokens: 6000,
		maxKeepTokens: allTokens,
	}),
	{ firstKeptIndex: 0, used: allTokens, boundary: "cursor" },
);

const trimmed = compactionBoundary(branch, {
	cursorId: "c0",
	keepRecentTokens: 100_000,
	maxUncoveredTokens: 6000,
	maxKeepTokens: 3000,
});
check("a tail over the budget is cut", trimmed.trimmed?.entries, 9);
check(
	"the cut keeps the newest entries",
	branch.slice(trimmed.firstKeptIndex).map((e) => e.id),
	["e8", "e9"],
);
check("the kept tail fits", trimmed.used <= 3000, true);
check("the trimmed range is named", [trimmed.trimmed?.fromId, trimmed.trimmed?.toId], ["c0", "e7"]);

check(
	"no budget means no trim",
	compactionBoundary(branch, { cursorId: "c0", keepRecentTokens: 100_000, maxUncoveredTokens: 6000 }).trimmed,
	undefined,
);

// The newest entry is never dropped: pi needs a real entry id to cut at.
const lastResort = compactionBoundary([thin("c0", 0), fat("huge", 1)], {
	cursorId: "c0",
	keepRecentTokens: 100_000,
	maxUncoveredTokens: 6000,
	maxKeepTokens: 100,
});
check("the newest entry survives even when it alone is oversized", lastResort.firstKeptIndex, 1);
check("everything older is reported as trimmed", lastResort.trimmed?.entries, 1);

// 2. The hook. The bank exists (one fact, from the ledger records in the branch).
const extractRecord = {
	type: "hy.extract",
	chunkId: "hy-01234567-001",
	coversUpToId: "e1",
	createdAt: "2026-10-21T00:00:00.000Z",
	drafts: [
		{
			task: "settings",
			statement: "settings live in one JSON file under the agent directory",
			keys: ["settings"],
			refs: [0],
		},
	],
	rejectedCount: 0,
	usage: { inTokens: 1, outTokens: 1, wallS: 1 },
};
const opsRecord = {
	type: "hy.ops",
	chunkId: "hy-01234567-001",
	coversUpToId: "e1",
	createdAt: "2026-10-21T00:00:00.000Z",
	ops: [{ action: "ADD", draft: 0 }],
	rejectedCount: 0,
	usage: { inTokens: 1, outTokens: 1, wallS: 1 },
};

const hookBranch: SessionEntry[] = [
	{
		id: "c0",
		type: "custom",
		customType: "hy.extract",
		parentId: null,
		timestamp: "1760000000000",
		data: extractRecord,
	},
	{ id: "c1", type: "custom", customType: "hy.ops", parentId: "c0", timestamp: "1760000000001", data: opsRecord },
	thin("e1", 2),
	...Array.from({ length: 8 }, (_, i) => fat(`b${i}`, i + 3)),
];

const faux = () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	return {
		pi: {
			on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) =>
				handlers.set(name, handler),
			registerTool: () => {},
			registerCommand: () => {},
			appendEntry: () => {},
		},
		handlers,
	};
};

const ctx = {
	sessionManager: {
		getSessionId: () => "01234567",
		getBranch: () => hookBranch,
		getEntry: (id: string) => hookBranch.find((e) => (e as { id: string }).id === id),
	},
	hasUI: false,
	ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_c: string, t: string) => t } },
	modelRegistry: {
		getAll: () => [],
		refresh: async () => undefined,
		getApiKeyAndHeaders: async () => ({ ok: true }),
	},
	model: { id: "small", provider: "test", contextWindow: 12_000 },
	thinkingLevel: "off",
};

// 12 000 − 1 000 reserve − overhead − 1 500 slack = what the retry can hold. The overhead is
// measured, not assumed: pi counts the whole request, this branch counts only the conversation, and
// the fixture states that gap as 2 500 tokens of prompt and schemas. So 7 000 available: 1 500 asked
// for the digest, the tail asking 40% of the rest (2 200), the note taking 3 300. Entries are ~1 000
// tokens, so the tail holds two. The digest then costs 417, which releases room, and the re-split
// raises the tail figure to 2 628 — the price of a trim is paid back when it turns out smaller.
const branchTokens = hookBranch.reduce((sum, e) => sum + entryTokens(e), 0);
const preparation = (firstKeptEntryId: string, tokensBefore = branchTokens + 2_500) => ({
	firstKeptEntryId,
	messagesToSummarize: [],
	turnPrefixMessages: [],
	isSplitTurn: false,
	tokensBefore,
	settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 5000 },
});

const run = faux();
piHyMemory(run.pi as never);
await (run.handlers.get("session_start") as (e: unknown, c: unknown) => Promise<unknown>)({}, ctx);
const compact = run.handlers.get("session_before_compact") as (
	e: unknown,
	c: unknown,
) => Promise<{ compaction?: { summary: string; firstKeptEntryId: string } } | undefined>;

// 3. A manual compaction that would drop unread entries still hands the job to pi.
const manual = await compact(
	{
		branchEntries: hookBranch,
		preparation: preparation("b6"),
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
	},
	ctx,
);
check("manual compaction still defers when the cut would lose unread entries", manual, undefined);

// 4. Overflow: never deferred, even though honouring the cut drops entries the writer never read.
const overflow = await compact(
	{
		branchEntries: hookBranch,
		preparation: preparation("b0"),
		reason: "overflow",
		willRetry: true,
		signal: new AbortController().signal,
	},
	ctx,
);
check("overflow returns a compaction instead of deferring", overflow?.compaction !== undefined, true);
has(
	"the summary carries a digest of what was cut",
	overflow?.compaction?.summary ?? "",
	"Dropped to fit the context window",
);
check(
	"the summary stays inside its share of the window",
	estimateTokens(overflow?.compaction?.summary ?? "") <= 6500 + 1500 + 300,
	true,
);
check(
	"the cut names an entry still in the branch",
	hookBranch.some((e) => (e as { id: string }).id === overflow?.compaction?.firstKeptEntryId),
	true,
);
// The tail is priced before the note, so at this window it holds two entries rather than the one the
// old split could afford. The newest entry survives either way; what moved is the cut's left edge.
check("the newest entry is kept, and one more with it", overflow?.compaction?.firstKeptEntryId, "b6");

// 5. A model with no known window keeps the previous behaviour.
const noWindow = await compact(
	{
		branchEntries: hookBranch,
		preparation: preparation("b0"),
		reason: "overflow",
		willRetry: true,
		signal: new AbortController().signal,
	},
	{ ...ctx, model: { id: "unknown", provider: "test", contextWindow: 0 } },
);
check("an unknown window still produces a summary", noWindow?.compaction !== undefined, true);
check(
	"and no trim or digest is invented for it",
	(noWindow?.compaction?.summary ?? "").includes("Dropped to fit"),
	false,
);

// 6. The overhead is measured from pi's count of the request, and capped: a count far larger than
// this branch can account for must not be charged entirely to the prompt, or a long session would
// trim its own working set away.
const inflated = await compact(
	{
		branchEntries: hookBranch,
		preparation: preparation("b0", 500_000),
		reason: "overflow",
		willRetry: true,
		signal: new AbortController().signal,
	},
	ctx,
);
check("an inflated count still returns a compaction", inflated?.compaction !== undefined, true);
const audit = readFileSync(join(process.env.PI_HY_MEMORY_STATE as string, "audit.ndjson"), "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line) as Record<string, unknown>);
const trimmedLine = audit.find((a) => a.event === "compact_trimmed");
check("the manual deferral is audited", audit.filter((a) => a.event === "compact_deferred").length >= 1, true);
check("the trim is audited", trimmedLine?.reason, "overflow");
// The share is whatever the split decided for this window, so the audit is checked against itself:
// the kept tail must sit inside the figure the same line reports as the cap.
check(
	"the trim leaves a tail inside the share the split set",
	(trimmedLine?.keptTokens as number) <= (trimmedLine?.maxKeepTokens as number),
	true,
);
// The literals below are what this fixture happens to deliver. These invariants are the reason a change
// to any of them would be a change to the split and not a coincidence: the three parts the audit names
// must fit the room the same line names, the note keeps its floor, and the probe settled on one price.
const parts =
	(trimmedLine?.maxKeepTokens as number) +
	(trimmedLine?.summaryTokens as number) +
	(trimmedLine?.digestBudget as number);
check(
	"the three parts the split named fit the room it was given",
	parts <= (trimmedLine?.availableTokens as number),
	true,
);
check("and the note kept its floor", (trimmedLine?.summaryTokens as number) >= 500, true);
check("and the probe settled on one digest price", trimmedLine?.probeConverged, true);
check("the digest is bounded by its own budget", (trimmedLine?.digestTokens as number) <= 1500, true);
check("and it covers the unread entries the trim removed", trimmedLine?.digestEntries, 6);
check("the overhead is pi's count minus this branch", trimmedLine?.overheadTokens, 2500);
// The overhead is measured, then capped: a count far larger than this branch can account for must not
// be charged entirely to the prompt. The cap is visible on the compaction line, because a tighter
// budget does not necessarily mean a trim — the walk stops where the tail figure says it does.
const compactLines = audit.filter((a) => a.event === "compact");
check("and the inflated count was capped at a third of the window", compactLines.at(-1)?.overheadTokens, 3600);
// The three compactions in this fixture are the honest overflow, an unknown window, and the inflated
// count, so the honest one is the first line and the inflated one the last.
check(
	"the inflated count was given less room than the honest one",
	(compactLines.at(-1)?.availableTokens as number) < (compactLines[0]?.availableTokens as number),
	true,
);
check(
	"and it was walked with a smaller tail share than the honest run",
	(compactLines.at(-1)?.tailTokens as number) < (compactLines[0]?.tailTokens as number),
	true,
);

const gaps = readFileSync(join(process.env.PI_HY_MEMORY_STATE as string, "sessions", "01234567.ledger.jsonl"), "utf8")
	.split("\n")
	.filter((line) => line.includes('"hy.gap"'))
	.map((line) => JSON.parse(line) as Record<string, unknown>);
check("the cut is recorded as a gap", gaps[0]?.reason, "overflow-trim");
check("coverage resumes at the first kept entry", gaps[0]?.fromId, overflow?.compaction?.firstKeptEntryId);

for (const line of audit.filter((a) => a.event === "compact_trimmed")) {
	console.log(
		`   trim ${line.reason}: window ${line.windowTokens} overhead ${line.overheadTokens} ` +
			`keep≤${line.maxKeepTokens} kept ${line.keptTokens} dropped ${line.trimmedEntries} digest ${line.digestTokens}`,
	);
}
console.log(failures === 0 ? "ok: overflow compact" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
