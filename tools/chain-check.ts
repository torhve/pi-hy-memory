#!/usr/bin/env node
/**
 * Chain check. Run: npx tsx tools/chain-check.ts
 *
 * Pins the policy that lets a completed write be followed by another one. The
 * defect it exists for: the trigger only ran on `turn_end` and skipped while a
 * write was in flight, so a chunk that landed mid-turn left its backlog waiting
 * for the next turn — measured on session 01a1510e (2026-10-19), ten minutes
 * with the footer at 29k/15k.
 *
 * The interesting cases are the ones that must NOT chain: an unhealthy writer,
 * a persisted extract (its own retry path owns that window), and the chain cap.
 */

import { type ChainInput, MAX_CHAIN, shouldChainWrite } from "../src/chain.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const base: ChainInput = {
	enabled: true,
	sessionMatches: true,
	inFlight: false,
	pendingExtract: false,
	failures: 0,
	chained: 0,
	pendingTokens: 20_000,
	triggerTokens: 15_000,
	entryCount: 40,
};

const decide = (patch: Partial<ChainInput>) => shouldChainWrite({ ...base, ...patch });
const reason = (patch: Partial<ChainInput>) => decide(patch).reason;

// 1. The case the fix exists for: a healthy writer with a window still over the
//    trigger keeps going.
check("healthy backlog chains", decide({}).chain, true);
check("chain reason", reason({}), "window still over trigger");

// 2. Everything that must stop it.
check("disabled", reason({ enabled: false }), "disabled");
check("session changed", reason({ sessionMatches: false }), "session changed");
check("write in flight", reason({ inFlight: true }), "write in flight");
check("extract awaiting reconcile", reason({ pendingExtract: true }), "extract awaiting reconcile");
check("writer unhealthy", reason({ failures: 1 }), "writer unhealthy");
check("chain limit", reason({ chained: MAX_CHAIN }), "chain limit");
check("nothing renderable", reason({ entryCount: 0 }), "nothing renderable");
check("under trigger", reason({ pendingTokens: 14_999 }), "under trigger");

// 3. The boundary: exactly at the trigger keeps going, one token under stops.
check("at the trigger chains", decide({ pendingTokens: 15_000 }).chain, true);
check("one token under stops", decide({ pendingTokens: 14_999 }).chain, false);

// 4. A single follow-up is allowed, the second is the last.
check("first follow-up allowed", decide({ chained: MAX_CHAIN - 1 }).chain, true);
check("chain cap is small", MAX_CHAIN <= 3, true);

console.log(failures === 0 ? "ok: chain policy" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
