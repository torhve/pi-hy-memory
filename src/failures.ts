/**
 * Failures, and whether a smaller chunk could plausibly fix them.
 *
 * `failures` halves the chunk budget (20 000 → 10 000 → …), which is right when
 * the request itself is the problem and wrong otherwise. Measured on session
 * 01a1510e (2026-10-19): write 059 failed with `extract …: terminated` — the
 * connection dropped — the budget halved, and the next chunk had to leave 133
 * entries behind instead of 43. The failure said nothing about chunk size, and
 * the shrink made the backlog larger at the worst moment.
 *
 * Three classes:
 *   chunk    — the request was too heavy: timeout/abort, 413, a context-length
 *              rejection. A smaller chunk finishes inside the same budget.
 *   output   — the model answered with something unusable: unparseable JSON, an
 *              empty completion. A smaller chunk gives it less to track.
 *   endpoint — transport, 5xx, 429, auth. Nothing about the chunk caused it, and
 *              the failover path already handles it.
 */

export type FailureClass = "chunk" | "output" | "endpoint";

const CONTEXT_REJECTION = /context|too long|too large|exceed|maximum.*token|prompt.*length/i;
const OUTPUT_DEFECT = /(Expected|Unbalanced|no JSON object|Unexpected)\b|empty completion/i;

export function failureClass(error: unknown): FailureClass {
	const message = String((error as Error)?.message ?? error);
	const status = (error as { status?: unknown })?.status;

	if (OUTPUT_DEFECT.test(message)) return "output";
	if (typeof status === "number") {
		if (status === 0) return "chunk"; // our own timeout or an abort
		if (status === 413) return "chunk";
		if (status === 400 && CONTEXT_REJECTION.test(message)) return "chunk";
	}
	// No status at all means the stream never produced a usable response: a
	// dropped connection, "terminated", a socket that hung up.
	return "endpoint";
}

/** Would a smaller chunk help? Only a size or output failure changes the budget. */
export function shrinksChunk(klass: FailureClass): boolean {
	return klass !== "endpoint";
}

/**
 * How long to wait before trying the writer again after a failure.
 *
 * `lastFailed` stops a chain from following a failure, but it does not stop the
 * *trigger*: a session producing turns every few seconds still fires one attempt per
 * turn. Measured on session 01a1510e (2026-10-19), a dead proxy (502) produced
 * **508 attempts in 37 minutes** — one every few seconds — because nothing backed
 * off across turns. The first wait is short (a blip should cost one attempt), then
 * doubles, so an outage costs a handful of requests instead of hundreds.
 */
export function writeCooldownMs(consecutiveFailures: number, baseMs: number): number {
	if (baseMs <= 0) return 0;
	if (consecutiveFailures <= 0) return 0;
	return Math.min(10 * 60_000, baseMs * 2 ** Math.min(consecutiveFailures - 1, 10));
}
