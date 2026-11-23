#!/usr/bin/env npx tsx
/**
 * Can a small parser give the bank a trustworthy "these two entries measure the same thing" signal?
 *
 * Words around a number do not work: an offline run and a LAN run use the same wording. This probe tries a
 * constrained key instead — a measure phrase, a scope read from the command, and a record/assertion split.
 * Truth comes from the corpus, which marks each fact as an assertion or as a record of an old number.
 *
 * Run: npx tsx dev/metric-identity.ts [--corpus dev/corpus-supersede2.json]
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

/** A count quoted by an older artifact, or attributed to a superseded run, is a record, not a current claim. */
const RECORD_MARKERS = [
	/\b(earlier|previous|previously|formerly|once|briefly|at one time|last session|older|stale)\b/i,
	/\b(reported|claimed|showed|hard-codes|hardcoded|recorded|contained|listed|opened with|still opens)\b/i,
	/\b[\w./-]+\.(md|log|json|sh|mjs|ts)\b.*\b(claims|states|contains|lists|records|opens with|hard-codes)\b/i,
	/'[^']*\d{3,4}[^']*'/,
];

/** What the number measures, read from the words next to it. */
const MEASURES: [RegExp, string][] = [
	[/\bchecks? (passed|passing)\b|\bpassing tests\b|\bchecks\b[^.]{0,30}\btests\b|\btests passed\b/i, "suite-count"],
	[/\bgreen\b/i, "suite-count"],
	[/\b(baseline|total|totals)\b/i, "suite-count"],
	[/\bcoverage\b|\b%\b/i, "coverage"],
	[/\bcases?\b/i, "case-count"],
];

const scope = (statement: string): string => {
	if (/--lan\b|\bTCTL_LAN\b|\bLAN\b/i.test(statement)) return "lan";
	if (/--offline\b|\bTCTL_DRY\b|\boffline\b/i.test(statement)) return "offline";
	return "unscoped";
};

const deriveClaim = (statement: string): { key: string; kind: "assertion" | "record" } | undefined => {
	if (!/\b\d{3,4}\b/.test(statement)) return undefined;
	const kind = RECORD_MARKERS.some((re) => re.test(statement)) ? "record" : "assertion";
	const measure = MEASURES.find(([re]) => re.test(statement))?.[1];
	if (!measure) return undefined;
	return { key: `${measure}/${scope(statement)}`, kind };
};

let ok = 0;
let wrongKind = 0;
let missingKey = 0;
const kindErrors: string[] = [];
const keyGroups = new Map<string, string[]>();

for (const chunk of corpus.chunks)
	for (const fact of chunk.facts) {
		const truth = suiteClaims(fact.statement)[0];
		if (!truth) continue;
		const derived = deriveClaim(fact.statement);
		if (!derived) {
			missingKey++;
			kindErrors.push(`  no key: ${fact.statement.slice(0, 72)}`);
			continue;
		}
		const truthKind = fact.stale === true ? "record" : "assertion";
		if (derived.kind === truthKind) ok++;
		else {
			wrongKind++;
			kindErrors.push(`  ${truthKind} read as ${derived.kind}: ${fact.statement.slice(0, 72)} [${derived.key}]`);
		}
		const group = keyGroups.get(derived.key) ?? [];
		group.push(`${derived.kind} ${truth.value}`);
		keyGroups.set(derived.key, group);
	}

console.log(corpusPath);
console.log(`  kinds correct: ${ok}, kinds wrong: ${wrongKind}, no key derived: ${missingKey}`);
for (const e of kindErrors) console.log(e);
console.log("  groups the key produces (kind value):");
for (const [k, v] of keyGroups) console.log(`    ${k}: ${v.join(", ")}`);
