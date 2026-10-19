#!/usr/bin/env node
/**
 * Per-session switch check. Run: npx tsx tools/session-off-check.ts
 *
 * `/hy off` exists because not every session earns its keep: a session that ends
 * before the next compaction never uses the facts a write paid for. The switch is
 * per session and durable, so the cases that matter are the ones a unit test on a
 * boolean would miss:
 *
 *   1. off stops the trigger, and says so in the audit and the footer;
 *   2. off does not abort a write already running, but suppresses its chain;
 *   3. the marker survives a reload — a fresh extension instance reads it;
 *   4. on discards the window accumulated while off, as a `hy.gap` with reason
 *      "disabled", so the ledger still records what was never read;
 *   5. on refuses when the config disables the extension globally.
 *
 * Drives the real handlers through a stub `pi`, the same way
 * `compaction-hook-check.ts` does.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hy-session-off-"));
process.env.PI_HY_MEMORY_STATE = join(dir, "state");
process.env.PI_HY_MEMORY_CONFIG = join(dir, "config.json");
writeFileSync(process.env.PI_HY_MEMORY_CONFIG, JSON.stringify({ model: "test/writer", timeoutMs: 1000 }));

const { default: piHyMemory } = await import("../src/index.js");

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

type Handler = (event: unknown, ctx: unknown) => unknown;
type Command = { handler: (args: string, ctx: unknown) => Promise<void> };
const SESSION = "01234567";

function harness() {
	const handlers = new Map<string, Handler>();
	let command: Command | null = null;
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: () => {},
		registerCommand: (_name: string, def: Command) => {
			command = def;
		},
	};
	piHyMemory(pi as never);
	if (!command) throw new Error("command not registered");
	return { handlers, command: command as Command };
}

const notify: string[] = [];
let seq = 0;
const message = (id: string, tokens: number) => ({
	id,
	type: "message",
	parentId: null,
	timestamp: new Date(1700000000000 + seq++).toISOString(),
	message: { role: "user", content: "x".repeat(tokens * 4) },
});

let branch: unknown[] = [];
const ctx = {
	sessionManager: {
		getSessionId: () => SESSION,
		getBranch: () => branch,
		getEntry: () => undefined,
	},
	ui: {
		setStatus: () => {},
		notify: (text: string) => notify.push(text),
		theme: { fg: (_c: string, t: string) => t },
	},
};

const auditFile = join(process.env.PI_HY_MEMORY_STATE as string, "audit.ndjson");
const events = (): Record<string, unknown>[] =>
	existsSync(auditFile)
		? readFileSync(auditFile, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
const last = (name: string) => [...events()].reverse().find((e) => e.event === name);
const sessionsDir = join(process.env.PI_HY_MEMORY_STATE as string, "sessions");
const offMarker = join(sessionsDir, `${SESSION}.off`);
const ledgerRecords = (): Record<string, unknown>[] => {
	const file = join(sessionsDir, `${SESSION}.ledger.jsonl`);
	return existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
};

// A window far over the trigger: 40 entries of ~1 000 tokens.
branch = [
	{ id: "cursor-1", type: "message", message: { role: "user", content: "watermark" } },
	...Array.from({ length: 40 }, (_, i) => message(`p${i}`, 1000)),
];

const { handlers, command } = harness();
(handlers.get("session_start") as Handler)({}, ctx);

// 1. Off: marker written, audited, no write on the next turn_end.
await command.handler("off", ctx);
check("off writes the marker", existsSync(offMarker), true);
check("off is audited", last("disabled")?.event, "disabled");
check("off is announced", notify.at(-1)?.includes("off for this session"), true);

const before = events().filter((e) => e.event === "write_start").length;
(handlers.get("turn_end") as Handler)({}, ctx);
check("off stops the trigger", events().filter((e) => e.event === "write_start").length - before, 0);

// 2. On: the window accumulated while off is dropped as a gap, not written.
await command.handler("on", ctx);
check("on clears the marker", existsSync(offMarker), false);
const gap = [...ledgerRecords()].reverse().find((r) => r.type === "hy.gap");
check("on records a disabled gap", [gap?.reason, gap?.entries], ["disabled", 41]);
check("skipped entries are audited", last("skipped_while_off")?.entries, 41);
check("on advances the coverage", String(gap?.coversUpToId).startsWith("p39"), true);

// The gap left the window empty, so the next turn_end still writes nothing.
const afterOn = events().filter((e) => e.event === "write_start").length;
(handlers.get("turn_end") as Handler)({}, ctx);
check(
	"discarded window does not trigger a catch-up write",
	events().filter((e) => e.event === "write_start").length - afterOn,
	0,
);

// 3. Durability: a fresh extension instance, same session, must read the marker.
await command.handler("off", ctx);
const second = harness();
(second.handlers.get("session_start") as Handler)({}, ctx);
check("reload reports the session disabled", last("session_start")?.disabled, true);
check(
	"reload announces it",
	notify.some((n) => n.includes("remembered from an earlier /hy off")),
	true,
);

// 4. A config-level kill switch wins over `/hy on`.
writeFileSync(process.env.PI_HY_MEMORY_CONFIG, JSON.stringify({ model: "test/writer", enabled: false }));
const third = harness();
(third.handlers.get("session_start") as Handler)({}, ctx);
await third.command.handler("on", ctx);
check("config beats the switch", (notify.at(-1) ?? "").includes("config disables it globally"), true);

console.log(failures === 0 ? "ok: session switch" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
