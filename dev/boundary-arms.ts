#!/usr/bin/env npx tsx
/**
 * dev/boundary-arms.ts — does the position of a chunk boundary change what the bank keeps?
 *
 * `hy_flush` exists on the argument that a chunk cut *inside* a transition costs
 * updates: each write then sees a smaller slice of the transition it has to
 * reconcile. That has never been measured. The corpus cannot measure it, because every
 * capture in `dev/corpus-extended.json` arrived with its boundary already fixed by the
 * observer's threshold — replaying them is the same cut twice.
 *
 * So this harness moves the cut over identical content. The control is one capture per
 * write, which is the shipped behaviour and is what the baseline run already produced.
 * The arm cuts each capture into `--parts` pieces at entry boundaries, so every write
 * sees a smaller slice of the same stretch — one boundary per piece, and one of them
 * necessarily falls mid-transition. Same writer, temperature 0, bank path and candidate
 * selection; only the cut moves.
 *
 * Merging instead of splitting was the first idea — a wider range, cut where a stretch
 * ended — but these captures are 13 000–20 000 estimated tokens each, so a merged pair
 * is a 30 000-token prompt: past the context of the local writer, and the arm would
 * measure a truncation rather than a boundary.
 *
 * Two limits stated up front, because both bias the reading:
 *
 * - Splitting multiplies the writes. An arm that keeps the same facts for twice the
 *   calls has lost, and the cost column is printed next to the quality columns for
 *   exactly that reason.
 * - Later pieces start with an empty view of what the first piece of the same capture
 *   just wrote, which is the effect being tested, not a flaw in the harness.
 *
 * Compare is by run *directory*: statement text comes from each run's ledger, so both
 * arms are scored on the same definition regardless of which harness wrote the metrics.
 *
 *   npx tsx dev/boundary-arms.ts --run halves-2026-10-21 --parts 2
 *   npx tsx dev/boundary-arms.ts --compare out/base-2026-10-21 out/halves-2026-10-21
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { foldLedger } from "../src/bank.js";
import { writeChunk } from "../src/pipeline.js";
import { renderMemory } from "../src/render.js";
import { rolesFromText, type SerializedChunk } from "../src/serialize.js";
import { type BankEntry, estimateTokens, type LedgerRecord } from "../src/types.js";
import { rawWriter } from "./raw-writer.js";
import { resolveRoute } from "./run.js";

type Capture = {
	chunkId: string;
	sessionId: string;
	entryCount: number;
	estimateChunkTokens: number;
	text: string;
	refs: string[];
};

type Row = {
	chunkId: string;
	parent: string;
	part: number;
	entryCount: number;
	chunkTokens: number;
	drafts: number;
	rejectedDrafts: string[];
	ops: { ADD: number; UPDATE: number; DELETE: number; SKIP: number };
	rejectedOps: string[];
	downgradedOps: string[];
	budgetDropped: number;
	statementTokens: number;
	bankBefore: { active: number; tokens: number };
	bankAfter: { active: number; tokens: number };
	usage: { inTokens: number; outTokens: number; wallTotalS: number };
};

const arg = (flag: string, fallback: string): string => {
	const i = process.argv.indexOf(flag);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const numArg = (flag: string, fallback: number): number => {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};

const ENTRY_START = /^\[(\d+)\] \[/;

/** Entry groups of a serialized chunk: a ref line plus the continuation lines under it. */
function entryGroups(text: string): { ref: number; lines: string[] }[] {
	const groups: { ref: number; lines: string[] }[] = [];
	for (const line of text.split("\n")) {
		const at = ENTRY_START.exec(line);
		if (at) groups.push({ ref: Number(at[1]), lines: [line] });
		else if (groups.length > 0) groups[groups.length - 1].lines.push(line);
	}
	return groups;
}

/**
 * Cut a capture into `parts` pieces at entry boundaries. Refs are renumbered from 0 in
 * each piece — they are positional, and a piece that kept `[41]` would cite an entry it
 * never contains.
 */
