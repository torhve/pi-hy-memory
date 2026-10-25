#!/usr/bin/env npx tsx

/**
 * dev/live-bank-report.ts — read one real session's memory, offline, and say what the
 * writer's own state files show that no corpus here can.
 *
 * Every other instrument in `dev/` replays an authored corpus: the writer saw chunks whose
 * correct output is known by construction. This one reads the state a session actually left
 * behind — `bank.json`, `ledger.jsonl`, `stats.json` — and reports the four things that only
 * appear in organic use, all of them measured on the author's own 155-write session:
 *
 *   - the pool ceiling bites, and how much it retired (`bank budget` supersessions);
 *   - reach: values carried only by retired facts, which `hy_recall` answers and marks, and
 *     which a query restricted to active entries could not reach at all (TODO 6.18);
 *   - the value gate replayed over the merges the writer really proposed, drafts held fixed,
 *     the same caveat every re-fold carries;
 *   - what the guards refused, and how much of that is retrieval rather than judgement.
 *
 * The fold and the live bank are different stores and the report says so: retirement is never
 * written to the ledger, so folding restores facts the running session had already dropped
 * (TODO 6.19). Numbers are printed for both, never merged into one.
 *
 *   npx tsx dev/live-bank-report.ts                     # every session in the state dir
 *   npx tsx dev/live-bank-report.ts --session <id>      # one session
 *   npx tsx dev/live-bank-report.ts --dir <path> --pool 60000
 *
 * Nothing here writes, and nothing prints fact text beyond the short labels it quotes.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { enforceBudget, foldLedger, newId } from "../src/bank.js";
import { guardUpdateOps } from "../src/protocol.js";
import { recallHits } from "../src/render.js";
import type { BankEntry, Draft, LedgerRecord } from "../src/types.js";
import { estimateTokens } from "../src/types.js";
import { carries, valuesTheDraftDrops, valueTokens } from "../src/values.js";

export type SessionReport = {
	sessionId: string;
	records: number;
	writes: number;
	statsWrites: number | null;
	foldedActive: number;
	foldedTokens: number;
	pool: number;
	fitsPool: number;
	trimmedSameAsStore: boolean;
	snapshotAt: string;
	snapshotDigest: string;
	replayMatchesFold: boolean;
	liveActive: number;
	liveTokens: number;
	retiredByBudget: number;
	valuesOnlyInRetired: number;
	updatesApplied: number;
	gateRefusals: number;
	mergesDroppingValue: number;
	valuesNoCurrentFactCarries: number;
	gateUpdatesApplied: number;
	gateActive: number;
	gateTokens: number;
	gateFitsPool: number;
	fitsPoolShipped: number;
	valuesOnlyInRetiredUnderGate: number;
	userGrounded: number;
	labelledTurns: number;
	userTurns: number;
	/** Whether any write in this ledger recorded turn counts at all. */
	turnCountsRecorded: boolean;
	refusalsByKind: Record<string, number>;
};

const surface = (row: { task: string; statement: string; keys: string[] }) =>
	`${row.task} ${row.statement} ${row.keys.join(" ")}`.toLowerCase();

function parseJsonl(text: string): LedgerRecord[] {
	const out: LedgerRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as LedgerRecord);
		} catch {
			// a torn last line is how a session that died mid-write looks
		}
	}
	return out;
}

function _readJsonl(path: string): LedgerRecord[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as LedgerRecord);
}

