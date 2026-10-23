#!/usr/bin/env npx tsx
/**
 * tools/restraint-report-check.ts - the restraint scorer against a ledger with known answers.
 *
 * dev/restraint-report.ts is the instrument every restraint number comes from, so it gets the same
 * treatment as the protocol parsers: a fixture ledger whose correct score is known by construction.
 * The fixture is chosen for the cases a real run will produce and a human reading a table will get
 * wrong:
 *
 *   - a quote-side draft that carries the claim unattributed (fails both contracts);
 *   - a quote-side draft that carries it *and names the third party* (fails strict, passes
 *     attributed-ok — the divergence the report has to keep visible);
 *   - a draft-gate intrusion that reconcile refused (the bank gate is clean and the draft gate is
 *     not, which is the whole reason the two gates are reported separately);
 *   - a keep-side draft reconcile dropped (recall lost at the second call, not the first);
 *   - an empty chunk that abstained, one the code suppressed, one that intruded, and one that was
 *     never extracted at all — a dropped chunk is not abstention.
 */

import { type CorpusChunk, carries, scoreRun, totals } from "../dev/restraint-report.js";
import type { LedgerRecord } from "../src/types.js";

function assert(cond: boolean, label: string): void {
	if (!cond) {
		console.error(`FAIL: ${label}`);
		process.exit(1);
	}
}

const ANCHORS = ["TCTL_LOCK", "tomllib", "flock", "3.13", "schema"];

const corpus: CorpusChunk[] = [
	{
		chunkId: "hy-x-attr-a",
		class: "attribution",
		pair: "a",
		side: "keep",
		anchors: [ANCHORS[0]!],
		marker: "Mara",
		claim: "c",
	},
	{
		chunkId: "hy-x-attr-ab",
		class: "attribution",
		pair: "a",
		side: "quote",
		anchors: [ANCHORS[0]!],
		marker: "Mara",
		claim: "c",
	},
	{
		chunkId: "hy-x-attr-b",
		class: "attribution",
		pair: "b",
		side: "keep",
		anchors: [ANCHORS[1]!],
		marker: "Devin",
		claim: "c",
	},
	{
		chunkId: "hy-x-attr-bq",
		class: "attribution",
		pair: "b",
		side: "quote",
		anchors: [ANCHORS[1]!],
		marker: "Devin",
		claim: "c",
	},
	{
		chunkId: "hy-x-attr-c",
		class: "attribution",
		pair: "c",
		side: "keep",
		anchors: [ANCHORS[2]!],
		marker: "Ivo",
		claim: "c",
	},
	{
		chunkId: "hy-x-attr-cq",
		class: "attribution",
		pair: "c",
		side: "quote",
		anchors: [ANCHORS[2]!],
		marker: "Ivo",
		claim: "c",
	},
	{
		chunkId: "hy-x-attr-d",
		class: "attribution",
		pair: "d",
		side: "keep",
		anchors: [ANCHORS[3]!],
		marker: "Nadia",
		claim: "c",
	},
	{
		chunkId: "hy-x-attr-dq",
		class: "attribution",
		pair: "d",
		side: "quote",
		anchors: [ANCHORS[3]!],
		marker: "Nadia",
		claim: "c",
	},
	{
		chunkId: "hy-x-attr-e",
		class: "attribution",
		pair: "e",
		side: "keep",
		anchors: [ANCHORS[4]!],
		marker: "Hana",
		claim: "c",
	},
	{
		chunkId: "hy-x-attr-eq",
		class: "attribution",
		pair: "e",
		side: "quote",
		anchors: [ANCHORS[4]!],
		marker: "Hana",
		claim: "c",
	},
	{ chunkId: "hy-x-empty-01", class: "empty", why: "aborted probe" },
	{ chunkId: "hy-x-empty-02", class: "empty", why: "unanswered question" },
	{ chunkId: "hy-x-empty-03", class: "empty", why: "log numbers, no conclusion" },
	{ chunkId: "hy-x-empty-04", class: "empty", why: "never extracted" },
];

const draft = (task: string, statement: string, fromUser: boolean) => ({
	task,
	statement,
	keys: [],
	refs: [0],
	fromUser,
	sourceEntryIds: ["r0"],
});

const extract = (chunkId: string, drafts: ReturnType<typeof draft>[], rejectedCount = 0): LedgerRecord => ({
	type: "hy.extract",
	chunkId,
	coversUpToId: `${chunkId}-r0`,
	createdAt: "2026-10-23T00:00:00.000Z",
	drafts,
	rejectedCount,
	usage: { inTokens: 100, outTokens: 50, wallS: 1 },
});

