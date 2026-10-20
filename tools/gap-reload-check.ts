#!/usr/bin/env node
/**
 * Gap durability check. Run: npx tsx tools/gap-reload-check.ts
 *
 * `/hy on` discards the window accumulated while the session was off and records a
 * `hy.gap` so the ledger still says what was never read. That was only ever half
 * durable: coverage is rebuilt from the session's own custom entries on reload, and
 * `ledgerFromSession` recognised `hy.extract` and `hy.ops` alone. When the session
 * copy is longer than the mirror file it wins the comparison in `reset()`, and the
 * gap vanished with it.
 *
 * Measured on session 01a15860 (2026-10-20): 450 694 tokens discarded at 17:08,
 * 428 612 pending again by 17:26, 22 `compact_deferred` after that, and every
 * compaction — automatic and manual — fell back to pi's own summariser because
 * honouring the extension's boundary would have dropped unread history.
 *
 * Three cases, driven through a stub `pi` the way `session-off-check.ts` does:
 *
 *   1. `/hy on` appends the gap as a session entry, not only to the mirror;
 *   2. a reload whose session copy is longer than the mirror still honours it;
 *   3. a sensitivity control — with the entry removed, the discarded window comes
 *      straight back, which is what the old code did.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hy-gap-reload-"));
process.env.PI_HY_MEMORY_STATE = join(dir, "state");
process.env.PI_HY_MEMORY_CONFIG = join(dir, "config.json");
writeFileSync(process.env.PI_HY_MEMORY_CONFIG, JSON.stringify({ model: "test/writer", timeoutMs: 1000 }));

// observeAfterTokens as shipped: the trigger the window must stay under.
const configTrigger = 6000;

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

let branch: unknown[] = [];
let recSeq = 0;
const statusLines: string[] = [];

function harness() {
	const handlers = new Map<string, Handler>();
	let command: Command | null = null;
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: () => {},
		registerCommand: (_name: string, def: Command) => {
			command = def;
		},
		// The real appendEntry writes a custom entry into the session file. That is the
		// only copy `ledgerFromSession` can read back after a reload, so the stub has
		// to model it or the check proves nothing.
		appendEntry: (type: string, data: unknown) => {
			branch.push({
				id: `rec-${recSeq++}`,
				type: "custom",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: type,
				data,
			});
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

/** A write record sitting in the session, covering an early entry. */
const extractRecord = (id: string, coversUpToId: string) => ({
	id,
	type: "custom",
	parentId: null,
	timestamp: new Date(1700000000000 + seq++).toISOString(),
	customType: "hy.extract",
	data: { type: "hy.extract", chunkId: "hy-01234567-001", coversUpToId, drafts: [], usage: {} },
});

const ctx = {
	sessionManager: {
		getSessionId: () => SESSION,
		getBranch: () => branch,
		getEntry: () => undefined,
	},
	ui: {
		setStatus: (_key: string, text: string | undefined) => statusLines.push(text ?? ""),
		notify: () => {},
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
const writesStarted = () => events().filter((e) => e.event === "write_start").length;

/** The first number of the footer bar: `hy ▕██░░▏ 12k/6k  ▕░░░░▏ 1.4k/5k`. */
const pendingOf = (line: string): number => {
	const m = line.match(/hy\s+▕[^▏]*▏\s+([\d.]+)(k?)/);
	if (!m) return Number.NaN;
	return Math.round(Number(m[1]) * (m[2] ? 1000 : 1));
};
const lastBar = () => [...statusLines].reverse().find((l) => l.includes("▕")) ?? "";

// A session that ran while off: 45 entries of ~1 000 tokens, plus two write records
// that cover only the first few of them.
branch = [
	...Array.from({ length: 45 }, (_, i) => message(`p${i}`, 1000)),
	extractRecord("rec-a", "p2"),
	extractRecord("rec-b", "p5"),
];

const first = harness();
(first.handlers.get("session_start") as Handler)({}, ctx);

// 1. Off, the session keeps talking, then on.
await first.command.handler("off", ctx);
branch.push(message("p45", 1000), message("p46", 1000));
await first.command.handler("on", ctx);

const gapEntry = branch.find((e) => (e as { customType?: string }).customType === "hy.gap");
check("on appends the gap as a session entry", Boolean(gapEntry), true);
check("the gap covers the newest entry", (gapEntry as { data?: { coversUpToId?: string } })?.data?.coversUpToId, "p46");

// Two more write records reached the session after the last mirror, so the session
// copy now holds 5 records against the mirror's 3 — the shape that made the
// comparison in reset() pick the session copy in the real session.
branch.push(extractRecord("rec-c", "p7"), extractRecord("rec-d", "p9"));

// 2. Reload: the gap must survive in the copy that wins.
const reloaded = harness();
statusLines.length = 0;
(reloaded.handlers.get("session_start") as Handler)({}, ctx);
const kept = pendingOf(lastBar());
console.log(`     window after reload: ${kept} tokens`);
check("reload keeps the discarded window under the trigger", kept < configTrigger, true);

const before = writesStarted();
(reloaded.handlers.get("turn_end") as Handler)({}, ctx);
check("no catch-up write for a discarded window", writesStarted() - before, 0);

// 3. Sensitivity control: strip the entry the way the old `ledgerFromSession` did,
//    and the window `/hy on` discarded comes straight back.
branch = branch.filter((e) => (e as { customType?: string }).customType !== "hy.gap");
const broken = harness();
statusLines.length = 0;
(broken.handlers.get("session_start") as Handler)({}, ctx);
const back = pendingOf(lastBar());
console.log(`     window after reload without the entry: ${back} tokens`);
check("a gap that is not a session entry lets the window back", back > 30_000, true);
console.log(failures === 0 ? "ok: gap durability" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
