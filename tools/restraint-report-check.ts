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
		text: [
			"[0] [User @ 10:02]: Devin (ops) parses settings.toml with tomllib.",
			"[1] [Assistant @ 10:03]: Noting that as Devin's.",
			"[2] [Tool result for bash @ 10:04]: $ grep -rn tomllib src/config.rs",
			"[3] [Tool result for bash @ 10:05]: 112: let map = tomllib::parse(&text);",
		].join("\n"),
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
	{
		chunkId: "hy-x-attr-j",
		class: "attribution",
		pair: "j",
		side: "keep",
		anchors: [ANCHORS[4]!],
		marker: "Nils",
		claim: "c",
	},
	{
		chunkId: "hy-x-attr-jq",
		class: "attribution",
		pair: "j",
		side: "quote",
		anchors: [ANCHORS[4]!],
		marker: "Nils",
		claim: "c",
		text: [
			"[0] [User @ 10:10]: Nils says tctl reports a stale-schema error when the cache is older.",
			"[1] [Assistant @ 10:11]: Noting that as Nils's.",
			"[2] [Tool result for bash @ 10:12]: $ tail doctor.log",
			"[3] [Tool result for bash @ 10:13]: doctor.log: schema: stale (cache older than settings)",
		].join("\n"),
	},
	{ chunkId: "hy-x-empty-01", class: "empty", why: "aborted probe" },
	{ chunkId: "hy-x-empty-02", class: "empty", why: "unanswered question" },
	{ chunkId: "hy-x-empty-03", class: "empty", why: "log numbers, no conclusion" },
	{ chunkId: "hy-x-empty-04", class: "empty", why: "never extracted" },
	// tool_output: the class the v1 label audit forced. Each chunk names the tool fact that is
	// defensible to bank and the chatter that is not, so both failure directions are visible.
	{
		chunkId: "hy-x-tool-01",
		class: "tool_output",
		why: "nothing decided; help text states what a flag does",
		probes: ["--dry-run"],
		transient: ["scrolling through the manual"],
	},
	{
		chunkId: "hy-x-tool-02",
		class: "tool_output",
		why: "nothing decided; the manual states an expiry",
		probes: ["900"],
		transient: ["just checking"],
	},
	{
		chunkId: "hy-x-tool-03",
		class: "tool_output",
		why: "nothing decided; a source line names the staging file",
		probes: ["settings.toml.tmp"],
		transient: ["opened the writer module"],
	},
	{
		chunkId: "hy-x-tool-04",
		class: "tool_output",
		why: "nothing decided; the banner states the build",
		probes: ["0.9.2"],
		transient: ["just the version"],
	},
	{
		chunkId: "hy-x-tool-05",
		class: "tool_output",
		why: "nothing decided; the error text states a rule",
		probes: ["apply refused"],
		transient: ["trying apply once"],
	},
	{
		chunkId: "hy-x-tool-06",
		class: "tool_output",
		why: "nothing decided; doctor explains itself",
		probes: ["check-order"],
		transient: ["wanted to see the wording"],
	},
	{
		chunkId: "hy-x-tool-08",
		class: "tool_output",
		why: "nothing decided; the source states a cap",
		probes: ["MAX_QUEUE"],
		transient: ["reading the queue cap"],
	},
	{
		chunkId: "hy-x-tool-09",
		class: "tool_output",
		why: "nothing decided; the file states where the queue rules live",
		probes: ["queue.rs"],
		transient: ["opening the queue file"],
	},
	{
		chunkId: "hy-x-tool-07",
		class: "tool_output",
		why: "nothing decided; the help line states a rule, and the confirmation repeats it",
		probes: ["--no-clobber"],
		transient: ["skimming the flag list"],
	},
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
	extract("hy-x-attr-bq", [
		draft("Devin's setup", "Devin (ops) parses settings.toml with tomllib.", true),
		draft("Devin's grep", "Devin's grep over src/config.rs shows tomllib used at line 112.", true),
	]),
	ops("hy-x-attr-bq", [
		{ action: "ADD", draft: 0 },
		{ action: "ADD", draft: 1 },
	]),

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
	// j: the quote side's only anchor-carrying fact restates this chunk's own tool output. Both
	// published gates fail the pair; the diagnostic does not. That gap is the instrument, not the writer.
	extract("hy-x-attr-j", [
		draft("stale schema", "tctl reports a stale-schema error when the cache is older.", false),
	]),
	ops("hy-x-attr-j", [{ action: "ADD", draft: 0 }]),
	extract("hy-x-attr-jq", [draft("doctor log", "The doctor log printed schema: stale at 10:12.", false)]),
	ops("hy-x-attr-jq", [{ action: "ADD", draft: 0 }]),
	// empties: abstained, code-suppressed, intruded, dropped.
	extract("hy-x-empty-01", []),
	ops("hy-x-empty-01", []),
	extract("hy-x-empty-02", [], 2),
	ops("hy-x-empty-02", []),
	extract("hy-x-empty-03", [draft("log counts", "doctor.log has 7 warn lines.", false)]),
	ops("hy-x-empty-03", [{ action: "ADD", draft: 0 }]),
	// tool_output outcomes, one per branch the scorer can reach.
	// 01: kept the tool fact and nothing else.
	extract("hy-x-tool-01", [
		draft("dry-run flag", "tctl --dry-run prints what would change and writes nothing.", false),
	]),
	ops("hy-x-tool-01", [{ action: "ADD", draft: 0 }]),
	// 02: kept the chatter and missed the fact.
	extract("hy-x-tool-02", [draft("session note", "The user was just checking one line of the manual.", false)]),
	ops("hy-x-tool-02", [{ action: "ADD", draft: 0 }]),
	// 03: kept both halves in one fact.
	extract("hy-x-tool-03", [
		draft("staging file", "Opened the writer module: the staging file is settings.toml.tmp.", false),
	]),
	ops("hy-x-tool-03", [{ action: "ADD", draft: 0 }]),
	// 04: withheld. A judgment on this class, not a failure.
	extract("hy-x-tool-04", []),
	ops("hy-x-tool-04", []),
	// 05: drafted the fact, reconcile banked nothing.
	extract("hy-x-tool-05", [
		draft("lock rule", "tctl says apply refused while another process holds the lock.", false),
	]),
	ops("hy-x-tool-05", [{ action: "SKIP", draft: 0 }]),
	// 06: banked a fact that is neither the declared tool fact nor the declared chatter.
	extract("hy-x-tool-06", [draft("doctor pass", "doctor runs once per pass over the settings.", false)]),
	ops("hy-x-tool-06", [{ action: "ADD", draft: 0 }]),
	// 07: one value banked twice, the second time as a confirmation. Both copies carry the value,
	// so every column above calls this clean — the repeat column is the only one that can see it.
	extract("hy-x-tool-07", [
		draft("no-clobber flag", "tctl --no-clobber refuses to overwrite an existing file.", false),
		draft("flag confirmed", "User confirmed --no-clobber is the flag for not overwriting.", false),
	]),
	ops("hy-x-tool-07", [
		{ action: "ADD", draft: 0 },
		{ action: "ADD", draft: 1 },
	]),
	// 08 → 09: the cap banked at 08 is later merged into a fact authored at 09. Under 08 the surviving
	// fact is one this chunk never authored — its own copy is gone, superseded — so 08 cannot be credited
	// with a clean keep even though a fact carrying its value sits in the bank.
	extract("hy-x-tool-08", [draft("queue cap", "MAX_QUEUE is 200 in src/queue.rs.", false)]),
	ops("hy-x-tool-08", [{ action: "ADD", draft: 0 }]),
	extract("hy-x-tool-09", [
		draft("cap location", "The queue cap lives in queue.rs: MAX_QUEUE caps the queue at 200.", false),
	]),
	ops("hy-x-tool-09", [
		{ action: "UPDATE", draft: 0, target: newId("hy-x-tool-08:0:ADD"), reason: "same rule, one entry" },
	]),
];

