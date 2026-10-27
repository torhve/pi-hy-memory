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
 * Two of these sections exist because of a bug this split nearly shipped with: passing the budget cap
 * as `keepRecentTokens` instead of as `maxKeepTokens` makes `compactionBoundary`'s backward walk do the
 * cutting, `trimKeptTail` finds nothing to trim, and the trim stops reporting its digest, its gap and
 * its audit line. Section 9 pins the difference between the two parameters.
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
const SUMMARY_MAX = 8000;
const DIGEST_SHARE = 1500;
const BASE = {
	reserveTokens: RESERVE,
	keepRecentTokens: KEEP_RECENT,
	summaryMaxTokens: SUMMARY_MAX,
	overflowDigestTokens: DIGEST_SHARE,
};

const split = (input: Partial<BudgetInput> & { windowTokens: number }): ReturnType<typeof budgetSplit> =>
	budgetSplit({
		reserveTokens: RESERVE,
		overheadTokens: 2000,
		keepRecentTokens: KEEP_RECENT,
		summaryMaxTokens: SUMMARY_MAX,
		overflowDigestTokens: DIGEST_SHARE,
		...input,
	});

/**
 * The committed formulas, written out here so a change to `src/budget.ts` has to be a decision rather
 * than a drift: the digest keeps its share, the note gives up its configured maximum, and the tail is
 * the remainder but never below its floor.
 */
const expected = (windowTokens: number, overheadTokens: number, digestTokens?: number) => {
	if (windowTokens <= 0) return { available: undefined, digest: 0, tail: 0, note: 0 };
	const available = Math.max(0, windowTokens - RESERVE - overheadTokens - COMPACT_SLACK_TOKENS);
	const cap = Math.min(DIGEST_SHARE, Math.floor(available / 4));
	const digest = Math.max(0, Math.min(cap, digestTokens ?? cap));
	const note = Math.max(
		COMPACT_SUMMARY_MIN_TOKENS,
		Math.min(SUMMARY_MAX, available - digest - COMPACT_KEEP_MIN_TOKENS),
	);
	return { available, digest, tail: Math.max(0, available - digest - note), note, cap };
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
			if (!Number.isInteger(available) || !Number.isInteger(s.tailTokens)) broken.push(`${label}: non-integer`);
			if (s.digestTokens !== want.digest) broken.push(`${label}: digest ${s.digestTokens} ≠ ${want.digest}`);
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
			// Every window in this table can pay the tail's floor, so it must.
			if (
				available >= COMPACT_KEEP_MIN_TOKENS + COMPACT_SUMMARY_MIN_TOKENS &&
				s.tailTokens < COMPACT_KEEP_MIN_TOKENS
			)
				broken.push(`${label}: the tail lost its floor in a room that could pay it`);
			if (s.underprovisioned !== available < COMPACT_KEEP_MIN_TOKENS + COMPACT_SUMMARY_MIN_TOKENS)
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
		summaryMaxTokens: 8000,
		overflowDigestTokens: 1500,
	});
	check(
		"12k window, measured overhead: the tail gets its floor and the note the rest",
		{
			available: fixture.available,
			tail: fixture.tailTokens,
			note: fixture.summaryTokenBudget,
			digest: fixture.digestTokens,
		},
		{ available: 7000, tail: 1000, note: 4500, digest: 1500 },
	);

	const heavy = split({ windowTokens: 16_000, overheadTokens: 4800 });
	check(
		"16k window, heavy prompt",
		{
			available: heavy.available,
			tail: heavy.tailTokens,
			note: heavy.summaryTokenBudget,
			digest: heavy.digestTokens,
		},
		{ available: 5700, tail: 1000, note: 3275, digest: 1425 },
	);

	// A roomy window: the note takes its cap and the tail takes the surplus. The surplus is a ceiling,
	// not what the model is handed — section 9 pins where `keepRecentTokens` caps the walk.
	const big = split({ windowTokens: 32_000 });
	check(
		"32k window: both ceilings bite and the tail takes what is left",
		{ tail: big.tailTokens, note: big.summaryTokenBudget, available: big.available },
		{ tail: 15_000, note: 8000, available: 24_500 },
	);
}

