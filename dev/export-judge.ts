/**
 * Export the PoC bank in a judge-friendly result shape, one file per chunk, so
 * the bank can be judged with the same rubric and the same captures as every other
 * model in the harness. Derived from the ledger by folding it — no model calls.
 *
 *   npx tsx src/export-judge.ts        # OUT_DIR defaults to ../out
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { foldLedger } from "../src/bank.js";
import type { LedgerRecord } from "../src/types.js";

const OUT_DIR = process.env.OUT_DIR ?? new URL("../out/", import.meta.url).pathname;

function main(): void {
	const ledger = readFileSync(`${OUT_DIR}/ledger.jsonl`, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as LedgerRecord);

	const bank = foldLedger(ledger);
	const byChunk = new Map<string, typeof bank>();
	for (const entry of bank) {
		if (!entry.chunkId) continue;
		byChunk.set(entry.chunkId, [...(byChunk.get(entry.chunkId) ?? []), entry]);
	}

	mkdirSync(`${OUT_DIR}/judge`, { recursive: true });
	for (const [chunkId, entries] of byChunk) {
		const observations = entries.map((entry) => ({
			id: entry.id,
			content: entry.statement,
			relevance: entry.relevance,
			sourceEntryIds: entry.sourceEntryIds ?? [],
			tokens: entry.tokenCount ?? Math.round(entry.statement.length / 4),
		}));
		const file = `${OUT_DIR}/judge/${chunkId}__hy_bank.json`;
		writeFileSync(
			file,
			JSON.stringify(
				{
					capture: chunkId,
					model: "hy-memory-30b-a3b (bank protocol)",
					protocol: "extract drafts -> ADD/UPDATE/DELETE ops, single shot, temp 0, no_think",
					recorded: observations.length,
					superseded: entries.filter((e) => e.status === "superseded").length,
					observations,
				},
				null,
				1,
			),
		);
		console.log(`${file}: ${observations.length} observations`);
	}
}

main();
