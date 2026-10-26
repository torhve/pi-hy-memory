/**
 * Whether a compaction should wait for the memory writer, and for how long.
 *
 * `session_before_compact` defers to pi when honouring the bank summary would drop entries the
 * writer has not read (`compactionBoundary().wouldDrop` with more unread than `maxChunkTokens`).
 * pi runs `_checkCompaction` **before** `agent_before_settle` in `_handlePostAgentRun`, so a
 * threshold compaction sees the write started at `turn_end` still in flight, with the cursor on the
 * previous write — the whole in-flight chunk counts as unread. Much of that deferral is therefore
 * about a write that is seconds from landing.
 *
 * Measured on session `01a17818` (`~/.pi/agent/pi-hy-memory/state/audit.ndjson`): `write_start` of
 * chunk 005 at 12:33:02, `compact_deferred` at 12:36:01 (95 entries / 23 061 tokens unread), the
 * extract persisted at 12:37:01, a second deferral at 12:37:38, `write_end` at 12:37:40 — two
 * minutes of waiting and two deferrals for a write that finished 39 s after the first one. The
 * manual `/compact` at 12:37:43 produced the extension summary with `boundary: cursor`.
 *
 * Across 760 live writes: extract p50 158 s, reconcile p50 30 s (recent route 199 s / 42 s), total
 * p50 199 s. So the reconcile stage is reliably short while an extract-stage wait is often long,
 * which is why the ETA is stage-aware and the budget small: waiting is only worth it when what is
 * left is short.
 *
 * Everything here is pure — `now` is passed in — so the policy is a unit test (`tools/lag-check.ts`)
 * and the hook stays wiring (`tools/compaction-wait-check.ts`).
 */

/** The stages a write can be in, as `pipeline.writeChunk` reports them. */
export type WriteStage = "extract" | "reconcile" | "waiting";

/** One completed write, split by stage. Milliseconds. */
export type WriteTiming = {
	chunkId: string;
	extractMs: number;
	reconcileMs: number;
};

/** The write that is running right now, as the session state recorded it. */
export type InFlightWrite = {
	chunkId: string;
	/** Estimated tokens in the chunk being written, from `serializeEntries` at start. */
	chunkTokens: number;
	startedAt: number;
	/** Last stage reported by the writer. */
	stage: WriteStage;
	/** When that stage began. */
	stageAt: number;
	/** When the reconcile stage began, if it has. */
	reconcileAt?: number;
};

/** How many completed writes the medians are taken over. */
export const TIMING_WINDOW = 8;

