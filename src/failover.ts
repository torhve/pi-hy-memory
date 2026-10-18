/**
 * Failover state machine for the fallback endpoint.
 *
 * The bug this exists for, measured on session 01a14dff:
 *
 * - 08:22:55 chunk 003's extract timed out on the primary → `failover`,
 *   `primaryDownUntil = now + 300 s`.
 * - 08:23:24 chunk 004 ran entirely on the fallback (correct: `preferFallback`).
 * - 08:24:00 chunk 004 finished without a `failover` reason — because the primary
 *   was never tried — and the old code read that as "the primary is back",
 *   cleared `primaryDownUntil` and logged `failover_recovered`.
 *
 * So one timeout restored a primary that was never re-tested: the next write pays
 * another timeout (up to `timeoutMs`, 300 s here) before failing over again. On
 * this endpoint that flapped every write, because the extract legitimately takes
 * ~330-360 s (8.5 tok/s decode) against a 300 s timeout.
 *
 * The rule is therefore: the cooldown is cleared only by a *primary* answer, and a
 * fallback-only success holds it instead. The inverse case is covered too — a
 * fallback that fails while the primary answers must not mark the primary down.
 */

export type FailoverEvent = "failover" | "failover_recovered" | "failover_held" | null;

export interface FailoverOutcome {
	failover?: string;
	endpoints: { extract: "primary" | "fallback"; reconcile: "primary" | "fallback" };
}

export function nextFailoverState(input: {
	primaryDownUntil: number;
	cooldownMs: number;
	now: number;
	result: FailoverOutcome;
}): { primaryDownUntil: number; event: FailoverEvent } {
	const { endpoints } = input.result;
	const primaryAnswered = endpoints.extract === "primary" || endpoints.reconcile === "primary";
	const wasDown = input.primaryDownUntil > 0;

	if (input.result.failover !== undefined && !primaryAnswered) {
		return { primaryDownUntil: input.now + Math.max(0, input.cooldownMs), event: "failover" };
	}
	if (primaryAnswered) {
		return { primaryDownUntil: 0, event: wasDown ? "failover_recovered" : null };
	}
	// Fallback only: the primary was never tested, so a cooldown in force stays in force.
	if (input.primaryDownUntil > input.now) {
		return { primaryDownUntil: input.primaryDownUntil, event: "failover_held" };
	}
	return { primaryDownUntil: 0, event: null };
}
