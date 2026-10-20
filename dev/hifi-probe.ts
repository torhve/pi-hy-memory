#!/usr/bin/env npx tsx
/**
 * Hi-fi probe: one real checkpoint from a real session, on the model you would actually run.
 *
 *   npx tsx dev/hifi-probe.ts --session <pi session .jsonl> [--model <provider/id>]
 *       [--reasoning none] [--tail 6000] [--delta 6000] [--max-tokens 2000] [--out out/hifi]
 *
 * The bank comes from this extension's own ledger for that session, the tail from the newest
 * entries of its branch, and the request is built by `src/hifi.ts` — the same code the
 * compaction hook runs. So what is measured here is the feature, not a sketch of it:
 * request size, what the model wrote, how many fact ids survived, and whether the answer would
 * have been accepted or rejected.
 *
 * Costs one model call. `--model` resolves from pi's model list (see `dev/run.ts`).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { foldLedger } from "../src/bank.js";
import { SETTING_DEFAULTS } from "../src/config.js";
import { fileOperations, renderEntry, selectTail } from "../src/entries.js";
import { buildHifiPrompt, checkHifi, hifiFacts, hifiSummary } from "../src/hifi.js";
import { estimateTokens } from "../src/types.js";
import { resolveRoute } from "./run.js";

const args = process.argv.slice(2);
const arg = (flag: string, fallback: string): string => {
	const at = args.indexOf(flag);
	return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const sessionPath = arg("--session", "");
if (!sessionPath) {
	console.error("usage: npx tsx dev/hifi-probe.ts --session <pi session .jsonl> [--model provider/id]");
	process.exit(1);
}

const sessionId = basename(sessionPath).match(/_(01[0-9a-f-]{30,})\.jsonl$/)?.[1] ?? "";
const ledgerPath = arg(
	"--ledger",
	join(process.env.HOME ?? "", ".pi", "agent", "pi-hy-memory", "state", "sessions", `${sessionId}.ledger.jsonl`),
);

const rows = readFileSync(sessionPath, "utf8")
	.split("\n")
	.filter((l) => l.trim())
	.map((l) => JSON.parse(l) as Record<string, any>);
const branch = rows.filter((r) => r.type === "message" || r.type === "custom_message") as unknown as SessionEntry[];

const ledger = readFileSync(ledgerPath, "utf8")
	.split("\n")
	.filter((l) => l.trim())
	.map((l) => JSON.parse(l) as never);
const bank = foldLedger(ledger);
const active = bank.filter((e) => e.status === "active");

const tailTokens = Number(arg("--tail", "6000"));
const deltaTokens = Number(arg("--delta", "6000"));
const maxTokens = Number(arg("--max-tokens", "2000"));
const reasoning = arg("--reasoning", "none");

const facts = hifiFacts(bank, { lastSeq: 0, maxTokens: deltaTokens, estimate: estimateTokens });
const tailEntries = selectTail(branch, tailTokens);
const tail = tailEntries.map((e) => renderEntry(e, SETTING_DEFAULTS.maxEntryChars)).filter(Boolean);
const files = fileOperations(branch);
const prompt = buildHifiPrompt({ facts, tail: tail.join("\n"), files });

const route = await resolveRoute(arg("--model", "hy-memory/hy-memory-30b-a3b"));
const model: Model<any> = {
	id: route.model,
	name: route.model,
	api: "openai-completions",
	provider: "probe",
	baseUrl: route.origin,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: false,
	contextWindow: 131072,
	maxTokens,
};

console.log(
	`session ${sessionId}: ${branch.length} branch entries, ${active.length} active facts, ` +
		`tail ${tailEntries.length} entries`,
);
console.log(`request: ${estimateTokens(prompt)} input tokens (facts ${facts.length}, tail ${tail.length} lines)`);

const result = await hifiSummary({ model, prompt, maxTokens, timeoutMs: 240_000, reasoning, apiKey: route.apiKey });
const verdict = checkHifi(result.text, facts, result.stopReason === "length");

const outDir = arg("--out", "out/hifi");
mkdirSync(outDir, { recursive: true });
const base = join(outDir, `${sessionId}-${route.model.replace(/[^\w.-]/g, "_")}`);
writeFileSync(`${base}.md`, result.text);
writeFileSync(`${base}.prompt.txt`, prompt);

const idsInBank = new Set(active.map((e) => e.id));
const cited = [...result.text.matchAll(/\[([0-9a-f]{12})\]/g)].map((m) => m[1]);
const invented = cited.filter((id) => !idsInBank.has(id));

console.log(
	`\nwall ${Math.round(result.ms / 1000)} s, stop ${result.stopReason}, ` +
		`output ${result.usage?.output ?? 0} tokens, checkpoint ${estimateTokens(result.text)} tokens`,
);
console.log(`verdict: ${verdict.ok ? "accepted" : `REJECTED — ${verdict.reason}`}`);
console.log(
	`ids: ${verdict.idsKept}/${verdict.idsGiven} offered facts cited, ${cited.length} citations, ${invented.length} invented`,
);
console.log(
	`sections: ${["Goal", "Constraints & preferences", "Progress", "Key decisions", "Next steps", "Critical context"].filter((s) => result.text.includes(s)).length}/6`,
);
console.log(`wrote ${base}.md and ${base}.prompt.txt`);
console.log(`\n${"─".repeat(60)}\n\n${result.text}`);
