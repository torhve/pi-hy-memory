/**
 * What every accepted UPDATE in this project actually did to the entry it replaced.
 *
 * The subject guard (sameSubject in src/protocol.ts) decides whether an UPDATE may overwrite
 * an entry by comparing wording. It was built against one measured failure — a fact about a
 * set of containers overwritten by a fact about one container — and every published run shows
 * it refusing a lot: 29 attempted UPDATEs were downgraded to ADD across the six restraint runs.
 * What had never been measured is the other side: of the UPDATEs the guard *let through*, how
 * many dropped a value their target carried, and what the refusals cost instead.
 *
 * hy-r3-to-01 (restraint3-actor) is why this exists. The arm's best fact in the corpus — flag,
 * behaviour and line coordinate intact — was merged away one chunk later because the incoming
 * draft shared a subject with it. The guard passed the merge on 4 of the target's 10 subject
 * tokens, and the six tokens it missed were the ones that made the entry about the flag. That
 * was read out of a ledger by hand. This is the same reading, done for every UPDATE in every
 * run, with no model call.
 *
 * Measures, all deterministic:
 *
 *  - specifics carried: tokens that hold a value rather than wording — numbers, flags, paths,
 *    dotted file names, underscored identifiers. An UPDATE that drops one narrowed something
 *    its target said. Works on every corpus, labelled or not.
 *  - declared values: where the corpus declares which tokens a chunk's tool output must keep
 *    (dev/corpus-restraint2.json, dev/corpus-restraint3.json), the same question against the
 *    corpus's own answer instead of a token shape.
 *  - which guard clause passed the merge: the strict one (the draft restates half the target's
 *    vocabulary) or the loose one (>= 3 shared specific tokens and a sixth of the wording).
 *  - what a refusal cost: a refused UPDATE is recorded as ADD, so both facts stay active. If
 *    the target carried a declared value, the refusal is only safe if that value was not worth
 *    merging — otherwise the bank now holds two facts covering it.
 *
 * And the question 7.14 left open, for the chunks that declare values: when several drafts in
 * one chunk carry the same declared value, does reconcile merge them, keep both, or refuse?
 *
 * Nothing here is a gate. Reported numbers, pinned by tools/merge-report-check.ts.
 *
 *   npx tsx dev/merge-report.ts                       # the restraint runs under out/
 *   npx tsx dev/merge-report.ts --run restraint3-actor
 *   npx tsx dev/merge-report.ts --all                 # every ledger under out/
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { foldLedger } from "../src/bank.js";
import { sameSubject } from "../src/protocol.js";
import type { BankEntry, Draft, LedgerRecord, ReconcileOp } from "../src/types.js";
import { type CorpusChunk, carries } from "./restraint-report.js";

const RUNS_ROOT = "out";
const SPECIFIC = /(-{1,2}[a-z0-9][a-z0-9._/+-]*|[a-z0-9][a-z0-9._/+-]{1,})/g;

/**
 * A token that holds a value instead of wording: a number, a flag, a dotted file name, a path,
 * or an underscored identifier. Wording tokens ("queue", "entries", "seconds") are deliberately
 * excluded — the guard already reads those, and the point of this measurement is what the guard
 * does not read.
 */
export function specificTokens(text: string): Set<string> {
	const out = new Set<string>();
	for (const raw of text.toLowerCase().match(SPECIFIC) ?? []) {
		const token = raw.replace(/[.,:]+$/, "");
		if (token.length < 2) continue;
		const isNumber = /\d/.test(token);
		const isFlag = token.startsWith("--");
		const isFile = /^[a-z0-9_-]+\.[a-z0-9.]+$/.test(token);
		const isPath = token.includes("/") && token.length > 3;
		const isIdentifier = token.includes("_") && token.length >= 5;
		if (isNumber || isFlag || isFile || isPath || isIdentifier) out.add(token);
	}
	return out;
}

