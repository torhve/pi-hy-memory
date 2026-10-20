/**
 * Pool-cap lifecycle check: fold → enforce → reload → enforce.
 *
 * Budget eviction is deliberately *not* written to the ledger — it is pressure,
 * not deletion, so re-folding a session restores the evicted facts. That has two
 * consequences this file pins:
 *
 * 1. Raising `poolMaxTokens` retroactively restores facts (observed live on
 *    session 01a14c10: 69 → 91 active after a reload at 12 000).
 * 2. A reload alone must not leave the bank above the current cap, which is why
 *    `loadState` re-applies `enforceBudget` after folding. Without that, the bank,
 *    the footer bar and the compaction summary can all sit over budget until the
 *    next write.
 *
 * Also pins that the rendered summary fits `summaryBudget`, including when task
 * strings are long — the reason the summary budget sums the real `[id] (task) `
 * prefixes instead of multiplying the pool by a constant.
 */

import { enforceBudget, foldLedger } from "../src/bank.js";
import { renderMemory, summaryBudget } from "../src/render.js";
import type { LedgerRecord } from "../src/types.js";

const estimate = (s: string): number => Math.max(1, Math.round(s.length / 4));
let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** One chunk of `n` ADD drafts, each `chars` characters of statement text. */
const chunk = (seq: number, n: number, chars: number, task = "t"): LedgerRecord[] => {
	const chunkId = `chunk-${String(seq).padStart(3, "0")}`;
	const createdAt = new Date(Date.UTC(2026, 0, 1, seq)).toISOString();
	const drafts = Array.from({ length: n }, (_, i) => ({
		task,
		statement: `fact ${seq}.${i} ${"x".repeat(chars)}`,
		keys: ["k"],
		refs: [1],
		sourceEntryIds: [`entry-${seq}-${i}`],
	}));
	return [
		{
			type: "hy.extract",
			chunkId,
			coversUpToId: `entry-${seq}`,
			createdAt,
			drafts,
			rejectedCount: 0,
			usage: { inTokens: 1, outTokens: 1, wallS: 0 },
		},
		{
			type: "hy.ops",
			chunkId,
			coversUpToId: `entry-${seq}`,
			createdAt,
			ops: drafts.map((_, draft) => ({ action: "ADD" as const, draft })),
			rejectedCount: 0,
			usage: { inTokens: 1, outTokens: 1, wallS: 0 },
		},
	];
};

const ledger: LedgerRecord[] = [
	...chunk(1, 30, 288),
	...chunk(2, 30, 288, "a much longer task label that costs real tokens"),
];
const POOL = 3_000;

// Fold as a fresh session would, and enforce the pool.
const first = foldLedger(ledger);
const activeBefore = first.filter((e) => e.status === "active").length;
const firstEnforce = enforceBudget(first, POOL);
const activeAfter = first.filter((e) => e.status === "active").length;
check(
	"pool evicts on a fresh fold",
	firstEnforce.dropped.length > 0,
	`${activeBefore} → ${activeAfter} of ${first.length}`,
);
check(
	"eviction names a reason",
	firstEnforce.dropped.every((e) => e.supersedeReason === "bank budget"),
);
check(
	"evicted bank fits the pool",
	first.filter((e) => e.status === "active").reduce((s, e) => s + e.tokenCount, 0) <= POOL,
	`${first.filter((e) => e.status === "active").reduce((s, e) => s + e.tokenCount, 0)}/${POOL}`,
);

// Reload: same ledger, no eviction records → facts come back, then get re-capped.
const reloaded = foldLedger(ledger);
check("reload restores evicted facts", reloaded.filter((e) => e.status === "active").length === activeBefore);
const reEnforced = enforceBudget(reloaded, POOL);
check(
	"load-time enforce re-caps the bank",
	reEnforced.dropped.length === firstEnforce.dropped.length,
	`${reEnforced.dropped.length} dropped again`,
);

// Raising the cap is retroactive: nothing to drop at 2x the pool.
const raised = enforceBudget(foldLedger(ledger), POOL * 2);
check("raising the cap restores everything", raised.dropped.length === 0);

// The summary fits its budget, even with the long task labels in chunk 2.
const bank = foldLedger(ledger);
const budget = summaryBudget(POOL, bank);
const summary = renderMemory(bank, budget);
check("summary fits summaryBudget", estimate(summary) <= budget, `${estimate(summary)}/${budget}`);
check(
	"summaryBudget tracks the real prefixes",
	budget > POOL && budget - POOL > 0,
	`+${budget - POOL} tokens of prefixes for ${bank.filter((e) => e.status === "active").length} facts`,
);
check("long task labels do not truncate", !summary.includes("not shown") || estimate(summary) <= budget);

console.log(failures === 0 ? "ok: pool cap lifecycle" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