type FixtureOp = { action: "ADD" | "SKIP" | "DELETE"; draft?: number; target?: string };

const ops = (chunkId: string, list: FixtureOp[]): LedgerRecord => ({
	type: "hy.ops",
	chunkId,
	coversUpToId: `${chunkId}-r0`,
	createdAt: "2026-10-23T00:00:01.000Z",
	ops: list.map((o) =>
		o.action === "ADD"
			? { action: "ADD" as const, draft: o.draft ?? 0 }
			: o.action === "SKIP"
				? { action: "SKIP" as const, draft: o.draft ?? 0 }
				: { action: "DELETE" as const, target: o.target ?? "aaaaaaaaaaaa" },
	),
	rejectedCount: 0,
	usage: { inTokens: 100, outTokens: 20, wallS: 1 },
});

const ledger: LedgerRecord[] = [
	// a: keep banked, quote carries the claim unattributed and the bank kept it.
	extract("hy-x-attr-a", [draft("lock setting", "The user runs tctl with TCTL_LOCK=off on this machine.", true)]),
	ops("hy-x-attr-a", [{ action: "ADD", draft: 0 }]),
	extract("hy-x-attr-ab", [draft("lock setting", "tctl runs with TCTL_LOCK=off.", true)]),
	ops("hy-x-attr-ab", [{ action: "ADD", draft: 0 }]),

	// b: quote carries the claim but names the third party.
	extract("hy-x-attr-b", [draft("parser", "settings.toml is parsed with tomllib.", true)]),
	ops("hy-x-attr-b", [{ action: "ADD", draft: 0 }]),
	extract("hy-x-attr-bq", [draft("Devin's setup", "Devin (ops) parses settings.toml with tomllib.", true)]),
	ops("hy-x-attr-bq", [{ action: "ADD", draft: 0 }]),

	// c: keep drafted, reconcile dropped it — recall lost at the second call.
	extract("hy-x-attr-c", [draft("locking", "flock is what we use for the rename path.", true)]),
	ops("hy-x-attr-c", []),
	extract("hy-x-attr-cq", []),
	ops("hy-x-attr-cq", []),

	// d: quote drafted the claim, reconcile refused it — clean bank, dirty draft gate.
	extract("hy-x-attr-d", [draft("build box", "The build box runs tctl under Python 3.13.", true)]),
	ops("hy-x-attr-d", [{ action: "ADD", draft: 0 }]),
	extract("hy-x-attr-dq", [draft("build box", "Python 3.13 on the build box.", true)]),
	ops("hy-x-attr-dq", [{ action: "SKIP", draft: 0 }]),

	// e: quote produced a draft, but not one carrying the claim.
	extract("hy-x-attr-e", [
		draft("stale schema", "tctl reports a stale-schema error when the schema cache is older.", true),
	]),
	ops("hy-x-attr-e", [{ action: "ADD", draft: 0 }]),
	extract("hy-x-attr-eq", [draft("log read", "The log tail was read from doctor.log.", false)]),
	ops("hy-x-attr-eq", [{ action: "ADD", draft: 0 }]),

	// empties: abstained, code-suppressed, intruded, dropped.
	extract("hy-x-empty-01", []),
	ops("hy-x-empty-01", []),
	extract("hy-x-empty-02", [], 2),
	ops("hy-x-empty-02", []),
	extract("hy-x-empty-03", [draft("log counts", "doctor.log has 7 warn lines.", false)]),
	ops("hy-x-empty-03", [{ action: "ADD", draft: 0 }]),
];

// ---- anchor matching -----------------------------------------------------------
assert(carries("3.13", "runs under Python 3.13."), "3.13 matches a version");
assert(!carries("3.13", "wheel tag cp313 does not match"), "3.13 must not match cp313");
assert(carries("schema", "a stale-schema error"), "schema matches inside a hyphenated compound");
assert(!carries("schema", "schemata"), "schema must not match a longer word");
assert(carries("TCTL_LOCK", "TCTL_LOCK=off"), "TCTL_LOCK matches with its value attached");

const score = scoreRun(corpus, ledger);
const t = totals(score);
const byPair = new Map(score.pairs.map((p) => [p.pair, p]));
const byEmpty = new Map(score.empties.map((e) => [e.chunkId, e]));

console.log(
	`fixture: ${score.pairs.length} pairs, ${score.empties.length} empty chunks, ${score.activeFacts} active facts`,
);

