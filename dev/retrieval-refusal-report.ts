#!/usr/bin/env tsx
import { createHash } from "node:crypto";
/**
 * Retrieval refusals (TODO 6.21). Run: npx tsx dev/retrieval-refusal-report.ts --snapshot <dir>
 *
 * Two refusals live in the `parseOps` boundary, and they mean opposite things because
 * `parseOps` only accepts ids the reconcile call was actually shown:
 *
 *   - `update target not retrieved for this draft` — the id was on screen, for a *different*
 *     draft. The writer attached a real entry to the wrong draft. A wider view helps only if the
 *     entry would also rank inside this draft's own list.
 *   - `target id not in bank` — the id was never on screen at all. Measured, this is rarely an
 *     invented hex id: the field arrives with a bare draft index, a function name, or a hex string
 *     one character longer than the id pattern allows. Widening the view cannot touch it, because
 *     the writer is filling the wrong field.
 *
 * The report walks a frozen snapshot chunk by chunk, rebuilding the bank the same way the write
 * path would, and asks of every refusal on record whether the target would have been inside the
 * draft's candidate list at a wider `candidateLimit`. It also prices that widening: entries shown
 * and estimated reconcile input at each limit. Refusal lists were bounded at six per write until
 * 2026-10-25, so what this sees is a sample of recorded refusals, never the whole count.
 *
 * The bank each call saw is rebuilt by `foldLedger`, the same folder a reload uses, so this reports
 * over a fold rather than a second implementation of the write path; `foldMatchesStore` says whether
 * that fold reproduces the frozen store here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { foldLedger } from "../src/bank.js";
import { candidatesPerDraft, renderBankForReconcile, selectShownPerDraft } from "../src/protocol.js";
import type { BankEntry, Draft, LedgerRecord } from "../src/types.js";

type OpsRecord = Extract<LedgerRecord, { type: "hy.ops" }>;

import { parseJsonl } from "./live-bank-report.js";

export type RefusalReport = {
	sessionId: string;
	snapshotAt: string;
	snapshotDigest: string;
	chunks: number;
	drafts: number;
	/** Refusal records on this ledger. Lists were capped at six per write before 2026-10-25. */
	refusalsRecorded: number;
	countsAreSample: boolean;
	/** Writes whose own `downgradedCount` exceeded what the record kept. */
	writesWithTruncatedLists: number;
	byReason: Record<string, number>;
	/** Refusals of a real target the draft never got. Where, if anywhere, a wider view would reach it. */
	notRetrieved: {
		total: number;
		wouldBeReachedAt: Record<string, number>;
		neverReached: number;
		/** Of those, targets that do score well enough to be eligible but ranked past every limit tried. */
		eligibleButBeyondCap: number;
		/** Targets whose wording never reaches the eligibility floor at all, at any view size. */
		notEligibleAtAll: number;
		targetNotActiveAtWrite: number;
		/** Where the target ranked in the fully scored list, `-1` when the score floor excluded it. */
		ranksAtWidest: { rank: number; id: string; chunkId: string }[];
	};
	/** Refusals of an id the call was never shown. Whether that id exists anywhere in the session. */
	neverShown: {
		total: number;
		idExistsActiveSomewhere: number;
		idExistsSupersededSomewhere: number;
		/** The value is a real id plus one stray character: copied, then mangled. */
		idExistsAsAPrefix: number;
		/** The value is a bare number — a draft index written where an entry id belongs. */
		looksLikeAnIndex: number;
		/** The value is a word, not hex — a function or file name written where an id belongs. */
		looksLikeAName: number;
		idExistsNowhere: number;
		sampleIds: string[];
	};
	/** What each candidate limit would have cost: entries rendered and estimated input tokens. */
	viewCost: { limit: number; meanShown: number; meanInputTokens: number; versusShipped: string }[];
	/** Does folding this whole ledger reproduce the frozen store, entry for entry? */
	foldMatchesStore: boolean | null;
};

const REASONS = {
	notRetrieved: "update target not retrieved for this draft",
	notInBank: "target id not in bank",
};

