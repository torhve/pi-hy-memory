#!/usr/bin/env npx tsx

/**
 * Item 7.3: does the writer *withhold*, and does it *attribute*?
 *
 * Every other corpus in this repo is an organic coding session where almost everything is worth
 * recording, so every coverage number ever printed here has been a recall number. This scorer reads
 * the contrast pairs in `dev/corpus-restraint.json` — chunks whose correct output is known by
 * construction — and scores the two things recall cannot see: abstention on a chunk with nothing
 * durable, and speaker attribution when the identical sentence arrives from the user or from a
 * named third party.
 *
 * It is offline. No model calls, no judge: the ledger already holds what the writer proposed and
 * what the bank kept, and the corpus declares what should have happened. `scoreRun` is exported so
 * `tools/restraint-report-check.ts` can prove the scorer itself reads a ledger correctly; an
 * untested instrument is how a benchmark quietly produces a wrong number.
 *
 *   npx tsx dev/restraint-report.ts --run restraint-base
 *   npx tsx dev/restraint-report.ts --corpus dev/corpus-restraint.json --run a --run b --show 6
 *
 * Two gates, always. `extract` never sees the bank, so a draft gate failure is a prompt failure;
 * only `reconcile` can refuse something, so a bank gate failure with a clean draft gate is a
 * reconcile failure. Reporting one number would collapse the two.
 *
 * Two contracts, both printed. `strict` counts only withholding — the contract an external
 * benchmark of this same writer used, so the numbers stay comparable. `attributed-ok` also counts a
 * draft that carries the claim *and names the third party*, because a correctly attributed fact is
 * a usable memory for a coding agent. The headline uses attributed-ok; the divergence is stated,
 * not folded into a better-looking score.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { foldLedger } from "../src/bank.js";
import type { BankEntry, LedgerRecord } from "../src/types.js";

export interface CorpusChunk {
	chunkId: string;
	class: "attribution" | "empty" | "nothing_work" | "tool_output";
	pair?: string;
	side?: "keep" | "quote";
	anchors?: string[];
	marker?: string;
	claim?: string;
	why?: string;
	/** tool_output only: the tool fact defensible to bank, and the chatter that is not. */
	probes?: string[];
	transient?: string[];
	/** A rule the user stated beside tool output, which has to survive as a rule. */
	constraints?: string[];
	/** A value past the argument window that appears nowhere in what the writer was shown. */
	hidden?: string[];
	/** A chunk in another authored session that restates this chunk's subject. */
	crossSession?: string;
	/** Authored corpora carry their transcript inline; the scorer reads the tool-result lines out of it. */
	text?: string;
}

export interface DraftRow {
	task: string;
	statement: string;
	keys: string[];
	fromUser: boolean;
}

export interface PairRow {
	pair: string;
	keepChunk: string;
	quoteChunk: string;
	anchors: string[];
	marker: string;
	keepDrafted: boolean | null;
	keepBanked: boolean | null;
	quoteCarrying: DraftRow[];
	quoteDraftStrict: boolean | null;
	quoteDraftAttributed: boolean | null;
	quoteBankCarrying: {
		id: string;
		statement: string;
		fromUser: boolean;
		merged: boolean;
		toolDerived: boolean;
	}[];
	/** Quote-side bank facts that restate the chunk's own tool output: reported, never scored. */
	quoteBankToolDerived: number;
	/** Quote-side facts that merged into the keep-side fact, and ones that stand as new facts. */
	quoteMerged: number;
	quoteAdded: number;
	/** Active facts across the whole pair: 1 is one memory, 2+ is the bank holding the subject twice. */
	pairFacts: number;
	bankDuplicated: boolean;
	quoteBankStrict: boolean;
	quoteBankAttributed: boolean;
	pairStrict: boolean;
	pairAttributed: boolean;
	/** Quote-side drafts that restate the chunk's own tool output: reported, never scored. */
	quoteDraftToolDerived: number;
	/** Diagnostic: attributed-ok pair-correct with the pair's own tool-output facts removed. */
	pairEvidenceFree: boolean;
	/** Quote side scored clean by anchor, yet word-overlaps the keep-side fact: possible paraphrase. */
	paraphraseSuspects: { where: "draft" | "bank"; text: string; shared: string[] }[];
}

export interface EmptyRow {
	chunkId: string;
	why: string;
	present: boolean;
	drafts: DraftRow[];
	rejectedCount: number;
	outcome: "abstained" | "code-suppressed" | "intruded" | "dropped";
	inBank: number;
	/** What actually landed, because "the bank kept 2 facts from a chunk with nothing durable" is not
	 * yet a verdict: some of those facts are tool capabilities the bank should keep. */
	facts: { task: string; statement: string }[];
}

/** A chunk where the user decided nothing and the tool output stated something. The corpus names
 * both halves, so the score can be wrong in either direction: keeping the tool fact is the
 * defensible call, keeping the chatter is the failure the v1 label hid. */
export interface ToolRow {
	chunkId: string;
	why: string;
	present: boolean;
	drafts: DraftRow[];
	rejectedCount: number;
	probes: string[];
	transient: string[];
	/** Bank facts whose supersede chain reaches this chunk, tagged with which half each kept. */
	facts: {
		task: string;
		statement: string;
		probe: string | null;
		chatter: string | null;
		/** Which declared user rule, if any, this fact carries in the chunk's own words. */
		constraint: string | null;
		/** Which token of a hidden value this fact carries, when it carries one at all. */
		hidden: string | null;
		/** No declared value, no quoted chatter, and none of it, yet the fact holds a declared chatter
		 * phrase's content words: the chatter reached the bank reworded around itself. */
		chatterParaphrase: boolean;
		repeat: boolean;
		authoredHere: boolean;
		keys: string[];
		/** Wording only: does this statement open with a person or with the agent's own voice.
		 * Reported, never scored — see `actorFramedStatement` above the scoring section. */
		actorFramed: boolean;
	}[];
	/** Declared values that reached the bank from this chunk, and the ones that did not: a chunk can
	 * keep *a* declared value and still lose another one, which the per-chunk outcome cannot see. */
	probesKept: string[];
	probesLost: string[];
	/** Facts this chunk authored whose wording is about a person or the agent rather than the thing. */
	actorFramedFacts: number;
	/**
	 * A declared value banked more than once from the same chunk. A restatement in an actor frame
	 * ("User confirmed the flag is…") carries the value, so `facts` alone counts it as a kept fact
	 * and the duplication is invisible. Reported as a diagnostic, never folded into the outcome or
	 * into the stricter "every fact carries the value" column.
	 *
	 * Structural, not semantic: a repeat is two banked facts in one authored chunk whose *declared*
	 * value both match. It needs the corpus's probe list and does not detect paraphrase.
	 */
	duplicateValueFacts: number;
	duplicateValueProbes: string[];
	/** How many banked facts from this chunk are a first copy of a declared value, its repeat, the
	 * declared chatter, or neither — the four kinds at fact level, since one chunk's outcome alone
	 * cannot tell narration banked beside a value from a chunk that banked only the value. `authoredHere`
	 * separates facts the chunk itself banked from facts a later merge pulled in: the chain reaches a chunk
	 * when a fact authored here was absorbed into a fact authored somewhere else. */
	factsValue: number;
	factsRepeat: number;
	factsChatter: number;
	factsNeither: number;
	factsCarriedIn: number;
	/** Exactly one fact banked from the chunk, and it carries a declared value: nothing repeated,
	 * no chatter, no narration. The narrowest reading of "kept the tool fact and nothing else". */
	singleCleanFact: boolean;
	/** The user rules this chunk declares beside tool output, and what the bank did with each one:
	 * carried in the chunk's own words, present only as a restatement, or gone. Per rule, not per
	 * chunk, because one chunk can hold two rules and keep one of them. */
	constraints: string[];
	constraintsKept: string[];
	constraintsRestated: string[];
	constraintsLost: string[];
	/** Bank facts whose only tie to a declared label is a user rule: the rule survived and the tool
	 * fact did not, which the outcome column can only read as `kept-other`. */
	factsConstraint: number;
	/** The value the corpus says the writer was never shown, and the facts from this chunk that carry
	 * one of its tokens anyway. A survivor here was supplied by the model, not read from the session. */
	hidden: string[];
	hiddenSurvivals: { statement: string; token: string }[];
	/** Drafts from this chunk that carry an unread token of the hidden value. A draft carrying it was
	 * written from the model's own wording rather than read: reported at the draft gate so a value the
	 * bank refused and a value the writer never had are not the same line. */
	hiddenDrafts: { statement: string; token: string }[];
	/** Bank facts carrying no declared value and none of the declared chatter verbatim, but holding a
	 * declared chatter phrase's content words: the chatter arrived paraphrased, which is the hole
	 * literal chatter matching left open in the 2026-10-22 label audit. */
	factsChatterParaphrase: number;
	/** The chunk in the other authored session that restates this chunk's subject, when the corpus says
	 * there is one. Which fact superseded which is not the scorer's to decide. */
	crossSession: string | null;
	outcome:
		| "kept-fact"
		| "kept-both"
		| "kept-chatter"
		| "kept-other"
		| "not-banked"
		| "abstained"
		| "code-suppressed"
		| "dropped";
}

