#!/usr/bin/env node
import type { InFlightWrite, WriteTiming } from "../src/lag.js";
/**
 * Lag / compaction-wait policy check. Run: npx tsx tools/lag-check.ts
 *
 * The policy decides whether a compaction waits for an in-flight write or hands the compaction to
 * pi. Both mistakes are silent in a live session — a wait that never pays costs the user a stalled
 * `/compact`, a skip that should have waited costs pi's model call and an unread range — so every
 * gate is pinned here, plus the arithmetic the message and the audit line are built from.
 *
 * `tools/compaction-wait-check.ts` covers the wiring around this; nothing there re-tests the rules.
 */
import { chunksBehind, decideCompactionWait, estimateLag, recentTimings, TIMING_WINDOW } from "../src/lag.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const NOW = 1_760_000_000_000;
const secondsAgo = (s: number) => NOW - s * 1000;

/** A write that started `elapsed` seconds ago and reported `stage` `stageAgo` seconds ago. */
const running = (stage: InFlightWrite["stage"], elapsed: number, stageAgo = elapsed): InFlightWrite => ({
	chunkId: "hy-01234567-005",
	chunkTokens: 9692,
	startedAt: secondsAgo(elapsed),
	stage,
	stageAt: secondsAgo(stageAgo),
	...(stage === "reconcile" ? { reconcileAt: secondsAgo(stageAgo) } : {}),
});

/** extract p50 ~158 s, reconcile p50 ~30 s — the numbers the live audit reports. */
const timings = (n: number, extractMs: number, reconcileMs: number): WriteTiming[] =>
	Array.from({ length: n }, (_, i) => ({ chunkId: `c${i}`, extractMs, reconcileMs }));

const base = {
	enabled: true,
	dryRun: false,
	sessionActive: true,
	reason: "threshold",
	wouldDrop: true,
	timings: timings(4, 158_000, 30_000),
	healthy: true,
	entries: 95,
	tokens: 23_061,
	maxChunkTokens: 12_000,
	budgetMs: 60_000,
	now: NOW,
};

// --- estimateLag: the ETA model itself -------------------------------------------------------

check(
	"reconcile ETA comes from the reconcile median, not the total",
	estimateLag({ inFlight: running("reconcile", 120, 10), timings: base.timings, now: NOW }),
	{
		stage: "reconcile",
		elapsedS: 120,
		etaS: 20,
		basis: "reconcile",
		medianReconcileMs: 30_000,
		medianTotalMs: 188_000,
	},
);

check(
	"extract ETA is the total median minus what the whole write has run",
	estimateLag({ inFlight: running("extract", 180), timings: base.timings, now: NOW }).etaS,
	8,
);

check(
	"an extract past the total median falls back to the reconcile median",
	estimateLag({ inFlight: running("extract", 400), timings: base.timings, now: NOW }),
	{
		stage: "extract",
		elapsedS: 400,
		etaS: 30,
		basis: "total then reconcile",
		medianReconcileMs: 30_000,
		medianTotalMs: 188_000,
	},
);

check(
	"ETA is floored at 0 rather than going negative",
	estimateLag({ inFlight: running("reconcile", 300, 90), timings: base.timings, now: NOW }).etaS,
	0,
);

check(
	"a waiting stage has no ETA — another session holds the single slot",
	estimateLag({ inFlight: running("waiting", 40), timings: base.timings, now: NOW }),
	{ stage: "waiting", elapsedS: 40, etaS: null, basis: "none" },
);

check(
	"no completed write means no estimate",
	estimateLag({ inFlight: running("reconcile", 5, 2), timings: [], now: NOW }),
	{ stage: "reconcile", elapsedS: 5, etaS: null, basis: "none" },
);

check(
	"a resumed extract (0 s recorded) is estimated from the extract median, not as an instant write",
	estimateLag({
		inFlight: running("extract", 10),
		timings: [{ chunkId: "r1", extractMs: 0, reconcileMs: 30_000 }, ...timings(2, 150_000, 30_000)],
		now: NOW,
	}).etaS,
	170,
);

check("medians are taken over the last 8 writes only", recentTimings(timings(20, 1000, 1000)).length, TIMING_WINDOW);
check(
	"the timing window is the newest 8, so an old slow route cannot hold the ETA open",
	estimateLag({
		inFlight: running("reconcile", 5, 2),
		timings: [...timings(12, 900_000, 400_000), ...timings(8, 20_000, 4_000)],
		now: NOW,
	}).etaS,
	2,
);

