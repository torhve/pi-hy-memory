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
	/**
	 * The attempt that just finished failed, whatever its class. A transport blip
	 * resets `failures` (it says nothing about chunk size), but it still means the
	 * writer is struggling right now, so the chain must not follow it: measured
	 * 2026-10-19, chunk 069 failed with an endpoint error and 070 started one second
	 * later, costing another full 20 000-token request.
	 */
	lastFailed: boolean;
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
	if (input.lastFailed) return { chain: false, reason: "last attempt failed" };
	if (input.failures > 0) return { chain: false, reason: "writer unhealthy" };
	if (input.chained >= MAX_CHAIN) return { chain: false, reason: "chain limit" };
	if (input.entryCount === 0) return { chain: false, reason: "nothing renderable" };
	if (input.pendingTokens < input.triggerTokens) return { chain: false, reason: "under trigger" };
	return { chain: true, reason: "window still over trigger" };
}

/**
 * How much larger than the write trigger a backlog has to be before an idle
 * session is worth draining on its own. Below this, the next turn would have
 * handled it anyway and a timer only spends writer time the user is not asking for.
 */
export const IDLE_DRAIN_TRIGGER_FACTOR = 4;

export type IdleDrainInput = {
	enabled: boolean;
	/** `/hy off` is remembered per session; an off session must stay silent. */
	sessionActive: boolean;
	/** Milliseconds since the last turn ended. */
	idleMs: number;
	/** How quiet the session has to be before a drain counts as idle work. */
	idleAfterMs: number;
	inFlight: boolean;
	pendingExtract: boolean;
	failures: number;
	/** The primary writer is inside its post-failover hold. */
	primaryDown: boolean;
	/** A cooldown from consecutive failures is active. */
	coolingDown: boolean;
	pendingTokens: number;
	triggerTokens: number;
	entryCount: number;
};

export type IdleDrainDecision = { drain: boolean; reason: string };

/**
 * Whether a session that is doing nothing should still pay down its backlog.
 *
 * The trigger lives on `turn_end` and nothing else starts a write, so a session
 * that is left open drains only when it is used. Measured on session 01a15860
 * (2026-10-20): reloaded at 18:40 with 352 000 tokens unread, `writes: 0` and
 * `compactions: 0` afterwards — the bar saturated and nothing was scheduled,
 * because no turn ran.
 *
 * The gate is deliberately stricter than the ordinary trigger: an idle drain is
 * for a backlog the user is not about to pay off themselves, so it needs
 * `IDLE_DRAIN_TRIGGER_FACTOR` times the trigger, a healthy writer, and no work
 * already in flight.
 */
export function shouldIdleDrain(input: IdleDrainInput): IdleDrainDecision {
	if (!input.enabled) return { drain: false, reason: "disabled" };
	if (!input.sessionActive) return { drain: false, reason: "session off" };
	if (input.idleAfterMs <= 0) return { drain: false, reason: "idle drain disabled" };
	if (input.idleMs < input.idleAfterMs) return { drain: false, reason: "session not idle" };
	if (input.inFlight) return { drain: false, reason: "write in flight" };
	if (input.pendingExtract) return { drain: false, reason: "extract awaiting reconcile" };
	if (input.failures > 0) return { drain: false, reason: "writer unhealthy" };
	if (input.primaryDown) return { drain: false, reason: "primary writer held" };
	if (input.coolingDown) return { drain: false, reason: "write cooling down" };
	if (input.entryCount === 0) return { drain: false, reason: "nothing renderable" };
	if (input.pendingTokens < input.triggerTokens * IDLE_DRAIN_TRIGGER_FACTOR)
		return { drain: false, reason: "backlog under idle threshold" };
	return { drain: true, reason: "idle with a large backlog" };
}
