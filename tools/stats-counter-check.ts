#!/usr/bin/env node
/**
 * The status line's counters are the session's, not the process's. Run:
 * npx tsx tools/stats-counter-check.ts
 *
 * `stats.json` sat next to a ledger holding every write the session ever made while its counters
 * restarted at zero on each `session_start`: the measured session's ledger had 159 write records
 * and its stats said `writes: 14` (TODO 6.22). This pins the recovery, including the one number
 * a pre-`downgradedCount` ledger cannot give exactly.
 */
import { emptyStats, statsFromLedger } from "../src/stats.js";
import type { LedgerRecord } from "../src/types.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const draft = (statement: string) => ({
	task: "task",
	statement,
	keys: ["key"],
	refs: [0],
	fromUser: false,
	sourceEntryIds: ["e1"],
});

const extract = (chunkId: string, drafts: number): LedgerRecord =>
	({
		type: "hy.extract",
		chunkId,
		coversUpToId: `e-${chunkId}`,
		createdAt: "2026-10-25T09:00:00.000Z",
		drafts: Array.from({ length: drafts }, (_, i) => draft(`${chunkId} statement number ${i} long enough`)),
		rejectedCount: 0,
		usage: { inTokens: 100, outTokens: 20, wallS: 1.5 },
	}) as unknown as LedgerRecord;

const opsRecord = (
	chunkId: string,
	actions: ("ADD" | "UPDATE" | "DELETE")[],
	downgraded: { count?: number; listed?: number },
): LedgerRecord =>
	({
		type: "hy.ops",
		chunkId,
		coversUpToId: `e-${chunkId}`,
		createdAt: "2026-10-25T09:01:00.000Z",
		ops: actions.map((action, draft) => ({ action, draft, target: action === "ADD" ? undefined : "t1" })),
		rejectedCount: 2,
		rejectedOps: [{ reason: "no target" }],
		downgradedOps: Array.from({ length: downgraded.listed ?? 0 }, () => ({ reason: "subject guard" })),
		downgradedCount: downgraded.count,
		usage: { inTokens: 200, outTokens: 40, wallS: 2 },
	}) as unknown as LedgerRecord;

const twoWrites: LedgerRecord[] = [
	extract("hy-st-001", 3),
	opsRecord("hy-st-001", ["ADD", "ADD", "UPDATE"], { count: 8 }),
	extract("hy-st-002", 3),
	opsRecord("hy-st-002", ["ADD", "ADD", "UPDATE"], { count: 8 }),
];

const seeded = statsFromLedger(twoWrites);
check("a reload continues the session's write count", seeded.writes, 2);
check("and its drafts, adds and merges", [seeded.drafts, seeded.added, seeded.updated], [6, 4, 2]);
check(
	"its refusals, including the ones the reason list could not hold",
	[seeded.rejectedOps, seeded.downgraded],
	[4, 16],
);
check("its tokens and model time", [seeded.inTokens, seeded.outTokens, seeded.wallS], [600, 120, 7]);
check("and says where the numbers came from", [seeded.seededFromLedger, seeded.countsAreFloor], [true, false]);

// A ledger written before `downgradedCount` existed only kept six reasons per write.
const older: LedgerRecord[] = [extract("hy-st-003", 2), opsRecord("hy-st-003", ["ADD"], { listed: 6 })];
const floored = statsFromLedger(older);
check("an older ledger gives a floor and admits it", [floored.downgraded, floored.countsAreFloor], [6, true]);

// Coverage and pressure are records too, but they are not writes.
check(
	"a compaction gap counts as a compaction, an off gap does not",
	[
		statsFromLedger([
			{
				type: "hy.gap",
				coversUpToId: "e9",
				fromId: "e12",
				entries: 3,
				tokens: 900,
				reason: "compaction",
				createdAt: "2026-10-25T09:02:00.000Z",
			},
			{
				type: "hy.gap",
				coversUpToId: "e12",
				fromId: "e13",
				entries: 1,
				tokens: 100,
				reason: "disabled",
				createdAt: "2026-10-25T09:03:00.000Z",
			},
		]).compactions,
		statsFromLedger([
			{
				type: "hy.evict",
				coversUpToId: "e13",
				createdAt: "2026-10-25T09:04:00.000Z",
				cause: "write",
				poolTokens: 60,
				activeTokensBefore: 74,
				droppedCount: 2,
				droppedTokens: 19,
				droppedIds: ["a", "b"],
			},
		]).writes,
	],
	[1, 0],
);

check("a session with no ledger starts at zero and says it is fresh", statsFromLedger([]), emptyStats());

console.log(failures === 0 ? "ok: the counters describe the session, not the process" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
