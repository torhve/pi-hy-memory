/**
 * Ratification arm: can the extract prompt be told to cite the settled proposal?
 *
 *   POC_MODEL=... npx tsx dev/ratification-arm.ts --session <session.jsonl> [--limit 8]
 *
 * `dev/ratification-analysis.ts` established the shape offline: in a real session
 * 40 % of user turns are bare acceptances ("proceed"), and when such a turn follows
 * an assistant proposal the two always land in the SAME chunk, so the extract call
 * that writes the fact does see the acceptance. What it does not do is cite the
 * proposal line: 13 of 1 355 drafts cited a user line at all.
 *
 * This arm asks whether one clause in the extract prompt moves citations, without
 * the model having to emit a field it was never trained on. Extract-only, like
 * `dev/split-chunk.ts`: no bank, no reconcile, one call per chunk per arm.
 *
 * Gate (pre-registered before the run):
 *   - ratified-proposal citations rise from the base arm's count to ≥ 80 % of chunks;
 *   - fact count and anchors/fact within −10 % of base (no coverage or specificity tax);
 *   - zero unparsable JSON in either arm.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { completeWithFallback } from "../src/llm.js";
import { EXTRACT_SYSTEM } from "../src/prompts.js";
import { parseDrafts } from "../src/protocol.js";
import type { Draft } from "../src/types.js";
import { estimateTokens } from "../src/types.js";
import { ACCEPT_MAX_CHARS, ACCEPTANCE, buildWindows, type Entry, loadSession } from "./ratification-analysis.js";
import { rawWriter } from "./raw-writer.js";
import { resolveRoute } from "./run.js";
import { duplicates, specificity } from "./split-chunk.js";

function arg(flag: string, fallback: string): string {
	const at = process.argv.indexOf(flag);
	return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

/** One clause, nothing else. Same sentence for every chunk. */
const CLAUSE =
	'- A short user turn that only accepts what the assistant just proposed ("proceed", "ok", "go") settles that proposal: store the proposal as a constraint, and cite the line where the proposal was made.';

const MAX_ENTRY_CHARS = 3000;
const WINDOW_TOKENS = 6000;

