#!/usr/bin/env node
import { reportRefusals } from "../dev/retrieval-refusal-report.js";
/**
 * Retrieval-refusal report. Run: npx tsx tools/retrieval-refusal-report-check.ts
 *
 * Four things this report claims, pinned on a ledger small enough to reason about by hand:
 *
 *   1. A refusal whose target *is* eligible but ranked past the shipped view is counted as
 *      reachable at a wider limit — that is the only class widening can clear.
 *   2. A refusal whose target never reaches the eligibility floor is counted separately: no view
 *      size would ever have offered it.
 *   3. A `target id not in bank` is sorted by what the field actually held: a bare index, a word,
 *      a real id with one character appended, or something that exists nowhere.
 *   4. Reason lists were bounded, so a write that downgraded more than it recorded is reported as
 *      a sample rather than a count.
 */
import { newId } from "../src/bank.js";
import type { BankEntry, Draft, LedgerRecord } from "../src/types.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const usage = { inTokens: 10, outTokens: 5, wallS: 1 };
const draft = (task: string, statement: string, keys: string[]): Draft & { sourceEntryIds: string[] } => ({
	task,
	statement,
	keys,
	refs: [0],
	sourceEntryIds: ["e1"],
});
const extract = (chunkId: string, drafts: (Draft & { sourceEntryIds: string[] })[]): LedgerRecord => ({
	type: "hy.extract",
	chunkId,
	coversUpToId: `e-${chunkId}`,
	createdAt: `2026-10-25T09:0${chunkId.slice(-1)}:00.000Z`,
	drafts,
	rejectedCount: 0,
	usage,
});
const ops = (
	chunkId: string,
	list: LedgerRecord extends never ? never : Extract<LedgerRecord, { type: "hy.ops" }>["ops"],
	extra: Partial<Extract<LedgerRecord, { type: "hy.ops" }>> = {},
): LedgerRecord => ({
	type: "hy.ops",
	chunkId,
	coversUpToId: `e-${chunkId}`,
	createdAt: `2026-10-25T09:0${chunkId.slice(-1)}:30.000Z`,
	ops: list,
	rejectedCount: extra.rejectedOps?.length ?? 0,
	usage,
	...extra,
});

const NOT_RETRIEVED = "update target not retrieved for this draft; recorded as ADD";
const NOT_IN_BANK = "target id not in bank";

const idA = newId("hy-ref-001:0:ADD");
const idB = newId("hy-ref-001:1:ADD");
const idC = newId("hy-ref-001:2:ADD");

const records: LedgerRecord[] = [
	extract("hy-ref-001", [
		draft("nightly pool", "the nightly pool is sized at 12000 tokens per pass", ["pool", "nightly"]),
		draft("render pool", "the render pool runs 8 workers per pool with a queue of 40 jobs", ["pool", "workers"]),
		draft("audit store", "the audit store is capped at 64MB and is never moved", ["audit"]),
	]),
	ops("hy-ref-001", [
		{ action: "ADD", draft: 0 },
		{ action: "ADD", draft: 1 },
		{ action: "ADD", draft: 2 },
	]),
	// Written mostly in the render pool's words, so that entry ranks first and the nightly pool's
	// ranks second: out of the shipped view of one, inside a view of two.
	extract("hy-ref-002", [
		draft(
			"pool sizes",
			"the render pool runs 8 workers per pool with a queue of 40 jobs, and the nightly pool keeps 12000 tokens per pass",
			["pool"],
		),
	]),
	ops("hy-ref-002", [], {
		downgradedOps: [{ reason: NOT_RETRIEVED, draft: 0, target: idA }],
		// The write refused four ops and recorded one.
		downgradedCount: 4,
	}),
	// A merge proposal between two subjects the scorer considers unrelated.
	extract("hy-ref-003", [
		draft("build timeout", "the compose timeout was raised to 90 seconds on the build host", ["timeout"]),
	]),
	ops("hy-ref-003", [], { downgradedOps: [{ reason: NOT_RETRIEVED, draft: 0, target: idC }] }),
	// What the writer puts in `target` when it is not filling the field.
	ops("hy-ref-004", [], {
		rejectedOps: [
			{ reason: NOT_IN_BANK, draft: 2, target: "3" },
			{ reason: NOT_IN_BANK, draft: 1, target: "renderComposableChildren" },
			{ reason: NOT_IN_BANK, draft: 0, target: `${idA}b` },
			{ reason: NOT_IN_BANK, draft: 0, target: "abcdef012345678" },
		],
	}),
];

const report = reportRefusals(records, "hy-refusal-check-01", { shipped: 1, limits: [1, 2] });

check("four writes and five drafts walked", [report.chunks, report.drafts], [4, 5]);
check("every recorded refusal counted", report.refusalsRecorded, 6);
check("sorted by reason", report.byReason, { notRetrieved: 2, notInBank: 4 });
check(
	"a refusal the wider view would clear is attributed to the limit that clears it",
	[report.notRetrieved.wouldBeReachedAt, report.notRetrieved.neverReached],
	[{ "2": 1 }, 1],
);
check(
	"and the two causes of never being reached stay distinct",
	[report.notRetrieved.eligibleButBeyondCap, report.notRetrieved.notEligibleAtAll],
	[0, 1],
);
check(
	"what the target field held when it held no id",
	[
		report.neverShown.looksLikeAnIndex,
		report.neverShown.looksLikeAName,
		report.neverShown.idExistsAsAPrefix,
		report.neverShown.idExistsNowhere,
	],
	[1, 1, 1, 1],
);
check(
	"a bounded reason list is reported as a sample",
	[report.countsAreSample, report.writesWithTruncatedLists],
	[true, 1],
);
check(
	"widening is priced, not assumed",
	[
		report.viewCost.map((v) => v.limit),
		report.viewCost[0].versusShipped,
		report.viewCost[1].meanInputTokens > report.viewCost[0].meanInputTokens,
		report.viewCost[1].meanShown >= report.viewCost[0].meanShown,
	],
	[[1, 2], "shipped", true, true],
);

const foldIds = report.foldMatchesStore;
check("no store passed means no claim made", foldIds, null);

const storeEntry = (id: string, status: "active" | "superseded"): BankEntry => ({
	id,
	task: "t",
	statement: "s",
	keys: [],
	sourceEntryIds: [],
	chunkId: "hy-ref-001",
	chunkSeq: 1,
	fromUser: false,
	createdAt: "2026-10-25T09:01:00.000Z",
	status,
	tokenCount: 1,
});
const written = [idA, newId("hy-ref-001:1:ADD"), idC];

const asStore = (active: string[], retired: string[] = []) => [
	...active.map((id) => storeEntry(id, "active")),
	...retired.map((id) => storeEntry(id, "superseded")),
];

check(
	"a store the fold reproduces is confirmed",
	reportRefusals(records, "hy-refusal-check-01", { shipped: 1, limits: [1] }, asStore(written)).foldMatchesStore,
	true,
);
check(
	"a store the fold does not reproduce is refused, including one fact the store already retired",
	reportRefusals(records, "hy-refusal-check-01", { shipped: 1, limits: [1] }, asStore([idA, idC], [idB]))
		.foldMatchesStore,
	false,
);

console.log(
	failures === 0 ? "ok: retrieval refusals are attributed, priced and sampled honestly" : `${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
