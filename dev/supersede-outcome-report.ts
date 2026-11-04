#!/usr/bin/env npx tsx

/**
 * dev/supersede-outcome-report.ts — judge a supersession run against its corpus, not against a judge.
 *
 * A supersession corpus declares its own right answer. Each chunk states the facts a correct writer should hold,
 * marks a statement stale when it records a superseded number rather than asserting a current one, and the run
 * must end with the newest count of each mode active exactly once and every superseded count retired. This walks
 * a run's ledger chunk by chunk and answers the two questions a summary metric cannot:
 *
 *   - Which entry did each UPDATE aim at? An UPDATE that landed on an older count of the same mode, on the other
 *     mode's claim, or on an entry holding no count at all is a wrong target even when the bank ends tidy.
 *   - What did the bank end with? Every superseded count retired, each current count held once, and the two
 *     counts kept apart — the corpus says the offline run and the LAN run are separate facts. A superseded number
 *     in an active entry counts against the run only when that entry asserts it as the current count: the corpus
 *     also carries records — a log file, a changelog line, a hard-coded CI line — which keep quoting old numbers
 *     on purpose, and the entry's own chunk carries the stale mark that tells the two apart.
 *
 *   npx tsx dev/supersede-outcome-report.ts <runId> [<runId> ...] [--corpus dev/corpus-supersede2.json]
 */
import { existsSync, readFileSync } from "node:fs";
import { foldLedger } from "../src/bank.js";
import type { BankEntry, Draft, LedgerRecord, ReconcileOp } from "../src/types.js";
import { type SuiteClaim, suiteClaims } from "./suite-claim.js";

type Mode = SuiteClaim["mode"];
type CorpusFact = { statement: string; stale?: boolean };

const arg = (flag: string, fallback: string): string => {
	const at = process.argv.indexOf(flag);
	return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};
const argRuns: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
	if (process.argv[i].startsWith("--")) {
		i++;
		continue;
	}
	argRuns.push(process.argv[i]);
}
if (argRuns.length === 0) {
	console.error("usage: npx tsx dev/supersede-outcome-report.ts <runId> [<runId> ...] [--corpus <path>]");
	process.exit(1);
}

const corpusPath = arg("--corpus", "dev/corpus-supersede.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
	chunks: { chunkId: string; facts?: (string | CorpusFact)[] }[];
	// The right answer the synthetic corpus declares: the count each mode must end on, and which superseded counts
	// the corpus deliberately keeps as records about a document.
	expected?: Partial<Record<Mode, { final: number; records?: number[] }>>;
};

const expected = corpus.expected ?? {};

/** A corpus chunk that declares no facts cannot be graded: the run has no stated right answer. */
const corpusChunks = corpus.chunks.map((chunk) => ({
	chunkId: chunk.chunkId,
	facts: (chunk.facts ?? []).map((f) => (typeof f === "string" ? { statement: f } : f)),
}));
const ungradedChunks = corpusChunks.filter((chunk) => chunk.facts.length === 0).map((chunk) => chunk.chunkId);
const chunkIndex = new Map(corpusChunks.map((chunk, i) => [chunk.chunkId, i]));

/** The count each mode claimed at each chunk, oldest first. A record of an old number asserts nothing. */
const lineage = new Map<Mode, SuiteClaim[]>();
for (const chunk of corpusChunks) {
	for (const fact of chunk.facts) {
		if (fact.stale) continue;
		for (const claim of suiteClaims(fact.statement))
			lineage.set(claim.mode, [...(lineage.get(claim.mode) ?? []), claim]);
	}
}
const modes = [...lineage.keys()];

const finalValue = (mode: Mode): number | undefined => lineage.get(mode)?.at(-1)?.value;

const readLedger = (runId: string): LedgerRecord[] => {
	const path = `out/${runId}/ledger.jsonl`;
	if (!existsSync(path)) throw new Error(`missing ${path} — run dev/run.ts --run ${runId} --corpus <corpus>`);
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as LedgerRecord);
};

const show = (claims: SuiteClaim[]): string =>
	claims.length ? claims.map((c) => `${c.mode} ${c.value}`).join(" + ") : "no count";

const heldValue = (claims: SuiteClaim[], mode: Mode): number | undefined => claims.find((c) => c.mode === mode)?.value;

