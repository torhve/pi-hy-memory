/**
 * `hy_flush` — the session model names the range the writer should read.
 *
 * `DESIGN.md` records the reason: the write trigger is a token threshold, so a
 * chunk boundary is wherever 6 000 estimated tokens happened to land. Not-yet-proven
 * #4 is that a boundary cutting through a transition costs updates, because each
 * write then sees a smaller slice of it. The session model knows when a stretch of
 * work is finished; it does not know how many tokens that stretch was. This module
 * is the seam between those two.
 *
 * Two constraints shape it:
 *
 * - The model cannot see session entry ids. pi hands the model message content and
 *   nothing else, and `src/serialize.ts` hides ids behind positional `[n]` refs
 *   because this writer was measured copying rendered id labels into fact text
 *   (19 of 590 observations). So a flush names *this tool's own* positional refs,
 *   which is why the tool lists them before it can be told a range. No `context`
 *   handler and no tags injected into messages: pi's `context` chain runs handlers
 *   in load order and the last one wins, and this extension must never be in that
 *   chain.
 * - Coverage is monotone in the branch (`coverageWindow`, `src/entries.ts`). The
 *   watermark is a single id, so a flush that skipped front entries would leave a
 *   hole the ledger could never mark as covered. `to` therefore means "write up to
 *   here", and the front of the unwritten window is always included.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { renderEntry } from "./entries.js";
import { estimateTokens } from "./types.js";

/** Characters of each entry shown in the listing. Previews are for choosing a range, not reading. */
const PREVIEW_CHARS = 120;

/** The model-facing surface. Kept short on purpose: a quantized model restates a long description or a JSON example in prose instead of calling the tool. */
export const FLUSH_DESCRIPTION =
	"Fold settled conversation entries into the durable fact bank now, instead of waiting for the token threshold. Call it once a stretch of work is finished and its facts must survive a compaction or a reload: a decision taken, a root cause found, a constraint the user stated. With no arguments it lists the entries not yet written; then call it with to. Use hy_recall to read facts, not this tool.";

export const FLUSH_SNIPPET = "Fold settled entries into the fact bank; no arguments lists what is unwritten.";

export const FLUSH_GUIDELINES: string[] = [
	"Call hy_flush after a settled stretch whose facts must survive a reload: decisions, root causes, user-stated constraints.",
	"Call hy_flush with no arguments first to list unwritten entries, then flush with to. Never call it to re-read a file or to undo work.",
];

export const FLUSH_PARAM_TO = "Highest listed entry to write. Everything unwritten up to it is written.";

/** One unwritten entry, as the model sees it. */
export type FlushRow = {
	/** 0-based, and the same numbering the chunk the writer receives uses. */
	ref: number;
	/** Position in the pending window, so a range of refs maps back to entries. */
	entryIndex: number;
	role: string;
	preview: string;
	tokens: number;
};

export type FlushRange = {
	/** Always 0: coverage is monotone, so a flush can only advance, never skip. */
	start: number;
	end: number;
	/** Set when the request named a `to` past the end of the window. */
	clampedTo?: number;
	/** Nothing renderable to write, with the reason. */
	empty?: "no-entries" | "to-before-start" | "no-range";
};

function roleOf(entry: SessionEntry): string {
	if (entry.type !== "message") return entry.type;
	const message = entry.message as Record<string, unknown>;
	const role = typeof message.role === "string" ? message.role : "message";
	if (role === "toolResult") return "tool";
	return role;
}

/**
 * The unwritten entries, numbered the way `serializeEntries` numbers them: entries
 * with no text for the writer (system rows, this extension's own records, pi
 * bookkeeping) get no ref, so a ref is a position among *renderable* rows.
 */
export function flushRows(pending: SessionEntry[]): FlushRow[] {
	const rows: FlushRow[] = [];
	for (const [entryIndex, entry] of pending.entries()) {
		if (!entry?.id) continue;
		const line = renderEntry(entry, PREVIEW_CHARS);
		if (!line) continue;
		rows.push({
			ref: rows.length,
			entryIndex,
			role: roleOf(entry),
			preview: line.replace(/^\[[^\]]+\]: /, ""),
			tokens: estimateTokens(line),
		});
	}
	return rows;
}

/**
 * Resolve a requested `to` into a range. A missing `to` is the listing call, not a
 * write. A `to` past the end is clamped rather than rejected, because a model
 * counting entries is estimating, not indexing.
 */
export function unwrittenRange(rows: FlushRow[], to?: number): FlushRange {
	if (rows.length === 0) return { start: 0, end: -1, empty: "no-entries" };
	if (to === undefined || to === null) return { start: 0, end: -1, empty: "no-range" };
	if (!Number.isFinite(to)) return { start: 0, end: -1, empty: "no-range" };
	const wanted = Math.floor(to);
	if (wanted < 0) return { start: 0, end: -1, empty: "to-before-start" };
	if (wanted >= rows.length) return { start: 0, end: rows.length - 1, clampedTo: wanted };
	return { start: 0, end: wanted };
}

/** The entries to hand `serializeEntries` for a resolved range. */
export function rangeEntries(pending: SessionEntry[], rows: FlushRow[], range: FlushRange): SessionEntry[] {
	if (range.empty || rows.length === 0) return [];
	const first = rows[range.start];
	const last = rows[Math.min(range.end, rows.length - 1)];
	return pending.slice(first.entryIndex, last.entryIndex + 1);
}

/** The listing the model reads before it can name a range. */
export function renderUnwritten(rows: FlushRow[], limit: number, windowTokens?: number, minTokens?: number): string {
	if (rows.length === 0) return "Nothing is unwritten: the writer has covered every entry in this session.";
	const shown = rows.slice(0, Math.max(1, limit));
	const lines = shown.map((row) => `[${row.ref}] ${row.role}: ${row.preview}`);
	const hidden = rows.length - shown.length;
	if (hidden > 0) lines.push(`… ${hidden} more, up to [${rows.length - 1}].`);
	// A model that flushes after every settled turn ignores a refusal — measured, three refusals in
	// a row did not change its next call — so the size a write needs is stated in the listing it
	// already asks for.
	if (windowTokens !== undefined && minTokens !== undefined && minTokens > 0)
		lines.unshift(`~${windowTokens} tokens unwritten; a write needs ${minTokens}.`);
	lines.push(flushInstructions(rows));
	return lines.join("\n");
}

/** One line naming the exact call that works, with the highest valid ref in it. */
export function flushInstructions(rows: FlushRow[]): string {
	const last = rows.length - 1;
	return `To write everything above, call hy_flush with to=${last}. Everything from [0] to that entry is written, because coverage cannot skip.`;
}

/** What the tool answers after queueing a write. */
export function flushQueuedText(range: FlushRange, entries: number, tokens: number, chunkId: string): string {
	const clamped = range.clampedTo === undefined ? "" : ` (to=${range.clampedTo} clamped to ${range.end})`;
	return `queued: entries [0]–[${range.end}]${clamped}, ${entries} entries, ~${tokens} tokens, chunk ${chunkId}. Facts land in the bank when the write finishes; use hy_recall to read them.`;
}
