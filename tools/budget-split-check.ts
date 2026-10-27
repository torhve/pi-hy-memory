#!/usr/bin/env node
/**
 * Budget split check. Run: npx tsx tools/budget-split-check.ts
 *
 * The file `src/budget.ts` promises in its header. The split decides what the next request after a
 * compaction contains — how much verbatim conversation, how much re-rendered fact bank, how much
 * digest of what the cut dropped — and every one of those decisions is arithmetic a live session shows
 * only as a worse answer. So the arithmetic is table-tested here: exact values at boundaries, the order
 * the parts are served in, and the properties no single row would catch.
 *
 * One section exists because of a bug this split nearly shipped with. The backward walk and the request
 * cap receive the same figure now, but the two still have different meanings: a branch longer than the
 * tail figure is cut by the walk and reports nothing, while a walk clamped back to a lagging writer's
 * cursor is cut by the cap and must report its digest, its gap and its audit line. Making
 * `trimKeptTail` never fire silently deletes those three, and section 9 pins the difference.
 *
 * Token figures are this package's `chars / 4` estimate, the same one `entryTokens` uses.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
	type BudgetInput,
	budgetSplit,
	COMPACT_KEEP_MIN_TOKENS,
	COMPACT_SLACK_TOKENS,
	COMPACT_SUMMARY_MIN_TOKENS,
	DIGEST_ENTRY_TOKENS,
	DIGEST_HEADER_TOKENS,
	DIGEST_LABEL_TOKENS,
	dropRange,
	estimateDigestTokens,
	resolveBudget,
} from "../src/budget.js";
import { type CompactionBoundary, entryTokens } from "../src/entries.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const RESERVE = 4000;
const KEEP_RECENT = 6000;
const KEEP_SHARE = 0.4;
const SUMMARY_MAX = 8000;
const DIGEST_SHARE = 1500;
const BASE = {
	reserveTokens: RESERVE,
	keepRecentTokens: KEEP_RECENT,
	keepRecentShare: KEEP_SHARE,
	summaryMaxTokens: SUMMARY_MAX,
	overflowDigestTokens: DIGEST_SHARE,
};

const split = (input: Partial<BudgetInput> & { windowTokens: number }): ReturnType<typeof budgetSplit> =>
	budgetSplit({
		reserveTokens: RESERVE,
		overheadTokens: 2000,
		keepRecentTokens: KEEP_RECENT,
		keepRecentShare: KEEP_SHARE,
		summaryMaxTokens: SUMMARY_MAX,
		overflowDigestTokens: DIGEST_SHARE,
		...input,
	});

/**
 * The committed formulas, written out here so a change to `src/budget.ts` has to be a decision rather
 * than a drift: the digest is priced down from its share, the tail asks for a share of the room the
 * digest left and is held at its floor while the room can pay one, and the note takes the rest up to
 * its own ceiling.
 */
const expected = (windowTokens: number, overheadTokens: number, digestTokens?: number) => {
	if (windowTokens <= 0) return { available: undefined, digest: 0, tail: 0, note: 0, room: 0 };
	const available = Math.max(0, windowTokens - RESERVE - overheadTokens - COMPACT_SLACK_TOKENS);
	const cap = Math.min(DIGEST_SHARE, Math.floor(available / 4));
	const digest = Math.max(0, Math.min(cap, digestTokens ?? cap));
	const room = available - digest;
	const ask = Math.max(COMPACT_KEEP_MIN_TOKENS, Math.round(KEEP_SHARE * room));
	const tail = Math.max(0, Math.min(KEEP_RECENT, ask, room - COMPACT_SUMMARY_MIN_TOKENS));
	const note = Math.max(COMPACT_SUMMARY_MIN_TOKENS, Math.min(SUMMARY_MAX, room - tail));
	return { available, digest, room, tail, note, cap };
};

