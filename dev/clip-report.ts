#!/usr/bin/env npx tsx

/**
 * dev/clip-report.ts — tier 4's offline half: how often the writer's view is cut, measured on real
 * captured sessions.
 *
 * src/entries.ts clips two things. Message and tool-result bodies go through clip() at maxEntryChars
 * (default 3000) and keep a visible `…`. Tool call arguments are cut at a window — 240 characters when these
 * captures were taken, 600 since the 2026-10-24 arm — and a cut call now carries clip()'s marker, so it reads
 * as a long call rather than as JSON that never closes. These captures were rendered before that marker
 * shipped and at the window in force when they were taken, so `cappedMarked` is the count of cuts that already
 * carried it and `ARGS_CAP` below is that historical window, not the shipped one: the numbers say how the
 * captures were made, not what ships today.
 *
 * The measurement asks how often that second cut fires in real sessions and where it lands. Captures are
 * the chunk texts the writer was actually given, so a call whose arguments stop being parseable JSON is a
 * call the clip cut. Nothing here needs a model: it reads files that already exist.
 *
 * It prints counts and lengths only. Captured command text is never printed, because captures hold real
 * sessions and this tool's output is meant to be pasted into a commit.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ARGS_WINDOW } from "../src/entries.js";

/** The window these captures were rendered at: 240, the window in force before the 2026-10-24 arm. */
const ARGS_CAP = 240;
const SHIPPED_WINDOW = ARGS_WINDOW;
const BODY_CAP = 3000;

export interface ClipStats {
	captures: number;
	lines: number;
	calls: number;
	/** arguments the writer could still parse as JSON: the cap was not reached. */
	whole: number;
	/** arguments whose JSON never closed: the cap cut them, and no marker says so. */
	capped: number;
	/** of the capped ones, the cut falls inside a quoted string — mid-command, mid-path. */
	cutInsideString: number;
	/** captures holding at least one capped call. */
	capturesWithCapped: number;
	/** longest arguments the writer saw whole. */
	longestWhole: number;
	/** how many whole calls were within 40 chars of the cap: near-misses, not short calls. */
	nearCap: number;
	/** lines carrying the visible … from clip(). */
	bodyClipped: number;
	/** how many lines would have been over the body cap had they carried their own cap. */
	longestLine: number;
	/** cut calls whose result the writer was shown on the following line anyway. */
	cappedThenResult: number;
	/** cut calls where a flag the writer could not see in the arguments appears in that result. */
	cappedFlagInResult: number;
	/** of the cut ones, how many carried clip()'s marker in the text as captured. Captures predate the
	 * marker shipping in src/entries.ts, so this reads how they were rendered, not what ships today. */
	cappedMarked: number;
}

/** Rendered chunk texts live in capture files as { chunkId, text, refs, ... }. */
export function readCaptures(root: string): { file: string; text: string }[] {
	const out: { file: string; text: string }[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 3) return;
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const path = join(dir, name);
			const st = statSync(path);
			if (st.isDirectory()) walk(path, depth + 1);
			else if (name.endsWith(".json")) {
				try {
					const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
						const text = (parsed as { text?: unknown }).text;
						if (typeof text === "string" && text.startsWith("[")) out.push({ file: name, text });
					}
				} catch {
					// not a capture
				}
			}
		}
	};
	walk(root, 0);
	return out;
}

/**
 * Read one JSON object from a slice of text; return its length, or null when it never closes.
 *
 * The scan is bounded at the next `[called ` on the line. Unbounded, a call the clip cut mid-string
 * keeps walking into the next call's arguments and closes on *their* brace, which reads as a whole call
 * of impossible length — this instrument first reported 500 characters of arguments against a 240
 * character cap.
 */
function wholeJsonObject(text: string, from: number): number | null {
	const start = text.indexOf("{", from);
	if (start < 0) return null;
	const next = text.indexOf("[called ", start + 1);
	const bound = next < 0 ? text.length : next;
	const end = scanObject(text, start, bound);
	return end === null ? null : end - start;
}

/**
 * A JSON scanner, not JSON.parse: the question is whether the writer's text closes, and a parser that
 * throws on the first truncated call cannot count the truncated ones.
 */
function scanObject(text: string, start: number, bound: number): number | null {
	const stack: string[] = [];
	let inString = false;
	let escaped = false;
	// Closers have to match their openers. The rendered line ends each call with the `]` that closes
	// `[called name …}`, so a depth-only scan closes a cut JSON object on that wrapper instead of
	// reporting the cut — measured here as a "whole" call of 241 characters against a 240 cap.
	for (let i = start; i < bound; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") stack.push("}");
		else if (ch === "[") stack.push("]");
		else if (ch === "}" || ch === "]") {
			if (stack.pop() !== ch) return null;
			if (stack.length === 0) return i + 1;
		}
	}
	return null;
}

