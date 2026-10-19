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

import { compactionBoundary, compactionWindow, entryTokens, serializeEntries } from "../src/entries.js";

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

// 7) A backlog larger than one chunk must not turn compaction into a no-op.
//    Reproduces session 01a1510e (2026-10-19): the watermark sat 255 entries
//    behind, the safe window kept ~104 000 real tokens, and pi re-compacted six
//    times in 37 seconds because the context stayed over its threshold.
{
	const entries: SessionEntry[] = [];
	for (let i = 0; i < 400; i++) entries.push(i % 2 === 0 ? message(`m${i}`, 200) : toolResult(`t${i}`, 200));
	// Watermark at 100, pi wants to cut at 300: 200 uncovered entries at risk.
	const choice = compactionBoundary(entries, {
		cursorId: "m100",
		keepRecentTokens: 600,
		proposedId: "m300",
		maxUncoveredTokens: 5000,
	});
	check("large backlog accepts pi's cut", choice.boundary, "proposed");
	check("large backlog keeps pi's boundary", entries[choice.firstKeptIndex].id, "m300");
	check(
		"large backlog reports the gap",
		{ from: choice.gap?.fromId, after: choice.gap?.toId },
		{ from: "m300", after: "m100" },
	);
	check("large backlog gap counts dropped entries", choice.gap?.entries, 200);
	// The point of the switch: the tail pi keeps is smaller than the safe window
	// would have kept, so the post-compaction context can fall below the threshold.
	check("proposed keeps less than the safe window", choice.used < compactionWindow(entries, "m100", 600).used, true);
}

// 8) A small backlog is still worth holding: nothing is dropped for a few entries.
{
	const entries: SessionEntry[] = [];
	for (let i = 0; i < 400; i++) entries.push(message(`m${i}`, 200));
	const choice = compactionBoundary(entries, {
		cursorId: "m295",
		keepRecentTokens: 600,
		proposedId: "m300",
		maxUncoveredTokens: 5000,
	});
	check("small backlog keeps the cursor", choice.boundary, "cursor");
	check("small backlog drops nothing", choice.gap, undefined);
	check("small backlog clamps to the watermark", entries[choice.firstKeptIndex].id, "m295");
}

// 9) No watermark in the branch: the safe walk stands, since covered and
//    uncovered cannot be told apart.
{
	const entries: SessionEntry[] = [];
	for (let i = 0; i < 400; i++) entries.push(message(`m${i}`, 200));
	const choice = compactionBoundary(entries, {
		cursorId: "gone",
		keepRecentTokens: 600,
		proposedId: "m300",
		maxUncoveredTokens: 0,
	});
	check("missing cursor never claims a gap", choice.boundary, "cursor");
	check("missing cursor keeps no gap record", choice.gap, undefined);
}

// 10) Sizing must not inherit the serialization clip. A large tool result is a
//     few thousand real tokens for the window, but only maxEntryChars in a chunk;
//     conflating the two is what made observeAfterTokens fire ~22 000 tokens in.
{
	const big = toolResult("big", 7500); // ~30 000 chars
	check("sizing counts the whole entry", entryTokens(big) > 7000, true);
	const chunk = serializeEntries([big], { maxTokens: 100000, maxEntryChars: 1000 });
	check("the chunk still clips it", chunk.chars < 1200, true);
}

console.log(failures === 0 ? "ok: compaction window" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
