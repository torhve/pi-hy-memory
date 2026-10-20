/**
 * Chunk-size arm: does one 24 k-token extract find the same facts as five 5 k ones?
 *
 * The paper (arXiv 2610.22196) trains the writer on chunks of "about ten turns"
 * with a 4 096-token OPD prompt budget, and its own annotation study found that
 * *less* context produces more specific facts (two-chunk context: +25 % proper
 * nouns, +59 % numbers per fact versus full history). Our captures carry ~10 turns
 * but 13–24 k prompt tokens, so this arm measures the one axis where the shipped
 * default may sit outside the training distribution.
 *
 * It is an extract-only arm on purpose: reconcile is a separate question, and the
 * bank is not needed to compare what the writer *saw*.
 *
 *   npx tsx dev/split-chunk.ts --capture captures-dev/<session>/hy-<id>.json --target 4500
 *
 * Writes `out/chunk-size/<chunkId>.json` with both arms' drafts and the metrics, and
 * prints the table that goes into EXPERIMENTS.md.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { completeWithFallback, type Writer } from "../src/llm.js";
import { EXTRACT_SYSTEM } from "../src/prompts.js";
import { parseDrafts } from "../src/protocol.js";
import type { SerializedChunk } from "../src/serialize.js";
import type { CallUsage, Draft } from "../src/types.js";
import { estimateTokens } from "../src/types.js";
import { rawWriter } from "./raw-writer.js";
import { resolveRoute } from "./run.js";

const arg = (flag: string, fallback: string): string => {
	const at = process.argv.indexOf(flag);
	return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};

/** Split a serialized chunk at entry boundaries into windows of ~`target` tokens. */
export function splitChunk(chunk: SerializedChunk, target: number): SerializedChunk[] {
	const lines = chunk.text.split("\n");
	const windows: SerializedChunk[] = [];
	let current: { line: string; ref: string }[] = [];
	let tokens = 0;
	const flush = (): void => {
		if (current.length === 0) return;
		const refs = current.map((c) => c.ref);
		windows.push({
			text: current.map((c, i) => c.line.replace(/^\[\d+\]/, `[${i}]`)).join("\n"),
			refs,
			entryCount: refs.length,
		});
		current = [];
		tokens = 0;
	};
	for (const line of lines) {
		const match = /^\[(\d+)\]/.exec(line);
		if (!match) continue;
		const ref = chunk.refs[Number(match[1])];
		if (!ref) continue;
		const cost = estimateTokens(line);
		// Close the window when adding this line would pass the target, unless the
		// window is empty (one line is always allowed to exceed it).
		if (current.length > 0 && tokens + cost > target) flush();
		current.push({ line, ref });
		tokens += cost;
	}
	flush();
	return windows;
}