/** The fold from `src/bank.ts` with the write-time guard inserted where `src/pipeline.ts` runs it. */
function replay(records: LedgerRecord[], valueGate: boolean) {
	const bank: BankEntry[] = [];
	let pending: { chunkId: string; drafts: (Draft & { sourceEntryIds: string[] })[] } | undefined;
	let chunkSeq = 0;
	let gateRefusals = 0;
	let updatesApplied = 0;
	let mergesDroppingValue = 0;
	const dropped: { value: string; chunkId: string; task: string }[] = [];

	for (const record of records) {
		// Same shape as `foldLedger`: a gap and an eviction carry no write.
		if (record.type === "hy.gap" || record.type === "hy.evict") continue;
		if (record.type === "hy.extract") {
			pending = { chunkId: record.chunkId, drafts: record.drafts };
			continue;
		}
		const drafts = pending?.chunkId === record.chunkId ? pending.drafts : [];
		chunkSeq += 1;
		const downgraded: { reason: string; op: unknown }[] = [];
		const ops = guardUpdateOps(bank, drafts, record.ops, downgraded, { valueGate });
		gateRefusals += downgraded.filter((d) => (d.reason ?? "").includes("carries a value")).length;
		updatesApplied += ops.filter((op) => op.action === "UPDATE").length;

		for (const op of ops) {
			if (op.action === "DELETE") {
				const target = bank.find((e) => e.id === op.target && e.status === "active");
				if (target) target.status = "superseded";
				continue;
			}
			if (op.action === "SKIP") continue;
			const draft = drafts[op.draft];
			if (!draft) continue;
			if (op.action === "UPDATE") {
				const target = bank.find((e) => e.id === op.target && e.status === "active");
				if (target) {
					const lost = valuesTheDraftDrops(target, draft);
					if (lost.length > 0) mergesDroppingValue += 1;
					for (const value of lost) dropped.push({ value, chunkId: record.chunkId, task: target.task });
					target.status = "superseded";
				}
			}
			bank.push({
				id: newId(`${record.chunkId}:${op.draft}:${op.action}`),
				task: draft.task,
				statement: draft.statement,
				keys: draft.keys,
				sourceEntryIds: draft.sourceEntryIds,
				chunkId: record.chunkId,
				chunkSeq,
				fromUser: draft.fromUser === true,
				createdAt: record.createdAt,
				status: "active",
				tokenCount: estimateTokens(draft.statement),
			});
		}
	}
	return {
		bank,
		active: bank.filter((e) => e.status === "active"),
		gateRefusals,
		updatesApplied,
		mergesDroppingValue,
		dropped,
	};
}

/** How many facts survive the ceiling a reload re-applies. `enforceBudget` mutates what it is
 * given, so this counts on copies. */
/** Ties the printed numbers to one file: the same ledger text gives the same digest. */
function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** Whether trimming the fold by the pool leaves exactly the ids the store marked current. */
function sameIds(trimmed: BankEntry[], store: BankEntry[]): boolean {
	const a = new Set(trimmed.map((entry) => entry.id));
	const b = new Set(store.map((entry) => entry.id));
	return a.size === b.size && [...a].every((id) => b.has(id));
}

function trimmedToPool(bank: BankEntry[], pool: number): BankEntry[] {
	const copies = bank.map((entry) => ({ ...entry }));
	enforceBudget(copies, pool);
	return copies.filter((entry) => entry.status === "active");
}

function fitsWithin(bank: BankEntry[], pool: number): number {
	return trimmedToPool(bank, pool).length;
}

/** Values that no current fact carries any more, whether the retirement came from a merge or the ceiling. */
function valuesOnlyWhereTheyDoNotCount(
	current: BankEntry[],
	retired: BankEntry[],
	dropped: { value: string; chunkId: string; task: string }[],
): number {
	const carried = current.map(surface);
	const fromMerges = new Set(
		dropped.filter((d) => !carried.some((text) => carries(d.value, text))).map((d) => d.value.toLowerCase()),
	);
	const fromCeiling = new Set(
		retired
			.filter((e) => e.supersedeReason === "bank budget")
			.flatMap((e) => [...valueTokens(surface(e))])
			.filter((value) => !carried.some((text) => carries(value, text))),
	);
	return fromMerges.size + [...fromCeiling].filter((v) => !fromMerges.has(v)).length;
}

function kind(reason: string): string {
	if (reason.includes("carries a value")) return "value gate";
	if (reason.includes("restate its subject")) return "subject guard";
	if (reason.includes("not retrieved")) return "target not retrieved";
	if (reason.includes("superseded in this batch")) return "already superseded in batch";
	return "other";
}

