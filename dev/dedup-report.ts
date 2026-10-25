#!/usr/bin/env tsx
/**
 * The duplicate a chunk writes twice, and what removing one of them would cost (TODO 7.14's
 * residue). Run: npx tsx dev/dedup-report.ts [--run <id>]... [--all]
 *
 * 7.14 measured that reconcile never merges two drafts carrying the same declared value: 39 such
 * cases across six runs, merged down to one active fact 0 times. The duplicate is created at the
 * draft gate and passes the bank gate untouched, so the only thing that can remove it is code at
 * the write boundary — no prompt instruction produces it. This prices that rule before anything
 * ships: re-apply every recorded write with a deterministic same-batch dedup and compare banks.
 *
 * The rule, deliberately narrow: within one chunk's op list, a draft is a duplicate when an ADD
 * already kept in that same batch (a) passes the subject test against it and (b) already carries
 * every specific value the draft carries. Condition (b) is the whole safety argument — a fact that
 * is the only home of some number, flag or file name is never dropped, whatever its wording looks
 * like. It says nothing about prose: a dropped duplicate loses its own phrasing, which is not a
 * value, so the report counts what each drop was made of.
 *
 * Three variants, because the bare rule is not the rule anyone should ship:
 *
 *   loose          the rule as stated, and the draft is never written
 *   conservative   additionally refuse a draft that names no value at all (that is a stated rule,
 *                  not a measurement), one grounded in the user's own turn, and one holding a
 *                  number or file name the value extractor failed to name
 *   retire         the conservative decision, but the fact is written and immediately superseded by
 *                  its survivor: the same current-space saving, the wording kept and still reachable
 *                  by query, per 6.18's rule that pressure retires rather than deletes
 *
 * What the report is careful about:
 *   - `shippedDuplicates` counts (chunk, value) pairs written into two or more current facts. That
 *     is a footprint, not a count of drafts the rule could act on: a footprint only becomes
 *     actionable when the drafts also pass the subject test and one carries nothing the other lacks.
 *   - merges aimed at a removed row. `applyOps` applies an UPDATE whose target is gone as an ADD
 *     that supersedes nothing, so those are counted — and counted again when the orphan restates a
 *     value the bank already held, which is the duplicate rebuilding itself one write later.
 *   - values that go dark, compared over the whole fold before and after, so a dedup that retires
 *     the last carrier of a value shows up even when nothing declared it.
 *   - runs with no corpus: the organic sessions have no declared values, so only the dark-value
 *     metric runs there, and the report says which numbers are missing rather than printing zeros.
 *   - a shipped `retire` would need the write to record the retirement. Folding a ledger that has
 *     no such record hands the duplicate back as current on reload — the hy.evict lesson (6.19).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { applyOps, foldLedger, newId } from "../src/bank.js";
import { sameSubject } from "../src/protocol.js";
import { type BankEntry, type Draft, estimateTokens, type LedgerRecord, type ReconcileOp } from "../src/types.js";
import { valueTokens } from "../src/values.js";
import { type CorpusChunk, carries } from "./restraint-report.js";

const RUNS_ROOT = "out";

export type DuplicateRow = {
	chunkId: string;
	/** Index of the draft the rule would remove. Its entry id is what a later UPDATE would target. */
	draft: number;
	/** Index of the draft that survives. */
	twinDraft: number;
	droppedStatement: string;
	twinStatement: string;
	/** Values the removed draft carries, all of them already held by the survivor. */
	sharedValues: string[];
	/** True when the removed draft named no specific value at all: what is lost is wording, not a value. */
	valueless: boolean;
	/** True when the removed draft was grounded in a user turn. */
	fromUser: boolean;
	/**
	 * Tokens a reader would call a value — a number, a file name, a flag — that `valueTokens` does
	 * not name and the survivor does not carry. The safety argument covers what the extractor names,
	 * and nothing else, so this is the rule's real exposure, counted rather than argued away.
	 */
	unprotected: string[];
};

/**
 * How much the rule requires before it acts.
 *
 * `loose` is the bare rule. `conservative` additionally requires the draft to name a value at all,
 * to not be grounded in the user's own turn, and to hold nothing the value extractor failed to
 * name. `retire` is the conservative decision applied by superseding the row instead of dropping it.
 */
export type DedupMode = "loose" | "conservative" | "retire";

