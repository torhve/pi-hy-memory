#!/usr/bin/env npx tsx

/**
 * tools/merge-report-check.ts - the merge instrument against a ledger with known answers.
 *
 * dev/merge-report.ts reads every accepted UPDATE out of a run's ledger and says what it did to
 * the entry it replaced. Its central claim is unfalsifiable unless something pins it: "the guard
 * passed a merge and a value disappeared". This fixture is a five-chunk session where each of
 * those outcomes is constructed on purpose, including the one a reader of the guard's own verdict
 * would score as fine.
 *
 *   1. a merge the guard allowed, that dropped a value the target carried  -> the blind spot;
 *   2. a merge allowed by the strict clause, that dropped nothing           -> the contrast case;
 *   3. a merge whose recorded numbers disagree with the guard's recomputation -> instrument hygiene;
 *   4. two drafts in one chunk carrying one declared value, both banked     -> 7.14's duplicate;
 *   5. a declared value drafted and then dropped outright                   -> nothing banked;
 *   6. a refusal that left two active facts covering the same declared value -> what a refusal costs;
 *   7. a merge the current guard would not have allowed                     -> reported, not hidden;
 *   8. a refusal recorded by the value gate rather than the subject guard   -> attributed to the gate
 *      that made it, because the two refusals mean different things to whoever reads the number.
 *
 * Entry ids in the fixture are the real ones: newId(`${chunkId}:${draft}:${action}`) is how
 * src/bank.ts derives them, so the ops point at entries the fold actually creates.
 */

import { pathToFileURL } from "node:url";
import { analyseRecords, passClause, specificTokens, textOf } from "../dev/merge-report.js";
import { type CorpusChunk, carries } from "../dev/restraint-report.js";
import { newId } from "../src/bank.js";
import { sameSubject } from "../src/protocol.js";
import type { Draft, LedgerRecord } from "../src/types.js";

// dev/merge-report.ts prints its report when run directly; importing the analysis must not.
void pathToFileURL;

let failures = 0;
function assert(cond: boolean, label: string): void {
	if (!cond) {
		console.error(`FAIL: ${label}`);
		failures += 1;
	}
}

// ---------------------------------------------------------------- token shape and guard clauses

const valueBearing = specificTokens(
	"--fix-age <n> drops queue entries older than n seconds, cap 4096 entries in queue.toml, see src/queue.rs and MAX_AGE_SECONDS",
);
assert(valueBearing.has("4096"), "a bare number counts as a value");
assert(valueBearing.has("--fix-age"), "a flag counts as a value");
assert(valueBearing.has("queue.toml"), "a dotted file name counts as a value");
assert(valueBearing.has("src/queue.rs"), "a path counts as a value");
assert(valueBearing.has("max_age_seconds"), "an underscored identifier counts as a value");
assert(!valueBearing.has("queue"), "a wording token is not a value — the guard already reads those");
assert(!valueBearing.has("older"), "an ordinary word is not a value");

assert(passClause(9, 12) === "restated half the target's wording", "the strict clause: half the wording");
assert(passClause(4, 10) === "shared 3+ tokens, under half the wording", "the loose clause: 3+ tokens, under half");
assert(passClause(2, 12) === "no clause should have passed it", "below both clauses: should have been refused");
assert(passClause(0, 0) === "target had no vocabulary to compare", "an empty target has nothing to compare");

// ---------------------------------------------------------------- the fixture session

const draft = (task: string, statement: string, keys: string[]): Draft & { sourceEntryIds: string[] } => ({
	task,
	statement,
	keys,
	refs: [1],
	sourceEntryIds: ["aaaaaaaaaaaaaaaa1111"],
});