// ---------------------------------------------------------------------------
// 1) The published table: every window × overhead combination, checked against the formulas. A change
//    to the order the parts are served in fails here rather than shipping a different compaction.
// ---------------------------------------------------------------------------
const WINDOWS = [16_000, 24_000, 32_000, 48_000, 64_000, 168_000];
{
	const broken: string[] = [];
	for (const windowTokens of WINDOWS) {
		for (const overheadTokens of [2000, Math.floor(windowTokens * 0.3)]) {
			const s = split({ windowTokens, overheadTokens });
			const want = expected(windowTokens, overheadTokens);
			const available = s.available ?? -1;
			const label = `${windowTokens} / overhead ${overheadTokens}`;
			const room = available - s.digestTokens;
			if (!Number.isInteger(available) || !Number.isInteger(s.tailTokens)) broken.push(`${label}: non-integer`);
			if (s.digestTokens !== want.digest) broken.push(`${label}: digest ${s.digestTokens} ≠ ${want.digest}`);
			if (room !== want.room) broken.push(`${label}: room ${room} ≠ ${want.room}`);
			if (s.tailTokens !== want.tail) broken.push(`${label}: tail ${s.tailTokens} ≠ ${want.tail}`);
			if (s.summaryTokenBudget !== want.note)
				broken.push(`${label}: note ${s.summaryTokenBudget} ≠ ${want.note}`);
			if (s.digestTokens + s.tailTokens + s.summaryTokenBudget > available)
				broken.push(`${label}: parts add to more than the room`);
			if (s.digestTokens > Math.floor(available / 4) || s.digestTokens > DIGEST_SHARE)
				broken.push(`${label}: the digest broke its own ceiling`);
			if (s.tailTokens < 0) broken.push(`${label}: the tail went negative`);
			if (s.summaryTokenBudget < COMPACT_SUMMARY_MIN_TOKENS)
				broken.push(`${label}: the note fell below its minimum`);
			if (s.summaryTokenBudget > SUMMARY_MAX) broken.push(`${label}: the note broke its ceiling`);
			// Every window in this table can pay the tail's floor out of the room the digest left.
			if (room >= COMPACT_KEEP_MIN_TOKENS + COMPACT_SUMMARY_MIN_TOKENS && s.tailTokens < COMPACT_KEEP_MIN_TOKENS)
				broken.push(`${label}: the tail lost its floor in a room that could pay it`);
			// The tail never takes more than it asked for. The floor may lift it above the share; only
			// that and the two ceilings can move it off `share × room`.
			if (s.tailTokens > Math.max(COMPACT_KEEP_MIN_TOKENS, Math.round(KEEP_SHARE * room)))
				broken.push(`${label}: the tail took more than its share of ${room}`);
			if (s.underprovisioned !== room < COMPACT_KEEP_MIN_TOKENS + COMPACT_SUMMARY_MIN_TOKENS)
				broken.push(`${label}: underprovisioned disagrees with the room`);
		}
	}
	check("table holds at every window × overhead", broken, []);
}

// ---------------------------------------------------------------------------
// 2) Exact values, so the shape is written down rather than inferred from invariants. The first pair is
//    the overflow fixture: a 12 000-token window with a measured 2 500-token overhead, where the tail
//    ends up with exactly its floor and the note takes everything else.
// ---------------------------------------------------------------------------
{
	const fixture = budgetSplit({
		windowTokens: 12_000,
		reserveTokens: 1000,
		overheadTokens: 2500,
		keepRecentTokens: 6000,
		keepRecentShare: KEEP_SHARE,
		summaryMaxTokens: 8000,
		overflowDigestTokens: 1500,
	});
	check(
		"12k window, measured overhead: the digest takes its share, the tail 40% of what is left",
		{
			available: fixture.available,
			tail: fixture.tailTokens,
			note: fixture.summaryTokenBudget,
			digest: fixture.digestTokens,
		},
		{ available: 7000, tail: 2200, note: 3300, digest: 1500 },
	);

	const heavy = split({ windowTokens: 16_000, overheadTokens: 4800 });
	check(
		"16k window, heavy prompt: the share moves with the room, not with the ceiling",
		{
			available: heavy.available,
			tail: heavy.tailTokens,
			note: heavy.summaryTokenBudget,
			digest: heavy.digestTokens,
		},
		{ available: 5700, tail: 1710, note: 2565, digest: 1425 },
	);

	// A roomy window: both ceilings bite at once and the room beyond them is left unbudgeted — 9 000
	// tokens of the 24 500 are spent on nothing, which is the point. Spending the window down to the
	// trigger would put the next request back at the threshold and compact again on the next turn.
	const big = split({ windowTokens: 32_000 });
	check(
		"32k window: the tail's ceiling and the note's ceiling both bite, and the surplus is not spent",
		{
			tail: big.tailTokens,
			note: big.summaryTokenBudget,
			spare: (big.available ?? 0) - big.tailTokens - big.summaryTokenBudget - big.digestTokens,
		},
		{ tail: 6000, note: 8000, spare: 9000 },
	);
}

