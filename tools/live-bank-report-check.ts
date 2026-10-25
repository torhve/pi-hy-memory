#!/usr/bin/env npx tsx

/**
 * tools/live-bank-report-check.ts — the organic-session instrument pinned on a constructed store.
 *
 * `dev/live-bank-report.ts` reads state a real session left behind, so it has to be pinned on a
 * store built to have each of the four findings in it — otherwise the instrument could silently
 * report zero for the thing it exists to notice:
 *
 *   - `stats.json` counts the process, not the session (TODO 6.22): the ledger has 3 writes and
 *     the stats file says 1, and the report must carry both rather than reconcile them.
 *   - retirement is not in the ledger (TODO 6.19): the folded bank and the live bank disagree by
 *     exactly the budget-retired entry, and the report prints both.
 *   - a value the ceiling retired is still answered by the query (TODO 6.18): `reachableThroughQuery`
 *     must find the retired fact, and say it is retired.
 *   - the value gate replayed over the merges that were really proposed: the merge that drops 420
 *     and `queue.toml` is applied in the shipped replay and refused in the gate replay, and the
 *     two values are left with no current fact only in the first.
 *
 * Constructed outcomes:
 *
 *   1. writes 3 from the ledger, 1 from stats — both reported, neither averaged
 *   2. folded active > live active, by the one budget-retired fact
 *   3. shipped replay: 1 merge applied, 1 dropping a value, 2 values left uncarried
 *   4. gate replay: 1 refusal, 0 merges applied, 0 values left uncarried, one more fact
 *   5. 2 values carried only by the budget-retired fact, and both reachable through the query
 *   6. a refusal the bank recorded as `target not retrieved` is classified, not counted as judgement
 *   7. a missing stats file is reported as unknown rather than as zero
 */

import { appendFileSync, copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reachableThroughQuery, reportSession } from "../dev/live-bank-report.js";
import { newId } from "../src/bank.js";
import { recallHits } from "../src/render.js";
import type { BankEntry, Draft, LedgerRecord } from "../src/types.js";

const AT = "2026-06-01T10:00:00Z";
const SESSION = "hy-live-check-01";

function extract(chunkId: string, drafts: Draft[]): LedgerRecord {
	return {
		type: "hy.extract",
		chunkId,
		coversUpToId: `e-${chunkId}`,
		createdAt: AT,
		drafts: drafts.map((d) => ({ ...d, sourceEntryIds: [`e-${chunkId}`] })),
		rejectedCount: 0,
		// Three writes, each shown four labelled turns of which one was the user's own.
		labelledTurns: 4,
		userTurns: 1,
		usage: { inTokens: 100, outTokens: 20 },
	} as unknown as LedgerRecord;
}

function ops(chunkId: string, list: unknown[], downgraded: { reason: string; op: unknown }[] = []): LedgerRecord {
	return {
		type: "hy.ops",
		chunkId,
		coversUpToId: `e-${chunkId}`,
		createdAt: AT,
		ops: list,
		rejectedCount: 0,
		rejectedOps: [],
		downgradedOps: downgraded,
		usage: { inTokens: 100, outTokens: 20 },
	} as unknown as LedgerRecord;
}

const draft = (task: string, statement: string, keys: string[]): Draft => ({
	task,
	statement,
	keys,
	refs: [1],
	fromUser: true,
});

/** Ids are `newId(chunkId:draft:action)`, the same ids the writer mints. */
const QUEUE_ID = newId("hy-live-001:0:ADD");
const RELAY_ID = newId("hy-live-001:1:ADD");
const MERGED_ID = newId("hy-live-002:0:ADD");
const SETTINGS_ID = newId("hy-live-003:0:ADD");

const records: LedgerRecord[] = [
	extract("hy-live-001", [
		draft("queue depth limit", "Queue depth limit is 420 entries max in queue.toml", ["420", "queue.toml"]),
		draft("relay ports", "relay listens on 9010/9001 with pbkdf2 iterations for relay auth", ["relay"]),
	]),
	ops("hy-live-001", [
		{ action: "ADD", draft: 0 },
		{ action: "ADD", draft: 1 },
	]),
	// The merge that passes the subject test and drops both values: applied in the shipped replay,
	// refused in the gate replay.
	extract("hy-live-002", [draft("queue depth limit", "Queue depth limit was reviewed and left as it is", ["queue"])]),
	ops("hy-live-002", [{ action: "UPDATE", draft: 0, target: QUEUE_ID }]),
	// A proposal the bank refused because the target was never shown to the draft.
	extract("hy-live-003", [draft("settings rows", "SettingsModal rows contract test passed 11 tests", ["settings"])]),
	ops(
		"hy-live-003",
		[{ action: "ADD", draft: 0 }],
		[
			{
				reason: "update target not retrieved for this draft; recorded as ADD",
				op: { action: "UPDATE", draft: 0, target: RELAY_ID },
			},
		],
	),
];