function parseArgs(argv: string[]): { dir: string; sessionId?: string; shipped: number; limits: number[] } {
	const args = {
		dir: "out/live-snapshot",
		sessionId: undefined as string | undefined,
		shipped: 24,
		limits: [24, 48, 96],
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--snapshot") args.dir = argv[++i];
		else if (arg === "--session") args.sessionId = argv[++i];
		else if (arg === "--shipped") args.shipped = Number(argv[++i]);
		else if (arg === "--limits") args.limits = argv[++i].split(",").map(Number);
	}
	return args;
}

const reasonKind = (reason: string): string | null => {
	if (reason.includes(REASONS.notRetrieved)) return "notRetrieved";
	if (reason.includes(REASONS.notInBank)) return "notInBank";
	if (reason.includes("does not restate its subject")) return "subject";
	if (reason.includes("already superseded in this batch")) return "sameBatch";
	if (reason.includes("carries a value")) return "valueGate";
	return null;
};

export function reportRefusals(
	records: LedgerRecord[],
	sessionId: string,
	{ shipped, limits }: { shipped: number; limits: number[] },
	store?: BankEntry[],
): RefusalReport {
	const widest = Math.max(...limits, shipped);
	const byReason: Record<string, number> = {};
	const reachedAt: Record<string, number> = {};
	const viewTokensAt: Record<string, number[]> = {};
	const viewShownAt: Record<string, number[]> = {};
	let refusalsRecorded = 0;
	let writesWithTruncatedLists = 0;
	let chunks = 0;
	let draftsWritten = 0;
	let notRetrievedTotal = 0;
	let neverReached = 0;
	let eligibleButBeyondCap = 0;
	let notEligibleAtAll = 0;
	let targetNotActiveAtWrite = 0;
	const ranksAtWidest: { rank: number; id: string; chunkId: string }[] = [];
	let neverShownTotal = 0;
	let idExistsActiveSomewhere = 0;
	let idExistsSupersededSomewhere = 0;
	let idExistsAsAPrefix = 0;
	let looksLikeAnIndex = 0;
	let looksLikeAName = 0;
	let idExistsNowhere = 0;
	const sampleIds: string[] = [];

	const wholeFold = foldLedger(records);
	const statusOf = new Map(wholeFold.map((e) => [e.id, e.status]));

	let pending: { chunkId: string; drafts: (Draft & { sourceEntryIds?: string[] })[] } | undefined;

	for (const [index, record] of records.entries()) {
		if (record.type === "hy.gap" || record.type === "hy.evict") continue;
		if (record.type === "hy.extract") {
			pending = { chunkId: record.chunkId, drafts: record.drafts };
			continue;
		}
		const drafts = pending?.chunkId === record.chunkId ? pending.drafts : [];
		// The bank as the reconcile call would have seen it, rebuilt by the same folder a reload
		// uses. Folding the prefix per chunk is a few thousand record applications on a long
		// session, which is cheaper than trusting a second implementation of the write path.
		const bank = foldLedger(records.slice(0, index));
		chunks += 1;
		draftsWritten += drafts.length;

		// The score floor is the real ceiling on this refusal: an entry below it never enters a
		// draft's list no matter how wide the view gets, so the unlimited pass separates a view
		// that is too narrow from a target that simply does not read like this draft.
		const scoredFully = candidatesPerDraft(bank, drafts, Number.MAX_SAFE_INTEGER);
		const perDraftByLimit = new Map<number, Map<number, BankEntry[]>>();
		for (const limit of new Set([...limits, shipped])) {
			perDraftByLimit.set(limit, candidatesPerDraft(bank, drafts, limit));
			const shown = selectShownPerDraft(perDraftByLimit.get(limit) ?? new Map(), limit);
			const key = String(limit);
			const shownCounts = viewShownAt[key] ?? [];
			shownCounts.push(shown.length);
			viewShownAt[key] = shownCounts;
			const tokenCounts = viewTokensAt[key] ?? [];
			tokenCounts.push(Math.ceil(renderBankForReconcile(shown).length / 4));
			viewTokensAt[key] = tokenCounts;
		}

		const lists = [
			...(record.downgradedOps ?? []).map((d) => ({
				reason: String(d.reason ?? ""),
				draft: d.draft,
				target: d.target,
			})),
			...(record.rejectedOps ?? []).map((d) => ({
				reason: String(d.reason ?? ""),
				draft: d.draft,
				target: d.target,
			})),
		];
		refusalsRecorded += lists.length;
		const recorded = lists.length;
		const own = (record as OpsRecord).downgradedCount ?? 0;
		if (own > recorded) writesWithTruncatedLists += 1;

		for (const refusal of lists) {
			const kind = reasonKind(refusal.reason);
			if (!kind) continue;
			byReason[kind] = (byReason[kind] ?? 0) + 1;
			const index = Number(refusal.draft);
			const target = String(refusal.target ?? "");

			if (kind === "notRetrieved") {
				notRetrievedTotal += 1;
				if (!bank.some((e) => e.id === target && e.status === "active")) targetNotActiveAtWrite += 1;
				let reached: number | undefined;
				let widestRank = -1;
				for (const limit of [...limits, shipped].sort((a, b) => a - b)) {
					const list = perDraftByLimit.get(limit)?.get(index) ?? [];
					const rank = list.findIndex((e) => e.id === target);
					if (rank >= 0) {
						reached ??= limit;
						if (limit === widest) widestRank = rank;
					}
				}
				const fullRank = (scoredFully.get(index) ?? []).findIndex((e) => e.id === target);
				if (reached === undefined) {
					neverReached += 1;
					if (fullRank >= 0) eligibleButBeyondCap += 1;
					else notEligibleAtAll += 1;
				} else reachedAt[String(reached)] = (reachedAt[String(reached)] ?? 0) + 1;
				if (ranksAtWidest.length < 6)
					ranksAtWidest.push({
						rank: fullRank >= 0 ? fullRank : widestRank,
						id: target,
						chunkId: record.chunkId,
					});
			}

			if (kind === "notInBank") {
				neverShownTotal += 1;
				const status = statusOf.get(target);
				const indexish = /^\d+$/.test(target);
				// Digits are hex characters too, so a bare index must be ruled out before the hex test.
				const hexish = !indexish && /^[a-f0-9]+$/i.test(target);
				if (indexish) looksLikeAnIndex += 1;
				else if (!hexish) looksLikeAName += 1;
				// Existence is only claimed about a value that could have been an id. A bare index or
				// a symbol name is already accounted for by the field-shape counters above; counting it
				// again as 'exists nowhere' would report one refusal twice.
				if (hexish) {
					if (status === "active") idExistsActiveSomewhere += 1;
					else if (status === "superseded") idExistsSupersededSomewhere += 1;
					else if ([...statusOf.keys()].some((id) => id.length === 12 && target.toLowerCase().startsWith(id)))
						idExistsAsAPrefix += 1;
					else idExistsNowhere += 1;
				}
				if (sampleIds.length < 6) sampleIds.push(target);
			}
		}
	}

	const mean = (values: number[]): number =>
		values.length === 0 ? 0 : Math.round(values.reduce((a, b) => a + b, 0) / values.length);
	const baseTokens = mean(viewTokensAt[String(shipped)] ?? []);
	const viewCost = [...new Set([...limits, shipped])]
		.sort((a, b) => a - b)
		.map((limit) => {
			const tokens = mean(viewTokensAt[String(limit)] ?? []);
			return {
				limit,
				meanShown: mean(viewShownAt[String(limit)] ?? []),
				meanInputTokens: tokens,
				versusShipped:
					limit === shipped
						? "shipped"
						: baseTokens === 0
							? "n/a"
							: `${Math.round(((tokens - baseTokens) / baseTokens) * 100)}%`,
			};
		});

	return {
		sessionId,
		snapshotAt:
			records
				.map((r) => r.createdAt)
				.sort()
				.at(-1) ?? "",
		snapshotDigest: createHash("sha256")
			.update(records.map((r) => JSON.stringify(r)).join("\n"))
			.digest("hex")
			.slice(0, 12),
		chunks,
		drafts: draftsWritten,
		refusalsRecorded,
		countsAreSample: writesWithTruncatedLists > 0,
		writesWithTruncatedLists,
		byReason,
		notRetrieved: {
			total: notRetrievedTotal,
			wouldBeReachedAt: reachedAt,
			neverReached,
			eligibleButBeyondCap,
			notEligibleAtAll,
			targetNotActiveAtWrite,
			ranksAtWidest,
		},
		neverShown: {
			total: neverShownTotal,
			idExistsActiveSomewhere,
			idExistsSupersededSomewhere,
			idExistsAsAPrefix,
			looksLikeAnIndex,
			looksLikeAName,
			idExistsNowhere,
			sampleIds,
		},
		viewCost,
		foldMatchesStore: store
			? JSON.stringify(
					wholeFold
						.filter((e) => e.status === "active")
						.map((e) => e.id)
						.sort(),
				) ===
				JSON.stringify(
					store
						.filter((e) => e.status === "active")
						.map((e) => e.id)
						.sort(),
				)
			: null,
	};
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	const sessions = args.sessionId
		? [args.sessionId]
		: readdirSync(args.dir)
				.filter((f) => f.endsWith(".ledger.jsonl"))
				.map((f) => f.slice(0, -".ledger.jsonl".length));
	for (const sessionId of sessions) {
		const records = parseJsonl(readFileSync(join(args.dir, `${sessionId}.ledger.jsonl`), "utf8"));
		let store: BankEntry[] | undefined;
		try {
			const parsed = JSON.parse(readFileSync(join(args.dir, `${sessionId}.bank.json`), "utf8"));
			store = (Array.isArray(parsed) ? parsed : parsed.entries) as BankEntry[];
		} catch {
			store = undefined;
		}
		const report = reportRefusals(records, sessionId, { shipped: args.shipped, limits: args.limits }, store);
		console.log(
			`session ${sessionId.slice(0, 12)}: ${report.chunks} chunks, ${report.drafts} drafts, ${report.refusalsRecorded} refusals recorded` +
				(report.countsAreSample
					? ` — a sample: ${report.writesWithTruncatedLists} writes kept fewer reasons than they downgraded`
					: ""),
		);
		console.log(
			`  by reason: ${
				Object.entries(report.byReason)
					.map(([k, v]) => `${k} ${v}`)
					.join(", ") || "none"
			}`,
		);
		console.log(
			`  target was on screen for another draft: ${report.notRetrieved.total}; would be inside this draft's own list at ${
				Object.entries(report.notRetrieved.wouldBeReachedAt)
					.map(([l, n]) => `limit ${l}: ${n}`)
					.join(", ") || "no listed limit"
			}, never reached at any listed limit ${report.notRetrieved.neverReached}, target not active when written ${report.notRetrieved.targetNotActiveAtWrite}`,
		);
		console.log(
			`  of what no listed limit reached: eligible but ranked past them ${report.notRetrieved.eligibleButBeyondCap}, wording below the eligibility floor so no view size would ever reach it ${report.notRetrieved.notEligibleAtAll}`,
		);
		console.log(
			`  id was never on screen: ${report.neverShown.total}; exists somewhere as active ${report.neverShown.idExistsActiveSomewhere}, superseded ${report.neverShown.idExistsSupersededSomewhere}, copied then mangled ${report.neverShown.idExistsAsAPrefix}, nowhere ${report.neverShown.idExistsNowhere}`,
		);
		console.log(
			`    written where an id belongs: a bare index ${report.neverShown.looksLikeAnIndex}, a word rather than hex ${report.neverShown.looksLikeAName}`,
		);
		if (report.neverShown.sampleIds.length > 0)
			console.log(`    ids named: ${report.neverShown.sampleIds.join(", ")}`);
		for (const view of report.viewCost) {
			console.log(
				`  view at limit ${view.limit}: ${view.meanShown} entries rendered on average, ~${view.meanInputTokens} input tokens (${view.versusShipped})`,
			);
		}
		if (report.notRetrieved.ranksAtWidest.length > 0) {
			console.log(
				`    where the target sat at the widest view: ${report.notRetrieved.ranksAtWidest.map((r) => `${r.id} rank ${r.rank}`).join(", ")}`,
			);
		}
		if (report.foldMatchesStore !== null)
			console.log(
				`  folding the whole ledger reproduces the frozen store entry for entry: ${report.foldMatchesStore}`,
			);
	}
}

if (process.argv[1]?.includes("retrieval-refusal-report")) main();
