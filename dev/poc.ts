/**
 * Proof-of-concept runner: replay real observer chunks through the write path.
 *
 *   npx tsx dev/poc.ts [--chunks 482 484 486 503] [--pool 6000]
 *
 * Reads captured observer requests from a payload capture set, so the
 * chunk text is the exact payload the production observer saw — not a synthetic
 * reconstruction.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { foldLedger } from "../src/bank.js";
import { writeChunk } from "../src/pipeline.js";
import { renderMemory, supersededTrail } from "../src/render.js";
import type { BankEntry, LedgerRecord } from "../src/types.js";
import { rawWriter } from "./raw-writer.js";

const CAPTURE_DIR = process.env.CAPTURE_DIR ?? new URL("../captures/", import.meta.url).pathname;
const OUT_DIR = process.env.OUT_DIR ?? new URL("../out/", import.meta.url).pathname;

function argList(flag: string, fallback: string[]): string[] {
	const at = process.argv.indexOf(flag);
	if (at < 0) return fallback;
	const out: string[] = [];
	for (let i = at + 1; i < process.argv.length && !process.argv[i].startsWith("--"); i++) out.push(process.argv[i]);
	return out;
}

function numArg(flag: string, fallback: number): number {
	const at = process.argv.indexOf(flag);
	return at >= 0 ? Number(process.argv[at + 1]) : fallback;
}

function textOf(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("\n");
	return "";
}

function userContent(capture: any): string {
	const messages = Array.isArray(capture?.messages) ? capture.messages : [];
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") {
			const text = textOf(messages[i]);
			if (text.includes("Source entry id")) return text;
		}
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") {
			const text = textOf(messages[i]);
			if (text.trim()) return text;
		}
	}
	throw new Error("capture has no serialized chunk");
}

async function main(): Promise<void> {
	const wanted = argList("--chunks", ["482", "484", "486", "503"]);
	const pool = numArg("--pool", 6000);
	const origin = process.env.POC_ORIGIN;
	if (!origin) throw new Error("set POC_ORIGIN (and POC_KEY / POC_MODEL) to an OpenAI-compatible endpoint");
	const writer = rawWriter({
		origin,
		apiKey: process.env.POC_KEY,
		model: process.env.POC_MODEL ?? "hy-memory-30b-a3b",
		maxTokens: numArg("--max-tokens", 8000),
		chatTemplateKwargs: { reasoning_effort: "none" },
	});

	const files = readdirSync(CAPTURE_DIR)
		.filter((f) => /^cap_\d+_observer_.*\.json$/.test(f))
		.filter((f) => wanted.some((id) => f.startsWith(`cap_${id}_`)))
		.sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));

	if (files.length === 0) throw new Error(`no captures matched in ${CAPTURE_DIR}`);

	mkdirSync(OUT_DIR, { recursive: true });
	mkdirSync(`${OUT_DIR}/raw`, { recursive: true });
	const ledger: LedgerRecord[] = [];
	const bank: BankEntry[] = [];
	const rows: string[] = [];

	console.log(`model=${writer.model} origin=${origin} temp=0 kwargs=none`);
	console.log(`captures=${files.length} pool=${pool} tokens\n`);

	for (const file of files) {
		const capture = JSON.parse(readFileSync(`${CAPTURE_DIR}/${file}`, "utf8"));
		const chunkId = file.replace(/\.json$/, "");
		const started = Date.now();
		let write: Awaited<ReturnType<typeof writeChunk>>;
		try {
			write = await writeChunk(writer, bank, chunkId, userContent(capture), {
				bankMaxTokens: pool,
				rawDir: `${OUT_DIR}/raw`,
			});
		} catch (error) {
			console.error(`${chunkId}: FAILED ${(error as Error).message}`);
			continue;
		}
		ledger.push(...write.records);

		const counts = { ADD: 0, UPDATE: 0, DELETE: 0, SKIP: 0 };
		for (const op of write.ops) counts[op.action]++;
		const active = bank.filter((e) => e.status === "active").length;
		const inTok = write.usage.extract.inTokens + write.usage.reconcile.inTokens;
		const outTok = write.usage.extract.outTokens + write.usage.reconcile.outTokens;
		const wall = (Date.now() - started) / 1000;

		console.log(`### ${chunkId}`);
		console.log(
			`  chunk entries ${write.entryCount} | drafts ${write.drafts.length} (rejected ${write.rejectedDrafts.length})`,
		);
		console.log(
			`  bank shown ${write.seen.length} | ops ADD ${counts.ADD} UPDATE ${counts.UPDATE} DELETE ${counts.DELETE} (rejected ${write.rejectedOps.length}) | omitted drafts ${write.report.omitted}`,
		);
		console.log(
			`  in ${inTok} tok | out ${outTok} tok | wall ${wall.toFixed(1)}s (extract ${write.usage.extract.wallS.toFixed(1)}s, reconcile ${write.usage.reconcile.wallS.toFixed(1)}s)`,
		);
		console.log(`  bank active ${active} / total ${bank.length}`);
		for (const entry of write.report.added) console.log(`    + [${entry.id}] ${entry.statement}`);
		for (const { entry, target } of write.report.updated)
			console.log(`    ~ [${entry.id}] <- ${target}: ${entry.statement}`);
		for (const del of write.report.deleted) console.log(`    - [${del.target}] ${del.reason}`);
		for (const rej of write.rejectedOps.slice(0, 4))
			console.log(`    x rejected op: ${rej.reason} ${JSON.stringify(rej.op).slice(0, 120)}`);
		for (const rej of write.rejectedDrafts.slice(0, 4)) console.log(`    x rejected draft: ${rej.reason}`);
		console.log();

		rows.push(
			`| ${chunkId.replace("cap_", "")} | ${write.entryCount} | ${write.drafts.length} | ${write.seen.length} | ${counts.ADD} | ${counts.UPDATE} | ${counts.DELETE} | ${write.rejectedOps.length} | ${inTok} | ${outTok} | ${wall.toFixed(1)} | ${active} |`,
		);
	}

	const refolded = foldLedger(ledger);
	const summary = renderMemory(bank, pool);
	writeFileSync(`${OUT_DIR}/ledger.jsonl`, `${ledger.map((r) => JSON.stringify(r)).join("\n")}\n`);
	writeFileSync(`${OUT_DIR}/bank.json`, JSON.stringify(bank, null, 1));
	writeFileSync(`${OUT_DIR}/summary.md`, `${summary}\n`);
	writeFileSync(`${OUT_DIR}/superseded.md`, `${supersededTrail(bank)}\n`);

	console.log("### totals");
	console.log(
		"| chunk | entries | drafts | shown | ADD | UPDATE | DELETE | rejected ops | in tok | out tok | wall s | active |",
	);
	console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
	console.log(rows.join("\n"));
	console.log(
		`\nbank: ${bank.length} entries, ${bank.filter((e) => e.status === "active").length} active, ` +
			`${bank.filter((e) => e.status === "active").reduce((s, e) => s + e.tokenCount, 0)} tokens, ` +
			`${bank.filter((e) => e.sourceEntryIds.length === 0).length} ungrounded`,
	);
	console.log(
		`ledger fold check: ${refolded.filter((e) => e.status === "active").length} active after re-folding the ledger`,
	);
	console.log(`wrote ${OUT_DIR}/ledger.jsonl, bank.json, summary.md, superseded.md`);
	void existsSync;
}

main().catch((error) => {
	console.error(String((error as Error)?.message ?? error));
	process.exit(1);
});