const chunks: CorpusChunk[] = [
	{
		chunkId: "hy-f-to-01",
		class: "tool_output",
		probes: ["--fix-age", "4096"],
		transient: ["reading the manual for a few minutes"],
		text: "operator: check the purge flag\n[1] tool result: --fix-age <n> drops queue entries older than n seconds; cap 4096 entries in queue.toml",
	},
	{
		// Case 1. A recap chunk whose draft reuses the flag name and the line coordinate, so the
		// guard sees a related subject — and quietly retires the cap value the flag entry carried.
		chunkId: "hy-f-nw-02",
		class: "nothing_work",
		text: "operator: so the entries just stay put until they are pinned, and that flag from the manual is the one I wanted",
	},
	{
		// Case 2. A chunk whose second draft restates the first one's rule in full: the strict
		// clause, and nothing lost.
		chunkId: "hy-f-to-03",
		class: "tool_output",
		probes: ["9000"],
		text: "operator: how deep does the queue go\n[1] tool result: MAX_QUEUE = 9000 in src/queue.rs caps the queue",
	},
	{
		// Case 4 and 5: four drafts. Two carry 9000 (the duplicate 7.14 asks about), one carries a
		// value reconcile then drops outright, one is an unrelated recap the guard should refuse.
		chunkId: "hy-f-to-04",
		class: "tool_output",
		probes: ["9000", "8080"],
		text: "operator: queue depth and the log port\n[1] tool result: queue holds 9000 entries, logs listen on 8080",
	},
	{
		// Case 6: a confirmation the guard refuses, recorded as ADD, so the bank keeps both.
		chunkId: "hy-f-nw-05",
		class: "nothing_work",
		text: "operator: fine, the depth number is all I needed, nothing to change",
	},
];

const entryId = (chunkId: string, draftIndex: number, action: string): string =>
	newId(`${chunkId}:${draftIndex}:${action}`);

const flagDraft = draft(
	"queue purge flag documentation",
	"--fix-age <n> drops queue entries older than n seconds, cap 4096 entries, queue.toml and settings.toml",
	["--fix-age", "4096"],
);
const retiresValue = draft(
	"queue entries stay until pinned",
	"Queue entries stay until pinned --fix-age line 63 manual.txt is the documentation wanted",
	["--fix-age", "manual.txt"],
);
const capDraft = draft("queue depth cap", "MAX_QUEUE = 9000 in src/queue.rs caps the queue depth", ["9000"]);
const capAgain = draft("queue depth confirmed", "User confirmed the queue holds 9000 entries", ["9000"]);
const capRestated = draft(
	"queue depth cap location",
	"MAX_QUEUE = 9000 in src/queue.rs caps the queue depth at 9000 entries",
	["9000", "src/queue.rs"],
);
const capConfirmed = draft(
	"queue depth confirmed by user",
	"User confirmed the 9000 queue depth is fine as it stands",
	["9000"],
);
const auditRecap2 = draft("recap of the audit tail", "audit tail showed a clean pass, nothing else pending", ["audit"]);
const logPortDraft = draft("log listener port", "logs listen on 8080 in listen.toml", ["8080"]);
const unrelatedDraft = draft("recap of the audit tail", "audit tail showed a clean pass, nothing else pending", [
	"audit",
]);

