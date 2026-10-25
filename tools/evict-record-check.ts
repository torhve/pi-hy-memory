#!/usr/bin/env npx tsx
/**
 * tools/evict-record-check.ts — the ceiling record: what it says, what folding does with it.
 *
 * TODO 6.19's residue was that a bank trimmed to `bankMaxTokens` left no record of *which* facts
 * the ceiling took: the live session had 631 retired facts and an audit could only count them.
 * `src/pipeline.ts` now writes an `hy.evict` record after the write that pushed the bank over the
 * cap. Three things have to be true about it, and none of them is obvious from the type:
 *
 *   1. it names every id the ceiling dropped, in the write that caused it, and its arithmetic
 *      closes — a record whose numbers do not add up is worse than no record;
 *   2. `foldLedger` ignores it. Budget eviction is pressure, not deletion, so re-folding a session
 *      still restores the dropped facts (the published reading: folded 1 451 facts against a store
 *      of 820). If folding read this record as a write it would permanently erase them;
 *   3. the record survives a reload. The mirror is rewritten from the in-memory ledger on every
 *      flush, so a reader that drops the record on reload would delete it from the copy that wins
 *      the next time.
 *
 * It also pins the reload claim `src/index.ts` makes in its audit comment: a reload re-applies the
 * same ceiling, so the ids it drops are the ids a write-path record already named.
 */

import { enforceBudget, foldLedger } from "../src/bank.js";
import { ledgerFromSession } from "../src/index.js";
import { writeChunk } from "../src/pipeline.js";
import type { SerializedChunk } from "../src/serialize.js";
import type { BankEntry, LedgerRecord } from "../src/types.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// Distinct statements: two drafts carrying one statement are deduplicated before they reach the
// bank. `tokenCount` is measured on the stored text, so a ceiling of 60 tokens admits the newest
// two facts and drops the older pair.
const LONG_A = `the nightly pool stays at ${"a".repeat(140)} tokens, decided on the first pass`;
const LONG_B = `the audit store is capped at ${"b".repeat(140)} bytes, decided on the first pass`;
const LONG = LONG_A;
// A serialized chunk, the way the shipped path hands one to `writeChunk`: drafts need real refs,
// and a bare string gives the writer none.
const CHUNK: SerializedChunk = {
	text: "[0] [User @ 09:00]: keep the drain timeout at 90s\n[1] [Assistant @ 09:01]: drain_timeout is 90s",
	refs: ["aaaa1111bbbb2222", "cccc3333dddd4444"],
	entryCount: 2,
	roles: ["user", "assistant"],
};

/** Two drafts, two ADDs: every write lands two facts, which is what makes the ceiling bite. */
function writer() {
	return {
		model: "fake",
		async complete(_system: string, _user: string, label: string) {
			const content = label.startsWith("extract")
				? JSON.stringify({
						drafts: [
							{ task: "nightly pool", statement: LONG_A, keys: ["pool"], refs: [1], sourceEntryIds: [] },
							{ task: "audit store", statement: LONG_B, keys: ["audit"], refs: [1], sourceEntryIds: [] },
						],
					})
				: JSON.stringify({
						ops: [
							{ action: "ADD", draft: 0 },
							{ action: "ADD", draft: 1 },
						],
					});
			return {
				content,
				usage: { inTokens: 10, outTokens: 5, wallS: 0 },
				model: { provider: "test", id: "fake" },
			};
		},
	};
}

// ---- 1) the write that bites leaves a record -------------------------------------
// Both chunks are written through `writeChunk`, so every fact in the bank has a ledger record
// behind it — which is what makes "folding restores what the ceiling took" a claim about the
// ledger rather than about entries a test invented.
const bank: BankEntry[] = [];
const first = await writeChunk(writer() as never, bank, "chunk-1", CHUNK, { bankMaxTokens: 60_000 });
const result = await writeChunk(writer() as never, bank, "chunk-2", CHUNK, { bankMaxTokens: 60 });
const evict = result.records.find((r) => r.type === "hy.evict");
const opsRecord = result.records.find((r) => r.type === "hy.ops")!;
check("the write that overshot the cap records it", evict !== undefined);
if (!evict) {
	console.log(`${failures} failure(s)`);
	process.exit(1);
}
check("it is the last record, after the write that caused it", result.records.at(-1) === evict);
check("it is not a write", "ops" in (evict as object) === false && "chunkId" in (evict as object) === false);
check(
	"the ids it names are exactly the ids the ceiling dropped",
	JSON.stringify(evict.droppedIds.slice().sort()) === JSON.stringify(result.budgetDropped.map((e) => e.id).sort()),
	`${evict.droppedIds.length} ids, ${result.budgetDropped.length} dropped`,
);
check(
	"every id it names is now superseded in the bank",
	evict.droppedIds.every((id) => bank.find((e) => e.id === id)?.status === "superseded"),
);
check("the coverage watermark matches the write", evict.coversUpToId === opsRecord.coversUpToId);
check("it names the cap that was in force", evict.poolTokens === 60);
check(
	"its arithmetic closes: before equals kept plus dropped",
	evict.activeTokensBefore ===
		bank.filter((e) => e.status === "active").reduce((n, e) => n + e.tokenCount, 0) + evict.droppedTokens,
	`${evict.activeTokensBefore} before, ${evict.droppedTokens} dropped into a ${evict.poolTokens} pool`,
);
check("the dropped count is the id list", evict.droppedCount === evict.droppedIds.length);
check("it says which pass dropped the facts", evict.cause === "write");
check("it carries no statement text", !JSON.stringify(evict).includes(LONG.slice(0, 40)));

