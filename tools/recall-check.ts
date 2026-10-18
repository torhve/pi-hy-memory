#!/usr/bin/env node
/**
 * Recall + config check: run: npx tsx tools/recall-check.ts
 *
 * Two gaps in coverage this closes:
 *
 * 1. **Config load.** A malformed config file used to fall back to defaults in
 *    silence — the user would run a different writer model than the one they
 *    configured, with no warning. `loadConfigFile` must distinguish "missing"
 *    (all defaults, no error) from "unparseable" (defaults + a recorded error),
 *    and the extension must audit + warn on the second.
 * 2. **hy_recall.** The recall tool is the only way a user (or the session
 *    model) reads the bank back, so its three paths — id lookup with source
 *    evidence, query scoring, and no-match — are exercised against a bank
 *    folded from real ledger records, exactly as `reset()` does it.
 *
 * The extension reads `PI_HY_MEMORY_CONFIG` / `PI_HY_MEMORY_STATE` at module
 * load, so the env is set before the dynamic import.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hy-recall-check-"));
process.env.PI_HY_MEMORY_STATE = join(dir, "state");
process.env.PI_HY_MEMORY_CONFIG = join(dir, "config.json");

const { default: piHyMemory, loadConfigFile } = await import("../src/index.js");
const { newId } = await import("../src/bank.js");

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};
const has = (name: string, text: string, needle: string): void => check(name, text.includes(needle), true);

// 1. Config load: missing vs malformed.
const configPath = join(dir, "config.json");
check(
	"missing file: defaults",
	[loadConfigFile(configPath).config.model, loadConfigFile(configPath).parseError],
	["hy-memory-30b-a3b", null],
);
writeFileSync(configPath, JSON.stringify({ model: "test/writer", poolMaxTokens: 9999 }));
check(
	"valid file: merged over defaults",
	[loadConfigFile(configPath).config.model, loadConfigFile(configPath).config.poolMaxTokens],
	["test/writer", 9999],
);
writeFileSync(configPath, "{ not valid json");
const malformed = loadConfigFile(configPath);
check(
	"malformed file: defaults + error",
	[malformed.config.model, malformed.parseError !== null],
	["hy-memory-30b-a3b", true],
);

// 2. The extension, from a bank folded out of ledger records in the branch.
const sourceEntry = {
	id: "e-src-1",
	type: "message",
	message: { role: "user", content: "use llama-swap at 127.0.0.1:8080" },
} as never;
const extractRecord = {
	type: "hy.extract",
	chunkId: "hy-01234567-001",
	coversUpToId: "e-src-1",
	createdAt: "2026-10-18T00:00:00.000Z",
	drafts: [
		{
			task: "llama-swap",
			statement: "llama-swap serves the writer model locally at 127.0.0.1:8080",
			keys: ["llama-swap"],
			confidence: 1,
			refs: [0],
			sourceEntryIds: ["e-src-1"],
		},
	],
	rejectedCount: 0,
	usage: { inTokens: 1, outTokens: 1, wallS: 1 },
};
const opsRecord = {
	type: "hy.ops",
	chunkId: "hy-01234567-001",
	coversUpToId: "e-src-1",
	createdAt: "2026-10-18T00:00:00.000Z",
	ops: [{ action: "ADD", draft: 0 }],
	rejectedCount: 0,
	usage: { inTokens: 1, outTokens: 1, wallS: 1 },
};
const branch = [
	sourceEntry,
	{ id: "c1", type: "custom", customType: "hy.extract", data: extractRecord } as never,
	{ id: "c2", type: "custom", customType: "hy.ops", data: opsRecord } as never,
];

type ToolDef = {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
};
const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
let tool: ToolDef | null = null;
const pi = {
	on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
		handlers.set(name, handler);
	},
	registerTool: (def: ToolDef) => {
		tool = def;
	},
	registerCommand: () => {},
};

const ctx = {
	sessionManager: {
		getSessionId: () => "01234567",
		getBranch: () => branch,
		getEntry: (id: string) => (id === "e-src-1" ? sourceEntry : undefined),
	},
	ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_c: string, t: string) => t } },
};

piHyMemory(pi as never);
check("tool registered", tool !== null, true);

const recall = async (params: Record<string, unknown>): Promise<string> => {
	const result = await (tool as ToolDef).execute("t1", params, undefined, undefined, ctx);
	return result.content.map((b) => b.text).join("\n");
};

// No session started yet: no bank.
has("no bank before session_start", await recall({ id: newId("hy-01234567-001:0:ADD") }), "no bank for this session");

(handlers.get("session_start") as (e: unknown, ctx: unknown) => unknown)(undefined, ctx);

const factId = newId("hy-01234567-001:0:ADD");
// Id lookup: the fact plus the exact source text behind it.
const byId = await recall({ id: factId });
has("id lookup: statement", byId, "llama-swap serves the writer model locally at 127.0.0.1:8080");
has("id lookup: evidence header", byId, "Source evidence:");
has("id lookup: source text", byId, "[User]: use llama-swap at 127.0.0.1:8080");
// Query: token match scores the entry.
has("query: match found", await recall({ query: "llama-swap" }), "llama-swap serves the writer model");
// No match: says so, and reports the bank size.
has("query: no match", await recall({ query: "zebra-unrelated" }), "No facts match");
has("query: bank size reported", await recall({ query: "zebra-unrelated" }), "1 facts in the bank");
// Unknown id.
has("unknown id", await recall({ id: "000000000000" }), "No fact with id 000000000000");

// 3. Malformed config: the extension must not crash, and must record the error.
writeFileSync(configPath, "{ broken on purpose");
const handlers2 = new Map<string, (event: unknown, ctx: unknown) => unknown>();
let crashed = false;
try {
	piHyMemory({
		on: (name: string, handler: (e: unknown, c: unknown) => unknown) => {
			handlers2.set(name, handler);
		},
		registerTool: () => {},
		registerCommand: () => {},
	} as never);
	(handlers2.get("session_start") as (e: unknown, c: unknown) => unknown)(undefined, ctx);
} catch {
	crashed = true;
}
check("malformed config: session_start survives", crashed, false);
const audit = readFileSync(join(dir, "state", "audit.ndjson"), "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line) as { event: string });
check(
	"malformed config: audited",
	audit.some((row) => row.event === "config_parse_failed"),
	true,
);

console.log(failures === 0 ? "ok: recall + config load" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
