/**
 * Corpus runner with named run ids and chunk-level resume.
 *
 *   npx tsx dev/run.ts --run <runId> [--corpus FILE] [--pool 12000]
 *       [--candidate-render-mode union|perDraft] [--candidate-limit 12]
 *
 * Writer route resolution, in order:
 *   1. POC_ORIGIN / POC_KEY / POC_MODEL (same convention as poc.ts);
 *   2. otherwise look the model up in ~/.pi/agent/models.json by id or
 *      `provider/modelId`, so the baseline can target the live remote route
 *      without endpoints ever being written into this repo.
 *
 * Resume: `ledger.jsonl` is appended the moment the extract record exists and
 * again when the ops record lands. On restart:
 *   - a chunk with both records is skipped entirely;
 *   - a chunk with only its extract record resumes from the stored drafts — the
 *     20 k-token extract is not re-paid;
 *   - metrics.json is rewritten after every chunk, so a killed run keeps its
 *     partial numbers.
 *
 * Metrics schema: see dev/metrics.md. Candidate coverage is recomputed with the
 * exact `src/protocol.ts` selection the pipeline uses, evaluated in `onExtract`
 * while the bank is still pre-apply.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { foldLedger } from "../src/bank.js";
import { writeChunk } from "../src/pipeline.js";
import { candidatesPerDraft, selectShownPerDraft } from "../src/protocol.js";
import { renderMemory } from "../src/render.js";
import type { SerializedChunk } from "../src/serialize.js";
import type { BankEntry, Draft, LedgerRecord } from "../src/types.js";
import { rawWriter } from "./raw-writer.js";

type Row = Record<string, any>;

function arg(flag: string, fallback: string): string {
	const at = process.argv.indexOf(flag);
	return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

function numArg(flag: string, fallback: number): number {
	const at = process.argv.indexOf(flag);
	return at >= 0 ? Number(process.argv[at + 1]) : fallback;
}

/** Resolve the writer route: models.json first, then llama-swap instances (models there are registered dynamically at startup, e.g. `remote/hy-memory-30b-a3b`). */
export async function resolveRoute(modelSpec: string): Promise<{ origin: string; apiKey?: string; model: string }> {
	const store = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "models.json"), "utf8")) as {
		providers: Record<string, { baseUrl?: string; apiKey?: string; models?: { id: string }[] }>;
	};
	const [wantProvider, wantId] = modelSpec.includes("/") ? modelSpec.split(/\/(.*)/s) : [undefined, modelSpec];
	for (const [providerId, provider] of Object.entries(store.providers ?? {})) {
		if (wantProvider && providerId !== wantProvider) continue;
		for (const model of provider.models ?? []) {
			if (model.id === wantId && provider.baseUrl) {
				return { origin: provider.baseUrl, apiKey: provider.apiKey, model: model.id };
			}
		}
	}
	const cfgPath = join(homedir(), ".pi", "agent", "pi-llama-swap.json");
	if (existsSync(cfgPath)) {
		const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as {
			instances: { id: string; origin: string; port?: number; apiKey?: string }[];
		};
		for (const instance of cfg.instances ?? []) {
			const url = `${instance.origin.replace(/\/+$/, "")}${instance.port && instance.port !== 443 && instance.port !== 80 ? `:${instance.port}` : ""}`;
			try {
				const res = await fetch(`${url}/v1/models`, {
					headers: instance.apiKey ? { Authorization: `Bearer ${instance.apiKey}` } : {},
					signal: AbortSignal.timeout(10_000),
				});
				if (!res.ok) continue;
				const data = (await res.json()) as { data?: { id: string }[] };
				if ((data.data ?? []).some((m) => m.id === modelSpec)) {
					return { origin: url, apiKey: instance.apiKey, model: modelSpec };
				}
			} catch {
				/* instance unreachable; try the next */
			}
		}
	}
	throw new Error(`model "${modelSpec}" not found in models.json or any llama-swap instance`);
}

function bankStats(bank: BankEntry[]): { active: number; tokens: number } {
	const active = bank.filter((e) => e.status === "active");
	return { active: active.length, tokens: active.reduce((s, e) => s + e.tokenCount, 0) };
}

