#!/usr/bin/env npx tsx

/**
 * tools/session-scope-check.ts — tier 6a's synthetic half: what the shipped rule permits across sessions.
 *
 * The real-data half (dev/session-scope-report.ts) can only report what was recorded, and almost every
 * recorded run holds one session, so its zero says nothing about the rule. This fixture builds the case
 * directly: a bank written by session A, and session B proposing a merge and a delete against it, through
 * the shipped candidate rendering (`candidatesPerDraft`), the shipped subject guard (`sameSubject`) and the
 * shipped write path (`applyOps`). No model, no corpus, no network.
 *
 * Four things are pinned:
 *
 *   1. candidate retrieval is unscoped — `candidatesPerDraft(bank, drafts, limit)` takes a bank and a
 *      draft and has no session to scope by, so session A's entry is offered to session B's draft
 *   2. the subject guard is blind to session identity — `sameSubject` reads only `{task, statement}` from
 *      each side, and the fixture proves it by giving the identical pair twice, once across sessions and
 *      once inside one session, and requiring the same numbers
 *   3. a cross-session UPDATE supersedes the other session's entry, and the replacement carries *its own*
 *      chunk id — the only session marker the bank keeps — so the record of who wrote the fact is
 *      overwritten by the session that destroyed it
 *   4. a cross-session DELETE needs nothing but the id
 *
 * And the contrast that bounds it: a draft that does not restate its target is refused on wording alone.
 * The fence that exists tests wording. It does not test ownership.
 */

import { passClause } from "../dev/merge-report.js";
import { analyseLedger } from "../dev/session-scope-report.js";
import { applyOps, foldLedger } from "../src/bank.js";
import { candidatesPerDraft, sameSubject } from "../src/protocol.js";
import type { BankEntry, Draft, LedgerRecord, ReconcileOp } from "../src/types.js";

let failures = 0;
function assert(cond: boolean, label: string): void {
	if (!cond) {
		console.error(`FAIL: ${label}`);
		failures += 1;
	}
}

const SESSION_A = "aaaaaaaa";
const SESSION_B = "bbbbbbbb";
const CHUNK_A1 = `hy-${SESSION_A}-001`;
const CHUNK_B1 = `hy-${SESSION_B}-001`;
const refs = ["entry-a-1", "entry-a-2", "entry-b-1", "entry-b-2", "entry-b-3"];

/** Session A's fact: a constraint established in that session, with the value tokens that carry it. */
const constraintDraft: Draft = {
	task: "queue purge scope",
	statement: "purge only touches the queue directory, and --purge-target is configured to var/state/queue",
	keys: ["--purge-target", "var/state/queue", "queue"],
	refs: [0, 1],
	fromUser: true,
};

/** Session B's draft: restates the purge subject, carries its own value, carries none of A's. */
const incomingDraft: Draft = {
	task: "queue purge age",
	statement: "purge drops entries older than 420 seconds unless pinned, and --purge-age is configured to 420",
	keys: ["--purge-age", "420", "queue"],
	refs: [2, 3],
};

/** A session B fact about something else, so the candidate set is not decided by having one entry in it. */
const neighbourDraft: Draft = {
	task: "queue drain lock held",
	statement: "the drain lock on the queue directory is being left in place for now, pid 4412",
	keys: ["4412", "queue", "drain"],
	refs: [4],
};

/** A draft that shares nothing with session A's fact, to show what wording alone already refuses. */
const unrelatedDraft: Draft = {
	task: "tls certificate rotation",
	statement: "the certificate rotates every 30 days through certbot renew --deploy-hook",
	keys: ["certbot", "--deploy-hook", "30"],
	refs: [5],
};

const bank: BankEntry[] = [];
applyOps(bank, [constraintDraft], [{ action: "ADD", draft: 0 }], CHUNK_A1, refs, "2026-10-23T09:00:00.000Z", 1);
const constraint = bank.find((e) => e.task === constraintDraft.task);
if (!constraint) {
	console.error("FAIL: session A's fact never reached the bank");
	process.exit(1);
}

// 1. Unscoped retrieval. The bank now holds one entry from session A and one from session B; session B's
//    draft is shown the entry written by the other session.
const bBank: BankEntry[] = [];
applyOps(bBank, [neighbourDraft], [{ action: "ADD", draft: 0 }], CHUNK_B1, refs, "2026-10-23T09:30:00.000Z", 1);
const shownToB = candidatesPerDraft([...bank, ...bBank], [incomingDraft], 8).get(0) ?? [];
assert(shownToB.length > 1, `the candidate set is degenerate: ${JSON.stringify(shownToB.map((e) => e.task))}`);
assert(
	shownToB.some((e) => e.id === constraint.id),
	`session A's entry was not offered to session B's draft: ${JSON.stringify(shownToB.map((e) => `${e.chunkId} ${e.task}`))}`,
);

