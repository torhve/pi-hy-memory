#!/usr/bin/env node
import { analyseDedup, dedupeBatch } from "../dev/dedup-report.js";
/**
 * Same-write dedup. Run: npx tsx tools/dedup-report-check.ts
 *
 * TODO 7.14 measured that reconcile never merges two drafts carrying the same value, so any dedup
 * has to be code at the write boundary. This pins the *rule* the report prices, on drafts whose
 * answers are known by construction:
 *
 *   - a draft whose subject and every value are already held by a fact in the same batch is a
 *     duplicate; everything else is not.
 *   - the conservative rule refuses the three shapes that look like duplicates and are not: a stated
 *     rule with no value in it, the user's own constraint, and a number the value extractor never
 *     named. The loose rule drops all three, which is exactly why it is reported and not shipped.
 *   - retiring instead of dropping frees the same active tokens and leaves the wording pointing at
 *     its survivor — but folding a ledger that recorded a retirement cannot reproduce it, which is
 *     the hy.evict lesson (6.19) and the reason nothing ships yet.
 *   - a later UPDATE aimed at a retired row is counted, and counted again when it restates a value
 *     the bank still holds.
 */
import { foldLedger, newId } from "../src/bank.js";
import type { Draft, LedgerRecord } from "../src/types.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const usage = { inTokens: 10, outTokens: 5, wallS: 1 };
const draft = (task: string, statement: string, fromUser = false): Draft & { sourceEntryIds: string[] } => ({
	task,
	statement,
	keys: [task],
	refs: [0],
	fromUser,
	sourceEntryIds: ["e1"],
});

const drafts = [
	draft("pool", "workers.toml sets pool_size = 12 and spin = 3"),
	draft("pool", "workers.toml sets pool_size = 12"),
	draft("pool", "workers.toml sets pool_size = 12 and spin = 3 in the staging copy pool-preview.toml"),
	draft("audit store", "audit.db keeps 12 rows of history"),
	draft("pool", "leave pool_size at 12 in workers.toml and never resize it before Friday", true),
	draft(
		"comments",
		"the parser keeps comments in settings.toml so comments are left alone while parsing settings files",
	),
	draft("comments", "comments are left alone while parsing settings files, nothing to change here"),
	draft("pool", "workers.toml sets pool_size and the retry count is 5"),
];

const chunkOne: LedgerRecord = {
	type: "hy.extract",
	chunkId: "hy-dup-001",
	coversUpToId: "e1",
	createdAt: "2026-10-25T09:01:00.000Z",
	drafts,
	rejectedCount: 0,
	usage,
};
const chunkOneOps: LedgerRecord = {
	type: "hy.ops",
	chunkId: "hy-dup-001",
	coversUpToId: "e1",
	createdAt: "2026-10-25T09:01:30.000Z",
	ops: drafts.map((_, index) => ({ action: "ADD" as const, draft: index })),
	rejectedCount: 0,
	usage,
};
// A later write tries to merge into the duplicate the rule would have removed.
const laterDraft = draft("pool", "pool_size stays 12 after the reload", true);
const records: LedgerRecord[] = [
	chunkOne,
	chunkOneOps,
	{
		type: "hy.extract",
		chunkId: "hy-dup-002",
		coversUpToId: "e2",
		createdAt: "2026-10-25T09:02:00.000Z",
		drafts: [laterDraft],
		rejectedCount: 0,
		usage,
	},
	{
		type: "hy.ops",
		chunkId: "hy-dup-002",
		coversUpToId: "e2",
		createdAt: "2026-10-25T09:02:30.000Z",
		ops: [{ action: "UPDATE", draft: 0, target: newId("hy-dup-001:1:ADD") }],
		rejectedCount: 0,
		usage,
	},
];

const duplicateId = newId("hy-dup-001:1:ADD");

// The rule on one batch, before any bank is involved.
const loose = dedupeBatch(
	drafts,
	drafts.map((_, i) => ({ action: "ADD" as const, draft: i })),
	"hy-dup-001",
	"loose",
);
const conservative = dedupeBatch(
	drafts,
	drafts.map((_, i) => ({ action: "ADD" as const, draft: i })),
	"hy-dup-001",
	"conservative",
);