function splitCapture(capture: Capture, parts: number): SerializedChunk[] {
	const groups = entryGroups(capture.text);
	if (groups.length <= 1 || parts <= 1) {
		return [
			{
				text: capture.text,
				refs: capture.refs,
				entryCount: capture.entryCount,
				roles: rolesFromText(capture.text),
			},
		];
	}
	const tokens = groups.map((g) => estimateTokens(g.lines.join("\n")));
	const total = tokens.reduce((s, t) => s + t, 0);
	const target = total / parts;
	const cuts: number[] = [];
	let run = 0;
	let piece = 1;
	for (let i = 0; i < groups.length - 1; i++) {
		run += tokens[i];
		if (run >= target * piece && piece < parts) {
			cuts.push(i + 1);
			piece++;
		}
	}
	const bounds = [0, ...cuts, groups.length];
	const pieces: SerializedChunk[] = [];
	for (let p = 0; p < bounds.length - 1; p++) {
		const slice = groups.slice(bounds[p], bounds[p + 1]);
		if (slice.length === 0) continue;
		const renumber = new Map(slice.map((g, i) => [g.ref, i] as [number, number]));
		const text = slice
			.map((g) =>
				g.lines
					.map((line, i) => (i === 0 ? line.replace(/^\[\d+\]/, `[${renumber.get(g.ref)}]`) : line))
					.join("\n"),
			)
			.join("\n");
		pieces.push({
			text,
			refs: slice.map((g) => capture.refs[g.ref] ?? g.ref.toString()),
			entryCount: slice.length,
			roles: rolesFromText(text),
		});
	}
	return pieces;
}

