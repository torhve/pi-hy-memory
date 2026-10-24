#!/usr/bin/env npx tsx

/**
 * tools/merge-value-gate-check.ts — the value gate pinned as the behaviour that ships.
 *
 * `mergeValueGate` decides whether an UPDATE that passes the subject guard is still refused because it
 * drops a value its target carries. This runs the shipped guard — `guardUpdateOps` from `src/protocol.ts`
 * — and folds the result through `applyOps`, so it pins the whole write path rather than a helper that
 * merely looks like it. Two things could silently break that, and the fixture is built so neither survives:
 *
 *   - the gate could be off by accident. The same merge is written with the gate off and required to
 *     destroy the number, so "the two arms agreed" is a failure rather than a pass.
 *   - the gate could refuse merges it has no business refusing: a draft that restates the values, a
 *     target carrying none, a value carried in `keys` rather than in the sentence. Each is asserted to
 *     merge.
 *
 * It also pins the reason string as a published interface: `dev/session-scope-report.ts` and
 * `dev/guard-fold-report.ts` read refusals back out of the ledger by that wording, and an unrecognised
 * reason makes the first of them throw rather than misreport.
 *
 * Constructed outcomes:
 *
 *   1. gate on, a merge that passes the subject test and drops 420 and queue.toml
 *      -> refused as an ADD naming both, and the target survives carrying them
 *   2. gate off, the same merge -> applied, and the bank holds neither value
 *   3. gate on, a draft that restates both -> applied, one active entry
 *   4. gate on, a draft that carries both only in its `keys` -> applied
 *   5. gate on, a target carrying no value at all -> applied
 *   6. a draft that fails the subject test -> refused under every gate setting, including off, and the
 *      value gate never gets the chance to overrule it
 *   7. the matcher's two edges -> `--retention-days 45` reworded as "forty-five days" reads as a loss,
 *      and a value inside a longer token is not a carry
 */

import { downgradeKind } from "../dev/guard-fold-report.js";
import { proposalKind } from "../dev/session-scope-report.js";
import { applyOps } from "../src/bank.js";
import { guardUpdateOps, sameSubject } from "../src/protocol.js";
import type { BankEntry, Draft, ReconcileOp } from "../src/types.js";
import { carries, valuesTheDraftDrops } from "../src/values.js";

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

const AT = "2026-06-01T10:00:00Z";

function entry(id: string, task: string, statement: string, keys: string[]): BankEntry {
	return {
		id,
		task,
		statement,
		keys,
		sourceEntryIds: [`e-${id}`],
		chunkId: "hy-9f000001-001",
		chunkSeq: 1,
		fromUser: true,
		createdAt: AT,
		status: "active",
		tokenCount: Math.ceil((task + statement).length / 4),
	};
}

function draft(task: string, statement: string, keys: string[]): Draft {
	return { task, statement, keys, refs: [1], fromUser: true };
}

const TARGET_TASK = "queue depth limit";
const TARGET_STATEMENT = "Queue depth limit is 420 entries max in queue.toml";

/** Runs one merge through the shipped guard, then through the write that records it. */
function merge(
	d: Draft,
	guards: { valueGate: boolean },
	target: BankEntry = entry("e-1", TARGET_TASK, TARGET_STATEMENT, ["420", "queue.toml"]),
): { ops: ReconcileOp[]; reasons: string[]; bank: BankEntry[] } {
	const bank = [target];
	const downgraded: { reason: string; op: unknown }[] = [];
	const ops = guardUpdateOps(bank, [d], [{ action: "UPDATE", draft: 0, target: target.id }], downgraded, guards);
	applyOps(bank, [d], ops, "hy-9f000002-002", ["e-2"], AT, 2);
	return { ops, reasons: downgraded.map((r) => r.reason), bank };
}

// Passes the subject test on wording (3 of the target's 5 vocabulary tokens), so the only thing
// standing between this merge and the number is the value gate.
const drops = draft("queue depth limit", "Queue depth limit was reviewed and left as it is", ["queue"]);
const on = merge(drops, { valueGate: true });
const off = merge(drops, { valueGate: false });