export type RunDedup = {
	run: string;
	/** Which corpus covers this ledger, or null when none does: then declared-value numbers are unavailable, not zero. */
	corpus: string | null;
	chunks: number;
	adds: number;
	/** Drafts the rule acted on, with the surviving fact they duplicate. */
	duplicates: DuplicateRow[];
	/** Where the rule declines: a shared value but not one subject, or one subject but not every value. */
	declines: { sameValueOtherSubject: number; sameSubjectOtherValue: number };
	/** How the actions break down, since a drop is only as safe as what it removed. */
	dropShapes: { carriedValues: number; valueless: number; fromUser: number; unprotected: number };
	tokensSaved: number;
	/** UPDATEs whose target the rule removed, which `applyOps` applies as an orphan ADD. */
	orphanMerges: { chunkId: string; target: string }[];
	/** Orphan ADDs restating a value the bank already held: the duplicate rebuilt itself one write later. */
	orphansRestatingAHeldValue: number;
	/** Current facts after the rule ran, so a drop and a retire can be compared on one measure. */
	activeFacts: number;
	/** Only in `retire` mode: the superseded rows and whether each still points at its survivor. */
	retiredDuplicates: { statement: string; pointsTo: string | null }[];
	/** Specific values carried by some fact but by nothing current, as shipped and after the rule. */
	darkValuesShipped: number;
	darkValuesDeduped: number;
	/** Corpus-declared values that go dark. Only when a corpus covers the run. */
	declaredDarkShipped: string[];
	declaredDarkDeduped: string[];
	/**
	 * Values a chunk wrote into two or more *current* facts, as shipped. A footprint count, not a
	 * count of actionable drafts: a footprint needs the subject test and the value test to match too.
	 */
	shippedDuplicates: { chunkId: string; value: string; facts: number }[];
};

const surface = (row: { task: string; statement: string }) => `${row.task} ${row.statement}`.toLowerCase();
const specific = (row: { task: string; statement: string }) => valueTokens(surface(row));
/** Looser than `valueTokens`: anything a reader would call a value, named or not. */
const looseValues = (row: { task: string; statement: string }) =>
	new Set(surface(row).match(/\d[\d.,_]+|\d+|[a-z0-9_./-]+\.[a-z0-9]{1,5}\b|--[a-z0-9][a-z0-9_-]*/gi) ?? []);

function subset(a: Set<string>, b: Set<string>): boolean {
	for (const token of a) if (!b.has(token)) return false;
	return true;
}

function activeCarriers(bank: BankEntry[]): Set<string> {
	const out = new Set<string>();
	for (const entry of bank) if (entry.status === "active") for (const token of specific(entry)) out.add(token);
	return out;
}

function anyCarriers(bank: BankEntry[]): Set<string> {
	const out = new Set<string>();
	for (const entry of bank) for (const token of specific(entry)) out.add(token);
	return out;
}

function darkValues(bank: BankEntry[]): number {
	const current = activeCarriers(bank);
	let dark = 0;
	for (const token of anyCarriers(bank)) if (!current.has(token)) dark++;
	return dark;
}

/** The rule itself, over one chunk's op list: which ops survive and which drafts it acted on. */
export function dedupeBatch(
	drafts: Draft[],
	ops: ReconcileOp[],
	chunkId = "",
	mode: DedupMode = "loose",
): {
	kept: ReconcileOp[];
	dropped: DuplicateRow[];
	declines: { sameValueOtherSubject: number; sameSubjectOtherValue: number };
} {
	const kept: ReconcileOp[] = [];
	const dropped: DuplicateRow[] = [];
	const accepted: Draft[] = [];
	const declines = { sameValueOtherSubject: 0, sameSubjectOtherValue: 0 };

	for (const op of ops) {
		if (op.action !== "ADD") {
			kept.push(op);
			continue;
		}
		const draft = drafts[op.draft];
		if (!draft) {
			kept.push(op);
			continue;
		}
		const values = specific(draft);
		const twin = accepted.find((a) => sameSubject(draft, a).ok && subset(values, specific(a)));
		if (twin) {
			const unprotected = [...looseValues(draft)].filter((token) => !looseValues(twin).has(token)).sort();
			// A draft that states a rule rather than a measurement, states the user's own constraint,
			// or holds a value the extractor never named is not proven redundant, so the conservative
			// rule keeps it and says why.
			if (mode !== "loose" && (values.size === 0 || draft.fromUser === true || unprotected.length > 0)) {
				declines.sameSubjectOtherValue++;
				accepted.push(draft);
				kept.push(op);
				continue;
			}
			dropped.push({
				chunkId,
				draft: op.draft,
				twinDraft: accepted.indexOf(twin),
				droppedStatement: draft.statement,
				twinStatement: twin.statement,
				sharedValues: [...values].sort(),
				valueless: values.size === 0,
				fromUser: draft.fromUser === true,
				unprotected,
			});
			continue;
		}
		for (const a of accepted) {
			const verdict = sameSubject(draft, a);
			const sharesValue = [...values].some((token) => specific(a).has(token));
			if (sharesValue && !verdict.ok) declines.sameValueOtherSubject++;
			if (verdict.ok && !subset(values, specific(a))) declines.sameSubjectOtherValue++;
		}
		accepted.push(draft);
		kept.push(op);
	}
	return { kept, dropped, declines };
}

