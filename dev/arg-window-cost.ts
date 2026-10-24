#!/usr/bin/env npx tsx
/**
 * dev/arg-window-cost.ts — what a wider argument window would cost, measured on the entries as they are
 * actually written rather than on the text the renderer already cut.
 *
 * `dev/clip-report.ts` counts how often the shipped 240-character window cuts a call, but it reads captured
 * chunk texts, which are already cut: the full argument list is not in them, so the captures cannot say what
 * a wider window would have added. pi's session files hold the real entries, and those carry the whole
 * `arguments` object. This reads them and prices the two windows directly:
 *
 *   extra chars   what a 600-character window would show that a 240-character one does not, per call
 *   still cut     calls past 600 characters, which the wider window would still remove the tail of
 *
 * It prints counts and lengths only. Session files are real sessions: no command text, no file path, no
 * argument content is printed, and nothing is written.
 *
 *   npx tsx dev/arg-window-cost.ts [--root DIR] [--narrow N] [--wide N]
 *
 * It defaults to the pair the shipped window replaced and the shipped window itself, so re-running it
 * reproduces the price recorded in `EXPERIMENTS.md` rather than comparing the shipped window to itself.

 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ARGS_WINDOW } from "../src/entries.js";
import { estimateTokens } from "../src/types.js";
import { REPLACED_WINDOW } from "./clip-window-report.js";

export interface WindowCost {
	files: number;
	/** Files carrying at least one tool call. */
	filesWithCalls: number;
	calls: number;
	/** Calls the narrow window shows whole. */
	wholeNarrow: number;
	/** Calls the narrow window cuts. */
	cutNarrow: number;
	/** Calls the wide window would still cut. */
	cutWide: number;
	/** Characters the wide window shows and the narrow one does not, summed over the calls the narrow cut. */
	extraChars: number;
	/** The same, in the same token estimate the extension budgets with. */
	extraTokens: number;
	/** Longest argument list seen. */
	longest: number;
	/** Argument-list length, summed over every call: the denominator for "per call". */
	totalChars: number;
}

function argStrings(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const p = part as Record<string, unknown>;
		if (p.type !== "toolCall") continue;
		out.push(JSON.stringify(p.arguments ?? p.args ?? {}));
	}
	return out;
}

/** Every session file under `root`, one level of project directories deep. */
export function sessionFiles(root: string): string[] {
	const out: string[] = [];
	for (const dir of readdirSync(root)) {
		const at = join(root, dir);
		try {
			if (!statSync(at).isDirectory()) continue;
		} catch {
			continue;
		}
		for (const file of readdirSync(at)) {
			if (!file.endsWith(".jsonl")) continue;
			const path = join(at, file);
			try {
				if (statSync(path).isFile()) out.push(path);
			} catch {}
		}
	}
	return out.sort();
}

/**
 * Price the two windows over real entries. Only assistant messages carry tool calls the renderer shows, so
 * only those are counted — a tool result's own text goes through the body clip, which is not what is priced
 * here.
 */
export function priceWindows(files: string[], narrow: number, wide: number): WindowCost {
	const stats: WindowCost = {
		files: files.length,
		filesWithCalls: 0,
		calls: 0,
		wholeNarrow: 0,
		cutNarrow: 0,
		cutWide: 0,
		extraChars: 0,
		extraTokens: 0,
		longest: 0,
		totalChars: 0,
	};
	for (const file of files) {
		let text = "";
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		let sawCall = false;
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (entry.type !== "message") continue;
			const message = entry.message as { role?: string; content?: unknown } | undefined;
			if (message?.role !== "assistant") continue;
			for (const args of argStrings(message.content)) {
				stats.calls++;
				sawCall = true;
				const length = args.length;
				stats.totalChars += length;
				if (length > stats.longest) stats.longest = length;
				if (length > narrow) {
					stats.cutNarrow++;
					stats.extraChars += Math.min(length, wide) - narrow;
					if (length > wide) stats.cutWide++;
				} else {
					stats.wholeNarrow++;
				}
			}
		}
		if (sawCall) stats.filesWithCalls++;
	}
	stats.extraTokens = stats.extraChars === 0 ? 0 : estimateTokens("x".repeat(stats.extraChars));
	return stats;
}

function numArg(flag: string, fallback: number): number {
	const at = process.argv.indexOf(flag);
	return at >= 0 && process.argv[at + 1] !== undefined ? Number(process.argv[at + 1]) : fallback;
}

function main(): void {
	const rootFlag = process.argv.indexOf("--root");
	const root = rootFlag >= 0 ? (process.argv[rootFlag + 1] ?? "") : join(homedir(), ".pi", "agent", "sessions");
	const narrow = numArg("--narrow", REPLACED_WINDOW);
	const wide = numArg("--wide", ARGS_WINDOW);
	const s = priceWindows(sessionFiles(root), narrow, wide);
	const pct = (n: number, d: number) => (d === 0 ? "-" : `${Math.round((100 * n) / d)}%`);

	console.log(
		`session files read: ${s.files}, files carrying at least one tool call: ${s.filesWithCalls}; calls shown to the writer: ${s.calls}`,
	);
	console.log(
		`  argument length over all calls: ${s.totalChars} chars, longest call ${s.longest}; whole at ${narrow}: ${s.wholeNarrow}, cut at ${narrow}: ${s.cutNarrow} (${pct(s.cutNarrow, s.calls)})`,
	);
	console.log(
		`  a ${wide}-character window would add ${s.extraChars} characters to what the writer is shown — ${s.extraTokens} tokens, ${pct(s.extraTokens, Math.round(s.totalChars / 4))} of the tokens every call's arguments already cost`,
	);
	console.log(
		`  calls a ${wide}-character window would still cut: ${s.cutWide} (${pct(s.cutWide, s.calls)}) — a wider window removes a smaller tail, it does not end the cut`,
	);
	console.log(
		`  calls the wider window shows whole that the narrow one cut: ${s.cutNarrow - s.cutWide} (${pct(s.cutNarrow - s.cutWide, s.cutNarrow)} of what ${narrow} removed)`,
	);
	console.log(
		"   reading: this is the render cost of the wider window, counted on entries that were never clipped. What it",
	);
	console.log(
		"   buys is measured separately, by rendering the same chunks at both windows and reading the two banks:",
	);
	console.log(
		"   dev/clip-window-report.ts writes the corpora, dev/run.ts runs them, dev/restraint-report.ts scores them.",
	);
}

if (process.argv[1]?.endsWith("arg-window-cost.ts")) main();
