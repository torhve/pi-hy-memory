#!/usr/bin/env npx tsx
/**
 * Item 6.10: does the writer propose short enumerables at all?
 *
 * Item 6.4 (`RESULTS.md`) lost facts that were stated plainly and never proposed: `exit code 3` in
 * one treatment run, `TOR_TOOL_SETTINGS` in two. Those are the short, dense shapes — a code, an
 * environment variable, a limit, a path, a ticket id, a rejected alternative — that a summary prompt
 * drops in favour of the sentence around them. This measures that directly and offline: it takes the
 * chunk text the writer actually read, pulls every probe of each category out of it, and asks whether
 * any draft the writer proposed for that chunk carried the probe, and whether it reached the bank.
 *
 * Attribution matters. A probe inside a user turn is a stated decision; one inside a tool result is
 * a fact the session happened to observe. They are reported separately because only the first is the
 * kind of thing the bank is supposed to keep.
 *
 *   npx tsx dev/enumerable-coverage.ts --corpus dev/corpus-extended.json --run baseline-extended
 *   npx tsx dev/enumerable-coverage.ts --corpus dev/corpus-extended.json --run baseline-kitx --run hifi
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { foldLedger } from "../src/bank.js";
import type { BankEntry, LedgerRecord } from "../src/types.js";

type Category = "exit_code" | "env_var" | "limit" | "path" | "identifier" | "rejected" | "flag";

const CATEGORIES: { name: Category; label: string; patterns: RegExp[] }[] = [
	{
		name: "exit_code",
		label: "exit codes and statuses",
		patterns: [
			/\b(?:exit(?:\s+code)?\s*=?\s*(?:\d+|0|[1-9]\d*))\b/gi,
			/\brc\s*=?\s*\d+\b/gi,
			/\b(?:HTTP|status)\s*\d{3}\b/gi,
		],
	},
	{
		name: "env_var",
		label: "environment variables",
		patterns: [/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g],
	},
	{
		name: "limit",
		label: "numeric limits",
		patterns: [
			/\b\d[\d_]*\s?(?:tokens?|chars?|bytes?|rows?|entries|messages?|ms|s|seconds?|minutes?|lines?)\b/gi,
			/\b0o[0-7]{3}\b/g,
			/\b(?:max|min|limit|cap|floor|threshold|timeout|window|budget)\s*=?\s*\d[\d_]*\b/gi,
		],
	},
	{
		name: "path",
		label: "file paths",
		patterns: [/\b[\w.-]+[\\/][\w./-]+\b/g, /\b[\w-]+\.(?:ts|tsx|js|json|md|toml|sh|py|html|lock|txt)\b/g],
	},
	{
		name: "identifier",
		label: "identifiers",
		patterns: [/\b[A-Z]{3,}-\d+\b/g, /\b[0-9a-f]{8}\b/g, /\b[\w-]+-[a-z]+-\d+\b/gi],
	},
	{
		name: "rejected",
		label: "rejected alternatives",
		patterns: [
			/\b(?:not|instead of|rather than|rejected|dropped|no longer using)\s+([A-Z][\w.-]*|[a-z][\w.-]{3,})\b/g,
		],
	},
	{ name: "flag", label: "commands and flags", patterns: [/\s--?[a-z][\w-]+/g] },
];

/** Upper-case words that are prose, not environment variables. */
const ENV_NOISE = new Set([
	"TODO",
	"API",
	"HTTP",
	"HTTPS",
	"JSON",
	"YAML",
	"XML",
	"HTML",
	"CSS",
	"SQL",
	"ID",
	"IDs",
	"OK",
	"AI",
	"PI",
	"UTC",
	"PM",
	"AM",
	"TL",
	"DRY",
	"CLI",
	"UI",
	"UX",
	"ABC",
	"E2E",
	"README",
	"DESIGN",
	"RESULTS",
	"TODO",
	"AGENTS",
	"SKILL",
	"MCP",
	"OAUTH",
	"TUI",
	"BSD",
	"POSIX",
	"Linux",
	"NaN",
	"II",
	"III",
]);