// --- decideCompactionWait: every gate --------------------------------------------------------

const decided = (over: Partial<Parameters<typeof decideCompactionWait>[0]>) =>
	decideCompactionWait({ ...base, ...over } as Parameters<typeof decideCompactionWait>[0]);

check("a reconcile with ~20 s left under a 60 s budget waits", decided({ inFlight: running("reconcile", 120, 10) }), {
	wait: true,
	reason: "wait",
	etaS: 20,
	elapsedS: 120,
	stage: "reconcile",
	entries: 95,
	tokens: 23_061,
	chunksBehind: 2,
	medianReconcileMs: 30_000,
	medianTotalMs: 188_000,
});

check(
	"waitForWriterBeforeCompact: false skips",
	decided({ enabled: false, inFlight: running("reconcile", 120, 10) }).reason,
	"disabled",
);
check("a dry run skips", decided({ dryRun: true, inFlight: running("reconcile", 120, 10) }).reason, "dry run");
check(
	"/hy off skips",
	decided({ sessionActive: false, inFlight: running("reconcile", 120, 10) }).reason,
	"session off",
);
check("overflow never waits", decided({ reason: "overflow", inFlight: running("reconcile", 5, 2), budgetMs: 60_000 }), {
	wait: false,
	reason: "overflow",
	etaS: null,
	elapsedS: 0,
	stage: "reconcile",
	entries: 95,
	tokens: 23_061,
	chunksBehind: 2,
});
check(
	"manual compaction waits like threshold",
	decided({ reason: "manual", inFlight: running("reconcile", 120, 10) }).wait,
	true,
);
check(
	"a boundary that is already safe has nothing to wait for",
	decided({ wouldDrop: false, inFlight: running("reconcile", 5, 2) }).reason,
	"already safe",
);
check("no write in flight: there is nothing to wait for and nothing to resume", decided({ inFlight: null }), {
	wait: false,
	reason: "no write in flight",
	etaS: null,
	elapsedS: 0,
	stage: null,
	entries: 95,
	tokens: 23_061,
	chunksBehind: 2,
});
check(
	"an unhealthy writer (failures, cooldown, held primary) is not waited on",
	decided({ healthy: false, inFlight: running("reconcile", 120, 10) }).reason,
	"writer unhealthy",
);
check("a busy endpoint skips", decided({ inFlight: running("waiting", 40) }).reason, "busy endpoint");
check(
	"a fresh session with no completed write does not gamble on a wait",
	decided({ timings: [], inFlight: running("reconcile", 120, 10) }).reason,
	"no timing history",
);
check(
	"an ETA past the shared budget is skipped rather than pinning compaction",
	decided({ inFlight: running("extract", 10), budgetMs: 60_000 }).reason,
	"eta over budget",
);
check(
	"the skip names the ETA that caused it",
	decided({ inFlight: running("extract", 10), budgetMs: 60_000 }).etaS,
	178,
);
check(
	"an ETA exactly at the budget still waits",
	decided({ inFlight: running("reconcile", 200, 30), budgetMs: 60_000 }).wait,
	true,
);

// --- chunksBehind: reported, never a gate ----------------------------------------------------

check("chunksBehind rounds up a partial chunk", chunksBehind(23_061, 12_000), 2);
check("chunksBehind rounds up 12 001 over 12 000", chunksBehind(12_001, 12_000), 2);
check("chunksBehind is 1 for a backlog inside one chunk", chunksBehind(12_000, 12_000), 1);
check("chunksBehind is 0 when nothing is unread", chunksBehind(0, 12_000), 0);
check("chunksBehind survives a zero chunk budget", chunksBehind(5000, 0), 1);
check(
	"chunksBehind does not gate the decision: four chunks behind still waits when the ETA is short",
	decided({ tokens: 60_000, inFlight: running("reconcile", 120, 10) }).wait,
	true,
);
check(
	"the reported chunksBehind travels with the decision",
	decided({ tokens: 60_000, inFlight: running("reconcile", 120, 10) }).chunksBehind,
	5,
);

console.log(failures === 0 ? "ok: lag policy" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
