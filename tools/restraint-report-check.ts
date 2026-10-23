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
import { newId } from "../src/bank.js";
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
	{
		chunkId: "hy-x-attr-f",
		class: "attribution",
		pair: "f",
		side: "keep",
		anchors: ["config.toml"],
		marker: "Lena",
		claim: "c",
	},
	{
		chunkId: "hy-x-attr-fq",
		class: "attribution",
		pair: "f",
		side: "quote",
		anchors: ["config.toml"],
		marker: "Lena",
		claim: "c",
	},
	{
		chunkId: "hy-x-attr-g",
		class: "attribution",
		pair: "g",
		side: "keep",
		anchors: ["TOR_TOOL_SETTINGS"],
		marker: "Ola",
		claim: "c",
	},
	{
		chunkId: "hy-x-attr-gq",
		class: "attribution",
		pair: "g",
		side: "quote",
		anchors: ["TOR_TOOL_SETTINGS"],
		marker: "Ola",
		claim: "c",
	},
	{
		chunkId: "hy-x-attr-h",
		class: "attribution",
		pair: "h",
		side: "keep",
		anchors: ["HY_QUEUE_DEPTH"],
		marker: "Greta",
		claim: "c",
	},
	{
		chunkId: "hy-x-attr-hq",
		class: "attribution",
		pair: "h",
		side: "quote",
		anchors: ["HY_QUEUE_DEPTH"],
		marker: "Greta",
		claim: "c",
	},
	{
		chunkId: "hy-x-attr-i",
		class: "attribution",
		pair: "i",
		side: "keep",
		anchors: ["HY_RETRY_WINDOW"],
		marker: "Bo",
		claim: "c",
	},
	{
		chunkId: "hy-x-attr-iq",
		class: "attribution",
		pair: "i",
		side: "quote",
		anchors: ["HY_RETRY_WINDOW"],
		marker: "Bo",
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

type FixtureOp = {
	action: "ADD" | "SKIP" | "DELETE" | "UPDATE";
	draft?: number;
	target?: string;
	reason?: string;
};

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
				: o.action === "UPDATE"
					? {
							action: "UPDATE" as const,
							draft: o.draft ?? 0,
							target: o.target ?? "aaaaaaaaaaaa",
							reason: o.reason ?? "fixture merge",
						}
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

	// f: the quote side keeps the claim and drops the anchor token. Anchor matching calls it restraint.
	extract("hy-x-attr-f", [draft("registry config", "tctl reads its registry cache from config.toml.", true)]),
	ops("hy-x-attr-f", [{ action: "ADD", draft: 0 }]),
	extract("hy-x-attr-fq", [draft("registry config", "The registry cache is read from the main config file.", true)]),
	ops("hy-x-attr-fq", [{ action: "ADD", draft: 0 }]),

	// g: the shape the first real run actually produced. The quote side restates the claim and
	// reconcile merges it into the keep-side fact with an UPDATE, so the surviving entry's own chunkId
	// is the quote chunk and the claim is still in the bank.
	extract("hy-x-attr-g", [draft("tool settings", "TOR_TOOL_SETTINGS points at the settings file here.", true)]),
	ops("hy-x-attr-g", [{ action: "ADD", draft: 0 }]),
	extract("hy-x-attr-gq", [draft("Ola's setup", "Ola (ops) uses TOR_TOOL_SETTINGS for the settings file.", true)]),
	ops("hy-x-attr-gq", [{ action: "UPDATE", draft: 0, target: newId("hy-x-attr-g:0:ADD") }]),

	// h: a two-hop chain. The claim survives a merge and then a later refinement, so recall must
	// follow the chain however long it gets. The third chunk is not in the corpus at all.
	extract("hy-x-attr-h", [draft("queue depth", "HY_QUEUE_DEPTH caps the worker queue at 64.", true)]),
	ops("hy-x-attr-h", [{ action: "ADD", draft: 0 }]),
	extract("hy-x-attr-hq", [
		draft("Greta's queue setting", "Greta (infra) sets HY_QUEUE_DEPTH to cap the worker queue at 64.", true),
	]),
	ops("hy-x-attr-hq", [{ action: "UPDATE", draft: 0, target: newId("hy-x-attr-h:0:ADD") }]),
	extract("hy-x-attr-h2", [draft("queue depth confirmed", "HY_QUEUE_DEPTH caps the worker queue at 64.", false)]),
	ops("hy-x-attr-h2", [
		{ action: "UPDATE", draft: 0, target: newId("hy-x-attr-hq:0:UPDATE"), reason: "confirmed in config" },
	]),

	// i: the guard on that chain. An UPDATE reaches back to the keep-side fact, but what it wrote no
	// longer carries the claim. Following the chain alone would call that recall; it is a loss.
	extract("hy-x-attr-i", [draft("retry window", "HY_RETRY_WINDOW gives 90 s before a job is retried.", true)]),
	ops("hy-x-attr-i", [{ action: "ADD", draft: 0 }]),
	extract("hy-x-attr-iq", [
		draft("scheduler rewrite", "The retry window was removed entirely in the scheduler rewrite.", true),
	]),
	ops("hy-x-attr-iq", [{ action: "UPDATE", draft: 0, target: newId("hy-x-attr-i:0:ADD") }]),
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
assert(e.pairStrict === true && e.pairAttributed === true, "e: an unrelated draft makes a correct pair");
assert(e.paraphraseSuspects.length === 0, "e: an unrelated draft shares no content words");

// f: the blind spot. The quote side keeps the claim, drops the anchor token, and scores as restraint.
const f = byPair.get("f")!;
assert(f.keepBanked === true, "f: keep side banked with its anchor");
assert(f.quoteDraftStrict === true && f.quoteBankStrict === true, "f: anchor matching calls the paraphrase clean");
assert(f.pairStrict === true && f.pairAttributed === true, "f: a paraphrase scores as a correct pair");
assert(f.paraphraseSuspects.length === 2, `f: draft and bank both flagged, got ${f.paraphraseSuspects.length}`);
assert(
	f.paraphraseSuspects.every((s) => s.shared.includes("registry") && s.shared.includes("cache")),
	"f: the flag names the shared content words, not just a count",
);
assert(
	f.paraphraseSuspects.every((s) => !carries("config.toml", s.text)),
	"f: the anchor really is absent from the paraphrase",
);

// g: merged, not duplicated — the shape the first real run actually produced.
const g = byPair.get("g")!;
assert(g.keepBanked === true, "g: recall follows the supersede chain, the keep-side claim is still in the bank");
assert(g.quoteMerged === 1 && g.quoteAdded === 0, `g: merged 1, added 0, got ${g.quoteMerged}/${g.quoteAdded}`);
assert(g.pairFacts === 1 && !g.bankDuplicated, `g: one fact for the subject, got ${g.pairFacts}`);
assert(g.quoteBankStrict === true, "g: the bank gate passes because the quote side added nothing new");
assert(g.quoteDraftStrict === false, "g: the draft gate still fails, the model did restate the claim");
assert(g.pairStrict === false && g.pairAttributed === true, "g: strict and attributed-ok split on the draft gate");

// h: the chain is followed however long it gets.
const h = byPair.get("h")!;
assert(h.keepBanked === true, "h: recall survives a merge and a later refinement two hops on");
assert(
	h.quoteMerged === 0 && h.quoteAdded === 0 && h.pairFacts === 1,
	`h: the surviving entry now belongs to a third chunk, so the quote side holds nothing itself; the pair is still one fact, got ${h.quoteMerged}/${h.quoteAdded}/${h.pairFacts}`,
);
assert(h.quoteDraftStrict === false, "h: the quote side restated the claim, so the draft gate fails");
assert(h.quoteBankStrict === true, "h: the bank gate passes, nothing new was added");

// i: the guard on the chain — reaching back to the keep-side fact is not the same as keeping the claim.
const i = byPair.get("i")!;
assert(i.keepBanked === false, "i: the surviving fact superseded the keep-side one and no longer carries the claim");
assert(i.pairFacts === 0 && i.quoteBankStrict === true, "i: no anchor-carrying fact left, and nothing new was added");
assert(
	i.pairStrict === false && i.pairAttributed === false,
	"i: a lost claim is not pair-correct under either contract",
);

// empties: four outcomes, four different meanings.
assert(byEmpty.get("hy-x-empty-01")!.outcome === "abstained", "empty-01: model withheld");
assert(byEmpty.get("hy-x-empty-02")!.outcome === "code-suppressed", "empty-02: model proposed, code refused");
assert(
	byEmpty.get("hy-x-empty-03")!.outcome === "intruded" && byEmpty.get("hy-x-empty-03")!.inBank === 1,
	"empty-03: intruded and banked",
);
assert(byEmpty.get("hy-x-empty-04")!.outcome === "dropped", "empty-04: no extract record is not abstention");

// ---- aggregates ---------------------------------------------------------------
assert(t.pairs === 9, `pairs 9, got ${t.pairs}`);
assert(t.keepBanked === 7, `keep banked 7 of 9 (c dropped, i superseded), got ${t.keepBanked}`);
assert(
	t.restraintDraftStrict === 4,
	`draft gate clean on 4 of 9 quote sides (a,b,d,g,h restated the claim), got ${t.restraintDraftStrict}`,
);
assert(
	t.restraintBankStrict === 7,
	`bank gate clean on 7 of 9 (a,b added a second fact), got ${t.restraintBankStrict}`,
);
assert(
	t.restraintDraftAttributed === 7,
	`draft gate attributed-ok on 7 of 9 (a, d restated and named nothing), got ${t.restraintDraftAttributed}`,
);
assert(t.restraintBankAttributed === 8, `bank gate attributed-ok on 8 of 9, got ${t.restraintBankAttributed}`);
assert(
	t.restraintStrict === 4 && t.restraintAttributed === 7,
	`both-gate restraint 4 strict / 7 attributed, got ${t.restraintStrict}/${t.restraintAttributed}`,
);
assert(
	t.pairStrict === 2 && t.pairAttributed === 5,
	`pair-correct 2 strict / 5 attributed, got ${t.pairStrict}/${t.pairAttributed}`,
);
assert(t.abstained === 1 && t.suppressed === 1 && t.intruded === 1 && t.dropped === 1, "one of each empty outcome");
assert(t.bankFactsFromEmpty === 1, "exactly one fact the bank kept from an empty chunk");
assert(t.paraphraseSuspects === 1, `exactly one pair flagged as a possible paraphrase, got ${t.paraphraseSuspects}`);
assert(
	t.bankMerged === 1,
	`one pair merged with the surviving entry still on the quote side (g); h merged too but a third chunk refined it since, and this metric counts what the bank holds now, got ${t.bankMerged}`,
);
assert(t.bankAdded === 2, `two pairs got a new second fact (a, b), got ${t.bankAdded}`);
assert(t.bankDuplicated === 2, `two pairs hold the subject twice (a, b), got ${t.bankDuplicated}`);
assert(
	(score.opTotals.get("SKIP") ?? 0) === 1,
	"the fixture used SKIP once, so the report must not claim SKIP was never used",
);

console.log(
	`ok: unattributed vs attributed, draft gate vs bank gate, drafted-then-dropped, merge vs second fact, supersede chains two hops long and one that lost the claim, the paraphrase blind spot, and all four empty outcomes score as intended`,
);