function pairs(records: LedgerRecord[]): { ops: Extract<LedgerRecord, { type: "hy.ops" }>; drafts: Draft[] }[] {
	const out: { ops: Extract<LedgerRecord, { type: "hy.ops" }>; drafts: Draft[] }[] = [];
	let pending: { chunkId: string; drafts: Draft[] } | undefined;
	for (const record of records) {
		if (record.type === "hy.gap" || record.type === "hy.evict") continue;
		if (record.type === "hy.extract") {
			pending = { chunkId: record.chunkId, drafts: record.drafts };
			continue;
		}
		if (record.type !== "hy.ops") continue;
		out.push({ ops: record, drafts: pending?.chunkId === record.chunkId ? pending.drafts : [] });
	}
	return out;
}

export function analyseDedup(
	runId: string,
	records: LedgerRecord[],
	chunks: CorpusChunk[] | null,
	corpusLabel: string | null = null,
	mode: DedupMode = "loose",
): RunDedup {
	const writes = pairs(records);
	const bank: BankEntry[] = [];
	const droppedIds = new Set<string>();
	const duplicates: DuplicateRow[] = [];
	const orphanMerges: { chunkId: string; target: string }[] = [];
	let orphansRestating = 0;
	const declines = { sameValueOtherSubject: 0, sameSubjectOtherValue: 0 };
	const dropShapes = { carriedValues: 0, valueless: 0, fromUser: 0, unprotected: 0 };
	let adds = 0;
	let tokensSaved = 0;
	let chunkSeq = 0;

	for (const { ops: record, drafts } of writes) {
		chunkSeq++;
		adds += record.ops.filter((op) => op.action === "ADD").length;
		const {
			kept,
			dropped,
			declines: local,
		} = dedupeBatch(drafts, record.ops, record.chunkId, mode === "retire" ? "conservative" : mode);
		declines.sameValueOtherSubject += local.sameValueOtherSubject;
		declines.sameSubjectOtherValue += local.sameSubjectOtherValue;
		for (const row of dropped) {
			if (row.valueless) dropShapes.valueless++;
			else dropShapes.carriedValues++;
			if (row.fromUser) dropShapes.fromUser++;
			if (row.unprotected.length > 0) dropShapes.unprotected++;
			droppedIds.add(newId(`${record.chunkId}:${row.draft}:ADD`));
			const written = bank.find((e) => e.id === newId(`${record.chunkId}:${row.draft}:ADD`));
			tokensSaved += written ? written.tokenCount : estimateTokens(row.droppedStatement);
			duplicates.push(row);
		}
		for (const op of kept) {
			if (op.action !== "UPDATE" || !droppedIds.has(op.target)) continue;
			orphanMerges.push({ chunkId: record.chunkId, target: op.target });
			// `applyOps` applies an UPDATE whose target is gone as an ADD that supersedes nothing. If
			// that draft carries a value the bank already holds, the duplicate has just rebuilt itself.
			const draft = drafts[op.draft];
			if (!draft) continue;
			const holders = activeCarriers(bank);
			if ([...specific(draft)].some((token) => holders.has(token))) orphansRestating++;
		}
		// `retire` writes every op and then supersedes the duplicate: the fact stays in the store and
		// stays reachable by query (6.18's rule — pressure retires, it never deletes), while the bank
		// stops offering it current. The drop modes never write it at all.
		applyOps(bank, drafts, mode === "retire" ? record.ops : kept, record.chunkId, [], record.createdAt, chunkSeq);
		if (mode === "retire") {
			for (const row of dropped) {
				const entry = bank.find((e) => e.id === newId(`${record.chunkId}:${row.draft}:ADD`));
				const twin = bank.find((e) => e.id === newId(`${record.chunkId}:${row.twinDraft}:ADD`));
				if (!entry || !twin) continue;
				entry.status = "superseded";
				entry.supersedeReason = "duplicate within the same write";
				entry.supersededBy = twin.id;
			}
		}
	}

	const shipped = foldLedger(records);
	const probes = (chunks ?? []).flatMap((c) => c.probes ?? []);
	const declaredDark = (target: BankEntry[]) =>
		probes.filter(
			(value) =>
				target.some((e) => carries(value, surface(e))) &&
				!target.some((e) => e.status === "active" && carries(value, surface(e))),
		);

	const shippedDuplicates: RunDedup["shippedDuplicates"] = [];
	const byChunk = new Map<string, BankEntry[]>();
	for (const entry of shipped) {
		if (entry.status !== "active") continue;
		const list = byChunk.get(entry.chunkId) ?? [];
		list.push(entry);
		byChunk.set(entry.chunkId, list);
	}
	for (const [chunkId, list] of byChunk) {
		if (list.length < 2) continue;
		for (const value of new Set(list.flatMap((e) => [...specific(e)]))) {
			const facts = list.filter((e) => specific(e).has(value)).length;
			if (facts > 1) shippedDuplicates.push({ chunkId, value, facts });
		}
	}

	return {
		run: `${runId} [${mode}]`,
		corpus: chunks ? corpusLabel : null,
		chunks: writes.length,
		adds,
		duplicates,
		declines,
		dropShapes,
		tokensSaved,
		orphanMerges,
		orphansRestatingAHeldValue: orphansRestating,
		activeFacts: bank.filter((e) => e.status === "active").length,
		retiredDuplicates: bank
			.filter((e) => e.supersedeReason === "duplicate within the same write")
			.map((e) => ({ statement: e.statement, pointsTo: e.supersededBy ?? null })),
		darkValuesShipped: darkValues(shipped),
		darkValuesDeduped: darkValues(bank),
		declaredDarkShipped: chunks ? declaredDark(shipped) : [],
		declaredDarkDeduped: chunks ? declaredDark(bank) : [],
		shippedDuplicates,
	};
}