// ---------------------------------------------------------------------------
// 2b) The published window table in DESIGN_HYVCC.md, reproduced row for row with pi's default
//     `reserveTokens: 16 384` and hy's defaults. The tail column is the figure the backward walk stops
//     at, which is also the most a long branch can deliver: `resolveBudget` hands that same number to
//     `compactionBoundary` as both the walk target and the request cap. What the model actually gets is
//     that figure or the branch, whichever is smaller. A table published in a design document has to be
//     recomputable by a harness.
// ---------------------------------------------------------------------------
{
	const PI_RESERVE = 16_384;
	const PI_DEFAULTS = {
		reserveTokens: PI_RESERVE,
		keepRecentTokens: 20_000,
		keepRecentShare: 0.4,
		summaryMaxTokens: 12_000,
		overflowDigestTokens: 1_500,
	};
	const rows = [
		// window, overhead, available, tail asked, note, digest
		[16_000, 2_000, 0, 0, 500, 0],
		[24_000, 2_000, 4_116, 1_235, 1_852, 1_029],
		[32_000, 2_000, 12_116, 4_246, 6_370, 1_500],
		[32_000, 9_600, 4_516, 1_355, 2_032, 1_129],
		[36_000, 2_000, 16_116, 5_846, 8_770, 1_500],
		[168_000, 2_016, 148_100, 20_000, 12_000, 1_500],
	] as const;
	const broken: string[] = [];
	for (const [windowTokens, overheadTokens, available, tail, note, digest] of rows) {
		const s = budgetSplit({ windowTokens, overheadTokens, ...PI_DEFAULTS });
		const label = `${windowTokens} / overhead ${overheadTokens}`;
		if (s.available !== available) broken.push(`${label}: available ${s.available} ≠ ${available}`);
		if (s.tailTokens !== tail) broken.push(`${label}: tail asked ${s.tailTokens} ≠ ${tail}`);
		if (s.summaryTokenBudget !== note) broken.push(`${label}: note ${s.summaryTokenBudget} ≠ ${note}`);
		if (s.digestTokens !== digest) broken.push(`${label}: digest ${s.digestTokens} ≠ ${digest}`);
	}
	check("the published window table reproduces from budgetSplit", broken, []);

	// On a small room every token of it is spent; on a wide one the tail stops asking at its ceiling
	// and 114 600 tokens are left unbudgeted. That surplus is deliberate: filling the window to the
	// trigger makes the next request land on the threshold again, so a compaction that trims every
	// turn is worse than one that leaves room and holds.
	const wide = budgetSplit({ windowTokens: 168_000, overheadTokens: 2_016, ...PI_DEFAULTS });
	const narrow = budgetSplit({ windowTokens: 32_000, overheadTokens: 2_000, ...PI_DEFAULTS });
	const spare = (s: ReturnType<typeof budgetSplit>) =>
		(s.available ?? 0) - s.digestTokens - s.tailTokens - s.summaryTokenBudget;
	check(
		"the tail's ask follows the room until its ceiling holds it flat, and the surplus is not spent",
		{
			narrowAsk: narrow.tailTokens,
			narrowSpare: spare(narrow),
			wideAsk: wide.tailTokens,
			wideSpare: spare(wide),
		},
		{ narrowAsk: 4_246, narrowSpare: 0, wideAsk: 20_000, wideSpare: 114_600 },
	);
}
// ---------------------------------------------------------------------------
// 3) Who gives way. The tail is priced first at its share, so a room that shrinks by 100 takes 40
//    from the tail and 60 from the note — the note absorbs the difference because it takes the
//    residual. The tail's floor outranks its share, and the note's minimum outranks the tail's floor:
//    below 1 500 tokens of room the tail is the thing that goes under its floor, and
//    `underprovisioned` says so out loud.
// ---------------------------------------------------------------------------
{
	const atCap = split({ windowTokens: 12_000, reserveTokens: 0, overheadTokens: 0 });
	check(
		"room of 9 000 after the digest: the tail takes its 40%, the note the rest",
		{
			available: atCap.available,
			room: atCap.available! - atCap.digestTokens,
			note: atCap.summaryTokenBudget,
			tail: atCap.tailTokens,
		},
		{ available: 10_500, room: 9000, note: 5400, tail: 3600 },
	);
	const below = split({ windowTokens: 11_900, reserveTokens: 0, overheadTokens: 0 });
	check(
		"100 tokens less room: the tail gives up 40, the note gives up 60",
		{
			room: below.available! - below.digestTokens,
			note: below.summaryTokenBudget,
			tail: below.tailTokens,
		},
		{ room: 8900, note: 5340, tail: 3560 },
	);
	// The note's ceiling bites before the tail's does: at 14 000 of room the tail's share is 5 600, the
	// note wants 8 400 and takes its 8 000, and the 400 left over is left unspent rather than handed to
	// the tail.
	const capped = split({ windowTokens: 17_000, reserveTokens: 0, overheadTokens: 0 });
	check(
		"room of 14 000: the note's ceiling bites first and the surplus is not spent",
		{
			room: capped.available! - capped.digestTokens,
			note: capped.summaryTokenBudget,
			tail: capped.tailTokens,
			spare: capped.available! - capped.digestTokens - capped.tailTokens - capped.summaryTokenBudget,
		},
		{ room: 14_000, note: 8000, tail: 5600, spare: 400 },
	);
	const paid = split({ windowTokens: 4500, reserveTokens: 0, overheadTokens: 0 });
	check(
		"room of 2 250: the tail's floor outranks its share (40% would be 900)",
		{
			available: paid.available,
			note: paid.summaryTokenBudget,
			tail: paid.tailTokens,
			digest: paid.digestTokens,
		},
		{ available: 3000, note: 1250, tail: 1000, digest: 750 },
	);
	const squeezed = split({ windowTokens: 2200, reserveTokens: 0, overheadTokens: 0 });
	check(
		"room of 525: the note keeps its minimum and the tail goes under its floor, and the split says so",
		{
			available: squeezed.available,
			note: squeezed.summaryTokenBudget,
			tail: squeezed.tailTokens,
			digest: squeezed.digestTokens,
			underprovisioned: squeezed.underprovisioned,
		},
		{ available: 700, note: 500, tail: 25, digest: 175, underprovisioned: true },
	);
}

