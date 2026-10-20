#!/usr/bin/env npx tsx
/**
 * Summary-selection A/B on an existing run's ledger. No model calls.
 *
 * The bank is a store; the summary is a selection over it (DESIGN.md § "The bank is
 * a store; the summary is a selection"). This compares the rules side by side on a
 * real ledger:
 *
 *   recency   newest-first over a bank trimmed to the cap (the old behaviour)
 *   tiered    constraints -> foundations -> current state (production)
 *
 * Reportable axes: facts shown, omitted, how far back the selection reaches in
 * chunks, median age, and how many user-grounded facts survive.
 *
 *   npx tsx dev/summary-ab.ts --run trans-base [--cap 6000] [--horizon 8]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { enforceBudget, foldLedger } from "../src/bank.js";
import { renderMemory, selectForSummary, summaryBudget } from "../src/render.js";
import type { LedgerRecord } from "../src/types.js";

function arg(flag: string, fallback: string): string {
	const at = process.argv.indexOf(flag);
	return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

function main(): void {
	const runId = arg("--run", "");
	if (!runId) throw new Error("--run <runId> is required");
	const cap = Number(arg("--cap", "8000"));
	const horizon = Number(arg("--horizon", "8"));
	const records = readFileSync(join("out", runId, "ledger.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as LedgerRecord);
	const bank = foldLedger(records);
	const active = bank.filter((e) => e.status === "active");
	if (active.length === 0) throw new Error(`run ${runId} has no active facts`);
	const latest = active.reduce((max, e) => Math.max(max, e.chunkSeq ?? 0), 0);
	const age = (e: { chunkSeq?: number }): number => latest - (e.chunkSeq ?? 0);

	const trimmed = bank.map((e) => ({ ...e }));
	enforceBudget(trimmed, cap);
	const budget = summaryBudget(cap, active);
	const before = selectForSummary(trimmed, budget, { constraintShare: 0, foundationShare: 0 });
	const after = selectForSummary(bank, budget, { foundationAfterChunks: horizon });

	const report = (label: string, sel: { shown: typeof active; omitted: number }): void => {
		const ages = sel.shown.map(age).sort((a, b) => b - a);
		const chunks = new Set(sel.shown.map((e) => e.chunkSeq)).size;
		const users = sel.shown.filter((e) => e.fromUser).length;
		console.log(
			`${label.padEnd(9)} shown ${String(sel.shown.length).padStart(3)}  omitted ${String(sel.omitted).padStart(3)}  ` +
				`oldest age ${String(ages[0] ?? 0).padStart(3)}  median ${String(ages[Math.floor(ages.length / 2)] ?? 0).padStart(3)}  ` +
				`chunks ${String(chunks).padStart(3)}  user-grounded ${users}`,
		);
	};

	console.log(
		`run ${runId}: ${records.length} records, bank ${bank.length} entries (${active.length} active, ` +
			`${active.filter((e) => e.fromUser).length} user-grounded), ${active.reduce((s, e) => s + e.tokenCount, 0)} fact tokens, cap ${cap}`,
	);
	report("recency", before);
	report("tiered", after);

	const oldIds = new Set(before.shown.map((e) => e.id));
	const gained = after.shown.filter((e) => !oldIds.has(e.id));
	console.log(
		`\ntiered adds ${gained.length} facts recency never showed` +
			(gained.length
				? `, ages ${gained
						.map(age)
						.sort((a, b) => b - a)
						.slice(0, 8)
						.join(",")}${gained.length > 8 ? ",…" : ""}`
				: ""),
	);
	const rendered = renderMemory(bank, summaryBudget(cap, active), { foundationAfterChunks: horizon });
	console.log(
		`rendered ${Math.round(rendered.length / 4)} tokens, ${rendered.split("\n").filter((l) => /^\[[a-f0-9]{12}\]/.test(l)).length} fact lines, ` +
			`${/more facts? not shown/.test(rendered) ? "with an omission tail" : "complete"}`,
	);
}

main();
