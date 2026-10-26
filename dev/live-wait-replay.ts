#!/usr/bin/env node
/**
 * Replay the live audit through the wait policy. Read-only; run with
 * `npx tsx dev/live-wait-replay.ts`.
 *
 * For every past `compact_deferred`, it reconstructs what the hook would have seen: was a write in
 * flight, which stage was it in, what had the completed writes cost, had this chunk already errored.
 * Then it asks `decideCompactionWait` and compares the estimate with the time the write actually
 * needed. That is the success metric for waiting: the fraction of past deferrals that become
 * `boundary_recomputed`, and the latency the rest would have added.
 *
 * The audit cannot say everything — it has no cooldown or backoff field per deferral — so `warn`
 * rows naming a busy endpoint and `failover_held` are read as the unhealthy cases they are, and
 * a chunk that answered with `write_error` is treated as unhealthy, which is exactly the gate in
 * `src/index.ts`.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decideCompactionWait, type WriteStage, type WriteTiming } from "../src/lag.js";

const AUDIT = join(homedir(), ".pi", "agent", "pi-hy-memory", "state", "audit.ndjson");
/** The live config's chunk budget; the policy's `chunksBehind` is reported with it. */
const MAX_CHUNK_TOKENS = 12_000;
const BUDGET_MS = 60_000;

type Row = Record<string, unknown>;
const ts = (row: Row): number => Date.parse(String(row.ts));

const rows = readFileSync(AUDIT, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line) as Row);

const bySession = new Map<string, Row[]>();
for (const row of rows) {
	const id = String(row.sessionId ?? "");
	if (!id) continue;
	const list = bySession.get(id) ?? [];
	list.push(row);
	bySession.set(id, list);
}

type Attempt = { chunkId: string; start: number; extractAt?: number; endAt?: number; errored: boolean };

let deferred = 0;
let inFlight = 0;
let wouldWait = 0;
let waitPaysOff = 0;
let waitTimesOut = 0;
let skippedUnhealthy = 0;
let skippedOverBudget = 0;
let skippedNoHistory = 0;
let skippedBusy = 0;
let waitedButNeverLanded = 0;
const detail: string[] = [];

type Case = {
	sessionId: string;
	at: number;
	entries: number;
	tokens: number;
	timings: WriteTiming[];
	flight: Attempt;
	healthy: boolean;
	stage: WriteStage;
};
const cases: Case[] = [];

for (const [sessionId, list] of bySession) {
	const attempts: Attempt[] = [];
	/** Chunk ids are reused by a resumed write, so attempts are paired in order, not by id. */
	const perChunk = new Map<string, Attempt[]>();
	for (const row of list) {
		const chunkId = String(row.chunkId ?? "");
		if (!chunkId) continue;
		const mine = perChunk.get(chunkId) ?? [];
		// Oldest attempt still open owns the next event: a resumed write can start while the
		// attempt it resumes is still running, and its events belong to that older attempt.
		const openAttempt = mine.find((a) => a.endAt === undefined);
		if (row.event === "write_start") {
			const attempt: Attempt = { chunkId, start: ts(row), errored: false };
			attempts.push(attempt);
			mine.push(attempt);
			perChunk.set(chunkId, mine);
		} else if (!openAttempt) {
		} else if (row.event === "extract_persisted") {
			openAttempt.extractAt = ts(row);
		} else if (row.event === "write_error") {
			// An error closes the attempt: the writer answered, badly.
			openAttempt.errored = true;
			openAttempt.endAt = ts(row);
		} else if (row.event === "write_end") {
			openAttempt.endAt = ts(row);
		}
	}

	// A held primary or a busy endpoint, from the events that name them.
	const blocked: number[] = [];
	for (const row of list) {
		if (
			row.event === "failover_held" ||
			(row.event === "warn" && /busy|429|backoff/i.test(String(row.message ?? row.reason ?? "")))
		) {
			blocked.push(ts(row));
		}
	}

	for (const row of list.filter((r) => r.event === "compact_deferred")) {
		deferred++;
		const at = ts(row);
		const timings: WriteTiming[] = attempts
			.filter((a) => a.endAt !== undefined && a.endAt <= at && !a.errored)
			.slice(-8)
			.map((a) => ({
				chunkId: a.chunkId,
				extractMs: (a.extractAt ?? (a.endAt as number)) - a.start,
				reconcileMs: (a.endAt as number) - (a.extractAt ?? (a.endAt as number)),
			}));
		const flight = attempts.find((a) => a.start <= at && (a.endAt === undefined || a.endAt > at));
		if (!flight) continue;
		inFlight++;

		// Healthy means what `writerHealthy` means: no failure on this chunk, the primary not held,
		// no cooldown window open.
		const blockedRecently = blocked.some((when) => when <= at && at - when < 60_000);
		const healthy = !flight.errored && !blockedRecently;
		const busy = blockedRecently && !flight.errored;
		const stage: WriteStage =
			flight.extractAt !== undefined && at >= flight.extractAt
				? "reconcile"
				: busy && !flight.extractAt
					? "waiting"
					: "extract";

		cases.push({
			sessionId,
			at,
			entries: Number(row.entries ?? 0),
			tokens: Number(row.tokens ?? 0),
			timings,
			flight,
			healthy,
			stage,
		});
		const decision = decideCompactionWait({
			enabled: true,
			dryRun: false,
			sessionActive: true,
			reason: "threshold",
			wouldDrop: true,
			inFlight: {
				chunkId: flight.chunkId,
				chunkTokens: 0,
				startedAt: flight.start,
				stage,
				stageAt: stage === "reconcile" ? (flight.extractAt as number) : flight.start,
				reconcileAt: flight.extractAt,
			},
			timings,
			healthy,
			entries: Number(row.entries ?? 0),
			tokens: Number(row.tokens ?? 0),
			maxChunkTokens: MAX_CHUNK_TOKENS,
			budgetMs: BUDGET_MS,
			now: at,
		});
		const actualLeftS = flight.endAt === undefined ? null : (flight.endAt - at) / 1000;
		const label = `${new Date(at).toISOString().slice(11, 19)} ${sessionId.slice(0, 8)} ${flight.chunkId.slice(-9)} ${stage}`;

		if (!decision.wait) {
			if (decision.reason === "writer unhealthy") skippedUnhealthy++;
			else if (decision.reason === "eta over budget") skippedOverBudget++;
			else if (decision.reason === "no timing history") skippedNoHistory++;
			else if (decision.reason === "busy endpoint") skippedBusy++;
			detail.push(
				`skip   ${label} ${decision.reason}${decision.etaS !== null ? ` (eta ${decision.etaS}s)` : ""}${
					actualLeftS !== null ? `, actual ${actualLeftS.toFixed(0)}s` : ", never landed"
				}`,
			);
			continue;
		}
		wouldWait++;
		if (actualLeftS === null) {
			waitedButNeverLanded++;
			detail.push(`wait   ${label} eta ${decision.etaS}s, write never landed — full budget spent`);
		} else if (actualLeftS * 1000 <= BUDGET_MS) {
			waitPaysOff++;
			detail.push(
				`wait   ${label} eta ${decision.etaS}s, actual ${actualLeftS.toFixed(0)}s — lands inside the budget, the cut would have been ours`,
			);
		} else {
			waitTimesOut++;
			detail.push(
				`wait   ${label} eta ${decision.etaS}s < actual ${actualLeftS.toFixed(0)}s — budget spent, then deferred`,
			);
		}
	}
}

