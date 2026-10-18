#!/usr/bin/env node
/**
 * Compaction window check. Run: npx tsx tools/compaction-window-check.ts
 *
 * Reproduces session 01a14a46 (2026-10-17): the backward token walk chose
 * firstKeptIndex 328 while the last write's watermark was entry 315, so 12
 * entries — 4 of them substantive tool results — were removed from the branch
 * before any chunk covered them. The bank never learned them.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { compactionWindow, entryTokens } from "../src/entries.js";

/** A user message whose rendered form is ~`tokens` tokens (4 chars/token). */
function message(id: string, tokens: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(1700000000000).toISOString(),
		message: { role: "user", content: "x".repeat(tokens * 4) },
	} as unknown as SessionEntry;
}

/** Tool results are what carry the evidence; they matter more than bookkeeping. */
function toolResult(id: string, tokens: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(1700000000000).toISOString(),
		message: { role: "toolResult", toolName: "read", content: "y".repeat(tokens * 4) },
	} as unknown as SessionEntry;
}

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

// 1) Watermark older than the token window: the window must be clamped back so
//    the cursor entry survives and nothing unprocessed is dropped.
{
	const entries = [...Array.from({ length: 100 }, (_, i) => message(`m${i}`, 100))];
	const cursor = "m60";
	const { firstKeptIndex } = compactionWindow(entries, cursor, 500); // ~5 entries by tokens
	check("clamps to watermark", entries[firstKeptIndex].id, cursor);
}

/** The budget must be tight: kept fits, adding one more entry does not. */
function assertTight(name: string, entries: SessionEntry[], firstKeptIndex: number, used: number, budget: number) {
	const fits = used <= budget;
	const oneMoreBreaks = firstKeptIndex === 0 || used + entryTokens(entries[firstKeptIndex - 1]) > budget;
	check(name, { fits, oneMoreBreaks }, { fits: true, oneMoreBreaks: true });
}

// 2) Watermark inside the token window: the token budget wins, unchanged.
{
	const entries = [...Array.from({ length: 100 }, (_, i) => message(`m${i}`, 100))];
	const { firstKeptIndex, used } = compactionWindow(entries, "m99", 500);
	// Not at the start: the cursor is simply inside the window either way.
	check("cursor stays in window", firstKeptIndex + 5 >= 99, true);
	assertTight("keeps token window", entries, firstKeptIndex, used, 500);
}

// 3) No watermark yet: plain token walk, no crash.
{
	const entries = [...Array.from({ length: 20 }, (_, i) => message(`m${i}`, 100))];
	const { firstKeptIndex, used } = compactionWindow(entries, undefined, 500);
	assertTight("no watermark", entries, firstKeptIndex, used, 500);
}

// 4) Cursor already dropped (defensive): fall back to the token walk.
{
	const entries = [...Array.from({ length: 20 }, (_, i) => message(`m${i}`, 100))];
	const { firstKeptIndex, used } = compactionWindow(entries, "gone", 500);
	assertTight("missing cursor", entries, firstKeptIndex, used, 500);
}

// 5) The real shape: bookkeeping entries around substantive tool results.
{
	const entries: SessionEntry[] = [];
	for (let i = 0; i < 320; i++) entries.push(message(`m${i}`, 200));
	entries.push(toolResult("cursor", 200));
	for (let i = 316; i < 328; i++) entries.push(i % 4 === 0 ? message(`b${i}`, 50) : toolResult(`t${i}`, 400));
	for (let i = 328; i < 420; i++) entries.push(message(`n${i}`, 200));
	const { firstKeptIndex } = compactionWindow(entries, "cursor", 5000);
	check("nothing unprocessed dropped", entries[firstKeptIndex].id, "cursor");
	const kept = entries.length - firstKeptIndex;
	check("kept window covers post-watermark entries", kept >= 12 + (420 - 328) - 4, true);
}

// 6) Entries that render to nothing must not inflate the kept budget to zero.
{
	const entries = [message("a", 100), message("b", 100)];
	const { firstKeptIndex } = compactionWindow(entries, "a", 100000);
	check("everything fits", firstKeptIndex, 0);
}

console.log(failures === 0 ? "ok: compaction window" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
