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
	const active = bank
		.filter((e) => e.status === "active")
		.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
	if (active.length === 0) return "";

	const rank = (e: BankEntry): number => (e.relevance === "high" ? 3 : e.relevance === "medium" ? 2 : 1);
	// Keep rank and cost alongside each rendered line. The previous version indexed
	// the lines array with the position in `active`, which misaligns as soon as one
	// entry is skipped: it then promoted against the wrong fact's relevance and
	// never adjusted `used`, so a 150-token budget could render 299 tokens.
	const lines: { text: string; rank: number; cost: number }[] = [];
	// Header and omission tail are part of the same summary, so both come out of
	// the budget; otherwise `maxTokens` is a cap on the fact lines only and the
	// rendered string can exceed it.
	const reserve = Math.round(TAIL(99).length / 4);
	const budget = Math.max(1, maxTokens - Math.round(HEADER.length / 4) - reserve);
	let used = 0;
	for (const entry of active) {
		const line = `[${entry.id}] (${entry.task}) ${entry.statement}`;
		const cost = Math.max(1, Math.round(line.length / 4));
		const r = rank(entry);
		if (used + cost <= budget) {
			lines.push({ text: line, rank: r, cost });
			used += cost;
			continue;
		}
		// Budget pressure: displace the weakest fact already rendered, if this one
		// outranks it and the swap still fits.
		let weakest = 0;
		for (let i = 1; i < lines.length; i++) if (lines[i].rank < lines[weakest].rank) weakest = i;
		if (lines.length > 0 && lines[weakest].rank < r && used - lines[weakest].cost + cost <= budget) {
			used += cost - lines[weakest].cost;
			lines[weakest] = { text: line, rank: r, cost };
		}
	}
	const omitted = active.length - lines.length;
	const body = lines.map((l) => l.text).join("\n");
	const tail = omitted > 0 ? TAIL(omitted) : "";
	return `${HEADER}\n${body}${tail}`;
}

export function supersededTrail(bank: BankEntry[]): string {
	return bank
		.filter((e) => e.status === "superseded")
		.map((e) => `[${e.id}] superseded by ${e.supersededBy ?? "-"}: ${e.supersedeReason ?? ""}`)
		.join("\n");
}