// ---------------------------------------------------------------------------
// 4) The digest cap floors rather than rounds: 8 511 / 4 is 2 127.75, and a reservation that rounds up
//    is a reservation that spends room the window never had.
// ---------------------------------------------------------------------------
{
	const s = split({ windowTokens: 10_011, reserveTokens: 0, overheadTokens: 0, overflowDigestTokens: 3000 });
	check("available after the furniture", s.available, 8511);
	check("the digest cap floors, never rounds up", s.digestTokens, 2127);
}

// ---------------------------------------------------------------------------
// 5) `underprovisioned` flips at its stated threshold and nowhere else.
// ---------------------------------------------------------------------------
{
	const at = (windowTokens: number) => split({ windowTokens, reserveTokens: 0, overheadTokens: 0 });
	const roomOf = (s: ReturnType<typeof budgetSplit>) => (s.available ?? 0) - s.digestTokens;
	// The threshold is the room left by the digest, not the window: below the digest's own share the
	// reservation takes a quarter of the room, so a window and a room are different numbers here.
	check(
		"three windows landing either side of the threshold",
		[roomOf(at(3498)), roomOf(at(3500)), roomOf(at(3501))],
		[1499, 1500, 1501],
	);
	check("underprovisioned at 1 499 of room", at(3498).underprovisioned, true);
	check("not underprovisioned at 1 500", at(3500).underprovisioned, false);
	check("not underprovisioned at 1 501", at(3501).underprovisioned, false);
	check(
		"the shortfall is a tail under its floor, not a zero budget",
		{ tail: at(3498).tailTokens, note: at(3498).summaryTokenBudget },
		{ tail: 999, note: 500 },
	);
}

