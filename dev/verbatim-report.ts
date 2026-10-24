#!/usr/bin/env npx tsx
/**
 * dev/verbatim-report.ts — tier 1 of plan-divergence.md, offline.
 *
 * The claim under test is TODO 7.18's structural option: values leave the bank because the model had
 * to re-say them. Upstream's answer is a verbatim surface — text copied from uncompressed messages by
 * code, never by model transcription. Before choosing it, measure whether a verbatim copy would even
 * have saved the values this repo has already watched a merge destroy.
 *
 * No model call, no new corpus, no src/ change. It reuses the merge audit's own rows
 * (dev/merge-report.ts) to find every corpus-declared value an accepted merge dropped, then looks for
 * that value in the verbatim text of the chunk that authored the entry the merge replaced — which is
 * exactly what a verbatim surface would have held.
 *
 * Matching rules, fixed here so they cannot be softened after the fact. Three normalisations, and only
 * three: collapse whitespace runs; unify typographic dashes, hyphens and minus signs with ASCII '-';
 * strip markdown emphasis and code-span markers ('*', '`'). Underscores inside identifiers survive,
 * because MAX_RETRY is a value and emphasis is not. Then:
 *
 *   recoverable  the value passes carries()'s own token-boundary rule, the rule
 *                dev/restraint-report.ts already uses for "this fact carries this value", so 4096
 *                inside 14096 is not a hit and --dry-run inside --dry-run-all is not a hit.
 *   false-hit    naive substring search says present and the boundary rule says no. This column exists
 *                because it is what a careless reading of a verbatim surface would report as recovery.
 *   absent       the value's characters are not in the source text at all, so a verbatim surface
 *                preserves nothing.
 *
 * Every row prints the source text around the match. That is the precision sample: the hits are meant
 * to be read, not counted. A value that survives only as a paraphrase is not scored as recovery.
 *
 * Recoverability alone is not a decision, so the report also measures today's dependency: for each
 * declared value still active in the bank, does the entry holding it still carry its source's wording
 * — a run of four or more consecutive words shared with the chunk that authored it — or does the value
 * exist only as model restatement? And it prices the surface in tokens with the shipped
 * estimateTokens(): what storing the source chunks behind the lost values would add, against what the
 * active bank costs now.
 *
 * Usage: npx tsx dev/verbatim-report.ts [--run <runId>] [--corpus <file>] [--all]
 */

import { existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { foldLedger } from "../src/bank.js";
import type { LedgerRecord } from "../src/types.js";
import { estimateTokens } from "../src/types.js";
import { analyseRecords, loadLedger, resolveCorpus, textOf } from "./merge-report.js";
import { type CorpusChunk, carries } from "./restraint-report.js";

const RUNS_ROOT = "out";

export interface RecoverabilityRow {
	run: string;
	/** the chunk whose merge dropped the value. */
	chunkId: string;
	/** the chunk that authored the entry the merge replaced: where a verbatim copy would live. */
	sourceChunk: string;
	targetTask: string;
	value: string;
	verdict: "recoverable" | "false-hit" | "absent";
	/** naive substring present, whether or not the boundary rule agrees. */
	naive: boolean;
	/**
	 * Which lines of the chunk hold it. "tool output" is what the machine wrote; "spoken line" is what
	 * a person or the assistant said. A verbatim surface stores both, and they are not the same
	 * evidence: a value recoverable only from a spoken line was recovered from an earlier wording, not
	 * from the source that produced it.
	 */
	foundIn: "tool output" | "spoken line" | "both" | "nowhere";
	/** source text around the match, for the precision sample. */
	window: string;
	/** did the value reach the end of the run in any active fact, by any route? */
	survived: boolean;
}

export interface DependencyRow {
	run: string;
	value: string;
	entryId: string;
	entryTask: string;
	sourceChunk: string;
	/** longest run of consecutive words shared with the source chunk text. */
	sharedWords: number;
	/** this instrument's threshold: four shared words reads as "still carries source wording". */
	quotesSource: boolean;
}

export interface VerbatimAnalysis {
	run: string;
	corpus: string;
	rows: RecoverabilityRow[];
	dependencies: DependencyRow[];
	/** tokens a verbatim surface would add for the chunks behind this run's lost values. */
	verbatimTokens: number;
	/**
	 * The same price if the surface is applied the way upstream applies it — one verbatim block per
	 * stored entry, deduplicated by source chunk — which is the number a storage change would actually
	 * have to be judged against.
	 */
	storeAllTokens: number;
	/** tokens of the active bank today, same run. */
	bankTokens: number;
	/** chunks the corpus gives no verbatim text for — organic captures, mostly. */
	missingText: string[];
}

export function normalise(text: string): string {
	return text
		.replace(/[\u2010-\u2015\u2212]/g, "-")
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201c\u201d]/g, '"')
		.replace(/[*`]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function windowAround(text: string, needle: string, width = 90): string {
	const at = text.toLowerCase().indexOf(needle.toLowerCase());
	if (at < 0) return "(no occurrence)";
	const from = Math.max(0, at - width);
	const to = Math.min(text.length, at + needle.length + width);
	return `${from > 0 ? "\u2026" : ""}${text.slice(from, to).trim()}${to < text.length ? "\u2026" : ""}`;
}

const TOOL_LINE = /^\s*\[\d+\]\s+\[Tool result for\b/;

/** Where in the chunk the value's own text appears: the machine's lines, the spoken lines, both. */
export function whereFound(value: string, rawText: string): RecoverabilityRow["foundIn"] {
	const needle = normalise(value);
	let tool = false;
	let spoken = false;
	for (const line of rawText.split("\n")) {
		if (!carries(needle, normalise(line))) continue;
		if (TOOL_LINE.test(line)) tool = true;
		else spoken = true;
	}
	if (tool && spoken) return "both";
	if (tool) return "tool output";
	if (spoken) return "spoken line";
	return "nowhere";
}

/** One value against one chunk's verbatim text. Exported so the fixture can test the rules directly. */
export function recoverability(
	value: string,
	rawText: string,
): {
	verdict: RecoverabilityRow["verdict"];
	naive: boolean;
	window: string;
	foundIn: RecoverabilityRow["foundIn"];
} {
	// The value gets the same normalisation as the text: a flag written with a typographic dash in the
	// source and two ASCII dashes in the probe list is the same spelling once both sides are normalised.
	// A value whose dashes differ in *count* is not the same spelling, and is reported as a false hit.
	const text = normalise(rawText);
	const needle = normalise(value);
	const foundIn = whereFound(value, rawText);
	if (carries(needle, text)) {
		return { verdict: "recoverable", naive: true, window: windowAround(text, needle), foundIn };
	}
	if (text.toLowerCase().includes(needle.toLowerCase())) {
		return { verdict: "false-hit", naive: true, window: windowAround(text, needle), foundIn };
	}
	// The source may have written the value in another shape: strip a leading flag dash or a file
	// extension and try again. Reported as a false hit, because a verbatim surface stores what the
	// source actually wrote, not what this value was spelled as.
	const core = needle.replace(/^-+/, "").replace(/\.[a-z][a-z0-9]*$/i, "");
	if (core.length > 2 && core !== needle && text.toLowerCase().includes(core.toLowerCase())) {
		return { verdict: "false-hit", naive: true, window: windowAround(text, core), foundIn };
	}
	return { verdict: "absent", naive: false, window: "(no occurrence)", foundIn: "nowhere" };
}

/** Longest run of consecutive words shared by two texts: does the entry still carry source wording? */
export function sharedWordRun(a: string, b: string): number {
	const wa = normalise(a).toLowerCase().split(/\s+/).filter(Boolean);
	const wb = normalise(b).toLowerCase().split(/\s+/).filter(Boolean);
	let best = 0;
	for (let i = 0; i < wa.length; i++) {
		for (let j = 0; j < wb.length; j++) {
			let k = 0;
			while (i + k < wa.length && j + k < wb.length && wa[i + k] === wb[j + k]) k++;
			if (k > best) best = k;
		}
	}
	return best;
}

export function analyseVerbatim(
	runId: string,
	records: LedgerRecord[],
	chunks: CorpusChunk[],
	corpusLabel: string,
): VerbatimAnalysis {
	const analysis = analyseRecords(runId, records, chunks, corpusLabel);
	const chunkById = new Map(chunks.map((c) => [c.chunkId, c]));
	const finalBank = foldLedger(records).filter((e) => e.status === "active");

	const rows: RecoverabilityRow[] = [];
	const missingText: string[] = [];
	const hosts = new Set<string>();
	const seen = new Set<string>();

	for (const merge of analysis.executed) {
		for (const value of merge.declaredDropped) {
			const key = `${merge.chunkId}|${merge.targetChunk}|${value}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const source = chunkById.get(merge.targetChunk);
			if (!source?.text) {
				missingText.push(`${merge.targetChunk} (value ${value})`);
				continue;
			}
			const verdict = recoverability(value, source.text);
			hosts.add(merge.targetChunk);
			rows.push({
				run: runId,
				chunkId: merge.chunkId,
				sourceChunk: merge.targetChunk,
				targetTask: merge.targetTask,
				value: normalise(value),
				verdict: verdict.verdict,
				naive: verdict.naive,
				foundIn: verdict.foundIn,
				window: verdict.window,
				survived: finalBank.some((e) => carries(normalise(value), textOf(e))),
			});
		}
	}

	// Today's dependency: every declared value still active in the bank, and how its carrier holds it.
	const dependencies: DependencyRow[] = [];
	const counted = new Set<string>();
	for (const entry of finalBank) {
		const source = chunkById.get(entry.chunkId);
		if (!source?.text) continue;
		for (const value of source.probes ?? []) {
			if (!carries(normalise(value), textOf(entry))) continue;
			const key = `${entry.id}|${value}`;
			if (counted.has(key)) continue;
			counted.add(key);
			const sharedWords = sharedWordRun(textOf(entry), source.text);
			dependencies.push({
				run: runId,
				value,
				entryId: entry.id,
				entryTask: entry.task,
				sourceChunk: entry.chunkId,
				sharedWords,
				quotesSource: sharedWords >= 4,
			});
		}
	}

	const verbatimTokens = [...hosts].reduce(
		(sum, id) => sum + estimateTokens(normalise(chunkById.get(id)?.text ?? "")),
		0,
	);
	const hostsForEverything = new Set<string>();
	for (const entry of finalBank) {
		if (chunkById.get(entry.chunkId)?.text) hostsForEverything.add(entry.chunkId);
	}
	const storeAllTokens = [...hostsForEverything].reduce(
		(sum, id) => sum + estimateTokens(normalise(chunkById.get(id)?.text ?? "")),
		0,
	);

	return {
		run: runId,
		corpus: corpusLabel,
		rows,
		dependencies,
		verbatimTokens,
		storeAllTokens,
		bankTokens: finalBank.reduce((sum, e) => sum + (e.tokenCount ?? estimateTokens(e.statement)), 0),
		missingText,
	};
}