assert(on.ops[0]?.action === "ADD", `gate on refuses the merge, saw ${JSON.stringify(on.ops[0])}`);
assert(
	on.reasons.length === 1 &&
		on.reasons[0].includes("420") &&
		on.reasons[0].includes("queue.toml") &&
		on.reasons[0].startsWith("target carries a value the draft does not restate"),
	`the refusal names both values it stopped, saw ${JSON.stringify(on.reasons)}`,
);
const activeOn = on.bank.filter((e) => e.status === "active");
assert(
	activeOn.length === 2,
	`a refused merge leaves the original in the bank beside the new fact, saw ${activeOn.length}`,
);
assert(
	activeOn.some((e) => carries("420", `${e.task} ${e.statement} ${e.keys.join(" ")}`)),
	"and the number is still carried by something after the refusal",
);
assert(off.ops[0]?.action === "UPDATE", "gate off lets the same merge run, which is the difference being pinned");
const activeOff = off.bank.filter((e) => e.status === "active");
assert(activeOff.length === 1, `gate off leaves one entry, saw ${activeOff.length}`);
assert(
	!activeOff.some((e) => carries("420", `${e.task} ${e.statement} ${e.keys.join(" ")}`)),
	"and the number is gone — this is the loss the gate exists to stop",
);

// Merges the gate must not refuse.
const restated = merge(draft(TARGET_TASK, TARGET_STATEMENT, ["420", "queue.toml"]), { valueGate: true });
assert(restated.ops[0]?.action === "UPDATE" && restated.reasons.length === 0, "a restatement merges");
assert(
	merge(draft("queue depth", "The depth limit is what it is", ["420", "queue.toml"]), { valueGate: true }).ops[0]
		?.action === "UPDATE",
	"values carried in keys count, as they do for the subject test",
);
const valuelessTarget = entry("e-1", "queue status", "Queue status looked fine that day", []);
const valueless = merge(
	draft("queue status", "Queue status checked once", ["queue"]),
	{ valueGate: true },
	valuelessTarget,
);
assert(
	valueless.ops[0]?.action === "UPDATE" && valueless.reasons.length === 0,
	"a target with no value in it has nothing for the gate to hold",
);

// The subject test is not overruled by the gate: it refuses first, under every setting.
const wrongSubject = draft("node offline", "Node b went offline during the drain", ["node"]);
const inventory = entry("e-1", "container inventory", "Containers 113 games, 114 transcode, 120 inference", []);
for (const valueGate of [true, false]) {
	const refused = merge(wrongSubject, { valueGate }, inventory);
	assert(!sameSubject(wrongSubject, inventory).ok, "that pair is not one subject");
	assert(refused.ops[0]?.action === "ADD", `the subject test refuses with valueGate ${valueGate}`);
	assert(refused.reasons[0].startsWith("target does not restate its subject"), "and names itself as the reason");
}

// The reason wording is a published interface: the reports read it back out of the ledger.
assert(proposalKind(on.reasons[0]) === "value gate", "session-scope-report classifies the refusal");
assert(downgradeKind(on.reasons[0]) === "value gate", "guard-fold-report classifies it apart from subject refusals");

// The matcher's two edges, pinned so neither is mistaken for a parser.
assert(
	JSON.stringify(
		valuesTheDraftDrops(
			{ task: "cache purge flag", statement: "Purge stale tiles with --retention-days 45", keys: [] },
			{ task: "cache purge flag", statement: "Purge stale tiles older than forty-five days", keys: [] },
		),
	) === JSON.stringify(["--retention-days", "45"]),
	"a value reworded into prose reads as a loss, which is the gate's cost, not its bug",
);
assert(
	valuesTheDraftDrops(
		{ task: "build cache flag", statement: "Build with --cache-shard 7", keys: [] },
		{ task: "build cache flag", statement: "Build with --cache-shard-7x", keys: [] },
	).includes("--cache-shard"),
	"a value inside a longer token is not a carry",
);

console.log(
	`ok: value-gate fixture — with the gate on the merge that drops 420 is refused and named, with it off ` +
		`the same merge erases the number; restatements, key-carried values and valueless targets still merge; ` +
		`the subject test refuses first under both settings, and both reports read the refusal's wording`,
);
