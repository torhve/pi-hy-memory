#!/usr/bin/env npx tsx

/**
 * dev/supersede2-trap-check.ts — does the hard corpus actually set the trap, before any model is called?
 *
 * `dev/corpus-supersede2.json` declares, per chunk, the facts a correct writer banks (`facts`), which of
 * them are records of what a log or document says (`stale`), and which a correct writer would retire by the
 * end (`retire`). From those declarations this builds the bank an ideal writer would hold just before each
 * count chunk, runs the shipped candidate selection against that chunk's own count draft, and says:
 *
 *   - how many count claims are active, and how many of them the reconcile call is shown;
 *   - the rank of the *current* count claim in that draft's candidate list;
 *   - the rank of the top-ranked count claim, and whether the number it asserts is one the suite moved past.
 *
 * Four ways it can fail, counted separately because they need different fixes: a stale count ranked above the
 * current one; the current claim never retrieved; stale counts sharing the screen with the current one; and a
 * chunk that only records an old number while the bank's current claim is nowhere in view. No model call here:
 * this measures the selection code, so a corpus that cannot set the trap is caught here rather than after
 * three paid arms.
 *
 *   npx tsx dev/supersede2-trap-check.ts [--limit 24] [--corpus dev/corpus-supersede2.json]
 */
import { readFileSync } from "node:fs";
import { candidatesPerDraft, overlap, selectShownPerDraft } from "../src/protocol.js";
import type { BankEntry, Draft } from "../src/types.js";
import { suiteClaim } from "./suite-claim.js";

const arg = (flag: string, fallback: string): string => {
	const at = process.argv.indexOf(flag);
	return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};

const limit = Number(arg("--limit", "24"));
const corpusPath = arg("--corpus", new URL("./corpus-supersede2.json", import.meta.url).pathname);

type Fact = { task: string; statement: string; stale?: boolean; retire?: boolean };
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
	trapChunk?: string;
	chunks: { chunkId: string; why?: string; text: string; facts: Fact[] }[];
};

const clock = (chunkIndex: number): string =>
	new Date(Date.parse("2026-11-01T09:00:00.000Z") + chunkIndex * 20 * 60_000).toISOString();

const entries: BankEntry[] = [];
corpus.chunks.forEach((chunk, ci) => {
	chunk.facts.forEach((fact, fi) => {
		entries.push({
			id: `f${String(ci + 1).padStart(3, "0")}${String(fi + 1).padStart(3, "0")}x`.padEnd(12, "0").slice(0, 12),
			task: fact.task,
			statement: fact.statement,
			keys: [],
			sourceEntryIds: [],
			chunkId: chunk.chunkId,
			chunkSeq: ci + 1,
			fromUser: false,
			createdAt: clock(ci),
			status: "active",
			tokenCount: Math.ceil(fact.statement.length / 4),
		});
	});
});

const kinds = { inverted: 0, unretrieved: 0, stalePeers: 0, recordBlind: 0 };
const kindsAfter = { inverted: 0, unretrieved: 0, stalePeers: 0, recordBlind: 0 };
let droppedPeers = 0;
let countChunks = 0;
let recordChunks = 0;

