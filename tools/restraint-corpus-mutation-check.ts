#!/usr/bin/env npx tsx
/**
 * tools/restraint-corpus-mutation-check.ts - prove the corpus check can fail.
 *
 * `tools/restraint-corpus-check.ts` passing against the committed corpus says nothing on its own: a
 * check that never rejects anything passes forever. This file breaks the corpus on purpose, one rule
 * at a time, and requires the check to reject each break with the message that names the rule. A rule
 * that stops being enforced shows up here as a mutation that suddenly passes.
 *
 * The corpus is copied to a temp file per mutation rather than edited in place, so the committed file
 * is never at risk and the check runs exactly the way `npm run test` runs it.
 *
 * One rule is deliberately not mutation-tested: the privacy rules (hostname-shaped text, an absolute
 * path under a home directory, credential-shaped text). A fixture that tripped them would put exactly
 * that shape into the diff, which AGENTS.md forbids. Those are rules a reviewer reads; this file
 * covers the ones that can be demonstrated without writing the thing itself.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CORPORA = [
	"dev/corpus-restraint.json",
	"dev/corpus-restraint2.json",
	"dev/corpus-restraint3.json",
	"dev/corpus-restraint4.json",
];
const CHECK = "tools/restraint-corpus-check.ts";

interface MutableChunk {
	chunkId: string;
	class: string;
	text: string;
	pair?: string;
	side?: string;
	anchors?: string[];
	marker?: string;
	claim?: string;
	why?: string;
	probes?: string[];
	transient?: string[];
	constraints?: string[];
	hidden?: string[];
	argsFull?: string;
	crossSession?: string;
}

interface MutableDoc {
	gate: Record<string, number>;
	chunks: MutableChunk[];
}

function assert(cond: boolean, label: string): void {
	if (!cond) {
		console.error(`FAIL: ${label}`);
		process.exit(1);
	}
}

const bases = new Map(CORPORA.map((file) => [file, JSON.parse(readFileSync(file, "utf8")) as MutableDoc]));
const dir = mkdtempSync(join(tmpdir(), "restraint-corpus-mutation-"));

function chunk(doc: MutableDoc, id: string): MutableChunk {
	const found = doc.chunks.find((c) => c.chunkId === id);
	if (!found) throw new Error(`mutation target ${id} is not in the corpus`);
	return found;
}

/** Add to the last labelled line, so the positional refs stay in order and only the rule under test breaks. */
function appendToLastLine(target: MutableChunk, extra: string): void {
	const lines = target.text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i]!.trim()) {
			lines[i] = `${lines[i]} ${extra}`;
			break;
		}
	}
	target.text = lines.join("\n");
}

/**
 * Rewrite one line of a chunk, found by a fragment it must contain, keeping the `[N]` label intact so
 * the positional refs stay in order and only the rule under test breaks. It fails loudly when the
 * fragment is gone or the rewrite changes nothing, which is how a mutation notices the corpus moved.
 */
function rewriteLine(doc: MutableDoc, id: string, needle: string, make: (line: string) => string): void {
	const target = chunk(doc, id);
	const lines = target.text.split("\n");
	let hit = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!line.includes(needle)) continue;
		const rewritten = make(line);
		assert(rewritten !== line, `mutation ${id}: the line containing "${needle}" came back unchanged`);
		lines[i] = rewritten;
		hit = true;
		break;
	}
	assert(hit, `mutation target ${id} has no line containing "${needle}"`);
	target.text = lines.join("\n");
}

interface Mutation {
	/** Which committed corpus this break is applied to. */
	corpus?: string;
	name: string;
	/** The rule the check must name when it rejects this corpus. */
	expect: string;
	apply: (doc: MutableDoc) => void;
}

