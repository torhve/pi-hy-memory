#!/usr/bin/env npx tsx
/**
 * Hi-fi probe: one real checkpoint from a real session, on the model you would actually run.
 *
 *   npx tsx dev/hifi-probe.ts --session <pi session .jsonl> [--model <provider/id>]
 *       [--reasoning off] [--thinking-format qwen-chat-template] [--off-value none]
 *       [--thinking-budget-field thinking_budget] [--tail 6000] [--delta 6000]
 *       [--max-tokens 4000] [--out out/hifi]
 *       [--previous <checkpoint .md>] [--last-seq <chunk>]   # a second boundary: the facts
 *       the checkpoint above dropped are the ones offered
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
// pi's own levels. "off" means pi sends no reasoning effort, which for a qwen-format server
// becomes an explicit enable_thinking:false. A word the endpoint invented ("none") is not a
// pi level and silently changes nothing.
const reasoningRaw = arg("--reasoning", "off");
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
if (!LEVELS.includes(reasoningRaw)) {
	console.error(`--reasoning must be one of ${LEVELS.join(", ")} (got "${reasoningRaw}")`);
	process.exit(1);
}
const reasoning = reasoningRaw as "off";
// Which knob tells *this* server to stop thinking. pi auto-detects the format from the URL,
// and an auto-detected guess is what produced the empty answers: the payload carried no
// reasoning field at all while the model emitted a thinking block. A Qwen-style server takes
// enable_thinking, an OpenAI-style one takes reasoning_effort, and the two are not
// interchangeable. `off-value` is pi's thinkingLevelMap.off, the endpoint's own word for off.
const thinkingFormat = arg("--thinking-format", "");
const offValue = arg("--off-value", "");
const budgetField = arg("--thinking-budget-field", "");

// A second boundary: `--previous` is the checkpoint the last one produced and `--last-seq`
// the chunk it covered, so the facts offered here are exactly the ones that checkpoint
// dropped — which is the self-healing claim, tested against a real model rather than a faux.
const previousPath = arg("--previous", "");
const previous = previousPath ? readFileSync(previousPath, "utf8") : "";
const lastSeq = Number(arg("--last-seq", "0"));
const facts = hifiFacts(bank, { lastSeq, previous, maxTokens: deltaTokens, estimate: estimateTokens });
const tailEntries = selectTail(branch, tailTokens);
const tail = tailEntries.map((e) => renderEntry(e, SETTING_DEFAULTS.maxEntryChars)).filter(Boolean);
const files = fileOperations(branch);
const prompt = buildHifiPrompt({ previous, facts, tail: tail.join("\n"), files, budgetTokens: maxTokens });

const route = await resolveRoute(arg("--model", "hy-memory/hy-memory-30b-a3b"));
const model: Model<any> = {
	id: route.model,
	name: route.model,
	api: "openai-completions",
	provider: "probe",
	baseUrl: route.origin,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	// Declared as a reasoning model so pi's reasoning machinery runs at all: with
	// reasoning:false it sends no reasoning field whatever the caller asks, which is how
	// the server ends up thinking by default.
	reasoning: true,
	...(offValue ? { thinkingLevelMap: { off: offValue } } : {}),
	compat: {
		...(thinkingFormat ? { thinkingFormat: thinkingFormat as "qwen" } : {}),
		...(offValue ? { supportsReasoningEffort: true } : {}),
		...(budgetField ? { thinkingTokenBudgetField: budgetField as "thinking_budget" } : {}),
		// Deliberately without omitWhenOff: with reasoning off this resolves to an explicit
		// false. Omitting the field is exactly what let the server think by default.
		...(thinkingFormat.includes("chat-template")
			? { chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } } }
			: {}),
	} as Model<any>["compat"],
	contextWindow: 131072,
	maxTokens,
};

console.log(
	`session ${sessionId}: ${branch.length} branch entries, ${active.length} active facts, ` +
		`tail ${tailEntries.length} entries`,
);
console.log(`request: ${estimateTokens(prompt)} input tokens (facts ${facts.length}, tail ${tail.length} lines)`);

const payload: Record<string, any> = {};
const result = await hifiSummary({
	model,
	prompt,
	maxTokens,
	timeoutMs: 240_000,
	reasoning,
	apiKey: route.apiKey,
	onPayload: (raw) => Object.assign(payload, raw as Record<string, any>),
});
const verdict = checkHifi(result.text, facts, result.stopReason === "length", {
	outputTokens: result.usage?.output ?? 0,
});

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
console.log(`thinking tokens: ${result.usage?.reasoning ?? "not reported"} of ${result.usage?.output ?? 0} output`);
console.log(`content blocks: ${JSON.stringify(result.blocks)}`);
const body = (payload.body ?? payload) as Record<string, any>;
console.log(`payload keys: ${Object.keys(body).join(", ")}`);
console.log(
	`payload reasoning fields: ${JSON.stringify({
		reasoning_effort: body.reasoning_effort,
		chat_template_kwargs: body.chat_template_kwargs,
		thinking_format_sent: thinkingFormat,
		enable_thinking: body.enable_thinking,
		thinking_budget: body.thinking_budget ?? body.thinking_token_budget ?? body.thinking_budget_tokens,
		max_tokens: body.max_tokens ?? body.max_completion_tokens,
	})}`,
);
console.log(
	`ids: ${verdict.idsKept}/${verdict.idsGiven} offered facts cited, ${cited.length} citations, ${invented.length} invented`,
);
console.log(
	`sections: ${["Goal", "Constraints & preferences", "Progress", "Key decisions", "Next steps", "Critical context"].filter((s) => result.text.includes(s)).length}/6`,
);
console.log(`wrote ${base}.md and ${base}.prompt.txt`);
console.log(`\n${"─".repeat(60)}\n\n${result.text}`);
