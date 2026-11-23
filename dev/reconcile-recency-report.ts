#!/usr/bin/env npx tsx

/**
 * dev/reconcile-recency-report.ts — what the reconcile call was told about recency, over a real ledger.
 *
 * For every UPDATE the writer recorded, this replays the candidate set the writer was shown and asks one
 * question: was a *newer* entry that shares the target's subject sitting on screen at the same time? If it
 * was, the write superseded an older claim while the claim it contradicted stayed active — the shape that
 * left twelve mutually exclusive test counts active at once in a real session.
 *
 * Historical: the age lines it prices were removed from the shipped render on 2026-11-03, after a 30-chunk
 * corpus showed they changed no end-state number. The aged column here reproduces that render locally, so the
 * wrong-target replay and its token price stay reproducible without the shipped code carrying the age lines.
 *
 * Reads a live session ledger, so it is a dev report, not a `tools/` check. Statements are never printed;
 * only ids, timestamps and the numbers inside numeric claims, because a real bank carries hosts and addresses.
 *
 *   npx tsx dev/reconcile-recency-report.ts --session <sessionId> [--limit 24]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { foldLedger } from "../src/bank.js";
import { candidatesPerDraft, sameSubject, selectShownPerDraft } from "../src/protocol.js";
import type { BankEntry, Draft, LedgerRecord } from "../src/types.js";

const arg = (flag: string, fallback: string): string => {
	const at = process.argv.indexOf(flag);
	return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};

const sessionId = arg("--session", "");
const ledgerPath = arg("--ledger", "");
const limit = Number(arg("--limit", "24"));
if (!sessionId && !ledgerPath) {
	console.error(
		"usage: npx tsx dev/reconcile-recency-report.ts --session <sessionId> | --ledger <file> [--limit 24]",
	);
	process.exit(1);
}

const stateDir = join(homedir(), ".pi", "agent", "pi-hy-memory", "state", "sessions");
const source = ledgerPath || join(stateDir, `${sessionId}.ledger.jsonl`);
const records = readFileSync(source, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line) as LedgerRecord);

const draftsOf = new Map<string, Draft[]>();
for (const record of records) if (record.type === "hy.extract") draftsOf.set(record.chunkId, record.drafts ?? []);

/** The number a numeric claim asserts, when it asserts one: "362 checks" -> 362. */
const numericClaim = (statement: string): number | undefined => {
	const m = statement.match(/(\d{2,4})\s+checks/i);
	return m ? Number(m[1]) : undefined;
};

const plain = (entries: BankEntry[]): string =>
	entries.map((e) => `<id>${e.id}</id> (${e.task}) ${e.statement}`).join("\n");

/**
 * The render src shipped until 2026-11-03, rebuilt here because src no longer produces it: candidates sorted
 * newest first, each carrying its age. Ages that cannot be parsed render as "just now", which is what the
 * removed code did for a stamp landing after the write.
 */
const ageOf = (createdAt: string, now: string): string => {
	const ms = Date.parse(now) - Date.parse(createdAt);
	if (!Number.isFinite(ms) || ms < 60_000) return "just now";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
};

const aged = (entries: BankEntry[], now: string): string => {
	const ordered = entries
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) =>
			a.entry.createdAt === b.entry.createdAt
				? a.index - b.index
				: a.entry.createdAt < b.entry.createdAt
					? 1
					: -1,
		);
	return ordered
		.map(({ entry }) => `<id>${entry.id}</id> (${entry.task}, ${ageOf(entry.createdAt, now)}) ${entry.statement}`)
		.join("\n");
};

let updates = 0;
let notReproducible = 0;
let staleTarget = 0;
let extraStaleCandidates = 0;
let hardConflictUpdates = 0;
let hardConflictCandidates = 0;
let plainTokens = 0;
let agedTokens = 0;
const worst: {
	chunkId: string;
	target: string;
	targetAt: string;
	newer: number;
	claim?: number;
	newerClaims: number[];
}[] = [];