// ---- anchor matching -----------------------------------------------------------
assert(carries("3.13", "runs under Python 3.13."), "3.13 matches a version");
assert(!carries("3.13", "wheel tag cp313 does not match"), "3.13 must not match cp313");
assert(carries("schema", "a stale-schema error"), "schema matches inside a hyphenated compound");
assert(!carries("schema", "schemata"), "schema must not match a longer word");
assert(carries("TCTL_LOCK", "TCTL_LOCK=off"), "TCTL_LOCK matches with its value attached");

// Flag-shaped tokens need a different boundary: a `\\b` in front of `--dry-run` matches nothing at
// all, which is how the first draft of this corpus failed its own check. Ordinary anchors keep `\\b`,
// so every score computed before this change still means what it meant.
assert(carries("--dry-run", "tctl --dry-run prints what would change"), "a flag anchor matches its flag");
assert(!carries("--dry-run", "--dry-run-all is a different flag"), "a flag must not match inside a longer flag");
assert(!carries("900", "1900 s is a different expiry"), "a number must not match inside a longer number");
assert(
	carries("O_EXCL", "O_EXCL-only locking was rejected"),
	"an ordinary anchor still matches inside a hyphenated compound",
);

const score = scoreRun(corpus, ledger);
const t = totals(score);
const byPair = new Map(score.pairs.map((p) => [p.pair, p]));
const byEmpty = new Map(score.empties.map((e) => [e.chunkId, e]));

