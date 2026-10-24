#!/usr/bin/env npx tsx

/**
 * dev/session-scope-report.ts — tier 6a's real-data half: does destructive authority ever cross a session?
 *
 * Upstream fences writes to the session that made them: its store takes `session_id` on every mutation,
 * an atomic claim belongs to the session that observed it, and an UPDATE from session B cannot supersede
 * session A's record. Nothing in this repo's bank has a session at all: `src/protocol.ts` renders
 * candidates from every active entry and `src/bank.ts` applies a destructive op to any id it is given.
 *
 * Session identity reaches a ledger through exactly one route — the chunk-id prefix `hy-<sessionId8>-`
 * written by `nextChunkId()` in `src/chunks.ts`, which only organic captures get. Authored corpora use
 * names like `hy-r3-to-01` and carry no session, so they are excluded from the count rather than counted
 * as single-session runs.
 *
 * The fold is rebuilt prefix by prefix so each op is judged against the bank as it stood *before* that
 * chunk: an entry's own `chunkId` is the only session marker the bank keeps, and a superseding write
 * replaces it, so a fold of the whole ledger would report the cross-session write as a same-session one.
 *
 *   npx tsx dev/session-scope-report.ts
 */

import { existsSync, readdirSync } from "node:fs";

import { pathToFileURL } from "node:url";

import { foldLedger } from "../src/bank.js";
import type { LedgerRecord } from "../src/types.js";
import { loadLedger } from "./merge-report.js";

const RUNS_ROOT = "out";
const SESSION_PREFIX = /^hy-([0-9a-f]{8})-/;

function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** The session a chunk belongs to, or null when the chunk id carries no session at all. */
export function sessionOf(chunkId: string | undefined): string | null {
	return SESSION_PREFIX.exec(chunkId ?? "")?.[1] ?? null;
}

export interface CrossSessionOp {
	run: string;
	chunkId: string;
	opSession: string;
	action: string;
	targetChunk: string;
	targetSession: string;
	/** the bank's own marker of who wrote the target, from before this op touched it */
	targetTask: string;
	/** true when the op wrote a replacement, which overwrites the target's only session marker */
	rewroteProvenance: boolean;
	reason: string;
}

export interface RunScope {
	run: string;
	chunks: number;
	sessions: string[];
	/** true when the ledger demonstrably contains more than one session prefix */
	spansSessions: boolean;
	/** true when no chunk id in this ledger carries a session at all */
	unscopedIds: boolean;
	destructiveOps: number;
	/** destructive ops whose target was last written by a chunk of the same session */
	sameSession: number;
	/** destructive ops whose target was last written by a chunk of a different session */
	crossSession: CrossSessionOp[];
	/** destructive ops whose target's creating chunk carries no session id */
	targetUnscoped: number;
}

function chunkRecords(records: LedgerRecord[]): Extract<LedgerRecord, { type: "hy.ops" }>[] {
	return records.filter((r): r is Extract<LedgerRecord, { type: "hy.ops" }> => r.type === "hy.ops");
}

export function analyseLedger(run: string, records: LedgerRecord[]): RunScope {
	const ops = chunkRecords(records);
	const sessions = [...new Set(ops.map((r) => sessionOf(r.chunkId)).filter((s): s is string => s !== null))];
	const scope: RunScope = {
		run,
		chunks: ops.length,
		sessions,
		spansSessions: sessions.length > 1,
		unscopedIds: sessions.length === 0,
		destructiveOps: 0,
		sameSession: 0,
		crossSession: [],
		targetUnscoped: 0,
	};

	ops.forEach((record) => {
		// The bank as it stood before this chunk ran: everything earlier in the ledger, nothing later.
		const before = foldLedger(records.slice(0, records.indexOf(record)));
		const byId = new Map(before.map((e) => [e.id, e]));
		const opSession = sessionOf(record.chunkId);

		for (const op of record.ops) {
			if (op.action !== "UPDATE" && op.action !== "DELETE") continue;
			scope.destructiveOps++;
			const target = byId.get(op.target);
			if (!target) continue;
			const targetSession = sessionOf(target.chunkId);
			if (targetSession === null || opSession === null) {
				scope.targetUnscoped++;
				continue;
			}
			if (targetSession === opSession) {
				scope.sameSession++;
				continue;
			}
			scope.crossSession.push({
				run,
				chunkId: record.chunkId,
				opSession,
				action: op.action,
				targetChunk: target.chunkId,
				targetSession,
				targetTask: target.task,
				rewroteProvenance: op.action === "UPDATE",
				reason: op.reason ?? "",
			});
		}
	});

	return scope;
}