/**
 * Which clause in sameSubject let an UPDATE through. Two ways to pass: the draft restates half
 * the target's vocabulary, or it shares at least three specific tokens and a sixth of the target's
 * wording. The second is the loose one, and it decides the cases this report is about.
 */
export function passClause(shared: number, targetSize: number): string {
	if (targetSize === 0) return "target had no vocabulary to compare";
	const ratio = shared / targetSize;
	if (ratio >= 0.5) return "restated half the target's wording";
	if (shared >= 3 && ratio >= 0.15) return "shared 3+ tokens, under half the wording";
	return "no clause should have passed it";
}

export interface MergeRow {
	run: string;
	chunkId: string;
	targetChunk: string;
	targetTask: string;
	targetStatement: string;
	replacementTask: string;
	replacementStatement: string;
	reason: string;
	/** sameSubject recomputed for the executed op, so the guard's own numbers are on the row. */
	shared: number;
	targetSize: number;
	passedBy: string;
	dropped: string[];
	added: string[];
	declaredDropped: string[];
	/** declared values the corpus says the target carried, whether or not the merge kept them. */
	declaredKept: string[];
}

export interface DowngradeRow {
	run: string;
	chunkId: string;
	targetChunk: string;
	targetTask: string;
	reason: string;
	shared: number;
	targetSize: number;
	/** declared values the refused target carried, and how many active facts carried them after. */
	targetDeclared: string[];
	/** active facts carrying one of those values after this chunk: >= 2 means the refusal kept both. */
	carriersAfter: number;
	/** ledger numbers vs sameSubject recomputed here, as a check on the instrument. */
	recomputedMatch: boolean | null;
}

export interface SameValueRow {
	chunkId: string;
	value: string;
	drafts: number;
	ops: string[];
	/** active facts authored by this chunk carrying that value after the chunk ran. */
	activeAfter: number;
}

export interface RunAnalysis {
	run: string;
	corpus: string;
	chunks: number;
	executed: MergeRow[];
	downgrades: DowngradeRow[];
	sameValue: SameValueRow[];
	/** declared values none of this chunk's drafts carried into the bank. */
	neverBanked: { chunkId: string; value: string }[];
	/** drafts reconcile dropped outright — the only way it can remove a duplicate. */
	skipOps: number;
}

export function textOf(entry: { task: string; statement: string; keys?: string[] }): string {
	return `${entry.task} ${entry.statement} ${(entry.keys ?? []).join(" ")}`;
}

export function loadLedger(runId: string): LedgerRecord[] {
	return readFileSync(`${RUNS_ROOT}/${runId}/ledger.jsonl`, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as LedgerRecord);
}

export function resolveCorpus(runId: string, explicit: string | undefined): { path: string; chunks: CorpusChunk[] } {
	const candidates = explicit
		? [explicit]
		: runId.startsWith("restraint3")
			? ["dev/corpus-restraint3.json", "dev/corpus-restraint2.json", "dev/corpus-restraint.json"]
			: runId.startsWith("restraint2")
				? ["dev/corpus-restraint2.json", "dev/corpus-restraint.json"]
				: ["dev/corpus-restraint.json", "dev/corpus-restraint2.json"];
	const ledgerIds = loadLedger(runId)
		.filter((r) => r.type === "hy.extract")
		.map((r) => (r as { chunkId: string }).chunkId);
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		const chunks = (JSON.parse(readFileSync(path, "utf8")).chunks ?? []) as CorpusChunk[];
		const ids = new Set(chunks.map((c) => c.chunkId));
		if (ledgerIds.length > 0 && ledgerIds.every((id) => ids.has(id))) return { path, chunks };
	}
	throw new Error(`${runId}: no corpus under dev/ covers its ledger — pass --corpus`);
}

export function analyseRun(runId: string, corpusPath?: string): RunAnalysis {
	const records = loadLedger(runId);
	const { path, chunks } = resolveCorpus(runId, corpusPath);
	return analyseRecords(runId, records, chunks, path);
}

