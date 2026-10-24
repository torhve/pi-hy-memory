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
	/** true when the bank applied it; false when the model asked for it and the bank wrote an ADD instead */
	applied: boolean;
	reason: string;
}

/** What kind of refusal a downgraded proposal was, read from the reason the bank recorded in the ledger. */
export type ProposalKind =
	| "subject guard"
	| "target not retrieved"
	| "already superseded in batch"
	| "reason not recorded";

const KINDS: { prefix: string; kind: ProposalKind }[] = [
	{ prefix: "target does not restate its subject", kind: "subject guard" },
	{ prefix: "update target not retrieved for this draft", kind: "target not retrieved" },
	{ prefix: "target already superseded in this batch", kind: "already superseded in batch" },
];

/**
 * `src/pipeline.ts` and `src/protocol.ts` write these three reasons, and the three kinds mean different
 * things: one is the subject guard saying no to a merge, one is the candidate set never offering the target,
 * one is the target having been superseded earlier in the same batch. An unrecognised reason is a kind this
 * report would silently misreport, so it stops rather than guessing.
 */
export function proposalKind(reason: string): ProposalKind {
	if (reason === "") return "reason not recorded";
	for (const { prefix, kind } of KINDS) if (reason.startsWith(prefix)) return kind;
	throw new Error(`unrecognised refusal reason, which this report cannot classify: ${reason}`);
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
	/** destructive ops whose target was not an active entry when the op ran */
	targetInactive: number;
	/** destructive ops the model asked for that the bank refused, recording an ADD instead */
	proposedOps: number;
	/** refused proposals aimed at an entry the acting session itself wrote */
	proposedSameSession: number;
	/** refused proposals aimed at an entry a different session wrote */
	proposedCrossSession: CrossSessionOp[];
	/** refused proposals whose target's creating chunk carries no session id */
	proposedTargetUnscoped: number;
	/** refused proposals whose target was not an active entry at the time, including a refusal naming no id */
	proposedTargetInactive: number;
	/** refused proposals split by the reason the bank recorded, since the kinds mean different things */
	proposedKinds: Record<ProposalKind, number>;
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
		targetInactive: 0,
		proposedOps: 0,
		proposedSameSession: 0,
		proposedCrossSession: [],
		proposedTargetUnscoped: 0,
		proposedTargetInactive: 0,
		proposedKinds: {
			"subject guard": 0,
			"target not retrieved": 0,
			"already superseded in batch": 0,
			"reason not recorded": 0,
		},
	};

	// Paired with each ops record's position in the ledger so the prefix is taken by index. indexOf on the
	// record object would work today — loadLedger parses every line into its own object — but it is the kind
	// of identity assumption that breaks quietly if a loader ever reuses or interns a record.
	const positions = ops.map((record) => ({ record, index: records.indexOf(record) }));
	for (const { record, index } of positions) {
		if (index < 0) throw new Error(`${run}: ops record ${record.chunkId} is missing from the ledger it came from`);
		// The bank as it stood before this chunk ran: everything earlier in the ledger, nothing later.
		// foldLedger builds a fresh bank out of fresh entries and only reads the records it is given, so
		// re-folding a prefix cannot inherit another fold's mutations.
		const before = foldLedger(records.slice(0, index));
		const byId = new Map(before.map((e) => [e.id, e]));
		const opSession = sessionOf(record.chunkId);

		for (const op of record.ops) {
			if (op.action !== "UPDATE" && op.action !== "DELETE") continue;
			scope.destructiveOps++;
			const target = byId.get(op.target);
			if (!target || target.status !== "active") {
				// foldLedger and applyOps both act only on an active target: an op aimed at something already
				// superseded destroyed nothing, and is evidence in neither direction.
				scope.targetInactive++;
				continue;
			}
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
				applied: true,
				rewroteProvenance: op.action === "UPDATE",
				reason: op.reason ?? "",
			});
		}

		// A refused proposal is evidence about what the model asked for, not about what the bank did. The
		// bank wrote an ADD instead, so nothing was destroyed — but the request named a live entry by id,
		// and nothing in the request knew or cared which session last wrote that entry.
		for (const downgraded of record.downgradedOps ?? []) {
			scope.proposedOps++;
			// The reason string is the bank's own record of which rule said no, so the kinds are not inferred
			// from the fact that a merge became an ADD.
			scope.proposedKinds[proposalKind(downgraded.reason ?? "")]++;
			// A refusal record is written by the bank, not the model, and the optional field is the bank's own
			// shape: a record that names no entry id aimed at nothing, so it cannot have crossed anything.
			const target = downgraded.target === undefined ? undefined : byId.get(downgraded.target);
			if (!target || target.status !== "active") {
				scope.proposedTargetInactive++;
				continue;
			}
			const targetSession = sessionOf(target.chunkId);
			if (targetSession === null || opSession === null) {
				scope.proposedTargetUnscoped++;
				continue;
			}
			if (targetSession === opSession) {
				scope.proposedSameSession++;
				continue;
			}
			scope.proposedCrossSession.push({
				run,
				chunkId: record.chunkId,
				opSession,
				action: "UPDATE",
				targetChunk: target.chunkId,
				targetSession,
				targetTask: target.task,
				applied: false,
				rewroteProvenance: false,
				reason: downgraded.reason,
			});
		}
	}

	// Every destructive op has to land in exactly one class, or the count is not auditable.
	const classified = scope.sameSession + scope.crossSession.length + scope.targetUnscoped + scope.targetInactive;
	if (classified !== scope.destructiveOps)
		throw new Error(`${run}: ${scope.destructiveOps} destructive ops but ${classified} classified`);

	// The same discipline for proposals: a class the count cannot place is a class it would not report.
	const classifiedProposals =
		scope.proposedSameSession +
		scope.proposedCrossSession.length +
		scope.proposedTargetUnscoped +
		scope.proposedTargetInactive;
	if (classifiedProposals !== scope.proposedOps)
		throw new Error(
			`${run}: ${scope.proposedOps} refused destructive proposals but ${classifiedProposals} classified`,
		);

	// And each refusal has to be attributed to the rule that recorded it, since a merge the subject guard
	// refused and a target the candidate set never offered are different events.
	const kindSum = Object.values(scope.proposedKinds).reduce((sum, n) => sum + n, 0);
	if (kindSum !== scope.proposedOps)
		throw new Error(`${run}: ${scope.proposedOps} refused proposals but ${kindSum} classified by kind`);

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
	const totalProposed = scopes.reduce((sum, s) => sum + s.proposedOps, 0);
	const totalProposedCross = scopes.reduce((sum, s) => sum + s.proposedCrossSession.length, 0);
	const totalCross = scopes.reduce((sum, s) => sum + s.crossSession.length, 0);

	console.log(
		`ledgers read: ${scopes.length}; carrying a session id in their chunk ids: ${scoped.length}; ` +
			`with no session id at all (authored corpora): ${scopes.length - scoped.length}`,
	);
	console.log(
		`ledgers demonstrably spanning more than one session (part of the scoped group above, not a fourth ` +
			`category): ${spanning.length}` +
			(spanning.length > 0 ? ` — ${spanning.map((s) => s.run).join(", ")}` : ""),
	);
	const totalSame = scopes.reduce((sum, s) => sum + s.sameSession, 0);
	const totalUnscoped = scopes.reduce((sum, s) => sum + s.targetUnscoped, 0);
	const totalInactive = scopes.reduce((sum, s) => sum + s.targetInactive, 0);
	console.log(`destructive ops applied (UPDATE + DELETE): ${totalOps}; crossing a session boundary: ${totalCross}`);
	console.log(
		`  ${totalOps} = ${totalSame} aimed at an entry of the acting session + ${totalCross} crossing a ` +
			`boundary + ${totalUnscoped} in ledgers with no session id + ${totalInactive} aimed at an entry ` +
			"that was no longer active",
	);
	console.log(
		`destructive proposals the bank refused and recorded as ADD instead: ${totalProposed}; aimed at an entry ` +
			`another session wrote: ${totalProposedCross}`,
	);
	const kindTotals: Record<ProposalKind, number> = {
		"subject guard": 0,
		"target not retrieved": 0,
		"already superseded in batch": 0,
		"reason not recorded": 0,
	};
	for (const scope of scopes)
		for (const kind of Object.keys(kindTotals) as ProposalKind[]) kindTotals[kind] += scope.proposedKinds[kind];
	console.log(
		`  the 3 kinds the bank records saying no: subject guard ${kindTotals["subject guard"]}, ` +
			`target not retrieved for that draft ${kindTotals["target not retrieved"]}, ` +
			`target already superseded earlier in the same batch ${kindTotals["already superseded in batch"]}, ` +
			`no reason recorded ${kindTotals["reason not recorded"]}`,
	);

	for (const scope of spanning) {
		console.log(`\n${scope.run}: ${scope.sessions.length} sessions, ${scope.chunks} chunks`);
		console.log(
			`  ${pad("chunk", 16)} ${pad("op", 8)} ${pad("target chunk", 16)} ${pad("target session", 14)} task`,
		);
		if (scope.crossSession.length === 0 && scope.proposedCrossSession.length === 0) {
			console.log(
				`  ${scope.destructiveOps} destructive ops applied and ${scope.proposedOps} refused, none of them ` +
					"aimed at another session's entry",
			);
		}
		for (const row of scope.crossSession) {
			console.log(
				`  ${pad(row.chunkId, 16)} ${pad(row.action, 8)} ${pad(row.targetChunk, 16)} ` +
					`${pad(row.targetSession, 14)} ${row.targetTask.slice(0, 44)}`,
			);
			console.log(`    reason recorded: ${row.reason || "(none)"}`);
		}
		for (const row of scope.proposedCrossSession) {
			console.log(
				`  ${pad(row.chunkId, 16)} ${pad("refused", 8)} ${pad(row.targetChunk, 16)} ` +
					`${pad(row.targetSession, 14)} ${row.targetTask.slice(0, 44)}`,
			);
			console.log(
				`    reason recorded: ${row.reason || "(none)"} — an ADD was written instead, so nothing was destroyed`,
			);
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
	console.log("\nA refused proposal is not a fence: the bank said no to a wording test, not to a session");
	console.log("boundary. The request named a live entry another session had written, by id, and nothing in the");
	console.log("pipeline asked which session that id belonged to.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
