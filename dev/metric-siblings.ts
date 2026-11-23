#!/usr/bin/env npx tsx
/**
 * Can the bank tell that two entries measure the same thing without being told the subject?
 *
 * The extractor labels every draft with its own task, so a superseded count and the current one arrive under
 * different names ("offline suite status", "cache fix retest"). Supersession then depends on the model noticing
 * that the two statements measure the same thing. This probe tests a model-free signal instead: strip the number
 * and compare the words around it. Two statements measure the same thing when their number neighbourhoods match.
 *
 * Truth comes from the corpus, which marks each fact as an assertion of a mode or as a record of an old number.
 * True pairs are two assertions of the same mode. A record matched to an assertion is a false pair, because a log
 * line quoting an old number is not the same fact.
 *
 * Run: npx tsx dev/metric-siblings.ts [--corpus dev/corpus-supersede2.json]
 */
import { readFileSync } from "node:fs";
import { suiteClaims } from "./suite-claim.js";

type Fact = { task: string; statement: string; stale?: boolean };
type Corpus = { chunks: { chunkId: string; facts: Fact[] }[] };

const arg = (flag: string, fallback: string): string => {
	const i = process.argv.indexOf(flag);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const corpusPath = arg("--corpus", "dev/corpus-supersede.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as Corpus;

/** The words within a few tokens of each number, lowercased, numbers and stopwords dropped. */
const STOP = new Set(
	"a an and are as at be been but by for from had has have in is it of on or that the their there they this to was were with which".split(
		" ",
	),
);

const windows = (statement: string): Set<string>[] => {
	const tokens = statement
		.toLowerCase()
		.split(/[^a-z0-9.]+/)
		.filter((t) => t.length > 0);
	const out: Set<string>[] = [];
	for (let i = 0; i < tokens.length; i++) {
		if (!/^\d{3,4}$/.test(tokens[i] ?? "")) continue;
		const window = new Set<string>();
		for (let j = Math.max(0, i - 4); j <= Math.min(tokens.length - 1, i + 4); j++) {
			if (j === i) continue;
			const token = tokens[j] ?? "";
			if (/^\d+[.]\d+$|^\d+$/.test(token) || STOP.has(token) || token.length < 3) continue;
			window.add(token);
		}
		out.push(window);
	}
	return out;
};

const similarity = (a: Set<string>, b: Set<string>): number => {
	let shared = 0;
	for (const t of a) if (b.has(t)) shared++;
	const union = new Set([...a, ...b]).size;
	return union === 0 ? 0 : shared / union;
};

// Every fact in the corpus becomes one entry, so a pair of entries is a pair of facts.
type Entry = { id: string; mode: "lan" | "offline"; value: number; statement: string; record: boolean };
const entries: Entry[] = [];
for (const chunk of corpus.chunks)
	for (const fact of chunk.facts) {
		const claim = suiteClaims(fact.statement)[0];
		if (!claim) continue;
		entries.push({
			id: `${chunk.chunkId}:${entries.length}`,
			mode: claim.mode,
			value: claim.value,
			statement: fact.statement,
			record: fact.stale === true,
		});
	}

const assertions = entries.filter((e) => !e.record);
const truePairs = new Set<string>();
for (let i = 0; i < assertions.length; i++)
	for (let j = i + 1; j < assertions.length; j++) {
		const a = assertions[i]!;
		const b = assertions[j]!;
		if (a.mode === b.mode) truePairs.add(`${a.id}|${b.id}`);
	}

const key = (a: Entry, b: Entry): string => (a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);

for (const threshold of [0.1, 0.2, 0.3, 0.4]) {
	const predicted = new Set<string>();
	const falsePairs: string[] = [];
	for (let i = 0; i < entries.length; i++)
		for (let j = i + 1; j < entries.length; j++) {
			const a = entries[i]!;
			const b = entries[j]!;
			let best = 0;
			for (const wa of windows(a.statement))
				for (const wb of windows(b.statement)) best = Math.max(best, similarity(wa, wb));
			if (best < threshold) continue;
			const k = key(a, b);
			predicted.add(k);
			if (!truePairs.has(k))
				falsePairs.push(
					`${a.value}/${b.value} ${a.record ? "record" : "assert"} ${a.statement.slice(0, 34)} <> ${b.record ? "record" : "assert"} ${b.statement.slice(0, 34)} (${best.toFixed(2)})`,
				);
		}
	const hit = [...predicted].filter((k) => truePairs.has(k)).length;
	console.log(
		`${corpusPath} threshold ${threshold}: ${hit}/${truePairs.size} true pairs found, ${predicted.size - hit} pairs matched that are not the same metric`,
	);
	for (const f of falsePairs.slice(0, 5)) console.log(`    ${f}`);
}