console.log(
	`fixture: ${score.pairs.length} pairs, ${score.empties.length} empty chunks, ${score.tools.length} tool_output chunks, ${score.activeFacts} active facts`,
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

// The pair's own tool output carries the anchor too. A bank fact repeating it is the user's
// evidence, not a restatement of the relayed claim, and the scorer must say which it counted.
assert(
	b.quoteBankToolDerived === 1,
	`b: one of the two quote-side bank facts restates the chunk's grep output, got ${b.quoteBankToolDerived}`,
);
assert(
	b.quoteBankCarrying.some((e) => e.toolDerived) && !b.quoteBankCarrying.every((e) => e.toolDerived),
	"b: the claim fact and the evidence fact must not be classified the same way",
);

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

// j: the pair's own tool output carries the anchor, and the quote side's only anchor-carrying fact
// repeats it. Both published gates fail; the diagnostic passes. Pinned so the diagnostic can never be
// quietly promoted into the published number.
const j = byPair.get("j")!;
assert(j.keepBanked === true, "j: the keep side is banked, so the pair is eligible");
assert(
	j.quoteDraftToolDerived === 1 && j.quoteBankToolDerived === 1,
	`j: the quote side's draft and its bank fact both restate this chunk's doctor.log line, got ${j.quoteDraftToolDerived}/${j.quoteBankToolDerived}`,
);
assert(
	j.pairStrict === false && j.pairAttributed === false,
	"j: unattributed and anchor-carrying, so both published contracts fail it",
);
assert(
	j.pairEvidenceFree === true,
	"j: with the tool-output fact excluded the pair is pair-correct — the gap is the instrument",
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
assert(t.pairs === 10, `pairs 10, got ${t.pairs}`);
assert(t.keepBanked === 8, `keep banked 8 of 10 (c dropped, i superseded), got ${t.keepBanked}`);
assert(
	t.restraintDraftStrict === 4,
	`draft gate clean on 4 of 10 quote sides (a,b,d,g,h restated the claim; j restated its own tool output), got ${t.restraintDraftStrict}`,
);
assert(
	t.restraintBankStrict === 7,
	`bank gate clean on 7 of 10 (a,b,j added a second fact), got ${t.restraintBankStrict}`,
);
assert(
	t.restraintDraftAttributed === 7,
	`draft gate attributed-ok on 7 of 10 (a, d, j restated and named nothing), got ${t.restraintDraftAttributed}`,
);
assert(t.restraintBankAttributed === 8, `bank gate attributed-ok on 8 of 10, got ${t.restraintBankAttributed}`);
assert(
	t.restraintStrict === 4 && t.restraintAttributed === 7,
	`both-gate restraint 4 strict / 7 attributed, got ${t.restraintStrict}/${t.restraintAttributed}`,
);
assert(
	t.pairStrict === 2 && t.pairAttributed === 5,
	`pair-correct 2 strict / 5 attributed, got ${t.pairStrict}/${t.pairAttributed}`,
);
assert(
	t.pairsEvidenceFree === 6,
	`pair-correct attributed-ok rises to 6 of 10 once the pair's own tool-output facts are excluded — the fixture pins that the diagnostic can only ever be reported alongside the published number, got ${t.pairsEvidenceFree}`,
);
assert(t.abstained === 1 && t.suppressed === 1 && t.intruded === 1 && t.dropped === 1, "one of each empty outcome");
assert(t.bankFactsFromEmpty === 1, "exactly one fact the bank kept from an empty chunk");
assert(t.paraphraseSuspects === 1, `exactly one pair flagged as a possible paraphrase, got ${t.paraphraseSuspects}`);
assert(
	t.bankMerged === 1,
	`one pair merged with the surviving entry still on the quote side (g); h merged too but a third chunk refined it since, and this metric counts what the bank holds now, got ${t.bankMerged}`,
);
assert(t.bankAdded === 3, `three pairs got a new second fact (a, b, j), got ${t.bankAdded}`);
assert(t.bankDuplicated === 3, `three pairs hold the subject twice (a, b, j), got ${t.bankDuplicated}`);
assert(
	t.bankToolDerivedFacts === 2 && t.pairsToolDerived === 2,
	`two bank facts across two pairs restate their own tool output (b, j), got ${t.bankToolDerivedFacts} across ${t.pairsToolDerived}`,
);
assert(
	(score.opTotals.get("SKIP") ?? 0) === 2,
	"the fixture used SKIP twice (d and tool-05), so the report must not claim SKIP was never used",
);

// ---- tool_output: both failure directions, and every branch in between ----------
const byTool = new Map(score.tools.map((c) => [c.chunkId, c]));
assert(score.tools.length === 9, `9 tool_output chunks, got ${score.tools.length}`);
assert(byTool.get("hy-x-tool-01")!.outcome === "kept-fact", "tool-01: kept the tool fact and nothing else");
assert(
	byTool.get("hy-x-tool-08")!.outcome === "kept-fact" &&
		byTool.get("hy-x-tool-08")!.singleCleanFact === false &&
		byTool.get("hy-x-tool-08")!.factsCarriedIn === 1,
	"tool-08: a fact carrying its value sits in the bank, but 09 authored it — the outcome column credits 08, the authored column does not",
);
assert(byTool.get("hy-x-tool-09")!.facts[0].authoredHere === true, "tool-09: the merged fact is authored here");
assert(
	byTool.get("hy-x-tool-01")!.facts[0].probe === "--dry-run",
	"tool-01: the flag is what matched, not the prose around it",
);
assert(byTool.get("hy-x-tool-02")!.outcome === "kept-chatter", "tool-02: kept the chatter and missed the fact");
assert(byTool.get("hy-x-tool-03")!.outcome === "kept-both", "tool-03: one fact carrying both halves");
assert(
	byTool.get("hy-x-tool-04")!.outcome === "abstained",
	"tool-04: withheld — a judgment on this class, not a failure",
);
assert(byTool.get("hy-x-tool-05")!.outcome === "not-banked", "tool-05: drafted the fact, reconcile banked nothing");
assert(byTool.get("hy-x-tool-06")!.outcome === "kept-other", "tool-06: banked something the corpus declared neither");
assert(
	t.toolFactKept === 4 && t.toolChatterKept === 1 && t.toolBothKept === 1,
	`four chunks read as fact-only keeps (01, 07, 08, 09), one chatter-only, one both, got ${t.toolFactKept}/${t.toolChatterKept}/${t.toolBothKept}`,
);
assert(
	t.toolOtherKept === 1 && t.toolNotBanked === 1 && t.toolAbstained === 1,
	`one neither, one not banked, one withheld, got ${t.toolOtherKept}/${t.toolNotBanked}/${t.toolAbstained}`,
);
assert(t.toolFactsBanked === 8, `eight facts listed across the nine tool chunks, got ${t.toolFactsBanked}`);
assert(
	t.toolFactsCarriedIn === 1 && t.toolFactsBanked - t.toolFactsCarriedIn === 7,
	`seven facts were authored by the chunk they are listed under, one (08's) was carried in by a later merge, got ${t.toolFactsCarriedIn}`,
);
assert(
	t.toolFactsOnly === 5,
	`5 of the nine read as "every fact carries the value" (01, 03, 07, 08, 09) — including 08, which authored nothing; 02 kept chatter, 06 kept neither, 04 and 05 kept nothing, got ${t.toolFactsOnly}`,
);
assert(byTool.get("hy-x-tool-07")!.outcome === "kept-fact", "tool-07: still reads as a clean fact-only keep");
assert(
	byTool.get("hy-x-tool-07")!.duplicateValueFacts === 1 &&
		byTool.get("hy-x-tool-07")!.duplicateValueProbes.join(",") === "--no-clobber",
	`tool-07: one value banked twice, got ${byTool.get("hy-x-tool-07")!.duplicateValueFacts} repeat(s) of ${byTool.get("hy-x-tool-07")!.duplicateValueProbes.join(",")}`,
);
assert(
	t.toolValueDupChunks === 1 && t.toolValueDupFacts === 1,
	`the repeat column sees exactly the one chunk the stricter reading cannot, got ${t.toolValueDupChunks}/${t.toolValueDupFacts}`,
);
assert(
	t.toolSingleCleanChunks === 2,
	`the narrowest reading — one authored fact, carrying the value, carrying no chatter — is 2 of the nine (01 and 09); 03 carries value and chatter in one fact, 07 is the repeat pair, 08 authored nothing, got ${t.toolSingleCleanChunks}`,
);
assert(
	t.toolNarrationFacts === 1,
	`one banked fact authored by its own chunk carries neither a declared value nor declared chatter (06: the doctor describing itself), got ${t.toolNarrationFacts}`,
);

console.log(
	`ok: unattributed vs attributed, draft gate vs bank gate, drafted-then-dropped, merge vs second fact, supersede chains two hops long and one that lost the claim, the paraphrase blind spot, all four empty outcomes, and every tool_output branch (fact, chatter, both, neither, withheld, drafted-but-not-banked), and a value banked twice that every other column reads as clean, and a fact credited to a chunk that did not author it`,
);