interface Probe {
	category: Category;
	text: string;
	chunk: string;
	role: "user" | "assistant" | "tool";
	/** True when the line reads as a decision, not an incidental mention. */
	decision: boolean;
}

const DECISION_WORDS =
	/\b(settled|decided|decide|decision|chose|chosen|keep|keeping|reject\w*|instead|must|will use|use\b|rule|default|preferr?ed?|dropped|no longer)\b/i;

/** Words that follow "not" or "dropped" in ordinary prose, not alternatives that were rejected. */
const REJECT_NOISE = new Set([
	"it",
	"that",
	"this",
	"the",
	"a",
	"an",
	"and",
	"but",
	"so",
	"know",
	"sent",
	"part",
	"depending",
	"competing",
	"duplicate",
	"statically",
	"clear",
	"sure",
	"able",
	"going",
	"using",
	"need",
	"want",
	"expect",
	"attempt",
	"issue",
	"case",
	"one",
	"more",
	"new",
	"same",
	"other",
	"both",
	"one",
	"two",
	"none",
	"restate",
	"writing",
	"falling",
	"unrecoverable",
	"generic",
	"triaging",
	"bring",
	"available",
	"guessing",
	"just",
	"also",
	"still",
	"only",
	"never",
	"again",
	"later",
	"first",
	"instead",
	"because",
	"since",
	"while",
	"after",
	"before",
	"either",
	"neither",
	"some",
	"many",
	"most",
	"few",
	"every",
	"whole",
	"same",
	"different",
	"possible",
	"unable",
	"ready",
	"sure",
	"clear",
	"worth",
	"used",
	"using",
	"uses",
	"need",
	"needed",
	"needs",
	"want",
	"wanted",
	"expect",
	"expected",
	"try",
	"trying",
	"attempt",
	"attempted",
	"fail",
	"failed",
	"failing",
	"works",
	"working",
	"worked",
	"seems",
	"looks",
	"feels",
	"keeps",
	"kept",
	"holds",
	"held",
	"makes",
	"made",
	"gives",
	"given",
	"takes",
	"taken",
	"calls",
	"called",
	"turns",
	"turned",
	"runs",
	"ran",
	"means",
	"meant",
	"shows",
	"shown",
	"leaves",
	"left",
	"loses",
	"lost",
	"finds",
	"found",
	"sets",
	"set",
	"adds",
	"added",
	"drops",
	"dropped",
	"removes",
	"removed",
	"builds",
	"built",
	"writes",
	"written",
	"reads",
	"read",
	"starts",
	"started",
	"stops",
	"stopped",
]);

const LINE_ROLE = /\[(User|Assistant|Tool result for [^\]]+)\b/;

function roleOfLine(line: string): Probe["role"] {
	const match = LINE_ROLE.exec(line);
	if (!match) return "assistant";
	return match[1]?.startsWith("User") ? "user" : match[1]?.startsWith("Tool") ? "tool" : "assistant";
}

/** Pull probes out of a chunk, one claim per text: a path is not also an identifier. */
/**
 * Did a draft or a bank fact carry this probe? Retention is literal, with one relaxation: an exit code
 * stated as `exit code 65` is legitimately kept as `65 = partial write`, and the writer does compress
 * enumerations that way. Bare numbers are ambiguous, so the relaxation only applies to the exit-code
 * category and only where the number sits next to an exit-ish word or an `=`.
 */
function carried(category: Category, probe: string, haystack: string): boolean {
	// Whitespace-insensitive: `45 s` stated, `45s` kept, is the same fact.
	const squash = (value: string) => value.toLowerCase().replace(/\s+/g, "");
	if (haystack && squash(haystack).includes(squash(probe))) return true;
	if (category !== "exit_code") return false;
	const num = probe.match(/\d+/)?.[0];
	if (!num) return false;
	// A code kept as `5 = registry 404` or `130 = interrupted rename` is kept. Checked per statement so
	// a bare number only counts when that statement is also talking about exit codes.
	return haystack
		.split("\n")
		.some((line) => /\b(?:exit|code|rc|status)\b/i.test(line) && new RegExp(`\\b${num}\\b\s*(?:=|:)?`).test(line));
}