function discoverRuns(): string[] {
	if (!existsSync(RUNS_ROOT)) return [];
	return readdirSync(RUNS_ROOT, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.filter((name) => existsSync(`${RUNS_ROOT}/${name}/ledger.jsonl`))
		.sort();
}

function main(): void {
	const runs = discoverRuns();
	if (runs.length === 0) {
		console.error(`no ledgers under ${RUNS_ROOT}`);
		process.exit(2);
	}

	const scopes = runs.map((run) => analyseLedger(run, loadLedger(run)));
	const scoped = scopes.filter((s) => !s.unscopedIds);
	const spanning = scoped.filter((s) => s.spansSessions);
	const totalOps = scopes.reduce((sum, s) => sum + s.destructiveOps, 0);
	const totalCross = scopes.reduce((sum, s) => sum + s.crossSession.length, 0);

	console.log(
		`ledgers read: ${scopes.length}; carrying a session id in their chunk ids: ${scoped.length}; ` +
			`with no session id at all (authored corpora): ${scopes.length - scoped.length}`,
	);
	console.log(
		`ledgers demonstrably spanning more than one session: ${spanning.length}` +
			(spanning.length > 0 ? ` — ${spanning.map((s) => s.run).join(", ")}` : ""),
	);
	console.log(`destructive ops read (UPDATE + DELETE): ${totalOps}; crossing a session boundary: ${totalCross}`);

	for (const scope of spanning) {
		console.log(`\n${scope.run}: ${scope.sessions.length} sessions, ${scope.chunks} chunks`);
		console.log(
			`  ${pad("chunk", 16)} ${pad("op", 8)} ${pad("target chunk", 16)} ${pad("target session", 14)} task`,
		);
		if (scope.crossSession.length === 0) {
			console.log(`  ${scope.destructiveOps} destructive ops, none of them aimed at another session's entry`);
		}
		for (const row of scope.crossSession) {
			console.log(
				`  ${pad(row.chunkId, 16)} ${pad(row.action, 8)} ${pad(row.targetChunk, 16)} ` +
					`${pad(row.targetSession, 14)} ${row.targetTask.slice(0, 44)}`,
			);
			console.log(`    reason recorded: ${row.reason || "(none)"}`);
		}
	}

	const unscoped = scopes.filter((s) => s.targetUnscoped > 0);
	if (unscoped.length > 0) {
		console.log(
			`\nops in ledgers whose chunk ids carry no session: ${unscoped.reduce((n, s) => n + s.targetUnscoped, 0)}` +
				` across ${unscoped.length} runs — these cannot be classified either way, and are not counted as`,
		);
		console.log("same-session evidence.");
	}

	console.log("\nwhat the count can and cannot say: a run recorded with one session prefix cannot contain a");
	console.log(
		"cross-session op, so its zero is a fact about the recording and not about the rule. Where a ledger does",
	);
	console.log(
		"span sessions, the ops listed above are the direct evidence. The synthetic half of this tier — a bank",
	);
	console.log("built by hand with an entry from session A and an op from session B — is what shows what the rule");
	console.log("permits, rather than what happened to be recorded.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
