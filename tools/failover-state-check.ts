/**
 * Failover cooldown check.
 *
 * Pins the defect measured on session 01a14dff: chunk 003's extract timed out on
 * the primary at 08:22:55 (cooldown set to 08:27:55), chunk 004 ran entirely on
 * the fallback at 08:23:24, and the write was logged as `failover_recovered` at
 * 08:24:00 — clearing a cooldown that had never been tested. The next write then
 * paid another full `timeoutMs` on a primary already known to be too slow.
 */

import { type FailoverOutcome, nextFailoverState } from "../src/failover.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const T0 = Date.UTC(2026, 9, 18, 8, 22, 55);
const COOLDOWN = 300_000;
const down = T0 + COOLDOWN;

const both = (which: "primary" | "fallback", failover?: string): FailoverOutcome => ({
	failover,
	endpoints: { extract: which, reconcile: which },
});

// 1. Primary times out → cooldown, exactly the 08:22:55 event.
const first = nextFailoverState({
	primaryDownUntil: 0,
	cooldownMs: COOLDOWN,
	now: T0,
	result: both("fallback", "extract hy-003: This operation was aborted"),
});
check("timeout sets the cooldown", first.event === "failover" && first.primaryDownUntil === down);

// 2. The 08:24:00 regression: a fallback-only success must NOT clear it.
const held = nextFailoverState({
	primaryDownUntil: down,
	cooldownMs: COOLDOWN,
	now: T0 + 65_000,
	result: both("fallback"),
});
check("fallback-only write holds the cooldown", held.event === "failover_held" && held.primaryDownUntil === down);
check("held cooldown is unchanged", held.primaryDownUntil === down, new Date(held.primaryDownUntil).toISOString());

// 3. Next write, still inside the cooldown, still fallback-only → still held.
const heldAgain = nextFailoverState({
	primaryDownUntil: down,
	cooldownMs: COOLDOWN,
	now: T0 + 200_000,
	result: both("fallback"),
});
check(
	"repeated fallback writes keep holding",
	heldAgain.event === "failover_held" && heldAgain.primaryDownUntil === down,
);

// 4. A real primary answer after the cooldown clears it.
const recovered = nextFailoverState({
	primaryDownUntil: down,
	cooldownMs: COOLDOWN,
	now: down + 1_000,
	result: both("primary"),
});
check(
	"primary answer clears the cooldown",
	recovered.event === "failover_recovered" && recovered.primaryDownUntil === 0,
);

// 5. Inverse case: the fallback failed but the primary answered → no cooldown.
const primarySurvived = nextFailoverState({
	primaryDownUntil: 0,
	cooldownMs: COOLDOWN,
	now: T0,
	result: { failover: "fallback: connection refused", endpoints: { extract: "primary", reconcile: "primary" } },
});
check("healthy primary is not marked down", primarySurvived.event === null && primarySurvived.primaryDownUntil === 0);

// 6. Mixed endpoints count as a primary answer if either stage hit it.
const mixed = nextFailoverState({
	primaryDownUntil: down,
	cooldownMs: COOLDOWN,
	now: down + 1,
	result: { endpoints: { extract: "fallback", reconcile: "primary" } },
});
check("one primary stage is enough to recover", mixed.event === "failover_recovered" && mixed.primaryDownUntil === 0);

// 7. No cooldown, no failure → nothing to report, nothing set.
const quiet = nextFailoverState({ primaryDownUntil: 0, cooldownMs: COOLDOWN, now: T0, result: both("primary") });
check("quiet write stays quiet", quiet.event === null && quiet.primaryDownUntil === 0);

console.log(failures === 0 ? "ok: failover cooldown" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
