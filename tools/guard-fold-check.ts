#!/usr/bin/env npx tsx

/**
 * tools/guard-fold-check.ts — tier 2's three guard settings against a ledger with known answers.
 *
 * dev/guard-fold-report.ts compares our subject guard as it ships, tightened, and switched off by
 * re-folding recorded ledgers. Two things could silently break that comparison, and this fixture is
 * built so neither survives:
 *
 *   - the arms must differ only in the subject test. A ledger's downgradedOps carry three kinds of
 *     refusal — the subject test, the retrieval test, the batch test — and only the first is a tier-2
 *     variable. The fixture records one of each and requires the fold to restore exactly one.
 *   - a merge is not an isolated event. Refusing one leaves its target active, which changes what a
 *     later merge can target at all. The fixture orders a second merge against the entry the first one
 *     created, so the tightened arm sees a target that was never written and the other two do not.
 *
 * Constructed outcomes:
 *
 *   1. a merge sharing 3 of 11 target tokens, dropping the chunk's declared value 2048
 *      -> shipped accepts and loses 2048; tightened refuses on the token count; guard off accepts
 *   2. a merge sharing 3 of 11 tokens against another entry, dropping declared 4096
 *      -> the same split
 *   3. a proposal the run recorded as refused by the subject test (1/5 shared), written as an ADD
 *      -> shipped and tightened re-refuse it; guard off applies it and loses 14096 outright
 *   4. refusals recorded for the retrieval test and the batch test, on the same chunk's other drafts
 *      -> left as ADDs in every arm, counted separately from subject refusals
 *   5. a later merge targeting the entry merge 1 created, restating all of its subject tokens
 *      -> shipped and guard off accept it; tightened cannot: its target was never written
 *   6. the rule itself, at all three boundaries
 *      -> 3/11 fails the tightened count, 4/20 fails the tightened ratio, 6/11 passes the strict
 *        clause under every setting, and a refused-under-both target stays in the bank
 *   7. the cost of each choice, measured in the bank each arm leaves behind
 *      -> a refusal leaves one value carried twice and another carried once; the shipped setting ends
 *        with the dropped number restored by a later draft and the config file named by nothing; guard
 *        off loses its value with nothing left to restore it
 *   8. the value arms, priced against the same rule boundaries
 *      -> the merge shipped accepts on 3/11 is refused by both value arms, naming 2048 and queue.toml
 *        as what the draft never restated; a draft restating both is accepted by both; a draft that
 *        carries every value on 2/11 shared passes value-only and fails value-carry, so the two arms
 *        are not aliases; and a target carrying no specific value at all passes value-only on 2/7
 *        shared, which is the hole value-carry exists to close
 */

import { downgradeKind, foldWithGuard, guardVerdict, proposalStream } from "../dev/guard-fold-report.js";
import { textOf } from "../dev/merge-report.js";
import { type CorpusChunk, carries } from "../dev/restraint-report.js";
import { newId } from "../src/bank.js";
import type { LedgerRecord } from "../src/types.js";

let failures = 0;
function assert(cond: boolean, label: string): void {
	if (!cond) {
		console.error(`FAIL: ${label}`);
		failures += 1;
	}
}

// ---------------------------------------------------------------- the rule, at each boundary

const target11 = {
	task: "queue depth limit",
	statement: "Queue depth limit is 2048 entries max in queue.toml config file size bytes count",
};
const draft3of11 = { task: "queue depth confirmation", statement: "User confirmed the queue depth limit" };
const draftStrict = { task: "queue depth limit", statement: "Queue depth limit is 2048 entries max in queue.toml" };
const target20 = {
	task: "queue retention purge window",
	statement:
		"Queue retention purge window drops entries older than the configured seconds in retention.toml settings file bytes mode owner group daily snapshot audit depth",
};
const draft4of20 = { task: "queue retention purge window", statement: "Retention purge window was reviewed" };
const targetRefused = { task: "backlog total", statement: "Backlog total is 14096 entries in the queue" };
const draftRefused = { task: "backlog confirmation", statement: "User wanted the backlog figure only" };