function corpusFor(records: LedgerRecord[]): { chunks: CorpusChunk[]; label: string } | null {
	const ids = records.filter((r) => r.type === "hy.extract").map((r) => r.chunkId);
	if (ids.length === 0) return null;
	for (const file of readdirSync("dev").filter((f) => f.startsWith("corpus-") && f.endsWith(".json"))) {
		const chunks = (JSON.parse(readFileSync(`dev/${file}`, "utf8")).chunks ?? []) as CorpusChunk[];
		const chunkIds = new Set(chunks.map((c) => c.chunkId));
		if (ids.every((id) => chunkIds.has(id))) return { chunks, label: `dev/${file}` };
	}
	return null;
}

function loadLedger(runId: string): LedgerRecord[] {
	return readFileSync(`${RUNS_ROOT}/${runId}/ledger.jsonl`, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as LedgerRecord);
}

function discoverRuns(): string[] {
	if (!existsSync(RUNS_ROOT)) return [];
	return readdirSync(RUNS_ROOT, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(`${RUNS_ROOT}/${d.name}/ledger.jsonl`))
		.map((d) => d.name)
		.sort();
}

function print(run: RunDedup): void {
	console.log(
		`${run.run}: ${run.chunks} writes, ${run.adds} ADDs; acted on ${run.duplicates.length} duplicate ADD(s), saving ~${run.tokensSaved} tokens`,
	);
	console.log(
		`   what it acted on: ${run.dropShapes.carriedValues} carried only values the survivor already held, ${run.dropShapes.valueless} named no specific value at all (wording lost, no value), ${run.dropShapes.fromUser} were the user's own words, ${run.dropShapes.unprotected} held a number, file name or flag the value extractor does not name`,
	);
	console.log(
		`   declined: ${run.declines.sameValueOtherSubject} share a value but not a subject, ${run.declines.sameSubjectOtherValue} share a subject but not every value`,
	);
	console.log(
		`   later merges aimed at a removed row ${run.orphanMerges.length} (applyOps applies those as an orphan ADD), of which ${run.orphansRestatingAHeldValue} restated a value the bank still held; values dark as shipped ${run.darkValuesShipped}, after the rule ${run.darkValuesDeduped}`,
	);
	if (run.corpus === null) {
		console.log(`   no corpus covers this ledger: declared-value numbers are not available here, not zero`);
	} else {
		console.log(
			`   corpus-declared values dark: as shipped ${run.declaredDarkShipped.length}, after the rule ${run.declaredDarkDeduped.length}${run.declaredDarkDeduped.length > 0 ? ` (${run.declaredDarkDeduped.join(", ")})` : ""}`,
		);
	}
	console.log(
		`   footprints as shipped: ${run.shippedDuplicates.length} value(s) written into two or more current facts by one chunk, ${run.activeFacts} current facts after the rule`,
	);
	for (const row of run.duplicates.slice(0, 3)) {
		console.log(`     removed: ${row.droppedStatement.slice(0, 90)}`);
		console.log(`     twin of: ${row.twinStatement.slice(0, 90)}`);
	}
}