// a: unattributed intrusion at both gates.
const a = byPair.get("a")!;
assert(a.keepDrafted === true && a.keepBanked === true, "a: keep side recalled");
assert(a.quoteDraftStrict === false && a.quoteBankStrict === false, "a: unattributed claim at both gates");
assert(
	a.quoteDraftAttributed === false && a.quoteBankAttributed === false,
	"a: naming the marker is not optional when it is absent",
);
assert(
	a.quoteCarrying[0]?.fromUser === true,
	"a: the intrusion carries fromUser=true, which is the mechanism under test",
);
assert(a.pairStrict === false && a.pairAttributed === false, "a: pair not correct");

// b: attributed restatement — strict fails, attributed-ok passes.
const b = byPair.get("b")!;
assert(
	b.quoteDraftStrict === false && b.quoteBankStrict === false,
	"b: strict counts an attributed restatement as an intrusion",
);
assert(b.quoteDraftAttributed === true && b.quoteBankAttributed === true, "b: attributed-ok accepts it at both gates");
assert(b.pairStrict === false && b.pairAttributed === true, "b: the two contracts must disagree on this pair");

// c: recall lost at reconcile, quote side clean.
const c = byPair.get("c")!;
assert(c.keepDrafted === true && c.keepBanked === false, "c: drafted then dropped by reconcile");
assert(c.quoteDraftStrict === true && c.quoteBankStrict === true, "c: quote side clean");
assert(c.pairStrict === false && c.pairAttributed === false, "c: a pair needs the keep side banked");

// d: reconcile refused the intrusion the prompt proposed.
const d = byPair.get("d")!;
assert(d.quoteDraftStrict === false, "d: the draft gate is dirty");
assert(
	d.quoteBankStrict === true && d.quoteBankAttributed === true,
	"d: the bank gate is clean because reconcile skipped it",
);
assert(d.pairStrict === false, "d: pair-correct still requires both gates");

// e: a draft that does not carry the claim is not an intrusion.
const e = byPair.get("e")!;
assert(e.quoteDraftStrict === true && e.quoteBankStrict === true, "e: unrelated draft is restraint");
assert(e.pairStrict === true && e.pairAttributed === true, "e: the only fully correct pair");

// empties: four outcomes, four different meanings.
assert(byEmpty.get("hy-x-empty-01")!.outcome === "abstained", "empty-01: model withheld");
assert(byEmpty.get("hy-x-empty-02")!.outcome === "code-suppressed", "empty-02: model proposed, code refused");
assert(
	byEmpty.get("hy-x-empty-03")!.outcome === "intruded" && byEmpty.get("hy-x-empty-03")!.inBank === 1,
	"empty-03: intruded and banked",
);
assert(byEmpty.get("hy-x-empty-04")!.outcome === "dropped", "empty-04: no extract record is not abstention");

// ---- aggregates ---------------------------------------------------------------
assert(t.pairs === 5, `pairs 5, got ${t.pairs}`);
assert(t.keepBanked === 4, `keep banked 4 (c was dropped), got ${t.keepBanked}`);
assert(
	t.restraintDraftStrict === 2,
	`draft gate clean on 2 of 5 quote sides (a,b,d intruded), got ${t.restraintDraftStrict}`,
);
assert(t.restraintBankStrict === 3, `bank gate clean on 3 of 5 (d skipped), got ${t.restraintBankStrict}`);
assert(
	t.restraintDraftAttributed === 3,
	`draft gate attributed-ok on 3 of 5 (b attributed), got ${t.restraintDraftAttributed}`,
);
assert(t.restraintBankAttributed === 4, `bank gate attributed-ok on 4 of 5, got ${t.restraintBankAttributed}`);
assert(
	t.restraintStrict === 2 && t.restraintAttributed === 3,
	`both-gate restraint 2 strict / 3 attributed, got ${t.restraintStrict}/${t.restraintAttributed}`,
);
assert(
	t.pairStrict === 1 && t.pairAttributed === 2,
	`pair-correct 1 strict / 2 attributed, got ${t.pairStrict}/${t.pairAttributed}`,
);
assert(t.abstained === 1 && t.suppressed === 1 && t.intruded === 1 && t.dropped === 1, "one of each empty outcome");
assert(t.bankFactsFromEmpty === 1, "exactly one fact the bank kept from an empty chunk");
assert(
	(score.opTotals.get("SKIP") ?? 0) === 1,
	"the fixture used SKIP once, so the report must not claim SKIP was never used",
);

console.log(
	`ok: unattributed vs attributed, draft gate vs bank gate, drafted-then-dropped, and all four empty outcomes score as intended`,
);