// A write that stays inside the cap records nothing.
const room = await writeChunk(writer() as never, [], "chunk-3", CHUNK, { bankMaxTokens: 60_000 });
check("a write inside the cap leaves no ceiling record", !room.records.some((r) => r.type === "hy.evict"));

// ---- 2) folding ignores it, so replay still restores the facts -------------------
// The ledger the live bank was built from: both writes, in order, with the ceiling record after
// the second. Replaying it is what a reload does.
const withRecord: LedgerRecord[] = [...first.records, ...result.records];
const withoutRecord = withRecord.filter((r) => r.type !== "hy.evict");
const folded = foldLedger(withRecord);
const foldedPlain = foldLedger(withoutRecord);
const activeIds = folded.filter((e) => e.status === "active").map((e) => e.id);
check(
	"the record adds no facts and removes none",
	JSON.stringify(activeIds) === JSON.stringify(foldedPlain.filter((e) => e.status === "active").map((e) => e.id)),
);
check(
	"the facts the ceiling took are active again in a fold",
	evict.droppedIds.every((id) => activeIds.includes(id)),
	`${evict.droppedIds.length} ids restored`,
);
const numbered = folded.filter((e) => e.status === "active").map((e) => e.chunkSeq);
const numberedPlain = foldedPlain.filter((e) => e.status === "active").map((e) => e.chunkSeq);
check("an extra record does not shift chunkSeq", JSON.stringify(numbered) === JSON.stringify(numberedPlain));

// A reload re-applies the same ceiling: the ids it drops are the ids this record already named.
const reloaded = foldLedger(withRecord);
const recheck = enforceBudget(reloaded, evict.poolTokens);
check(
	"a reload drops exactly the ids the record names",
	JSON.stringify(recheck.dropped.map((e) => e.id).sort()) === JSON.stringify(evict.droppedIds.slice().sort()),
	`${recheck.dropped.length} dropped on reload against ${evict.droppedIds.length} recorded`,
);

// An unknown record type is not a write, and must not throw on `record.ops`.
const unknown = [
	...withRecord,
	{ type: "hy.future", createdAt: "2026-01-01T00:00:00.000Z" } as unknown as LedgerRecord,
];
const foldedUnknown = foldLedger(unknown)
	.filter((e) => e.status === "active")
	.map((e) => e.id);
check(
	"an unknown ledger record contributes nothing and does not break the fold",
	JSON.stringify(foldedUnknown) === JSON.stringify(activeIds),
);

// ---- 3) the record survives the read path ----------------------------------------
const entries = [
	{ type: "custom", customType: "hy.extract", data: withRecord[0] },
	{ type: "custom", customType: "hy.ops", data: withRecord[1] },
	{ type: "custom", customType: "hy.evict", data: evict },
] as unknown as Parameters<typeof ledgerFromSession>[0];
const readBack = ledgerFromSession(entries);
check(
	"a reload reads the ceiling record back out of the branch",
	readBack.some((r) => r.type === "hy.evict" && r.droppedIds.length === evict.droppedIds.length),
	`${readBack.length} records read back`,
);
check(
	"the writes still read back alongside it",
	readBack.filter((r) => r.type === "hy.ops" || r.type === "hy.extract").length === 2,
);
const malformed = [
	{ type: "custom", customType: "hy.evict", data: { type: "hy.evict", createdAt: "2026-01-01T00:00:00.000Z" } },
] as unknown as Parameters<typeof ledgerFromSession>[0];
check("a ceiling record with no id list is not read as one", ledgerFromSession(malformed).length === 0);

console.log(
	failures === 0 ? "ok: the ceiling record says which facts went, and folding ignores it" : `${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
