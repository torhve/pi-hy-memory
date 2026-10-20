/**
 * The write path for one chunk: two single-shot calls, nothing else.
 *
 *   1. extract  chunk -> drafts            (the model's native JSON memory object)
 *   2. reconcile drafts + retrieved bank -> ADD/UPDATE/DELETE ops
 *
 * No tool loop, no completion handshake, no turn budget, no third agent call.
 */

import { writeFileSync } from "node:fs";
import { type ApplyReport, applyOps, enforceBudget } from "./bank.js";
import { completeWithFallback, type Writer } from "./llm.js";
import { EXTRACT_SYSTEM, reconcileSystem } from "./prompts.js";
import {
	candidatesPerDraft,
	parseDrafts,
	parseOps,
	renderBankForReconcile,
	renderDraftsForReconcile,
	sameSubject,
	selectShownPerDraft,
} from "./protocol.js";
import { type SerializedChunk, serializeChunk } from "./serialize.js";
import type { BankEntry, CallUsage, Draft, LedgerRecord, ReconcileOp } from "./types.js";

export type ChunkWrite = {
	chunkId: string;
	entryCount: number;
	drafts: Draft[];
	rejectedDrafts: { reason: string; draft: unknown }[];
	seen: BankEntry[];
	ops: ReconcileOp[];
	rejectedOps: { reason: string; op: unknown }[];
	downgraded: { reason: string; op: unknown }[];
	report: ApplyReport;
	usage: { extract: CallUsage; reconcile: CallUsage };
	endpoints: { extract: "primary" | "fallback"; reconcile: "primary" | "fallback" };
	/** `provider/modelId` that actually answered each call ("resumed" for a reused extract). */
	models: { extract: string; reconcile: string };
	failover?: string;
	/** Facts evicted because the bank exceeded poolMaxTokens. */
	budgetDropped: { id: string; statement: string }[];
	records: LedgerRecord[];
};

/**
 * A malformed completion used to surface as a bare JSON.parse message
 * ("Expected ',' or ']' after array element"), which says nothing about which
 * of the two calls failed. The watermark does not advance on failure, so the
 * next turn re-chunks the same entries and the write is retried for free — but
 * only if the audit line identifies the stage.
 */
function stage<T>(name: "extract" | "reconcile", chunkId: string, fn: () => T): T {
	try {
		return fn();
	} catch (error) {
		throw new Error(`${name} ${chunkId}: ${String((error as Error)?.message ?? error)}`);
	}
}