function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function report(a: VerbatimAnalysis): void {
	console.log(`\n== ${a.run}  (${a.corpus})`);
	if (a.rows.length === 0) {
		console.log("   no corpus-declared value was dropped by an accepted merge in this run");
	}
	const counts = { recoverable: 0, "false-hit": 0, absent: 0 } as Record<RecoverabilityRow["verdict"], number>;
	for (const row of a.rows) {
		counts[row.verdict]++;
		console.log(
			`   ${pad(row.value, 22)} ${pad(row.verdict, 12)} ${pad(row.foundIn, 12)} authored by` +
				` ${pad(row.sourceChunk, 16)} merged at ${pad(row.chunkId, 16)}` +
				` ${row.survived ? "survived the run anyway" : "gone from the final bank"}`,
		);
	}
	for (const row of a.rows) {
		console.log(`      ${pad(row.value, 22)} source text: ${row.window}`);
	}
	const naiveClaims = a.rows.filter((r) => r.naive).length;
	const held = a.rows.filter((r) => r.verdict === "recoverable");
	const fromTool = held.filter((r) => r.foundIn === "tool output" || r.foundIn === "both").length;
	const fromSpeech = held.filter((r) => r.foundIn === "spoken line").length;
	console.log(
		`   verdicts: recoverable ${counts.recoverable}, false-hit ${counts["false-hit"]}, absent ${counts.absent}` +
			`  — a naive substring search would have claimed ${naiveClaims} of ${a.rows.length} recoverable`,
	);
	console.log(
		`   of what a verbatim copy would hold: ${fromTool} in the tool output itself,` +
			` ${fromSpeech} only in a spoken line — recovered from an earlier wording, not from its source`,
	);
	if (a.missingText.length > 0) console.log(`   no verbatim text available for: ${a.missingText.join(", ")}`);

	const quoting = a.dependencies.filter((d) => d.quotesSource).length;
	console.log(
		`   surviving declared values ${a.dependencies.length}: ${quoting} still carry source wording` +
			` (4+ consecutive words), ${a.dependencies.length - quoting} exist only as model restatement`,
	);
	for (const d of a.dependencies.filter((x) => !x.quotesSource)) {
		console.log(`      ${pad(d.value, 22)} ${pad(d.entryTask.slice(0, 44), 44)} shared words ${d.sharedWords}`);
	}
	console.log(
		`   priced: only the chunks behind this run's lost values = ${a.verbatimTokens} tokens;` +
			` every stored entry's source chunk = ${a.storeAllTokens} tokens;` +
			` the active bank today = ${a.bankTokens} tokens`,
	);
}

