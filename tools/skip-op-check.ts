#!/usr/bin/env npx tsx
/**
 * tools/skip-op-check.ts - the SKIP op contract, end to end through code.
 *
 * parseOps accepts SKIP with a valid draft index, rejects out-of-range and
 * duplicate-draft SKIPs; applyOps records the decision without touching the
 * bank; foldLedger replays it identically; omitted counts only drafts with no
 * op at all, so an explicit SKIP is distinguishable from a silent drop.
 */

import { applyOps, foldLedger } from "../src/bank.js";
import { parseOps } from "../src/protocol.js";
import type { BankEntry, LedgerRecord } from "../src/types.js";

function assert(cond: boolean, label: string): void {
	if (!cond) {
		console.error(`FAIL: ${label}`);
		process.exit(1);
	}
}

const draftOf = (i: number) => ({
	task: `task ${i}`,
	statement: `statement number ${i} about something durable`,
	keys: [`k${i}`],
	refs: [i],
	sourceEntryIds: [],
});

// 1) parse: SKIP survives, bad ones are rejected.
const parsed = parseOps(
	JSON.stringify({
		ops: [
			{ action: "ADD", draft: 0 },
			{ action: "SKIP", draft: 1, reason: "restates entry above" },
			{ action: "SKIP", draft: 9 },
			{ action: "SKIP", draft: 0, reason: "duplicate of the ADD" },
		],
	}),
	2,
	new Set<string>(),
);
assert(parsed.ops.length === 2, `two ops survive: ${parsed.ops.length}`);
assert(
	parsed.ops.some((o) => o.action === "SKIP" && o.draft === 1),
	"valid SKIP parsed",
);
assert(parsed.rejected.length === 2, `out-of-range and duplicate rejected: ${parsed.rejected.length}`);

// 2) apply: SKIP adds nothing, records the decision, and the skipped draft is
// not double-counted as silently omitted.
const bank: BankEntry[] = [];
const drafts = [draftOf(0), draftOf(1)];
const report = applyOps(bank, drafts, parsed.ops, "hy-skip-001", ["e1", "e2"], new Date().toISOString());
assert(report.added.length === 1, `only the ADD adds: ${report.added.length}`);
assert(report.skipped.length === 1 && report.skipped[0].draft === 1, "skip recorded with reason");
assert(report.omitted === 0, `explicit skip is not an omission: ${report.omitted}`);
assert(bank.length === 1, `bank holds only the added entry: ${bank.length}`);

// 3) a silent drop (no op at all) stays visible as omitted.
const silent = parseOps(JSON.stringify({ ops: [{ action: "ADD", draft: 0 }] }), 2, new Set<string>());
const bank2: BankEntry[] = [];
const report2 = applyOps(bank2, drafts, silent.ops, "hy-skip-002", ["e1", "e2"], new Date().toISOString());
assert(report2.skipped.length === 0 && report2.omitted === 1, "silent drop reads as omitted");

// 4) foldLedger replays SKIP without inventing an entry.
const records: LedgerRecord[] = [
	{
		type: "hy.extract",
		chunkId: "hy-skip-003",
		coversUpToId: "e2",
		createdAt: "2026-01-01T00:00:00.000Z",
		drafts: drafts.map((d) => ({ ...d })),
		rejectedCount: 0,
		usage: { inTokens: 1, outTokens: 1, wallS: 1 },
	},
	{
		type: "hy.ops",
		chunkId: "hy-skip-003",
		coversUpToId: "e2",
		createdAt: "2026-01-01T00:00:00.000Z",
		ops: parsed.ops.map((o) => ({
			...o,
			draftStatement: o.action === "DELETE" ? undefined : drafts[o.draft].statement,
		})),
		rejectedCount: parsed.rejected.length,
		usage: { inTokens: 1, outTokens: 1, wallS: 1 },
	},
];
const folded = foldLedger(records);
assert(folded.length === 1, `fold adds only the ADD: ${folded.length}`);
assert(folded[0].chunkId === "hy-skip-003", "entry belongs to the chunk");

console.log("ok: SKIP parses, applies, folds; explicit skip is distinguishable from silent omission");
