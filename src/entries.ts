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

/**
 * Which entries survive a compaction.
 *
 * The backward walk alone can drop entries the writer has never seen: measured
 * on session 01a14a46, compaction kept from index 328 while the last write's
 * watermark was index 315, so 12 entries (4 substantive tool results) were
 * removed from the branch before any chunk ever covered them — the bank never
 * learned them and the live context no longer contained them.
 *
 * So the window is clamped to the watermark entry itself. Keeping the cursor in
 * the branch has a second effect: `tokensSince` still finds it, so the next
 * write covers exactly the entries after it instead of re-scanning the branch
 * from index 0.
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
