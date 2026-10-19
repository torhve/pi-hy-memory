/**
 * Session entries -> the chunk the writer sees.
 *
 * Two rules that come straight from the measurements in DESIGN.md:
 *   - The model is never shown an entry id. Provenance is a positional [n] ref that
 *     code maps back to the real id, because Hy-Memory copied internal id labels into
 *     19 of 590 observations under the incumbent serializer.
 *   - Compaction summaries and this extension's own entries are never fed back in.
 *     The bank already holds those facts; re-reading them produces self-referential
 *     memory.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SerializedChunk } from "./serialize.js";

import { estimateTokens } from "./types.js";

function clock(timestamp: string | number | undefined): string {
	const ms = typeof timestamp === "number" ? timestamp : timestamp ? Date.parse(timestamp) : Number.NaN;
	if (!Number.isFinite(ms)) return "";
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function textOfParts(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const out: string[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const p = part as Record<string, unknown>;
		if (p.type === "text" && typeof p.text === "string") out.push(p.text);
		else if (p.type === "toolCall") {
			const name = typeof p.name === "string" ? p.name : "tool";
			const args = JSON.stringify(p.arguments ?? p.args ?? {}).slice(0, 240);
			out.push(`[called ${name} ${args}]`);
		} else if (p.type === "image") out.push("[image]");
	}
	return out.join("\n").trim();
}

function clip(text: string, maxChars: number): string {
	const clean = text.replace(/\s*\n\s*/g, " ").trim();
	if (clean.length <= maxChars) return clean;
	return `${clean.slice(0, maxChars)}…`;
}

/** One session entry -> one labelled chunk line, or undefined when it carries no facts. */
export function renderEntry(entry: SessionEntry, maxChars: number): string | undefined {
	const at = clock((entry as { timestamp?: string }).timestamp);
	if (entry.type === "message") {
		const message = entry.message as Record<string, unknown>;
		const role = typeof message.role === "string" ? message.role : "message";
		if (role === "system" || role === "developer") return undefined;
		const body = textOfParts(message.content);
		if (!body) return undefined;
		if (role === "toolResult") {
			const name = typeof message.toolName === "string" ? message.toolName : "tool";
			const failed = message.isError === true ? " [error]" : "";
			return `[Tool result for ${name}${failed}${at ? ` @ ${at}` : ""}]: ${clip(body, maxChars)}`;
		}
		if (role === "assistant") return `[Assistant${at ? ` @ ${at}` : ""}]: ${clip(body, maxChars)}`;
		if (role === "user") return `[User${at ? ` @ ${at}` : ""}]: ${clip(body, maxChars)}`;
		return `[${role}${at ? ` @ ${at}` : ""}]: ${clip(body, maxChars)}`;
	}
	if (entry.type === "branch_summary") {
		const summary = typeof entry.summary === "string" ? entry.summary : "";
		return summary ? `[Earlier branch summary]: ${clip(summary, maxChars)}` : undefined;
	}
	// custom / custom_message / compaction / model_change / label / session_info:
	// either this extension's own records, pi bookkeeping, or a summary of text the
	// bank already contains.
	return undefined;
}

export type ChunkBuild = SerializedChunk & { droppedEntries: number; chars: number };

/**
 * Entries -> chunk, newest entries first until the token budget is spent, then
 * restored to chronological order so the writer reads the story in order.
 */
export function serializeEntries(
	entries: SessionEntry[],
	options: { maxTokens: number; maxEntryChars?: number },
): ChunkBuild {
	const maxChars = options.maxEntryChars ?? 3000;
	const rendered: { id: string; line: string; tokens: number }[] = [];
	for (const entry of entries) {
		if (!entry?.id) continue;
		const line = renderEntry(entry, maxChars);
		if (!line) continue;
		rendered.push({ id: entry.id, line, tokens: estimateTokens(line) });
	}

	// Take the OLDEST pending entries that fit, not the newest.
	//
	// The watermark is a single id, so coverage has to be contiguous: skipping a
	// middle entry and advancing past it loses it forever. The old suffix-first
	// walk did exactly that once pending exceeded maxChunkTokens — measured on
	// session 01a14a46 at 23 365 pending tokens against a 20 000 cap, which would
	// have silently dropped the oldest ~3 000 tokens on the next success. The tail
	// kept here is simply covered by the following write.
	let used = 0;
	const kept: typeof rendered = [];
	for (const row of rendered) {
		if (kept.length > 0 && used + row.tokens > options.maxTokens) break;
		used += row.tokens;
		kept.push(row);
	}
	const dropped = rendered.length - kept.length;

	const refs: string[] = [];
	const text = kept
		.map((row, index) => {
			refs.push(row.id);
			return `[${index}] ${row.line}`;
		})
		.join("\n");
	return { text, refs, entryCount: kept.length, droppedEntries: dropped, chars: text.length };
}

