#!/usr/bin/env npx tsx
/**
 * dev/judge.ts - blind quality judge for a run's bank writes.
 *
 * For each chunk in the run, the judge model sees ONLY the serialized chunk
 * (the writer's exact input) and the write ops that chunk produced (ADD/UPDATE
 * statements, DELETE reasons, with old statements resolved from the bank state
 * the ledger fold held before the chunk). It never sees writer prompts,
 * confidences, keys or endpoints, and the writer model is rejected as judge.
 *
 * Judge model: temperature 0; the rubric (dev/rubric.md) travels with every
 * call, so each chunk verdict is self-contained and reproducible.
 *
 *   npx tsx dev/judge.ts --run <runId> [--model <judgeModel>] [--corpus dev/corpus.json]
 *
 * Writes out/<runId>/judge.json and prints per-chunk aggregates.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { foldLedger } from "../src/bank.js";
import type { BankEntry, LedgerRecord } from "../src/types.js";
import { rawWriter } from "./raw-writer.js";
import { resolveRoute } from "./run.js";

type ChunkFile = {
	chunkId: string;
	sessionId: string;
	entryCount: number;
	estimateChunkTokens: number;
	auditChunkTokens: number;
	draftCount: number;
	text: string;
	refs: string[];
};

type JudgedOp = {
	chunkId: string;
	op: "ADD" | "UPDATE" | "DELETE";
	text: string;
	oldText?: string;
	reason?: string;
};

type OpVerdict = {
	opIndex: number;
	supported: "full" | "partial" | "none";
	durability: "durable" | "marginal" | "noise";
	specificity: number; // 0-3: does it carry the anchors a future agent needs?
	transitionCaptured: boolean; // settled state + what was dropped, when relevant
	shouldNotStore: boolean;
	fidelityIssue: string | null; // e.g. "claims verified", "number invented"
	note: string;
};

type MissedFact = { statement: string; why: string };

type ChunkVerdict = {
	chunkId: string;
	seed: number;
	ops: OpVerdict[];
	missed: MissedFact[];
};

/** Deterministic shuffle so judging order carries no positional bias. */
function shuffled<T>(items: T[], seed: number): { order: T[]; perm: number[] } {
	let s = seed >>> 0;
	const rand = (): number => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const order = [...items];
	const perm = items.map((_, i) => i);
	for (let i = order.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[order[i], order[j]] = [order[j], order[i]];
		[perm[i], perm[j]] = [perm[j], perm[i]];
	}
	return { order, perm };
}

const JUDGE_SYSTEM = [
	"You are a memory-quality auditor. You judge proposed long-term memories against the conversation transcript they were extracted from.",
	"You are shown: (1) the transcript chunk, with source-entry markers [n]; (2) numbered write operations the memory system produced for it.",
	"Judge each operation strictly by the rubric. Judge the transcript for important durable facts no operation captured (max 5).",
	"Be harsh on: claims not present in the transcript, generic assistant-behavior lessons, chatter, bookkeeping lines, confident statements resting on partial evidence.",
	'Reply with JSON only: {"verdicts":[{"opIndex":0,"supported":"full|partial|none","durability":"durable|marginal|noise","specificity":0,"transitionCaptured":true,"shouldNotStore":false,"fidelityIssue":null,"note":"..."}],"missed":[{"statement":"...","why":"..."}]}',
].join("\n");

function rubric(): string {
	return readFileSync(join(import.meta.dirname, "rubric.md"), "utf8");
}

/** Replay the ledger up to (not including) this chunk's ops to resolve old statements. */
function bankBefore(records: LedgerRecord[], chunkId: string): Map<string, BankEntry> {
	const prefix: LedgerRecord[] = [];
	for (const r of records) {
		if (r.type === "hy.ops" && r.chunkId === chunkId) break;
		prefix.push(r);
	}
	return new Map(foldLedger(prefix).map((e) => [e.id, e]));
}

function judgeOps(
	records: LedgerRecord[],
	chunkId: string,
	draftsByChunk: Map<string, { statement: string }[]>,
): JudgedOp[] {
	const extract = records.find((r) => r.type === "hy.extract" && r.chunkId === chunkId);
	const opsRec = records.find((r) => r.type === "hy.ops" && r.chunkId === chunkId);
	if (!opsRec || opsRec.type !== "hy.ops") return [];
	const drafts = draftsByChunk.get(chunkId) ?? (extract?.type === "hy.extract" ? extract.drafts : []);
	const before = bankBefore(records, chunkId);
	const out: JudgedOp[] = [];
	for (const op of opsRec.ops) {
		if (op.action === "DELETE") {
			const old = before.get(op.target);
			out.push({
				chunkId,
				op: "DELETE",
				text: old?.statement ?? op.target,
				oldText: old?.statement,
				reason: op.reason,
			});
		} else {
			const draft = drafts[op.draft] ?? (op.draftStatement ? { statement: op.draftStatement } : undefined);
			if (!draft) continue;
			const old = op.action === "UPDATE" ? before.get(op.target) : undefined;
			out.push({
				chunkId,
				op: op.action,
				text: draft.statement,
				oldText: old?.statement,
				reason: op.action === "UPDATE" ? op.reason : undefined,
			});
		}
	}
	return out;
}

