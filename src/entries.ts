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
	gap?: { fromId: string; toId: string; entries: number; tokens: number };
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
		gap: {
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
export function entryTokens(entry: SessionEntry): number {
	const rendered = renderEntry(entry, 4000);
	return rendered ? estimateTokens(rendered) : 0;
}