function extractProbes(text: string, chunk: string): Probe[] {
	const probes: Probe[] = [];
	let lastRole: Probe["role"] = "assistant";
	for (const line of text.split("\n")) {
		// A capture clips each entry to one line, but a corpus can carry a multi-line tool result:
		// continuation lines belong to the labelled entry above them, not to the assistant.
		const labelled = LINE_ROLE.test(line);
		const role: Probe["role"] = labelled ? roleOfLine(line) : lastRole;
		lastRole = role;
		const decision = labelled && DECISION_WORDS.test(line);
		const claimed = new Set<string>();
		for (const category of CATEGORIES) {
			for (const pattern of category.patterns) {
				for (const match of line.matchAll(pattern)) {
					const value = (match[1] ?? match[0]).trim();
					if (value.length < 2) continue;
					const key = value.toLowerCase();
					if (claimed.has(key)) continue;
					if (category.name === "env_var" && ENV_NOISE.has(value)) continue;
					if (category.name === "rejected" && REJECT_NOISE.has(key)) continue;
					claimed.add(key);
					probes.push({ category: category.name, text: value, chunk, role, decision });
				}
			}
		}
	}
	return probes;
}

function args(): { corpus: string; runs: string[]; captures: string; show: number } {
	const argv = process.argv.slice(2);
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const runs: string[] = [];
	for (let i = 0; i < argv.length; i++) if (argv[i] === "--run" && argv[i + 1]) runs.push(argv[i + 1]);
	return {
		corpus: get("--corpus") ?? "dev/corpus-extended.json",
		runs,
		captures: get("--captures") ?? "captures-dev",
		show: Number(get("--show") ?? 8),
	};
}

const { corpus, runs, captures, show } = args();
if (runs.length === 0) {
	console.error("give at least one --run <runId> under out/");
	process.exit(2);
}

interface CorpusChunk {
	path?: string;
	text?: string;
	chunkId?: string;
	category?: string;
}
const corpusDoc = JSON.parse(readFileSync(corpus, "utf8")) as {
	chunks: CorpusChunk[];
	gate?: Partial<Record<Category, number>>;
};