function parseVerdicts(raw: string, opCount: number): ChunkVerdict | null {
	let data: { verdicts?: OpVerdict[]; missed?: MissedFact[] };
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!Array.isArray(data.verdicts)) return null;
	const verdicts = data.verdicts.filter((v) => Number.isInteger(v.opIndex) && v.opIndex >= 0 && v.opIndex < opCount);
	if (verdicts.length !== opCount) return null;
	return { chunkId: "", seed: 0, ops: verdicts, missed: Array.isArray(data.missed) ? data.missed.slice(0, 5) : [] };
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const flag = (name: string, fallback?: string): string => {
		const i = args.indexOf(`--${name}`);
		if (i >= 0 && args[i + 1]) return args[i + 1];
		if (fallback === undefined) throw new Error(`--${name} is required`);
		return fallback;
	};
	const runId = flag("run");
	const judgeModel = process.env.JUDGE_MODEL ?? flag("model", "remote/qwen3.6-35b-q4ks");
	if (judgeModel.includes("hy-memory")) {
		throw new Error("the writer model may never judge its own writes");
	}
	const corpusPath = flag("corpus", "dev/corpus.json");
	const seed = Number(flag("seed", "7"));
	const runDir = join("out", runId);

	const chunks = (JSON.parse(readFileSync(corpusPath, "utf8")).chunks ?? []) as { path: string }[];
	const records = readFileSync(join(runDir, "ledger.jsonl"), "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as LedgerRecord);
	const draftsByChunk = new Map<string, { statement: string }[]>();
	for (const r of records) if (r.type === "hy.extract") draftsByChunk.set(r.chunkId, r.drafts);

	const route = process.env.JUDGE_ORIGIN
		? { origin: process.env.JUDGE_ORIGIN, apiKey: process.env.JUDGE_KEY, model: judgeModel }
		: await resolveRoute(judgeModel);
	const writer = rawWriter({ ...route, temperature: 0, maxTokens: 4000 });
	const verdicts: ChunkVerdict[] = [];
	let totalOps = 0;
	let noise = 0;
	let unsupported = 0;
	let missed = 0;

	for (const item of chunks) {
		const file = JSON.parse(readFileSync(join("captures-dev", item.path), "utf8")) as ChunkFile;
		const ops = judgeOps(records, file.chunkId, draftsByChunk);
		if (ops.length === 0) {
			console.log(`${file.chunkId}: no ops (skipped)`);
			continue;
		}
		const { order: opsView, perm } = shuffled(ops, seed + verdicts.length);
		const opsBlock = opsView
			.map(
				(o, i) =>
					`[${i}] ${o.op}: ${o.text}${o.oldText ? `\n    (replacing: ${o.oldText})` : ""}${o.reason ? `\n    (stated reason: ${o.reason})` : ""}`,
			)
			.join("\n");
		const user = `<rubric>\n${rubric().trim()}\n</rubric>\n\n<transcript>\n${file.text.trim()}\n</transcript>\n\n<write-ops>\n${opsBlock}\n</write-ops>`;
		const res = await writer.complete(JUDGE_SYSTEM, user, "judge");
		const verdict = parseVerdicts(res.content, ops.length);
		if (!verdict) {
			console.error(`${file.chunkId}: judge produced no parseable verdict`);
			continue;
		}
		verdict.chunkId = file.chunkId;
		verdict.seed = seed;
		verdict.ops = verdict.ops
			.map((v) => ({ ...v, opIndex: perm[v.opIndex] }))
			.sort((a, b) => a.opIndex - b.opIndex);
		verdicts.push(verdict);
		totalOps += verdict.ops.length;
		noise += verdict.ops.filter((v) => v.shouldNotStore || v.durability === "noise").length;
		unsupported += verdict.ops.filter((v) => v.supported === "none").length;
		missed += verdict.missed.length;
		console.log(
			`${file.chunkId}: ops ${verdict.ops.length} | noise ${noise} | unsupported ${unsupported} | missed ${verdict.missed.length}`,
		);
	}

	writeFileSync(
		join(runDir, "judge.json"),
		`${JSON.stringify({ runId, judgeModel, seed, totalOps, noise, unsupported, missed, verdicts }, null, 2)}\n`,
	);
	console.log(
		`\njudge done: ops ${totalOps}, noise ${noise}, unsupported ${unsupported}, missed ${missed} -> ${runDir}/judge.json`,
	);
}

main().catch((error) => {
	console.error(String((error as Error)?.message ?? error));
	process.exitCode = 1;
});