console.log(`compact_deferred in the audit       ${deferred}`);
console.log(`  with a write in flight            ${inFlight}`);
console.log(`  the policy would wait             ${wouldWait}`);
console.log(`    lands inside the budget       ${waitPaysOff}   (boundary_recomputed)`);
console.log(`    write outlives the budget       ${waitTimesOut}   (budget spent, then deferred)`);
console.log(
	`    write never landed              ${waitedButNeverLanded}   (full budget spent — the gate that must catch these)`,
);
console.log(`  skipped, writer unhealthy         ${skippedUnhealthy}`);
console.log(`  skipped, ETA over budget          ${skippedOverBudget}`);
console.log(`  skipped, busy endpoint            ${skippedBusy}`);
console.log(`  skipped, no timing history        ${skippedNoHistory}`);
console.log(`  no write in flight at all         ${deferred - inFlight}   (the old deferral stands unchanged)`);
console.log("");
for (const line of detail) console.log(line);

/**
 * The same cases under a different budget. `compactWaitMs` is a choice, so the trade it buys is
 * printed rather than assumed: more budget converts more deferrals into our cut, and spends more
 * time on the ones it cannot catch.
 */
function sweep(budgetMs: number): { waits: number; paysOff: number; misses: number; latencyS: number } {
	let waits = 0;
	let paysOff = 0;
	let misses = 0;
	let latencyS = 0;
	for (const c of cases) {
		const decision = decideCompactionWait({
			enabled: true,
			dryRun: false,
			sessionActive: true,
			reason: "threshold",
			wouldDrop: true,
			inFlight: {
				chunkId: c.flight.chunkId,
				chunkTokens: 0,
				startedAt: c.flight.start,
				stage: c.stage,
				stageAt: c.stage === "reconcile" ? (c.flight.extractAt as number) : c.flight.start,
				reconcileAt: c.flight.extractAt,
			},
			timings: c.timings,
			healthy: c.healthy,
			entries: c.entries,
			tokens: c.tokens,
			maxChunkTokens: MAX_CHUNK_TOKENS,
			budgetMs,
			now: c.at,
		});
		if (!decision.wait) continue;
		waits++;
		const left = c.flight.endAt === undefined ? null : (c.flight.endAt - c.at) / 1000;
		latencyS += left === null ? budgetMs / 1000 : Math.min(budgetMs / 1000, left);
		// The ETA only decides whether to try; the write landing inside the budget decides success.
		if (left !== null && left * 1000 <= budgetMs) paysOff++;
		else misses++;
	}
	return { waits, paysOff, misses, latencyS };
}

console.log("\nbudget   waits  lands in budget   missed  added latency over the whole audit");
for (const budgetMs of [30_000, 60_000, 120_000]) {
	const s = sweep(budgetMs);
	console.log(
		`${String(Math.round(budgetMs / 1000)).padStart(4)}s  ${String(s.waits).padStart(6)}  ${String(s.paysOff).padStart(14)}  ${String(s.misses).padStart(6)}  ${s.latencyS.toFixed(0).padStart(10)}s`,
	);
}
