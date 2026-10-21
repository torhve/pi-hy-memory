#!/usr/bin/env node
/**
 * Flush tool check: run: npx tsx tools/flush-tool-check.ts
 *
 * `tools/flush-check.ts` pins the pure rules. This exercises the wiring in
 * `src/index.ts`, which is where the two-step surface could break: the listing has to
 * show only what the watermark has not reached, the ranged call has to queue a write and
 * return at once (a synchronous tool would hold the turn for the 28–52 s the extract
 * costs), and a second call while that write is running has to be refused rather than
 * stacked.
 *
 * The writer is deliberately unreachable: the tool answers before the model call, so the
 * assertions do not depend on an endpoint, and the audit line is the record of what the
 * model asked for.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hy-flush-tool-check-"));
process.env.PI_HY_MEMORY_STATE = join(dir, "state");
process.env.PI_HY_MEMORY_CONFIG = join(dir, "config.json");

const baseConfig = {
	model: "test/writer",
	// A blackhole address, not a refused port: a refused connect clears the in-flight
	// write in milliseconds and the "busy writer refuses" assertion would then race it.
	origin: "http://10.255.255.1:80/v1",
	timeoutMs: 2000,
	observeAfterTokens: 100_000,
	writeCooldownS: 0,
	// This window is a handful of entries, so the floor is off here; the floor itself is pinned
	// by `tools/flush-check.ts` and asserted against the wiring further down.
	flushMinTokens: 0,
};
writeFileSync(join(dir, "config.json"), JSON.stringify(baseConfig));

const { default: piHyMemory } = await import("../src/index.js");

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};
const has = (name: string, text: string, needle: string): void => check(name, text.includes(needle), true);

type ToolDef = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
};

const message = (id: string, role: string, content: string) => ({ type: "message", id, message: { role, content } });
const branch = [
	message("e1", "user", "The watermark sits at the first entry, so two are unwritten."),
	message("e2", "assistant", "A flush names the end of the range and never the start."),
	message("e3", "user", "Queue it and answer immediately."),
];

const faux = () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const tools = new Map<string, ToolDef>();
	const appended: { type: string; data: unknown }[] = [];
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(name, handler);
		},
		registerTool: (def: ToolDef) => {
			tools.set(def.name, def);
		},
		registerCommand: () => {},
		appendEntry: (type: string, data: unknown) => {
			appended.push({ type, data });
		},
	};
	return { pi, handlers, tools, appended };
};

const ctx = {
	sessionManager: {
		getSessionId: () => "01234567",
		getBranch: () => [
			branch[0],
			{ id: "c1", type: "custom", customType: "hy.extract", data: extractRecord },
			{ id: "c2", type: "custom", customType: "hy.ops", data: opsRecord },
			branch[1],
			branch[2],
		],
		getEntry: (id: string) => branch.find((e) => e.id === id),
	},
	// pi's own ctx throws once a session is replaced; the extension must not need the UI.
	hasUI: false,
	ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_c: string, t: string) => t } },
	modelRegistry: {},
};

const extractRecord = {
	type: "hy.extract",
	chunkId: "hy-01234567-001",
	coversUpToId: "e1",
	createdAt: "2026-10-21T00:00:00.000Z",
	drafts: [{ task: "coverage", statement: "the watermark is at e1", keys: ["coverage"], refs: [0] }],
	rejectedCount: 0,
	usage: { inTokens: 1, outTokens: 1, wallS: 1 },
};
const opsRecord = {
	type: "hy.ops",
	chunkId: "hy-01234567-001",
	coversUpToId: "e1",
	createdAt: "2026-10-21T00:00:00.000Z",
	ops: [{ action: "ADD", draft: 0 }],
	rejectedCount: 0,
	usage: { inTokens: 1, outTokens: 1, wallS: 1 },
};

const first = faux();
piHyMemory(first.pi as never);
const flush = () => first.tools.get("hy_flush") as ToolDef;
const textOf = async (params: Record<string, unknown>): Promise<string> => {
	const result = await flush().execute("t1", params, undefined, undefined, ctx);
	return result.content.map((b) => b.text).join("\n");
};

check("both tools are registered", [...first.tools.keys()].sort(), ["hy_flush", "hy_recall"]);

// 1. No session started yet: there is no window to list and nothing to write.
has("before session_start it says so", await textOf({}), "no bank for this session yet");

(first.handlers.get("session_start") as (e: unknown, c: unknown) => unknown)(undefined, ctx);

// 2. The bare call lists what the watermark has not reached, and names the call that works.
const listing = await textOf({});
check(
	"listing numbers from 0",
	listing.split("\n")[0],
	"[0] assistant: A flush names the end of the range and never the start.",
);
check("listing stops at the newest entry", listing.split("\n")[1], "[1] user: Queue it and answer immediately.");
check("listing excludes what is already covered", listing.includes("The watermark sits at the first entry"), false);
has("listing names the call", listing, "call hy_flush with to=1");

// 3. A range queues and answers without waiting for the writer.
const accepted = await flush().execute("t2", { to: 99 }, undefined, undefined, ctx);
const queued = accepted.content.map((b) => b.text).join("\n");
has("queued answer", queued, "queued: entries [0]–[1]");
has("the clamp is reported", queued, "(to=99 clamped to 1)");
const details = accepted.details as { chunkId?: string; entries?: number } | undefined;
check("details name the chunk and how much of it", [typeof details?.chunkId, details?.entries], ["string", 2]);
// 4. A second call while that write is in flight is refused, not stacked.
const busy = await textOf({ to: 1 });
has("a busy writer refuses", busy, "not written (write in flight)");

// 5. Off means no tool at all, so no prompt surface either.
writeFileSync(join(dir, "config.json"), JSON.stringify({ ...baseConfig, flushTool: false }));
const second = faux();
piHyMemory(second.pi as never);
check("flushTool: false registers no flush tool", second.tools.has("hy_flush"), false);
check("recall still registers", second.tools.has("hy_recall"), true);

const audit = readFileSync(join(dir, "state", "audit.ndjson"), "utf8")
	.split("\n")
	.filter((l) => l.trim())
	.map((l) => JSON.parse(l) as Record<string, unknown>);
const flushLines = audit.filter((a) => a.event === "hy_flush");
check("the flush is audited once per accepted call", flushLines.length, 1);
check("the audit names the requested and applied range", flushLines[0]?.applied, { from: 0, to: 1 });
check("the audit records the clamp", flushLines[0]?.clampedTo, 99);
const skipped = audit.filter((a) => a.event === "flush_skipped");
check(
	"the refusal is audited with its reason",
	skipped.map((s) => s.reason),
	["write in flight"],
);

// 6. The token floor is enforced by the wiring, not only by the gate: a thin window is refused and
// the listing says what a write needs, because a model that ignores a refusal still sees the number.
writeFileSync(join(dir, "config.json"), JSON.stringify({ ...baseConfig, flushMinTokens: 2000 }));
const floored = faux();
piHyMemory(floored.pi as never);
(floored.handlers.get("session_start") as (e: unknown, c: unknown) => unknown)(undefined, ctx);
const flooredFlush = () => floored.tools.get("hy_flush") as ToolDef;
const floorListing = await flooredFlush().execute("t3", {}, undefined, undefined, ctx);
has("the listing states the floor", floorListing.content[0].text, "a write needs 2000.");
const thin = await flooredFlush().execute("t4", { to: 1 }, undefined, undefined, ctx);
has("a thin window is refused", thin.content[0].text, "the floor is 2000");
check("a refused flush queues no write", thin.details, undefined);
console.log(failures === 0 ? "ok: flush tool" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
