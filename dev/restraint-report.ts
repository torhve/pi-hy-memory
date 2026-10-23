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
	facts: { task: string; statement: string; probe: string | null; chatter: string | null }[];
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
	opTotals: Map<string, number>;
}

/** Split-chunk arms write `hy-…-001.1` and `…001.2` over one corpus chunk: fold them together. */
const base = (chunkId: string): string => chunkId.replace(/\.\d+$/, "");

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

	const toolRows: ToolRow[] = toolChunks.map((chunk) => {
		const ev = evidence.get(base(chunk.chunkId));
		const probes = chunk.probes ?? [];
		const chatter = chunk.transient ?? [];
		const facts = bank
			.filter((e) => chainChunks(e).includes(base(chunk.chunkId)))
			.map((e) => {
				const text = textOf({ task: e.task, statement: e.statement, keys: e.keys });
				return {
					task: e.task,
					statement: e.statement,
					probe: probes.find((p) => carries(p, text)) ?? null,
					chatter: chatter.find((c) => carries(c, text)) ?? null,
				};
			});
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
			outcome,
		};
	});

	return { pairs: pairRows, empties: emptyRows, tools: toolRows, activeFacts: bank.length, opTotals };
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
				`${"chunk".padEnd(20)} ${"drafts".padStart(7)} ${"rejected".padStart(9)} ${"outcome".padStart(16)} ${"facts".padStart(6)} ${"probe".padStart(6)} ${"chatter".padStart(8)}`,
			);
			for (const c of score.tools) {
				console.log(
					`${c.chunkId.padEnd(20)} ${(c.present ? String(c.drafts.length) : "-").padStart(7)} ${(c.present ? String(c.rejectedCount) : "-").padStart(9)} ${c.outcome.padStart(16)} ${String(c.facts.length).padStart(6)} ${String(c.facts.filter((f) => f.probe).length).padStart(6)} ${String(c.facts.filter((f) => f.chatter).length).padStart(8)}`,
				);
			}
			console.log(
				`\n  kept the declared tool fact ${t.toolFactKept}/${t.toolChunks}  ${pct(t.toolFactKept, t.toolChunks)}   kept it and nothing else ${t.toolFactsOnly}/${t.toolChunks}  ${pct(t.toolFactsOnly, t.toolChunks)}   fact and chatter ${t.toolBothKept}   chatter only ${t.toolChatterKept}   something else ${t.toolOtherKept}   drafted but not banked ${t.toolNotBanked}   abstained ${t.toolAbstained}   facts banked from these chunks: ${t.toolFactsBanked}`,
			);
			console.log("\nwhat each tool_output chunk kept:");
			for (const c of score.tools) {
				for (const f of c.facts) {
					const tag = f.probe ? "tool fact" : f.chatter ? "chatter" : "neither";
					console.log(`  ${c.chunkId.padEnd(20)} ${tag.padEnd(9)} ${f.task} | ${f.statement.slice(0, 120)}`);
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
