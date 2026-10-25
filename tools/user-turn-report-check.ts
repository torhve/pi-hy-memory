#!/usr/bin/env node
import { analyseSession, classifyTurn } from "../dev/user-turn-report.js";
/**
 * Is a user turn groundable at all (TODO 6.20b). Run: npx tsx tools/user-turn-report-check.ts
 *
 * `fromUser` says a draft cited a line labelled User. On a real session that label is mostly a
 * go-ahead or a question, the constraint usually sits in the assistant's restatement one turn
 * later, and a merge that restates a marked fact writes an unmarked successor. This fixture pins
 * each of those on text whose answers are known by construction, so the report's numbers mean what
 * they say:
 *
 *   - "proceed to the next" is a go-ahead, not a constraint, and grounds nothing
 *   - a directive restated by the assistant is detected as restated, at the turn that restates it
 *   - a draft citing the restatement carries the user's wording with no mark on it
 *   - a marked fact superseded by a merge leaves an unmarked successor that still carries the
 *     wording, and the chain says where the mark went
 *   - a draft citing the user's question is marked, and carries nothing the user decided
 */
import { entryFromDraft } from "../src/bank.js";
import type { BankEntry, Draft, LedgerRecord } from "../src/types.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const text = [
	"[0] [User @ 00:01]: proceed to the next",
	'[1] [Assistant @ 00:02]: [called bash {"command":"grep nightly schedule.toml"}]',
	"[2] [Tool result for bash @ 00:02]: nightly = 02:30 in schedule.toml",
	"[3] [User @ 00:03]: don't resize the nightly pool before Friday, keep schedule.toml alone",
	"[4] [Assistant @ 00:04]: understood — the nightly pool stays as it is until Friday and schedule.toml is not touched",
	"[5] [User @ 00:05]: what does the tail say?",
].join("\n");

// refs[i] is the entry id of the i-th labelled line, exactly as a capture stores it.
const refs = ["e0", "e1", "e2", "e3", "e4", "e5"];
const usage = { inTokens: 10, outTokens: 5, wallS: 1 };
const drafted = (task: string, statement: string, entryId: string, fromUser: boolean) => ({
	task,
	statement,
	keys: [task],
	refs: [refs.indexOf(entryId)],
	fromUser,
	sourceEntryIds: [entryId],
});

// D0 states the user's rule but cites the assistant's restatement; D1 cites the user's question;
// D2 cites the tool output and shares two of the directive's words, which is not enough to count.
const drafts = [
	drafted(
		"nightly pool",
		"The nightly pool is not resized before Friday and schedule.toml is left alone",
		"e4",
		false,
	),
	drafted("tail", "User asked what the tail of the log says", "e5", true),
	drafted("schedule", "nightly = 02:30 in schedule.toml", "e2", false),
];

const records: LedgerRecord[] = [
	{
		type: "hy.extract",
		chunkId: "hy-ut-001",
		coversUpToId: "e5",
		createdAt: "2026-10-25T11:01:00.000Z",
		drafts,
		rejectedCount: 0,
		usage,
	},
	{
		type: "hy.ops",
		chunkId: "hy-ut-001",
		coversUpToId: "e5",
		createdAt: "2026-10-25T11:01:30.000Z",
		ops: [
			{ action: "ADD", draft: 0 },
			{ action: "ADD", draft: 1 },
			{ action: "ADD", draft: 2 },
		],
		rejectedCount: 0,
		usage,
	},
];

const bank: BankEntry[] = [];
for (const index of [0, 1, 2]) {
	bank.push(
		entryFromDraft(
			drafts[index] as Draft,
			"hy-ut-001",
			refs,
			"2026-10-25T11:01:30.000Z",
			`hy-ut-001:${index}:ADD`,
			1,
		),
	);
}
// A marked fact, then the merge that took its place: the successor carries the wording, loses the mark.
const marked = entryFromDraft(
	drafted("nightly pool", "Rule from the user: no nightly pool resize before Friday", "e3", true),
	"hy-ut-002",
	refs,
	"2026-10-25T11:02:00.000Z",
	"hy-ut-002:0:ADD",
	2,
);
const successor = entryFromDraft(
	drafted("nightly pool", "The nightly pool stays until Friday and schedule.toml stays alone", "e4", false),
	"hy-ut-003",
	refs,
	"2026-10-25T11:03:00.000Z",
	"hy-ut-003:0:ADD",
	3,
);
successor.supersedes = marked.id;
successor.status = "active";
marked.status = "superseded";
marked.supersededBy = successor.id;
const retired = entryFromDraft(
	drafted("tail", "Rule from the user: keep the tail short", "e3", true),
	"hy-ut-004",
	refs,
	"2026-10-25T11:04:00.000Z",
	"hy-ut-004:0:ADD",
	4,
);
retired.status = "superseded";
retired.supersedeReason = "bank budget";
// A third cause, distinct from both: the fact was invalidated by a later chunk, not replaced.
const invalidated = entryFromDraft(
	drafted("scope", "Rule from the user: touch nothing in the legacy module", "e3", true),
	"hy-ut-005",
	refs,
	"2026-10-25T11:05:00.000Z",
	"hy-ut-005:0:ADD",
	5,
);
invalidated.status = "superseded";
invalidated.supersedeReason = "invalidated by newer chunk";
bank.push(marked, successor, retired, invalidated);

const read = analyseSession("ut", [{ chunkId: "hy-ut-001", text, refs }], records, bank);

check(
	"a go-ahead is a shape of its own, not a constraint and not a question",
	classifyTurn("proceed to the next"),
	"ack",
);
check("an instruction is a directive", classifyTurn("don't resize the pool before Friday"), "directive");
check("a bare ask is a question", classifyTurn("what does the tail say?"), "question");
check(
	"shapes counted",
	[read.shapes.ack, read.shapes.directive, read.shapes.question, read.shapes.neither],
	[1, 1, 1, 0],
);
check(
	"the directive is detected as restated, at the turn that restates it",
	read.turns.find((turn) => turn.shape === "directive")?.restatedBy,
	4,
);
check("coverage is stated: captured chunks are not the whole ledger", [read.capturedChunks, read.ledgerWrites], [1, 1]);
check(
	"the only user line a draft cited was a question",
	[
		read.draftsCitingUser.question,
		read.draftsCitingUser.directive,
		read.draftsCitingUser.ack,
		read.draftsCitingUser.neither,
	],
	[1, 0, 0, 0],
);
check(
	"the draft that carries the user's rule cites the restatement, not the user",
	read.draftsCarryingDirectiveUnmarked,
	1,
);
check(
	"the tool-output draft shares two words only, so it does not count as carrying the rule",
	read.bankFactsCarryingDirective,
	2,
);
check(
	"neither of them is marked, although the bank has marks on it",
	[read.bankFactsCarryingDirectiveMarked, read.bankFactsMarkedUser],
	[0, 1],
);
check("one of them sits where a marked fact used to be", read.bankFactsCarryingDirectiveFromMarkedAncestor, 1);
check(
	"where the marks went, by cause: a merge, a ceiling retirement, an invalidation",
	[
		read.marksWritten,
		read.bankFactsMarkedUser,
		read.marksLostToMerge,
		read.marksLostToCeiling,
		read.marksLostToInvalidation,
	],
	[4, 1, 1, 1, 1],
);
check(
	"the causes add up to the marks no longer current, none unattributed",
	[read.marksLost, read.marksLostUnattributed],
	[3, 0],
);

console.log(
	failures === 0
		? "ok: go-aheads, restatements and merge-decayed marks are all counted separately"
		: `${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