export interface RunScore {
	pairs: PairRow[];
	empties: EmptyRow[];
	tools: ToolRow[];
	activeFacts: number;
	/** Active bank facts whose wording opens with a person or the agent's own voice — wording-shaped,
	 * reported for comparing two prompts over one corpus, never a gate. */
	bankActorFramedFacts: number;
	opTotals: Map<string, number>;
}

/** Split-chunk arms write `hy-…-001.1` and `…001.2` over one corpus chunk: fold them together. */
const base = (chunkId: string): string => chunkId.replace(/\.\d+$/, "");

/** A claim survives paraphrase as a token, not as a sentence: match the anchor as a whole token.
 * A flag-shaped token needs a boundary that does not assume a word character on its outside — a `\b`
 * in front of `--dry-run` matches nothing — while an ordinary token keeps `\b`, which is the boundary
 * every earlier score in this repo was computed with. */
/**
 * Wording-shaped, reported, never scored. Upstream's coding prompt bans one thing a regular
 * expression can actually see: "its grammatical subject is never a person and never the agent".
 * This asks only whether a banked statement *opens* that way.
 *
 * A floor, not a measurement: "the drain lock stays held; the user asked for it" passes it, and so
 * does a person-framed sentence that opens with the value. What it does guarantee is that every
 * fact it names is one a reader would flag, which is what makes it usable for comparing two
 * prompts over one corpus instead of as a gate.
 */
const OPENS_WITH_PERSON = /^(the\s+)?(user|assistant|operator|the agent|the model|i|we|they)\b/i;
const OPENS_WITH_AGENT_VOICE =
	/^(ran|checked|found|noted|verified|confirmed|made|did|updated|fixed|showed|told|gave|opened|read|used|tried|looked|pulled)\b/i;

export function actorFramedStatement(statement: string): boolean {
	const s = statement.trim();
	return OPENS_WITH_PERSON.test(s) || OPENS_WITH_AGENT_VOICE.test(s);
}

/** A claim survives paraphrase as a token, not as a sentence: match the anchor as a whole token.
 * A flag-shaped token needs a boundary that does not assume a word character on its outside — a `\b`
 * in front of `--dry-run` matches nothing — while an ordinary token keeps `\b`, which is the boundary
 * every earlier score in this repo was computed with. */
export function carries(anchor: string, text: string): boolean {
	const esc = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = anchor.startsWith("-") ? `(?<![\\w-])${esc}(?![\\w-])` : `\\b${esc}\\b`;
	return new RegExp(pattern, "i").test(text);
}

const textOf = (row: { task: string; statement: string; keys: string[] }): string =>
	`${row.task} ${row.statement} ${row.keys.join(" ")}`;

/**
 * Did this draft or fact name the third party? A name inside a quoted sentence counts: the
 * restraint being tested is *who the claim is attributed to*, and "Mara said X" is the answer.
 */
export function namesMarker(marker: string, row: { task: string; statement: string; keys: string[] }): boolean {
	return carries(marker, textOf(row));
}

const STOPWORDS = new Set([
	"this",
	"that",
	"with",
	"from",
	"when",
	"into",
	"they",
	"their",
	"then",
	"than",
	"have",
	"has",
	"was",
	"were",
	"will",
	"would",
	"should",
	"could",
	"must",
	"only",
	"also",
	"here",
	"there",
	"what",
	"which",
	"while",
	"about",
	"after",
	"before",
	"because",
]);

/**
 * Content words, for the one thing an anchor cannot see: a quote-side draft that keeps the claim and
 * drops every anchor token. Word overlap is reported as a *suspicion*, never scored as an intrusion —
 * counting it as an intrusion would punish a legitimate related fact, and ignoring it would let a
 * paraphrase pass as restraint.
 */
export function sharedTokens(a: string, b: string): string[] {
	const words = (text: string): Set<string> =>
		new Set(
			text
				.toLowerCase()
				.split(/[^a-z0-9_]+/)
				.filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
		);
	const left = words(a);
	return [...words(b)].filter((w) => left.has(w));
}

/**
 * The lines of an authored chunk that are tool output rather than something a participant said.
 * A contrast pair deliberately shows the same tool output on both sides — that is what keeps the
 * speaker frame the only variable — and the tool output carries the anchor too. So a bank fact that
 * repeats the anchor is not automatically a restatement of the relayed claim: it can be the user's
 * own evidence, which needs no attribution because nobody relayed it.
 */