export function reportSession(dir: string, sessionId: string, pool: number): SessionReport | null {
	const ledgerPath = join(dir, `${sessionId}.ledger.jsonl`);
	if (!existsSync(ledgerPath)) return null;
	const ledgerText = readFileSync(ledgerPath, "utf8");
	const records = parseJsonl(ledgerText);
	if (records.length === 0) return null;
	let live: BankEntry[] = [];
	let statsWrites: number | null = null;
	try {
		live = JSON.parse(readFileSync(join(dir, `${sessionId}.bank.json`), "utf8")) as BankEntry[];
	} catch {
		live = [];
	}
	try {
		statsWrites =
			(JSON.parse(readFileSync(join(dir, `${sessionId}.stats.json`), "utf8")) as { writes?: number }).writes ??
			null;
	} catch {
		statsWrites = null;
	}

	const folded = foldLedger(records);
	// A reload re-applies the ceiling (src/index.ts), and that eviction is not in the ledger,
	// A reload re-applies the ceiling (src/index.ts), and that eviction is not in the ledger,
	// so the same fold trimmed to the current pool is what a reader holding this ledger gets.
	const fitsPool = fitsWithin(folded, pool);
	const liveActive = live.filter((e) => e.status === "active");
	const retired = live.filter((e) => e.status !== "active");
	const shipped = replay(records, false);
	const gated = replay(records, true);

	const refusalsByKind: Record<string, number> = {};
	for (const record of records) {
		if (record.type !== "hy.ops") continue;
		for (const downgraded of record.downgradedOps ?? []) {
			const name = kind(String(downgraded.reason ?? ""));
			refusalsByKind[name] = (refusalsByKind[name] ?? 0) + 1;
		}
	}

	// How much of what this session wrote was the user's own turn. `fromUser` on a fact only says
	// a draft cited a user line; without the denominator the ratio between the two is unmeasurable,
	// which is TODO 6.20. A session whose writes predate the counter prints 0 and says so.
	let labelledTurns = 0;
	let userTurns = 0;
	for (const record of records) {
		if (record.type !== "hy.extract") continue;
		labelledTurns += record.labelledTurns ?? 0;
		userTurns += record.userTurns ?? 0;
	}
	return {
		sessionId,
		records: records.length,
		writes: records.filter((r) => r.type === "hy.ops").length,
		statsWrites,
		foldedActive: folded.filter((e) => e.status === "active").length,
		foldedTokens: folded.filter((e) => e.status === "active").reduce((n, e) => n + e.tokenCount, 0),
		pool,
		fitsPool,
		trimmedSameAsStore: sameIds(trimmedToPool(folded, pool), liveActive),
		replayMatchesFold: sameIds(shipped.bank, folded),
		snapshotAt: String(records[records.length - 1]?.createdAt ?? ""),
		snapshotDigest: digest(ledgerText),
		liveActive: liveActive.length,
		liveTokens: liveActive.reduce((n, e) => n + e.tokenCount, 0),
		retiredByBudget: retired.filter((e) => e.supersedeReason === "bank budget").length,
		valuesOnlyInRetired: valuesOnlyWhereTheyDoNotCount(liveActive, retired, shipped.dropped),
		updatesApplied: shipped.updatesApplied,
		gateRefusals: gated.gateRefusals,
		mergesDroppingValue: shipped.mergesDroppingValue,
		valuesNoCurrentFactCarries: valuesOnlyWhereTheyDoNotCount(shipped.active, [], shipped.dropped),
		gateUpdatesApplied: gated.updatesApplied,
		gateActive: gated.active.length,
		gateTokens: gated.active.reduce((n, e) => n + e.tokenCount, 0),
		gateFitsPool: fitsWithin(gated.bank, pool),
		fitsPoolShipped: fitsWithin(shipped.bank, pool),
		valuesOnlyInRetiredUnderGate: valuesOnlyWhereTheyDoNotCount(gated.active, [], gated.dropped),
		userGrounded: liveActive.filter((e) => e.fromUser === true).length,
		labelledTurns,
		userTurns,
		turnCountsRecorded: records.some((r) => r.type === "hy.extract" && r.labelledTurns !== undefined),
		refusalsByKind,
	};
}

/** Whether the repaired query actually reaches a value no current fact carries. */
export function reachableThroughQuery(live: BankEntry[], value: string): boolean {
	return recallHits(live, value, 5).some((hit) => carries(value, surface(hit.entry)));
}