/** Statement text the run actually wrote, read back through the ledger. */
function statementsOf(dir: string): string[] {
	const records = readFileSync(join(dir, "ledger.jsonl"), "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as LedgerRecord);
	const drafts = new Map<string, { statement: string }[]>();
	for (const r of records) if (r.type === "hy.extract") drafts.set(String(r.chunkId), r.drafts);
	const out: string[] = [];
	for (const r of records) {
		if (r.type !== "hy.ops") continue;
		const list = drafts.get(String(r.chunkId)) ?? [];
		for (const op of r.ops as unknown as { action: string; draft?: number }[]) {
			if ((op.action === "ADD" || op.action === "UPDATE") && typeof op.draft === "number") {
				const statement = list[op.draft]?.statement;
				if (statement) out.push(statement);
			}
		}
	}
	return out;
}

/** Token accounting that tolerates both harness shapes (CallUsage objects or plain sums). */
function callTokens(value: unknown): number {
	if (typeof value === "number") return value;
	if (value && typeof value === "object") {
		const v = value as { inTokens?: number; outTokens?: number };
		return (v.inTokens ?? 0) + (v.outTokens ?? 0);
	}
	return 0;
}

function statsOf(dir: string) {
	const metrics = JSON.parse(readFileSync(join(dir, "metrics.json"), "utf8")) as {
		chunks: {
			ops?: Record<string, number>;
			drafts?: number;
			entryCount?: number;
			usage?: Record<string, unknown>;
		}[];
	};
	const ops = { ADD: 0, UPDATE: 0, DELETE: 0, SKIP: 0 };
	let drafts = 0;
	let entries = 0;
	let rejectedDrafts = 0;
	let rejectedOps = 0;
	let wall = 0;
	let promptTokens = 0;
	for (const c of metrics.chunks) {
		for (const k of ["ADD", "UPDATE", "DELETE", "SKIP"] as const) ops[k] += c.ops?.[k] ?? 0;
		drafts += c.drafts ?? 0;
		entries += c.entryCount ?? 0;
		rejectedDrafts += Array.isArray((c as { rejectedDrafts?: unknown[] }).rejectedDrafts)
			? (c as { rejectedDrafts: unknown[] }).rejectedDrafts.length
			: 0;
		rejectedOps += Array.isArray((c as { rejectedOps?: unknown[] }).rejectedOps)
			? (c as { rejectedOps: unknown[] }).rejectedOps.length
			: 0;
		wall += Number((c.usage as { wallTotalS?: number } | undefined)?.wallTotalS ?? 0);
		// The two harnesses record usage differently — `dev/run.ts` per call, this one aggregated —
		// and reading only one shape reports the other as zero.
		const perCall = callTokens(c.usage?.extract) + callTokens(c.usage?.reconcile);
		promptTokens += perCall || callTokens(c.usage);
	}
	const statements = statementsOf(dir);
	const statementTokens = statements.reduce((s, t) => s + estimateTokens(t), 0);
	const written = ops.ADD + ops.UPDATE;
	return {
		writes: metrics.chunks.length,
		entries,
		drafts,
		ADD: ops.ADD,
		UPDATE: ops.UPDATE,
		DELETE: ops.DELETE,
		reconciled: ops.UPDATE + ops.DELETE,
		reconcileRate: drafts ? Number(((ops.UPDATE + ops.DELETE) / drafts).toFixed(3)) : 0,
		rejectedDrafts,
		rejectedOps,
		statements: statements.length,
		statementTokens,
		meanStatementTokens: written ? Math.round(statementTokens / written) : 0,
		promptTokens,
		wall: Number(wall.toFixed(1)),
	};
}

function compare(dirs: string[]): void {
	const rows = dirs.map((dir) => ({ dir, s: statsOf(dir) }));
	const keys = Object.keys(rows[0].s) as (keyof ReturnType<typeof statsOf>)[];
	console.log(["run", ...keys].join("\t"));
	for (const row of rows) console.log([row.dir, ...keys.map((k) => String(row.s[k]))].join("\t"));
	if (rows.length === 2) {
		console.log("delta (second − first)");
		for (const key of keys) {
			const a = rows[0].s[key];
			const b = rows[1].s[key];
			if (typeof a === "number" && typeof b === "number") console.log(`${key}\t${Number((b - a).toFixed(3))}`);
		}
	}
}

function bankStats(bank: BankEntry[]): { active: number; tokens: number } {
	const active = bank.filter((e) => e.status === "active");
	return { active: active.length, tokens: active.reduce((s, e) => s + e.tokenCount, 0) };
}

async function main(): Promise<void> {
	if (process.argv.includes("--compare")) {
		compare(process.argv.slice(process.argv.indexOf("--compare") + 1).filter((a) => !a.startsWith("--")));
		return;
	}
	const runId = arg("--run", "");
	if (!runId) throw new Error("--run <runId> is required (or --compare <dirA> <dirB>)");
	const corpusPath = arg("--corpus", new URL("./corpus-extended.json", import.meta.url).pathname);
	const capturesDir = new URL("../captures-dev/", import.meta.url).pathname;
	const outDir = new URL(`../out/${runId}/`, import.meta.url).pathname;
	const parts = numArg("--parts", 2);
	const dry = process.argv.includes("--dry");
	const pool = numArg("--pool", 60000);
	const renderMode = arg("--candidate-render-mode", "perDraft") as "union" | "perDraft";
	const candidateLimit = numArg("--candidate-limit", 24);
	const modelSpec = process.env.POC_MODEL;
	if (!modelSpec) {
		console.error("POC_MODEL is required: a provider/modelId from your own pi model list.");
		process.exit(1);
	}
	const route = process.env.POC_ORIGIN
		? { origin: process.env.POC_ORIGIN, apiKey: process.env.POC_KEY, model: modelSpec }
		: await resolveRoute(modelSpec);

	const corpus = (JSON.parse(readFileSync(corpusPath, "utf8")).chunks ?? []) as { path: string }[];
	const writer = rawWriter({
		origin: route.origin,
		apiKey: route.apiKey,
		model: route.model,
		maxTokens: 8000,
		chatTemplateKwargs: { reasoning_effort: "none" },
		timeoutMs: 600_000,
	});

	mkdirSync(join(outDir, "raw"), { recursive: true });
	const ledgerPath = join(outDir, "ledger.jsonl");
	const metricsPath = join(outDir, "metrics.json");
	const ledger: LedgerRecord[] = existsSync(ledgerPath)
		? readFileSync(ledgerPath, "utf8")
				.split("\n")
				.filter((l) => l.trim())
				.map((l) => JSON.parse(l) as LedgerRecord)
		: [];
	const bank: BankEntry[] = foldLedger(ledger);
	const done = new Set<string>(ledger.filter((r) => r.type === "hy.ops").map((r) => String(r.chunkId)));
	const metrics: {
		runId: string;
		model: string;
		pool: number;
		renderMode: string;
		candidateLimit: number;
		parts: number;
		chunks: Row[];
	} = {
		runId,
		model: route.model,
		pool,
		renderMode,
		candidateLimit,
		parts,
		chunks: existsSync(metricsPath) ? ((JSON.parse(readFileSync(metricsPath, "utf8")).chunks ?? []) as Row[]) : [],
	};

	console.log(
		`run=${runId} model=${route.model} origin=${route.origin} arm=split parts=${parts} over ${corpus.length} captures, candidates=${renderMode} limit=${candidateLimit}`,
	);

	for (const [index, item] of corpus.entries()) {
		const capture = JSON.parse(readFileSync(join(capturesDir, item.path), "utf8")) as Capture;
		const pieces = splitCapture(capture, parts);
		for (const [part, piece] of pieces.entries()) {
			if (dry)
				console.log(
					`${capture.chunkId}.${part + 1}: entries ${piece.entryCount} refs ${piece.refs.length} tokens ${estimateTokens(piece.text)} roles ${(piece.roles ?? []).length}`,
				);
			if (dry) continue;
			const chunkId = parts === 1 ? capture.chunkId : `${capture.chunkId}.${part + 1}`;
			if (done.has(chunkId)) {
				console.log(`skip ${chunkId} (already in ledger)`);
				continue;
			}
			const before = bankStats(bank);
			const started = Date.now();
			let persisted: (LedgerRecord & { type: "hy.extract" }) | undefined;
			let write: Awaited<ReturnType<typeof writeChunk>> | undefined;
			for (let attempt = 1; attempt <= 3; attempt++) {
				try {
					write = await writeChunk(writer, bank, chunkId, piece, {
						bankMaxTokens: pool,
						rawDir: join(outDir, "raw"),
						candidateRenderMode: renderMode,
						candidateLimit,
						resume: persisted
							? {
									drafts: persisted.drafts as never,
									rejected: [],
									usage: persisted.usage as never,
									refs: piece.refs,
									coversUpToId: String(persisted.coversUpToId),
								}
							: undefined,
						onExtract: (record) => {
							appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`);
							persisted = record;
						},
					});
					break;
				} catch (error) {
					const message = String((error as Error)?.message ?? error);
					if (attempt === 3) {
						console.error(`${chunkId}: FAILED ${message}`);
						break;
					}
					console.error(`${chunkId}: attempt ${attempt} failed (${message}); retrying`);
					await new Promise((resolve) => setTimeout(resolve, 45_000));
				}
			}
			if (!write) continue;
			const fresh = write.records.filter((r) => !(r.type === "hy.extract" && persisted));
			for (const r of fresh) appendFileSync(ledgerPath, `${JSON.stringify(r)}\n`);
			ledger.push(...write.records);
			const after = bankStats(bank);
			const statements = write.ops
				.filter((o) => o.action === "ADD" || o.action === "UPDATE")
				.map((o) => write.drafts[(o as { draft?: number }).draft ?? -1]?.statement ?? "")
				.filter(Boolean);
			const row: Row = {
				chunkId,
				parent: `${index + 1}/${corpus.length}`,
				part: part + 1,
				entryCount: write.entryCount,
				chunkTokens: estimateTokens(piece.text),
				drafts: write.drafts.length,
				rejectedDrafts: write.rejectedDrafts.map((r) => r.reason),
				ops: {
					ADD: write.ops.filter((o) => o.action === "ADD").length,
					UPDATE: write.ops.filter((o) => o.action === "UPDATE").length,
					DELETE: write.ops.filter((o) => o.action === "DELETE").length,
					SKIP: write.ops.filter((o) => o.action === "SKIP").length,
				},
				rejectedOps: write.rejectedOps.map((r) => r.reason),
				downgradedOps: write.downgraded.map((r) => r.reason),
				budgetDropped: write.budgetDropped.length,
				statementTokens: statements.reduce((s, t) => s + estimateTokens(t), 0),
				bankBefore: before,
				bankAfter: after,
				usage: {
					inTokens: write.usage.extract.inTokens + write.usage.reconcile.inTokens,
					outTokens: write.usage.extract.outTokens + write.usage.reconcile.outTokens,
					wallTotalS: Number(((Date.now() - started) / 1000).toFixed(1)),
				},
			};
			metrics.chunks.push(row);
			writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
			console.log(
				`${chunkId}: entries ${row.entryCount} chunk ${row.chunkTokens} tok | drafts ${row.drafts} (rejected ${row.rejectedDrafts.length}) | ADD ${row.ops.ADD} UPDATE ${row.ops.UPDATE} DELETE ${row.ops.DELETE} | bank ${before.active}->${after.active} (${after.tokens} tok) | ${row.usage.inTokens}+${row.usage.outTokens} tok, ${row.usage.wallTotalS}s`,
			);
		}
	}

	if (!dry) {
		writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
		writeFileSync(join(outDir, "bank.json"), `${JSON.stringify(bank, null, 1)}\n`);
		writeFileSync(join(outDir, "summary.md"), `${renderMemory(bank, pool)}\n`);
	}
	if (dry) {
		console.log("dry: pieces listed, no writer calls, nothing written");
		return;
	}
	const s = statsOf(outDir);
	console.log(
		`\nrun ${runId} done: ${s.writes} writes over ${s.entries} entries, ADD ${s.ADD} UPDATE ${s.UPDATE} DELETE ${s.DELETE} (reconcile rate ${s.reconcileRate}), ${s.statements} statements / ${s.statementTokens} tokens, ${s.promptTokens} prompt tokens, ${s.wall}s wall`,
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(String((error as Error)?.message ?? error));
		process.exit(1);
	});
}