/**
 * The same reading on records and chunks handed in directly, which is what
 * tools/merge-report-check.ts uses: a ledger whose correct answer is known by construction.
 */
export function analyseRecords(
	runId: string,
	records: LedgerRecord[],
	chunks: CorpusChunk[],
	corpusLabel: string,
): RunAnalysis {
	const finalBank = foldLedger(records);
	const byId = new Map(finalBank.map((e) => [e.id, e]));
	const chunkById = new Map(chunks.map((c) => [c.chunkId, c]));

	// Pair each ops record with the extract record that precedes it, the same way foldLedger
	// does, and snapshot the bank as it stood after each chunk.
	const draftsByOpsIndex = new Map<number, Draft[]>();
	const activeAfterIndex = new Map<number, BankEntry[]>();
	let pending: { chunkId: string; drafts: Draft[] } | undefined;
	records.forEach((record, index) => {
		if (record.type === "hy.gap") return;
		if (record.type === "hy.extract") {
			pending = { chunkId: record.chunkId, drafts: record.drafts };
			return;
		}
		draftsByOpsIndex.set(index, pending?.chunkId === record.chunkId ? pending.drafts : []);
		activeAfterIndex.set(
			index,
			foldLedger(records.slice(0, index + 1)).filter((e) => e.status === "active"),
		);
	});

	const executed: MergeRow[] = [];
	let skipOps = 0;
	const downgrades: DowngradeRow[] = [];
	const sameValue: SameValueRow[] = [];
	const neverBanked: { chunkId: string; value: string }[] = [];

	records.forEach((record, index) => {
		if (record.type !== "hy.ops") return;
		const drafts = draftsByOpsIndex.get(index) ?? [];
		const activeAfter = activeAfterIndex.get(index) ?? [];

		for (const op of record.ops) {
			const draft = op.action === "DELETE" ? undefined : drafts[op.draft];

			if (op.action === "UPDATE" && draft) {
				const target = op.target ? byId.get(op.target) : undefined;
				if (!target) continue;
				const verdict = sameSubject(draft, target);
				const before = specificTokens(textOf(target));
				const after = specificTokens(textOf(draft));
				const declared = chunkById.get(target.chunkId)?.probes ?? [];
				executed.push({
					run: runId,
					chunkId: record.chunkId,
					targetChunk: target.chunkId,
					targetTask: target.task,
					targetStatement: target.statement,
					replacementTask: draft.task,
					replacementStatement: draft.statement,
					reason: target.supersedeReason ?? "",
					shared: verdict.shared,
					targetSize: verdict.targetSize,
					passedBy: passClause(verdict.shared, verdict.targetSize),
					dropped: [...before].filter((token) => !after.has(token)),
					added: [...after].filter((token) => !before.has(token)),
					declaredDropped: declared.filter((v) => carries(v, textOf(target)) && !carries(v, textOf(draft))),
					declaredKept: declared.filter((v) => carries(v, textOf(target)) && carries(v, textOf(draft))),
				});
			}
		}

		skipOps += record.ops.filter((op) => op.action === "SKIP").length;

		for (const downgraded of record.downgradedOps ?? []) {
			const draft = downgraded.draft !== undefined ? drafts[downgraded.draft] : undefined;
			const target = downgraded.target ? byId.get(downgraded.target) : undefined;
			const recorded = /(\d+)\/(\d+) shared/.exec(downgraded.reason);
			const verdict = draft && target ? sameSubject(draft, target) : undefined;
			const declared = target ? (chunkById.get(target.chunkId)?.probes ?? []) : [];
			const targetDeclared = declared.filter((v) => carries(v, textOf(target ?? { task: "", statement: "" })));
			downgrades.push({
				run: runId,
				chunkId: record.chunkId,
				targetChunk: target?.chunkId ?? "(target not in bank)",
				targetTask: target?.task ?? downgraded.reason,
				reason: /does not restate its subject/.test(downgraded.reason)
					? "subject guard refused it"
					: /not retrieved/.test(downgraded.reason)
						? "target was never shown for this draft"
						: "target already replaced in this batch",
				shared: recorded ? Number(recorded[1]) : (verdict?.shared ?? 0),
				targetSize: recorded ? Number(recorded[2]) : (verdict?.targetSize ?? 0),
				targetDeclared,
				carriersAfter: targetDeclared.length
					? activeAfter.filter((entry) => targetDeclared.some((v) => carries(v, textOf(entry)))).length
					: 0,
				recomputedMatch:
					recorded && verdict
						? recorded[1] === String(verdict.shared) && recorded[2] === String(verdict.targetSize)
						: null,
			});
		}
	});

	// 7.14's open question, per chunk: several drafts carrying one declared value.
	const opsIndexByChunk = new Map<string, number>();
	records.forEach((record, index) => {
		if (record.type === "hy.ops") opsIndexByChunk.set(record.chunkId, index);
	});
	for (const chunk of chunks) {
		const probes = chunk.probes ?? [];
		if (probes.length === 0) continue;
		const opsIndex = opsIndexByChunk.get(chunk.chunkId);
		const drafts = opsIndex === undefined ? [] : (draftsByOpsIndex.get(opsIndex) ?? []);
		const ops = opsIndex === undefined ? [] : ((records[opsIndex] as { ops: ReconcileOp[] }).ops ?? []);
		const activeAfter = opsIndex === undefined ? [] : (activeAfterIndex.get(opsIndex) ?? []);

		for (const value of probes) {
			const carriers = drafts
				.map((draft, draftIndex) => ({ draft, draftIndex }))
				.filter(({ draft }) => carries(value, textOf(draft)));
			const inBank = activeAfter.filter((e) => e.chunkId === chunk.chunkId && carries(value, textOf(e))).length;
			if (inBank === 0) neverBanked.push({ chunkId: chunk.chunkId, value });
			if (carriers.length < 2) continue;
			sameValue.push({
				chunkId: chunk.chunkId,
				value,
				drafts: carriers.length,
				ops: carriers.map(({ draftIndex }) => {
					const op = ops.find((o) => "draft" in o && o.draft === draftIndex);
					return op ? op.action : "omitted";
				}),
				activeAfter: inBank,
			});
		}
	}

	return {
		run: runId,
		corpus: corpusLabel,
		chunks: records.filter((r) => r.type === "hy.extract").length,
		executed,
		downgrades,
		sameValue,
		neverBanked,
		skipOps,
	};
}