function main(): void {
	const argv = process.argv.slice(2);
	const arg = (name: string): string | undefined => {
		const at = argv.indexOf(name);
		return at >= 0 ? argv[at + 1] : undefined;
	};
	const explicit = arg("--run");
	const corpus = arg("--corpus");
	const all = argv.includes("--all");
	const discovered = discoverRuns();
	const runs = explicit ? [explicit] : all ? discovered : discovered.filter((r) => r.startsWith("restraint"));
	if (runs.length === 0) {
		console.error("no ledgers under out/ — give --run <runId>");
		process.exit(2);
	}

	const total = { recoverable: 0, "false-hit": 0, absent: 0, rows: 0, fromTool: 0, fromSpeech: 0 };
	const dep = { quoting: 0, restatement: 0 };
	let verbatim = 0;
	let storeAll = 0;
	let bank = 0;
	for (const run of runs) {
		const { path, chunks } = resolveCorpus(run, corpus);
		const a = analyseVerbatim(run, loadLedger(run), chunks, path);
		report(a);
		for (const row of a.rows) {
			total[row.verdict]++;
			if (row.verdict !== "recoverable") continue;
			if (row.foundIn === "spoken line") total.fromSpeech++;
			else total.fromTool++;
		}
		total.rows += a.rows.length;
		dep.quoting += a.dependencies.filter((d) => d.quotesSource).length;
		dep.restatement += a.dependencies.filter((d) => !d.quotesSource).length;
		verbatim += a.verbatimTokens;
		storeAll += a.storeAllTokens;
		bank += a.bankTokens;
	}

	console.log(`\n== ${runs.length} runs together`);
	console.log(
		`   corpus-declared values an accepted merge destroyed: ${total.rows} — recoverable` +
			` ${total.recoverable}, false-hit ${total["false-hit"]}, absent ${total.absent}`,
	);
	console.log(
		`   surviving declared values ${dep.quoting + dep.restatement}: ${dep.quoting} still carry source` +
			` wording, ${dep.restatement} survive only as model restatement`,
	);
	console.log(
		`   of the recoverable ones: ${total.fromTool} appear in tool output, ${total.fromSpeech} only in a` +
			" spoken line",
	);
	console.log(
		`   price: ${verbatim} tokens behind just the lost values, ${storeAll} behind every stored entry,` +
			` ${bank} tokens of active bank today`,
	);
	if (total.rows > 0 && total.recoverable < (2 * total.rows) / 3) {
		console.log(
			"   stop rule (plan-divergence.md tier 1): under two thirds recoverable verbatim, so the" +
				" structural option loses its main argument and tier 2 is the only priced fix left.",
		);
	}
	console.log(
		"   reported, not gated: recoverability says a verbatim copy would have held the text. It says" +
			" nothing about attaching such a field to drafts or ops, whether it is searchable, whether it" +
			" is ever fed back to the writer, or whether four shared words is the right line for" +
			' "still carries source wording".',
	);
}

function discoverRuns(): string[] {
	return readdirSync(RUNS_ROOT, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(`${RUNS_ROOT}/${d.name}/ledger.jsonl`))
		.map((d) => d.name);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