const loose = guardVerdict("shipped", draft3of11, target11);
const looseTight = guardVerdict("tightened", draft3of11, target11);
const looseOff = guardVerdict("off", draft3of11, target11);
assert(
	loose.shared === 3 && loose.targetSize === 11,
	`3 shared of 11 target tokens, saw ${loose.shared}/${loose.targetSize}`,
);
assert(loose.ok && loose.clause === "loose clause", "as shipped: 3 shared tokens and a quarter of the wording passes");
assert(!looseTight.ok, "tightened: the same merge fails on the shared-token count");
assert(looseOff.ok, "guard off: no test runs at all");

const ratioShipped = guardVerdict("shipped", draft4of20, target20);
const ratioTight = guardVerdict("tightened", draft4of20, target20);
assert(
	ratioShipped.shared === 4 && ratioShipped.targetSize === 20,
	`4 shared of 20, saw ${ratioShipped.shared}/${ratioShipped.targetSize}`,
);
assert(ratioShipped.ok && ratioShipped.clause === "loose clause", "as shipped: a fifth of the wording is enough");
assert(!ratioTight.ok, "tightened: the same merge fails on the ratio rather than the count");

const strict = guardVerdict("tightened", draftStrict, target11);
assert(
	strict.shared === 6 && strict.targetSize === 11,
	`the strict-clause case shares 6 of 11, saw ${strict.shared}/${strict.targetSize}`,
);
assert(
	strict.ok && strict.clause === "restated half the target's wording",
	"the strict clause is untouched by the tightening",
);

const bothRefuse = guardVerdict("tightened", draftRefused, targetRefused);
const shippedRefuses = guardVerdict("shipped", draftRefused, targetRefused);
assert(!bothRefuse.ok && !shippedRefuses.ok, "1 shared of 5 fails under both settings");
assert(guardVerdict("off", draftRefused, targetRefused).ok, "and would have run under no guard");

// The value arms, which is the option a merge gate could ship without asking the model to phrase
// anything: the target's own specific tokens have to be restated by the draft.
const draftValuesOnly = { task: "queue.toml", statement: "2048 max in queue.toml" };
const plainTarget = { task: "queue status", statement: "Queue status looked fine today, nothing to change" };
const plainDraft = { task: "queue look", statement: "Looked at the queue once" };

const carryLoose = guardVerdict("value-carry", draft3of11, target11);
const onlyLoose = guardVerdict("value-only", draft3of11, target11);
assert(loose.ok, "as shipped this merge runs — it is the one the value arms exist to stop");
assert(
	!carryLoose.ok && JSON.stringify(carryLoose.missingValues) === JSON.stringify(["2048", "queue.toml"]),
	`value-carry refuses it and names what the draft never restated, saw ${JSON.stringify(carryLoose.missingValues)}`,
);
assert(!onlyLoose.ok, "value-only refuses it too, on the value test alone");
assert(
	guardVerdict("value-carry", draftStrict, target11).ok && guardVerdict("value-only", draftStrict, target11).ok,
	"a draft that restates 2048 and queue.toml is allowed by both value arms",
);
// The two arms are not aliases: this draft carries every value but shares 2 of 11 tokens.
const carryWeak = guardVerdict("value-carry", draftValuesOnly, target11);
const onlyWeak = guardVerdict("value-only", draftValuesOnly, target11);
assert(!carryWeak.ok, "value-carry still needs the wording rule: 2/11 is not a restatement");
assert(
	onlyWeak.ok && onlyWeak.clause === "every value the target carried is restated",
	"value-only accepts it on values alone",
);
// And the hole that makes the two arms different decisions rather than two spellings of one:
// a target carrying no specific value at all passes value-only on any subject overlap.
const carryPlain = guardVerdict("value-carry", plainDraft, plainTarget);
const onlyPlain = guardVerdict("value-only", plainDraft, plainTarget);
assert(
	onlyPlain.ok && onlyPlain.clause === "target carried no specific value",
	"value-only merges a valueless target it has no subject test for",
);
assert(!carryPlain.ok, "value-carry refuses that same merge on wording");
assert(
	downgradeKind("target does not restate its subject (2/9 shared); recorded as ADD") === "subject",
	"the subject test is recognised",
);
assert(
	downgradeKind("update target not retrieved for this draft; recorded as ADD") === "retrieval",
	"the retrieval test is not a tier-2 variable",
);
assert(
	downgradeKind("target already superseded in this batch; recorded as ADD") === "batch",
	"the batch test is not a tier-2 variable",
);

