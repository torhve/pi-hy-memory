#!/usr/bin/env npx tsx
/**
 * tools/restraint-corpus-check.ts - the contrast-pair contract of dev/corpus-restraint.json.
 *
 * A contrast pair is only worth anything if the two sides differ in exactly one thing. This check
 * is what keeps that true: it refuses a pair whose sides differ in a second declared token, a
 * marker that leaks onto the side that must not name it, an anchor that appears in an unrelated
 * chunk, and — the failure an external benchmark actually caught — a probe string that also
 * appears in the writer's own instructions, which measures the prompt instead of the model.
 *
 * It also runs the repo's privacy rules over the authored text, because this corpus is committed
 * while the transcripts it imitates are not.
 */

import { readFileSync } from "node:fs";
import { EXTRACT_SYSTEM, reconcileSystem } from "../src/prompts.js";

// `--corpus <file>` exists so the check can be pointed at a deliberately broken copy and shown
// to fail; `npm run test` runs it against the committed corpus with no arguments.
const argCorpus = process.argv.indexOf("--corpus");
const CORPUS =
	argCorpus >= 0 && process.argv[argCorpus + 1]
		? process.argv[argCorpus + 1]
		: new URL("../dev/corpus-restraint.json", import.meta.url).pathname;

interface CorpusChunk {
	chunkId: string;
	class: string;
	pair?: string;
	side?: string;
	anchors?: string[];
	marker?: string;
	claim?: string;
	why?: string;
	text: string;
}

function assert(cond: boolean, label: string): void {
	if (!cond) {
		console.error(`FAIL: ${label}`);
		process.exit(1);
	}
}

const doc = JSON.parse(readFileSync(CORPUS, "utf8")) as {
	gate?: { attribution_pair?: number; empty_chunk?: number };
	chunks: CorpusChunk[];
};

const chunks = doc.chunks;
const gate = doc.gate ?? {};

// ---- 1. shape -----------------------------------------------------------------
const ids = new Set<string>();
for (const c of chunks) {
	assert(!ids.has(c.chunkId), `duplicate chunkId ${c.chunkId}`);
	ids.add(c.chunkId);
	assert(c.class === "attribution" || c.class === "empty", `${c.chunkId}: unknown class "${c.class}"`);
	assert(c.text.trim().length > 0, `${c.chunkId}: empty text`);
	// Every labelled line carries a positional ref, and refs count from 0.
	const lines = c.text.split("\n");
	let labelled = 0;
	for (const line of lines) {
		if (!line.trim()) continue;
		if (!/^\[\d+\] \[/.test(line)) continue;
		assert(line.startsWith(`[${labelled}]`), `${c.chunkId}: ref out of order in "${line.slice(0, 24)}…"`);
		labelled++;
	}
	assert(labelled >= 4, `${c.chunkId}: only ${labelled} labelled turns, too thin to score`);
}

const pairs = new Map<string, CorpusChunk[]>();
const empties: CorpusChunk[] = [];
for (const c of chunks) {
	if (c.class === "empty") {
		assert(Boolean(c.why), `${c.chunkId}: an empty chunk must say why nothing in it is durable`);
		assert(!c.anchors?.length && !c.marker, `${c.chunkId}: an empty chunk declares no anchors or marker`);
		empties.push(c);
		continue;
	}
	assert(
		Boolean(c.pair && c.side && c.anchors?.length && c.marker && c.claim),
		`${c.chunkId}: attribution chunk needs pair, side, anchors, marker and claim`,
	);
	assert(c.side === "keep" || c.side === "quote", `${c.chunkId}: side must be keep or quote, got ${c.side}`);
	pairs.set(c.pair!, [...(pairs.get(c.pair!) ?? []), c]);
}

for (const [pair, sides] of pairs) {
	assert(sides.length === 2, `${pair}: ${sides.length} sides, a contrast pair has exactly two`);
	const keep = sides.find((s) => s.side === "keep");
	const quote = sides.find((s) => s.side === "quote");
	assert(Boolean(keep && quote), `${pair}: needs one keep side and one quote side`);
}

const pairCount = pairs.size;
const wantPairs = gate.attribution_pair ?? 0;
const wantEmpty = gate.empty_chunk ?? 0;
console.log(`corpus: ${chunks.length} chunks, ${pairCount} attribution pairs, ${empties.length} empty chunks`);
assert(pairCount >= wantPairs, `gate: ${pairCount} attribution pairs, needs ${wantPairs}`);
assert(empties.length >= wantEmpty, `gate: ${empties.length} empty chunks, needs ${wantEmpty}`);

// ---- 2. pair isolation --------------------------------------------------------
const wordMatch = (needle: string, text: string): boolean =>
	new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);

