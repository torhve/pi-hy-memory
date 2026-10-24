#!/usr/bin/env npx tsx

/**
 * tools/recall-reach-check.ts — the recall query pinned as reaching retired facts.
 *
 * `hy_recall` used to score only `status === "active"` entries. That made the pool
 * budget silent: on a real 155-write session 599 facts were superseded with reason
 * `bank budget`, and the oldest fact still reachable by query was from write 116 of 155.
 * The claim in `src/bank.ts` and DESIGN.md — a superseded fact "stays recallable" — was
 * true of the store and false of the only read path. This fixture pins the repaired
 * behaviour through the function the tool actually calls (`recallHits`, `renderRecallHit`
 * in `src/render.ts`), and pins the wiring so a future edit cannot quietly re-filter.
 *
 * Three things could silently break it, and the fixture is built so none survives:
 *
 *   - the query could filter back to active facts. A value carried only by a
 *     budget-superseded fact is required to come back.
 *   - retired facts could take over the results. A retired fact is added only when it matches
 *     strictly better than the weakest live fact shown, and at most `RECALL_RETIRED_LIMIT` of them.
 *   - a retired fact could be handed over without saying so. Each retired row must name
 *     what dropped it, and a merge-retired row must name the fact that replaced it.
 *
 * Constructed outcomes:
 *
 *   1. a value held only by a budget-superseded fact is returned by query
 *   2. a retired fact matching no better than a live one is not returned at all
 *   3. a retired fact matching strictly better than the weakest live one is added after them
 *   4. a retired row says `retired: bank budget`; a merge-retired row names its successor
 *   5. `limit` bounds the result, retired rows included
 *   6. no query -> current facts only, newest first
 *   6b. a mass of ceiling-retired facts: at most RECALL_RETIRED_LIMIT are added to a query
 *   7. the shipped tool searches the whole bank, not an active-only slice
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RECALL_RETIRED_LIMIT, recallHits, renderRecallHit } from "../src/render.js";
import type { BankEntry } from "../src/types.js";

const failures: string[] = [];
function ok(condition: boolean, message: string): void {
	if (!condition) failures.push(message);
}

function entry(over: Partial<BankEntry> & { id: string; task: string; statement: string }): BankEntry {
	return {
		keys: [],
		sourceEntryIds: [],
		chunkId: `hy-reach-${over.id.slice(-3)}`,
		chunkSeq: 1,
		fromUser: false,
		createdAt: "2026-10-24T00:00:00.000Z",
		status: "active",
		tokenCount: 12,
		...over,
	} as BankEntry;
}

/** A bank shaped like a session that ran into the ceiling: old work retired, recent work live. */
const bank: BankEntry[] = [
	entry({
		id: "hy-reach-a001",
		task: "relay ports",
		statement: "relay ports 9010/9001 with pbkdf2 iterations for relay auth",
		chunkSeq: 4,
		status: "superseded",
		supersedeReason: "bank budget",
	}),
	entry({
		id: "hy-reach-b002",
		task: "queue purge age",
		statement: "queue purge age is 420 seconds",
		chunkSeq: 9,
	}),
	entry({
		id: "hy-reach-c003",
		task: "queue purge age restated",
		statement: "queue purge age restated without the number",
		chunkSeq: 11,
	}),
	entry({
		id: "hy-reach-d004",
		task: "drain timeout",
		statement: "drain timeout decided at 420 seconds for the queue",
		chunkSeq: 6,
		status: "superseded",
		supersedeReason: "target does not restate its subject (2/9 shared); recorded as ADD",
		supersededBy: "hy-reach-c003",
	}),
	entry({
		id: "hy-reach-e005",
		task: "recent note",
		statement: "svelte-check reported no errors",
		chunkSeq: 12,
	}),
	entry({
		id: "hy-reach-f006",
		task: "queue purge age retired",
		statement: "queue purge age retired from the bank at 420 seconds",
		chunkSeq: 3,
		status: "superseded",
		supersedeReason: "bank budget",
	}),
];

// 1. the ceiling did not delete the value.
const ports = recallHits(bank, "9010", 12);
ok(ports.length === 1, `query for a budget-dropped value found ${ports.length} facts, expected 1`);
ok(ports[0]?.entry.id === "hy-reach-a001", "the budget-dropped value was not reachable by query");
ok(ports[0]?.superseded === true, "a budget-superseded hit was reported as current");