// ---------------------------------------------------------------- the fixture ledger

const chunks: CorpusChunk[] = [
	{
		chunkId: "gf-to-01",
		class: "tool_output",
		probes: ["2048", "queue.toml"],
		text: "[1] [Tool result for bash @ 09:01]: queue depth limit is 2048 entries max, queue.toml",
	},
	{ chunkId: "gf-b", class: "nothing_work", text: "[1] [User @ 09:02]: Just confirming the depth limit." },
	{
		chunkId: "gf-to-02",
		class: "tool_output",
		probes: ["4096"],
		text: "[1] [Tool result for bash @ 09:03]: message size ceiling 4096 bytes per message payload header frame octet count limit",
	},
	{ chunkId: "gf-c", class: "nothing_work", text: "[1] [User @ 09:04]: Confirming the ceiling, that is all." },
	{
		chunkId: "gf-to-03",
		class: "tool_output",
		probes: ["14096"],
		text: "[1] [Tool result for bash @ 09:05]: backlog total 14096 entries",
	},
	{ chunkId: "gf-d", class: "nothing_work", text: "[1] [User @ 09:06]: Wanted the backlog number, nothing further." },
	{ chunkId: "gf-e", class: "nothing_work", text: "[1] [User @ 09:07]: Right, that depth limit is the one we use." },
];

const A = {
	task: "queue depth limit",
	statement: "Queue depth limit is 2048 entries max in queue.toml config file size bytes count",
	keys: ["2048", "queue.toml"],
};
// 3 shared of 11 target tokens, and 2048 gone.
const B = { task: "queue depth confirmation", statement: "User confirmed the queue depth limit", keys: ["queue.toml"] };
const C = {
	task: "message size ceiling",
	statement: "Message size ceiling is 4096 bytes per message payload header frame octet count limit",
	keys: ["4096"],
};
const D = {
	task: "message size ceiling",
	statement: "Message size ceiling confirmed",
	keys: ["message", "size", "ceiling", "confirmed"],
};
const E = { task: "backlog total", statement: "Backlog total is 14096 entries in the queue", keys: ["14096"] };
// The proposal the run recorded as refused by the subject test, written as an ADD.
const F = { task: "backlog confirmation", statement: "User wanted the backlog figure only", keys: ["backlog"] };
// Drafts whose merges the other two checks refused.
const H = {
	task: "queue settings file location",
	statement: "Settings were read once from the settings file",
	keys: ["settings file"],
};
const I = { task: "queue depth note", statement: "Queue depth was mentioned in passing", keys: ["queue"] };
// Targets the entry B's merge created and restates every one of its subject tokens, 2048 included.
const G = {
	task: "queue depth confirmation",
	statement: "User confirmed the queue depth limit is 2048",
	keys: ["2048"],
};

const usage = { inTokens: 0, outTokens: 0, wallS: 0 };

function extract(chunkId: string, at: string, drafts: { task: string; statement: string; keys: string[] }[]) {
	return {
		type: "hy.extract" as const,
		chunkId,
		coversUpToId: `${chunkId}-r1`,
		createdAt: `2026-10-23T09:${at}:00.000Z`,
		drafts: drafts.map((d) => ({ ...d, refs: [], fromUser: true, sourceEntryIds: [] })),
		rejectedCount: 0,
		usage,
	};
}

