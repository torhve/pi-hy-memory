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
	quoteBankCarrying: { id: string; statement: string; fromUser: boolean }[];
	quoteBankStrict: boolean;
	quoteBankAttributed: boolean;
	pairStrict: boolean;
	pairAttributed: boolean;
}

export interface EmptyRow {
	chunkId: string;
	why: string;
	present: boolean;
	drafts: DraftRow[];
	rejectedCount: number;
	outcome: "abstained" | "code-suppressed" | "intruded" | "dropped";
	inBank: number;
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

	const bank = foldLedger(ledger).filter((entry) => entry.status === "active");
	const bankByChunk = new Map<string, BankEntry[]>();
	for (const entry of bank) {
		const key = base(entry.chunkId);
		bankByChunk.set(key, [...(bankByChunk.get(key) ?? []), entry]);
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
		const keepBanked = keepEv?.present
			? (bankByChunk.get(base(keep.chunkId)) ?? []).some((e) => anchors.some((a) => carries(a, textOf(e))))
			: null;

		const quoteCarrying = quoteEv?.present
			? quoteEv.drafts.filter((d) => anchors.some((a) => carries(a, textOf(d))))
			: [];
		const quoteBankCarrying = (bankByChunk.get(base(quote.chunkId)) ?? [])
			.filter((e) => anchors.some((a) => carries(a, textOf(e))))
			.map((e) => ({ id: e.id, statement: e.statement, fromUser: e.fromUser === true }));

		const quoteDraftStrict = quoteEv?.present ? quoteCarrying.length === 0 : null;
		const quoteDraftAttributed = quoteEv?.present
			? quoteCarrying.length === 0 || quoteCarrying.some((d) => namesMarker(marker, d))
			: null;
		const quoteBankStrict = quoteBankCarrying.length === 0;
		const quoteBankAttributed = quoteBankCarrying.every((e) =>
			namesMarker(marker, { task: "", statement: e.statement, keys: [] }),
		);

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
			quoteBankStrict,
			quoteBankAttributed,
			pairStrict: Boolean(keepBanked) && quoteDraftStrict === true && quoteBankStrict,
			pairAttributed: Boolean(keepBanked) && quoteDraftAttributed === true && quoteBankAttributed,
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
			`${"pair".padEnd(10)} ${"keep draft".padStart(12)} ${"keep bank".padStart(11)} ${"quote draft".padStart(12)} ${"quote bank".padStart(12)} ${"pair strict".padStart(12)} ${"pair attrib".padStart(12)}`,
		);
		for (const p of score.pairs) {
			console.log(
				`${p.pair.padEnd(10)} ${cell(p.keepDrafted).padStart(12)} ${cell(p.keepBanked).padStart(11)} ${cell(p.quoteDraftStrict).padStart(12)} ${cell(p.quoteBankStrict).padStart(12)} ${cell(p.pairStrict).padStart(12)} ${cell(p.pairAttributed).padStart(12)}`,
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
					`${p.quoteChunk}: the claim reached the bank ${named ? `naming ${p.marker}` : "unattributed"} (${e.id}): "${e.statement.slice(0, 150)}"`,
				);
			}
			if (p.keepBanked === false) {
				notes.push(
					p.keepDrafted
						? `${p.keepChunk}: drafted and then lost at reconcile — the bank holds no anchor`
						: `${p.keepChunk}: the user-stated claim was never proposed at all`,
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