// Probes per chunk, deduplicated within a chunk, so a path repeated five times counts once.
const probesByChunk = new Map<string, Probe[]>();
for (const chunk of corpusDoc.chunks) {
	// An authored corpus carries its text inline; a capture corpus points at a serialized chunk file.
	const doc =
		typeof chunk.text === "string"
			? { chunkId: chunk.chunkId ?? String(chunk.path), text: chunk.text }
			: (JSON.parse(readFileSync(join(captures, String(chunk.path)), "utf8")) as {
					chunkId: string;
					text: string;
				});
	const seen = new Set<string>();
	const keep: Probe[] = [];
	for (const probe of extractProbes(doc.text, doc.chunkId)) {
		const key = `${probe.category}:${probe.text.toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);
		keep.push(probe);
	}
	probesByChunk.set(doc.chunkId, keep);
}

for (const run of runs) {
	const ledger = readFileSync(join("out", run, "ledger.jsonl"), "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as LedgerRecord);
	const draftsByChunk = new Map<string, string[]>();
	for (const record of ledger) {
		if (record.type !== "hy.extract") continue;
		const statements = (record.drafts ?? []).map(
			(draft) => `${draft.task} ${draft.statement} ${(draft.keys ?? []).join(" ")}`,
		);
		// Split-chunk arms write `hy-…-001.1` and `…001.2` over one corpus chunk: fold them together.
		const key = record.chunkId.replace(/\.\d+$/, "");
		draftsByChunk.set(key, [...(draftsByChunk.get(key) ?? []), ...statements]);
	}
	const bank: BankEntry[] = foldLedger(ledger).filter((entry) => entry.status === "active");
	const bankText = bank.map((entry) => `${entry.task} ${entry.statement} ${(entry.keys ?? []).join(" ")}`).join("\n");

	interface Row {
		label: string;
		prose: number;
		proseProposed: number;
		proseBank: number;
		decided: number;
		decidedProposed: number;
		decidedBank: number;
		tool: number;
		missed: string[];
	}

	const rows: Row[] = [];
	for (const category of CATEGORIES) {
		let prose = 0;
		let proseProposed = 0;
		let proseBank = 0;
		let decided = 0;
		let decidedProposed = 0;
		let decidedBank = 0;
		let tool = 0;
		const missed: string[] = [];
		for (const [chunkId, probes] of probesByChunk) {
			const drafts = draftsByChunk.get(chunkId) ?? [];
			for (const probe of probes) {
				if (probe.category !== category.name) continue;
				const inBank = carried(probe.category, probe.text, bankText);
				const proposed = drafts.some((draft) => carried(probe.category, probe.text, draft));
				if (probe.role === "tool") {
					tool++;
					continue;
				}
				prose++;
				if (proposed) proseProposed++;
				if (inBank) proseBank++;
				if (probe.decision) {
					decided++;
					if (proposed) decidedProposed++;
					if (inBank) decidedBank++;
				}
				if (!inBank && missed.length < show) missed.push(`${probe.text} (${probe.role}, ${chunkId})`);
			}
		}
		rows.push({
			label: category.label,
			prose,
			proseProposed,
			proseBank,
			decided,
			decidedProposed,
			decidedBank,
			tool,
			missed,
		});
	}

	const sum = (pick: (row: Row) => number) => rows.reduce((total, row) => total + pick(row), 0);
	if (corpusDoc.gate) {
		const names = new Map(rows.map((row, i) => [row.label, CATEGORIES[i]?.name]));
		console.log(`\n${run} gate (decision-line scope, distinct probes stated)`);
		for (const [name, min] of Object.entries(corpusDoc.gate)) {
			const row = rows.find((r) => names.get(r.label) === name);
			const have = row?.decided ?? 0;
			console.log(`  ${name}: ${have} stated, needs ${min} — ${have >= min ? "ok" : "NOT MET"}`);
		}
	}
	const pct = (n: number, d: number) => (d === 0 ? "-" : `${Math.round((100 * n) / d)}%`);
	const table = (
		head: string,
		count: (row: Row) => number,
		proposed: (row: Row) => number,
		inBank: (row: Row) => number,
		extra?: (row: Row) => number,
	) => {
		console.log(`\n${head}`);
		console.log(
			`${"category".padEnd(24)} ${"stated".padStart(7)} ${"proposed".padStart(9)} ${"% prop".padStart(7)} ${"in bank".padStart(8)} ${"% bank".padStart(7)}${extra ? ` ${"tool".padStart(6)}` : ""}`,
		);
		for (const row of rows) {
			const tail = extra ? ` ${String(extra(row)).padStart(6)}` : "";
			console.log(
				`${row.label.padEnd(24)} ${String(count(row)).padStart(7)} ${String(proposed(row)).padStart(9)} ${pct(proposed(row), count(row)).padStart(7)} ${String(inBank(row)).padStart(8)} ${pct(inBank(row), count(row)).padStart(7)}${tail}`,
			);
		}
		const total = sum(count);
		console.log(
			`${"TOTAL".padEnd(24)} ${String(total).padStart(7)} ${String(sum(proposed)).padStart(9)} ${pct(sum(proposed), total).padStart(7)} ${String(sum(inBank)).padStart(8)} ${pct(sum(inBank), total).padStart(7)}`,
		);
	};

	console.log(`\n=== ${run} — ${probesByChunk.size} chunks, ${bank.length} active facts ===`);
	table(
		"everything the chunk text said (user + assistant prose)",
		(row) => row.prose,
		(row) => row.proseProposed,
		(row) => row.proseBank,
		(row) => row.tool,
	);
	table(
		"only lines that read as a decision",
		(row) => row.decided,
		(row) => row.decidedProposed,
		(row) => row.decidedBank,
	);

	console.log("\nprose probes absent from the final bank, oldest first:");
	for (const row of rows) {
		if (row.missed.length === 0) continue;
		console.log(`  ${row.label}: ${row.missed.join(", ")}`);
	}
}