// ---------------------------------------------------------------------------
// 6) Degenerate inputs: the documented floors, never a negative budget.
// ---------------------------------------------------------------------------
{
	const ruined = split({ windowTokens: 5000, reserveTokens: 2000, overheadTokens: 5000 });
	check(
		"overhead larger than the window",
		{
			available: ruined.available,
			digest: ruined.digestTokens,
			tail: ruined.tailTokens,
			note: ruined.summaryTokenBudget,
			underprovisioned: ruined.underprovisioned,
		},
		{ available: 0, digest: 0, tail: 0, note: 500, underprovisioned: true },
	);
	// A room the note's floor cannot fit inside: the tail gives up everything, the note still renders at
	// its 500, and the split admits it exceeds the room rather than reporting a budget that fits.
	const starvingRoom = split({ windowTokens: 7900 });
	check(
		"a room below the note's floor leaves the tail with nothing",
		{
			available: starvingRoom.available,
			digest: starvingRoom.digestTokens,
			tail: starvingRoom.tailTokens,
			note: starvingRoom.summaryTokenBudget,
			underprovisioned: starvingRoom.underprovisioned,
		},
		{ available: 400, digest: 100, tail: 0, note: 500, underprovisioned: true },
	);
	// 0 + 500 + 100 against 400 of room: 200 over, which is the floor minus the room the digest left.
	check(
		"and the overshoot is exactly the note's floor minus the room, not a negative budget",
		starvingRoom.tailTokens +
			starvingRoom.summaryTokenBudget +
			starvingRoom.digestTokens -
			(starvingRoom.available ?? 0),
		COMPACT_SUMMARY_MIN_TOKENS - ((starvingRoom.available ?? 0) - starvingRoom.digestTokens),
	);
	const blind = split({ windowTokens: 0 });
	check(
		"model reported no window: pi's own numbers stand",
		{
			available: blind.available,
			digest: blind.digestTokens,
			tail: blind.tailTokens,
			note: blind.summaryTokenBudget,
			underprovisioned: blind.underprovisioned,
		},
		{ available: undefined, digest: 1500, tail: 6000, note: 8000, underprovisioned: false },
	);
	// A share outside 0…1 is a config mistake, and the two ends of that mistake have to stay inside the
	// split's own floors and ceilings rather than become a negative ask or a tail that swallows the note.
	const greedy = split({ windowTokens: 40_000, keepRecentShare: 3 });
	const starving = split({ windowTokens: 40_000, keepRecentShare: -1 });
	check(
		"a share above 1 becomes the whole room minus the note's minimum, capped by keepRecentTokens",
		{ tail: greedy.tailTokens, note: greedy.summaryTokenBudget },
		{ tail: 6000, note: 8000 },
	);
	check(
		"and a share below 0 becomes the floor, not a negative ask",
		{ tail: starving.tailTokens, note: starving.summaryTokenBudget },
		{ tail: 1000, note: 8000 },
	);
}

// ---------------------------------------------------------------------------
// 7) The digest is a ceiling the probe may only price down. `budgetSplit` alone reserves the share; it
//    is `resolveBudget` that can reduce it, and never below zero or above the share or a quarter of the
//    room.
// ---------------------------------------------------------------------------
{
	const reserved = split({ windowTokens: 41_500, reserveTokens: 0, overheadTokens: 0 });
	check("the first pass reserves the whole share", reserved.digestTokens, 1500);
	const asked = split({ windowTokens: 41_500, reserveTokens: 0, overheadTokens: 0, digestTokens: 900 });
	check("a small drop set gets exactly its estimate", asked.digestTokens, 900);
	const over = split({ windowTokens: 41_500, reserveTokens: 0, overheadTokens: 0, digestTokens: 2000 });
	check("the configured share is a ceiling", over.digestTokens, 1500);
	const tight = split({ windowTokens: 5500, reserveTokens: 0, overheadTokens: 0, digestTokens: 3000 });
	check(
		"a quarter of the room caps a hungry drop set",
		{ digest: tight.digestTokens, tail: tight.tailTokens, note: tight.summaryTokenBudget },
		{ digest: 1000, tail: 1200, note: 1800 },
	);
	check(
		"parts still fit with a digest charged",
		tight.digestTokens + tight.tailTokens + tight.summaryTokenBudget <= (tight.available ?? 0),
		true,
	);
	check(
		"no digest room requested is not the same as none available",
		split({ windowTokens: 41_500, reserveTokens: 0, overheadTokens: 0, digestTokens: 0 }).digestTokens,
		0,
	);
}

// ---------------------------------------------------------------------------
// 8) Monotonicity: a bigger window never hands back less tail or less note. Clamp-ordering bugs are
//    invisible row by row and obvious here.
// ---------------------------------------------------------------------------
for (const ratio of [0, 0.3]) {
	const overheadOf = (w: number) => (ratio === 0 ? 2000 : Math.floor(w * ratio));
	const tails = WINDOWS.map((w) => split({ windowTokens: w, overheadTokens: overheadOf(w) }).tailTokens);
	const notes = WINDOWS.map((w) => split({ windowTokens: w, overheadTokens: overheadOf(w) }).summaryTokenBudget);
	const neverShrinks = (values: number[]) => values.every((v, i) => i === 0 || v >= values[i - 1]);
	check(`tail never shrinks as the window grows (overhead ${overheadOf(32_000)})`, neverShrinks(tails), true);
	check(`note never shrinks as the window grows (overhead ${overheadOf(32_000)})`, neverShrinks(notes), true);
}