/** The same candidate selection `writeChunk` performs (per-draft limit = shown cap). */
function candidateCoverage(
	bank: BankEntry[],
	drafts: Draft[],
	mode: "union" | "perDraft" = "union",
	limit = 12,
): { zeroCandidateDrafts: number; noCandidateDrafts: number; shownUnion: number } {
	const active = bank.filter((e) => e.status === "active");
	if (active.length === 0) return { zeroCandidateDrafts: 0, noCandidateDrafts: 0, shownUnion: 0 };
	const perDraft = candidatesPerDraft(bank, drafts, limit);
	const union = new Map<string, BankEntry>();
	for (const list of perDraft.values()) for (const e of list) if (!union.has(e.id)) union.set(e.id, e);
	const shownEntries =
		mode === "perDraft" ? selectShownPerDraft(perDraft, limit) : [...union.values()].slice(0, limit);
	const shown = new Set(shownEntries.map((e) => e.id));
	let starved = 0;
	let none = 0;
	for (const list of perDraft.values()) {
		// A draft with no candidates at all has nothing to show; a draft WITH
		// candidates that the shown cap dropped is the real coverage failure.
		if (list.length === 0) none++;
		else if (!list.some((e) => shown.has(e.id))) starved++;
	}
	return { zeroCandidateDrafts: starved, noCandidateDrafts: none, shownUnion: shown.size };
}

/** Limit a prior run used, so reconstructed rows score the same selection. */
function candidateLimitFromDisk(metricsPath: string): number {
	if (!existsSync(metricsPath)) return 12;
	const prior = JSON.parse(readFileSync(metricsPath, "utf8")) as { candidateLimit?: number };
	return prior.candidateLimit ?? 12;
}

