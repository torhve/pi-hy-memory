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
	// The shipped default is off (item 6.4 in `RESULTS.md`); these checks exercise the opt-in.
	flushTool: true,
	writeCooldownS: 0,
	// The writer endpoint is a black hole; without this the failed attempt retries for tens of
	// seconds and the queue guard refuses the next call while it hangs.
	busyRetries: 0,
	busyBackoffMs: 0,
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
	message("e1", "user", "The watermark sits at the first entry, so the rest is unwritten."),
	message("e2", "assistant", "A flush names the end of the range and never the start."),
	message("e3", "user", "Queue it and answer immediately."),
	// Three more entries so a slice of the window is measurably smaller than the whole of it,
	// which is what the token floor has to distinguish.
	message(
		"e4",
		"assistant",
		"Coverage is monotone, so a flush that skipped the front would leave a hole in the ledger that no later write could ever mark as covered, which is why only the end of the range is exposed to the model.",
	),
	message("e5", "user", "Write the whole window rather than the part that happens to be settled."),
	message(
		"e6",
		"assistant",
		"A thin chunk is the thing the finer-boundary experiment punished, so a named range that carries too little is refused and the threshold folds those entries instead.",
	),
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
			...branch.slice(1),
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
has("listing names the call", listing, "call hy_flush with to=4");

// 3. A range queues and answers without waiting for the writer.
const accepted = await flush().execute("t2", { to: 99 }, undefined, undefined, ctx);
const queued = accepted.content.map((b) => b.text).join("\n");
has("queued answer", queued, "queued: entries [0]–[4]");
has("the clamp is reported", queued, "(to=99 clamped to 4)");
const details = accepted.details as { chunkId?: string; entries?: number } | undefined;
check("details name the chunk and how much of it", [typeof details?.chunkId, details?.entries], ["string", 5]);
// 4. A second call while that write is in flight is refused, not stacked.
const busy = await textOf({ to: 1 });
has("a busy writer refuses", busy, "not written (write in flight)");
// The refusal has to deter the retry, not just report it: a live session issued fifteen flush
// calls, nine of them while a write was already running, each burning a turn to learn the same thing.
has("the busy refusal says a write is already running", busy, "already running or queued");
has("and that repeating the range adds nothing", busy, "adds nothing");

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
check("the audit names the requested and applied range", flushLines[0]?.applied, { from: 0, to: 4 });
check("the audit records the clamp", flushLines[0]?.clampedTo, 99);
const skipped = audit.filter((a) => a.event === "flush_skipped");
check(
	"the refusal is audited with its reason",
	skipped.map((s) => s.reason),
	["write in flight"],
);

// 6. The token floor is enforced by the wiring, not only by the gate, and the listing states the
// number: a model that ignores a refusal still sees it where it asked.
// The floor applies to what a write carries, not to how big the window is: naming `to` partway up a
// window is still a thin chunk. The sizes are read back from the tool, so the pin follows the
// fixture instead of a hand-picked number.
writeFileSync(join(dir, "config.json"), JSON.stringify({ ...baseConfig, flushMinTokens: 0 }));
const openFloor = faux();
piHyMemory(openFloor.pi as never);
(openFloor.handlers.get("session_start") as (e: unknown, c: unknown) => unknown)(undefined, ctx);
const openFlush = () => openFloor.tools.get("hy_flush") as ToolDef;
const slice = await openFlush().execute("t3", { to: 1 }, undefined, undefined, ctx);
// Each accepted call queues a write against a dead endpoint; the queue guard would refuse the next
// call while that attempt is still hanging, so let it fail out first.
await new Promise((resolve) => setTimeout(resolve, baseConfig.timeoutMs + 300));
const sliceTokens = (slice.details as { tokens?: number } | undefined)?.tokens ?? 0;
check("a floor of 0 accepts a thin slice", sliceTokens > 0, true);
const wholeTokens =
	((await openFlush().execute("t4", { to: 3 }, undefined, undefined, ctx)).details as { tokens?: number } | undefined)
		?.tokens ?? 0;
check("the whole window carries more than the slice", wholeTokens > sliceTokens, true);
await new Promise((resolve) => setTimeout(resolve, baseConfig.timeoutMs + 300));

writeFileSync(join(dir, "config.json"), JSON.stringify({ ...baseConfig, flushMinTokens: sliceTokens + 1 }));
const floored = faux();
piHyMemory(floored.pi as never);
(floored.handlers.get("session_start") as (e: unknown, c: unknown) => unknown)(undefined, ctx);
const flooredFlush = () => floored.tools.get("hy_flush") as ToolDef;
const floorListing = await flooredFlush().execute("t5", {}, undefined, undefined, ctx);
has("the listing states the floor", floorListing.content[0].text, "a write needs");
const thin = await flooredFlush().execute("t6", { to: 1 }, undefined, undefined, ctx);
has("that same slice is refused once the floor is above it", thin.content[0].text, "a write needs");
has("and it names the amount the write would have carried", thin.content[0].text, `carry ${sliceTokens}`);
check("a refused flush queues no write", thin.details, undefined);
const fat = await flooredFlush().execute("t7", { to: 4 }, undefined, undefined, ctx);
const fatTokens = (fat.details as { tokens?: number } | undefined)?.tokens ?? 0;
// Each instance is its own closure with its own estimate, so the pin is the ordering, not an
// exact count: the slice the floor stopped is smaller than the whole window that cleared it.
check("the whole window still clears that floor", fatTokens > sliceTokens, true);
console.log(failures === 0 ? "ok: flush tool" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