export function measureCaptures(captures: { file: string; text: string }[]): ClipStats {
	const stats: ClipStats = {
		captures: captures.length,
		lines: 0,
		calls: 0,
		whole: 0,
		capped: 0,
		cutInsideString: 0,
		capturesWithCapped: 0,
		longestWhole: 0,
		nearCap: 0,
		bodyClipped: 0,
		longestLine: 0,
		cappedThenResult: 0,
		cappedFlagInResult: 0,
		cappedMarked: 0,
	};

	for (const capture of captures) {
		let cappedHere = 0;
		const lines = capture.text.split("\n");
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			stats.lines++;
			stats.longestLine = Math.max(stats.longestLine, line.length);
			if (line.endsWith("…")) stats.bodyClipped++;
			const next = lines[index + 1] ?? "";
			const showsResult = next.includes("[Tool result for");

			let at = 0;
			while (true) {
				const found = line.indexOf("[called ", at);
				if (found < 0) break;
				const brace = line.indexOf("{", found);
				if (brace < 0) break;
				const whole = wholeJsonObject(line, brace);
				stats.calls++;
				if (whole === null) {
					stats.capped++;
					cappedHere++;
					// The marker would sit at the character right after the window's characters.
					if (line[brace + ARGS_CAP] === "…") stats.cappedMarked++;
					// The cut fell inside an open quoted string if the quotes left on this line are odd.
					if ((line.slice(brace).match(/(?<!\\)"/g) ?? []).length % 2 === 1) stats.cutInsideString++;
					if (showsResult) {
						stats.cappedThenResult++;
						const visible = line.slice(brace, brace + ARGS_CAP);
						const flags = new Set(next.match(/--[a-z][a-z0-9-]{1,}/g) ?? []);
						if ([...flags].some((flag) => !visible.includes(flag))) stats.cappedFlagInResult++;
					}
					at = found + 8;
				} else {
					stats.whole++;
					stats.longestWhole = Math.max(stats.longestWhole, whole);
					if (whole >= ARGS_CAP - 40) stats.nearCap++;
					at = brace + whole;
				}
			}
		}
		if (cappedHere > 0) stats.capturesWithCapped++;
	}
	return stats;
}

function main(): void {
	const argv = process.argv.slice(2);
	const at = argv.indexOf("--dir");
	const root = at >= 0 ? argv[at + 1] : "captures-dev";
	const captures = readCaptures(root);
	if (captures.length === 0) {
		console.error(
			`no captured chunk texts under ${root} — this instrument measures real sessions, not authored corpora`,
		);
		process.exit(2);
	}
	const s = measureCaptures(captures);
	const pct = (n: number, of: number) => `${((100 * n) / Math.max(of, 1)).toFixed(1)}%`;

	console.log(`captured chunk texts read: ${s.captures}, rendered lines: ${s.lines}`);
	console.log(
		`tool calls the writer was shown: ${s.calls}; whole JSON: ${s.whole}; cut at ${ARGS_CAP}: ` +
			`${s.capped} (${pct(s.capped, s.calls)}), of them carrying the marker in the text as captured: ${s.cappedMarked}`,
	);
	console.log(
		`  of the cut ones, the cut falls inside a quoted string: ${s.cutInsideString} (${pct(s.cutInsideString, s.capped)})`,
	);
	console.log(
		`  captures holding at least one cut call: ${s.capturesWithCapped} of ${s.captures} (${pct(s.capturesWithCapped, s.captures)})`,
	);
	console.log(
		`  of the cut calls, ones whose own result the writer was shown on the next line: ${s.cappedThenResult};` +
			` of those, ones whose result carries a flag the visible arguments did not: ${s.cappedFlagInResult}`,
	);
	console.log(
		`  longest arguments the writer saw whole: ${s.longestWhole} chars; whole calls within 40 of the cap: ${s.nearCap}`,
	);
	if (s.longestWhole > ARGS_CAP)
		console.log(
			`  FAIL: a whole call measured ${s.longestWhole} chars, past the ${ARGS_CAP} character cap — the scan ran past a cut call`,
		);
	console.log(
		`  lines carrying clip()'s visible … at ${BODY_CAP}: ${s.bodyClipped}; longest rendered line: ${s.longestLine} chars`,
	);
	console.log(
		`   reading: a cut call reaches the end of its JSON with no closing brace. These captures were ` +
			`rendered while that cut carried no marker at all (${s.cappedMarked} of ${s.capped} marked), which is ` +
			"what the writer had to notice; src/entries.ts now leaves clip()'s marker on a cut call, so a long " +
			"call and a broken one are no longer the same text.",
	);
	console.log(
		"   the flag figure bounds the writer's other route, not the loss: a flag readable in a result line " +
			"says the writer had a way to learn that flag, not that the removed tail held it.",
	);
	console.log(
		"   reported, not gated: captures show that the cut fires and where it lands. Whether the removed " +
			"tail carried anything the writer needed is a different question, answered by the fixture in " +
			"tools/clip-check.ts rather than by these counts.",
	);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