// ---------------------------------------------------------------------------
// 9) The walk and the cap. `keepRecentTokens` is how far the backward walk reaches; `maxKeepTokens` is
//    the request budget. `resolveBudget` hands the same figure to both, because that figure came from
//    the budget. What has to stay distinguishable is the *cause* of a cut: a branch longer than the tail
//    figure is cut by the walk and nothing is reported — that is pi's working-set behaviour, and the
//    entries past the walk leave without a digest, a gap or an audit line — while a walk clamped back to
//    a lagging writer's cursor is cut by the cap and must report all three. Folding the cap into the walk
//    so `trimKeptTail` never fires silently deletes them, which is the bug this section pins.
// ---------------------------------------------------------------------------
{
	const wide = Array.from({ length: 50 }, (_, i) => message(`w${i}`, 400));
	const loose = resolveBudget({
		base: { ...BASE, windowTokens: 168_000, reserveTokens: 0, overheadTokens: 0 },
		entries: wide,
		cursorId: "w45",
		maxUncoveredTokens: 100_000,
	});
	check(
		"a branch longer than the tail figure is cut by the walk, and that cut is not a budget trim",
		{ keptTokens: loose.choice.used, tail: loose.split.tailTokens },
		{ keptTokens: 5656, tail: 6000 },
	);
	check("a cut the walk made on its own is not reported as a budget trim", loose.choice.trimmed === undefined, true);

	const tight = resolveBudget({
		base: { ...BASE, windowTokens: 6000, reserveTokens: 0, overheadTokens: 0 },
		entries: wide,
		cursorId: "w0",
		proposedId: "w40",
		maxUncoveredTokens: 1000,
	});
	check(
		"a walk clamped back to a lagging cursor is cut by the cap, and says what it cut",
		{
			trimmedEntries: tight.choice.trimmed?.entries,
			trimmedTokens: tight.choice.trimmed?.tokens,
			keptTokens: tight.choice.used,
			unread: tight.unread.map((e) => e.id),
		},
		{
			trimmedEntries: 7,
			trimmedTokens: 2828,
			keptTokens: 1212,
			unread: ["w40", "w41", "w42", "w43", "w44", "w45", "w46"],
		},
	);
	check(
		"the trim is priced rather than assumed",
		{ digest: tight.split.digestTokens, ceiling: Math.min(1500, Math.floor((tight.split.available ?? 0) / 4)) },
		{ digest: 497, ceiling: 1125 },
	);
}

// ---------------------------------------------------------------------------
// 10) The drop set and its price.
// ---------------------------------------------------------------------------
function message(id: string, tokens: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(1_700_000_000_000).toISOString(),
		message: { role: "user", content: "x".repeat(tokens * 4) },
	} as unknown as SessionEntry;
}

const branch = Array.from({ length: 10 }, (_, i) => message(`m${i}`, 100));
const trimmedInto = (fromId: string, firstKeptIndex: number): CompactionBoundary => ({
	firstKeptIndex,
	used: 400,
	boundary: "proposed",
	trimmed: { fromId, toId: `m${firstKeptIndex - 1}`, entries: firstKeptIndex - 2, tokens: 400 },
});

{
	const untouched = dropRange(branch, { firstKeptIndex: 6, used: 400, boundary: "cursor" }, "m3");
	check(
		"no trim, nothing unread",
		{ ids: untouched.unread.map((e) => e.id), missed: untouched.lookupMissed },
		{ ids: [], missed: false },
	);
	const covered = dropRange(branch, trimmedInto("m2", 6), "m3");
	check(
		"coverage resumes at the watermark, not at the cut",
		{ ids: covered.unread.map((e) => e.id), missed: covered.lookupMissed },
		{ ids: ["m4", "m5"], missed: false },
	);
	const lost = dropRange(branch, trimmedInto("m2", 6), "m-gone");
	check(
		"a watermark the branch no longer holds is reported, not smoothed over",
		{ ids: lost.unread.map((e) => e.id), missed: lost.lookupMissed },
		{ ids: ["m2", "m3", "m4", "m5"], missed: true },
	);
	const cutGone = dropRange(branch, trimmedInto("m-gone", 6), "m3");
	check("a missing cut is reported too", cutGone.lookupMissed, true);
}