const ANCHOR =
	/(`[^`]+`|\b[A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+|\b[A-Z][a-z0-9]+[A-Za-z0-9_]*\b|\b\d+(?:[.:]\d+)*\b|--?[a-z][a-z0-9-]+)/g;
const NUMBER = /\b\d+(?:[.:]\d+)*\b/g;

/** Specificity, measured per fact: concrete anchors (paths, identifiers, flags, numbers). */
export function specificity(drafts: Draft[]): {
	facts: number;
	anchorsPerFact: number;
	numbersPerFact: number;
	genericRate: number;
} {
	let anchors = 0;
	let numbers = 0;
	let generic = 0;
	for (const draft of drafts) {
		const text = `${draft.task} ${draft.statement}`;
		const found = new Set(text.match(ANCHOR) ?? []);
		const nums = new Set(text.match(NUMBER) ?? []);
		anchors += found.size;
		numbers += nums.size;
		if (found.size === 0) generic++;
	}
	const facts = drafts.length || 1;
	return {
		facts: drafts.length,
		anchorsPerFact: Number((anchors / facts).toFixed(2)),
		numbersPerFact: Number((numbers / facts).toFixed(2)),
		genericRate: Number((generic / facts).toFixed(2)),
	};
}

/** Share of the full-chunk facts that the split arm also stated. */
function coverageOfSplit(full: Draft[], split: Draft[]): { mean: number; covered: number; exact: number } {
	const norm = (s: string): Set<string> =>
		new Set(
			s
				.toLowerCase()
				.split(/[^a-z0-9._/-]+/)
				.filter((t) => t.length > 2),
		);
	let total = 0;
	let covered = 0;
	for (const draft of full) {
		const a = norm(`${draft.task} ${draft.statement}`);
		let best = 0;
		for (const other of split) {
			const b = norm(`${other.task} ${other.statement}`);
			if (a.size === 0 || b.size === 0) continue;
			let shared = 0;
			for (const t of a) if (b.has(t)) shared++;
			best = Math.max(best, shared / Math.min(a.size, b.size));
		}
		total += best;
		if (best >= 0.5) covered++;
	}
	return {
		mean: Number((total / (full.length || 1)).toFixed(2)),
		covered,
		exact: full.length,
	};
}

export function duplicates(drafts: Draft[]): number {
	const seen = new Set<string>();
	let dupes = 0;
	for (const draft of drafts) {
		const key = draft.statement
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, " ")
			.trim();
		if (seen.has(key)) dupes++;
		seen.add(key);
	}
	return dupes;
}

async function extract(
	writer: Writer,
	chunk: SerializedChunk,
	label: string,
): Promise<{ drafts: Draft[]; usage: CallUsage }> {
	const result = await completeWithFallback(writer, null, EXTRACT_SYSTEM, chunk.text, label);
	const { drafts } = parseDrafts(result.content, chunk.refs);
	return { drafts, usage: result.usage };
}

async function main(): Promise<void> {
	const capturePath = arg("--capture", "");
	if (!capturePath) throw new Error("--capture <path> is required");
	const target = Number(arg("--target", "4500"));
	const modelSpec = process.env.POC_MODEL ?? "hy-memory-30b-a3b";
	const route = process.env.POC_ORIGIN
		? { origin: process.env.POC_ORIGIN, apiKey: process.env.POC_KEY, model: process.env.POC_MODEL ?? modelSpec }
		: await resolveRoute(modelSpec);
	const writer = rawWriter({
		origin: route.origin,
		apiKey: route.apiKey,
		model: route.model,
		maxTokens: 8000,
		chatTemplateKwargs: { reasoning_effort: "none" },
		timeoutMs: 600_000,
	});
	console.log(`route model=${route.model} target=${target} tok/window`);

	const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
		chunkId: string;
		text: string;
		refs: string[];
		entryCount: number;
	};
	// The capture is already serialized (numeric refs), so it *is* the chunk: running
	// it through serializeChunk again would find no `[Source entry id: …]` labels and
	// leave `refs` empty, which makes parseDrafts reject every draft.
	const chunk: SerializedChunk = { text: capture.text, refs: capture.refs, entryCount: capture.entryCount };
	const windows = splitChunk(chunk, target);
	console.log(
		`chunk ${capture.chunkId}: ${chunk.entryCount} entries, ${estimateTokens(chunk.text)} tokens → ${windows.length} windows ` +
			`(${windows.map((w) => `${w.entryCount}e/${estimateTokens(w.text)}t`).join(", ")})`,
	);

	const startedFull = Date.now();
	const full = await extract(writer, chunk, `extract full ${capture.chunkId}`);
	console.log(
		`full: ${full.drafts.length} drafts, ${full.usage.inTokens} in / ${full.usage.outTokens} out, ${(full.usage.wallS || 0).toFixed(1)} s`,
	);

	const splitDrafts: Draft[] = [];
	const splitUsage: CallUsage[] = [];
	for (const [index, window] of windows.entries()) {
		const part = await extract(writer, window, `extract ${capture.chunkId} w${index}`);
		splitDrafts.push(...part.drafts);
		splitUsage.push(part.usage);
		console.log(
			`  w${index}: ${window.entryCount} entries → ${part.drafts.length} drafts, ${part.usage.inTokens} in / ${part.usage.outTokens} out, ${(part.usage.wallS || 0).toFixed(1)} s`,
		);
	}

	const sum = (list: CallUsage[], key: "inTokens" | "outTokens" | "wallS"): number =>
		Number(list.reduce((total, u) => total + (u[key] ?? 0), 0).toFixed(1));
	const report = {
		chunkId: capture.chunkId,
		model: route.model,
		targetTokens: target,
		entries: chunk.entryCount,
		chunkTokens: estimateTokens(chunk.text),
		full: {
			...specificity(full.drafts),
			duplicates: duplicates(full.drafts),
			usage: full.usage,
			wallS: Number(((Date.now() - startedFull) / 1000).toFixed(1)),
			statements: full.drafts.map((d) => d.statement),
		},
		split: {
			...specificity(splitDrafts),
			duplicates: duplicates(splitDrafts),
			usage: {
				inTokens: sum(splitUsage, "inTokens"),
				outTokens: sum(splitUsage, "outTokens"),
				wallS: sum(splitUsage, "wallS"),
			},
			statements: splitDrafts.map((d) => d.statement),
		},
		coverage: coverageOfSplit(full.drafts, splitDrafts),
	};
	const outDir = new URL("../out/chunk-size/", import.meta.url).pathname;
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, `${capture.chunkId}.json`), `${JSON.stringify(report, null, 2)}\n`);

	const pct = (a: number, b: number): string => `${(((a - b) / (b || 1)) * 100).toFixed(0)} %`;
	console.log(`\n| arm | facts | anchors/fact | numbers/fact | generic | dupes | in tok | out tok | wall |`);
	console.log(`|---|---|---|---|---|---|---|---|---|`);
	console.log(
		`| full (${report.chunkTokens} tok) | ${report.full.facts} | ${report.full.anchorsPerFact} | ${report.full.numbersPerFact} | ${report.full.genericRate} | ${report.full.duplicates} | ${report.full.usage.inTokens} | ${report.full.usage.outTokens} | ${report.full.wallS} s |`,
	);
	console.log(
		`| split (${windows.length}×~${target}) | ${report.split.facts} | ${report.split.anchorsPerFact} | ${report.split.numbersPerFact} | ${report.split.genericRate} | ${report.split.duplicates} | ${report.split.usage.inTokens} | ${report.split.usage.outTokens} | ${report.split.usage.wallS} s |`,
	);
	console.log(
		`\nanchors/fact ${pct(report.split.anchorsPerFact, report.full.anchorsPerFact)} vs full, ` +
			`numbers/fact ${pct(report.split.numbersPerFact, report.full.numbersPerFact)}, ` +
			`facts ${pct(report.split.facts, report.full.facts)}`,
	);
	console.log(
		`coverage of full-chunk facts by the split arm: ${report.coverage.covered}/${report.coverage.exact} (mean best overlap ${report.coverage.mean})`,
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(String((error as Error)?.message ?? error));
		process.exitCode = 1;
	});
}