export type CompactionBoundary = {
	firstKeptIndex: number;
	used: number;
	/** "cursor": the safe window. "proposed": pi's cut, accepted to let compaction work. */
	boundary: "cursor" | "proposed";
	/** Set when honouring the summary here would drop entries the writer never read. */
	wouldDrop?: { fromId: string; toId: string; entries: number; tokens: number };
};

/**
 * Where a compaction should cut, given pi's own proposal.
 *
 * `compactionWindow` alone keeps every entry the writer has not covered, which is
 * safe but can make compaction a no-op: measured on session 01a1510e (2026-10-19),
 * the watermark sat 255 entries / ~104 000 real tokens behind a slow writer, so the
 * kept tail plus the summary stayed above pi's threshold and pi compacted six times
 * in 37 seconds, rendering the same 47 KB summary each time.
 *
 * So the clamp is bounded: when holding the uncovered backlog would cost more than
 * one chunk's worth, pi's boundary wins and the lost range is reported as a gap. The
 * caller writes that gap to the ledger, which is what stops the writer from claiming
 * coverage it never had.
 */
export function compactionBoundary(
	entries: SessionEntry[],
	options: {
		cursorId?: string;
		keepRecentTokens: number;
		/** pi's own cut point, from `preparation.firstKeptEntryId`. */
		proposedId?: string;
		/** How much uncovered backlog is worth holding back; one chunk by default. */
		maxUncoveredTokens: number;
	},
): CompactionBoundary {
	const safe = compactionWindow(entries, options.cursorId, options.keepRecentTokens);
	const cursorIndex = options.cursorId ? entries.findIndex((e) => e.id === options.cursorId) : -1;
	const proposedIndex = options.proposedId ? entries.findIndex((e) => e.id === options.proposedId) : -1;
	// Without a watermark in the branch there is no way to tell covered from
	// uncovered, so the safe window stands.
	if (cursorIndex < 0 || proposedIndex <= safe.firstKeptIndex) {
		return { ...safe, boundary: "cursor" };
	}

	let atRisk = 0;
	for (let i = safe.firstKeptIndex; i < proposedIndex; i++) atRisk += entryTokens(entries[i]);
	if (atRisk <= options.maxUncoveredTokens) return { ...safe, boundary: "cursor" };

	let used = 0;
	for (let i = proposedIndex; i < entries.length; i++) used += entryTokens(entries[i]);
	return {
		firstKeptIndex: proposedIndex,
		used,
		boundary: "proposed",
		wouldDrop: {
			fromId: entries[proposedIndex].id,
			toId: entries[safe.firstKeptIndex].id,
			entries: proposedIndex - safe.firstKeptIndex,
			tokens: atRisk,
		},
	};
}

/**
 * The safe cut: the backward walk, clamped to the watermark.
 *
 * The backward walk alone can drop entries the writer has never seen: measured on
 * session 01a14a46, compaction kept from index 328 while the last write's watermark
 * was index 315, so 12 entries (4 substantive tool results) were removed from the
 * branch before any chunk ever covered them — the bank never learned them and the
 * live context no longer contained them.
 *
 * Keeping the cursor in the branch has a second effect: `tokensSince` still finds
 * it, so the next write covers exactly the entries after it instead of re-scanning
 * the branch from index 0.
 */
export function compactionWindow(
	entries: SessionEntry[],
	cursorId: string | undefined,
	keepRecentTokens: number,
): { firstKeptIndex: number; used: number } {
	let used = 0;
	let firstKeptIndex = entries.length - 1;
	for (let i = entries.length - 1; i >= 0; i--) {
		const cost = entryTokens(entries[i]);
		if (used + cost > keepRecentTokens && i < entries.length - 1) {
			firstKeptIndex = i + 1;
			break;
		}
		used += cost;
		firstKeptIndex = i;
	}

	if (cursorId) {
		const cursorIndex = entries.findIndex((e) => e.id === cursorId);
		if (cursorIndex >= 0 && cursorIndex < firstKeptIndex) {
			// Recompute the kept token count from the clamped window.
			let kept = 0;
			for (let i = cursorIndex; i < entries.length; i++) kept += entryTokens(entries[i]);
			return { firstKeptIndex: cursorIndex, used: kept };
		}
	}
	return { firstKeptIndex, used };
}
/**
 * Size of an entry, unclipped.
 *
 * Sizing decisions (the trigger window, `keepRecentTokens`, the footer) have to
 * track what pi counts against the context window, and pi counts the real entry.
 * Rendering with a clip here underestimated a tool-heavy branch by ~1.5x: the
 * pending window measured 74 060 tokens while the same entries were 108 520, so
 * `observeAfterTokens` fired ~22 000 real tokens in. Clipping belongs to
 * serialization, where it is a deliberate limit on what the writer is sent.
 */