{
	const big = Array.from({ length: 4 }, () => message("big", 1000));
	check(
		"a clipped entry is priced at what the digest actually renders, not at the clip",
		estimateDigestTokens(big),
		4 * DIGEST_ENTRY_TOKENS + DIGEST_HEADER_TOKENS,
	);
	const small = [message("small", 40)];
	check(
		"an entry that fits under the clip is priced at itself plus its label",
		estimateDigestTokens(small),
		entryTokens(small[0]) + DIGEST_LABEL_TOKENS + DIGEST_HEADER_TOKENS,
	);
	check("the header is priced even for one entry", estimateDigestTokens(small) > entryTokens(small[0]), true);
	check("nothing dropped costs nothing", estimateDigestTokens([]), 0);
	check(
		"pricing the clip alone would under-cover the list it prices",
		estimateDigestTokens(big) > big.length * (240 / 4),
		true,
	);
}

// ---------------------------------------------------------------------------
// 11) Ask first, then reserve: the probe loop, the waiver, and the case where the drop set asks for more
//     than the share can give.
// ---------------------------------------------------------------------------
{
	const quiet = Array.from({ length: 20 }, (_, i) => message(`q${i}`, 200));
	const first = resolveBudget({
		base: { ...BASE, windowTokens: 41_500, reserveTokens: 0, overheadTokens: 0 },
		entries: quiet,
		cursorId: "q10",
		maxUncoveredTokens: 100_000,
	});
	check(
		"a cut that drops nothing pays for nothing",
		{
			passes: first.passes,
			converged: first.converged,
			digest: first.split.digestTokens,
			unread: first.unread.length,
		},
		{ passes: 2, converged: true, digest: 0, unread: 0 },
	);

	const busy = Array.from({ length: 20 }, (_, i) => message(`b${i}`, 400));
	const second = resolveBudget({
		base: { ...BASE, windowTokens: 6000, reserveTokens: 0, overheadTokens: 0 },
		entries: busy,
		cursorId: "b0",
		proposedId: "b15",
		maxUncoveredTokens: 1000,
	});
	check(
		"a trim discovered by the probe re-splits and settles",
		{
			passes: second.passes,
			converged: second.converged,
			digest: second.split.digestTokens,
			unread: second.unread.map((e) => e.id),
			missed: second.lookupMissed,
		},
		{ passes: 3, converged: true, digest: 95, unread: ["b15"], missed: false },
	);
	check(
		"the re-split still fits the room",
		second.split.digestTokens + second.split.tailTokens + second.split.summaryTokenBudget <=
			(second.split.available ?? 0),
		true,
	);
	check(
		"room the waiver freed is split the same way: the tail takes its share, the note the rest",
		{
			note: second.split.summaryTokenBudget,
			noteBefore: split({ windowTokens: 6000, reserveTokens: 0, overheadTokens: 0 }).summaryTokenBudget,
			tail: second.split.tailTokens,
			tailBefore: split({ windowTokens: 6000, reserveTokens: 0, overheadTokens: 0 }).tailTokens,
		},
		{ note: 2643, noteBefore: 2025, tail: 1762, tailBefore: 1350 },
	);

	// 60 entries of 204 tokens, a cut that drops eleven of them: priced at 11 × 67 + 28 = 765 tokens against a
	// quarter-room ceiling of 625. The reservation stops at the ceiling and says it converged.
	const hungry = Array.from({ length: 60 }, (_, i) => message(`h${i}`, 200));
	const third = resolveBudget({
		base: { ...BASE, windowTokens: 4000, reserveTokens: 0, overheadTokens: 0 },
		entries: hungry,
		cursorId: "h0",
		proposedId: "h45",
		maxUncoveredTokens: 1000,
	});
	check(
		"a drop set that asks for more than the share gets the share, not more",
		{
			passes: third.passes,
			converged: third.converged,
			digest: third.split.digestTokens,
			priced: estimateDigestTokens(third.unread),
			dropped: third.choice.trimmed?.entries,
		},
		{ passes: 2, converged: true, digest: 625, priced: 765, dropped: 11 },
	);

	const capped = resolveBudget({
		base: { ...BASE, windowTokens: 6000, reserveTokens: 0, overheadTokens: 0 },
		entries: busy,
		cursorId: "b0",
		proposedId: "b15",
		maxUncoveredTokens: 1000,
		maxPasses: 1,
	});
	check(
		"a probe bound that does not settle says so",
		{ passes: capped.passes, converged: capped.converged },
		{ passes: 1, converged: false },
	);
}