for (const record of records) {
	if (record.type !== "hy.ops") continue;
	const drafts = draftsOf.get(record.chunkId) ?? [];
	if (drafts.length === 0) continue;

	// The bank the writer held at this moment: every fact this ledger wrote before this chunk.
	const prior = records.filter((r) => String(r.createdAt) < String(record.createdAt));
	const bank = foldLedger(prior);
	const activeBefore = bank.filter((e) => e.status === "active");

	const perDraft = candidatesPerDraft(bank, drafts, limit);
	const shown = selectShownPerDraft(perDraft, limit);
	plainTokens += Math.ceil(plain(shown).length / 4);
	agedTokens += Math.ceil(aged(shown, record.createdAt).length / 4);

	for (const op of record.ops ?? []) {
		if (op.action !== "UPDATE" || op.draft === undefined) continue;
		const target = activeBefore.find((e) => e.id === op.target);
		if (!target) {
			notReproducible++;
			continue;
		}
		const forDraft = perDraft.get(op.draft) ?? [];
		const newerSameSubject = forDraft.filter(
			(e) => e.id !== target.id && String(e.createdAt) > String(target.createdAt) && sameSubject(target, e).ok,
		);
		// The hard version of the same question, with no subject test involved: the target and a newer
		// candidate both assert a check count, and the numbers disagree.
		const targetClaim = numericClaim(target.statement);
		const numericConflicts =
			targetClaim === undefined
				? []
				: forDraft.filter(
						(e) =>
							e.id !== target.id &&
							String(e.createdAt) > String(target.createdAt) &&
							numericClaim(e.statement) !== undefined &&
							numericClaim(e.statement) !== targetClaim,
					);
		if (numericConflicts.length > 0) {
			hardConflictUpdates++;
			hardConflictCandidates += numericConflicts.length;
		}
		updates++;
		if (newerSameSubject.length === 0) continue;
		staleTarget++;
		extraStaleCandidates += newerSameSubject.length;
		worst.push({
			chunkId: record.chunkId,
			target: target.id,
			targetAt: String(target.createdAt).slice(11, 16),
			newer: newerSameSubject.length,
			claim: numericClaim(target.statement),
			newerClaims: newerSameSubject
				.map((e) => numericClaim(e.statement))
				.filter((n): n is number => n !== undefined),
		});
	}
}

console.log(
	`ledger ${source}  chunks ${draftsOf.size}  UPDATEs recorded ${records.reduce((a, r) => a + (r.type === "hy.ops" ? r.ops.filter((o) => o.action === "UPDATE").length : 0), 0)}`,
);
console.log(`replayed at candidate limit ${limit}`);
console.log(
	`UPDATEs whose target was older than a same-subject candidate on screen: ${staleTarget} of ${updates} ` +
		`(${((staleTarget / Math.max(1, updates)) * 100).toFixed(1)}%), ${extraStaleCandidates} newer same-subject entries left active`,
);
console.log(`targets not reproducible from the recorded bank: ${notReproducible}`);
console.log(
	`hard numeric conflicts (the target and a newer candidate assert different "N checks" values): ${hardConflictUpdates} of ${updates} UPDATEs, ${hardConflictCandidates} contradicted claims left active`,
);
console.log(
	`reconcile candidate render: ${plainTokens} tok as shipped, ${agedTokens} tok with the removed age lines ` +
		`(+${agedTokens - plainTokens} over ${draftsOf.size} chunks, +${((agedTokens - plainTokens) / Math.max(1, draftsOf.size)).toFixed(1)} per call)`,
);
worst.sort((a, b) => b.newer - a.newer);
for (const w of worst.slice(0, 10))
	console.log(
		`  ${w.chunkId} target ${w.target} (${w.targetAt}${w.claim !== undefined ? `, claims ${w.claim} checks` : ""}) ` +
			`had ${w.newer} newer same-subject candidate(s) on screen${w.newerClaims.length ? ` claiming ${w.newerClaims.join(", ")}` : ""}`,
	);