type Totals = ReturnType<typeof totals>;
function totals(list: RunDedup[]) {
	const sum = (pick: (run: RunDedup) => number) => list.reduce((n, run) => n + pick(run), 0);
	return {
		runs: list.length,
		dropped: sum((r) => r.duplicates.length),
		tokens: sum((r) => r.tokensSaved),
		carried: sum((r) => r.dropShapes.carriedValues),
		valueless: sum((r) => r.dropShapes.valueless),
		fromUser: sum((r) => r.dropShapes.fromUser),
		unprotected: sum((r) => r.dropShapes.unprotected),
		orphans: sum((r) => r.orphanMerges.length),
		orphansRestating: sum((r) => r.orphansRestatingAHeldValue),
		dark: sum((r) => r.darkValuesDeduped),
		darkShipped: sum((r) => r.darkValuesShipped),
		declaredDark: sum((r) => r.declaredDarkDeduped.length),
		declaredDarkShipped: sum((r) => r.declaredDarkShipped.length),
		declinedValue: sum((r) => r.declines.sameValueOtherSubject),
		declinedSubject: sum((r) => r.declines.sameSubjectOtherValue),
		footprints: sum((r) => r.shippedDuplicates.length),
	};
}

function line(label: string, t: Totals): string {
	return `   ${label}: acted on ${t.dropped} ADDs (~${t.tokens} tokens), of which ${t.valueless} named no value, ${t.fromUser} were the user's own words, ${t.unprotected} held something the extractor never named; ${t.orphans} later merges orphaned, ${t.orphansRestating} of them restating a held value; dark ${t.dark}/${t.declaredDark}`;
}

function main(): void {
	const args = process.argv.slice(2);
	const requested: string[] = [];
	args.forEach((value, index) => {
		if (value === "--run") requested.push(args[index + 1]);
	});
	const discovered = discoverRuns();
	const runs =
		requested.length > 0
			? requested
			: args.includes("--all")
				? discovered
				: discovered.filter((r) => r.startsWith("restraint") || r === "r5-off" || r === "r5-on");
	if (runs.length === 0) {
		console.error("no runs found under out/");
		process.exit(2);
	}

	const ledgers = runs.map((runId) => {
		const records = loadLedger(runId);
		return { runId, records, corpus: corpusFor(records) };
	});
	const analyse = (mode: DedupMode) =>
		ledgers.map((ledger) =>
			analyseDedup(
				ledger.runId,
				ledger.records,
				ledger.corpus?.chunks ?? null,
				ledger.corpus?.label ?? null,
				mode,
			),
		);
	const loose = analyse("loose");
	const conservative = analyse("conservative");
	const retire = analyse("retire");
	const a = totals(loose);
	const b = totals(conservative);
	const c = totals(retire);

	for (const analysis of conservative) print(analysis);

	console.log(`\n== ${a.runs} ledgers, three variants of the rule`);
	console.log(
		`   as shipped: ${a.footprints} (chunk, value) footprints — one chunk wrote that value into two or more current facts; ${a.darkShipped} specific values dark, ${a.declaredDarkShipped} of them corpus-declared`,
	);
	console.log(line("loose drop", a));
	console.log(line("conservative drop", b));
	console.log(
		`   conservative retire: acted on ${c.dropped} ADDs, freeing ~${c.tokens} current tokens while keeping the wording reachable by query; ${c.orphans} later merges aimed at a retired row, ${c.orphansRestating} of them restating a held value`,
	);
	console.log(
		`   the rule declines either way: ${a.declinedValue} share a value but not a subject, ${a.declinedSubject} share a subject but not every value`,
	);
	console.log(
		`   folding cannot replay a retirement — a ledger that recorded none hands the duplicate back as current, so a shipped retire must record it (6.19's lesson)`,
	);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