async function main(): Promise<void> {
	const runId = arg("--run", "");
	if (!runId) throw new Error("--run <runId> is required");
	const corpusPath = arg("--corpus", new URL("./corpus.json", import.meta.url).pathname);
	const capturesDir = new URL("../captures-dev/", import.meta.url).pathname;
	const outDir = new URL(`../out/${runId}/`, import.meta.url).pathname;
	const pool = numArg("--pool", 12000);
	const modelSpec = process.env.POC_MODEL ?? "remote/hy-memory-30b-a3b";
	const renderMode = arg("--candidate-render-mode", "union") as "union" | "perDraft";
	// Shown cap and per-draft retrieval depth are the same number in `writeChunk`
	// (`candidateLimit`), so one flag moves both.
	const candidateLimit = numArg("--candidate-limit", 12);
	const route = process.env.POC_ORIGIN
		? { origin: process.env.POC_ORIGIN, apiKey: process.env.POC_KEY, model: process.env.POC_MODEL ?? modelSpec }
		: await resolveRoute(modelSpec);

	if (process.argv.includes("--probe")) {
		console.log(`route ok: model=${route.model} origin=${route.origin}`);
		return;
	}

	const corpus = (JSON.parse(readFileSync(corpusPath, "utf8")).chunks ?? []) as { path: string; category?: string }[];
	if (corpus.length === 0) throw new Error(`corpus is empty: ${corpusPath}`);

	const writer = rawWriter({
		origin: route.origin,
		apiKey: route.apiKey,
		model: route.model,
		maxTokens: 8000,
		chatTemplateKwargs: { reasoning_effort: "no_think" },
		timeoutMs: 600_000,
	});

	mkdirSync(join(outDir, "raw"), { recursive: true });
	const ledgerPath = join(outDir, "ledger.jsonl");
	const metricsPath = join(outDir, "metrics.json");

	// Rebuild state from whatever this run already persisted.
	const ledger: LedgerRecord[] = existsSync(ledgerPath)
		? readFileSync(ledgerPath, "utf8")
				.split("\n")
				.filter((l) => l.trim())
				.map((l) => JSON.parse(l) as LedgerRecord)
		: [];
	const bank: BankEntry[] = foldLedger(ledger);
	const extractOf = new Map<string, Extract<LedgerRecord, { type: "hy.extract" }>>();
	const doneChunk = new Set<string>();
	for (const r of ledger) {
		if (r.type === "hy.extract") extractOf.set(r.chunkId, r);
		if (r.type === "hy.ops") doneChunk.add(r.chunkId);
	}
	const metrics: {
		runId: string;
		model: string;
		pool: number;
		renderMode: string;
		candidateLimit: number;
		chunks: Row[];
	} = {
		runId,
		model: route.model,
		pool,
		renderMode,
		candidateLimit,
		chunks: [],
	};
	// Chunks finished in an earlier attempt keep their full metrics rows when
	// this attempt already wrote them; only rows predating the metrics file
	// are reconstructed (ledger-only) from the fold.
	const priorByChunk = new Map<string, Row>(
		existsSync(metricsPath)
			? ((JSON.parse(readFileSync(metricsPath, "utf8")).chunks ?? []) as Row[]).map((r) => [r.chunkId, r])
			: [],
	);
	const capturesById = new Map<string, Row>();
	for (const item of corpus) {
		const c = JSON.parse(readFileSync(join(capturesDir, item.path), "utf8")) as Row;
		capturesById.set(String(c.chunkId), { ...c, category: item.category ?? null });
	}
	const prefix: LedgerRecord[] = [];
	for (const r of ledger) {
		if (r.type === "hy.ops" && extractOf.has(r.chunkId)) {
			metrics.chunks.push(
				priorByChunk.get(r.chunkId) ??
					summarize(
						extractOf.get(r.chunkId)!,
						r,
						foldLedger(prefix),
						foldLedger([...prefix, r]),
						capturesById.get(r.chunkId),
						renderMode,
						candidateLimitFromDisk(metricsPath),
					),
			);
		}
		prefix.push(r);
	}
	console.log(
		`run=${runId} model=${route.model} origin=${route.origin} temp=0 kwargs=no_think timeout=600s candidates=${renderMode} limit=${candidateLimit}`,
	);
	console.log(
		`corpus=${corpus.length} chunks, ledger has ${doneChunk.size} complete, ${extractOf.size - doneChunk.size} resumable`,
	);

	for (const item of corpus) {
		const capture = JSON.parse(readFileSync(join(capturesDir, item.path), "utf8")) as Row;
		const chunkId: string = capture.chunkId;
		if (doneChunk.has(chunkId)) {
			console.log(`skip ${chunkId} (already in ledger)`);
			continue;
		}
		const chunk: SerializedChunk = { text: capture.text, refs: capture.refs, entryCount: capture.entryCount };
		const resumeRecord = extractOf.get(chunkId);
		const before = bankStats(bank);
		const started = Date.now();
		let coverage: { zeroCandidateDrafts: number; noCandidateDrafts: number; shownUnion: number } | undefined =
			resumeRecord
				? candidateCoverage(bank, resumeRecord.drafts as unknown as Draft[], renderMode, candidateLimit)
				: undefined;
		let extractOnDisk = false;
		let persistedExtract: (LedgerRecord & { type: "hy.extract" }) | undefined;
		let write: Awaited<ReturnType<typeof writeChunk>> | undefined;
		const attempts = 3;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			const resumeFrom = persistedExtract ?? resumeRecord;
			try {
				write = await writeChunk(writer, bank, chunkId, chunk, {
					poolMaxTokens: pool,
					rawDir: join(outDir, "raw"),
					candidateRenderMode: renderMode,
					candidateLimit,
					resume: resumeFrom
						? {
								drafts: resumeFrom.drafts as Draft[],
								rejected: [],
								usage: resumeFrom.usage,
								refs: capture.refs,
								coversUpToId: resumeFrom.coversUpToId,
							}
						: undefined,
					onExtract: (record) => {
						// Persist before reconcile can fail: a crash resumes from these drafts.
						appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`);
						extractOnDisk = true;
						persistedExtract = record;
						coverage = candidateCoverage(
							bank,
							record.drafts.map((d) => d as unknown as Draft),
							renderMode,
							candidateLimit,
						);
					},
				});
				break;
			} catch (error) {
				const cause = (error as Error)?.cause ? `: ${String((error as Error).cause)}` : "";
				const message = `${String((error as Error)?.message ?? error)}${cause}`;
				if (attempt >= attempts) {
					console.error(`${chunkId}: FAILED ${message}`);
					write = undefined;
					break;
				}
				// A completed extract makes the retry cheap; a failed one is simply
				// re-attempted, since connection-level drops often clear.
				console.error(
					`${chunkId}: attempt ${attempt} failed (${message}); retrying ${persistedExtract || resumeRecord ? "from the persisted extract" : "with a fresh extract"}`,
				);
				// llama-swap keeps processing a request the client abandoned; an
				// immediate retry collides with that zombie's concurrency slot.
				await new Promise((resolve) => setTimeout(resolve, 45_000));
			}
		}
		if (!write) continue;
		// The extract record is already on disk (persisted at onExtract, or carried
		// from the resumed attempt); appending it again would duplicate the chunk.
		const newRecords = write.records.filter((r) => !(r.type === "hy.extract" && (resumeRecord || extractOnDisk)));
		for (const r of newRecords) appendFileSync(ledgerPath, `${JSON.stringify(r)}\n`);
		ledger.push(...write.records);

		const after = bankStats(bank);
		const row: Row = {
			chunkId,
			category: item.category ?? null,
			resumed: Boolean(resumeRecord),
			entryCount: write.entryCount,
			drafts: write.drafts.length,
			rejectedDrafts: write.rejectedDrafts.map((r) => r.reason),
			candidateCoverage: coverage ?? {
				zeroCandidateDrafts: -1,
				noCandidateDrafts: -1,
				shownUnion: write.seen.length,
			},
			ops: {
				ADD: write.ops.filter((o) => o.action === "ADD").length,
				UPDATE: write.ops.filter((o) => o.action === "UPDATE").length,
				DELETE: write.ops.filter((o) => o.action === "DELETE").length,
				SKIP: write.ops.filter((o) => o.action === "SKIP").length,
			},
			rejectedOps: write.rejectedOps.map((r) => r.reason),
			downgradedOps: write.downgraded.map((r) => r.reason),
			omittedDrafts: write.report.omitted,
			skippedDrafts: write.report.skipped.length,
			budgetDropped: write.budgetDropped.length,
			bankBefore: before,
			bankAfter: after,
			bankGrowthRatio: Number(((after.tokens - before.tokens) / capture.estimateChunkTokens).toFixed(3)),
			usage: {
				extract: write.usage.extract,
				reconcile: write.usage.reconcile,
				wallTotalS: Number(((Date.now() - started) / 1000).toFixed(1)),
			},
		};
		metrics.chunks.push(row);
		writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
		console.log(
			`${chunkId}: drafts ${row.drafts} (rejected ${row.rejectedDrafts.length}) | ADD ${row.ops.ADD} UPDATE ${row.ops.UPDATE} DELETE ${row.ops.DELETE} SKIP ${row.ops.SKIP ?? 0} | starved ${row.candidateCoverage.zeroCandidateDrafts}/no-cand ${row.candidateCoverage.noCandidateDrafts} | bank ${before.active}->${after.active} (${after.tokens} tok, growth ${row.bankGrowthRatio}) | wall ${row.usage.wallTotalS}s${resumeRecord ? " [resumed]" : ""}`,
		);
	}

	writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
	writeFileSync(join(outDir, "bank.json"), `${JSON.stringify(bank, null, 1)}\n`);
	writeFileSync(join(outDir, "summary.md"), `${renderMemory(bank, pool)}\n`);
	const totals = bankStats(bank);
	console.log(
		`\nrun ${runId} done: bank ${totals.active} active / ${totals.tokens} tokens; metrics -> ${metricsPath}`,
	);
}

/** Fully rebuild a finished chunk's metrics row from the ledger: the records
 * carry drafts, usage and op lists, and folding the ledger prefix replays the
 * exact bank the chunk saw. Only per-attempt wall-clock stays unrecoverable. */
function summarize(
	extract: Extract<LedgerRecord, { type: "hy.extract" }>,
	ops: LedgerRecord,
	bankBefore: BankEntry[],
	bankAfter: BankEntry[],
	capture: Row | undefined,
	renderMode: "union" | "perDraft",
	candidateLimit: number,
): Row {
	const o = ops as Extract<LedgerRecord, { type: "hy.ops" }>;
	const drafts = extract.drafts;
	const referenced = new Set(o.ops.map((op) => (op as { draft?: number }).draft).filter((d) => d !== undefined));
	const before = bankStats(bankBefore);
	const after = bankStats(bankAfter);
	const chunkTokens = capture?.estimateChunkTokens ?? capture?.auditChunkTokens ?? 0;
	return {
		chunkId: o.chunkId,
		category: capture?.category ?? null,
		resumed: false,
		reconstructedFromLedger: true,
		entryCount: capture?.entryCount ?? null,
		drafts: drafts.length,
		rejectedDrafts: [],
		rejectedDraftCount: extract.rejectedCount ?? 0,
		candidateCoverage: candidateCoverage(bankBefore, drafts as unknown as Draft[], renderMode, candidateLimit),
		ops: {
			ADD: o.ops.filter((x: { action: string }) => x.action === "ADD").length,
			UPDATE: o.ops.filter((x: { action: string }) => x.action === "UPDATE").length,
			DELETE: o.ops.filter((x: { action: string }) => x.action === "DELETE").length,
			SKIP: o.ops.filter((x: { action: string }) => x.action === "SKIP").length,
		},
		rejectedOps: o.rejectedOps?.map((x: { reason: string }) => x.reason) ?? [],
		downgradedOps: o.downgradedOps?.map((x: { reason: string }) => x.reason) ?? [],
		omittedDrafts: drafts.length - referenced.size,
		bankBefore: before,
		bankAfter: after,
		bankGrowthRatio: chunkTokens ? Number(((after.tokens - before.tokens) / chunkTokens).toFixed(3)) : null,
		usage: {
			extract: extract.usage,
			reconcile: o.usage,
			wallTotalS: Number(((extract.usage?.wallS ?? 0) + (o.usage?.wallS ?? 0)).toFixed(1)),
		},
	};
}

// Importable by dev/judge.ts: only run when executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(String((error as Error)?.message ?? error));
		process.exitCode = 1;
	});
}