// 2. Session identity cannot reach the guard: same pair, authored twice — once in session A's chunk and
//    once in session B's — must produce identical numbers.
const twinBank: BankEntry[] = [];
applyOps(twinBank, [constraintDraft], [{ action: "ADD", draft: 0 }], CHUNK_B1, refs, "2026-10-23T09:00:00.000Z", 1);
const twin = twinBank[0];
// Ids are seeded from the chunk id, so the twin is a different entry by construction. What has to match
// is everything the guard reads.
assert(
	twin.id !== constraint.id &&
		twin.chunkId === CHUNK_B1 &&
		twin.task === constraint.task &&
		twin.statement === constraint.statement &&
		twin.keys.join("|") === constraint.keys.join("|"),
	`the twin entry is not the same fact written in the other session: ${twin.chunkId} ${twin.task}`,
);

const cross = sameSubject(incomingDraft, constraint);
const local = sameSubject(incomingDraft, twin);
assert(
	cross.ok,
	`the shipped guard should accept this pair as written, saw shared ${cross.shared}/${cross.targetSize}`,
);
assert(
	passClause(cross.shared, cross.targetSize) === "shared 3+ tokens, under half the wording",
	`the pair was not accepted by the loose clause this tier is about: ${passClause(cross.shared, cross.targetSize)}`,
);
assert(
	cross.ok === local.ok && cross.shared === local.shared && cross.targetSize === local.targetSize,
	`the guard treated the cross-session pair differently from the same-session pair: ${JSON.stringify(cross)} vs ${JSON.stringify(local)}`,
);

// 3. The cross-session merge applies, and the replacement carries the destroying session's chunk id.
const ops: ReconcileOp[] = [
	{ action: "UPDATE", draft: 0, target: constraint.id, reason: "aligns with the purge configuration" },
];
const report = applyOps(bank, [incomingDraft], ops, CHUNK_B1, refs, "2026-10-23T11:00:00.000Z", 2);
assert(report.updated.length === 1, `the cross-session UPDATE was not applied: ${JSON.stringify(report.updated)}`);
assert(constraint.status === "superseded", "session A's entry was left active after being superseded");
const replacement = bank.find((e) => e.id === constraint.supersededBy);
assert(replacement !== undefined, "no replacement entry was written for the superseded fact");
assert(replacement?.chunkId === CHUNK_B1, `the replacement carries the wrong chunk: ${replacement?.chunkId}`);
assert(
	constraint.chunkId === CHUNK_A1 && (replacement?.chunkId ?? "").startsWith(`hy-${SESSION_B}-`),
	"the bank does not distinguish which session wrote the surviving fact from which session destroyed it",
);
assert(
	bank.every((entry) => !Object.keys(entry).some((key) => /session/i.test(key))),
	`a bank entry turned out to carry a session field after all: ${Object.keys(bank[0]).join(", ")}`,
);

// The value only session A's fact carried is gone from every active fact.
const activeText = bank
	.filter((e) => e.status === "active")
	.map((e) => `${e.task} ${e.statement} ${e.keys.join(" ")}`)
	.join(" | ");
assert(!activeText.includes("--purge-target"), "the destroyed fact's flag survived in the active bank");
assert(!activeText.includes("var/state/queue"), "the destroyed fact's configured path survived in the active bank");
assert(activeText.includes("--purge-age"), "the fixture is wrong if the destroying draft's own value is missing");

// 4. A delete needs nothing but the id.
const third = applyOps(
	bank,
	[],
	[{ action: "DELETE", target: replacement!.id, reason: "superseded later" }],
	CHUNK_A1,
	refs,
	"2026-10-23T12:00:00.000Z",
	3,
);
assert(
	third.deleted.length === 1,
	`a DELETE from one session did not supersede another session's entry: ${JSON.stringify(third.deleted)}`,
);
assert(replacement!.status === "superseded", "the entry is still active after the delete");

// The contrast that bounds the finding: wording is the fence, ownership is not.
const unrelated = sameSubject(unrelatedDraft, constraint);
assert(!unrelated.ok, `a draft that restates nothing was accepted anyway: ${JSON.stringify(unrelated)}`);