for (const [pair, sides] of pairs) {
	const keep = sides.find((s) => s.side === "keep")!;
	const quote = sides.find((s) => s.side === "quote")!;
	for (const anchor of keep.anchors!) {
		assert(wordMatch(anchor, keep.text), `${keep.chunkId}: anchor "${anchor}" is not on the keep side`);
		assert(wordMatch(anchor, quote.text), `${quote.chunkId}: anchor "${anchor}" is not on the quote side`);
	}
	// The claim itself must be verbatim on both sides: the pair's whole point is that the
	// sentence is identical and only the frame around it moved.
	assert(keep.text.includes(keep.claim!), `${keep.chunkId}: the claim is not verbatim on the keep side`);
	assert(quote.text.includes(quote.claim!), `${quote.chunkId}: the claim is not verbatim on the quote side`);
	assert(
		keep.claim === quote.claim,
		`${pair}: the two sides declare different claims, so the pair is not a contrast`,
	);
	// The marker names the third party, so it belongs on the quote side only.
	assert(wordMatch(keep.marker!, quote.text), `${quote.chunkId}: the quote side never names "${keep.marker}"`);
	assert(
		!wordMatch(keep.marker!, keep.text),
		`${keep.chunkId}: the keep side names "${keep.marker}", which erases the contrast`,
	);
}

// ---- 3. no leakage ------------------------------------------------------------
// An anchor or marker that appears in an unrelated chunk makes every score in that chunk
// ambiguous: an intrusion there could be a leak rather than a decision.
for (const [pair, sides] of pairs) {
	const keep = sides.find((s) => s.side === "keep")!;
	for (const anchor of keep.anchors!) {
		for (const other of chunks) {
			if (other.pair === pair) continue;
			assert(!wordMatch(anchor, other.text), `leak: anchor "${anchor}" of ${pair} appears in ${other.chunkId}`);
		}
	}
	for (const other of chunks) {
		if (other.pair === pair) continue;
		assert(
			!wordMatch(keep.marker!, other.text),
			`leak: marker "${keep.marker}" of ${pair} appears in ${other.chunkId}`,
		);
	}
}

// ---- 4. contamination guard ---------------------------------------------------
// The external benchmark caught a model inventing a fact out of its own instructions. This
// repo's own measured version of that is 19/590 observations copying a rendered id label.
// A probe that exists in the prompt measures the prompt.
const promptText = `${EXTRACT_SYSTEM}\n${reconcileSystem(12)}`;
for (const [pair, sides] of pairs) {
	const keep = sides.find((s) => s.side === "keep")!;
	for (const anchor of keep.anchors!) {
		assert(
			!wordMatch(anchor, promptText),
			`contamination: anchor "${anchor}" of ${pair} appears in the writer prompt`,
		);
	}
	assert(!wordMatch(keep.marker!, promptText), `contamination: marker "${keep.marker}" appears in the writer prompt`);
}

// ---- 5. privacy (AGENTS.md) ---------------------------------------------------
const HOST = /\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|dev|local|internal|lan)\b/i;
const ABS_PATH = /(?:^|[\s"'`(])\/(?:Users|home|root|var|etc|tmp|private)\//i;
const CREDENTIAL = /\b(?:api[_-]?key|secret|token|password|passwd|bearer|authorization|sk-[A-Za-z0-9]{8,})\b/i;
for (const c of chunks) {
	assert(!HOST.test(c.text), `${c.chunkId}: hostname-shaped text`);
	assert(!ABS_PATH.test(c.text), `${c.chunkId}: absolute path under a home or system directory`);
	assert(!CREDENTIAL.test(c.text), `${c.chunkId}: credential-shaped text`);
}

const totalChars = chunks.reduce((n, c) => n + c.text.length, 0);
console.log(
	`ok: pairs isolated, no leakage, no prompt contamination, privacy clean (${chunks.length} chunks, ~${Math.ceil(totalChars / 4)} est tokens, mean ${Math.round(totalChars / chunks.length / 4)} per chunk)`,
);
