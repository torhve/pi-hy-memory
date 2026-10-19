/**
 * pi-hy-memory — data shapes.
 *
 * The ledger is the source of truth (same principle as pi-observational-memory V3):
 * memory state is reconstructed by folding append-only ledger entries, never by
 * mutating a live object. The model never sees ids that only exist in the ledger.
 */

export type Relevance = "high" | "medium" | "low";

export const ID_PATTERN = /^[a-f0-9]{12}$/;

/** One durable statement in the bank. */
export type BankEntry = {
	id: string;
	/** Short subject the statement is about. Used for retrieval grouping. */
	task: string;
	statement: string;
	keys: string[];
	confidence: number;
	relevance: Relevance;
	/** Session entry ids this statement is grounded in. Provenance, not progress. */
	sourceEntryIds: string[];
	/** Capture/chunk this entry was written from. */
	chunkId: string;
	createdAt: string;
	status: "active" | "superseded";
	/** Set when this entry replaced an older one. */
	supersedes?: string;
	/** Set on the older entry when something replaced or invalidated it. */
	supersededBy?: string;
	supersedeReason?: string;
	tokenCount: number;
};

/** A draft is what the extractor returns for one chunk, before reconciliation. */
export type Draft = {
	task: string;
	statement: string;
	keys: string[];
	confidence: number;
	/** Numeric refs as they appear in the serialized chunk, e.g. 7 -> [7]. */
	refs: number[];
};

export type ReconcileOp =
	| { action: "ADD"; draft: number }
	| { action: "UPDATE"; draft: number; target: string; reason?: string }
	| { action: "DELETE"; target: string; reason?: string };

export type ExtractResult = {
	drafts: Draft[];
	rejected: { reason: string; draft: unknown }[];
};

export type ReconcileResult = {
	ops: ReconcileOp[];
	rejected: { reason: string; op: unknown }[];
	downgraded: { reason: string; op: unknown }[];
};

export type LedgerRecord =
	| {
			type: "hy.extract";
			chunkId: string;
			coversUpToId: string;
			createdAt: string;
			drafts: (Draft & { sourceEntryIds: string[] })[];
			rejectedCount: number;
			usage: CallUsage;
	  }
	| {
			type: "hy.ops";
			chunkId: string;
			coversUpToId: string;
			createdAt: string;
			ops: (ReconcileOp & { draftStatement?: string })[];
			rejectedCount: number;
			/** Bounded, so a later reader can see why the model's proposals were refused. */
			rejectedOps?: { reason: string; draft?: number; target?: string }[];
			downgradedOps?: { reason: string; draft?: number; target?: string }[];
			usage: CallUsage;
	  }
	| {
			type: "hy.gap";
			/** Coverage as it stood: the watermark that was in play when the cut happened. */
			coversUpToId: string;
			/** First entry still in the branch after the cut; coverage resumes here. */
			fromId: string;
			/** How many entries fell between the two, and their estimated size. */
			entries: number;
			tokens: number;
			/** "compaction": pi cut past the watermark. "disabled": this session was off. */
			reason: "compaction" | "disabled";
			createdAt: string;
	  };

export type CallUsage = {
	inTokens: number;
	outTokens: number;
	wallS: number;
};

export function isId(value: unknown): value is string {
	return typeof value === "string" && ID_PATTERN.test(value);
}

export function estimateTokens(text: string): number {
	return Math.max(1, Math.round(text.length / 4));
}