const records: LedgerRecord[] = [
	{
		type: "hy.extract",
		chunkId: "hy-f-to-01",
		coversUpToId: "r1",
		createdAt: "2026-10-23T10:00:00.000Z",
		drafts: [flagDraft],
		rejectedCount: 0,
		usage: { inTokens: 100, outTokens: 40, wallS: 1 },
	},
	{
		type: "hy.ops",
		chunkId: "hy-f-to-01",
		coversUpToId: "r1",
		createdAt: "2026-10-23T10:00:01.000Z",
		ops: [{ action: "ADD", draft: 0 }],
		rejectedCount: 0,
		usage: { inTokens: 200, outTokens: 20, wallS: 1 },
	},
	{
		type: "hy.extract",
		chunkId: "hy-f-nw-02",
		coversUpToId: "r2",
		createdAt: "2026-10-23T10:01:00.000Z",
		drafts: [retiresValue],
		rejectedCount: 0,
		usage: { inTokens: 100, outTokens: 40, wallS: 1 },
	},
	{
		type: "hy.ops",
		chunkId: "hy-f-nw-02",
		coversUpToId: "r2",
		createdAt: "2026-10-23T10:01:01.000Z",
		ops: [
			{
				action: "UPDATE",
				draft: 0,
				target: entryId("hy-f-to-01", 0, "ADD"),
				reason: "same flag documentation, recap",
			},
		],
		rejectedCount: 0,
		usage: { inTokens: 200, outTokens: 20, wallS: 1 },
	},
	{
		type: "hy.extract",
		chunkId: "hy-f-to-03",
		coversUpToId: "r3",
		createdAt: "2026-10-23T10:02:00.000Z",
		drafts: [capDraft],
		rejectedCount: 0,
		usage: { inTokens: 100, outTokens: 40, wallS: 1 },
	},
	{
		type: "hy.ops",
		chunkId: "hy-f-to-03",
		coversUpToId: "r3",
		createdAt: "2026-10-23T10:02:01.000Z",
		ops: [{ action: "ADD", draft: 0 }],
		rejectedCount: 0,
		usage: { inTokens: 200, outTokens: 20, wallS: 1 },
	},
	{
		type: "hy.extract",
		chunkId: "hy-f-to-04",
		coversUpToId: "r4",
		createdAt: "2026-10-23T10:03:00.000Z",
		drafts: [capRestated, capAgain, logPortDraft, unrelatedDraft],
		rejectedCount: 0,
		usage: { inTokens: 100, outTokens: 40, wallS: 1 },
	},
	{
		type: "hy.ops",
		chunkId: "hy-f-to-04",
		coversUpToId: "r4",
		createdAt: "2026-10-23T10:03:01.000Z",
		ops: [
			{ action: "UPDATE", draft: 0, target: entryId("hy-f-to-03", 0, "ADD"), reason: "same cap rule, restated" },
			{ action: "ADD", draft: 1 },
			{ action: "SKIP", draft: 2, reason: "recap only no change" },
			// Case 7: recorded as an executed UPDATE although the current guard would refuse it.
			// It happens when reconcile targets an entry the draft was never shown next to.
			{ action: "UPDATE", draft: 3, target: entryId("hy-f-to-01", 0, "ADD"), reason: "audit tail recap" },
		],
		rejectedCount: 0,
		usage: { inTokens: 200, outTokens: 20, wallS: 1 },
	},
	{
		type: "hy.extract",
		chunkId: "hy-f-nw-05",
		coversUpToId: "r5",
		createdAt: "2026-10-23T10:04:00.000Z",
		drafts: [capConfirmed, auditRecap2],
		rejectedCount: 0,
		usage: { inTokens: 100, outTokens: 40, wallS: 1 },
	},
	{
		type: "hy.ops",
		chunkId: "hy-f-nw-05",
		coversUpToId: "r5",
		createdAt: "2026-10-23T10:04:01.000Z",
		ops: [
			{ action: "ADD", draft: 0 },
			{ action: "ADD", draft: 1 },
		],
		rejectedCount: 0,
		downgradedOps: [
			// Recorded numbers that agree with what the guard recomputes here: the refusal is
			// attributable to the subject guard.
			{
				reason: "target does not restate its subject (3/8 shared); recorded as ADD",
				draft: 0,
				target: entryId("hy-f-to-04", 0, "UPDATE"),
			},
			// Recorded numbers that do not agree: reported as a disagreement, not trusted.
			{
				reason: "target does not restate its subject (1/14 shared); recorded as ADD",
				draft: 1,
				target: entryId("hy-f-to-03", 0, "ADD"),
			},
			// The other write-time guard: same subject, but the draft drops a value the target
			// carries. Its reason names no shared/target counts, so the instrument must attribute
			// it by its reason string rather than fall through to a bucket that describes a
			// different failure.
			{
				reason: "target carries a value the draft does not restate (9000); recorded as ADD",
				draft: 0,
				target: entryId("hy-f-to-04", 0, "UPDATE"),
			},
		],
		usage: { inTokens: 200, outTokens: 20, wallS: 1 },
	},
];

const run = analyseRecords("merge-fixture", records, chunks, "fixture");

// ---------------------------------------------------------------- case 1: the blind spot

const blind = run.executed.find((row) => row.chunkId === "hy-f-nw-02");
assert(blind !== undefined, "the recap merge is read as a merge");
if (blind) {
	const verdict = sameSubject(retiresValue, { task: flagDraft.task, statement: flagDraft.statement });
	assert(verdict.ok, "the guard itself allows this merge — that is the point of the fixture");
	assert(
		blind.passedBy === "shared 3+ tokens, under half the wording",
		`the merge is credited to the clause that let it through, saw ${blind.passedBy}`,
	);
	assert(blind.dropped.includes("4096"), `the cap value left the bank, saw ${blind.dropped.join(",")}`);
	assert(
		blind.declaredDropped.length === 1 && blind.declaredDropped[0] === "4096",
		`the corpus's own label names the lost value, saw ${blind.declaredDropped.join(",")}`,
	);
	assert(blind.declaredKept.includes("--fix-age"), "the flag name survived the merge that dropped the cap");
	// The blind spot in words: a reader of the guard's verdict sees a related subject and a
	// sensible reason. Only the value axis shows something was retired.
	assert(!/cap|4096/.test(blind.replacementStatement), "the replacement says nothing about the cap");
}

// ---------------------------------------------------------------- case 2: strict clause, nothing lost