function median(values: number[]): number | undefined {
	const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
	if (sorted.length === 0) return undefined;
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The most recent `TIMING_WINDOW` writes, oldest first. */
export function recentTimings(timings: WriteTiming[]): WriteTiming[] {
	return timings.slice(-TIMING_WINDOW);
}

export type LagEstimate = {
	/** The stage the ETA was computed from; `"waiting"` means there is no ETA. */
	stage: WriteStage;
	elapsedS: number;
	/** Seconds until this write lands, floored at 0. `null` when nothing supports an estimate. */
	etaS: number | null;
	/** Which median answered, so an audit line can be read back later. */
	basis: "reconcile" | "total" | "total then reconcile" | "none";
	medianReconcileMs?: number;
	medianTotalMs?: number;
};

/**
 * How long the running write still needs.
 *
 * Conservative on purpose: the writer is a single-slot endpoint, so another session's write can
 * queue ours behind it and the real wait is longer than this says. The user-facing wording is
 * "~Ys left" for that reason, and the `waiting` stage — the 429 backoff — is a hard no-ETA.
 *
 * - `reconcile`: its own median minus the time reconcile has already run. p50 ~30 s, so this is
 *   the case a 60 s budget is built for.
 * - `extract` (or not yet reported): the total median minus elapsed. When that is already 0 the
 *   write is past a typical total and about to switch stage, so the reconcile median is what is
 *   left — an upper bound, since we cannot see the stage change yet.
 * - `waiting`: no estimate. Something else is holding the endpoint.
 * - No completed write in this process: no estimate. A fresh session must not gamble on a wait.
 */
export function estimateLag(input: {
	inFlight: InFlightWrite | null;
	timings: WriteTiming[];
	now: number;
}): LagEstimate {
	const inFlight = input.inFlight;
	if (!inFlight) return { stage: "extract", elapsedS: 0, etaS: null, basis: "none" };
	const elapsedS = Math.max(0, (input.now - inFlight.startedAt) / 1000);
	if (inFlight.stage === "waiting") {
		return { stage: "waiting", elapsedS, etaS: null, basis: "none" };
	}

	const window = recentTimings(input.timings);
	const medianReconcileMs = median(window.map((t) => t.reconcileMs));
	const medianExtractMs = median(window.map((t) => t.extractMs));
	// A resumed extract records 0 for its extract stage (the call was paid for earlier), so that
	// half falls back to the median rather than making the total look short.
	const medianTotalMs = median(window.map((t) => (t.extractMs || medianExtractMs || 0) + t.reconcileMs));
	const seconds = (ms: number) => Math.round(ms / 1000);

	if (inFlight.stage === "reconcile") {
		if (medianReconcileMs === undefined) {
			return { stage: "reconcile", elapsedS, etaS: null, basis: "none" };
		}
		const spent = (input.now - (inFlight.reconcileAt ?? inFlight.stageAt)) / 1000;
		return {
			stage: "reconcile",
			elapsedS,
			etaS: Math.max(0, seconds(medianReconcileMs - spent * 1000)),
			basis: "reconcile",
			medianReconcileMs,
			medianTotalMs,
		};
	}

	if (medianTotalMs === undefined) {
		return { stage: inFlight.stage, elapsedS, etaS: null, basis: "none", medianReconcileMs };
	}
	const remaining = medianTotalMs - elapsedS * 1000;
	if (remaining > 0) {
		return {
			stage: inFlight.stage,
			elapsedS,
			etaS: Math.max(0, seconds(remaining)),
			basis: "total",
			medianReconcileMs,
			medianTotalMs,
		};
	}
	// Past a typical total: the write is about to switch stage, so what is left is the reconcile
	// half. A write that has no reconcile median either has nothing left to wait for (the total is
	// already spent) or nothing to estimate with, and both answer 0.
	return {
		stage: inFlight.stage,
		elapsedS,
		etaS: medianReconcileMs === undefined ? 0 : seconds(medianReconcileMs),
		basis: "total then reconcile",
		medianReconcileMs,
		medianTotalMs,
	};
}

/** How many chunk-sized writes the unread backlog still needs. Reported, never a gate. */
export function chunksBehind(unreadTokens: number, maxChunkTokens: number): number {
	if (unreadTokens <= 0) return 0;
	if (!(maxChunkTokens > 0)) return 1;
	return Math.ceil(unreadTokens / maxChunkTokens);
}

/** Why a compaction did not wait. Each value is an audit line, so they must stay distinguishable. */
export type WaitSkipReason =
	| "disabled"
	| "dry run"
	| "session off"
	| "overflow"
	| "already safe"
	| "no write in flight"
	| "writer unhealthy"
	| "busy endpoint"
	| "no timing history"
	| "eta over budget";

export type WaitDecision = {
	wait: boolean;
	reason: WaitSkipReason | "wait";
	/** The in-flight stage, or null when there is no write to wait for. */
	stage: WriteStage | null;
	entries: number;
	tokens: number;
	etaS: number | null;
	elapsedS: number;
	chunksBehind: number;
	medianReconcileMs?: number;
	medianTotalMs?: number;
};

export type WaitInput = {
	/** `waitForWriterBeforeCompact`. The rollback switch. */
	enabled: boolean;
	dryRun: boolean;
	/** `config.enabled` and the per-session `/hy` switch together. */
	sessionActive: boolean;
	/** Why pi is compacting. `overflow` never waits. */
	reason: string;
	/** Honouring the bank summary would drop entries the writer never read. */
	wouldDrop: boolean;
	/** The in-flight write, or null when none is running. */
	inFlight: InFlightWrite | null;
	timings: WriteTiming[];
	/** No failures, no cooldown, the primary is not held down. */
	healthy: boolean;
	entries: number;
	tokens: number;
	maxChunkTokens: number;
	/** Shared budget for the current write plus its chained follow-ups. */
	budgetMs: number;
	now: number;
};

/**
 * The gate, in one place: a bounded wait only for a write that is already running and looks close.
 *
 * Order is the cost order — a config or reason check before an ETA check — and every rejection is
 * named so `compact_wait_skipped` says which rule fired rather than "it did not wait".
 */
export function decideCompactionWait(input: WaitInput): WaitDecision {
	const base = {
		stage: input.inFlight ? input.inFlight.stage : null,
		entries: input.entries,
		tokens: input.tokens,
		chunksBehind: chunksBehind(input.tokens, input.maxChunkTokens),
	};
	const skip = (reason: WaitSkipReason, etaS: number | null = null, elapsedS = 0): WaitDecision => ({
		wait: false,
		reason,
		etaS,
		elapsedS,
		...base,
	});

	if (!input.enabled) return skip("disabled");
	if (input.dryRun) return skip("dry run");
	if (!input.sessionActive) return skip("session off");
	// Overflow recovery produces its own summary and digest, and pi's summariser needs the whole
	// conversation to run — precisely the request an oversized session cannot make. A writer that is
	// 200 s away must not delay the only recovery available.
	if (input.reason === "overflow") return skip("overflow");
	if (!input.wouldDrop) return skip("already safe");
	if (!input.inFlight) return skip("no write in flight");
	if (!input.healthy) return skip("writer unhealthy");
	const estimate = estimateLag({ inFlight: input.inFlight, timings: input.timings, now: input.now });
	if (estimate.stage === "waiting") return skip("busy endpoint", null, estimate.elapsedS);
	if (estimate.etaS === null) return skip("no timing history", null, estimate.elapsedS);
	if (estimate.etaS * 1000 > input.budgetMs) return skip("eta over budget", estimate.etaS, estimate.elapsedS);
	return {
		wait: true,
		reason: "wait",
		etaS: estimate.etaS,
		elapsedS: estimate.elapsedS,
		...base,
		medianReconcileMs: estimate.medianReconcileMs,
		medianTotalMs: estimate.medianTotalMs,
	};
}