const mutations: Mutation[] = [
	{
		name: "tool_output chunk with no probe list",
		expect: "must name the tool fact it tests for",
		apply: (doc) => {
			delete chunk(doc, "hy-r2-to-01").probes;
		},
	},
	{
		name: "probe declared but absent from its own chunk",
		expect: 'probe "--dry-run" is not in the chunk',
		apply: (doc) => {
			const c = chunk(doc, "hy-r2-to-01");
			c.text = c.text.split("--dry-run").join("--show-diff");
		},
	},
	{
		name: "tool_output chunk with no declared chatter",
		expect: "must name the chatter that must not be banked",
		apply: (doc) => {
			delete chunk(doc, "hy-r2-to-02").transient;
		},
	},
	{
		name: "chatter declared but absent from its own chunk",
		expect: 'transient "just checking" is not in the chunk',
		apply: (doc) => {
			const c = chunk(doc, "hy-r2-to-02");
			c.text = c.text.replace(/just checking/i, "checking nothing");
		},
	},
	{
		name: "probe leaked into an unrelated chunk",
		expect: 'leak: probe "0.9.2" of hy-r2-to-06 appears in hy-r2-nw-03',
		apply: (doc) => {
			appendToLastLine(chunk(doc, "hy-r2-nw-03"), "0.9.2");
		},
	},
	{
		name: "probe that is also a word in the writer's own prompt",
		expect: 'contamination: probe "version" of hy-r2-to-06 appears in the writer prompt',
		apply: (doc) => {
			chunk(doc, "hy-r2-to-06").probes = ["version"];
		},
	},
	{
		name: "a class the scorer does not know",
		expect: 'unknown class "marginal"',
		apply: (doc) => {
			chunk(doc, "hy-r2-nw-01").class = "marginal";
		},
	},
	{
		name: "gate promises one more tool_output chunk than the corpus has",
		expect: "gate: 6 tool_output chunks, needs 7",
		apply: (doc) => {
			doc.gate.tool_output = 7;
		},
	},
	{
		name: "nothing_work chunk that never says why nothing is durable",
		expect: "must say why nothing in it is durable",
		apply: (doc) => {
			chunk(doc, "hy-r2-nw-01").why = "";
		},
	},
	{
		name: "a contrast pair whose two sides declare different claims",
		expect: "the two sides declare different claims",
		apply: (doc) => {
			const quote = chunk(doc, "hy-r2-r2a-q");
			const revised = `${quote.claim} (revised)`;
			quote.text = quote.text.replace(quote.claim!, revised);
			quote.claim = revised;
		},
	},
	{
		name: "a claim that is no longer verbatim on the quote side",
		expect: "the claim is not verbatim on the quote side",
		apply: (doc) => {
			const quote = chunk(doc, "hy-r2-r2b-q");
			quote.text = quote.text.split(quote.claim!).join("the flag does not follow links, roughly");
		},
	},
	{
		name: "the third party's name moved onto the side that must not name it",
		expect: "the keep side names",
		apply: (doc) => {
			const keep = chunk(doc, "hy-r2-r2a-k");
			appendToLastLine(keep, `(as ${keep.marker} put it)`);
		},
	},
	{
		name: "an anchor that stops appearing on the quote side",
		expect: 'anchor "pending.db" is not on the quote side',
		apply: (doc) => {
			const quote = chunk(doc, "hy-r2-r2c-q");
			quote.text = quote.text.split("pending.db").join("the queue file");
		},
	},
	// ---- the wide tool-output corpus: same rules, new file ---------------------------
	{
		corpus: "dev/corpus-restraint3.json",
		name: "r3: tool_output chunk with no probe list",
		expect: "must name the tool fact it tests for",
		apply: (doc) => {
			delete chunk(doc, "hy-r3-to-03").probes;
		},
	},
	{
		corpus: "dev/corpus-restraint3.json",
		name: "r3: probe leaked into an unrelated chunk",
		expect: 'leak: probe "MAX_RETRY" of hy-r3-to-09 appears in hy-r3-to-11',
		apply: (doc) => {
			appendToLastLine(chunk(doc, "hy-r3-to-11"), "MAX_RETRY");
		},
	},
	{
		corpus: "dev/corpus-restraint3.json",
		name: "r3: declared chatter leaked into an unrelated chunk",
		expect: 'leak: transient "glancing at one line" of hy-r3-to-02 appears in hy-r3-to-07',
		apply: (doc) => {
			appendToLastLine(chunk(doc, "hy-r3-to-07"), "glancing at one line");
		},
	},
	{
		corpus: "dev/corpus-restraint3.json",
		name: "r3: chatter declared but absent from its own chunk",
		expect: 'transient "wanted the exact wording" is not in the chunk',
		apply: (doc) => {
			const c = chunk(doc, "hy-r3-to-05");
			c.text = c.text.replace("wanted the exact wording", "wanted the rough wording");
		},
	},
	{
		corpus: "dev/corpus-restraint3.json",
		name: "r3: probe that is also a word in the writer's own prompt",
		expect: 'contamination: probe "durable" of hy-r3-to-06 appears in the writer prompt',
		apply: (doc) => {
			const c = chunk(doc, "hy-r3-to-06");
			appendToLastLine(c, "nothing durable here");
			c.probes = ["durable"];
		},
	},
	{
		corpus: "dev/corpus-restraint3.json",
		name: "r3: gate promises one more tool_output chunk than the corpus has",
		expect: "gate: 12 tool_output chunks, needs 13",
		apply: (doc) => {
			doc.gate.tool_output = 13;
		},
	},
	{
		corpus: "dev/corpus-restraint3.json",
		name: "r3: an anchor that stops appearing on the quote side",
		expect: 'anchor "journal.db" is not on the quote side',
		apply: (doc) => {
			const quote = chunk(doc, "hy-r3-r3c-q");
			quote.text = quote.text.split("journal.db").join("the journal file");
		},
	},
	{
		corpus: "dev/corpus-restraint3.json",
		name: "r3: the third party's name moved onto the side that must not name it",
		expect: "the keep side names",
		apply: (doc) => {
			const keep = chunk(doc, "hy-r3-r3d-k");
			appendToLastLine(keep, `(as ${keep.marker} put it)`);
		},
	},
	// ---- the fourth corpus: window, constraints, hidden values, authored sessions -----

	{
		corpus: "dev/corpus-restraint4.json",
		name: "r4: a cut call whose full argument list the corpus never names",
		expect: "names no argsFull",
		apply: (doc) => {
			delete chunk(doc, "hy-4f0a0001-to-02").argsFull;
		},
	},
	{
		corpus: "dev/corpus-restraint4.json",
		name: "r4: a call shown 12 characters shorter than the shipped window shows",
		expect: "characters of arguments; the shipped window shows",
		apply: (doc) => {
			rewriteLine(doc, "hy-4f0a0001-to-02", "[called bash ", (line) => {
				const at = line.indexOf("[called bash ");
				const head = line.slice(0, at + "[called bash ".length);
				const visible = line.slice(at + "[called bash ".length, -1);
				// 12 characters removed from a 240-character cut: still unparseable, no longer the window.
				return `${head}${visible.slice(0, 228)}]`;
			});
		},
	},
	{
		corpus: "dev/corpus-restraint4.json",
		name: "r4: a hidden value that sits inside the window rather than past it",
		expect: 'hidden value "--purge-stale" is not past the 240-character argument window',
		apply: (doc) => {
			chunk(doc, "hy-4f0a0001-to-03").hidden = ["--purge-stale"];
		},
	},
	{
		corpus: "dev/corpus-restraint4.json",
		name: "r4: a hidden value printed in plain sight in another chunk",
		expect: 'shows the hidden value "--retention-days 45"',
		apply: (doc) => {
			appendToLastLine(chunk(doc, "hy-4f0a0002-nw-01"), "the summary mentioned --retention-days 45");
		},
	},
	{
		corpus: "dev/corpus-restraint4.json",
		name: "r4: a hidden value whose every token is shown by some chunk",
		expect: "names no token the writer is ever denied",
		apply: (doc) => {
			// The phrase stays non-contiguous, so the leak rule cannot be what catches this one: only
			// the token rule knows that a bank fact carrying either token could have read it somewhere.
			appendToLastLine(chunk(doc, "hy-4f0a0002-nw-04"), "the sweep wrote --retention-days and 45 of them down");
		},
	},
	{
		corpus: "dev/corpus-restraint4.json",
		name: "r4: a constraint the chunk does not actually contain",
		expect: 'constraint "do not rebalance the night render" is not in the chunk',
		apply: (doc) => {
			const c = chunk(doc, "hy-4f0a0001-to-04");
			c.text = c.text.split("do not rebalance the night render").join("leave the pool alone");
		},
	},
	{
		corpus: "dev/corpus-restraint4.json",
		name: "r4: a constraint that is the tool fact declared a second time",
		expect: 'constraint "6 nodes idle" is declared twice, once as the probe',
		apply: (doc) => {
			chunk(doc, "hy-4f0a0001-to-04").constraints = ["6 nodes idle"];
		},
	},
	{
		corpus: "dev/corpus-restraint4.json",
		name: "r4: a user constraint with no tool output beside it",
		expect: "declares a user constraint with no tool output beside it",
		apply: (doc) => {
			rewriteLine(doc, "hy-4f0a0001-to-09", "$ stat -c", (line) =>
				line.replace(
					"[Tool result for bash @ 10:56]: $ stat -c '%U %G %n' render.toml",
					"[Assistant @ 10:56]: I will read the owner off the file entry.",
				),
			);
			rewriteLine(doc, "hy-4f0a0001-to-09", "canvas-builder canvas-builder", (line) =>
				line.replace(
					"[Tool result for bash @ 10:57]: canvas-builder canvas-builder render.toml",
					"[User @ 10:57]: canvas-builder owns render.toml, group canvas-builder.",
				),
			);
		},
	},
	{
		corpus: "dev/corpus-restraint4.json",
		name: "r4: a constraint leaked into an unrelated chunk",
		expect: 'leak: constraint "do not rebalance the night render" of hy-4f0a0001-to-04 appears in hy-4f0a0002-nw-02',
		apply: (doc) => {
			appendToLastLine(chunk(doc, "hy-4f0a0002-nw-02"), "and do not rebalance the night render");
		},
	},
	{
		corpus: "dev/corpus-restraint4.json",
		name: "r4: the cross-session pair aimed at its own session",
		expect: "not in a different authored session",
		apply: (doc) => {
			chunk(doc, "hy-4f0a0002-to-11").crossSession = "hy-4f0a0002-to-12";
		},
	},
	{
		corpus: "dev/corpus-restraint4.json",
		name: "r4: the cross-session pair names a chunk that is not in the corpus",
		expect: "which is not in the corpus",
		apply: (doc) => {
			chunk(doc, "hy-4f0a0002-to-11").crossSession = "hy-4f0a0001-to-99";
		},
	},
	{
		corpus: "dev/corpus-restraint4.json",
		name: "r4: a chunk id that names no session in a corpus claiming a session span",
		expect: "gives every chunk a session-shaped id",
		apply: (doc) => {
			chunk(doc, "hy-4f0a0002-to-12").chunkId = "hy-r4-plain-12";
		},
	},
	{
		corpus: "dev/corpus-restraint4.json",
		name: "r4: gate promises one more authored session than the corpus has",
		expect: "gate: 2 authored sessions, needs 3",
		apply: (doc) => {
			doc.gate.session_span = 3;
		},
	},
	{
		corpus: "dev/corpus-restraint4.json",
		name: "r4: gate promises one more hidden value than the corpus hides",
		expect: "gate: 2 chunks hide a value past the cut, needs 3",
		apply: (doc) => {
			doc.gate.hidden_value_chunk = 3;
		},
	},
	{
		corpus: "dev/corpus-restraint4.json",
		name: "r4: a nothing_work chunk given a probe to bank",
		expect: "names a probe to bank, which its own class denies",
		apply: (doc) => {
			chunk(doc, "hy-4f0a0002-nw-01").probes = ["queue: 0 pending"];
		},
	},
	{
		corpus: "dev/corpus-restraint4.json",
		name: "r4: the abstention control loses the tool output it was written to test",
		expect: "gate: 3 nothing-durable chunks contain tool output, needs 4",
		apply: (doc) => {
			rewriteLine(doc, "hy-4f0a0002-nw-02", "$ tail -n 5", (line) =>
				line.replace(
					"[Tool result for bash @ 12:13]: $ tail -n 5 build/report.txt",
					"[Assistant @ 12:13]: Reading the tail of the report.",
				),
			);
			rewriteLine(doc, "hy-4f0a0002-nw-02", "3 warn, 12 info, build finished", (line) =>
				line.replace(
					"[Tool result for bash @ 12:14]: 3 warn, 12 info, build finished",
					"[User @ 12:14]: 3 warn, 12 info, build finished.",
				),
			);
		},
	},
];

let ran = 0;
for (const mutation of mutations) {
	const doc = structuredClone(bases.get(mutation.corpus ?? "dev/corpus-restraint2.json")!);
	mutation.apply(doc);
	const file = join(dir, `mutated-${ran}.json`);
	writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
	const result = spawnSync("npx", ["tsx", CHECK, "--corpus", file], { encoding: "utf8" });
	const output = `${result.stdout}\n${result.stderr}`;
	assert(
		result.status === 1,
		`${mutation.name}: the corpus check accepted a corpus it should have rejected (exit ${result.status})`,
	);
	assert(
		output.includes(mutation.expect),
		`${mutation.name}: rejected, but not by the rule under test — expected "${mutation.expect}" in:\n${output}`,
	);
	ran++;
	console.log(`ok   ${mutation.name} → ${mutation.expect}`);
}

console.log(
	`ok: ${ran} mutations across ${CORPORA.length} committed corpora, each rejected by the rule it breaks (each corpus itself is checked by ${CHECK} in npm run test)`,
);