check(
	"the draft that repeats a subject and every value is the only duplicate the conservative rule sees",
	conservative.dropped.map((row) => row.draft),
	[1],
);
check(
	"the loose rule also drops the stated rule, the user's own constraint and an unnamed number",
	loose.dropped.map((row) => row.draft).sort((a, b) => a - b),
	[1, 4, 6, 7],
);
const shapes = (rows: { valueless: boolean; fromUser: boolean; unprotected: string[] }[]) => [
	rows.filter((row) => !row.valueless).length,
	rows.filter((row) => row.valueless).length,
	rows.filter((row) => row.fromUser).length,
	rows.filter((row) => row.unprotected.length > 0).length,
];
check(
	"what the loose rule threw away: values the survivor held, no value at all, the user's words, an unnamed number",
	shapes(loose.dropped),
	[3, 1, 1, 1],
);
check(
	"a shared value against a different subject is refused, counted per pair it appears in",
	conservative.declines.sameValueOtherSubject,
	2,
);
check(
	"the conservative rule acts on the plain repeat and nothing else",
	[conservative.dropped.length, ...shapes(conservative.dropped)],
	[1, 1, 0, 0, 0],
);
check(
	"a matching subject holding one more value is refused, not merged",
	conservative.declines.sameSubjectOtherValue,
	4,
);
check("the retired draft knows which survivor it points at", loose.dropped[0].twinDraft, 0);

const looseRun = analyseDedup("dedup-loose", records, null, null, "loose");
const conservativeRun = analyseDedup("dedup-conservative", records, null, null, "conservative");
const retireRun = analyseDedup("dedup-retire", records, null, null, "retire");

check(
	"no corpus means declared-value numbers are unavailable, printed as such",
	[looseRun.corpus, looseRun.declaredDarkDeduped.length],
	[null, 0],
);
check(
	"drop counts per variant",
	[looseRun.duplicates.length, conservativeRun.duplicates.length, retireRun.duplicates.length],
	[4, 1, 1],
);
check(
	"retiring frees exactly as much current space as dropping",
	[conservativeRun.activeFacts, retireRun.activeFacts],
	[8, 8],
);
check("the loose rule leaves 5 current facts where the shipped fold leaves 8", looseRun.activeFacts, 5);
check(
	"the retired row is kept and points at its survivor",
	retireRun.retiredDuplicates.map((r) => r.pointsTo === newId("hy-dup-001:0:ADD")),
	[true],
);
check(
	"dropping keeps nothing, so nothing points anywhere",
	[looseRun.retiredDuplicates.length, conservativeRun.retiredDuplicates.length],
	[0, 0],
);
check(
	"a later merge aimed at the removed row is counted, and again when it restates a held value",
	[conservativeRun.orphanMerges.length, conservativeRun.orphansRestatingAHeldValue],
	[1, 1],
);
check(
	"no variant leaves a value with no current carrier",
	[looseRun.darkValuesDeduped, conservativeRun.darkValuesDeduped, retireRun.darkValuesDeduped],
	[0, 0, 0],
);
check(
	"as shipped this ledger left three values in two or more current facts",
	conservativeRun.shippedDuplicates.map((row) => row.value).sort(),
	["12", "pool_size", "workers.toml"],
);

// The replay trap: folding the ledger a retire would have written cannot see the retirement. A
// later merge happens to hide it here by superseding the row, so fold the first write alone.
const firstWrite = records.slice(0, 2);
const folded = foldLedger(firstWrite).filter((entry) => entry.status === "active");
const retireFirst = analyseDedup("dedup-retire-first", firstWrite, null, null, "retire");
check(
	"the fold cannot replay a retirement — it hands the duplicate back as current",
	[folded.some((entry) => entry.id === duplicateId), retireFirst.activeFacts, folded.length],
	[true, 7, 8],
);

console.log(
	failures === 0 ? "ok: the dedup rule keeps rules, user constraints and unnamed numbers" : `${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
