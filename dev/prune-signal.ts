#!/usr/bin/env npx tsx
/**
 * Prune-signal test: can a large model tell which bank facts describe *closed* work?
 *
 * The idea under test (DESIGN.md § "When the store itself is full", step 5 and the
 * executor-review proposal): the session's own model knows which threads it has
 * finished or abandoned, and after the first compaction the bank is already in its
 * context — so "which of these facts belong to work that is over?" looks cheap.
 *
 * It is only worth building if the answer has *spread*. Two previous attempts at
 * asking a model to grade its own output died on exactly that: `confidence` came back
 * 1.0 for 965 of 996 facts, and a `stability` field came back `detail` for 60 of 65
 * drafts. A model that says "keep" for 90 % of the bank gives us nothing to rank with,
 * no matter how sensible the request is.
 *
 * This is that gate, and nothing else: one call, then the verdict distribution and how
 * it overlaps with what the reader and the retriever actually look at.
 *
 *   npx tsx dev/prune-signal.ts --ledger <path> [--model deepseek-v4-pro] [--limit 0]
 *
 * Costs one model call. `--model` takes a `provider/modelId` from pi's model list, or
 * set POC_ORIGIN / POC_KEY / POC_MODEL to use a raw endpoint.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { foldLedger } from "../src/bank.js";
import type { Writer } from "../src/llm.js";
import { candidatesPerDraft, parseJsonObject } from "../src/protocol.js";
import { selectForSummary, summaryBudget } from "../src/render.js";
import type { BankEntry, Draft, LedgerRecord } from "../src/types.js";
import { rawWriter } from "./raw-writer.js";
import { resolveRoute } from "./run.js";

const systemPrompt = (
	idsOnly: boolean,
): string => `You are reviewing the memory bank of a coding session that is still running.

Each line is one stored fact, in the form: <id>abcdef123456</id> (short subject) statement.

Some facts describe work that is finished, abandoned, reverted or was a dead end. Others
describe constraints, decisions, configuration and state that are still in force.

Return ONLY a JSON object, no prose and no code fence:
${idsOnly ? '{"closed":["abcdef123456","fedcba654321"]}' : '{"closed":[{"id":"abcdef123456","why":"short reason"}]}'}

Rules:
- List an id only when the work it describes is over: finished and never to be revisited, abandoned, reverted, or a dead end already replaced by a later approach.
- Do not list a fact merely because it is old, small, or looks unimportant. Age is not closure.
- Constraints, user preferences, environment and configuration are still in force unless the statement itself says otherwise.
- If nothing is closed, return {"closed":[]}.`;

const args = process.argv.slice(2);
const arg = (flag: string, fallback: string): string => {
	const at = args.indexOf(flag);
	return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

type Verdict = { id: string; why?: string };

function main(): Promise<void> {
	return run();
}

async function run(): Promise<void> {
	const ledgerPath = arg("--ledger", "");
	if (!ledgerPath) throw new Error("--ledger <path> is required");
	const modelSpec = arg("--model", "deepseek/deepseek-v4-pro");
	const limit = Number(arg("--limit", "0"));
	const idsOnly = args.includes("--ids-only");
	// Evenly spaced sample across the whole bank (the newest facts would bias toward
	// "keep", the oldest toward "closed"): separates "cannot judge" from "cannot scale".
	const sample = Number(arg("--sample", "0"));
	// `none` is the value both engines accept: llama.cpp ignores a reasoning effort it does
	// not recognise, the Strata engine answers 400 for one. The flash-next endpoint only accepts
	// none/low/medium/high and rejects anything else with a 400.
	const reasoning = arg("--reasoning", "none");
	const records = readFileSync(ledgerPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as LedgerRecord);
	const bank = foldLedger(records);
	let active = bank.filter((e) => e.status === "active");
	if (limit > 0) active = active.slice(-limit);
	if (sample > 0 && sample < active.length) {
		const step = active.length / sample;
		active = Array.from({ length: sample }, (_, i) => active[Math.floor(i * step)]);
	}

	// What the reader sees, and what the retriever has ever shown — the two places a
	// pruned fact would have mattered.
	const shown = new Set(
		selectForSummary(bank, summaryBudget(8000, active), { foundationAfterChunks: 8 }).shown.map((e) => e.id),
	);
	const retrieved = new Set<string>();
	{
		const extracts = new Map<string, Draft[]>();
		const prefix: LedgerRecord[] = [];
		for (const r of records) {
			if (r.type === "hy.extract") {
				extracts.set(r.chunkId, r.drafts as Draft[]);
				prefix.push(r);
				continue;
			}
			if (r.type !== "hy.ops") {
				prefix.push(r);
				continue;
			}
			const before = foldLedger(prefix).filter((e) => e.status === "active");
			for (const list of candidatesPerDraft(before, extracts.get(r.chunkId) ?? [], 24).values())
				for (const e of list) retrieved.add(e.id);
			prefix.push(r);
		}
	}

	const lines = active.map((e: BankEntry) => `<id>${e.id}</id> (${e.task.slice(0, 60)}) ${e.statement}`);
	const writer: Writer = await resolveWriter(modelSpec, reasoning);
	const result = await writer.complete(systemPrompt(idsOnly), `Facts:\n${lines.join("\n")}`, "prune-signal");
	const parsed = parseJsonObject(result.content) as { closed?: Verdict[] } | undefined;
	const closedRaw = Array.isArray(parsed?.closed) ? parsed.closed : [];
	const verdicts: Verdict[] = closedRaw.map((v) =>
		typeof v === "string" ? { id: v } : { id: String((v as Verdict)?.id ?? ""), why: (v as Verdict)?.why },
	);
	const byId = new Map(active.map((e) => [e.id, e]));
	const valid = verdicts.filter((v) => byId.has(String(v.id)));
	const invalid = verdicts.length - valid.length;

	const closedIds = new Set(valid.map((v) => String(v.id)));
	const overlap = {
		shownInSummary: valid.filter((v) => shown.has(String(v.id))).length,
		retrievedOnly: valid.filter((v) => !shown.has(String(v.id)) && retrieved.has(String(v.id))).length,
		invisible: valid.filter((v) => !shown.has(String(v.id)) && !retrieved.has(String(v.id))).length,
	};
	const share = (n: number): string => `${n} (${((100 * n) / active.length).toFixed(1)}% of the bank)`;

	console.log(`model ${modelSpec}, ${active.length} active facts, ${lines.length} lines sent`);
	console.log(
		`usage: ${result.usage.inTokens} in / ${result.usage.outTokens} out, ${result.usage.wallS.toFixed(1)} s`,
	);
	console.log(`\nclosed verdicts: ${verdicts.length} (${share(valid.length)}), invalid ids: ${invalid}`);
	console.log(`  of those, shown in the summary: ${overlap.shownInSummary}`);
	console.log(`  retrieved but not shown:        ${overlap.retrievedOnly}`);
	console.log(`  neither shown nor retrieved:    ${overlap.invisible}`);
	console.log(
		`  keep verdicts:                  ${active.length - closedIds.size} (${(100 * (1 - closedIds.size / active.length)).toFixed(1)}%)`,
	);

	const outDir = join("out", "prune-signal");
	mkdirSync(outDir, { recursive: true });
	writeFileSync(
		join(outDir, `signal-${modelSpec.replace(/[^a-z0-9]+/gi, "-")}.json`),
		`${JSON.stringify({ modelSpec, active: active.length, usage: result.usage, verdicts: valid, invalid, overlap, raw: result.content.slice(0, 4000) }, null, 2)}\n`,
	);
	console.log(
		`\nexamples: ${valid
			.slice(0, 5)
			.map((v) => `[${v.id}] ${String(v.why ?? "").slice(0, 60)}`)
			.join("\n           ")}`,
	);
}

async function resolveWriter(spec: string, reasoning: string): Promise<Writer> {
	if (process.env.POC_ORIGIN) {
		return rawWriter({
			origin: process.env.POC_ORIGIN,
			apiKey: process.env.POC_KEY,
			model: process.env.POC_MODEL ?? spec,
			maxTokens: 12000,
			chatTemplateKwargs: { reasoning_effort: reasoning },
			timeoutMs: 1_800_000,
		});
	}
	const route = await resolveRoute(spec);
	return rawWriter({
		origin: route.origin,
		apiKey: route.apiKey,
		model: route.model,
		maxTokens: 12000,
		chatTemplateKwargs: { reasoning_effort: reasoning },
		timeoutMs: 1_800_000,
	});
}

main().catch((error) => {
	console.error(String((error as Error)?.message ?? error));
	process.exitCode = 1;
});
