/**
 * Bank state and the deterministic maintenance the model is NOT asked to do.
 *
 * pi-observational-memory spends a third model call (the dropper) deciding what
 * to prune. Hy-Memory-30B-A3B measures badly as an orchestrator (12/12 runs
 * never closed a loop) but well as a bank writer, so pruning here is code:
 * supersede chains plus a token budget. The model only ever decides
 * ADD / UPDATE / DELETE for the entries it was shown.
 */

import { createHash } from "node:crypto";
import { relevanceOf } from "./protocol.js";
import { type BankEntry, type Draft, estimateTokens, type LedgerRecord, type ReconcileOp } from "./types.js";

export function newId(seed: string): string {
	return createHash("sha256").update(seed).digest("hex").slice(0, 12);
}

export function entryFromDraft(
	draft: Draft,
	chunkId: string,
	refs: string[],
	createdAt: string,
	seed: string,
): BankEntry {
	return {
		id: newId(seed),
		task: draft.task,
		statement: draft.statement,
		keys: draft.keys,
		confidence: draft.confidence,
		relevance: relevanceOf(draft.confidence, draft.refs.length),
		sourceEntryIds: draft.refs.map((r) => refs[r]).filter(Boolean),
		chunkId,
		createdAt,
		status: "active",
		tokenCount: estimateTokens(draft.statement),
	};
}

export type ApplyReport = {
	added: BankEntry[];
	updated: { entry: BankEntry; target: string }[];
	deleted: { target: string; reason?: string }[];
	omitted: number;
};

export function applyOps(
	bank: BankEntry[],
	drafts: Draft[],
	ops: ReconcileOp[],
	chunkId: string,
	refs: string[],
	createdAt: string,
): ApplyReport {
	const byId = new Map(bank.map((e) => [e.id, e]));
	const report: ApplyReport = { added: [], updated: [], deleted: [], omitted: 0 };

	for (const op of ops) {
		if (op.action === "DELETE") {
			const target = byId.get(op.target);
			if (target?.status !== "active") continue;
			target.status = "superseded";
			target.supersedeReason = op.reason ?? "invalidated by newer chunk";
			report.deleted.push({ target: op.target, reason: target.supersedeReason });
			continue;
		}
		const draft = drafts[op.draft];
		if (!draft) continue;
		const entry = entryFromDraft(draft, chunkId, refs, createdAt, `${chunkId}:${op.draft}:${op.action}`);
		if (op.action === "UPDATE") {
			const target = byId.get(op.target);
			if (target && target.status === "active") {
				target.status = "superseded";
				target.supersededBy = entry.id;
				target.supersedeReason = op.reason ?? "replaced by newer statement";
				entry.supersedes = target.id;
				report.updated.push({ entry, target: target.id });
			}
		} else {
			report.added.push(entry);
		}
		bank.push(entry);
		byId.set(entry.id, entry);
	}

	const used = new Set(ops.filter((o) => o.action !== "DELETE").map((o) => o.draft));
	report.omitted = drafts.length - used.size;
	return report;
}

/**
 * Pool budget. Deterministic, auditable, no model call:
 * keep high relevance first, then recency; supersede the rest.
 * Superseded entries stay in the ledger and stay recallable.
 */
export function enforceBudget(bank: BankEntry[], maxTokens: number): { dropped: BankEntry[] } {
	const active = bank.filter((e) => e.status === "active");
	const total = active.reduce((sum, e) => sum + e.tokenCount, 0);
	if (total <= maxTokens) return { dropped: [] };

	// Rank, then keep what fits. The tie-break is recency, not insertion order:
	// measured on session 01a14c10 the bank filled with 69 facts that are all
	// relevance=high, confidence=1.0, so the ranking collapsed to a stable sort
	// over insertion order and the *newest* facts were the ones dropped — the
	// opposite of what a memory that tracks current state should do.
	const rank = (e: BankEntry): number => {
		const rel = e.relevance === "high" ? 3 : e.relevance === "medium" ? 2 : 1;
		return rel * 1000 + e.confidence * 100;
	};
	const ordered = [...active].sort((a, b) => {
		const byRank = rank(b) - rank(a);
		if (byRank !== 0) return byRank;
		return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
	});

	let kept = 0;
	const keepIds = new Set<string>();
	for (const entry of ordered) {
		if (kept + entry.tokenCount > maxTokens) continue;
		kept += entry.tokenCount;
		keepIds.add(entry.id);
	}

	const dropped: BankEntry[] = [];
	for (const entry of active) {
		if (!keepIds.has(entry.id)) {
			entry.status = "superseded";
			entry.supersedeReason = "pool budget";
			dropped.push(entry);
		}
	}
	return { dropped };
}

export function foldLedger(records: LedgerRecord[]): BankEntry[] {
	const bank: BankEntry[] = [];

	// Pair each ops record with the extract record that precedes it, in order.
	// A Map keyed by chunkId is wrong the moment two chunks share an id (measured:
	// session 01a14a46 reused 005 after a reload), because the later extract
	// overwrote the earlier drafts and every op past its length was skipped —
	// 3 facts silently vanished on every replay.
	let pending: { chunkId: string; drafts: (Draft & { sourceEntryIds: string[] })[] } | undefined;

	for (const record of records) {
		if (record.type === "hy.extract") {
			pending = { chunkId: record.chunkId, drafts: record.drafts };
			continue;
		}
		const drafts = pending?.chunkId === record.chunkId ? pending.drafts : [];
		for (const op of record.ops) {
			if (op.action === "DELETE") {
				const target = bank.find((e) => e.id === op.target && e.status === "active");
				if (target) {
					target.status = "superseded";
					target.supersedeReason = op.reason ?? "invalidated by newer chunk";
				}
				continue;
			}
			const draft = drafts[op.draft];
			if (!draft) continue;
			const entry: BankEntry = {
				id: newId(`${record.chunkId}:${op.draft}:${op.action}`),
				task: draft.task,
				statement: draft.statement,
				keys: draft.keys,
				confidence: draft.confidence,
				relevance: relevanceOf(draft.confidence, draft.refs.length),
				sourceEntryIds: draft.sourceEntryIds,
				chunkId: record.chunkId,
				createdAt: record.createdAt,
				status: "active",
				tokenCount: estimateTokens(draft.statement),
			};
			if (op.action === "UPDATE") {
				const target = bank.find((e) => e.id === op.target && e.status === "active");
				if (target) {
					target.status = "superseded";
					target.supersededBy = entry.id;
					target.supersedeReason = op.reason ?? "replaced by newer statement";
					entry.supersedes = target.id;
				}
			}
			bank.push(entry);
		}
	}
	return bank;
}
