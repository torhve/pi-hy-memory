/**
 * How a compaction splits the room the next request has: tail, digest, note.
 *
 * The order is the whole design. The tail asks first: a share (`keepRecentShare`) of the room the
 * furniture left, held at least at `COMPACT_KEEP_MIN_TOKENS` while the room can pay for one, and
 * capped by `keepRecentTokens`. It is verbatim conversation and nothing can rebuild it. The note
 * takes what the tail left, up to `summaryMaxTokens`, and gives way first — it is re-rendered from
 * the fact bank on disk at every compaction. When the room cannot pay both, the note keeps its
 * minimum and `underprovisioned` says so rather than claiming a split that fits.
 *
 * What this package adds on top of that order is the digest: the reservation is probed instead of
 * assumed. A boundary is computed with the full share, the drop set it actually produces is priced,
 * and the reservation may only fall to that price — never above `overflowDigestTokens`, never above
 * a quarter of the room. A compaction that trims nothing then pays nothing for the digest, and a
 * trim that needs the whole share still gets it.
 *
 * Everything here is pure and takes the window from pi plus the measured overhead, so
 * `tools/budget-split-check.ts` can table-test the arithmetic. Token figures are the
 * `chars / 4` estimate this package uses throughout, not pi's tokenizer.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type CompactionBoundary, compactionBoundary, entryTokens } from "./entries.js";

/**
 * The floor on what a compaction budget cannot see: the system prompt and tool schemas are not
 * ours to render, and pi counts tokens with a real tokenizer while this package estimates them
 * from characters. Measured overhead is used when pi has counted a request; this is what is left
 * for a session it has not.
 */
export const COMPACT_OVERHEAD_TOKENS = 2000;
/**
 * Room a compaction leaves below the threshold rather than filling it. A budget spent exactly to
 * `window − reserve` puts the next request back at the trigger, so pi compacts again on the turn
 * that follows — a compaction that trims the working set every turn is worse than one that trims
 * less and holds.
 */
export const COMPACT_SLACK_TOKENS = 1500;
/** Never hand the model fewer than this many verbatim entries' worth of tail. */
export const COMPACT_KEEP_MIN_TOKENS = 1000;
/** The smallest note that still reads as a note. Below this the compaction cannot work. */
export const COMPACT_SUMMARY_MIN_TOKENS = 500;

/** Each digested entry is clipped to this many characters before counting (`serializeEntries`). */
export const DIGEST_ENTRY_CHARS = 240;

export type BudgetInput = {
	/** pi's model context window; `0` when the model did not report one. */
	windowTokens: number;
	/** pi's `reserveTokens` for the retry request. */
	reserveTokens: number;
	/** What the request carries that is not conversation: prompt, tool schemas, bookkeeping. */
	overheadTokens: number;
	/**
	 * How much of the room the tail asks for before this ceiling caps it. It is a ceiling, not the
	 * number the tail delivers on a small window, and it is not the request cap either —
	 * `tailTokens` below is, and the walk back through the branch stops at that.
	 */
	keepRecentTokens: number;
	/** The share of the room `keepRecentTokens` caps. */
	keepRecentShare: number;
	summaryMaxTokens: number;
	overflowDigestTokens: number;
	/**
	 * Digest room carried in from the previous boundary probe. Omitted on the first pass, which is
	 * the full share; every later pass can only price it down to what the drop set costs.
	 */
	digestTokens?: number;
};

export type BudgetSplit = {
	/** Room for conversation after the furniture. `undefined` when pi gave no window. */
	available: number | undefined;
	digestTokens: number;
	tailTokens: number;
	summaryTokenBudget: number;
	/**
	 * True when the room cannot hold both a usable tail and a usable note. The split still
	 * returns its minimums — pi would rather have a summary than a 400 — but the caller has
	 * to report that the compaction cannot clear the threshold rather than claim it worked.
	 */
	underprovisioned: boolean;
};

