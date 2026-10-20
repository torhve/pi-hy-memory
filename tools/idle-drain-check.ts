#!/usr/bin/env node
/**
 * Idle-drain check. Run: npx tsx tools/idle-drain-check.ts
 *
 * Pins the policy that lets a quiet session pay down its backlog. The defect it
 * exists for: `turn_end` is the only place a write is started, so a session that
 * is reloaded and then left open never drains — measured on session 01a15860
 * (2026-10-20), reloaded at 18:40 with 352 000 tokens unread and `writes: 0`
 * afterwards because no turn ran.
 *
 * The gate is stricter than the ordinary trigger on purpose. A turn would have
 * handled a 12 000-token window anyway; an idle drain is only for a backlog the
 * user is not about to pay off, and it must not fire over an in-flight write, a held
 * primary, a cooldown, or a session the user switched off. A writer that has failed
 * is probed, not vetoed: while a session stays quiet nothing else ever tries again.
 */

import {
	IDLE_DRAIN_TRIGGER_FACTOR,
	IDLE_PROBE_MAX_FAILURES,
	type IdleDrainInput,
	shouldIdleDrain,
} from "../src/chain.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const base: IdleDrainInput = {
	enabled: true,
	sessionActive: true,
	idleMs: 240_000,
	idleAfterMs: 180_000,
	inFlight: false,
	pendingExtract: false,
	failures: 0,
	primaryDown: false,
	coolingDown: false,
	pendingTokens: 352_000,
	triggerTokens: 10_000,
	entryCount: 1_800,
};

const decide = (patch: Partial<IdleDrainInput>) => shouldIdleDrain({ ...base, ...patch });
const reason = (patch: Partial<IdleDrainInput>) => decide(patch).reason;

// 1. The case the fix exists for: idle session, backlog far over the trigger.
check("idle backlog drains", decide({}).drain, true);
check("drain reason", reason({}), "idle with a large backlog");

// 2. The threshold is four times the trigger, and it is a boundary, not a suggestion.
check("factor is four", IDLE_DRAIN_TRIGGER_FACTOR, 4);
check("one token under the threshold stops", decide({ pendingTokens: 39_999 }).drain, false);
check("at the threshold drains", decide({ pendingTokens: 40_000 }).drain, true);
check("threshold reason", reason({ pendingTokens: 39_999 }), "backlog under idle threshold");
// A window a turn would have handled anyway: the ordinary trigger is satisfied,
// the idle gate is not.
check("ordinary trigger is not enough", decide({ pendingTokens: 12_000 }).reason, "backlog under idle threshold");

// 3. Not idle yet, and the kill switch.
check("recent activity waits", decide({ idleMs: 179_999 }).reason, "session not idle");
check("idle boundary is inclusive", decide({ idleMs: 180_000 }).drain, true);
check("zero disables", decide({ idleAfterMs: 0 }).reason, "idle drain disabled");
check("extension off disables", decide({ enabled: false }).reason, "disabled");
check("/hy off stays silent", decide({ sessionActive: false }).reason, "session off");

// 4. Nothing may overlap a write or a writer that is already struggling.
check("in-flight write blocks", decide({ inFlight: true }).reason, "write in flight");
check("awaiting reconcile blocks", decide({ pendingExtract: true }).reason, "extract awaiting reconcile");
check("a failed writer is probed, not vetoed", decide({ failures: 2 }).reason, "idle with a large backlog");
check("probe cap is small", IDLE_PROBE_MAX_FAILURES <= 3, true);
check("past the probe cap it stops", decide({ failures: IDLE_PROBE_MAX_FAILURES + 1 }).reason, "writer unhealthy");
check("a cooldown spaces the probes", decide({ failures: 2, coolingDown: true }).reason, "write cooling down");
check("held primary blocks", decide({ primaryDown: true }).reason, "primary writer held");
check("cooldown blocks", decide({ coolingDown: true }).reason, "write cooling down");
check("nothing renderable blocks", decide({ entryCount: 0 }).reason, "nothing renderable");

console.log(failures === 0 ? "ok: idle drain policy" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
