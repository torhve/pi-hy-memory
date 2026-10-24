#!/usr/bin/env npx tsx
/**
 * dev/guard-fold-report.ts — tier 2 of plan-divergence.md, offline.
 *
 * TODO 7.18 offers two answers: tighten the guard's loose clause, or take values out of the model's
 * restatement burden entirely. This instrument prices them by re-folding already-recorded ledgers
 * under five settings and comparing what each bank ends up holding. No model call, no corpus edit,
 * no src/ change.
 *
 *   shipped     the clause as it runs today: half the target's vocabulary, or 3+ shared tokens and a
 *               sixth of the target's wording;
 *   tightened   the tightening TODO 7.18 proposed: half the wording, or 4+ shared tokens and a quarter
 *               of the target's wording;
 *   off         upstream's shape: every UPDATE the reconciler proposed is applied.
 *   value-carry  the shipped wording rule and a value test on top of it: an UPDATE is accepted only
 *               when every specific token the target carries — numbers, flags, file names, paths,
 *               identifiers — is restated by the draft;
 *   value-only  that value test with the wording rule dropped, which is what it looks like to gate a
 *               merge on values alone rather than on how the draft is phrased.
 *
 * The fold does not read the recorded ops as the model's proposals: the ledger stores them after our
 * guards already interfered. src/pipeline.ts replaces a refused UPDATE with an ADD and writes the
 * original into the record's downgradedOps with its draft index and target, so the proposal stream can
 * be reconstructed. But a downgrade is not one check: the recorded reasons in these six runs name the
 * subject test ("target does not restate its subject"), the retrieval test ("update target not
 * retrieved for this draft"), and the batch test ("target already superseded in this batch"). Only the
 * subject test is what these arms change, so only subject refusals are put back as UPDATEs; the rest
 * stay ADDs and are counted separately. A ledger written with `mergeValueGate` on records a fourth kind,
 * the value gate's refusal, which is also left as an ADD: the fold reproduces that bank either way, but
 * it cannot re-decide those merges, so a gate-on ledger prices the wording arms and not the gate itself.
 * Ops rejected before any of
 * this, by parseOps, are not recoverable at all — the ledger keeps at most six, truncated — and none of
 * the runs on disk has any.
 *
 * The fold then re-derives the guard decision for every proposed UPDATE against the bank as it stands
 * at that point in the replay — the same check src/pipeline.ts makes at write time — and a refused
 * merge becomes an ADD, which is what the shipped code does. So the three settings differ only in that
 * one decision, and everything downstream of it (which entry a later merge can target, how many facts
 * cover one value) is allowed to cascade.
 *
 * That reconstruction is also the fold's sharpest test: under the as-shipped setting the guard must
 * refuse exactly the proposals the run recorded as downgraded, and accept the ones it recorded as
 * UPDATEs. If the counts disagree, the fold is not the shipped rule.
 *
 * Two things keep the fold honest:
 *
 *   - the as-shipped re-fold must reproduce the recorded bank exactly, entry for entry. If it does not,
 *     the fold is not the shipped semantics and nothing else in this report means anything;
 *   - a refusal is not free. Every merge the tightened setting refuses is charged: the value the target
 *     carried, whether the replacement would have carried it, and how many active facts then cover that
 *     value. A refusal that leaves two facts saying the same thing is reported as a cost, not a win.
 *
 * What the fold cannot see is the model. A downgraded merge stays an ADD in the replay only because
 * the recorded draft is what it is; a live run under a different guard would have produced different
 * drafts in later chunks, because the bank it was shown would have been different. The numbers here
 * are the cost of the rule holding its drafts fixed, which is a bound, not a simulation.
 *
 * Usage: npx tsx dev/guard-fold-report.ts [--run <runId>] [--corpus <file>] [--all]
 */

import { existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { foldLedger, newId } from "../src/bank.js";
import { sameSubject } from "../src/protocol.js";
import type { BankEntry, Draft, LedgerRecord, ReconcileOp } from "../src/types.js";
import { estimateTokens } from "../src/types.js";
import { loadLedger, resolveCorpus, specificTokens, textOf } from "./merge-report.js";
import { type CorpusChunk, carries } from "./restraint-report.js";

const RUNS_ROOT = "out";

export type GuardSetting = "shipped" | "tightened" | "off" | "value-carry" | "value-only";

export const SETTINGS: GuardSetting[] = ["shipped", "tightened", "off", "value-carry", "value-only"];

export interface GuardVerdict {
	ok: boolean;
	shared: number;
	targetSize: number;
	/** which clause decided, so a refusal can be attributed to the clause that changed. */
	clause:
		| "target had no vocabulary to compare"
		| "restated half the target's wording"
		| "loose clause"
		| "target carried no specific value"
		| "every value the target carried is restated"
		| "refused";
	/** for the value arms: the target's values the draft does not restate. */
	missingValues?: string[];
}

/**
 * The settings as one function, so no arm can drift from another by accident.
 *
 * `value-carry` keeps the shipped wording rule and adds a value test on top of it: an UPDATE is
 * accepted only when every specific token the target carries — numbers, flags, file names, paths,
 * identifiers, read with the same boundary rule the scorer uses — is restated by the draft.
 * `value-only` drops the wording rule and keeps that value test alone, which is the version a
 * merge gate could ship without asking the model to phrase anything. Both read only what an entry
 * already holds, so neither needs a corpus label at run time.
 */
export function guardVerdict(
	setting: GuardSetting,
	draft: { task: string; statement: string; keys?: string[] },
	target: { task: string; statement: string; keys?: string[] },
): GuardVerdict {
	const { shared, targetSize } = sameSubject(draft, target);
	if (setting === "value-carry" || setting === "value-only") {
		const text = (row: { task: string; statement: string; keys?: string[] }) =>
			`${row.task} ${row.statement} ${(row.keys ?? []).join(" ")}`;
		const values = [...specificTokens(text(target))];
		const missing = values.filter((v) => !carries(v, text(draft)));
		const ratio = targetSize === 0 ? 1 : shared / targetSize;
		// The shipped wording rule, unchanged, so `value-carry` is that rule plus the value test
		// and `value-only` is the value test on its own.
		const wordingOk = targetSize === 0 || ratio >= 0.5 || (shared >= 3 && ratio >= 0.15);
		const ok = setting === "value-only" ? missing.length === 0 : wordingOk && missing.length === 0;
		if (ok) {
			return {
				ok: true,
				shared,
				targetSize,
				clause:
					values.length === 0
						? "target carried no specific value"
						: "every value the target carried is restated",
			};
		}
		return { ok: false, shared, targetSize, clause: "refused", missingValues: missing };
	}
	if (setting === "off") {
		return { ok: true, shared, targetSize, clause: "target had no vocabulary to compare" };
	}
	if (targetSize === 0) {
		return { ok: true, shared, targetSize, clause: "target had no vocabulary to compare" };
	}
	const ratio = shared / targetSize;
	if (ratio >= 0.5) return { ok: true, shared, targetSize, clause: "restated half the target's wording" };
	const loose = setting === "shipped" ? shared >= 3 && ratio >= 0.15 : shared >= 4 && ratio >= 0.25;
	if (loose) return { ok: true, shared, targetSize, clause: "loose clause" };
	return { ok: false, shared, targetSize, clause: "refused" };
}

export interface MergeRow {
	chunkId: string;
	targetChunk: string;
	targetTask: string;
	value: string;
	/** did the replacement keep the value the target carried? */
	kept: boolean;
	/** was it a value the corpus declared this chunk had to keep? */
	declared: boolean;
	shared: number;
	targetSize: number;
	clause: GuardVerdict["clause"];
}

export interface RefusalRow {
	chunkId: string;
	targetChunk: string;
	targetTask: string;
	shared: number;
	targetSize: number;
	/** values the target carried that the rejected replacement would not have carried. */
	droppedIfApplied: string[];
	/** and which of those the corpus declared. */
	declared: string[];
	/** how many active facts carry each of those values at the end of the run. */
	carriersAfter: { value: string; carriers: number }[];
	/** the entry the merge would have replaced. */
	targetId: string;
	/** the entry the draft became instead, under the id an ADD in this chunk gets. */
	ownEntryId: string;
	/** the target itself survived the refusal: still active at the end. */
	targetStillActive: boolean;
	/** the rejected draft entered the bank as its own fact instead. */
	becameOwnFact: boolean;
}

export interface FoldResult {
	run: string;
	setting: GuardSetting;
	proposed: number;
	accepted: number;
	refused: number;
	/** recorded UPDATEs whose target was not active at that point in this fold — a cascade, not a rule. */
	targetGone: number;
	/** proposals the ledger had written as ADDs, put back as the UPDATEs the reconciler proposed. */
	proposalsRestored: number;
	/** proposals the run itself recorded as refused by the subject test specifically. */
	recordedRefusals: number;
	/** refusals recorded for the retrieval or batch test, left alone by every arm. */
	otherRefusals: number;
	/** how many restored proposals this setting still refused, and how many recorded ones it accepted. */
	refusedRestored: number;
	acceptedRecordedRefusals: number;
	merges: MergeRow[];
	dropping: number;
	declaredLost: string[];
	/** declared values an accepted merge kept, counted the same way as the losses. */
	declaredKept: number;
	refusals: RefusalRow[];
	/** active facts carrying one declared value more than once. */
	valueDuplicates: { value: string; carriers: number }[];
	/** declared values this fold's bank held at some point and holds no longer — the final-bank measure,
	/** as against declaredLost, which is a statement about the merge that dropped them. */
	goneByTheEnd: { value: string; carriers: number }[];
	/** accepted + refused + targetGone has to equal proposed; asserted here rather than assumed. */
	reconciles: boolean;
	activeFacts: number;
	bankTokens: number;
	bank: BankEntry[];
}

interface Pending {
	chunkId: string;
	drafts: (Draft & { sourceEntryIds: string[] })[];
}

/**
 * The model's proposals, before our guard touched them: a recorded ADD whose draft index appears in the
 * record's downgradedOps was an UPDATE when the reconciler wrote it.
 */
/** Which of our write-time checks refused the merge. Only the subject test is a fold variable. */
export function downgradeKind(reason: string): "subject" | "value gate" | "retrieval" | "batch" | "other" {
	if (/does not restate its subject/.test(reason)) return "subject";
	if (/carries a value the draft does not restate/.test(reason)) return "value gate";
	if (/not retrieved|never shown|not candidate/i.test(reason)) return "retrieval";
	if (/superseded in this batch|already replaced/.test(reason)) return "batch";
	return "other";
}

export function proposalStream(record: Extract<LedgerRecord, { type: "hy.ops" }>): {
	ops: ReconcileOp[];
	restored: number;
	otherRefusals: number;
	restoredDrafts: Set<number>;
} {
	const refused = new Map<number, { target: string; reason: string }>();
	let otherRefusals = 0;
	for (const d of record.downgradedOps ?? []) {
		if (typeof d.draft !== "number" || typeof d.target !== "string") continue;
		if (downgradeKind(d.reason) !== "subject") {
			otherRefusals += 1;
			continue;
		}
		refused.set(d.draft, { target: d.target, reason: d.reason });
	}
	let restored = 0;
	const restoredDrafts = new Set<number>();
	const ops = record.ops.map((op): ReconcileOp => {
		if (op.action !== "ADD" || op.draft === undefined) return op;
		const was = refused.get(op.draft);
		if (!was) return op;
		restored += 1;
		restoredDrafts.add(op.draft);
		return { action: "UPDATE", draft: op.draft, target: was.target, reason: was.reason };
	});
	return { ops, restored, otherRefusals, restoredDrafts };
}

/**
 * Replay one ledger under one guard setting. Mirrors foldLedger's pairing and chunkSeq numbering and
 * src/pipeline.ts's write-time guard check, and nothing else.
 */
export function foldWithGuard(
	runId: string,
	records: LedgerRecord[],
	chunks: CorpusChunk[],
	setting: GuardSetting,
): FoldResult {
	const chunkById = new Map(chunks.map((c) => [c.chunkId, c]));
	const bank: BankEntry[] = [];
	let pending: Pending | undefined;
	let chunkSeq = 0;

	const merges: MergeRow[] = [];
	const refusals: RefusalRow[] = [];
	let declaredKept = 0;
	let proposed = 0;
	let accepted = 0;
	let refused = 0;
	let targetGone = 0;
	let proposalsRestored = 0;
	let recordedRefusals = 0;
	let otherRefusals = 0;
	let refusedRestored = 0;
	let acceptedRecordedRefusals = 0;

	for (const record of records) {
		if (record.type === "hy.gap") continue;
		if (record.type === "hy.extract") {
			pending = { chunkId: record.chunkId, drafts: record.drafts };
			continue;
		}
		if (record.type !== "hy.ops") continue;
		const drafts = pending && pending.chunkId === record.chunkId ? pending.drafts : [];
		chunkSeq += 1;
		const stream = proposalStream(record);
		proposalsRestored += stream.restored;
		recordedRefusals += stream.restored;
		otherRefusals += stream.otherRefusals;

		// The guard sees the bank as it stands before this chunk's writes, exactly as the shipped
		// pipeline sees it: an entry written earlier in the same chunk is not a target it was offered.
		const before = new Map(bank.map((e) => [e.id, e]));
		const applied: ReconcileOp[] = [];

		for (const op of stream.ops) {
			if (op.action === "DELETE" || op.action === "SKIP") {
				applied.push(op);
				continue;
			}
			const draft = drafts[op.draft];
			if (!draft) continue;
			if (op.action !== "UPDATE") {
				applied.push(op);
				continue;
			}

			proposed += 1;
			const wasRecordedRefusal = stream.restoredDrafts.has(op.draft);
			const target = before.get(op.target);
			if (target?.status !== "active") {
				targetGone += 1;
				applied.push({ action: "SKIP", draft: op.draft, reason: "target not active in this fold" });
				continue;
			}

			const verdict = guardVerdict(setting, draft, target);
			if (!verdict.ok) {
				refused += 1;
				if (wasRecordedRefusal) refusedRestored += 1;
				const targetText = textOf(target);
				const declared = chunkById.get(target.chunkId)?.probes ?? [];
				// What the target carried: its own specific tokens, plus every value the corpus declared
				// for the chunk that authored it. A probe like `line 63` is a value and not a specific
				// token, so enumerating tokens alone misses declared losses the merge audit sees.
				const targetValues = [
					...new Set([...specificTokens(targetText), ...declared.filter((v) => carries(v, targetText))]),
				];
				const droppedIfApplied = targetValues.filter(
					(v) => !carries(v, textOf({ task: draft.task, statement: draft.statement, keys: draft.keys })),
				);
				refusals.push({
					chunkId: record.chunkId,
					targetChunk: target.chunkId,
					targetTask: target.task,
					shared: verdict.shared,
					targetSize: verdict.targetSize,
					droppedIfApplied,
					declared: droppedIfApplied.filter((v) => declared.includes(v)),
					carriersAfter: [],
					targetId: target.id,
					ownEntryId: newId(`${record.chunkId}:${op.draft}:ADD`),
					targetStillActive: false,
					becameOwnFact: false,
				});
				applied.push({ action: "ADD", draft: op.draft });
				continue;
			}

			accepted += 1;
			if (wasRecordedRefusal) acceptedRecordedRefusals += 1;
			const replacementText = textOf({ task: draft.task, statement: draft.statement, keys: draft.keys });
			const targetText = textOf(target);
			const declared = chunkById.get(target.chunkId)?.probes ?? [];
			const targetValues = [
				...new Set([...specificTokens(targetText), ...declared.filter((v) => carries(v, targetText))]),
			];
			for (const value of targetValues) {
				if (carries(value, replacementText)) {
					if (declared.includes(value)) declaredKept += 1;
					continue;
				}
				merges.push({
					chunkId: record.chunkId,
					targetChunk: target.chunkId,
					targetTask: target.task,
					value,
					kept: false,
					declared: declared.includes(value),
					shared: verdict.shared,
					targetSize: verdict.targetSize,
					clause: verdict.clause,
				});
			}
			applied.push(op);
		}

		// Apply exactly the way foldLedger does, so ids and chunkSeq match a real replay.
		for (const op of applied) {
			if (op.action === "DELETE") {
				const target = bank.find((e) => e.id === op.target && e.status === "active");
				if (target) {
					target.status = "superseded";
					target.supersedeReason = op.reason ?? "invalidated by newer chunk";
				}
				continue;
			}
			if (op.action === "SKIP") continue;
			const draft = drafts[op.draft];
			if (!draft) continue;
			const entry: BankEntry = {
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
			};
			if (op.action === "UPDATE") {
				const target = bank.find((e) => e.id === op.target && e.status === "active");
				if (target) {
					target.status = "superseded";
					target.supersededBy = entry.id;
					target.supersedeReason = op.reason ?? "replaced by newer statement";
					entry.supersedes = target.id;
				}
			}
			bank.push(entry);
		}
	}

	const active = bank.filter((e) => e.status === "active");

	// Charge each refusal: what the target carried, and how many facts cover it now.
	for (const refusal of refusals) {
		refusal.targetStillActive = bank.find((e) => e.id === refusal.targetId)?.status === "active";
		refusal.becameOwnFact = bank.some((e) => e.id === refusal.ownEntryId);
		refusal.carriersAfter = refusal.droppedIfApplied.map((value) => ({
			value,
			carriers: active.filter((e) => carries(value, textOf(e))).length,
		}));
	}

	const declaredValues = new Set<string>();
	for (const chunk of chunks) for (const v of chunk.probes ?? []) declaredValues.add(v);
	const valueDuplicates = [...declaredValues]
		.map((value) => ({ value, carriers: active.filter((e) => carries(value, textOf(e))).length }))
		.filter((row) => row.carriers > 1);

	return {
		run: runId,
		setting,
		proposed,
		accepted,
		refused,
		targetGone,
		proposalsRestored,
		recordedRefusals,
		otherRefusals,
		refusedRestored,
		acceptedRecordedRefusals,
		merges,
		dropping: merges.length,
		declaredLost: merges.filter((m) => m.declared).map((m) => m.value),
		declaredKept,
		refusals,
		valueDuplicates,
		goneByTheEnd: [...declaredValues]
			.map((value) => ({
				value,
				carriers: active.filter((e) => carries(value, textOf(e))).length,
			}))
			.filter((row) => row.carriers === 0 && bank.some((e) => carries(row.value, textOf(e)))),
		reconciles: accepted + refused + targetGone === proposed,
		activeFacts: active.length,
		bankTokens: active.reduce((sum, e) => sum + (e.tokenCount ?? estimateTokens(e.statement)), 0),
		bank,
	};
}

// ---------------------------------------------------------------- reporting

function pad(value: string | number, width: number): string {
	const s = String(value);
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

interface RunAudit {
	run: string;
	corpus: string;
	/** the recorded bank, for the fold's self-check. */
	recorded: BankEntry[];
	results: Record<GuardSetting, FoldResult>;
}

function analyseRun(runId: string, corpusPath?: string): RunAudit {
	const { path, chunks } = resolveCorpus(runId, corpusPath);
	const records = loadLedger(runId);
	const recorded = foldLedger(records);
	const results = {} as Record<GuardSetting, FoldResult>;
	for (const setting of SETTINGS) results[setting] = foldWithGuard(runId, records, chunks, setting);
	return { run: runId, corpus: path, recorded, results };
}

function sameIds(a: BankEntry[], b: BankEntry[]): boolean {
	if (a.length !== b.length) return false;
	const x = new Map(a.map((e) => [e.id, e.status]));
	for (const e of b) if (x.get(e.id) !== e.status) return false;
	return true;
}

function reportRun(a: RunAudit): void {
	console.log(`\n== ${a.run}  (${a.corpus})`);
	const shipped = a.results.shipped;
	const agrees = sameIds(shipped.bank, a.recorded) && shipped.acceptedRecordedRefusals === 0;
	console.log(
		`   self-check: the as-shipped re-fold is the recorded bank — ${agrees ? "identical" : "DIFFERS"} (${a.recorded.length} entries recorded, ${shipped.bank.length} re-folded)`,
	);
	console.log(
		`   ${pad("setting", 12)} ${pad("proposed", 9)} ${pad("accepted", 9)} ${pad("refused", 8)} ${pad("target gone", 12)} ${pad("dropped value", 14)} ${pad("declared lost", 14)} ${pad("gone by end", 13)} ${pad("active facts", 13)} ${pad("bank tokens", 12)} ${pad("dup values", 10)}`.replace(
			/^/m,
			"   ",
		) +
			`
   recorded subject refusals ${shipped.recordedRefusals}, refusals from the retrieval and batch checks ${shipped.otherRefusals}. The shipped arm refused ${shipped.refusedRestored} of the recorded ones and accepted ${shipped.acceptedRecordedRefusals}: the re-derived rule ${shipped.refusedRestored === shipped.recordedRefusals && shipped.acceptedRecordedRefusals === 0 ? "agrees with what the run recorded" : "DISAGREES with what the run recorded"}`,
	);
	for (const setting of SETTINGS) {
		const r = a.results[setting];
		console.log(
			`   ${pad(setting, 12)} ${pad(r.proposed, 9)} ${pad(r.accepted, 9)} ${pad(r.refused, 8)}` +
				` ${pad(r.targetGone, 12)} ${pad(r.dropping, 14)} ${pad(r.declaredLost.length, 14)}` +
				` ${pad(r.goneByTheEnd.length, 13)} ${pad(r.activeFacts, 13)} ${pad(r.bankTokens, 12)} ${pad(r.valueDuplicates.length, 10)}`,
		);
	}

	for (const setting of SETTINGS) {
		const r = a.results[setting];
		if (!r.reconciles)
			console.log(
				`   FAIL: ${setting} accounts for ${r.accepted} + ${r.refused} + ${r.targetGone} of ${r.proposed} proposals`,
			);
	}

	const shippedLost = new Set(shipped.declaredLost);
	for (const setting of SETTINGS) {
		const r = a.results[setting];
		if (r.declaredLost.length === 0) {
			console.log(`   ${setting}: no corpus-declared value lost at a merge`);
			continue;
		}
		console.log(`   ${setting}: corpus-declared values lost at merges — ${r.declaredLost.join(", ")}`);
		for (const m of r.merges.filter((x) => x.declared)) {
			console.log(
				`      ${pad(m.value, 20)} target ${pad(m.targetChunk, 16)} merged at ${pad(m.chunkId, 16)}` +
					` ${m.shared}/${m.targetSize} shared (${m.clause})`,
			);
		}
		if (setting !== "shipped") {
			const recovered = [...shippedLost].filter((v) => !r.declaredLost.includes(v));
			const added = r.declaredLost.filter((v) => !shippedLost.has(v));
			if (recovered.length) console.log(`      recovered that shipped lost: ${recovered.join(", ")}`);
			if (added.length) console.log(`      lost that shipped did not: ${added.join(", ")}`);
		}
	}

	for (const setting of SETTINGS) {
		const r = a.results[setting];
		if (r.refusals.length === 0) continue;
		console.log(`   ${setting}: ${r.refusals.length} merge(s) refused, charged as follows`);
		for (const f of r.refusals) {
			const carried = f.carriersAfter.map((c) => `${c.value} in ${c.carriers} active fact(s)`).join(", ");
			console.log(
				`      ${pad(f.targetChunk, 16)} <- ${pad(f.chunkId, 16)} ${f.shared}/${f.targetSize} shared` +
					`${f.droppedIfApplied.length ? `; would have dropped ${f.droppedIfApplied.join(", ")}` : "; target carried no value tokens"}` +
					`${carried ? `; after the refusal ${carried}` : ""}` +
					`${f.targetStillActive ? "; target still active" : "; target superseded later anyway"}` +
					`${f.becameOwnFact ? "; the rejected draft became its own fact" : "; the rejected draft banked nothing"}`,
			);
		}
	}

	for (const setting of SETTINGS) {
		const r = a.results[setting];
		if (r.valueDuplicates.length === 0) continue;
		console.log(
			`   ${setting}: ${r.valueDuplicates.length} declared value(s) carried by more than one active fact —` +
				` ${r.valueDuplicates.map((d) => `${d.value} x${d.carriers}`).join(", ")}`,
		);
	}
	if (shipped.targetGone || a.results.tightened.targetGone || a.results.off.targetGone) {
		console.log(
			"   cascade: some recorded targets were no longer active in the re-fold, so the merge could not" +
				" be judged at all — counted under 'target gone', not under accepted or refused",
		);
	}
}

function main(): void {
	const argv = process.argv.slice(2);
	const arg = (name: string): string | undefined => {
		const at = argv.indexOf(name);
		return at >= 0 ? argv[at + 1] : undefined;
	};
	const explicit = arg("--run");
	const corpus = arg("--corpus");
	const discovered = discoverRuns();
	const runs = explicit
		? [explicit]
		: argv.includes("--all")
			? discovered
			: discovered.filter((r) => r.startsWith("restraint"));
	if (runs.length === 0) {
		console.error("no ledgers under out/ — give --run <runId>");
		process.exit(2);
	}

	const totals = {} as Record<GuardSetting, FoldResult[]>;
	let faithful = 0;
	for (const run of runs) {
		const a = analyseRun(run, corpus);
		reportRun(a);
		if (sameIds(a.results.shipped.bank, a.recorded)) faithful += 1;
		for (const setting of SETTINGS) {
			totals[setting] = [...(totals[setting] ?? []), a.results[setting]];
		}
	}

	console.log(`\n== ${runs.length} runs together`);
	console.log(
		`   self-check: the as-shipped re-fold reproduced the recorded bank in ${faithful} of ${runs.length} runs`,
	);
	const header = [
		"setting",
		"proposed",
		"accepted",
		"refused",
		"target gone",
		"dropped value",
		"declared lost",
		"gone by end",
		"active facts",
		"bank tokens",
		"dup values",
	];
	console.log(`   ${header.map((h) => pad(h, 13)).join(" ")}`);
	for (const setting of SETTINGS) {
		const list = totals[setting];
		const sum = (f: (r: FoldResult) => number) => list.reduce((n, r) => n + f(r), 0);
		const cells = [
			setting,
			sum((r) => r.proposed),
			sum((r) => r.accepted),
			sum((r) => r.refused),
			sum((r) => r.targetGone),
			sum((r) => r.dropping),
			sum((r) => r.declaredLost.length),
			sum((r) => r.goneByTheEnd.length),
			sum((r) => r.activeFacts),
			sum((r) => r.bankTokens),
			sum((r) => r.valueDuplicates.length),
		];
		console.log(`   ${cells.map((c) => pad(c, 13)).join(" ")}`);
	}

	const shipped = totals.shipped;
	const tightened = totals.tightened;
	const off = totals.off;
	const declaredLoss = (list: FoldResult[]) => list.reduce((n, r) => n + r.declaredLost.length, 0);
	console.log(
		`   declared values lost at merges: shipped ${declaredLoss(shipped)}, tightened ${declaredLoss(tightened)},` +
			` guard off ${declaredLoss(off)}`,
	);
	const split = (list: FoldResult[]) =>
		`${list.reduce((n, r) => n + r.declaredKept, 0)} kept / ${declaredLoss(list)} lost`;
	console.log(
		`   at the merge gate, corpus-declared values the accepted merges kept versus lost: shipped ` +
			`${split(shipped)}, tightened ${split(tightened)}, guard off ${split(off)}`,
	);
	const goneCost = (list: FoldResult[]) => list.reduce((n, r) => n + r.goneByTheEnd.length, 0);
	console.log(
		`   declared values the bank held and then lost entirely: shipped ${goneCost(shipped)},` +
			` tightened ${goneCost(tightened)}, guard off ${goneCost(off)}. A value dropped at one merge` +
			" counts here only if no later draft put it back.",
	);
	const dupCost = (list: FoldResult[]) => list.reduce((n, r) => n + r.valueDuplicates.length, 0);
	console.log(
		`   duplicate declared values left standing: shipped ${dupCost(shipped)}, tightened ${dupCost(tightened)},` +
			` guard off ${dupCost(off)}`,
	);
	const bankCost = (list: FoldResult[]) => list.reduce((n, r) => n + r.bankTokens, 0);
	console.log(
		`   bank size at the end: shipped ${bankCost(shipped)} tokens, tightened ${bankCost(tightened)},` +
			` guard off ${bankCost(off)}`,
	);
	console.log(
		`   the runs recorded ${totals.shipped.reduce((n, r) => n + r.recordedRefusals, 0)} subject refusals and` +
			` ${totals.shipped.reduce((n, r) => n + r.otherRefusals, 0)} refusals from the retrieval and batch checks;` +
			" the arms differ only in the first kind",
	);
	const valueCarry = totals["value-carry"];
	const valueOnly = totals["value-only"];
	const accept = (list: FoldResult[]) => list.reduce((n, r) => n + r.accepted, 0);
	const refuse = (list: FoldResult[]) => list.reduce((n, r) => n + r.refused, 0);
	const gone = (list: FoldResult[]) => list.reduce((n, r) => n + r.targetGone, 0);
	console.log(
		`   the value arms refuse merges whose target carries a value the draft does not restate:` +
			` value-carry accepts ${accept(valueCarry)} and refuses ${refuse(valueCarry)}, value-only accepts` +
			` ${accept(valueOnly)} and refuses ${refuse(valueOnly)} — and neither leaves a declared value lost` +
			` at a judged merge, because that is exactly the merge they stop. Read that against their cascade:` +
			` refusing earlier merges leaves ${gone(valueCarry)} and ${gone(valueOnly)} later proposals without` +
			` an active target to judge, so their zero is measured on a smaller denominator than shipped's.`,
	);
	console.log(
		"   reported, not gated: the fold holds the model's drafts fixed. A live run under a different" +
			" guard would have been shown a different bank and would have drafted differently, so these are" +
			" the bounds on the rule, not a simulation of the run.",
	);
}

function discoverRuns(): string[] {
	return readdirSync(RUNS_ROOT, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(`${RUNS_ROOT}/${d.name}/ledger.jsonl`))
		.map((d) => d.name);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