/** The split itself, given the room and a digest reservation. No session data, no model. */
export function budgetSplit(input: BudgetInput): BudgetSplit {
	if (input.windowTokens <= 0) {
		return {
			available: undefined,
			digestTokens: input.overflowDigestTokens,
			tailTokens: input.keepRecentTokens,
			summaryTokenBudget: input.summaryMaxTokens,
			underprovisioned: false,
		};
	}
	const available = Math.max(
		0,
		input.windowTokens - input.reserveTokens - input.overheadTokens - COMPACT_SLACK_TOKENS,
	);
	// The reservation's ceiling: the configured share, never more than a quarter of the room. The
	// value that arrives here is a price a probe measured, so it can only land below this ceiling.
	const digestCap = Math.min(input.overflowDigestTokens, Math.floor(available / 4));
	const digestTokens = Math.max(0, Math.min(digestCap, input.digestTokens ?? digestCap));
	const room = available - digestTokens;
	// The tail asks for a share of what the furniture left, and it is never asked for less than the
	// floor while the room can pay for one. Then two ceilings clamp it: `keepRecentTokens`, and the
	// note's minimum — a room this small keeps a coherent note over two messages of exact text, and
	// `underprovisioned` says the compaction cannot clear the threshold instead of pretending the
	// split worked.
	const tailAsk = Math.max(
		COMPACT_KEEP_MIN_TOKENS,
		// The share is clamped rather than trusted: 0 is "the note may have everything", 1 is "the tail
		// takes all but the note's minimum", and anything outside that range is a config mistake that
		// should not turn into a negative budget.
		Math.round(Math.min(1, Math.max(0, input.keepRecentShare)) * room),
	);
	const tailTokens = Math.max(0, Math.min(input.keepRecentTokens, tailAsk, room - COMPACT_SUMMARY_MIN_TOKENS));
	// Whatever the tail did not ask for belongs to the note, up to its configured maximum. The note
	// is re-rendered from the fact bank on disk at every compaction; the tail is the part nothing can
	// rebuild, which is why it is priced first.
	const summaryTokenBudget = Math.max(
		COMPACT_SUMMARY_MIN_TOKENS,
		Math.min(input.summaryMaxTokens, room - tailTokens),
	);
	return {
		available,
		digestTokens,
		tailTokens,
		summaryTokenBudget,
		underprovisioned: room < COMPACT_KEEP_MIN_TOKENS + COMPACT_SUMMARY_MIN_TOKENS,
	};
}

/**
 * Entries leaving the branch that the writer never covered.
 *
 * The watermark lookup can miss: after a rewind the cursor may name an entry that is no
 * longer in this branch. That is the conservative direction — unknown coverage counts as
 * uncovered — but it is reported, because a lookup miss silently widening the "never
 * written" range is exactly the kind of claim this digest exists to make honestly.
 */
export function dropRange(
	entries: SessionEntry[],
	choice: CompactionBoundary,
	watermarkId?: string,
): { unread: SessionEntry[]; lookupMissed: boolean } {
	if (!choice.trimmed) return { unread: [], lookupMissed: false };
	const trimmedFrom = entries.findIndex((e) => e.id === choice.trimmed?.fromId);
	const watermark = watermarkId ? entries.findIndex((e) => e.id === watermarkId) : -1;
	const lookupMissed = trimmedFrom < 0 || (watermarkId !== undefined && watermark < 0);
	const from = Math.max(trimmedFrom, watermark + 1);
	return { unread: entries.slice(from, choice.firstKeptIndex), lookupMissed };
}

/**
 * The digest announces itself before it lists anything ("Dropped to fit the context window — N
 * entries, ~M tokens, never written to the fact bank:"). Measured with this package's `chars / 4`
 * estimate across ranges of 1 to 40 entries and with and without a "(N not shown)" tail.
 */
export const DIGEST_HEADER_TOKENS = 28;

/**
 * What one digested entry actually costs when it is clipped. Measured with this package's estimate on
 * entries rendered through `serializeEntries` at `DIGEST_ENTRY_CHARS`: 240 characters of content, the
 * decoration `renderEntry` adds around it, the `[n] ` label the digest puts in front, and the newline
 * that joins the lines. An entry shorter than the clip is priced at itself plus the label.
 */