const report = (runId: string, ledger: LedgerRecord[]) => {
	let updates = 0;
	let rightTarget = 0;
	let olderCountTarget = 0;
	let otherModeTarget = 0;
	let noClaimTarget = 0;
	let deletes = 0;
	let deletesOfSuperseded = 0;
	let retiredTarget = 0;
	const findings: string[] = [];
	const missing: string[] = [];
	const storedStaleRecords: string[] = [];
	let declaredCount = 0;
	let draftedCount = 0;

	// Walk the ledger chunk by chunk. The bank is replayed with the same fold the pipeline uses, so a target is
	// judged by what it held when the model picked it, not by what it ended as.
	for (let i = 0; i < ledger.length; i++) {
		const record = ledger[i];
		if (record.type !== "hy.ops") continue;
		const extract = ledger.slice(0, i).findLast((r) => r.type === "hy.extract" && r.chunkId === record.chunkId);
		const drafts = extract?.type === "hy.extract" ? extract.drafts : [];
		const bank = foldLedger(ledger.slice(0, i));
		const at = chunkIndex.get(record.chunkId);
		if (at === undefined) {
			findings.push(`  ${record.chunkId}: not a chunk of ${corpusPath}, skipped`);
			continue;
		}
		// Did the chunk's declared fact reach the writer at all? A count that is never drafted cannot be
		// superseded, and no reconcile change can fix it.
		const declared = corpusChunks[at].facts.filter((f) => !f.stale).flatMap((f) => suiteClaims(f.statement));
		const drafted = drafts.flatMap((d) => suiteClaims((d as Draft).statement));
		declaredCount += declared.length;
		for (const want of declared) {
			if (drafted.some((c) => c.mode === want.mode && c.value === want.value)) draftedCount++;
			else
				missing.push(
					`  ${record.chunkId}: the corpus states ${want.mode} ${want.value} and no draft of this chunk asserted it (drafts: ${show(drafted)})`,
				);
		}
		const staleDeclared = corpusChunks[at].facts.filter((f) => f.stale).flatMap((f) => suiteClaims(f.statement));
		for (const staleClaim of staleDeclared) {
			if (drafted.some((c) => c.mode === staleClaim.mode && c.value === staleClaim.value))
				storedStaleRecords.push(
					`  ${record.chunkId}: a draft asserts ${staleClaim.mode} ${staleClaim.value}, which the corpus marks as a record of a superseded number`,
				);
		}

		for (const op of record.ops as (ReconcileOp & { draftStatement?: string })[]) {
			if (op.action !== "UPDATE" && op.action !== "DELETE") continue;
			const target = bank.find((e) => e.id === op.target);
			const held = target ? suiteClaims(target.statement) : [];
			if (target && target.status !== "active") {
				retiredTarget++;
				findings.push(
					`  ${record.chunkId}: UPDATE aimed at an entry the bank had already superseded (${show(held)})`,
				);
				continue;
			}

			if (op.action === "DELETE") {
				deletes++;
				const superseded = held.some((claim) =>
					(lineage.get(claim.mode) ?? []).slice(0, -1).some((step) => step.value === claim.value),
				);
				if (superseded) deletesOfSuperseded++;
				continue;
			}
			if (op.action !== "UPDATE") continue;
			updates++;

			const draft = drafts[op.draft] as Draft | undefined;
			const wrote = suiteClaims(op.draftStatement ?? draft?.statement ?? "");
			const mode = wrote[0]?.mode ?? held[0]?.mode;
			if (!mode) {
				noClaimTarget++;
				findings.push(
					`  ${record.chunkId}: UPDATE neither wrote a count nor aimed at one (${show(held)} → ${show(wrote)})`,
				);
				continue;
			}
			// The right target is what the bank actually holds: the active entry with the newest claim of this
			// mode. The corpus states what should be current, but a count the extractor never drafted is not in
			// the bank, and aiming at the newest claim the bank does hold is the correct move.
			let current: { id: string; value: number; chunkSeq: number } | undefined;
			for (const entry of bank) {
				if (entry.status !== "active") continue;
				const claim = suiteClaims(entry.statement).find((c) => c.mode === mode);
				if (!claim) continue;
				if (!current || entry.chunkSeq > current.chunkSeq)
					current = { id: entry.id, value: claim.value, chunkSeq: entry.chunkSeq };
			}

			if (!target) {
				noClaimTarget++;
				findings.push(
					`  ${record.chunkId}: UPDATE named ${op.target}, which the bank did not hold (draft wrote ${show(wrote)})`,
				);
				continue;
			}
			if (held.length === 0) {
				noClaimTarget++;
				findings.push(
					`  ${record.chunkId}: UPDATE "${target.statement.slice(0, 60)}" held ${show(held)}; draft wrote ${show(wrote)}`,
				);
				continue;
			}
			const aim = heldValue(held, mode);
			if (aim === undefined) {
				otherModeTarget++;
				findings.push(
					`  ${record.chunkId}: UPDATE rewrote ${show(held)} while writing ${show(wrote)} — the target held no ${mode} count`,
				);
				continue;
			}
			if (current && target.id !== current.id) {
				olderCountTarget++;
				findings.push(
					`  ${record.chunkId}: UPDATE aimed at ${mode} ${aim} (write ${target.chunkSeq}) while the bank's newest ${mode} claim was ${current.value} (write ${current.chunkSeq}); draft wrote ${show(wrote)}`,
				);
				continue;
			}
			rightTarget++;
		}
	}

	// The end state the corpus demands: each mode's newest count active once, superseded counts gone, and the two
	// counts kept as separate entries.
	const all = foldLedger(ledger);
	// A superseded entry stays in the ledger and stays recallable; it is no longer current. Only active entries
	// are the end state the corpus grades.
	let bank = all.filter((entry) => entry.status === "active");
	// Experiment rule, applied at measurement time rather than in the writer: only the newest active entry that
	// asserts a metric's count may hold that metric. An older entry is not deleted — it stays in the ledger and
	// stays recallable — it just stops being current, which is what a supersede already means.
	const newestClaimOnly = process.argv.includes("--newest-claim-only");
	let ruleRetired = 0;
	if (newestClaimOnly) {
		const holdsMetric = (entry: BankEntry, mode: Mode): boolean =>
			suiteClaims(entry.statement).some((c) => !c.record && c.mode === mode);
		const modesHeld = (entry: BankEntry): Mode[] => [
			...new Set(
				suiteClaims(entry.statement)
					.filter((c) => !c.record)
					.map((c) => c.mode),
			),
		];
		bank = bank.filter((entry) => {
			const overtaken = modesHeld(entry).filter((mode) =>
				bank.some((other) => other !== entry && other.createdAt > entry.createdAt && holdsMetric(other, mode)),
			);
			ruleRetired += overtaken.length;
			return overtaken.length === 0;
		});
	}
	const heldBy = (mode: Mode, value: number) =>
		bank.filter((entry) => suiteClaims(entry.statement).some((c) => c.mode === mode && c.value === value));

	// A superseded number sitting in an active entry is only a failure when the entry asserts it as the current
	// count. The corpora deliberately carry records — a log file, a changelog line, a hard-coded CI line — and a
	// record quoting an old number is a correct fact about that document. The classification reads the entry's own
	// wording rather than the chunk it came from, because an entry that began as a record can be rewritten into an
	// assertion by a later UPDATE, and that is exactly the case the count has to catch.
	const recordCarrier = (entry: BankEntry, claim: { mode: Mode; value: number }): boolean => {
		const held = suiteClaims(entry.statement).filter((c) => c.mode === claim.mode && c.value === claim.value);
		return held.length > 0 && held.every((c) => c.record);
	};

	let staleSurvivors = 0;
	let staleRecords = 0;
	let unsupported = 0;
	let duplicates = 0;
	const endings: string[] = [];
	for (const mode of modes) {
		const final = finalValue(mode);
		const superseded = (lineage.get(mode) ?? []).slice(0, -1);
		const holdingFinal = final === undefined ? 0 : heldBy(mode, final).length;
		const holdingOld = superseded.filter((step) => heldBy(step.mode, step.value).length > 0);
		const oldAsAssertion = holdingOld.filter((step) =>
			heldBy(step.mode, step.value).some((entry) => !recordCarrier(entry, step)),
		);
		const oldAsRecord = holdingOld.filter((step) =>
			heldBy(step.mode, step.value).every((entry) => recordCarrier(entry, step)),
		);
		staleSurvivors += oldAsAssertion.length;
		staleRecords += oldAsRecord.length;
		duplicates += Math.max(0, holdingFinal - 1);
		// A count the corpus never states for that mode is a claim the writer invented — the mode a number was
		// read under, or a total no chunk ever reported.
		const declaredForMode = new Set((lineage.get(mode) ?? []).map((c) => c.value));
		const invented = bank
			.flatMap((entry) => suiteClaims(entry.statement))
			.filter((c) => c.mode === mode && !declaredForMode.has(c.value));
		unsupported += new Set(invented.map((c) => c.value)).size;
		endings.push(
			`${mode}: corpus ends at ${final ?? "-"}, bank holds it ${holdingFinal}x | superseded ${
				superseded.map((s) => s.value).join(", ") || "-"
			} — asserted as current: ${oldAsAssertion.map((s) => s.value).join(", ") || "none"} | held only as a record: ${
				oldAsRecord.map((s) => s.value).join(", ") || "none"
			} | never stated for this mode: ${[...new Set(invented.map((c) => c.value))].join(", ") || "none"}`,
		);
	}
	// Ground truth. Each corpus names the count each mode must end on, and which superseded counts may stay inside
	// records. The record/assertion split above is a wording heuristic; this comparison is what calls a run right.
	const newestAsserted = (mode: Mode): number | undefined => {
		let value: number | undefined;
		for (const entry of bank)
			for (const claim of suiteClaims(entry.statement))
				if (claim.mode === mode && !claim.record) value = claim.value;
		return value;
	};
	const problems: string[] = [];
	const verdicts: string[] = [];
	for (const mode of modes) {
		const want = expected[mode];
		if (!want) continue;
		const got = newestAsserted(mode);
		if (got !== want.final) problems.push(`${mode} ends at ${got ?? "nothing"}, corpus ends at ${want.final}`);
		const wantedRecords = want.records ?? [];
		const heldRecords = wantedRecords.filter((value) =>
			heldBy(mode, value).some((entry) => recordCarrier(entry, { mode, value })),
		).length;
		verdicts.push(
			`${mode} ${got === want.final ? "ok" : "WRONG"} (bank ${got ?? "-"} / corpus ${want.final}; expected records held ${heldRecords} of ${wantedRecords.length})`,
		);
	}
	if (staleSurvivors > 0) problems.push(`${staleSurvivors} superseded counts asserted as current`);
	if (unsupported > 0) problems.push(`${unsupported} counts the corpus never states`);
	if (duplicates > 0) problems.push(`${duplicates} entries hold the same current count`);
	const merged = bank.filter((entry) => {
		const claims = suiteClaims(entry.statement);
		return claims.some((c) => c.mode === "offline") && claims.some((c) => c.mode === "lan");
	});
	// A count held by two active entries is the same fact written twice, whatever the corpus says about it.
	const carriers = new Map<string, number>();
	for (const entry of bank)
		for (const claim of suiteClaims(entry.statement)) {
			const key = `${claim.mode} ${claim.value}`;
			carriers.set(key, (carriers.get(key) ?? 0) + 1);
		}
	const sharedCarriers = [...carriers.values()].filter((n) => n > 1).length;

	const allClaims = bank.flatMap((entry) => suiteClaims(entry.statement)).sort((a, b) => a.value - b.value);
	const writes = ledger.reduce((n, r) => n + (r.type === "hy.ops" ? r.ops.length : 0), 0);
	console.log(
		`\n${runId} — ${writes} writes over ${ledger.filter((r) => r.type === "hy.ops").length} chunks; bank ends with ${bank.length} active entries of ${all.length} written (${all.length - bank.length} superseded), holding ${allClaims.length} count claims (${allClaims.map((c) => `${c.mode} ${c.value}`).join(", ") || "none"})`,
	);
	if (newestClaimOnly)
		console.log(
			`  newest-claim-only rule applied at measurement: ${ruleRetired} older claims would stop being current (${bank.length} entries left holding a count)`,
		);
	if (ungradedChunks.length) console.log(`  ungraded: ${ungradedChunks.join(", ")} declare no facts`);
	for (const line of endings) console.log(`  ${line}`);
	console.log(
		`  targets: ${rightTarget}/${updates} UPDATEs aimed at the current count of their mode; ${olderCountTarget} aimed at an older count, ${otherModeTarget} at an entry holding no claim of that mode, ${noClaimTarget} at an entry holding no count at all, ${retiredTarget} at an entry the bank had already superseded`,
	);
	console.log(
		`  retirement: ${deletes} DELETEs, ${deletesOfSuperseded} of them removed a superseded count; ${staleSurvivors} superseded counts still asserted as current (${staleRecords} more held only as records the corpus says stay); ${unsupported} counts the corpus never states for that mode; ${duplicates} duplicate entries for a current count; ${sharedCarriers} counts held by more than one active entry; ${merged.length} entries merged both counts into one statement`,
	);
	if (verdicts.length)
		console.log(
			`  VERDICT: ${problems.length === 0 ? "PASS" : `FAIL — ${problems.join("; ")}`} | ${verdicts.join(" | ")}`,
		);
	console.log(
		`  coverage: of ${declaredCount} counts the corpus states across the run, ${draftedCount} reached the writer as a draft; ${storedStaleRecords.length} chunks produced a draft stating a number the corpus marks superseded`,
	);
	for (const line of missing) console.log(line);
	for (const line of storedStaleRecords) console.log(line);
	for (const line of findings) console.log(line);
};

for (const runId of argRuns) report(runId, readLedger(runId));