function pad(value: string, width: number): string {
	return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function pct(n: number, d: number): string {
	return d === 0 ? "-" : `${((n / d) * 100).toFixed(0)}%`.padStart(3);
}

function reportRun(a: RunAnalysis): void {
	const dropping = a.executed.filter((row) => row.dropped.length > 0);
	const declaredLoss = a.executed.filter((row) => row.declaredDropped.length > 0);
	console.log(`\n== ${a.run} (${a.corpus}, ${a.chunks} chunks, replayed from its ledger)`);
	console.log(
		`   UPDATEs executed ${a.executed.length}; refused and recorded as ADD ${a.downgrades.length}; drafts dropped outright ${a.skipOps};` +
			` executed UPDATEs that dropped a value their target carried ${dropping.length}/${a.executed.length} ${pct(dropping.length, a.executed.length)}`,
	);
	if (a.executed.length > 0) {
		const byClause = new Map<string, { passed: number; dropped: number; declared: number }>();
		for (const row of a.executed) {
			const cell = byClause.get(row.passedBy) ?? { passed: 0, dropped: 0, declared: 0 };
			cell.passed += 1;
			if (row.dropped.length > 0) cell.dropped += 1;
			cell.declared += row.declaredDropped.length;
			byClause.set(row.passedBy, cell);
		}
		for (const [clause, cell] of [...byClause].sort((x, y) => y[1].passed - x[1].passed)) {
			console.log(
				`     ${pad(clause, 42)} ${pad(`${cell.passed} merge(s)`, 12)}` +
					`${cell.dropped} dropped a value${cell.declared ? `, ${cell.declared} corpus-declared value(s) lost` : ""}`,
			);
		}
	}
	if (dropping.length > 0) {
		console.log("   what each merge dropped:");
		for (const row of dropping) {
			console.log(
				`     ${pad(row.chunkId, 15)}<- ${pad(row.targetChunk, 15)} dropped ${row.dropped.join(", ")}` +
					`${row.added.length ? `   added ${row.added.join(", ")}` : ""}`,
			);
			console.log(
				`     ${" ".repeat(30)}passed the guard at ${row.shared}/${row.targetSize} shared via ${row.passedBy}` +
					`   reason: ${(row.reason || "(none)").slice(0, 60)}`,
			);
			if (row.declaredDropped.length > 0) {
				console.log(`     ${" ".repeat(30)}corpus-declared values lost: ${row.declaredDropped.join(", ")}`);
			}
		}
	}
	if (a.downgrades.length > 0) {
		const byReason = new Map<string, number>();
		for (const row of a.downgrades) byReason.set(row.reason, (byReason.get(row.reason) ?? 0) + 1);
		const withDeclared = a.downgrades.filter((row) => row.targetDeclared.length > 0);
		const bothKept = withDeclared.filter((row) => row.carriersAfter >= 2);
		console.log(
			`   refusals: ${a.downgrades.length}` + ` (${[...byReason].map(([why, n]) => `${n} ${why}`).join(", ")})`,
		);
		console.log(
			`     of those, ${withDeclared.length} refused a target carrying a corpus-declared value;` +
				` ${bothKept.length} of those left two or more active facts covering that value`,
		);
		for (const row of a.downgrades) {
			const cost = row.targetDeclared.length
				? `   value ${row.targetDeclared.join("/")} now carried by ${row.carriersAfter} active fact(s)`
				: "";
			console.log(
				`     ${pad(row.chunkId, 15)}<- ${pad(row.targetChunk, 15)} refused at ${row.shared}/${row.targetSize} shared` +
					`   target: ${row.targetTask.slice(0, 40)}${cost}`,
			);
		}
	}
	if (a.sameValue.length > 0) {
		const merged = a.sameValue.filter((row) => row.activeAfter <= 1).length;
		console.log(
			`   one declared value carried by several drafts in the same chunk: ${a.sameValue.length} case(s),` +
				` merged down to one active fact ${merged} time(s)`,
		);
		for (const row of a.sameValue) {
			console.log(
				`     ${pad(row.chunkId, 15)}${pad(row.value, 23)} drafts ${row.drafts}  ops ${row.ops.join("/")}  active facts from this chunk after the write ${row.activeAfter}`,
			);
		}
	}
	if (a.neverBanked.length > 0) {
		console.log(
			`   declared values none of this chunk's drafts carried: ${a.neverBanked.map((n) => `${n.chunkId} ${n.value}`).join(", ")}`,
		);
	}
	if (declaredLoss.length > 0) {
		const kept = a.executed.reduce((n, row) => n + row.declaredKept.length, 0);
		const lost = declaredLoss.reduce((n, row) => n + row.declaredDropped.length, 0);
		console.log(`   at the merge gate the corpus-declared values came out ${kept} kept / ${lost} lost`);
	}
}

function main(): void {
	const args = process.argv.slice(2);
	const arg = (name: string, fallback = ""): string => {
		const i = args.indexOf(name);
		return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
	};
	const explicit = arg("--corpus") || undefined;
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
				: discovered.filter((r) => r.startsWith("restraint"));
	if (runs.length === 0) {
		console.error("no runs found under out/");
		process.exit(2);
	}

	const analyses: RunAnalysis[] = [];
	const skipped: string[] = [];
	for (const run of runs) {
		try {
			analyses.push(analyseRun(run, explicit));
		} catch (error) {
			skipped.push(`${run} (${(error as Error).message})`);
		}
	}
	if (skipped.length > 0) console.log(`skipped, no dev/ corpus covers the ledger: ${skipped.join(", ")}`);
	for (const analysis of analyses) reportRun(analysis);

	const all = analyses.flatMap((a) => a.executed);
	const allDropping = all.filter((row) => row.dropped.length > 0);
	const refused = analyses.reduce((n, a) => n + a.downgrades.length, 0);
	console.log(`\n== ${analyses.length} runs together`);
	console.log(
		`   UPDATEs executed ${all.length}; refused and recorded as ADD ${refused};` +
			` executed UPDATEs that dropped a value ${allDropping.length} (${pct(allDropping.length, all.length)})`,
	);
	console.log(
		`   values dropped at a merge ${allDropping.reduce((n, r) => n + r.dropped.length, 0)}, of which corpus-declared` +
			` ${allDropping.reduce((n, r) => n + r.declaredDropped.length, 0)}`,
	);

	const byClause = new Map<string, { passed: number; dropped: number; declared: number }>();
	for (const row of all) {
		const cell = byClause.get(row.passedBy) ?? { passed: 0, dropped: 0, declared: 0 };
		cell.passed += 1;
		if (row.dropped.length > 0) cell.dropped += 1;
		cell.declared += row.declaredDropped.length;
		byClause.set(row.passedBy, cell);
	}
	console.log("   which clause in the guard let each merge through, and what it cost:");
	for (const [clause, cell] of [...byClause].sort((x, y) => y[1].passed - x[1].passed)) {
		console.log(
			`     ${pad(clause, 42)} ${pad(`${cell.passed} merge(s)`, 12)}${cell.dropped} dropped a value` +
				` (${pct(cell.dropped, cell.passed)}), ${cell.declared} corpus-declared value(s) lost`,
		);
	}

	const ratio = (row: MergeRow): number => row.shared / Math.max(row.targetSize, 1);
	const tightened = all.filter((row) => !(ratio(row) >= 0.5 || (row.shared >= 4 && ratio(row) >= 0.25)));
	const tightenedDropping = tightened.filter((row) => row.dropped.length > 0);
	console.log(
		`   counterfactual on these ledgers: tighten the loose clause to 4 shared tokens and a quarter of the` +
			` target's wording and ${tightened.length} of these ${all.length} merges get refused instead —` +
			` ${tightenedDropping.length} of them merges that would have dropped a value (the gain),` +
			` ${tightened.length - tightenedDropping.length} that dropped nothing (the cost: a kept duplicate instead)`,
	);

	const withDeclared = analyses.flatMap((a) => a.downgrades).filter((row) => row.targetDeclared.length > 0);
	const bothKept = withDeclared.filter((row) => row.carriersAfter >= 2);
	console.log(
		`   refusals that cost something: ${withDeclared.length} refused a target carrying a corpus-declared value,` +
			` ${bothKept.length} left two or more active facts covering it`,
	);

	const sameValue = analyses.flatMap((a) => a.sameValue);
	const merged = sameValue.filter((row) => row.activeAfter <= 1).length;
	console.log(
		`   same declared value carried by several drafts in one chunk: ${sameValue.length} case(s), merged down to one` +
			` fact ${merged} time(s)`,
	);
	console.log(
		"   reported, not gated: a dropped value is not automatically a mistake — the corpus says which values a tool" +
			" output states, not which ones a later chunk may retire.",
	);
}

function discoverRuns(): string[] {
	if (!existsSync(RUNS_ROOT)) return [];
	return readdirSync(RUNS_ROOT, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(`${RUNS_ROOT}/${d.name}/ledger.jsonl`))
		.map((d) => d.name)
		.sort();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