// ---------------------------------------------------------------------------
// 12) The wiring at the shipped defaults. `src/index.ts` hands `split.tailTokens` to both the backward
//     walk and the request cap; a pure `budgetSplit` test cannot catch a walk that still reads the raw
//     config figure, and a wide window is exactly where the difference shows — the old wiring stopped
//     at 6 000 of a 138 600-token room.
// ---------------------------------------------------------------------------
{
	const defaults = {
		reserveTokens: 16_384,
		keepRecentTokens: 20_000,
		keepRecentShare: 0.4,
		summaryMaxTokens: 12_000,
		overflowDigestTokens: 1_500,
	};
	for (const windowTokens of [168_000, 262_144]) {
		// 200 entries × 800 tokens: a branch far longer than any share of either window, so the only
		// thing that can decide the delivered tail is the split.
		const long = Array.from({ length: 200 }, (_, i) => message(`v${i}`, 800));
		const wide = resolveBudget({
			base: { ...defaults, windowTokens, overheadTokens: 2_000 },
			entries: long,
			cursorId: "v199",
			maxUncoveredTokens: 100_000,
		});
		check(
			`a ${windowTokens}-window branch delivers the tail the split asked for`,
			{ tail: wide.split.tailTokens, kept: wide.choice.used, note: wide.split.summaryTokenBudget },
			// 20 000 is the figure; the walk stops at the first entry that would cross it, and
			// `entryTokens` adds a per-entry constant on top of the 800 content tokens, so what lands is
			// 24 entries at 804 = 19 296. The tail is 96 % of the figure, not the old 6 000.
			{ tail: 20_000, kept: 19_296, note: 12_000 },
		);
		check(
			`and a ${windowTokens}-window tail is past the ceiling the old wiring stopped at`,
			wide.choice.used > 6_000,
			true,
		);
		// Tail + note + digest + the furniture has to leave the retry under pi's trigger, or the
		// compaction is the 400 it was meant to avoid.
		const request = wide.choice.used + wide.split.summaryTokenBudget + wide.split.digestTokens + 2_000 + 16_384;
		check(
			`and the request after a ${windowTokens}-window compaction stays under its window`,
			request < windowTokens,
			true,
		);
		check(
			`and a ${windowTokens}-window split never spends more than the room it was given`,
			wide.split.tailTokens + wide.split.summaryTokenBudget + wide.split.digestTokens <=
				(wide.split.available ?? 0),
			true,
		);
	}
	// An entry bigger than the tail figure: the newest entry is never dropped, but a mid-branch giant is
	// cut rather than shipped, so the overshoot is bounded by the newest entry alone and the request
	// still fits. This is the case the code reports as larger-context rather than fixing.
	const oneHuge: SessionEntry[] = [message("h0", 500), message("h1", 30_000), message("h2", 500)];
	const huge = resolveBudget({
		base: { ...defaults, windowTokens: 32_000, overheadTokens: 2_000 },
		entries: oneHuge,
		cursorId: "h2",
		maxUncoveredTokens: 100_000,
	});
	check(
		"an oversized mid-branch entry is cut, so the tail is the newest entry alone",
		{
			kept: huge.choice.used,
			firstKept: oneHuge[huge.choice.firstKeptIndex]?.id ?? null,
			tail: huge.split.tailTokens,
		},
		// 32 000 − 16 384 − 2 000 − 1 500 = 12 116 of room; nothing was unread, so the digest priced
		// itself to 0 and the tail asked 0.4 × 12 116 = 4 846. The walk reached h1, the cap cut back to
		// the newest entry, and the overshoot is that entry's own 504 tokens.
		{ kept: 504, firstKept: "h2", tail: 4846 },
	);
	check(
		"and the request after that cut still fits the window",
		huge.choice.used + huge.split.summaryTokenBudget + huge.split.digestTokens + 2_000 + 16_384 < 32_000,
		true,
	);
}
console.log(failures === 0 ? "ok: budget split" : `${failures} FAIL in budget split`);
process.exit(failures === 0 ? 0 : 1);