// 5. The real-data half of this tier counts two different things and must never read them as one: an op the
//    bank applied, and one it refused and wrote as an ADD instead. A refusal is a wording test saying no,
//    not a session boundary saying no. The ledgers below are authored here — no model, no corpus — so what
//    gets pinned is the classifier that reads real ledgers.
function fixtureLedger(applied: boolean, reason: string): LedgerRecord[] {
	const usage = { inTokens: 100, outTokens: 40, wallS: 1 };
	const records: LedgerRecord[] = [
		{
			type: "hy.extract",
			chunkId: CHUNK_A1,
			coversUpToId: `${CHUNK_A1}-r1`,
			createdAt: "2026-10-23T09:00:00.000Z",
			drafts: [{ ...constraintDraft, sourceEntryIds: [] }],
			rejectedCount: 0,
			usage,
		},
		{
			type: "hy.ops",
			chunkId: CHUNK_A1,
			coversUpToId: `${CHUNK_A1}-r1`,
			createdAt: "2026-10-23T09:00:05.000Z",
			ops: [{ action: "ADD", draft: 0 }],
			rejectedCount: 0,
			usage,
		},
		{
			type: "hy.extract",
			chunkId: CHUNK_B1,
			coversUpToId: `${CHUNK_B1}-r1`,
			createdAt: "2026-10-23T09:30:00.000Z",
			drafts: [{ ...incomingDraft, sourceEntryIds: [] }],
			rejectedCount: 0,
			usage,
		},
	];
	// The id session A's entry gets belongs to the fold, not to this file: build the prefix, read the id
	// back, and the destructive op below aims at a live entry the other session wrote.
	const written = foldLedger(records);
	const target = written.find((entry) => entry.chunkId === CHUNK_A1);
	if (!target) throw new Error("the fixture ledger never wrote session A's entry");
	records.push({
		type: "hy.ops",
		chunkId: CHUNK_B1,
		coversUpToId: `${CHUNK_B1}-r1`,
		createdAt: "2026-10-23T09:30:05.000Z",
		ops: applied ? [{ action: "UPDATE", draft: 0, target: target.id, reason: "restated the purge subject" }] : [],
		rejectedCount: 0,
		downgradedOps: applied ? [] : [{ reason, draft: 0, target: target.id }],
		usage,
	});
	return records;
}

const guardReason = "target does not restate its subject (3/8 shared); recorded as ADD";
const retrievalReason = "update target not retrieved for this draft; recorded as ADD";
const refusedScope = analyseLedger("fixture-refused", fixtureLedger(false, guardReason));
assert(
	refusedScope.destructiveOps === 0 && refusedScope.crossSession.length === 0,
	`a proposal the bank refused was counted as an applied crossing: ${JSON.stringify(refusedScope.crossSession)}`,
);
assert(
	refusedScope.proposedOps === 1 && refusedScope.proposedCrossSession.length === 1,
	`the refused cross-session proposal went uncounted: ${JSON.stringify(refusedScope.proposedCrossSession)}`,
);
assert(refusedScope.proposedCrossSession[0]?.applied === false, "the instrument marked a refused proposal as applied");
assert(
	refusedScope.proposedCrossSession[0]?.targetChunk === CHUNK_A1,
	"the refused proposal did not name the chunk the other session wrote",
);

const ranScope = analyseLedger("fixture-applied", fixtureLedger(true, guardReason));
assert(
	ranScope.destructiveOps === 1 && ranScope.crossSession.length === 1,
	`the applied cross-session op went uncounted: ${JSON.stringify(ranScope.crossSession)}`,
);
assert(ranScope.crossSession[0]?.applied === true, "the instrument marked an applied op as refused");
assert(ranScope.proposedOps === 0, "an op the bank applied was also counted as a refusal");

assert(
	refusedScope.spansSessions && ranScope.spansSessions,
	"the fixture ledger stopped spanning two sessions, so no crossing could be seen in it",
);

// 5. The bank records which rule said no, and the report reads it off that record rather than inferring a
//    kind from an ADD landing where an UPDATE was proposed. A merge the subject guard refused and a target
//    the candidate set never offered are different events; an unrecognised reason stops the report instead
//    of becoming a fourth bucket that quietly absorbs whatever it does not know.
const retrievalScope = analyseLedger("fixture-retrieval-refusal", fixtureLedger(false, retrievalReason));
assert(
	refusedScope.proposedKinds["subject guard"] === 1 && refusedScope.proposedKinds["target not retrieved"] === 0,
	`the subject-guard refusal was not classified as one: ${JSON.stringify(refusedScope.proposedKinds)}`,
);
assert(
	retrievalScope.proposedKinds["target not retrieved"] === 1 &&
		retrievalScope.proposedKinds["subject guard"] === 0 &&
		retrievalScope.proposedCrossSession.length === 1,
	`a retrieval refusal aimed at another session's entry was not kept apart from a guard refusal: ${JSON.stringify(retrievalScope.proposedKinds)}`,
);

let unknownReasonStopped = false;
try {
	analyseLedger("fixture-unknown-reason", fixtureLedger(false, "some rule said no that this report does not know"));
} catch {
	unknownReasonStopped = true;
}
assert(unknownReasonStopped, "the report classified a refusal reason it has no kind for instead of stopping");