function print(report: SessionReport, pool: number): void {
	console.log(`session ${report.sessionId}`);
	console.log(
		`ledger ${report.records} records, ${report.writes} writes | stats.json says ${report.statsWrites ?? "-"} writes (counters reset at session_start)`,
	);
	console.log(
		`the store as it ran: ${report.liveActive} current facts / ${report.liveTokens} tokens; the ledger folded: ${report.foldedActive} / ${report.foldedTokens} — retirement is not in the ledger, so the fold restores ${report.foldedActive - report.liveActive} facts the session had dropped`,
	);
	console.log(
		`the same fold trimmed to the pool a reload re-applies (${report.pool}): ${report.fitsPool} facts, where the session had ${report.liveActive} current — ${report.trimmedSameAsStore ? "the same ids: a reload re-applies the same recency rule" : "a different set, so eviction is not reproducible from the ledger"}`,
	);
	console.log(
		`pool ceiling ${pool}: ${report.retiredByBudget} facts retired by budget; ${report.valuesOnlyInRetired} values are carried only by retired facts, reachable through the query and marked retired`,
	);
	console.log(
		`merges: ${report.updatesApplied} applied, ${report.mergesDroppingValue} dropped a value, ${report.valuesNoCurrentFactCarries} values left with no current fact carrying them`,
	);
	console.log(
		`same ledger replayed with the value gate on: ${report.gateUpdatesApplied} applied, ${report.gateRefusals} refused, ${report.valuesOnlyInRetiredUnderGate} values left uncarried, bank ${report.gateActive} facts / ${report.gateTokens} tokens; at the ceiling that is ${report.gateFitsPool} facts current against ${report.fitsPoolShipped} with the gate off`,
	);
	console.log(`refusals the bank recorded: ${JSON.stringify(report.refusalsByKind)}`);
	console.log(`user-grounded facts: ${report.userGrounded} of ${report.liveActive} current`);
	console.log(
		`what the writer was shown: ${report.userTurns} user turns of ${report.labelledTurns} labelled turns${report.turnCountsRecorded ? "" : " — no write in this ledger recorded turn counts, so this session ran before the counter existed"}`,
	);
	console.log(
		`snapshot: last record ${report.snapshotAt || "unknown"}, ledger digest ${report.snapshotDigest} — re-run with --dir on a copy of these files to read the same numbers`,
	);
	console.log(
		`the re-decided fold agrees with src/bank.ts foldLedger on this ledger: ${report.replayMatchesFold ? "yes" : "no"} — where it is no, the gate numbers below are an estimate, not shipped behaviour`,
	);
}

function main(): void {
	const args = process.argv.slice(2);
	const arg = (name: string): string | undefined => {
		const at = args.indexOf(`--${name}`);
		return at >= 0 ? args[at + 1] : undefined;
	};
	const source = arg("dir") ?? join(process.env.HOME ?? "", ".pi/agent/pi-hy-memory/state/sessions");
	const wanted = arg("session");
	// --snapshot freezes the three files into a directory and reads from the copy, so the
	// numbers printed here stay reproducible while the session is still writing.
	const snapshot = arg("snapshot");
	let dir = source;
	if (snapshot && wanted) {
		mkdirSync(snapshot, { recursive: true });
		for (const suffix of [".ledger.jsonl", ".bank.json", ".stats.json"]) {
			const from = join(source, `${wanted}${suffix}`);
			if (existsSync(from)) copyFileSync(from, join(snapshot, `${wanted}${suffix}`));
		}
		dir = snapshot;
	}
	const pool = Number(arg("pool") ?? 60000);
	const ids = (
		wanted
			? [wanted]
			: readdirSync(dir)
					.filter((f) => f.endsWith(".ledger.jsonl"))
					.map((f) => f.slice(0, -".ledger.jsonl".length))
	).sort();
	let printed = 0;
	for (const id of ids) {
		const report = reportSession(dir, id, pool);
		if (!report) continue;
		print(report, pool);
		printed += 1;
	}
	if (printed === 0) console.log(`no session ledgers read from ${dir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