// ---------------------------------------------------------------------------
// 2b) The published window table in DESIGN_HYVCC.md, reproduced row for row with pi's default
//     `reserveTokens: 16 384`. Two numbers, not one: `tailTokens` is the room the split leaves for
//     the tail, and the table's column is what the model actually gets — that room capped by
//     `keepRecentTokens`, because the walk back through the branch is what `keepRecentTokens` bounds.
//     A table published in a design document has to be recomputable by a harness.
// ---------------------------------------------------------------------------
{
	const PI_RESERVE = 16_384;
	const rows = [
		// window, overhead, available, tail delivered, note, digest
		[16_000, 2_000, 0, 0, 500, 0],
		[24_000, 2_000, 4_116, 1_000, 2_087, 1_029],
		[32_000, 2_000, 12_116, 2_616, 8_000, 1_500],
		[32_000, 9_600, 4_516, 1_000, 2_387, 1_129],
		[36_000, 2_000, 16_116, 6_000, 8_000, 1_500],
		[168_000, 2_016, 148_100, 6_000, 8_000, 1_500],
	] as const;
	const broken: string[] = [];
	for (const [windowTokens, overheadTokens, available, tail, note, digest] of rows) {
		const s = budgetSplit({
			windowTokens,
			reserveTokens: PI_RESERVE,
			overheadTokens,
			keepRecentTokens: 6_000,
			summaryMaxTokens: 8_000,
			overflowDigestTokens: 1_500,
		});
		const label = `${windowTokens} / overhead ${overheadTokens}`;
		const delivered = Math.min(s.tailTokens ?? 0, 6_000);
		if (s.available !== available) broken.push(`${label}: available ${s.available} ≠ ${available}`);
		if (delivered !== tail) broken.push(`${label}: tail delivered ${delivered} ≠ ${tail}`);
		if (s.summaryTokenBudget !== note) broken.push(`${label}: note ${s.summaryTokenBudget} ≠ ${note}`);
		if (s.digestTokens !== digest) broken.push(`${label}: digest ${s.digestTokens} ≠ ${digest}`);
	}
	check("the published window table reproduces from budgetSplit", broken, []);

	// The two tail numbers differ exactly where the room is wider than the setting, and only there.
	const wide = budgetSplit({
		windowTokens: 168_000,
		reserveTokens: PI_RESERVE,
		overheadTokens: 2_016,
		keepRecentTokens: 6_000,
		summaryMaxTokens: 8_000,
		overflowDigestTokens: 1_500,
	});
	const narrow = budgetSplit({
		windowTokens: 32_000,
		reserveTokens: PI_RESERVE,
		overheadTokens: 2_000,
		keepRecentTokens: 6_000,
		summaryMaxTokens: 8_000,
		overflowDigestTokens: 1_500,
	});
	check(
		"room left for the tail and tail delivered are the same number until the room outgrows the setting",
		{
			narrowRoom: narrow.tailTokens,
			narrowDelivered: Math.min(narrow.tailTokens ?? 0, 6_000),
			wideRoom: wide.tailTokens,
			wideDelivered: Math.min(wide.tailTokens ?? 0, 6_000),
		},
		{ narrowRoom: 2_616, narrowDelivered: 2_616, wideRoom: 138_600, wideDelivered: 6_000 },
	);
}

