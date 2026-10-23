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
	class: "attribution" | "empty";
	pair?: string;
	side?: "keep" | "quote";
	anchors?: string[];
	marker?: string;
	claim?: string;
	why?: string;
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
	quoteBankCarrying: { id: string; statement: string; fromUser: boolean; merged: boolean }[];
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

export interface RunScore {
	pairs: PairRow[];
	empties: EmptyRow[];
	activeFacts: number;
	opTotals: Map<string, number>;
}

/** Split-chunk arms write `hy-…-001.1` and `…001.2` over one corpus chunk: fold them together. */
const base = (chunkId: string): string => chunkId.replace(/\.\d+$/, "");

/** A claim survives paraphrase as a token, not as a sentence: match the anchor as a word. */
export function carries(anchor: string, text: string): boolean {
	return new RegExp(`\\b${anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
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
	for (const chunk of chunks) {
		if (chunk.class === "empty") {
			empties.push(chunk);
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
		// Two different things a quote-side fact can be. Merging into the keep-side fact is reconcile
		// doing its job on a restatement; adding a second active fact about the same subject is the
		// duplication restraint is meant to prevent. Scoring them together hid which one happened.
		const quoteBankCarrying = quoteFacts.map((e) => ({
			id: e.id,
			statement: e.statement,
			fromUser: e.fromUser === true,
			merged: chainChunks(e).includes(base(keep.chunkId)),
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
			quoteMerged,
			quoteAdded,
			pairFacts: pairFacts.length,
			bankDuplicated: pairFacts.length >= 2,
			quoteBankStrict,
			quoteBankAttributed,
			pairStrict: Boolean(keepBanked) && quoteDraftStrict === true && quoteBankStrict,
			pairAttributed: Boolean(keepBanked) && quoteDraftAttributed === true && quoteBankAttributed,
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

	return { pairs: pairRows, empties: emptyRows, activeFacts: bank.length, opTotals };
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
	abstained: number;
	suppressed: number;
	intruded: number;
	dropped: number;
	bankFactsFromEmpty: number;
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
		abstained: score.empties.filter((e) => e.outcome === "abstained").length,
		suppressed: score.empties.filter((e) => e.outcome === "code-suppressed").length,
		intruded: score.empties.filter((e) => e.outcome === "intruded").length,
		dropped: score.empties.filter((e) => e.outcome === "dropped").length,
		bankFactsFromEmpty: score.empties.reduce((n, e) => n + e.inBank, 0),
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
		gate?: { attribution_pair?: number; empty_chunk?: number };
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
			`corpus gate: ${t.pairs} attribution pairs (need ${gate.attribution_pair ?? 0}), ${score.empties.length} empty chunks (need ${gate.empty_chunk ?? 0})`,
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
					`${p.quoteChunk}: the claim reached the bank ${e.merged ? "merged into the keep-side fact" : "as a new fact"} ${named ? `naming ${p.marker}` : "unattributed"} (${e.id}): "${e.statement.slice(0, 150)}"`,
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
		if (notes.length > 0) {
			console.log(`\nfailures, in corpus order (first ${show}):`);
			for (const line of notes.slice(0, show)) console.log(`  ${line}`);
		}
	}
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
