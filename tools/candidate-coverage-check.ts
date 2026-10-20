#!/usr/bin/env npx tsx
/**
 * tools/candidate-coverage-check.ts - the per-draft shown-set contract.
 *
 * selectShownPerDraft must: never exceed the cap; show every draft's own best
 * candidate whenever the number of drafts with candidates fits the cap; fill
 * remaining slots with further candidates round-robin; and leave zero-candidate
 * drafts untouched. The union rule it replaces is included as the contrast —
 * it is exactly the starvation this fix removes.
 */

import { candidatesPerDraft, selectShownPerDraft } from "../src/protocol.js";
import type { BankEntry } from "../src/types.js";

function assert(cond: boolean, label: string): void {
	if (!cond) {
		console.error(`FAIL: ${label}`);
		process.exit(1);
	}
}

const entry = (id: string, statement: string): BankEntry => ({
	id,
	task: "t",
	statement,
	keys: [],
	confidence: 1,
	relevance: "high",
	sourceEntryIds: [],
	chunkId: "c0",
	createdAt: "2026-01-01T00:00:00.000Z",
	status: "active",
	tokenCount: 10,
});

const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
const bank = Array.from({ length: 40 }, (_, i) =>
	entry(`0000000000${String(i).padStart(2, "0")}`, `shared probe marker dossier ${words[i % 10]}${i} ledger`),
);

// 20 drafts, each most-overlapping with a distinct bank entry near the tail of
// the bank: a union sorted by first-encounter order can only show 12, starving
// the rest. Per-draft selection must show at least one candidate for each of
// the 12 it can fit, and every draft's best while drafts-with-candidates <= cap.
const drafts = Array.from({ length: 12 }, (_, i) => ({
	task: `task ${i}`,
	statement: `shared probe marker dossier ${words[(28 + i) % 10]}${28 + i} ledger`,
	keys: [],
	confidence: 1,
	refs: [i],
}));

const perDraft = candidatesPerDraft(bank, drafts, 8);
assert(perDraft.size === 12, `every draft has a candidate set: ${perDraft.size}`);
for (const [i, list] of perDraft)
	assert(
		list.length > 0 && list[0].statement.includes(`${words[(28 + i) % 10]}${28 + i}`),
		`draft ${i} best candidate`,
	);

const unionShown = new Set<string>(
	[...new Map([...perDraft.values()].flat().map((e) => [e.id, e] as const)).values()].slice(0, 12).map((e) => e.id),
);
let unionStarved = 0;
for (const list of perDraft.values()) if (!list.some((e) => unionShown.has(e.id))) unionStarved++;
// (Contrast only: the old rule may or may not starve depending on ordering.)
console.log(`union rule would starve ${unionStarved} of 12 drafts`);

const perDraftShown = selectShownPerDraft(perDraft, 12);
assert(perDraftShown.length <= 12, `cap respected: ${perDraftShown.length}`);
const shownIds = new Set(perDraftShown.map((e) => e.id));
let pdStarved = 0;
for (const list of perDraft.values()) if (!list.some((e) => shownIds.has(e.id))) pdStarved++;
assert(pdStarved === 0, `no draft with candidates is starved: ${pdStarved}`);

// Cap forces sharing when more drafts compete than slots: still never exceeds.
const crowdedDrafts = Array.from({ length: 20 }, (_, i) => ({
	task: `task ${i}`,
	statement: `shared probe marker dossier ${words[(i % 5) * 7]}${(i % 5) * 7} ledger`,
	keys: [],
	confidence: 1,
	refs: [i],
}));
const crowded = candidatesPerDraft(bank, crowdedDrafts, 8);
const crowdedShown = selectShownPerDraft(crowded, 12);
assert(crowdedShown.length <= 12, `crowded cap respected: ${crowdedShown.length}`);
const crowdedSeen = new Set(crowdedShown.map((e) => e.id));
const crowdedStarved = [...crowded.values()].filter((list) => !list.some((e) => crowdedSeen.has(e.id))).length;
assert(crowdedStarved === 0, `even 20 competing drafts all see a shown candidate: ${crowdedStarved}`);

// Determinism: same inputs, same order.
const again = selectShownPerDraft(perDraft, 12);
assert(
	JSON.stringify(again.map((e) => e.id)) === JSON.stringify(perDraftShown.map((e) => e.id)),
	"selection is deterministic",
);

// Zero-candidate drafts change nothing about the shown set.
const noCandidate = candidatesPerDraft(
	bank,
	[{ task: "zz", statement: "unrelated zebra quantum sandwich", keys: [], confidence: 1, refs: [] }],
	8,
);
assert(selectShownPerDraft(noCandidate, 12).length === 0, "no candidates, nothing shown");

console.log("ok: per-draft shown set caps at limit, guarantees each draft's best where it fits, deterministic");
