#!/usr/bin/env npx tsx
/**
 * Transition report for an existing run. No model calls.
 *
 * The failure this measures: a chunk says something was removed, renamed or
 * replaced, the writer extracts that as a draft, and the bank ends up carrying both
 * the old fact and its negation instead of superseding. Measured on production
 * ledgers (1 588 drafts): 109 drafts mention a removal, and 93 of them became ADDs.
 *
 *   npx tsx dev/transitions-report.ts --run trans-base
 *
 * Prints the removal-draft op mix, the downgrades that hit them, and how many bank
 * facts still assert a removal at the end of the run.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { foldLedger } from "../src/bank.js";
import type { LedgerRecord } from "../src/types.js";

const REMOVAL = /\b(removed|deleted|dropped|retired|abandoned|reverted|no longer|stopped using|killed|deprecated)\b/i;

function arg(flag: string, fallback: string): string {
	const at = process.argv.indexOf(flag);
	return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

function main(): void {
	const runId = arg("--run", "");
	if (!runId) throw new Error("--run <runId> is required");
	const records = readFileSync(join("out", runId, "ledger.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as LedgerRecord);
	const extracts = new Map<string, Extract<LedgerRecord, { type: "hy.extract" }>>();
	for (const r of records) if (r.type === "hy.extract") extracts.set(r.chunkId, r);

	const ops = { ADD: 0, UPDATE: 0, DELETE: 0, SKIP: 0 };
	const removal = { drafts: 0, ADD: 0, UPDATE: 0, DELETE: 0, SKIP: 0, omitted: 0 };
	let downgraded = 0;
	let removalDowngraded = 0;
	let drafts = 0;
	for (const r of records) {
		if (r.type !== "hy.ops") continue;
		const all = extracts.get(r.chunkId)?.drafts ?? [];
		drafts += all.length;
		const acted = new Set<number>();
		for (const op of r.ops) {
			ops[op.action] += 1;
			if (!("draft" in op)) continue;
			acted.add(op.draft);
			const draft = all[op.draft];
			if (!draft || !REMOVAL.test(`${draft.statement} ${draft.task}`)) continue;
			removal.drafts += 1;
			removal[op.action] += 1;
		}
		for (const d of r.downgradedOps ?? []) {
			downgraded += 1;
			const draft = typeof d.draft === "number" ? all[d.draft] : undefined;
			if (draft && REMOVAL.test(`${draft.statement} ${draft.task}`)) removalDowngraded += 1;
		}
		for (const [index, draft] of all.entries()) {
			if (acted.has(index)) continue;
			if (!REMOVAL.test(`${draft.statement} ${draft.task}`)) continue;
			removal.drafts += 1;
			removal.omitted += 1;
		}
	}

	const bank = foldLedger(records);
	const active = bank.filter((e) => e.status === "active");
	const stillClaims = active.filter((e) => !REMOVAL.test(e.statement)).length;
	const statesRemoval = active.filter((e) => REMOVAL.test(e.statement)).length;

	console.log(`run ${runId}`);
	console.log(
		`  drafts ${drafts}, ops ADD ${ops.ADD} UPDATE ${ops.UPDATE} DELETE ${ops.DELETE} SKIP ${ops.SKIP}, downgraded ${downgraded}`,
	);
	console.log(
		`  removal drafts ${removal.drafts}: ADD ${removal.ADD} UPDATE ${removal.UPDATE} DELETE ${removal.DELETE} SKIP ${removal.SKIP} omitted ${removal.omitted}` +
			`${removal.drafts ? ` (${Math.round((100 * removal.UPDATE) / removal.drafts)}% reconciled)` : ""}`,
	);
	console.log(`  downgrades that hit a removal draft ${removalDowngraded}`);
	console.log(
		`  bank ${active.length} active (${active.reduce((s, e) => s + e.tokenCount, 0)} tokens): ${statesRemoval} state a removal, ${stillClaims} do not`,
	);
}

main();
