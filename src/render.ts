/**
 * Compaction rendering: deterministic, model-free, no paraphrase.
 *
 * This is the part of pi-observational-memory V3 worth keeping unchanged. The
 * expensive memory work already happened while the session ran, so compaction is
 * a string build, not a summarization call.
 *
 * The bank is a store; the summary is a *selection* over it. Those used to be the
 * same number, which turned a long session's memory into a tail: measured on a
 * 32-chunk session, 408 facts / 29 357 tokens of bank were cut to the newest 84,
 * and the oldest surviving fact was 7 chunks old. Selecting by recency alone is
 * also wrong on its own terms — it keeps the last few hours of churn and drops the
 * decisions the session is built on — and the writer cannot be asked to rank its
 * own facts (see DESIGN.md, *Ranking*). So the selection is stratified in code.
 */

import type { BankEntry } from "./types.js";

const INTRO = `These are the durable memories of this session, maintained continuously by the memory writer.

- Each line is one fact. Sections are ordered newest first; inside a section the later line is the more recent state.
- Work described as completed should not be redone unless the user asks to revisit it.
- [id] references are exact: use the recall tool with that id to read the source evidence behind a fact.`;

/** Section labels; a bank with one age group shows only the first. */
const CURRENT = "## Current state";
const EARLIER = "## Earlier";

/**
 * Budget for `renderMemory` given the summary cap.
 *
 * `enforceBudget` measures fact text (`tokenCount`); each rendered line adds the
 * `[id] (task) ` prefix on top, measured at +14.2 tokens per fact on a 91-fact
 * session (7 953 rendered / 6 659 counted). A flat multiplier would silently
 * truncate again whenever task strings run long, so the prefix cost is summed for
 * this bank instead of assumed.
 */
export function summaryBudget(summaryMaxTokens: number, bank: BankEntry[]): number {
	const prefix = bank
		.filter((e) => e.status === "active")
		.reduce((sum, e) => sum + Math.round(`[${e.id}] (${e.task}) `.length / 4), 0);
	return summaryMaxTokens + prefix;
}

/** Shown when the bank does not fit the summary budget. */
const TAIL = (omitted: number): string =>
	`\n\n${omitted} more fact${omitted === 1 ? "" : "s"} not shown (budget); use the recall tool to read them.`;

export type SelectionOptions = {
	/** A fact this many chunks old that was never superseded counts as a foundation. */
	foundationAfterChunks?: number;
	/** Share of the budget reserved for user-stated facts. */
	constraintShare?: number;
	/** Share of the budget reserved for old, never-superseded facts. */
	foundationShare?: number;
};

const newestFirst = (a: BankEntry, b: BankEntry): number =>
	a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;

/**
 * Three slices, each newest-first, filled in order, never duplicated:
 *
 * 1. constraints — evidence is a user turn (the class the judge values most)
 * 2. foundations — old facts that were never superseded
 * 3. current state — everything else
 *
 * Shares are budgets, and unused budget spills forward, so a session with no
 * user-stated facts still fills the summary. Admission inside a slice is a
 * bin-packing walk: one long fact does not block three short ones.
 */