export async function writeChunk(
	primary: Writer,
	bank: BankEntry[],
	chunkId: string,
	userContent: string | SerializedChunk,
	options: {
		poolMaxTokens?: number;
		candidateLimit?: number;
		/**
		 * "union" (current production default): show the score-sorted union, capped
		 * — drafts whose candidates fall outside the cap see nothing.
		 * "perDraft": guarantee every draft with candidates sees its own best match
		 * before the cap fills.
		 */
		candidateRenderMode?: "union" | "perDraft";
		rawDir?: string;
		/**
		 * Drafts from an extract call that already succeeded on this same window
		 * but whose reconcile failed. Reusing them is the difference between
		 * retrying one small reconcile and re-paying a 20 k-token extraction.
		 */
		resume?: {
			drafts: Draft[];
			rejected: { reason: string; draft: unknown }[];
			usage: CallUsage;
			refs: string[];
			coversUpToId: string;
		};
		/** Called as soon as the extract record exists, before reconcile runs. */
		onExtract?: (record: LedgerRecord & { type: "hy.extract" }) => void;
		/** Second model, tried when the primary is unavailable. */
		fallback?: Writer | null;
		/** Skip a primary already known to be down. */
		preferFallback?: boolean;
		/** 429 handling: how many times to wait for a single-slot endpoint. */
		busyRetries?: number;
		busyBackoffMs?: number;
		busyBudgetMs?: number;
		busyMaxWaitMs?: number;
		/** Footer progress: which call is running right now. */
		onStage?: (stage: "extract" | "reconcile" | "waiting", detail?: string) => void;
	} = {},
): Promise<ChunkWrite> {
	const chunk: SerializedChunk = typeof userContent === "string" ? serializeChunk(userContent) : userContent;
	const createdAt = new Date().toISOString();

	let extractEndpoint: "primary" | "fallback" = "primary";
	let reconcileEndpoint: "primary" | "fallback" = "primary";
	let extractModel = "";
	let reconcileModel = "";
	let failover: string | undefined;
	let drafts: Draft[];
	let rejected: { reason: string; draft: unknown }[];
	let extractUsage: CallUsage;
	if (options.resume) {
		// The extract ran in an earlier attempt; its model was recorded then.
		extractModel = "resumed";
		drafts = options.resume.drafts;
		rejected = options.resume.rejected;
		extractUsage = options.resume.usage;
	} else {
		options.onStage?.("extract", chunk.entryCount ? `${chunk.entryCount} entries` : undefined);
		const extract = await completeWithFallback(
			primary,
			options.fallback ?? null,
			EXTRACT_SYSTEM,
			chunk.text,
			`extract ${chunkId}`,
			{
				preferFallback: options.preferFallback,
				busyRetries: options.busyRetries,
				busyBackoffMs: options.busyBackoffMs,
				busyBudgetMs: options.busyBudgetMs,
				busyMaxWaitMs: options.busyMaxWaitMs,
				onNotice: (message) => options.onStage?.("waiting", message),
			},
		);
		extractEndpoint = extract.endpoint;
		extractModel = `${extract.model.provider}/${extract.model.id}`;
		failover = extract.failed;
		if (options.rawDir) writeFileSync(`${options.rawDir}/${chunkId}.extract.txt`, extract.content);
		({ drafts, rejected } = stage("extract", chunkId, () => parseDrafts(extract.content, chunk.refs)));
		extractUsage = extract.usage;
	}

	// Persist the extract before the reconcile call can fail, so a retry resumes
	// from these drafts instead of re-extracting a larger chunk.
	const extractRecord: LedgerRecord & { type: "hy.extract" } = {
		type: "hy.extract",
		chunkId,
		coversUpToId: options.resume?.coversUpToId ?? chunk.refs[chunk.refs.length - 1] ?? chunkId,
		createdAt,
		drafts: drafts.map((d) => ({ ...d, sourceEntryIds: d.refs.map((r) => chunk.refs[r]).filter(Boolean) })),
		rejectedCount: rejected.length,
		usage: extractUsage,
	};
	// On a resume the caller already persisted this record; only a fresh extract
	// needs to be handed over before the reconcile call can fail.
	if (!options.resume) options.onExtract?.(extractRecord);

	const perDraft = candidatesPerDraft(bank, drafts, options.candidateLimit ?? 8);
	const allowedTargets = new Map<number, Set<string>>();
	const union = new Map<string, BankEntry>();
	for (const [index, list] of perDraft) {
		allowedTargets.set(index, new Set(list.map((e) => e.id)));
		for (const entry of list) if (!union.has(entry.id)) union.set(entry.id, entry);
	}
	const candidateCap = options.candidateLimit ?? 12;
	const seen =
		options.candidateRenderMode === "perDraft"
			? selectShownPerDraft(perDraft, candidateCap)
			: [...union.values()].slice(0, candidateCap);
	let ops: ReconcileOp[] = [];
	let rejectedOps: { reason: string; op: unknown }[] = [];
	let downgradedOps: { reason: string; op: unknown }[] = [];
	let reconcileUsage: CallUsage = { inTokens: 0, outTokens: 0, wallS: 0 };

	if (drafts.length > 0) {
		const zeroCandidate =
			options.candidateRenderMode === "perDraft"
				? new Set([...perDraft.entries()].filter(([, list]) => list.length === 0).map(([i]) => i))
				: undefined;
		const user = `${renderBankForReconcile(seen)}\n\n${renderDraftsForReconcile(drafts, zeroCandidate)}`;
		options.onStage?.("reconcile", `${drafts.length} drafts`);
		const raw = await completeWithFallback(
			primary,
			options.fallback ?? null,
			reconcileSystem(seen.length),
			user,
			`reconcile ${chunkId}`,
			{
				preferFallback: extractEndpoint === "fallback",
				busyRetries: options.busyRetries,
				busyBackoffMs: options.busyBackoffMs,
				busyBudgetMs: options.busyBudgetMs,
				busyMaxWaitMs: options.busyMaxWaitMs,
				onNotice: (message) => options.onStage?.("waiting", message),
			},
		);
		reconcileEndpoint = raw.endpoint;
		reconcileModel = `${raw.model.provider}/${raw.model.id}`;
		failover = failover ?? raw.failed;
		if (options.rawDir) writeFileSync(`${options.rawDir}/${chunkId}.reconcile.txt`, raw.content);
		const parsed = stage("reconcile", chunkId, () =>
			parseOps(raw.content, drafts.length, new Set(seen.map((e) => e.id)), allowedTargets),
		);
		ops = parsed.ops;
		rejectedOps = parsed.rejected;
		downgradedOps = parsed.downgraded;
		reconcileUsage = raw.usage;

		// An UPDATE must restate its target. The per-draft retrieval guard only
		// proves the entry was on screen for this draft; it cannot tell that the
		// subject changed. Measured: "node-b offline / container 121 start failure"
		// was applied over "LXC containers on nodes", erasing the inventory.
		const byId = new Map(bank.map((entry) => [entry.id, entry]));
		ops = ops.map((op) => {
			if (op.action !== "UPDATE") return op;
			const target = byId.get(op.target);
			const draft = drafts[op.draft];
			if (!target || !draft) return op;
			const verdict = sameSubject(draft, target);
			if (verdict.ok) return op;
			downgradedOps.push({
				reason: `target does not restate its subject (${verdict.shared}/${verdict.targetSize} shared); recorded as ADD`,
				op: { action: op.action, draft: op.draft, target: op.target },
			});
			return { action: "ADD" as const, draft: op.draft };
		});
	}

	const report = applyOps(bank, drafts, ops, chunkId, chunk.refs, createdAt);
	const budget = enforceBudget(bank, options.poolMaxTokens ?? 6000);

	const records: LedgerRecord[] = [
		extractRecord,
		{
			type: "hy.ops",
			chunkId,
			coversUpToId: chunk.refs[chunk.refs.length - 1] ?? chunkId,
			createdAt,
			ops,
			rejectedCount: rejectedOps.length,
			rejectedOps: rejectedOps.slice(0, 6).map((r) => ({
				reason: String(r.reason).slice(0, 160),
				draft:
					typeof (r.op as { draft?: unknown })?.draft === "number"
						? (r.op as { draft: number }).draft
						: undefined,
				target:
					typeof (r.op as { target?: unknown })?.target === "string"
						? (r.op as { target: string }).target
						: undefined,
			})),
			downgradedOps: downgradedOps.slice(0, 6).map((r) => ({
				reason: String(r.reason).slice(0, 160),
				draft:
					typeof (r.op as { draft?: unknown })?.draft === "number"
						? (r.op as { draft: number }).draft
						: undefined,
				target:
					typeof (r.op as { target?: unknown })?.target === "string"
						? (r.op as { target: string }).target
						: undefined,
			})),
			usage: reconcileUsage,
		},
	];

	return {
		chunkId,
		entryCount: chunk.entryCount,
		drafts,
		rejectedDrafts: rejected,
		seen,
		ops,
		rejectedOps,
		downgraded: downgradedOps,
		report,
		usage: { extract: extractUsage, reconcile: reconcileUsage },
		endpoints: { extract: extractEndpoint, reconcile: reconcileEndpoint },
		models: { extract: extractModel, reconcile: reconcileModel },
		failover,
		budgetDropped: budget.dropped.map((e) => ({ id: e.id, statement: e.statement.slice(0, 160) })),
		records,
	};
}
