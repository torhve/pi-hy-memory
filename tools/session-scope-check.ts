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
import { applyOps } from "../src/bank.js";
import { candidatesPerDraft, sameSubject } from "../src/protocol.js";
import type { BankEntry, Draft, ReconcileOp } from "../src/types.js";

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

if (failures === 0) {
	console.log(
		`ok: session scope fixture — session B was shown session A's fact among ${shownToB.length} candidates; ` +
			`the guard scored the pair ${cross.shared}/${cross.targetSize} identically across sessions and within ` +
			`one; after the merge the only session marker left in the bank belongs to the session that destroyed ` +
			`the fact, and ${cross.targetSize - cross.shared} of the target's subject tokens went unrestated ` +
			`(accepted by the loose clause: ${passClause(cross.shared, cross.targetSize)})`,
	);
} else {
	console.error(`FAIL: ${failures} session-scope assertion(s) failed`);
	process.exit(1);
}
