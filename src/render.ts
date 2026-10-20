/**
 * Compaction rendering: deterministic, model-free, no paraphrase.
 *
 * This is the part of pi-observational-memory V3 worth keeping unchanged. The
 * expensive memory work already happened while the session ran, so compaction is
 * a string build, not a summarization call.
 */

import type { BankEntry } from "./types.js";

const HEADER = `These are the durable memories of this session, maintained continuously by the memory writer.

- Each line is one fact. When two lines conflict, the later one reflects the current state.
- Work described as completed should not be redone unless the user asks to revisit it.
- [id] references are exact: use the recall tool with that id to read the source evidence behind a fact.

## Facts`;

/**
 * Budget for `renderMemory` given the bank cap.
 *
 * `enforceBudget` measures fact text (`tokenCount`); each rendered line adds the
 * `[id] (task) ` prefix on top, measured at +14.2 tokens per fact on a 91-fact
 * session (7 953 rendered / 6 659 counted). A flat multiplier would silently
 * truncate again whenever task strings run long, so the prefix cost is summed for
 * this bank instead of assumed.
 */
export function summaryBudget(poolMaxTokens: number, bank: BankEntry[]): number {
	const prefix = bank
		.filter((e) => e.status === "active")
		.reduce((sum, e) => sum + Math.round(`[${e.id}] (${e.task}) `.length / 4), 0);
	return poolMaxTokens + prefix;
}

/** Shown when the bank does not fit the summary budget. */
const TAIL = (omitted: number): string =>
	`\n\n${omitted} more fact${omitted === 1 ? "" : "s"} not shown (budget); use the recall tool to read them.`;

export function renderMemory(bank: BankEntry[], maxTokens = 4000): string {
	// Newest first while admitting lines, chronological when printing them.
	//
	// The header tells the model that the later of two conflicting lines is the
	// current state, so under budget pressure the later line has to be the one that
	// survives. Admitting in chronological order did the opposite: the first N facts
	// were kept and the newest were dropped. Measured on session 01a1510e
	// (2026-10-19) the single omitted fact was the newest in the bank, from the most
	// recent write. Recency is the only rank there is (see DESIGN.md, *Ranking*).
	const active = bank
		.filter((e) => e.status === "active")
		.sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0));
	if (active.length === 0) return "";

	// Admission is a walk over the newest-first list, skipping what does not fit. The
	// previous version indexed the lines array with the position in `active`, which
	// misaligns as soon as one entry is skipped: it never adjusted `used`, so a
	// 150-token budget could render 299 tokens.
	const lines: string[] = [];
	// Header and omission tail are part of the same summary, so both come out of the
	// budget; otherwise `maxTokens` caps the fact lines only and the rendered string
	// can exceed it.
	const reserve = Math.round(TAIL(99).length / 4);
	const budget = Math.max(1, maxTokens - Math.round(HEADER.length / 4) - reserve);
	let used = 0;
	for (const entry of active) {
		const line = `[${entry.id}] (${entry.task}) ${entry.statement}`;
		const cost = Math.max(1, Math.round(line.length / 4));
		if (used + cost > budget) continue;
		lines.push(line);
		used += cost;
	}
	const omitted = active.length - lines.length;
	// Print chronologically, so the model reads the story in order and the newest
	// fact is the last line it sees. Admission above is only about who wins the
	// budget, and the admitted lines are already in newest-first order.
	const body = [...lines].reverse().join("\n");
	const tail = omitted > 0 ? TAIL(omitted) : "";
	return `${HEADER}\n${body}${tail}`;
}

export function supersededTrail(bank: BankEntry[]): string {
	return bank
		.filter((e) => e.status === "superseded")
		.map((e) => `[${e.id}] superseded by ${e.supersededBy ?? "-"}: ${e.supersedeReason ?? ""}`)
		.join("\n");
}