function clock(ms: number): string {
	if (!Number.isFinite(ms)) return "";
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function label(entry: Entry): string {
	const at = clock(entry.timestamp);
	const body = entry.text.replace(/\s+/g, " ").trim().slice(0, MAX_ENTRY_CHARS);
	const role = entry.role === "toolResult" ? "Tool result" : entry.role === "assistant" ? "Assistant" : "User";
	return `[${role}${at ? ` @ ${at}` : ""}]: ${body}`;
}

interface Case {
	chunkId: string;
	text: string;
	refs: string[];
	proposalRef: number;
	acceptanceRef: number;
	userRefIndices: number[];
	acceptanceText: string;
	proposalHead: string;
}

/** Windows centred on each acceptance whose proposal sits in the same production chunk. */
function buildCases(entries: Entry[], ledgerPath: string, limit: number): Case[] {
	const byId = new Map(entries.map((e) => [e.id, e]));
	const windows = buildWindows(ledgerPath, byId);
	const chunkOf = new Map<number, string>();
	for (const w of windows) for (let i = w.from; i <= w.to; i++) chunkOf.set(i, w.chunkId);

	const seen = new Set<string>();
	const cases: Case[] = [];
	for (const e of entries) {
		if (e.role !== "user") continue;
		const text = e.text.trim();
		if (!text || text.length > ACCEPT_MAX_CHARS || !ACCEPTANCE.test(text)) continue;
		let proposal: Entry | undefined;
		for (let i = e.index - 1; i >= 0; i--) {
			const prev = entries[i];
			if (prev.role === "assistant" && prev.text.trim()) {
				proposal = prev;
				break;
			}
			if (prev.role === "user") break;
		}
		if (!proposal) continue;
		const chunkId = chunkOf.get(e.index);
		if (!chunkId || chunkId !== chunkOf.get(proposal.index) || seen.has(chunkId)) continue;
		seen.add(chunkId);

		const window = windows.find((w) => w.chunkId === chunkId);
		if (!window) continue;
		// Centre on the exchange, then trim to the token budget from the proposal back.
		const start = Math.max(window.from, proposal.index - 6);
		const end = Math.min(window.to, e.index + 6);
		const picked: Entry[] = [];
		let tokens = 0;
		for (let i = start; i <= end; i++) {
			const entry = entries[i];
			if (entry.role === "system" || !entry.text.trim()) continue;
			const cost = estimateTokens(label(entry));
			if (picked.length > 0 && tokens + cost > WINDOW_TOKENS) break;
			picked.push(entry);
			tokens += cost;
		}
		const refs = picked.map((entry) => entry.id);
		const proposalRef = picked.findIndex((entry) => entry.id === proposal?.id);
		const acceptanceRef = picked.findIndex((entry) => entry.id === e.id);
		if (proposalRef < 0 || acceptanceRef < 0) continue;
		cases.push({
			chunkId,
			text: picked.map((entry, i) => `[${i}] ${label(entry)}`).join("\n"),
			refs,
			proposalRef,
			acceptanceRef,
			userRefIndices: picked.map((entry, i) => (entry.role === "user" ? i : -1)).filter((i) => i >= 0),
			acceptanceText: text.slice(0, 20),
			proposalHead: proposal.text.replace(/\s+/g, " ").trim().slice(0, 90),
		});
		if (cases.length >= limit) break;
	}
	return cases;
}

interface ArmResult {
	cases: number;
	citesProposal: number;
	citesAcceptance: number;
	citesUser: number;
	facts: number;
	anchorsPerFact: number;
	numbersPerFact: number;
	duplicates: number;
	rejectedDrafts: number;
	inTokens: number;
	outTokens: number;
	wallS: number;
}

type Row = Record<string, unknown>;

function emptyArm(): ArmResult {
	return {
		cases: 0,
		citesProposal: 0,
		citesAcceptance: 0,
		citesUser: 0,
		facts: 0,
		anchorsPerFact: 0,
		numbersPerFact: 0,
		duplicates: 0,
		rejectedDrafts: 0,
		inTokens: 0,
		outTokens: 0,
		wallS: 0,
	};
}

function accumulate(
	arm: ArmResult,
	c: Case,
	drafts: Draft[],
	rejected: number,
	usage: { inTokens?: number; outTokens?: number; wallS?: number },
): void {
	const spec = specificity(drafts);
	arm.cases++;
	arm.facts += drafts.length;
	arm.anchorsPerFact += spec.anchorsPerFact;
	arm.numbersPerFact += spec.numbersPerFact;
	arm.duplicates += duplicates(drafts);
	arm.rejectedDrafts += rejected;
	arm.inTokens += usage.inTokens ?? 0;
	arm.outTokens += usage.outTokens ?? 0;
	arm.wallS += usage.wallS ?? 0;
	for (const draft of drafts) {
		const refs = (draft.refs ?? []) as number[];
		if (refs.includes(c.proposalRef)) arm.citesProposal++;
		if (refs.includes(c.acceptanceRef)) arm.citesAcceptance++;
		if (refs.some((r) => c.userRefIndices.includes(r))) arm.citesUser++;
	}
}

async function main(): Promise<void> {
	const sessionPath = arg("--session", "");
	if (!sessionPath) throw new Error("--session <session.jsonl> is required");
	const sessionId = (sessionPath.match(/(01a[0-9a-f-]{30,})/)?.[1] ?? "").slice(0, 36);
	const ledgerPath = arg(
		"--ledger",
		join(process.env.HOME ?? "", ".pi", "agent", "pi-hy-memory", "state", "sessions", `${sessionId}.ledger.jsonl`),
	);
	const limit = Number(arg("--limit", "8"));
	const modelSpec = process.env.POC_MODEL ?? "hy-memory-30b-a3b";
	const route = process.env.POC_ORIGIN
		? { origin: process.env.POC_ORIGIN, apiKey: process.env.POC_KEY, model: process.env.POC_MODEL ?? modelSpec }
		: await resolveRoute(modelSpec);

	const writer = rawWriter({
		origin: route.origin,
		apiKey: route.apiKey,
		model: route.model,
		maxTokens: 8000,
		chatTemplateKwargs: { reasoning_effort: "none" },
		timeoutMs: 600_000,
	});

	const cases = buildCases(loadSession(sessionPath), ledgerPath, limit);
	console.log(`route ${route.model} @ ${route.origin} | ${cases.length} acceptance chunks`);
	for (const c of cases) console.log(`  ${c.chunkId} "${c.acceptanceText}" → ${c.proposalHead}`);

	const outDir = join(process.env.HY_OUT ?? "out", `ratification-${Date.now()}`);
	mkdirSync(outDir, { recursive: true });

	const arms: Record<string, ArmResult> = { base: emptyArm(), clause: emptyArm() };
	const perCase: Row[] = [];
	for (const c of cases) {
		for (const [name, system] of [
			["base", EXTRACT_SYSTEM],
			["clause", `${EXTRACT_SYSTEM}\n${CLAUSE}`],
		] as [string, string][]) {
			const arm = arms[name];
			let drafts: Draft[] = [];
			let rejected = 0;
			let usage = { inTokens: 0, outTokens: 0, wallS: 0 };
			try {
				const result = await completeWithFallback(writer, null, system, c.text, `extract ${name} ${c.chunkId}`);
				const parsed = parseDrafts(result.content, c.refs) as { drafts: Draft[]; rejected?: unknown[] };
				drafts = parsed.drafts;
				rejected = (parsed.rejected ?? []).length;
				usage = result.usage;
			} catch (error) {
				console.log(`  ${name} ${c.chunkId} FAILED: ${String((error as Error)?.message).slice(0, 120)}`);
			}
			accumulate(arm, c, drafts, rejected, usage);
			perCase.push({
				arm: name,
				chunkId: c.chunkId,
				proposalRef: c.proposalRef,
				acceptanceRef: c.acceptanceRef,
				facts: drafts.length,
				citesProposal: drafts.filter((d) => (d.refs ?? []).includes(c.proposalRef)).length,
				statements: drafts.map((d) => `${d.task} :: ${d.statement}`),
			});
			console.log(
				`  ${name.padEnd(6)} ${c.chunkId}: ${drafts.length} facts, cites proposal ${perCase[perCase.length - 1].citesProposal}, ` +
					`${usage.inTokens} in / ${usage.outTokens} out, ${usage.wallS.toFixed(1)} s`,
			);
		}
	}

	console.log(
		`\n| arm | chunks | facts | cites proposal | cites acceptance | anchors/fact | numbers/fact | dupes | rejected | in tok | out tok | wall |`,
	);
	console.log(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
	for (const [name, arm] of Object.entries(arms)) {
		const n = arm.cases || 1;
		console.log(
			`| ${name} | ${arm.cases} | ${arm.facts} | ${arm.citesProposal} | ${arm.citesAcceptance} | ${(arm.anchorsPerFact / n).toFixed(2)} | ` +
				`${(arm.numbersPerFact / n).toFixed(2)} | ${arm.duplicates} | ${arm.rejectedDrafts} | ${arm.inTokens} | ${arm.outTokens} | ${arm.wallS.toFixed(0)} s |`,
		);
	}
	writeFileSync(join(outDir, "arms.json"), JSON.stringify({ route, cases, arms, perCase }, null, 2));
	console.log(`\nwrote ${join(outDir, "arms.json")}`);
}

main().catch((error) => {
	console.error(String((error as Error)?.message ?? error));
	process.exit(1);
});
