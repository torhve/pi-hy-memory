#!/usr/bin/env node
/**
 * Footer window check. Run: npx tsx tools/status-window-check.ts
 *
 * The first bar is the unread window: how much text has accumulated since the
 * writer last covered it. It is only honest if it is re-read every turn. A bar
 * frozen at session_start keeps the user looking at an empty window while a
 * write extracts 26 entries — the bug this check exists to catch.
 *
 * Drives the real session_start and turn_end through a stub pi, the way
 * session-off-check.ts does, and reads the footer text the status bar hands
 * to the ctx.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hy-status-window-"));
process.env.PI_HY_MEMORY_STATE = join(dir, "state");
process.env.PI_HY_MEMORY_CONFIG = join(dir, "config.json");
writeFileSync(process.env.PI_HY_MEMORY_CONFIG, JSON.stringify({ model: "test/writer", observeAfterTokens: 6000 }));

const { default: piHyMemory } = await import("../src/index.js");

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
const pi = {
	on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
	registerTool: () => {},
	registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
		commands.set(name, def),
};
piHyMemory(pi as never);

let seq = 0;
const message = (id: string, tokens: number) => ({
	id,
	type: "message",
	parentId: null,
	timestamp: new Date(1700000000000 + seq++).toISOString(),
	message: { role: "user", content: "x".repeat(tokens * 4) },
});

const footer: string[] = [];
const branch: unknown[] = [message("seed", 1000)];
const ctx = {
	sessionManager: {
		getSessionId: () => "status-window",
		getBranch: () => branch,
		getEntry: () => undefined,
	},
	ui: {
		setStatus: (_key: string, text: string | undefined) => {
			if (text !== undefined) footer.push(text);
		},
		notify: () => {},
		theme: { fg: (_c: string, t: string) => t },
	},
};

const lastFooter = () => footer.at(-1) ?? "";

// 1. session_start: the bar shows the window it found.
(handlers.get("session_start") as (e: unknown, c: unknown) => unknown)({}, ctx);
check("session start shows the window", lastFooter().includes("1k/6k"), true);

// 2. The window grows during the turn; turn_end must re-read it.
branch.push(message("a1", 1000), message("a2", 1000), message("a3", 1000));
(handlers.get("turn_end") as (e: unknown, c: unknown) => unknown)({}, ctx);
check("turn_end shows the grown window", lastFooter().includes("4k/6k"), true);

branch.push(message("a4", 1000));
(handlers.get("turn_end") as (e: unknown, c: unknown) => unknown)({}, ctx);
check("second turn_end keeps advancing the bar", lastFooter().includes("5k/6k"), true);

// 3. Off: the footer switches to the off bar, which is honest about the switch.
await commands.get("hy")?.handler("off", ctx);
check("off switches the footer", lastFooter().includes("hy off"), true);

console.log(failures === 0 ? "ok: footer window" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