const strict = run.executed.find((row) => row.chunkId === "hy-f-to-04" && row.targetChunk === "hy-f-to-03");
assert(strict !== undefined, "the restated cap merge is read as a merge");
if (strict) {
	assert(
		strict.passedBy === "restated half the target's wording",
		`a full restatement is credited to the strict clause, saw ${strict.passedBy}`,
	);
	assert(strict.dropped.length === 0, `nothing left the entry, saw ${strict.dropped.join(",")}`);
	assert(strict.declaredDropped.length === 0, "no declared value was lost at the strict merge");
}

// ---------------------------------------------------------------- case 7: a merge the guard would refuse

const rogue = run.executed.find((row) => row.chunkId === "hy-f-to-04" && row.targetChunk === "hy-f-to-01");
assert(rogue !== undefined, "the unrelated merge is read as a merge");
if (rogue) {
	assert(
		rogue.passedBy === "no clause should have passed it",
		`a merge the guard would refuse is reported as one, saw ${rogue.passedBy}`,
	);
	assert(
		rogue.declaredDropped.length > 0,
		`and it took declared values with it, saw ${rogue.declaredDropped.join(",")}`,
	);
}

// ---------------------------------------------------------------- case 4: the duplicate 7.14 asks about

const dup = run.sameValue.find((row) => row.chunkId === "hy-f-to-04" && row.value === "9000");
assert(dup !== undefined, "two drafts carrying 9000 in one chunk are found");
if (dup) {
	assert(dup.drafts === 2, `both drafts carry the value, saw ${dup.drafts}`);
	assert(dup.activeAfter === 2, `reconcile banked both instead of merging, saw ${dup.activeAfter}`);
	assert(dup.ops.includes("UPDATE"), "one of them was an UPDATE onto the earlier cap entry");
}

// ---------------------------------------------------------------- case 5: drafted, then dropped outright

assert(run.skipOps === 1, `the SKIP is counted, saw ${run.skipOps}`);
const never = run.neverBanked.filter((row) => row.chunkId === "hy-f-to-04");
assert(
	never.some((row) => row.value === "8080"),
	"the log port value was drafted and never reached the bank: reported",
);

// ---------------------------------------------------------------- case 6: what a refusal costs

const refusal = run.downgrades.find((row) => row.recomputedMatch === true);
assert(refusal !== undefined, "a refusal whose recorded numbers match the guard is recognised as the guard's");
if (refusal) {
	assert(
		refusal.reason === "subject guard refused it",
		`the refusal is attributed to the guard, saw ${refusal.reason}`,
	);
	assert(refusal.targetDeclared.includes("9000"), "the refused target carried a declared value");
	assert(
		refusal.carriersAfter === 3,
		`refusing that merge left three active facts covering 9000, saw ${refusal.carriersAfter}`,
	);
}

const valueGateRefusal = run.downgrades.find((row) => row.reason === "value gate refused it");
assert(valueGateRefusal !== undefined, "a value-gate refusal is attributed to the value gate");
if (valueGateRefusal) {
	assert(valueGateRefusal.recomputedMatch === null, "a value-gate refusal has no shared counts to recompute");
	assert(
		valueGateRefusal.targetDeclared.includes("9000"),
		"the value-gate refusal names the value the target carried",
	);
}

const disagreeing = run.downgrades.filter((row) => row.recomputedMatch === false);
assert(disagreeing.length === 1, "the refusal whose recorded numbers do not match is reported as disagreeing");

// ---------------------------------------------------------------- aggregate shape

const total = run.executed.reduce((n, row) => n + row.declaredDropped.length, 0);
assert(total >= 2, `the run lost more than one declared value at merges, saw ${total}`);
assert(
	run.executed.every(
		(row) =>
			row.shared ===
			sameSubject(
				{ task: row.replacementTask, statement: row.replacementStatement },
				{ task: row.targetTask, statement: row.targetStatement },
			).shared,
	),
	"the guard numbers on each row come from the guard itself, not from the ledger's prose",
);
assert(
	!run.executed.some(
		(row) => row.passedBy === "restated half the target's wording" && row.declaredDropped.length > 0,
	),
	"the strict clause is not credited with a value loss it did not cause",
);
void textOf;
void carries;

if (failures === 0) {
	console.log(
		`ok: merge fixture — ${run.executed.length} executed merge(s), ${run.downgrades.length} refusal(s), ` +
			`${run.sameValue.length} same-value case(s), ${run.neverBanked.length} declared value(s) never banked, ` +
			`case 1 shows a guard-approved merge losing a declared value`,
	);
} else {
	console.log(`${failures} FAIL`);
	process.exit(1);
}