// 6. The menu axis, kept apart from the op axis. A fact from the other session can be offered as a merge
//    candidate without the guard letting a draft destroy it. Session B's neighbour fact shares the technical
//    noun "queue" and the word "directory" with session A's fact: enough for retrieval to put it on the menu,
//    not enough for the subject guard to accept it as a restatement.
const shortUsage = { inTokens: 100, outTokens: 40, wallS: 1 };
const menuRecords: LedgerRecord[] = [
	{
		type: "hy.extract",
		chunkId: CHUNK_A1,
		coversUpToId: `${CHUNK_A1}-r1`,
		createdAt: "2026-10-23T09:00:00.000Z",
		drafts: [{ ...constraintDraft, sourceEntryIds: [] }],
		rejectedCount: 0,
		usage: shortUsage,
	},
	{
		type: "hy.ops",
		chunkId: CHUNK_A1,
		coversUpToId: `${CHUNK_A1}-r1`,
		createdAt: "2026-10-23T09:00:05.000Z",
		ops: [{ action: "ADD", draft: 0 }],
		rejectedCount: 0,
		usage: shortUsage,
	},
	{
		type: "hy.extract",
		chunkId: CHUNK_B1,
		coversUpToId: `${CHUNK_B1}-r1`,
		createdAt: "2026-10-23T09:30:00.000Z",
		drafts: [{ ...neighbourDraft, sourceEntryIds: [] }],
		rejectedCount: 0,
		usage: shortUsage,
	},
	{
		type: "hy.ops",
		chunkId: CHUNK_B1,
		coversUpToId: `${CHUNK_B1}-r1`,
		createdAt: "2026-10-23T09:30:05.000Z",
		ops: [{ action: "ADD", draft: 0 }],
		rejectedCount: 0,
		usage: shortUsage,
	},
];
const menuScope = analyseLedger("fixture-menu", menuRecords);
const menuRow = menuScope.exposure.find((row) => row.chunkId === CHUNK_B1);
const neighbourPair = sameSubject(neighbourDraft, constraint);
assert(
	menuRow !== undefined && menuRow.cross === 1 && menuRow.crossEligible === 0,
	`the other session's fact on the menu was not kept apart from a merge the guard would permit: ${JSON.stringify(menuRow)}`,
);
assert(
	!neighbourPair.ok,
	`the guard should refuse the neighbour pair as a restatement: shared ${neighbourPair.shared}/${neighbourPair.targetSize}`,
);

// And the case the tier is about: the restatement drafted in session B is offered session A's fact, and the
// guard would have let it through. Whether the model reached for it is a separate count.
const refusedRow = refusedScope.exposure.find((row) => row.chunkId === CHUNK_B1);
assert(
	refusedRow !== undefined && refusedRow.cross >= 1 && refusedRow.crossEligible >= 1,
	`session A's fact was not offered to session B's restatement as a merge-eligible candidate: ${JSON.stringify(refusedRow)}`,
);

if (failures === 0) {
	console.log("  the permission structure, all three cases this fixture runs:");
	console.log(
		`    draft from session B, target written by session A     accepted  ${cross.shared}/${cross.targetSize}` +
			`  ${passClause(cross.shared, cross.targetSize)}`,
	);
	console.log(
		`    draft from session B, same fact written by session B   accepted  ${local.shared}/${local.targetSize}` +
			`  ${passClause(local.shared, local.targetSize)}`,
	);
	console.log(
		`    unrelated draft, target written by session A           refused   ${unrelated.shared}/${unrelated.targetSize}` +
			`  ${passClause(unrelated.shared, unrelated.targetSize)}`,
	);
	console.log(
		`ok: session scope fixture — the shipped rule permits this case: session B was shown session A's fact among ${shownToB.length} candidates; ` +
			`the guard scored the pair ${cross.shared}/${cross.targetSize} identically across sessions and within ` +
			`one; after the merge the only session marker left in the bank belongs to the session that destroyed ` +
			`the fact, and ${cross.targetSize - cross.shared} of the target's subject tokens went unrestated ` +
			`(accepted by the loose clause: ${passClause(cross.shared, cross.targetSize)}); and the ledger ` +
			`classifier keeps the two apart — ${ranScope.crossSession.length} applied crossing and ` +
			`${refusedScope.proposedCrossSession.length} refused crossing in the ledgers authored here — and the menu is ` +
			`counted apart from both: ${menuRow?.cross} candidate from the other session offered to a draft that ` +
			`wording alone refuses (${menuRow?.crossEligible} eligible), ${refusedRow?.crossEligible} offered to a ` +
			`draft the guard would accept`,
	);
} else {
	console.error(`FAIL: ${failures} session-scope assertion(s) failed`);
	process.exit(1);
}
