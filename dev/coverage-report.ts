#!/usr/bin/env npx tsx
/**
 * Offline per-draft coverage replay for an existing run (no model calls).
 *
 * Replays the run's own ledger with foldLedger so each chunk is measured
 * against the exact bank that chunk saw, then reports the starved-draft share
 * under BOTH shown-set rules: the union cap (old behaviour) and per-draft
 * selection (Tier-1). Starved under perDraft can only come from drafts with
 * candidates competing for fewer slots than drafts - a cap problem, not a
 * selection-order problem.
 *
 *   npx tsx dev/coverage-report.ts --run <runId> [--corpus dev/corpus-extended.json] [--candidate-limit 12]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { foldLedger } from "../src/bank.js";
import { candidatesPerDraft, selectShownPerDraft } from "../src/protocol.js";
import type { BankEntry, Draft, LedgerRecord } from "../src/types.js";

function coverage(
	bank: BankEntry[],
	drafts: { sourceEntryIds?: string[] }[],
	mode: "union" | "perDraft",
	limit: number,
) {
	const perDraft = candidatesPerDraft(bank, drafts as unknown as Draft[], limit);
	const union = new Map<string, BankEntry>();
	for (const list of perDraft.values()) for (const e of list) if (!union.has(e.id)) union.set(e.id, e);
	const shown = new Set(
		(mode === "perDraft" ? selectShownPerDraft(perDraft, limit) : [...union.values()].slice(0, limit)).map(
			(e) => e.id,
		),
	);
	let starved = 0;
	let none = 0;
	let withCand = 0;
	for (const list of perDraft.values()) {
		if (list.length === 0) none++;
		else {
			withCand++;
			if (!list.some((e) => shown.has(e.id))) starved++;
		}
	}
	return { starved, none, withCand };
}

function main(): void {
	const args = process.argv.slice(2);
	const flag = (name: string, dflt: string) => {
		const i = args.indexOf(name);
		return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
	};
	const runId = flag("--run", "");
	if (!runId) throw new Error("--run <runId> required");
	const corpusPath = flag("--corpus", "dev/corpus-extended.json");
	const limit = Number(flag("--candidate-limit", "12"));
	const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as { chunks: { path: string; category?: string }[] };
	const captureIds = new Set(corpus.chunks.map((c) => c.path.split("/").pop()!.replace(".json", "")));

	const records = readFileSync(join("out", runId, "ledger.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as LedgerRecord);
	const draftsOf = new Map<string, { sourceEntryIds?: string[] }[]>();
	for (const r of records) if (r.type === "hy.extract") draftsOf.set(r.chunkId, r.drafts);

	const prefix: LedgerRecord[] = [];
	let tDrafts = 0,
		tUnion = 0,
		tPer = 0,
		tNone = 0;
	console.log(`run ${runId} (offline replay, both rules measured on this run's own bank trajectory)`);
	console.log("chunk                    drafts  withCand  unionStarved  perDraftStarved  bankActive");
	for (const r of records) {
		if (r.type === "hy.ops") {
			const bankBefore = foldLedger(prefix);
			const drafts = draftsOf.get(r.chunkId) ?? [];
			if (drafts.length > 0) {
				const u = coverage(bankBefore, drafts, "union", limit);
				const p = coverage(bankBefore, drafts, "perDraft", limit);
				const active = bankBefore.filter((e) => e.status === "active").length;
				const mark = captureIds.has(r.chunkId) ? "" : "  (not in corpus)";
				console.log(
					`${r.chunkId}  ${String(drafts.length).padStart(6)}  ${String(u.withCand).padStart(9)}  ${String(u.starved).padStart(12)}  ${String(p.starved).padStart(15)}  ${String(active).padStart(10)}${mark}`,
				);
				tDrafts += drafts.length;
				tUnion += u.starved;
				tPer += p.starved;
				tNone += u.none;
			}
		}
		prefix.push(r);
	}
	console.log(
		`TOTAL drafts ${tDrafts} | no-candidate ${tNone} | union starved ${tUnion} (${((tUnion / tDrafts) * 100).toFixed(1)} %) | perDraft starved ${tPer} (${((tPer / tDrafts) * 100).toFixed(1)} %)`,
	);
}

main();