function liveEntry(over: Partial<BankEntry> & { id: string; task: string; statement: string }): BankEntry {
	return {
		keys: [],
		sourceEntryIds: [],
		chunkId: "hy-live-001",
		chunkSeq: 1,
		fromUser: true,
		createdAt: AT,
		status: "active",
		tokenCount: 20,
		...over,
	} as BankEntry;
}

/** The store as the session left it: one fact retired by the ceiling, one by the merge. */
const liveBank: BankEntry[] = [
	liveEntry({
		id: QUEUE_ID,
		task: "queue depth limit",
		statement: "Queue depth limit is 420 entries max in queue.toml",
		keys: ["420", "queue.toml"],
		status: "superseded",
		supersededBy: MERGED_ID,
		supersedeReason: "replaced by newer statement",
	}),
	liveEntry({
		id: RELAY_ID,
		task: "relay ports",
		statement: "relay listens on 9010/9001 with pbkdf2 iterations for relay auth",
		keys: ["relay"],
		status: "superseded",
		supersedeReason: "bank budget",
	}),
	liveEntry({
		id: MERGED_ID,
		task: "queue depth limit",
		statement: "Queue depth limit was reviewed and left as it is",
		chunkId: "hy-live-002",
		chunkSeq: 2,
	}),
	liveEntry({
		id: SETTINGS_ID,
		task: "settings rows",
		statement: "SettingsModal rows contract test passed 11 tests",
		chunkId: "hy-live-003",
		chunkSeq: 3,
	}),
];