const records: LedgerRecord[] = [
	extract("gf-to-01", "01", [A]),
	{
		type: "hy.ops",
		chunkId: "gf-to-01",
		coversUpToId: "gf-to-01-r1",
		createdAt: "2026-10-23T09:01:01.000Z",
		ops: [{ action: "ADD", draft: 0 }],
		rejectedCount: 0,
		usage,
	},
	extract("gf-b", "02", [B]),
	{
		type: "hy.ops",
		chunkId: "gf-b",
		coversUpToId: "gf-b-r1",
		createdAt: "2026-10-23T09:02:01.000Z",
		ops: [{ action: "UPDATE", draft: 0, target: newId("gf-to-01:0:ADD"), reason: "same depth limit" }],
		rejectedCount: 0,
		usage,
	},
	extract("gf-to-02", "03", [C]),
	{
		type: "hy.ops",
		chunkId: "gf-to-02",
		coversUpToId: "gf-to-02-r1",
		createdAt: "2026-10-23T09:03:01.000Z",
		ops: [{ action: "ADD", draft: 0 }],
		rejectedCount: 0,
		usage,
	},
	extract("gf-c", "04", [D]),
	{
		type: "hy.ops",
		chunkId: "gf-c",
		coversUpToId: "gf-c-r1",
		createdAt: "2026-10-23T09:04:01.000Z",
		ops: [{ action: "UPDATE", draft: 0, target: newId("gf-to-02:0:ADD"), reason: "same ceiling" }],
		rejectedCount: 0,
		usage,
	},
	extract("gf-to-03", "05", [E]),
	{
		type: "hy.ops",
		chunkId: "gf-to-03",
		coversUpToId: "gf-to-03-r1",
		createdAt: "2026-10-23T09:05:01.000Z",
		ops: [{ action: "ADD", draft: 0 }],
		rejectedCount: 0,
		usage,
	},
	extract("gf-d", "06", [F, H, I]),
	{
		type: "hy.ops",
		chunkId: "gf-d",
		coversUpToId: "gf-d-r1",
		createdAt: "2026-10-23T09:06:01.000Z",
		ops: [
			{ action: "ADD", draft: 0 },
			{ action: "ADD", draft: 1 },
			{ action: "ADD", draft: 2 },
		],
		rejectedCount: 0,
		// What the run recorded: the subject test refused draft 0's merge, the retrieval test refused
		// draft 1's, the batch test refused draft 2's. Only the first is restored as a proposal.
		downgradedOps: [
			{
				reason: "target does not restate its subject (1/5 shared); recorded as ADD",
				draft: 0,
				target: newId("gf-to-03:0:ADD"),
			},
			{
				reason: "update target not retrieved for this draft; recorded as ADD",
				draft: 1,
				target: newId("gf-to-01:0:ADD"),
			},
			{
				reason: "target already superseded in this batch; recorded as ADD",
				draft: 2,
				target: newId("gf-to-01:0:ADD"),
			},
		],
		usage,
	},
	extract("gf-e", "07", [G]),
	{
		type: "hy.ops",
		chunkId: "gf-e",
		coversUpToId: "gf-e-r1",
		createdAt: "2026-10-23T09:07:01.000Z",
		// Targets the entry B's merge created. Under the tightened setting B never wrote one.
		ops: [{ action: "UPDATE", draft: 0, target: newId("gf-b:0:UPDATE"), reason: "same limit, restated" }],
		rejectedCount: 0,
		usage,
	},
];

const opsRecord = records.find((r) => r.type === "hy.ops" && r.chunkId === "gf-d");
const stream = proposalStream(opsRecord as Extract<LedgerRecord, { type: "hy.ops" }>);
assert(stream.restored === 1, `one subject refusal is put back as the UPDATE it was, saw ${stream.restored}`);
assert(stream.otherRefusals === 2, "the retrieval and batch refusals stay recorded ADDs");

const shipped = foldWithGuard("guard-fold-fixture", records, chunks, "shipped");
const tightened = foldWithGuard("guard-fold-fixture", records, chunks, "tightened");
const off = foldWithGuard("guard-fold-fixture", records, chunks, "off");

const lostIn = (r: typeof shipped) => new Set(r.declaredLost);
const carriers = (r: typeof shipped, value: string) =>
	r.bank.filter((e) => e.status === "active" && carries(value, textOf(e))).length;

// As shipped: every proposal the run recorded as a merge was accepted, and the one subject refusal
// is re-refused by the re-derived rule rather than trusted.
assert(shipped.proposed === 4, `four merges were proposed in total, saw ${shipped.proposed}`);
assert(
	shipped.accepted === 3 && shipped.refused === 1,
	`shipped accepts 3 and refuses 1, saw ${shipped.accepted}/${shipped.refused}`,
);
assert(
	shipped.recordedRefusals === 1 && shipped.refusedRestored === 1,
	"the shipped arm re-refuses the recorded subject refusal",
);
assert(shipped.acceptedRecordedRefusals === 0, "and accepts none of them");
assert(shipped.targetGone === 0, "under the shipped setting every recorded target was in place");
assert(
	lostIn(shipped).has("2048") && lostIn(shipped).has("4096"),
	`shipped loses 2048 and 4096, saw ${shipped.declaredLost.join(", ")}`,
);
assert(!lostIn(shipped).has("14096"), "and keeps 14096, because our guard stopped that merge");