corpus.chunks.forEach((chunk, ci) => {
	const own = chunk.facts.map((f) => suiteClaim(f.statement));
	const draftIndex = own.findIndex((c) => c !== undefined);
	if (draftIndex < 0) return;
	countChunks++;
	// A fact the corpus marks stale is a record of an old number, not a claim about the current one. The
	// writer still faces a selection problem in that chunk — it is rewriting a document about 214 while the
	// bank's current count is 402 — so it is graded, just not as an assertion.
	const draftIsRecord = chunk.facts[draftIndex]?.stale === true;
	if (draftIsRecord) recordChunks++;
	const draftClaim = own[draftIndex];
	if (!draftClaim) return;
	const draft: Draft = {
		task: chunk.facts[draftIndex].task,
		statement: chunk.facts[draftIndex].statement,
		keys: [],
		refs: [],
	};

	// The bank an ideal writer holds before this chunk: every fact from earlier chunks, except a superseded
	// count of the same mode that is neither the newest of its mode nor a record the corpus says stays.
	const prior = entries.filter((e) => e.chunkSeq <= ci);
	const staleIds = new Set(
		entries
			.filter((e) => corpus.chunks[e.chunkSeq - 1].facts.some((f) => f.statement === e.statement && f.stale))
			.map((e) => e.id),
	);
	// The current claim of a mode is its newest *assertion*. A record of an old number — a log line, a document
	// line, a hard-coded CI echo — quotes a count without asserting it, so it never counts as current.
	const newestByMode = new Map<"lan" | "offline", string>();
	for (const e of prior) {
		if (staleIds.has(e.id)) continue;
		const claim = suiteClaim(e.statement);
		if (claim) newestByMode.set(claim.mode, e.id);
	}
	const bank = prior.filter((e) => {
		const claim = suiteClaim(e.statement);
		if (!claim) return true;
		return staleIds.has(e.id) || newestByMode.get(claim.mode) === e.id;
	});

	const perDraft = candidatesPerDraft(bank, [draft], limit);
	const candidates = perDraft.get(0) ?? [];
	const shown = selectShownPerDraft(perDraft, limit);

	const rankOf = (id: string): number => candidates.findIndex((e) => e.id === id);
	const currentId = newestByMode.get(draftClaim.mode);
	const currentRank = currentId === undefined ? -1 : rankOf(currentId);
	const top = candidates[0];
	const topClaim = top ? suiteClaim(top.statement) : undefined;
	const activeCounts = bank.filter((e) => suiteClaim(e.statement) !== undefined);
	const shownCounts = shown.filter((e) => suiteClaim(e.statement) !== undefined);

	// Ways the selection can fail the writer, and they need different fixes.
	const hasPredecessor = currentId !== undefined;
	const unretrieved = !draftIsRecord && hasPredecessor && currentRank < 0;
	// A chunk that only records an old number is a risk when the call cannot see the current one: the writer
	// has nothing to write the correction against, and the stale number is the only count in front of it.
	const recordBlind = draftIsRecord && (currentId === undefined || currentRank < 0);
	const currentClaimValue = suiteClaim(bank.find((e) => e.id === currentId)?.statement ?? "")?.value ?? -1;
	const inverted =
		!draftIsRecord &&
		!unretrieved &&
		topClaim !== undefined &&
		topClaim.mode === draftClaim.mode &&
		topClaim.value !== currentClaimValue &&
		topClaim.value !== draftClaim.value;
	// The case the age lines were meant to settle: the current claim is on screen, and stale counts of the same
	// subject are on screen with it, so the only thing that tells them apart is which one is newest.
	const stalePeers = shown.filter((e) => {
		const claim = suiteClaim(e.statement);
		return claim !== undefined && e.id !== currentId && staleIds.has(e.id);
	}).length;
	const trapKind = unretrieved
		? "the current claim was not retrieved at all"
		: recordBlind
			? "the chunk records an old number and the current claim is not on screen"
			: inverted
				? "a stale count ranked above it"
				: stalePeers > 0
					? `${stalePeers} stale count(s) share the screen with it`
					: "";
	if (unretrieved) kinds.unretrieved++;
	if (recordBlind) kinds.recordBlind++;
	if (inverted) kinds.inverted++;
	if (stalePeers > 0) kinds.stalePeers++;
	// The alternative selection: the newest claim of a metric keeps the slot, older claims of the same metric
	// stay in the bank and stay recallable, but they are not shown. This measures what a bank-side supersede
	// rule would do to the candidate list before any model is involved.
	const newestCandidate = new Map<"lan" | "offline", BankEntry>();
	for (const e of candidates) {
		const claim = suiteClaim(e.statement);
		if (claim === undefined || staleIds.has(e.id)) continue;
		const held = newestCandidate.get(claim.mode);
		if (held === undefined || e.createdAt > held.createdAt) newestCandidate.set(claim.mode, e);
	}
	const kept = candidates.filter((e) => {
		const claim = suiteClaim(e.statement);
		return claim === undefined || newestCandidate.get(claim.mode)?.id === e.id;
	});
	const shownAfter = kept.slice(0, shown.length);
	const stalePeersAfter = shownAfter.filter((e) => {
		const claim = suiteClaim(e.statement);
		return claim !== undefined && e.id !== currentId && staleIds.has(e.id);
	}).length;
	const topAfter = kept[0] ? suiteClaim(kept[0].statement) : undefined;
	const invertedAfter =
		!draftIsRecord &&
		!unretrieved &&
		topAfter !== undefined &&
		topAfter.mode === draftClaim.mode &&
		topAfter.value !== currentClaimValue &&
		topAfter.value !== draftClaim.value;
	if (unretrieved) kindsAfter.unretrieved++;
	if (recordBlind) kindsAfter.recordBlind++;
	if (invertedAfter) kindsAfter.inverted++;
	if (stalePeersAfter > 0) kindsAfter.stalePeers++;
	droppedPeers += shownCounts.length - shownAfter.filter((e) => suiteClaim(e.statement) !== undefined).length;

	console.log(
		`${chunk.chunkId} draft ${draftIsRecord ? "records" : "asserts"} ${draftClaim.mode} ${draftClaim.value} | active count claims ${activeCounts
			.map((e) => suiteClaim(e.statement)?.value ?? 0)
			.sort((a, b) => a - b)
			.join(
				",",
			)} | shown ${shown.length} entries (${shownCounts.length} counts) | candidates ${candidates.length}` +
			` | current rank ${currentRank}${currentRank >= 0 ? "" : " (not a candidate)"} | top rank 0 is ` +
			`${topClaim ? `${topClaim.mode} ${topClaim.value}` : "not a count"}${topClaim && topClaim.value !== draftClaim.value ? " (stale)" : ""}` +
			`${trapKind ? `  <-- TRAP: ${trapKind}` : ""}`,
	);
	if (chunk.chunkId === corpus.trapChunk) {
		const ranked = candidates.map((e, i) => ({
			rank: i + 1,
			number: suiteClaim(e.statement)?.value ?? "-",
			task: e.task,
			score: overlap(`${e.statement} ${e.task}`, `${draft.statement} ${draft.task}`),
		}));
		console.log("   trap chunk ranking (rank. number task score):");
		for (const r of ranked) console.log(`     ${r.rank}. ${r.number} ${r.task} ${r.score.toFixed(2)}`);
		const bankCounts = activeCounts
			.map((e) => ({
				number: suiteClaim(e.statement)?.value,
				task: e.task,
				shown: shown.some((s) => s.id === e.id),
			}))
			.sort((a, b) => (b.shown ? 1 : 0) - (a.shown ? 1 : 0));
		console.log(
			`   active count claims and whether the call sees them: ${bankCounts.map((c) => `${c.number} ${c.task}${c.shown ? "" : " (unseen)"}`).join(" | ")}`,
		);
	}
});

console.log(
	`\ncorpus ${corpusPath}: ${countChunks} count chunks, ${recordChunks} of them only recording an old number. Traps found before any model runs: ${kinds.inverted} where a stale count ranked above the current one, ${kinds.unretrieved} where the current claim was not a candidate at all, ${kinds.stalePeers} where stale counts of the same subject share the screen with it, ${kinds.recordBlind} where a chunk records an old number with no current claim in view. Candidate limit ${limit}.`,
);
console.log(
	`with the newest claim of a metric holding the slot: ${kindsAfter.inverted} inverted, ${kindsAfter.unretrieved} unretrieved, ${kindsAfter.stalePeers} with stale peers, ${kindsAfter.recordBlind} record chunks blind to the current claim; ${droppedPeers} stale count(s) left the screen and stay recallable.`,
);
