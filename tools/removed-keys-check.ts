#!/usr/bin/env node
/**
 * Removed-key notice: run: npx tsx tools/removed-keys-check.ts
 *
 * `hy_flush` was removed on measurement and `src/config.ts` keeps `REMOVED_KEYS`. A config
 * that still sets those settings must say so at startup: a tool that stops existing in
 * silence reads as a broken extension. This pins three things — the notice names the stale
 * keys and the reason, a config carrying both the removed keys and the older legacy keys
 * gets one message covering both (`warn` notifies once per process), and a clean config
 * stays quiet.
 *
 * The extension reads `PI_HY_MEMORY_CONFIG` / `PI_HY_MEMORY_STATE` at module load, so each
 * case re-runs this file as a child with its own scratch config and state directory. The
 * child answers with one JSON line.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Case = { name: string; config: Record<string, unknown> };

const CASES: Case[] = [
	{ name: "removed keys set", config: { flushTool: true, flushListEntries: 5 } },
	{ name: "legacy and removed together", config: { poolMaxTokens: 30000, flushMinTokens: 1234 } },
	{ name: "clean config", config: { model: "test/writer" } },
];

const CASE = process.argv[2] === "--case" ? (process.argv[3] ?? "") : null;

if (CASE !== null) {
	const found = CASES.find((c) => c.name === CASE);
	if (!found) {
		console.error(`unknown case: ${CASE}`);
		process.exit(2);
	}
	const { default: piHyMemory } = await import("../src/index.js");
	const notices: string[] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
		registerTool: () => {},
		registerCommand: () => {},
	};
	const ctx = {
		hasUI: true,
		sessionManager: { getSessionId: () => "01234567", getBranch: () => [], getEntry: () => undefined },
		ui: {
			setStatus: () => {},
			notify: (message: string) => notices.push(message),
			theme: { fg: (_color: string, text: string) => text },
		},
	};
	piHyMemory(pi as never);
	await handlers.get("session_start")?.({}, ctx);
	const state = process.env.PI_HY_MEMORY_STATE ?? "";
	const lines = readFileSync(join(state, "audit.ndjson"), "utf8").split("\n");
	console.log(JSON.stringify({ notices, legacy: lines.filter((line) => line.includes("legacy_config")) }));
	process.exit(0);
}

let failures = 0;
const assert = (name: string, ok: boolean, detail = ""): void => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const dir = mkdtempSync(join(tmpdir(), "hy-removed-keys-"));
for (const testCase of CASES) {
	const scratch = join(dir, testCase.name.replace(/\W+/g, "-"));
	mkdirSync(scratch, { recursive: true });
	const configFile = join(scratch, "config.json");
	const stateDir = join(scratch, "state");
	writeFileSync(configFile, JSON.stringify(testCase.config));
	const result = spawnSync("npx", ["tsx", "tools/removed-keys-check.ts", "--case", testCase.name], {
		encoding: "utf8",
		env: { ...process.env, PI_HY_MEMORY_CONFIG: configFile, PI_HY_MEMORY_STATE: stateDir },
	});
	const label = `${testCase.name}:`;
	if (result.status !== 0) {
		assert(`${label} the case ran`, false, `exit ${result.status}: ${result.stderr.slice(0, 200)}`);
		continue;
	}
	const jsonLine = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("{"))
		.pop();
	if (!jsonLine) {
		assert(`${label} the case reported`, false, `no JSON line in:\n${result.stdout}`);
		continue;
	}
	const seen = JSON.parse(jsonLine) as { notices: string[]; legacy: string[] };
	const message = seen.notices.join(" | ");
	const auditedKeys = seen.legacy.join(" ");

	if (testCase.name === "clean config") {
		assert(`${label} no notice`, seen.notices.length === 0, message);
		assert(`${label} no legacy audit`, seen.legacy.length === 0, auditedKeys);
		continue;
	}
	assert(`${label} one notice`, seen.notices.length === 1, message);
	assert(`${label} says hy_flush was removed`, message.includes("hy_flush was removed"), message);
	assert(`${label} audits the keys`, seen.legacy.length === 1, auditedKeys);
	for (const key of Object.keys(testCase.config)) {
		if (key === "model") continue;
		assert(`${label} names ${key}`, message.includes(key) && auditedKeys.includes(key), message);
	}
	if (testCase.name === "legacy and removed together") {
		assert(
			`${label} covers both groups in one message`,
			message.includes("poolMaxTokens") && message.includes("flushMinTokens"),
			message,
		);
	}
}

console.log(failures === 0 ? "ok: removed-key notice" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