// Tightened: both loose-clause merges fail, and the later merge loses its target outright.
assert(tightened.accepted === 0, `tightened accepts none of the four proposals, saw ${tightened.accepted}`);
assert(
	tightened.refused === 3,
	`tightened refuses both loose-clause merges and the restored one, saw ${tightened.refused}`,
);
assert(
	tightened.declaredLost.length === 0,
	`tightened loses no declared value, saw ${tightened.declaredLost.join(", ")}`,
);
assert(
	tightened.targetGone === 1,
	`the tightened arm never wrote a target a later merge needed, saw ${tightened.targetGone} cascade`,
);
assert(shipped.targetGone === 0 && off.targetGone === 0, "the other two arms had that entry in place");

// Guard off: everything the reconciler proposed, applied.
assert(off.accepted === 4 && off.refused === 0, `guard off applies every proposal, saw ${off.accepted}/${off.refused}`);
assert(off.declaredLost.length === 3, `guard off loses all three declared values, saw ${off.declaredLost.join(", ")}`);

// Every proposal is accounted for: accepted, refused, or a target this fold never wrote.
assert(
	shipped.reconciles && tightened.reconciles && off.reconciles,
	"accepted + refused + target gone equals proposed in every arm",
);

// Whether the value is still in the bank at the end, which is not the same question as whether a
// merge dropped it. The fixture's later draft restores 2048 in every arm that banked it.
const goneIn = (r: typeof shipped) => r.goneByTheEnd.map((g) => g.value);
assert(
	goneIn(shipped).sort().join(",") === "4096,queue.toml",
	`the shipped arm ends holding neither the number its merge dropped nor the config file, saw ${goneIn(shipped).join(", ")}`,
);
assert(goneIn(tightened).length === 0, `tightened loses nothing outright, saw ${goneIn(tightened).join(", ")}`);
assert(
	goneIn(off).sort().join(",") === "14096,4096,queue.toml",
	`guard off ends holding none of the values its bank once held, saw ${goneIn(off).join(", ")}`,
);

// The cost of each choice, in the bank each arm leaves behind.
assert(
	carriers(tightened, "queue.toml") === 2,
	`the refusal leaves the value the merge restated in two active facts, saw ${carriers(tightened, "queue.toml")}`,
);
assert(carriers(tightened, "2048") === 1, "and the value it would have dropped is still carried once");
assert(
	carriers(shipped, "queue.toml") === 0,
	"under the shipped setting nothing left in the bank names the config file",
);
assert(carriers(shipped, "2048") === 1, "and 2048 left the bank at the merge but a later draft put the number back");
assert(
	shipped.declaredLost.includes("2048") && carriers(shipped, "2048") > 0,
	"so a declared loss is a statement about the merge, not about the final bank",
);
assert(
	carriers(off, "14096") === 0,
	`guard off loses 14096 with nothing left to restore it, saw ${carriers(off, "14096")} carriers`,
);
assert(
	carriers(shipped, "14096") === 1 && carriers(tightened, "14096") === 1,
	"both arms that kept the refusal still carry it",
);

if (failures === 0) {
	console.log(
		`ok: guard-fold fixture — shipped ${shipped.accepted}/${shipped.proposed} accepted, ${shipped.declaredLost.length} declared lost; ` +
			`tightened ${tightened.accepted}/${tightened.proposed} accepted, ${tightened.declaredLost.length} declared lost, ${tightened.targetGone} cascade; ` +
			`guard off ${off.accepted}/${off.proposed} accepted, ${off.declaredLost.length} declared lost`,
	);
} else {
	console.error(`FAIL: ${failures} guard-fold assertion(s) failed`);
	process.exit(1);
}

// scratch inspection
