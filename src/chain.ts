/**
 * Whether a finished write should be followed by another one immediately.
 *
 * The trigger lives on `turn_end`, and it returns early while a write is in
 * flight. Nothing re-evaluated the window when a write *completed*, so a chunk
 * that landed mid-turn left its backlog waiting for the next `turn_end`. Measured
 * on session 01a1510e (2026-10-19): a failed write at 13:45 was followed by the
 * next one at 13:55 — ten minutes with the footer bar saturated at 29k/15k and
 * nothing scheduled.
 *
 * The policy is deliberately narrow. A chain only continues while the writer is
 * healthy (`failures === 0`), only for a bounded number of steps, and never for a
 * resumed extract — that case has its own retry path and its own chunk id.
 */

/** Consecutive follow-up writes allowed per turn before the window waits. */
export const MAX_CHAIN = 2;

export type ChainInput = {
	enabled: boolean;
	/** The session the write ran in is still the live one. */
	sessionMatches: boolean;
	/** A write is already running (a second one would overlap). */
	inFlight: boolean;
	/** An extract is persisted and waiting for its reconcile; that path retries. */
	pendingExtract: boolean;
	/** Consecutive failed writes; the writer is not healthy. */
	failures: number;
	/** Follow-ups already started since the last `turn_end`. */
	chained: number;
	pendingTokens: number;
	triggerTokens: number;
	/** Renderable entries in the remaining window. */
	entryCount: number;
};

export type ChainDecision = { chain: boolean; reason: string };

export function shouldChainWrite(input: ChainInput): ChainDecision {
	if (!input.enabled) return { chain: false, reason: "disabled" };
	if (!input.sessionMatches) return { chain: false, reason: "session changed" };
	if (input.inFlight) return { chain: false, reason: "write in flight" };
	if (input.pendingExtract) return { chain: false, reason: "extract awaiting reconcile" };
	if (input.failures > 0) return { chain: false, reason: "writer unhealthy" };
	if (input.chained >= MAX_CHAIN) return { chain: false, reason: "chain limit" };
	if (input.entryCount === 0) return { chain: false, reason: "nothing renderable" };
	if (input.pendingTokens < input.triggerTokens) return { chain: false, reason: "under trigger" };
	return { chain: true, reason: "window still over trigger" };
}