export function selectForSummary(
	bank: BankEntry[],
	maxTokens: number,
	options: SelectionOptions = {},
): { shown: BankEntry[]; omitted: number } {
	const horizon = options.foundationAfterChunks ?? 8;
	const constraintShare = options.constraintShare ?? 0.1;
	const foundationShare = options.foundationShare ?? 0.35;
	const active = bank.filter((e) => e.status === "active").sort(newestFirst);
	const latest = active.reduce((max, e) => Math.max(max, e.chunkSeq ?? 0), 0);
	const age = (e: BankEntry): number => latest - (e.chunkSeq ?? 0);

	const constraints = active.filter((e) => e.fromUser === true);
	const foundations = active.filter((e) => e.fromUser !== true && age(e) >= horizon);
	const current = active.filter((e) => e.fromUser !== true && age(e) < horizon);

	// Header and omission tail are part of the same summary, so both come out of the
	// budget; otherwise `maxTokens` caps the fact lines only and the rendered string
	// can exceed it.
	// Ceil the fixed parts and the per-line cost: with rounding in both directions the
	// rendered string could exceed `maxTokens` by a token or two (measured: 221/220).
	const reserve = Math.ceil(TAIL(99).length / 4) + 4;
	const fixed = INTRO.length + CURRENT.length + EARLIER.length;
	const budget = Math.max(1, maxTokens - Math.ceil(fixed / 4) - reserve);

	const taken = new Set<string>();
	const shown: BankEntry[] = [];
	let used = 0;
	const fill = (list: BankEntry[], share: number, spill: boolean): void => {
		let slice = 0;
		for (const entry of list) {
			if (taken.has(entry.id)) continue;
			const cost = Math.max(1, Math.ceil(`[${entry.id}] (${entry.task}) ${entry.statement}`.length / 4));
			const cap = spill ? budget : used + Math.max(0, Math.round(budget * share) - slice);
			if (used + cost > cap) continue;
			taken.add(entry.id);
			shown.push(entry);
			slice += cost;
			used += cost;
		}
	};

	fill(constraints, constraintShare, false);
	fill(foundations, foundationShare, false);
	fill(current, 0, true);
	// Anything left over (a slice that could not fill its share) goes to whatever is
	// still unshown, newest first — the summary should not come out short because a
	// session happened to have no foundations.
	if (used < budget) fill(active, 0, true);

	return {
		shown: shown.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)),
		omitted: active.length - shown.length,
	};
}

export function renderMemory(bank: BankEntry[], maxTokens = 4000, options: SelectionOptions = {}): string {
	const active = bank.filter((e) => e.status === "active");
	if (active.length === 0) return "";
	const { shown, omitted } = selectForSummary(bank, maxTokens, options);
	const horizon = options.foundationAfterChunks ?? 8;
	const latest = active.reduce((max, e) => Math.max(max, e.chunkSeq ?? 0), 0);
	// Two age groups, newest first, chronological inside each: the reader gets the
	// live state before the history, and the "later line wins" rule still holds where
	// a contradiction is possible — inside a group.
	const chronological = shown
		.slice()
		.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
	const current = chronological.filter((e) => latest - (e.chunkSeq ?? 0) < horizon);
	const earlier = chronological.filter((e) => latest - (e.chunkSeq ?? 0) >= horizon);
	const line = (e: BankEntry): string => `[${e.id}] (${e.task}) ${e.statement}`;
	const sections: string[] = [];
	if (current.length > 0) sections.push(`${CURRENT}\n${current.map(line).join("\n")}`);
	if (earlier.length > 0) sections.push(`${EARLIER}\n${earlier.map(line).join("\n")}`);
	const tail = omitted > 0 ? TAIL(omitted) : "";
	return `${INTRO}\n\n${sections.join("\n\n")}${tail}`;
}

/** `<read-files>` / `<modified-files>`, bounded, appended to a summary like pi does. */
export function renderFileOperations(ops: { readFiles: string[]; modifiedFiles: string[] }, maxPerList = 40): string {
	const fmt = (label: string, files: string[]): string => {
		if (files.length === 0) return "";
		const shown = files.slice(0, maxPerList);
		const rest = files.length - shown.length;
		return `<${label}>\n${shown.join("\n")}${rest > 0 ? `\n… ${rest} more` : ""}\n</${label}>`;
	};
	const parts = [fmt("read-files", ops.readFiles), fmt("modified-files", ops.modifiedFiles)].filter(Boolean);
	return parts.join("\n\n");
}

export function supersededTrail(bank: BankEntry[]): string {
	return bank
		.filter((e) => e.status === "superseded")
		.map((e) => `[${e.id}] superseded by ${e.supersededBy ?? "-"}: ${e.supersedeReason ?? ""}`)
		.join("\n");
}
