#!/usr/bin/env node
/**
 * Idle-timer check. Run: npx tsx tools/idle-timer-check.ts
 *
 * `idle-drain-check.ts` pins the policy; this one pins the wiring, because the
 * defect was that *nothing ever called it*. The extension's only write trigger was
 * `turn_end`, so a session that is reloaded and then left open never drains —
 * measured on session 01a15860 (2026-10-20): reloaded at 18:40 with 352 000 tokens
 * unread, `writes: 0` afterwards because no turn ran.
 *
 * Drives the real handlers through a stub `pi` with `idleDrainAfterMs` set to 1.2 s,
 * then waits. The three things worth proving: the timer does not fire while the
 * session is merely under the threshold, it does fire once the backlog reaches 4×
 * the trigger, and `/hy off` silences it.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hy-idle-timer-"));
process.env.PI_HY_MEMORY_STATE = join(dir, "state");
process.env.PI_HY_MEMORY_CONFIG = join(dir, "config.json");
const TRIGGER = 10_000;
const IDLE_MS = 1_200;
writeFileSync(
	process.env.PI_HY_MEMORY_CONFIG,
	JSON.stringify({
		model: "test/writer",
		timeoutMs: 1000,
		observeAfterTokens: TRIGGER,
		idleDrainAfterMs: IDLE_MS,
		writeCooldownS: 0,
	}),
);

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

let seq = 0;
const message = (id: string, tokens: number) => ({
	id,
	type: "message",
	parentId: null,
	timestamp: new Date(1700000000000 + seq++).toISOString(),
	message: { role: "user", content: "x".repeat(tokens * 4) },
});
/** `count` entries of ~1 000 tokens each, plus a watermark entry the cursor can sit on. */
const window = (count: number) => [
	{ id: "cursor-1", type: "message", message: { role: "user", content: "watermark" } },
	...Array.from({ length: count }, (_, i) => message(`p${i}`, 1000)),
];

const auditFile = join(process.env.PI_HY_MEMORY_STATE as string, "audit.ndjson");
const events = (): Record<string, unknown>[] =>
	existsSync(auditFile)
		? readFileSync(auditFile, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
const drains = (sessionId: string) => events().filter((e) => e.event === "idle_drain" && e.sessionId === sessionId);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ctxOf = (sessionId: string, branch: unknown[]) => ({
	sessionManager: {
		getSessionId: () => sessionId,
		getBranch: () => branch,
		getEntry: () => undefined,
	},
	ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_c: string, t: string) => t } },
});

// 1. Three times the trigger: a turn would handle it, an idle timer must not spend
//    a writer call on it.
const branch1 = window(30);
const ctx1 = ctxOf("01234567", branch1);
const a = harness();
(a.handlers.get("session_start") as Handler)({}, ctx1);
await wait(IDLE_MS * 2);
check("under the idle threshold stays quiet", drains("01234567").length, 0);

// 2. Four times the trigger, still no turn: this is the case the timer exists for.
branch1.push(...Array.from({ length: 10 }, (_, i) => message(`q${i}`, 1000)));
await wait(IDLE_MS * 2);
const fired = drains("01234567");
check("idle backlog drains without a turn", fired.length >= 1, true);
check(
	"drain audited with its threshold",
	[fired.at(-1)?.thresholdTokens, Number(fired.at(-1)?.pendingTokens ?? 0) >= 40_000],
	[40_000, true],
);
check(
	"drain starts a write",
	events().some((e) => e.event === "write_start" && e.sessionId === "01234567"),
	true,
);

// 3. A session the user switched off must not be written to by a timer. Fresh
//    instance and fresh session, so a failed write above cannot explain the result.
const ctx2 = ctxOf("89abcdef", window(40));
const b = harness();
(b.handlers.get("session_start") as Handler)({}, ctx2);
await b.command.handler("off", ctx2);
await wait(IDLE_MS * 2);
check("/hy off silences the timer", drains("89abcdef").length, 0);

console.log(failures === 0 ? "ok: idle timer wiring" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