function toolLines(chunk: CorpusChunk): string[] {
	return (chunk.text ?? "").split("\n").filter((line) => /^\[\d+\] \[Tool result/.test(line));
}

/**
 * The loose reading beside `carries`: a bank fact restates a phrase when it holds that phrase's content
 * words, in any order and with any framing around them. Reported beside the literal count and never
 * instead of it: a rule that survived as a paraphrase is a different outcome from one that survived in
 * the user's own words, and the 2026-10-22 label audit is what asked for the two to be told apart.
 */
export function rewords(phrase: string, text: string): boolean {
	const words = (t: string): string[] => [
		...new Set(
			t
				.toLowerCase()
				.split(/[^a-z0-9_]+/)
				.filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
		),
	];
	const need = words(phrase);
	if (need.length < 2) return false;
	const have = new Set(words(text));
	return need.every((w) => have.has(w));
}

/**
 * The parts of a hidden value that could not have been read out of what the writer was shown: a flag name or
 * a number, kept only when no chunk shows that token. dev/restraint-report.ts passes the whole corpus's
 * authored text rather than the declaring chunk alone: `--retention-days 45` hides both of its tokens from a
 * chunk that shows neither, but a session that prints 45 anywhere — in plain sight or as the minute of
 * `@ 10:45` — makes the number read rather than invented, and only the flag stays unread.
 */
export function hiddenSignatures(hidden: string, visibleText: string): string[] {
	const tokens = [...(hidden.match(/--[a-z0-9-]{2,}/g) ?? []), ...(hidden.match(/\b\d{2,}\b/g) ?? [])];
	return [...new Set(tokens)].filter((token) => !carries(token, visibleText));
}

export function scoreRun(chunks: CorpusChunk[], ledger: LedgerRecord[]): RunScore {
	const evidence = new Map<
		string,
		{ present: boolean; drafts: DraftRow[]; rejectedCount: number; ops: { action: string }[] }
	>();
	const opTotals = new Map<string, number>();
	for (const record of ledger) {
		// A gap records lost coverage and carries no chunkId.
		if (record.type === "hy.gap") continue;
		const key = base(record.chunkId);
		if (record.type === "hy.extract") {
			evidence.set(key, {
				present: true,
				drafts: (record.drafts ?? []).map((d) => ({
					task: d.task,
					statement: d.statement,
					keys: d.keys ?? [],
					fromUser: d.fromUser === true,
				})),
				rejectedCount: record.rejectedCount ?? 0,
				ops: [],
			});
			continue;
		}
		if (record.type !== "hy.ops") continue;
		const ops = (record.ops ?? []).map((op) => ({ action: op.action }));
		for (const op of ops) opTotals.set(op.action, (opTotals.get(op.action) ?? 0) + 1);
		const row = evidence.get(key);
		if (row) row.ops = ops;
		else evidence.set(key, { present: false, drafts: [], rejectedCount: 0, ops });
	}

	const allEntries = foldLedger(ledger);
	const entryById = new Map(allEntries.map((e) => [e.id, e]));
	const bank = allEntries.filter((entry) => entry.status === "active");
	const bankByChunk = new Map<string, BankEntry[]>();
	for (const entry of bank) {
		const key = base(entry.chunkId);
		bankByChunk.set(key, [...(bankByChunk.get(key) ?? []), entry]);
	}

	/**
	 * Which chunks a surviving fact came from. An UPDATE writes a *new* entry whose own chunkId is the
	 * newer chunk and whose `supersedes` points back at the fact it replaced. A claim stated on the
	 * keep side and merged on the quote side is therefore still in the bank, and reading only the
	 * entry's own chunkId counted it as lost — which is how the first real run printed 13 % recall on a
	 * corpus where every claim survived.
	 */
	function chainChunks(entry: BankEntry): string[] {
		const seen = new Set<string>();
		const chunks: string[] = [];
		let cur: BankEntry | undefined = entry;
		while (cur && !seen.has(cur.id)) {
			seen.add(cur.id);
			chunks.push(base(cur.chunkId));
			cur = cur.supersedes ? entryById.get(cur.supersedes) : undefined;
		}
		return chunks;
	}
	const pairs = new Map<string, { keep: CorpusChunk; quote: CorpusChunk }>();
	const empties: CorpusChunk[] = [];
	const toolChunks: CorpusChunk[] = [];
	for (const chunk of chunks) {
		if (chunk.class === "empty" || chunk.class === "nothing_work") {
			// Same contract, different claim about why: `empty` is the v1 label, `nothing_work` is
			// the narrowed one the label audit produced. Both expect {"drafts":[]}.
			empties.push(chunk);
			continue;
		}
		if (chunk.class === "tool_output") {
			toolChunks.push(chunk);
			continue;
		}
		if (!chunk.pair) continue;
		const row = pairs.get(chunk.pair) ?? {
			keep: undefined as unknown as CorpusChunk,
			quote: undefined as unknown as CorpusChunk,
		};
		if (chunk.side === "keep") row.keep = chunk;
		else row.quote = chunk;
		pairs.set(chunk.pair, row);
	}

	const pairRows: PairRow[] = [];
	for (const [pair, { keep, quote }] of [...pairs.entries()].sort()) {
		const keepEv = evidence.get(base(keep.chunkId));
		const quoteEv = evidence.get(base(quote.chunkId));
		const anchors = keep.anchors ?? [];
		const marker = keep.marker ?? "";

		const keepCarrying = keepEv?.present
			? keepEv.drafts.filter((d) => anchors.some((a) => carries(a, textOf(d))))
			: [];
		// Recall follows the supersede chain: the claim counts if a surviving fact carries it and that
		// fact's history includes the keep chunk, whether reconcile kept the original entry or merged it.
		const keepBanked = keepEv?.present
			? bank.some(
					(e) => anchors.some((a) => carries(a, textOf(e))) && chainChunks(e).includes(base(keep.chunkId)),
				)
			: null;

		const quoteCarrying = quoteEv?.present
			? quoteEv.drafts.filter((d) => anchors.some((a) => carries(a, textOf(d))))
			: [];
		const quoteFacts = (bankByChunk.get(base(quote.chunkId)) ?? []).filter((e) =>
			anchors.some((a) => carries(a, textOf(e))),
		);
		/**
		 * A draft or a fact that repeats the chunk's own tool output is not a relayed claim, and the
		 * pair's tool output carries the anchor on both sides by design. The published gates count
		 * those as quote-side facts about the claim; the diagnostic below shows how much of the gap
		 * is the instrument rather than the writer.
		 */
		const derived = (text: string): boolean =>
			toolLines(quote).some((line) => sharedTokens(line, text).length >= 3);
		const quoteDraftToolDerived = quoteCarrying.filter((d) => derived(textOf(d))).length;
		// Two different things a quote-side fact can be. Merging into the keep-side fact is reconcile
		// doing its job on a restatement; adding a second active fact about the same subject is the
		// duplication restraint is meant to prevent. Scoring them together hid which one happened.
		const quoteBankCarrying = quoteFacts.map((e) => ({
			id: e.id,
			statement: e.statement,
			fromUser: e.fromUser === true,
			merged: chainChunks(e).includes(base(keep.chunkId)),
			/** Restates the chunk's own tool output rather than the relayed claim. Reported, not scored. */
			toolDerived: derived(textOf(e)),
		}));
		const quoteAdded = quoteBankCarrying.filter((e) => !e.merged).length;
		const quoteMerged = quoteBankCarrying.length - quoteAdded;
		const pairFacts = bank.filter(
			(e) =>
				anchors.some((a) => carries(a, textOf(e))) &&
				chainChunks(e).some((c) => c === base(keep.chunkId) || c === base(quote.chunkId)),
		);

		const quoteDraftStrict = quoteEv?.present ? quoteCarrying.length === 0 : null;
		const quoteDraftAttributed = quoteEv?.present
			? quoteCarrying.length === 0 || quoteCarrying.some((d) => namesMarker(marker, d))
			: null;
		// Restraint at the bank gate means the quote side added nothing new. A merge is not an
		// intrusion; a second active fact about the same subject is.
		const quoteBankStrict = quoteAdded === 0;
		const quoteBankAttributed = quoteBankCarrying.every((e) =>
			namesMarker(marker, { task: "", statement: e.statement, keys: [] }),
		);
		// Diagnostic, not a published gate: the same attributed-ok contract with the pair's own
		// tool-output facts removed from the quote side. The distance between this and pairAttributed
		// is how much of the published gap the instrument itself created.
		const draftWithoutEvidence = quoteCarrying.filter((d) => !derived(textOf(d)));
		const bankWithoutEvidence = quoteBankCarrying.filter((e) => !e.toolDerived);
		const draftOkWithoutEvidence = quoteEv?.present
			? draftWithoutEvidence.length === 0 || draftWithoutEvidence.some((d) => namesMarker(marker, d))
			: null;
		const bankOkWithoutEvidence = bankWithoutEvidence.every((e) =>
			namesMarker(marker, { task: "", statement: e.statement, keys: [] }),
		);
		const pairEvidenceFree = Boolean(keepBanked) && draftOkWithoutEvidence === true && bankOkWithoutEvidence;

		// The blind spot of anchor matching, made visible instead of assumed away.
		const keepText = (bankByChunk.get(base(keep.chunkId)) ?? []).map((e) => textOf(e)).join(" ");
		const paraphraseSuspects: PairRow["paraphraseSuspects"] = [];
		if (keepText) {
			for (const d of quoteEv?.present ? quoteEv.drafts : []) {
				if (anchors.some((a) => carries(a, textOf(d)))) continue;
				const shared = sharedTokens(keepText, textOf(d));
				if (shared.length >= 3) paraphraseSuspects.push({ where: "draft", text: d.statement, shared });
			}
			for (const e of bankByChunk.get(base(quote.chunkId)) ?? []) {
				if (anchors.some((a) => carries(a, textOf(e)))) continue;
				const shared = sharedTokens(keepText, textOf(e));
				if (shared.length >= 3) paraphraseSuspects.push({ where: "bank", text: e.statement, shared });
			}
		}

		pairRows.push({
			pair,
			keepChunk: keep.chunkId,
			quoteChunk: quote.chunkId,
			anchors,
			marker,
			keepDrafted: keepEv?.present ? keepCarrying.length > 0 : null,
			keepBanked,
			quoteCarrying,
			quoteDraftStrict,
			quoteDraftAttributed,
			quoteBankCarrying,
			quoteBankToolDerived: quoteBankCarrying.filter((e) => e.toolDerived).length,
			quoteMerged,
			quoteAdded,
			pairFacts: pairFacts.length,
			bankDuplicated: pairFacts.length >= 2,
			quoteBankStrict,
			quoteBankAttributed,
			pairStrict: Boolean(keepBanked) && quoteDraftStrict === true && quoteBankStrict,
			pairAttributed: Boolean(keepBanked) && quoteDraftAttributed === true && quoteBankAttributed,
			quoteDraftToolDerived,
			pairEvidenceFree,
			paraphraseSuspects,
		});
	}

	const emptyRows: EmptyRow[] = empties.map((chunk) => {
		const ev = evidence.get(base(chunk.chunkId));
		if (!ev?.present) {
			return {
				chunkId: chunk.chunkId,
				why: chunk.why ?? "",
				present: false,
				drafts: [],
				rejectedCount: 0,
				outcome: "dropped",
				inBank: 0,
				facts: [],
			};
		}
		const inBank = (bankByChunk.get(base(chunk.chunkId)) ?? []).length;
		const outcome =
			ev.drafts.length === 0 && ev.rejectedCount === 0
				? "abstained"
				: ev.drafts.length === 0
					? "code-suppressed"
					: "intruded";
		return {
			chunkId: chunk.chunkId,
			why: chunk.why ?? "",
			present: true,
			drafts: ev.drafts,
			rejectedCount: ev.rejectedCount,
			outcome,
			inBank,
			facts: (bankByChunk.get(base(chunk.chunkId)) ?? []).map((e) => ({
				task: e.task,
				statement: e.statement,
			})),
		};
	});

	// A hidden value is measured against everything the corpus shows, not only against the chunk that
	// declares it: `--retention-days 45` hides a flag and a number, and a number the session prints
	// somewhere else was read rather than invented. The corpus check insists at least one token of every
	// hidden value is shown by no chunk, and names the rest as ambiguous.
	const shownSomewhere = chunks.map((c) => c.text ?? "").join("\n");

	const toolRows: ToolRow[] = toolChunks.map((chunk) => {
		const ev = evidence.get(base(chunk.chunkId));
		const probes = chunk.probes ?? [];
		const chatter = chunk.transient ?? [];
		const constraints = chunk.constraints ?? [];
		const hiddenTokens = [...new Set((chunk.hidden ?? []).flatMap((h) => hiddenSignatures(h, shownSomewhere)))];
		const facts = bank
			.filter((e) => chainChunks(e).includes(base(chunk.chunkId)))
			.map((e) => {
				const text = textOf({ task: e.task, statement: e.statement, keys: e.keys });
				return {
					task: e.task,
					statement: e.statement,
					probe: probes.find((p) => carries(p, text)) ?? null,
					chatter: chatter.find((c) => carries(c, text)) ?? null,
					constraint: constraints.find((c) => carries(c, text)) ?? null,
					hidden: hiddenTokens.find((t) => carries(t, text)) ?? null,
					chatterParaphrase: false,
					repeat: false,
					// The chain reaches this chunk when a fact authored here was later absorbed into a
					// fact authored elsewhere, so a fact in this list is not always one this chunk banked.
					authoredHere: base(e.chunkId) === base(chunk.chunkId),
					keys: e.keys ?? [],
					actorFramed: actorFramedStatement(e.statement),
				};
			});
		// A declared value can be banked more than once from one chunk: a restatement in an
		// actor frame ("User confirmed the flag is…") still carries the value, so the columns
		// above call it a kept fact. Mark the second copy and count the repeats separately —
		// counting only facts this chunk authored, since a value reaching the bank once per
		const valueUses = new Map<string, number>();
		for (const f of facts) {
			if (!f.probe || !f.authoredHere) continue;
			const seen = valueUses.get(f.probe) ?? 0;
			if (seen > 0) f.repeat = true;
			valueUses.set(f.probe, seen + 1);
		}
		const duplicateValueProbes = [...valueUses.entries()].filter(([, n]) => n > 1).map(([p]) => p);
		const duplicateValueFacts = [...valueUses.values()].reduce((n, k) => n + Math.max(0, k - 1), 0);
		const factsCarriedIn = facts.filter((f) => !f.authoredHere).length;
		const authored = facts.filter((f) => f.authoredHere);
		// Counted per declared value and not per chunk, because a chunk can keep one declared value
		// and drop another while the outcome line still reads `kept-fact`.
		const probesKept = probes.filter((p) =>
			facts.some((f) => carries(p, textOf({ task: f.task, statement: f.statement, keys: f.keys }))),
		);
		const probesLost = probes.filter((p) => !probesKept.includes(p));
		const factText = (f: { task: string; statement: string; keys: string[] }): string =>
			textOf({ task: f.task, statement: f.statement, keys: f.keys });
		// A user rule counts as kept when a bank fact carries it in the user's own words, restated when
		// one holds its content words and not its wording, and lost when neither reaches the bank.
		const constraintsKept = constraints.filter((c) => facts.some((f) => carries(c, factText(f))));
		const constraintsRestated = constraints.filter(
			(c) => !constraintsKept.includes(c) && facts.some((f) => rewords(c, factText(f))),
		);
		const constraintsLost = constraints.filter(
			(c) => !constraintsKept.includes(c) && !constraintsRestated.includes(c),
		);
		const factsConstraint = authored.filter((f) => f.constraint !== null && f.probe === null).length;
		// A fact from this chunk carrying a token the chunk never shows was not read out of the session.
		const hiddenSurvivals = authored
			.filter((f) => f.hidden !== null)
			.map((f) => ({ statement: f.statement, token: f.hidden as string }));
		// The same token read at the draft gate: the model wrote it before the bank decided anything, so
		// this is where a value the writer was never shown would first appear.
		const hiddenDrafts =
			ev?.present && hiddenTokens.length > 0
				? ev.drafts
						.filter((d) => hiddenTokens.some((token) => carries(token, textOf(d))))
						.map((d) => ({
							statement: d.statement,
							token: hiddenTokens.find((token) => carries(token, textOf(d))) as string,
						}))
				: [];
		for (const f of facts) {
			f.chatterParaphrase =
				f.probe === null &&
				f.constraint === null &&
				f.chatter === null &&
				chatter.some((c) => rewords(c, factText(f)));
		}
		const factsChatterParaphrase = authored.filter((f) => f.chatterParaphrase).length;
		const actorFramedFacts = authored.filter((f) => f.actorFramed).length;
		const factsValue = authored.filter((f) => f.probe !== null && !f.repeat).length;
		const factsRepeat = authored.filter((f) => f.repeat).length;
		const factsChatter = authored.filter((f) => f.probe === null && f.chatter !== null).length;
		const factsNeither = authored.filter((f) => f.probe === null && f.chatter === null).length;
		const singleCleanFact = authored.length === 1 && authored[0].probe !== null && authored[0].chatter === null;
		const keptProbe = facts.some((f) => f.probe !== null);
		const keptChatter = facts.some((f) => f.chatter !== null);
		const outcome: ToolRow["outcome"] = !ev?.present
			? "dropped"
			: ev.drafts.length === 0 && ev.rejectedCount === 0
				? "abstained"
				: ev.drafts.length === 0
					? "code-suppressed"
					: facts.length === 0
						? "not-banked"
						: keptProbe && keptChatter
							? "kept-both"
							: keptProbe
								? "kept-fact"
								: keptChatter
									? "kept-chatter"
									: "kept-other";
		return {
			chunkId: chunk.chunkId,
			why: chunk.why ?? "",
			present: Boolean(ev?.present),
			drafts: ev?.drafts ?? [],
			rejectedCount: ev?.rejectedCount ?? 0,
			probes,
			transient: chatter,
			facts,
			duplicateValueFacts,
			duplicateValueProbes,
			factsValue,
			factsRepeat,
			factsChatter,
			factsNeither,
			factsCarriedIn,
			singleCleanFact,
			probesKept,
			probesLost,
			actorFramedFacts,
			constraints,
			constraintsKept,
			constraintsRestated,
			constraintsLost,
			factsConstraint,
			hidden: chunk.hidden ?? [],
			hiddenSurvivals,
			hiddenDrafts,
			factsChatterParaphrase,
			crossSession: chunk.crossSession ?? null,
			outcome,
		};
	});

	return {
		pairs: pairRows,
		empties: emptyRows,
		tools: toolRows,
		activeFacts: bank.length,
		bankActorFramedFacts: bank.filter((e) => actorFramedStatement(e.statement)).length,
		opTotals,
	};
}

export interface Totals {
	pairs: number;
	keepBanked: number;
	/** Per gate: a draft-gate failure is a prompt failure, a bank-gate failure is a reconcile failure. */
	restraintDraftStrict: number;
	restraintBankStrict: number;
	restraintDraftAttributed: number;
	restraintBankAttributed: number;
	restraintStrict: number;
	restraintAttributed: number;
	pairStrict: number;
	pairAttributed: number;
	paraphraseSuspects: number;
	bankMerged: number;
	bankDuplicated: number;
	bankAdded: number;
	/** Quote-side bank facts that restate the chunk's own tool output — reported, never scored. */
	bankToolDerivedFacts: number;
	pairsToolDerived: number;
	/** Diagnostic only: attributed-ok pair-correct ignoring the pair's own tool-output facts. */
	pairsEvidenceFree: number;
	abstained: number;
	suppressed: number;
	intruded: number;
	dropped: number;
	bankFactsFromEmpty: number;
	/** tool_output: keeping the tool fact is the defensible call, keeping the chatter is the failure. */
	toolChunks: number;
	toolFactKept: number;
	toolBothKept: number;
	toolChatterKept: number;
	toolOtherKept: number;
	toolNotBanked: number;
	toolAbstained: number;
	toolSuppressed: number;
	toolDropped: number;
	toolFactsBanked: number;
	/** The stricter reading: every fact the bank kept from the chunk carries the declared tool fact. */
	toolFactsOnly: number;
	/**
	 * Chunks that banked one declared value twice, and how many facts were repeats. Reported beside
	 * `toolFactsOnly`, never inside it: a repeat carries the value too, so the stricter reading above
	 * counts it as clean and the duplication has nowhere else to go.
	 */
	toolValueDupChunks: number;
	toolValueDupFacts: number;
	/**
	 * The narrowest reading: the chunk banked exactly one fact, it carried a declared value, and it
	 * carried none of the declared chatter. Stricter than `toolFactsOnly`, because one fact can carry
	 * the value and the chatter together and `toolFactsOnly` cannot tell that from a clean keep.
	 */
	toolSingleCleanChunks: number;
	/** Banked facts that carry neither a declared value nor declared chatter — narration kept as fact. */
	toolNarrationFacts: number;
	/** Banked facts whose supersede chain passes through the chunk but were authored in another chunk —
	 * a later merge absorbed this chunk's fact into a fact written somewhere else. */
	toolFactsCarriedIn: number;
	/** tool_output chunks that declare a user rule, and what the bank did with each declared rule: kept
	 * in the user's own words, present only as its content words, or gone. Per rule, not per chunk. */
	toolConstraintChunks: number;
	toolConstraintsDeclared: number;
	toolConstraintsKept: number;
	toolConstraintsRestated: number;
	toolConstraintsLost: number;
	/** Banked facts whose only tie to a declared label is a user rule: the rule survived and the tool
	 * fact did not, which the outcome column reads as `kept-other`. */
	toolFactsConstraint: number;
	/** Chunks whose declared value sat past the argument window and appeared nowhere else in the session,
	 * and the banked facts carrying a token of it anyway. The only number in this report that the
	 * writer's own input cannot explain, and the fabrication probe's positive case. */
	toolHiddenChunks: number;
	toolHiddenSurvivalFacts: number;
	/** Drafts — not banked facts — carrying an unread token: the writer's own words reached for a value
	 * no chunk shows, whether or not the bank kept it. */
	toolHiddenDraftFacts: number;
	/** Banked chatter that arrived paraphrased rather than quoted — the hole the 2026-10-22 label audit
	 * found and literal chatter matching could not see. */
	toolChatterParaphraseFacts: number;
	/** Declared values counted per value and not per chunk: keeping one declared value while dropping
	 * another still reads `kept-fact` in the outcome column, so the loss needs its own line. */
	toolProbesDeclared: number;
	toolProbesKept: number;
	toolChunksLostValue: number;
	/** Facts authored in these chunks whose wording opens with a person or the agent's own voice, over
	 * all facts authored there, plus the same pattern across the whole active bank. Wording-shaped
	 * floor, reported for comparing two prompts over one corpus, never a gate. */
	toolActorFramedAuthored: number;
	toolFactsAuthored: number;
	bankActorFramedFacts: number;
	bankFacts: number;
}

export function totals(score: RunScore): Totals {
	return {
		pairs: score.pairs.length,
		keepBanked: score.pairs.filter((p) => p.keepBanked).length,
		restraintDraftStrict: score.pairs.filter((p) => p.quoteDraftStrict === true).length,
		restraintBankStrict: score.pairs.filter((p) => p.quoteBankStrict).length,
		restraintDraftAttributed: score.pairs.filter((p) => p.quoteDraftAttributed === true).length,
		restraintBankAttributed: score.pairs.filter((p) => p.quoteBankAttributed).length,
		restraintStrict: score.pairs.filter((p) => p.quoteDraftStrict && p.quoteBankStrict).length,
		restraintAttributed: score.pairs.filter((p) => p.quoteDraftAttributed && p.quoteBankAttributed).length,
		pairStrict: score.pairs.filter((p) => p.pairStrict).length,
		pairAttributed: score.pairs.filter((p) => p.pairAttributed).length,
		paraphraseSuspects: score.pairs.filter((p) => p.paraphraseSuspects.length > 0).length,
		bankMerged: score.pairs.filter((p) => p.quoteMerged > 0).length,
		bankAdded: score.pairs.filter((p) => p.quoteAdded > 0).length,
		bankDuplicated: score.pairs.filter((p) => p.bankDuplicated).length,
		bankToolDerivedFacts: score.pairs.reduce((n, p) => n + p.quoteBankToolDerived, 0),
		pairsToolDerived: score.pairs.filter((p) => p.quoteBankToolDerived > 0).length,
		pairsEvidenceFree: score.pairs.filter((p) => p.pairEvidenceFree).length,
		abstained: score.empties.filter((e) => e.outcome === "abstained").length,
		suppressed: score.empties.filter((e) => e.outcome === "code-suppressed").length,
		intruded: score.empties.filter((e) => e.outcome === "intruded").length,
		dropped: score.empties.filter((e) => e.outcome === "dropped").length,
		bankFactsFromEmpty: score.empties.reduce((n, e) => n + e.inBank, 0),
		toolChunks: score.tools.length,
		toolFactKept: score.tools.filter((c) => c.outcome === "kept-fact").length,
		toolBothKept: score.tools.filter((c) => c.outcome === "kept-both").length,
		toolChatterKept: score.tools.filter((c) => c.outcome === "kept-chatter").length,
		toolOtherKept: score.tools.filter((c) => c.outcome === "kept-other").length,
		toolNotBanked: score.tools.filter((c) => c.outcome === "not-banked").length,
		toolAbstained: score.tools.filter((c) => c.outcome === "abstained").length,
		toolSuppressed: score.tools.filter((c) => c.outcome === "code-suppressed").length,
		toolDropped: score.tools.filter((c) => c.outcome === "dropped").length,
		toolFactsBanked: score.tools.reduce((n, c) => n + c.facts.length, 0),
		toolFactsOnly: score.tools.filter((c) => c.facts.length > 0 && c.facts.every((f) => f.probe !== null)).length,
		toolValueDupChunks: score.tools.filter((c) => c.duplicateValueFacts > 0).length,
		toolValueDupFacts: score.tools.reduce((n, c) => n + c.duplicateValueFacts, 0),
		toolSingleCleanChunks: score.tools.filter((c) => c.singleCleanFact).length,
		toolNarrationFacts: score.tools.reduce((n, c) => n + c.factsNeither, 0),
		toolFactsCarriedIn: score.tools.reduce((n, c) => n + c.factsCarriedIn, 0),
		toolProbesDeclared: score.tools.reduce((n, c) => n + c.probes.length, 0),
		toolProbesKept: score.tools.reduce((n, c) => n + c.probesKept.length, 0),
		toolChunksLostValue: score.tools.filter((c) => c.probesLost.length > 0).length,
		toolConstraintChunks: score.tools.filter((c) => c.constraints.length > 0).length,
		toolConstraintsDeclared: score.tools.reduce((n, c) => n + c.constraints.length, 0),
		toolConstraintsKept: score.tools.reduce((n, c) => n + c.constraintsKept.length, 0),
		toolConstraintsRestated: score.tools.reduce((n, c) => n + c.constraintsRestated.length, 0),
		toolConstraintsLost: score.tools.reduce((n, c) => n + c.constraintsLost.length, 0),
		toolFactsConstraint: score.tools.reduce((n, c) => n + c.factsConstraint, 0),
		toolHiddenChunks: score.tools.filter((c) => c.hidden.length > 0).length,
		toolHiddenSurvivalFacts: score.tools.reduce((n, c) => n + c.hiddenSurvivals.length, 0),
		toolHiddenDraftFacts: score.tools.reduce((n, c) => n + c.hiddenDrafts.length, 0),
		toolChatterParaphraseFacts: score.tools.reduce((n, c) => n + c.factsChatterParaphrase, 0),
		toolActorFramedAuthored: score.tools.reduce((n, c) => n + c.actorFramedFacts, 0),
		toolFactsAuthored: score.tools.reduce((n, c) => n + (c.facts.length - c.factsCarriedIn), 0),
		bankActorFramedFacts: score.bankActorFramedFacts,
		bankFacts: score.activeFacts,
	};
}

// ---------------------------------------------------------------- CLI ---------

function argList(flag: string): string[] {
	const out: string[] = [];
	for (let i = 2; i < process.argv.length; i++)
		if (process.argv[i] === flag && process.argv[i + 1]) out.push(process.argv[i + 1]);
	return out;
}

function main(): void {
	const runs = argList("--run");
	if (runs.length === 0) {
		console.error("give at least one --run <runId> under out/");
		process.exit(2);
	}
	const at = process.argv.indexOf("--corpus");
	const corpusPath = at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : "dev/corpus-restraint.json";
	const showAt = process.argv.indexOf("--show");
	const show = showAt >= 0 ? Number(process.argv[showAt + 1]) : 6;

	const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
		gate?: { attribution_pair?: number; empty_chunk?: number; nothing_work?: number; tool_output?: number };
		chunks: CorpusChunk[];
	};
	const gate = corpus.gate ?? {};
	const pct = (n: number, d: number) => (d === 0 ? "-" : `${Math.round((100 * n) / d)}%`);
	const cell = (ok: boolean | null) => (ok === null ? "no record" : ok ? "ok" : "FAIL");

	for (const run of runs) {
		const ledger = readFileSync(join("out", run, "ledger.jsonl"), "utf8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as LedgerRecord);
		const score = scoreRun(corpus.chunks, ledger);
		const t = totals(score);

		console.log(`\n=== ${run} — ${corpus.chunks.length} chunks, ${score.activeFacts} active facts ===`);
		console.log(
			`corpus gate: ${t.pairs} attribution pairs (need ${gate.attribution_pair ?? 0}), ${score.empties.length} nothing-durable chunks (need ${gate.empty_chunk ?? 0} empty, ${gate.nothing_work ?? 0} nothing_work), ${t.toolChunks} tool_output chunks (need ${gate.tool_output ?? 0})`,
		);

		console.log("\nattribution pairs — identical claim, only the speaker frame flips");
		console.log(
			`${"pair".padEnd(10)} ${"keep draft".padStart(12)} ${"keep bank".padStart(11)} ${"quote draft".padStart(12)} ${"quote bank".padStart(12)} ${"pair strict".padStart(12)} ${"pair attrib".padStart(12)} ${"paraphrase".padStart(11)} ${"facts".padStart(6)}`,
		);
		for (const p of score.pairs) {
			console.log(
				`${p.pair.padEnd(10)} ${cell(p.keepDrafted).padStart(12)} ${cell(p.keepBanked).padStart(11)} ${cell(p.quoteDraftStrict).padStart(12)} ${cell(p.quoteBankStrict).padStart(12)} ${cell(p.pairStrict).padStart(12)} ${cell(p.pairAttributed).padStart(12)} ${(p.paraphraseSuspects.length > 0 ? "suspect" : "-").padStart(11)} ${String(p.pairFacts).padStart(6)}`,
			);
		}

		console.log(`\n  recall (keep side in bank)      ${t.keepBanked}/${t.pairs}  ${pct(t.keepBanked, t.pairs)}`);
		console.log(
			`  restraint, strict (withheld)    ${t.restraintStrict}/${t.pairs}  ${pct(t.restraintStrict, t.pairs)}`,
		);
		console.log(
			`  quote side clean — draft gate ${t.restraintDraftStrict}/${t.pairs}  ${pct(t.restraintDraftStrict, t.pairs)}   bank gate ${t.restraintBankStrict}/${t.pairs}  ${pct(t.restraintBankStrict, t.pairs)}   (attributed-ok: draft ${t.restraintDraftAttributed}, bank ${t.restraintBankAttributed})`,
		);
		console.log(
			`  restraint, attributed-ok        ${t.restraintAttributed}/${t.pairs}  ${pct(t.restraintAttributed, t.pairs)}`,
		);
		console.log(`  pair-correct, strict            ${t.pairStrict}/${t.pairs}  ${pct(t.pairStrict, t.pairs)}`);
		console.log(
			`  pair-correct, attributed-ok     ${t.pairAttributed}/${t.pairs}  ${pct(t.pairAttributed, t.pairs)}`,
		);
		console.log(
			`  paraphrase suspects             ${t.paraphraseSuspects}/${t.pairs}  ${pct(t.paraphraseSuspects, t.pairs)}   (quote side clean by anchor, ≥3 content words shared with the keep-side fact: reported, not scored)`,
		);
		console.log(
			`  what the bank did with the pair: merged into the keep-side fact ${t.bankMerged}   quote side added a new fact ${t.bankAdded}   subject held twice ${t.bankDuplicated}`,
		);
		console.log(
			`  bank facts restating the chunk's own tool output: ${t.bankToolDerivedFacts} across ${t.pairsToolDerived}/${t.pairs} pairs — the bank gate and bank attributed-ok count these as quote-side facts about the relayed claim, which they are not: reported, never scored`,
		);
		console.log(
			`  pair-correct, attributed-ok ignoring those facts: ${t.pairsEvidenceFree}/${t.pairs}  ${pct(t.pairsEvidenceFree, t.pairs)}   (diagnostic, not a published gate: the distance from the number above is what the instrument itself created)`,
		);
		console.log(
			"  headline contract is attributed-ok; strict is kept so the external number stays comparable. Raw counts are the number — with 8 pairs the percentage is orientation, not a measurement.",
		);

		console.log('\nempty chunks — the correct output is {"drafts":[]}');
		console.log(
			`${"chunk".padEnd(20)} ${"drafts".padStart(7)} ${"rejected".padStart(9)} ${"outcome".padStart(16)} ${"in bank".padStart(8)}`,
		);
		for (const e of score.empties) {
			console.log(
				`${e.chunkId.padEnd(20)} ${(e.present ? String(e.drafts.length) : "-").padStart(7)} ${(e.present ? String(e.rejectedCount) : "-").padStart(9)} ${e.outcome.padStart(16)} ${(e.present ? String(e.inBank) : "-").padStart(8)}`,
			);
		}
		console.log(
			`\n  abstained ${t.abstained}/${score.empties.length}  ${pct(t.abstained, score.empties.length)}   code-suppressed ${t.suppressed}   intruded ${t.intruded}   dropped ${t.dropped}   facts the bank kept from empty chunks: ${t.bankFactsFromEmpty}`,
		);
		const banked = score.empties.filter((e) => e.facts.length > 0);
		if (banked.length > 0) {
			console.log(
				"\nwhat the bank kept from the chunks labelled nothing-durable — each line has to be read, not counted:",
			);
			for (const e of banked) {
				for (const f of e.facts) {
					console.log(`  ${e.chunkId.padEnd(20)} ${f.task} | ${f.statement.slice(0, 130)}`);
				}
			}
		}

		if (score.tools.length > 0) {
			console.log(
				"\ntool_output chunks — nothing decided, tool output states a fact: keeping the fact is the defensible call, keeping the chatter is the failure the v1 label hid",
			);
			console.log(
				`${"chunk".padEnd(20)} ${"drafts".padStart(7)} ${"rejected".padStart(9)} ${"outcome".padStart(16)} ${"facts".padStart(6)} ${"own".padStart(5)} ${"probe".padStart(6)} ${"chatter".padStart(8)}`,
			);
			for (const c of score.tools) {
				console.log(
					`${c.chunkId.padEnd(20)} ${(c.present ? String(c.drafts.length) : "-").padStart(7)} ${(c.present ? String(c.rejectedCount) : "-").padStart(9)} ${c.outcome.padStart(16)} ${String(c.facts.length).padStart(6)} ${String(c.facts.length - c.factsCarriedIn).padStart(5)} ${String(c.facts.filter((f) => f.probe).length).padStart(6)} ${String(c.facts.filter((f) => f.chatter).length).padStart(8)}`,
				);
			}
			console.log(
				`\n  kept the declared tool fact ${t.toolFactKept}/${t.toolChunks}  ${pct(t.toolFactKept, t.toolChunks)}   kept it and nothing else ${t.toolFactsOnly}/${t.toolChunks}  ${pct(t.toolFactsOnly, t.toolChunks)}   fact and chatter ${t.toolBothKept}   chatter only ${t.toolChatterKept}   something else ${t.toolOtherKept}   drafted but not banked ${t.toolNotBanked}   abstained ${t.toolAbstained}   facts banked from these chunks: ${t.toolFactsBanked}`,
			);
			console.log(
				`  same declared value banked more than once from one chunk: ${t.toolValueDupChunks}/${t.toolChunks} chunks, ${t.toolValueDupFacts} repeat facts   reported beside "kept it and nothing else", never inside it: a restatement carries the value too, so the column above cannot see it`,
			);
			console.log(
				`  banked exactly one fact, and it carried the value: ${t.toolSingleCleanChunks}/${t.toolChunks} chunks  ${pct(t.toolSingleCleanChunks, t.toolChunks)}   facts this chunk authored: ${t.toolFactsBanked - t.toolFactsCarriedIn}, carried in by a later merge: ${t.toolFactsCarriedIn}   narration facts this chunk banked beside a value: ${t.toolNarrationFacts}   narrower than the stricter reading above: one fact can carry the value and the chatter at once`,
			);
			console.log(
				`  declared values counted per value and not per chunk: ${t.toolProbesKept}/${t.toolProbesDeclared} survived the bank; chunks that lost at least one declared value: ${t.toolChunksLostValue}/${t.toolChunks}`,
			);
			console.log(
				`  declared rule text beside tool output: ${t.toolConstraintsKept}/${t.toolConstraintsDeclared} kept verbatim in a bank fact, ${t.toolConstraintsRestated} present only as a rearrangement of its content words, ${t.toolConstraintsLost} reaching no bank fact at all, over ${t.toolConstraintChunks}/${t.toolChunks} chunks. A keep here means the rule's wording sits in a banked fact, not that the rule was obeyed; and a bank fact whose only tie to the chunk is such a rule — ${t.toolFactsConstraint} of them — is the case where the rule text survived and the tool fact did not, which the outcome column can only read as kept-other.`,
			);
			console.log(
				`  hidden-value carry — tokens no chunk in the corpus shows: ${t.toolHiddenChunks}/${t.toolChunks} chunks hold a value past the argument window; ${t.toolHiddenSurvivalFacts} banked facts and ${t.toolHiddenDraftFacts} drafts carry one of its unread tokens.`,
			);
			console.log(
				`  The reading is supplied-not-read for those tokens only: a flag name or a number that any chunk prints is dropped from the count, the corpus check rejects a hidden value whose every token is visible somewhere, and a value carried from a later chunk is not this chunk's. The two halves say different things — no draft and no fact means the value never reached the model's pen, while a draft with no surviving fact would mean the bank refused a value the writer had read.`,
			);
			console.log(
				`  possible chatter paraphrase: ${t.toolChatterParaphraseFacts} banked facts hold a declared chatter phrase's content words without quoting it. Word matching, not understanding: a synonym substitution slips past this and a shared technical noun can over-count it, and it is the hole the 2026-10-22 label audit found that literal chatter matching could not see.`,
			);
			console.log(
				`  actor-frame wording — a statement opening with a person or with the agent's own voice: ${t.toolActorFramedAuthored}/${t.toolFactsAuthored} facts authored in these chunks, ${t.bankActorFramedFacts}/${t.bankFacts} across the whole active bank. Wording-shaped floor, reported, never scored: it reads how a statement opens, so a person-framed clause buried mid-sentence passes it.`,
			);
			console.log("\nwhat each tool_output chunk kept:");
			for (const c of score.tools) {
				for (const f of c.facts) {
					const tag = !f.authoredHere
						? "carried-in"
						: f.probe
							? f.repeat
								? "repeat"
								: "tool fact"
							: f.chatter
								? "chatter"
								: f.chatterParaphrase
									? "chatter~"
									: f.constraint
										? "rule"
										: "neither";
					const marker = [
						f.actorFramed ? "[person or agent as subject]" : "",
						f.hidden ? "[carries a value the session never showed]" : "",
						f.chatterParaphrase ? "[holds a declared chatter phrase's content words]" : "",
					]
						.filter(Boolean)
						.join("  ");
					console.log(
						`  ${c.chunkId.padEnd(20)} ${tag.padEnd(9)} ${f.task} | ${f.statement.slice(0, 120)}${marker}`,
					);
				}
				if (c.probesLost.length > 0)
					console.log(
						`  ${c.chunkId.padEnd(20)} ${"lost values".padEnd(9)} ${c.probesLost.join(", ")}   declared values this chunk banked and the bank did not keep`,
					);
				if (c.constraints.length > 0)
					console.log(
						`  ${c.chunkId.padEnd(20)} ${"rules".padEnd(9)} kept in the user's own words ${c.constraintsKept.length}/${c.constraints.length}${
							c.constraintsRestated.length > 0
								? `   wording-only restatement: ${c.constraintsRestated.length}`
								: ""
						}${
							c.constraintsLost.length > 0
								? `   no bank fact carries them: ${c.constraintsLost.join(", ")}`
								: ""
						}`,
					);
				for (const s of c.hiddenSurvivals)
					console.log(
						`  ${c.chunkId.padEnd(20)} ${"supplied".padEnd(9)} ${s.token.padEnd(18)} ${s.statement.slice(0, 110)}   the chunk never shows this token, so this fact did not read it`,
					);
				if (c.crossSession !== null) {
					const other = score.tools.find((t) => t.chunkId === c.crossSession);
					console.log(
						`  ${c.chunkId.padEnd(20)} ${"cross-sess".padEnd(9)} ${c.crossSession}   another session restates this subject${
							other
								? ` with its own value ${other.probes.join(", ")}: this chunk kept ${
										c.probesKept.join(", ") || "nothing"
									}, that one kept ${other.probesKept.join(", ") || "nothing"}`
								: ""
						}. Which fact superseded which is the session-scope instrument's reading, not this one's.`,
					);
				}
			}
		}

		const opLine = [...score.opTotals.entries()].map(([action, n]) => `${action} ${n}`).join("  ") || "none";
		console.log(`\nops across the run: ${opLine}`);
		if ((score.opTotals.get("SKIP") ?? 0) === 0) {
			console.log("SKIP was never used: the withhold vocabulary exists and the writer did not reach for it.");
		}

		const notes: string[] = [];
		for (const p of score.pairs) {
			if (p.quoteDraftStrict === false) {
				for (const d of p.quoteCarrying) {
					const named = namesMarker(p.marker, d);
					notes.push(
						`${p.quoteChunk}: carried "${p.anchors.join(", ")}" at the draft gate${
							named
								? ` naming ${p.marker} (strict counts it, attributed-ok does not)`
								: `${d.fromUser ? " unattributed, and fromUser=true — the pipeline read it as the user's own statement" : " unattributed"}`
						}: "${d.statement.slice(0, 150)}"`,
					);
				}
			}
			for (const e of p.quoteBankCarrying) {
				const named = namesMarker(p.marker, { task: "", statement: e.statement, keys: [] });
				notes.push(
					`${p.quoteChunk}: the claim reached the bank ${e.merged ? "merged into the keep-side fact" : "as a new fact"} ${named ? `naming ${p.marker}` : "unattributed"}${e.toolDerived ? " and restating this chunk's own tool output" : ""} (${e.id}): "${e.statement.slice(0, 150)}"`,
				);
			}
			if (p.keepBanked === false) {
				notes.push(
					p.keepDrafted
						? `${p.keepChunk}: drafted and then lost at reconcile — the bank holds no anchor`
						: `${p.keepChunk}: the user-stated claim was never proposed at all`,
				);
			}
			for (const s of p.paraphraseSuspects) {
				notes.push(
					`${p.quoteChunk}: scored clean at the ${s.where} gate by anchor, but "${s.text.slice(0, 120)}" shares ${s.shared.length} content words (${s.shared.slice(0, 6).join(", ")}) with the keep-side fact — a paraphrase would score as restraint here`,
				);
			}
		}
		for (const e of score.empties) {
			if (e.outcome === "dropped")
				notes.push(`${e.chunkId}: no hy.extract record — a dropped chunk is not abstention`);
			for (const d of e.drafts)
				notes.push(`${e.chunkId}: proposed "${d.statement.slice(0, 150)}" on a chunk with nothing durable`);
		}
		for (const c of score.tools) {
			for (const f of c.facts) {
				if (f.chatter)
					notes.push(
						`${c.chunkId}: banked "${f.statement.slice(0, 150)}" carrying the declared chatter "${f.chatter}"`,
					);
				if (!f.probe && !f.chatter)
					notes.push(
						`${c.chunkId}: banked "${f.statement.slice(0, 150)}" carrying neither the declared tool fact nor the declared chatter`,
					);
			}
			if (c.outcome === "abstained")
				notes.push(
					`${c.chunkId}: withheld on a chunk whose tool output states a fact — reported as a judgment, not scored either way`,
				);
		}
		if (notes.length > 0) {
			console.log(`\nfailures, in corpus order (first ${show}):`);
			for (const line of notes.slice(0, show)) console.log(`  ${line}`);
		}
	}
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