export function entryTokens(entry: SessionEntry): number {
	const rendered = renderEntry(entry, Number.POSITIVE_INFINITY);
	return rendered ? estimateTokens(rendered) : 0;
}

/**
 * Where coverage resumes when the watermark is no longer in the branch.
 *
 * A watermark is an entry id, and pi can move the leaf: a rewind, a resumed
 * checkpoint or a compaction that re-parents the branch leaves the old id in the
 * session file but off the current chain. Measured on session 01a1510e
 * (2026-10-19): write 064 covered up to `369f8228`, the user rewound to an earlier
 * point, and the next trigger could not find the id. Falling back to index 0 made
 * the whole 3 617-entry session "pending" — 431 329 tokens, re-extracting history
 * the bank already held, one 20 000-token chunk per write.
 *
 * Our own ledger records are the reliable proxy: a write appends `hy.extract` and
 * `hy.ops` right after the entries it covered, so the newest record in the branch
 * marks where coverage ended. Failing that, the newest compaction entry does: pi
 * summarised everything before it, so re-reading that prefix is pointless.
 */
export function resumeAfterLostCursor(entries: SessionEntry[]): {
	index: number;
	from: "record" | "compaction" | "none";
} {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; customType?: string };
		if (entry.type === "custom" && (entry.customType === "hy.extract" || entry.customType === "hy.ops"))
			return { index: i + 1, from: "record" };
	}
	for (let i = entries.length - 1; i >= 0; i--) {
		if ((entries[i] as { type?: string }).type === "compaction") return { index: i + 1, from: "compaction" };
	}
	return { index: 0, from: "none" };
}

/**
 * The window that would be written next, and the coverage it starts from.
 *
 * The watermark is a single entry id, which is wrong after pi moves the leaf
 * (rewind, resumed checkpoint, a compaction that re-parents the branch): the id is
 * still in the session file but off the chain, and the next trigger used to fall
 * back to index 0 and call the whole session pending. Measured on session
 * 01a1510e (2026-10-19): write 064's cursor went off-chain, the window became
 * 431 329 tokens across 3 617 entries, and writes began re-extracting history the
 * bank already held.
 *
 * Worse, the records written after that rewind advanced the watermark backwards
 * (chunk 065 covered index 93, 066 index 232) while the ledger still held coverage
 * up to index 3423. Coverage is monotone in the branch, so the window starts after
 * the furthest position any ledger record still reaches — not after the newest
 * record's id.
 */
export type Window = { pending: SessionEntry[]; tokens: number; drift?: { from?: string; to: string } };

export function coverageWindow(
	entries: SessionEntry[],
	ledger: { coversUpToId?: string }[],
	cursorId: string | undefined,
	resumeFromId: string | undefined,
): Window {
	const index = new Map(entries.map((e, i) => [e.id, i]));
	const sliceFrom = (start: number): Window => {
		const pending = entries.slice(start);
		return { pending, tokens: pending.reduce((sum, e) => sum + entryTokens(e), 0) };
	};

	const cursorIndex = cursorId === undefined ? undefined : index.get(cursorId);
	if (cursorIndex !== undefined) {
		let furthest = cursorIndex;
		for (const record of ledger) {
			const at = record.coversUpToId === undefined ? undefined : index.get(record.coversUpToId);
			if (at !== undefined && at > furthest) furthest = at;
		}
		const window = sliceFrom(furthest + 1);
		return furthest > cursorIndex ? { ...window, drift: { from: cursorId, to: entries[furthest].id } } : window;
	}

	// A compaction gap says exactly where coverage resumes: honour it before older
	// records, which would otherwise re-read the range the gap recorded as lost.
	const resumed = resumeFromId === undefined ? undefined : index.get(resumeFromId);
	if (resumed !== undefined) return sliceFrom(resumed);

	if (cursorId !== undefined) {
		let furthest = -1;
		for (const record of ledger) {
			const at = record.coversUpToId === undefined ? undefined : index.get(record.coversUpToId);
			if (at !== undefined && at > furthest) furthest = at;
		}
		if (furthest >= 0) return { ...sliceFrom(furthest + 1), drift: { from: cursorId, to: entries[furthest].id } };
		return {
			...sliceFrom(resumeAfterLostCursor(entries).index),
			drift: { from: cursorId, to: "resumed after lost cursor" },
		};
	}

	return sliceFrom(0);
}