// 2. equal evidence: the live fact wins.
const equal = recallHits(bank, "queue purge age", 12);
ok(
	equal.every((hit) => !hit.superseded),
	`a retired fact matching no better than the live ones was returned: ${equal.map((h) => h.entry.id).join(", ")}`,
);
ok(
	!equal.some((hit) => hit.entry.id === "hy-reach-f006"),
	"an equally-matching retired fact was returned beside the live facts that already say it",
);
// 3. a retired fact that matches strictly more leads a weak live match.
const lead = recallHits(bank, "drain timeout queue", 12);
ok(
	lead.slice(0, 2).every((hit) => !hit.superseded),
	`retired fact outranked the live facts instead of following them: ${lead.map((h) => `${h.entry.id}:${h.score}`).join(" ")}`,
);
ok(
	lead.some((hit) => hit.entry.id === "hy-reach-d004" && hit.superseded),
	"a retired fact matching strictly better was not added",
);

// 4. every retired row says what retired it; a merge-retired row points forward.
const budgetRow = renderRecallHit(recallHits(bank, "9010", 12)[0] as (typeof ports)[number]);
ok(budgetRow.includes("retired: bank budget"), "a budget-dropped row did not say so");
ok(!budgetRow.includes("for what replaced it"), "a budget-dropped row claimed a successor it does not have");
const mergeRow = renderRecallHit(recallHits(bank, "drain timeout", 12)[0] as (typeof ports)[number]);
ok(mergeRow.includes("retired:"), "a merge-retired row did not say so");
ok(mergeRow.includes("read hy-reach-c003"), "a merge-retired row did not name the fact that replaced it");
ok(
	renderRecallHit(recallHits(bank, "svelte-check", 12)[0] as (typeof ports)[number]).includes("[hy-reach-e005]"),
	"a live row grew a marker",
);

// 5. the limit counts retired rows too, so a query cannot return more than it promised.
const capped = recallHits(bank, "queue", 2);
ok(capped.length === 2, `limit of 2 returned ${capped.length}`);
ok(
	capped.every((hit) => hit.entry.task.includes("queue") || hit.entry.statement.includes("queue")),
	"limit returned unmatched facts",
);

// 6. with no query, current facts come first and newest first.
const plain = recallHits(bank, "", 50);
ok(
	plain.every((hit) => !hit.superseded),
	`a no-query listing mixed retired facts in as current: ${plain.map((h) => `${h.entry.id}${h.superseded ? "*" : ""}`).join(" ")}`,
);
ok(plain.length === plain.filter((hit) => !hit.superseded).length, "no-query listing did not return every live fact");
ok(
	plain
		.filter((hit) => !hit.superseded)
		.every(
			(hit, index, list) => index === 0 || (list[index - 1]?.entry.chunkSeq ?? 0) >= (hit.entry.chunkSeq ?? 0),
		),
	"no-query ordering was not newest first",
);

// 6b. a ceiling retired many facts: one query adds at most RECALL_RETIRED_LIMIT of them.
const crowded = recallHits(
	[
		entry({ id: "hy-reach-g007", task: "live note", statement: "the queue file was named", chunkSeq: 20 }),
		...Array.from({ length: 9 }, (_, i) =>
			entry({
				id: `hy-reach-h0${i}`,
				task: `queue retired ${i}`,
				statement: `queue retired with value q-${i} in queue.toml`,
				chunkSeq: i,
				status: "superseded",
				supersedeReason: "bank budget",
			}),
		),
	],
	"queue.toml",
	12,
);
ok(
	crowded.filter((hit) => hit.superseded).length === RECALL_RETIRED_LIMIT,
	`expected ${RECALL_RETIRED_LIMIT} retired rows added, got ${crowded.filter((hit) => hit.superseded).length}`,
);

// 7. the shipped tool calls this over the whole bank.
const source = readFileSync(join(import.meta.dirname, "../src/index.ts"), "utf8");
ok(source.includes("recallHits(state.bank"), "hy_recall no longer searches the bank through recallHits");
ok(
	!/const scored = active\.map/.test(source),
	"hy_recall grew an active-only query slice again; retired facts would be unreachable",
);

if (failures.length > 0) {
	for (const failure of failures) console.error(`FAIL: ${failure}`);
	process.exit(1);
}
console.log(
	`ok: a value the pool budget dropped is still answered, live facts win on equal evidence, ` +
		`a retired row names what dropped it and what replaced it`,
);