export const DIGEST_ENTRY_TOKENS = 67;
/** Slack for the `[n] ` label and joining newline on an entry that was never clipped. */
export const DIGEST_LABEL_TOKENS = 2;

/**
 * What the digest of that range will actually cost. Pricing only the raw entries — the figure
 * `DIGEST_ENTRY_CHARS / 4` suggests — under-covers the labelled, decorated lines the digest is
 * rendered into, and a reservation that cannot pay for its own list is what makes it clip entries it
 * just promised to show.
 */
export function estimateDigestTokens(unread: SessionEntry[]): number {
	if (unread.length === 0) return 0;
	let used = DIGEST_HEADER_TOKENS;
	for (const entry of unread) {
		used += Math.min(entryTokens(entry) + DIGEST_LABEL_TOKENS, DIGEST_ENTRY_TOKENS);
	}
	return used;
}

export type ResolvedBudget = {
	split: BudgetSplit;
	choice: CompactionBoundary;
	unread: SessionEntry[];
	/** Passes run, and whether the reservation settled. A non-settling probe is reported. */
	passes: number;
	converged: boolean;
	lookupMissed: boolean;
};

/**
 * Ask first, then reserve: probe the boundary with the full digest share, price the drop set it
 * actually produced, re-split with that as the reservation, and probe again until the reservation
 * settles. The reservation only ever moves down, so the worst case is the committed constant.
 *
 * The second pass can grow the tail, which moves the cut later, which drops fewer entries — so the
 * loop is a fixed point, not a single correction. Three passes is the bound; a range clipped to
 * `DIGEST_ENTRY_CHARS` per entry converges well inside it, and a caller that sees `converged: false`
 * keeps the last split rather than iterating forever.
 */
export function resolveBudget(args: {
	base: Omit<BudgetInput, "digestTokens">;
	entries: SessionEntry[];
	cursorId?: string;
	proposedId?: string;
	maxUncoveredTokens: number;
	maxPasses?: number;
}): ResolvedBudget {
	const maxPasses = args.maxPasses ?? 3;
	// The first pass is the committed reservation: the whole share. Every later pass prices it down.
	let requested: number | undefined;
	let split = budgetSplit({ ...args.base });
	let choice = probe(args, split);
	let unread: SessionEntry[] = [];
	let lookupMissed = false;
	for (let pass = 1; pass <= maxPasses; pass++) {
		const drop = dropRange(args.entries, choice, args.cursorId);
		unread = drop.unread;
		lookupMissed = drop.lookupMissed;
		const need = unread.length > 0 ? estimateDigestTokens(unread) : 0;
		if (need === requested) return { split, choice, unread, passes: pass, converged: true, lookupMissed };
		requested = need;
		split = budgetSplit({ ...args.base, digestTokens: need });
		choice = probe(args, split);
	}
	return { split, choice, unread, passes: maxPasses, converged: false, lookupMissed };
}

function probe(
	args: {
		base: Omit<BudgetInput, "digestTokens">;
		entries: SessionEntry[];
		cursorId?: string;
		proposedId?: string;
		maxUncoveredTokens: number;
	},
	split: BudgetSplit,
): CompactionBoundary {
	return compactionBoundary(args.entries, {
		cursorId: args.cursorId,
		// The walk stops where the split decided the tail is allowed to reach, so the number the
		// share computed is the number delivered — the config ceiling is applied in `budgetSplit`,
		// not here. `maxKeepTokens` is the same figure: past it the trim is the budget's doing, and
		// a cut the walk made on its own stays a working-set choice rather than a reported trim.
		keepRecentTokens: split.tailTokens,
		proposedId: args.proposedId,
		maxUncoveredTokens: args.maxUncoveredTokens,
		maxKeepTokens: split.available === undefined ? undefined : split.tailTokens,
	});
}