const dir = mkdtempSync(join(tmpdir(), "live-bank-check-"));
writeFileSync(join(dir, `${SESSION}.ledger.jsonl`), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
writeFileSync(join(dir, `${SESSION}.bank.json`), JSON.stringify(liveBank));
writeFileSync(join(dir, `${SESSION}.stats.json`), JSON.stringify({ writes: 1, drafts: 3, added: 2 }));

const failures: string[] = [];
function ok(condition: boolean, message: string): void {
	if (!condition) failures.push(message);
}

const report = reportSession(dir, SESSION, 60000);
if (!report) failures.push("the report read nothing from a directory that holds a ledger");

if (report) {
	// 1. counters that disagree are reported as disagreeing.
	ok(report.writes === 3, `the ledger holds 3 writes, report says ${report.writes}`);
	ok(report.statsWrites === 1, `stats.json says 1 write, report says ${report.statsWrites}`);

	// 2. the fold restores what the ceiling retired.
	ok(report.foldedActive === 3, `the fold should hold 3 active facts, got ${report.foldedActive}`);
	ok(report.liveActive === 2, `the store as it ran held 2 active facts, report says ${report.liveActive}`);
	ok(report.retiredByBudget === 1, `one fact was retired by budget, report says ${report.retiredByBudget}`);

	// 3. the shipped replay: the merge ran and left both values uncarried.
	ok(report.updatesApplied === 1, `1 merge applied without the gate, got ${report.updatesApplied}`);
	ok(report.mergesDroppingValue === 1, `1 merge dropped a value, got ${report.mergesDroppingValue}`);
	ok(
		report.valuesNoCurrentFactCarries === 2,
		`2 values left with no current carrier, got ${report.valuesNoCurrentFactCarries}`,
	);

	// 4. the gate replay: refused, so nothing is left uncarried, at one more fact.
	ok(report.gateRefusals === 1, `the value gate refused 1 merge, got ${report.gateRefusals}`);
	ok(report.gateUpdatesApplied === 0, `no merge should apply under the gate, got ${report.gateUpdatesApplied}`);
	ok(
		report.valuesOnlyInRetiredUnderGate === 0,
		`the gate replay left values uncarried: ${report.valuesOnlyInRetiredUnderGate}`,
	);
	ok(
		report.gateActive === report.foldedActive + 1,
		`gate-on bank should hold one more fact than ${report.foldedActive}, got ${report.gateActive}`,
	);
	// 4b. trimming a fold by tokens never adds facts back, and it bites both replays.
	ok(report.fitsPool <= report.foldedActive, "trimming the fold returned more facts than the fold held");
	ok(
		typeof report.trimmedSameAsStore === "boolean",
		"the report cannot say whether the trimmed fold reproduces the store's ids",
	);
	const tight = reportSession(dir, SESSION, 24);
	ok(tight !== null && tight.fitsPool < tight.foldedActive, "a tight pool left the shipped fold untrimmed");
	ok(
		tight !== null && tight.gateFitsPool <= tight.gateActive,
		`gate-on fit ${tight?.gateFitsPool} exceeded its own bank of ${tight?.gateActive} facts`,
	);

	// 4c. the replay is the shipped fold, not a story about it: with the gate off it agrees
	// entry for entry with foldLedger, and the digest ties the reading to one ledger file.
	ok(report.replayMatchesFold, "the gate-off replay disagrees with foldLedger on this ledger");
	ok(
		report.turnCountsRecorded && report.labelledTurns === 12 && report.userTurns === 3,
		`turn counts did not add up across the writes: ${report.userTurns} of ${report.labelledTurns}, recorded ${report.turnCountsRecorded}`,
	);
	ok(/^[0-9a-f]{12}$/.test(report.snapshotDigest), `digest is not a 12-character hex: ${report.snapshotDigest}`);
	const again = reportSession(dir, SESSION, 60000);
	ok(again?.snapshotDigest === report.snapshotDigest, "the same files read twice gave different digests");
	const copy = mkdtempSync(join(tmpdir(), "live-bank-copy-"));
	for (const suffix of [".ledger.jsonl", ".bank.json", ".stats.json"]) {
		copyFileSync(join(dir, `${SESSION}${suffix}`), join(copy, `${SESSION}${suffix}`));
	}
	const frozen = reportSession(copy, SESSION, 60000);
	ok(
		frozen?.snapshotDigest === report.snapshotDigest && frozen?.liveActive === report.liveActive,
		"reading a copy of the store gave different numbers than reading the store",
	);
	appendFileSync(join(dir, `${SESSION}.ledger.jsonl`), `${JSON.stringify(records[records.length - 1])}\n`);
	ok(
		reportSession(dir, SESSION, 60000)?.snapshotDigest !== report.snapshotDigest,
		"appending to the ledger left the digest untouched",
	);

	// 5. the ceiling retired a value nobody else carries — and the query still answers for it.
	ok(report.valuesOnlyInRetired === 4, `4 values carried only by retired facts, got ${report.valuesOnlyInRetired}`);
	ok(
		reachableThroughQuery(liveBank, "9010/9001"),
		"a value retired by the ceiling is not reachable through the query",
	);
	const hit = recallHits(liveBank, "9010/9001", 5)[0];
	ok(hit?.superseded === true, "the retired fact was handed back as if it were current");
	ok(hit?.entry.id === RELAY_ID, `expected the retired relay fact, got ${hit?.entry.id}`);

	// 6. a retrieval refusal is classified as retrieval, not as a guard refusing judgement.
	ok(report.refusalsByKind["target not retrieved"] === 1, `refusal mix: ${JSON.stringify(report.refusalsByKind)}`);
	ok(
		report.refusalsByKind["subject guard"] === undefined,
		`subject refusals invented: ${JSON.stringify(report.refusalsByKind)}`,
	);
}

// 7. a session with no stats file reports unknown, not zero.
const bare = mkdtempSync(join(tmpdir(), "live-bank-bare-"));
writeFileSync(join(bare, `${SESSION}.ledger.jsonl`), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
const noStats = reportSession(bare, SESSION, 60000);
ok(noStats !== null && noStats.statsWrites === null, "a missing stats file read as a write count rather than unknown");
ok(
	noStats !== null && noStats.liveActive === 0,
	`no bank file should read as an empty store, got ${noStats?.liveActive}`,
);

if (failures.length > 0) {
	for (const failure of failures) console.error(`FAIL: ${failure}`);
	process.exit(1);
}
console.log(
	`ok: stats and ledger disagree and both are printed, the fold and the store disagree by what the ceiling retired, ` +
		`the merge that drops 420 is applied in one replay and refused in the other, and a ceiling-retired value is answered`,
);