// ---------------------------------------------------------------------------
// 3) The order, at the boundary where the note's cap and the tail's floor compete. Below an available of
//    10 500 the note is the part that shrinks; the tail does not give up an entry until the room cannot
//    pay the floor at all.
// ---------------------------------------------------------------------------
{
	const atCap = split({ windowTokens: 12_000, reserveTokens: 0, overheadTokens: 0 });
	check(
		"room of 10 500: the note still at its configured maximum, the tail at its floor",
		{ available: atCap.available, note: atCap.summaryTokenBudget, tail: atCap.tailTokens },
		{ available: 10_500, note: 8000, tail: 1000 },
	);
	const below = split({ windowTokens: 11_900, reserveTokens: 0, overheadTokens: 0 });
	check(
		"room of 10 400: the note gives up 100 tokens of its cap, the tail gives up nothing",
		{ available: below.available, note: below.summaryTokenBudget, tail: below.tailTokens },
		{ available: 10_400, note: 7900, tail: 1000 },
	);
	const paid = split({ windowTokens: 4500, reserveTokens: 0, overheadTokens: 0 });
	check(
		"room of 3 000: the tail is still owed its floor",
		{ available: paid.available, note: paid.summaryTokenBudget, tail: paid.tailTokens, digest: paid.digestTokens },
		{ available: 3000, note: 1250, tail: 1000, digest: 750 },
	);
	const squeezed = split({ windowTokens: 2200, reserveTokens: 0, overheadTokens: 0 });
	check(
		"room of 700: the room cannot pay both, and the split says so rather than picking silently",
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
	const at = (available: number) =>
		split({ windowTokens: available + COMPACT_SLACK_TOKENS, reserveTokens: 0, overheadTokens: 0 });
	check("underprovisioned at 1499 of room", at(1499).underprovisioned, true);
	check("not underprovisioned at 1500", at(1500).underprovisioned, false);
	check("not underprovisioned at 1501", at(1501).underprovisioned, false);
	check(
		"the shortfall is a tail under its floor, not a zero budget",
		{ tail: at(1499).tailTokens, note: at(1499).summaryTokenBudget },
		{ tail: 625, note: 500 },
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
		{ digest: 1000, tail: 1000, note: 2000 },
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
// 9) The walk and the cap are different parameters and have to stay different. `keepRecentTokens` is how
//    far the backward walk reaches; `maxKeepTokens` is the request budget. Folding the second into the
//    first cuts the tail without ever producing a `trimmed`, which is what silently deletes the digest,
//    the gap and the audit line that report what a compaction threw away.
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
		"a window that could hold the whole branch still walks back only to keepRecentTokens",
		{ keptTokens: loose.choice.used, cap: loose.split.tailTokens },
		{ keptTokens: 5656, cap: 158_500 },
	);
	check("and a cut the walk made alone is not reported as a budget trim", loose.choice.trimmed === undefined, true);

	const tight = resolveBudget({
		base: { ...BASE, windowTokens: 6000, reserveTokens: 0, overheadTokens: 0 },
		entries: wide,
		cursorId: "w0",
		proposedId: "w40",
		maxUncoveredTokens: 1000,
	});
	check(
		"a budget tighter than the walk cuts, and says what it cut",
		{
			trimmedEntries: tight.choice.trimmed?.entries,
			trimmedTokens: tight.choice.trimmed?.tokens,
			keptTokens: tight.choice.used,
			unread: tight.unread.map((e) => e.id),
		},
		{
			trimmedEntries: 8,
			trimmedTokens: 3232,
			keptTokens: 808,
			unread: ["w40", "w41", "w42", "w43", "w44", "w45", "w46", "w47"],
		},
	);
	check(
		"the trim is priced rather than assumed",
		{ digest: tight.split.digestTokens, ceiling: Math.min(1500, Math.floor((tight.split.available ?? 0) / 4)) },
		{ digest: 564, ceiling: 1125 },
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
		{ passes: 2, converged: true, digest: 229, unread: ["b15", "b16", "b17"], missed: false },
	);
	check(
		"the re-split still fits the room",
		second.split.digestTokens + second.split.tailTokens + second.split.summaryTokenBudget <=
			(second.split.available ?? 0),
		true,
	);
	check(
		"room freed by the waiver goes to the note, which is the part that can give way",
		{
			note: second.split.summaryTokenBudget,
			noteBefore: split({ windowTokens: 6000, reserveTokens: 0, overheadTokens: 0 }).summaryTokenBudget,
			tail: second.split.tailTokens,
			tailBefore: split({ windowTokens: 6000, reserveTokens: 0, overheadTokens: 0 }).tailTokens,
		},
		{ note: 3271, noteBefore: 2375, tail: 1000, tailBefore: 1000 },
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

console.log(failures === 0 ? "ok: budget split" : `${failures} FAIL in budget split`);
process.exit(failures === 0 ? 0 : 1);
