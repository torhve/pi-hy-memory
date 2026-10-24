#!/usr/bin/env npx tsx

/**
 * tools/clip-check.ts — tier 4's fixture: what the writer is actually shown when arguments run long.
 *
 * src/entries.ts clips two things. Message and tool-result bodies go through clip(text, maxEntryChars) at
 * 3000 and keep a trailing `…`. Tool call arguments are cut at ARGS_WINDOW — 600 since 2026-10-24, measured
 * by `dev/clip-window-report.ts` against the 240 it replaced — and carry the same marker, so a cut call says
 * so. Upstream raised its own window from 80 to 600 for the same reason: the flags that matter are often late
 * in the line, and it keeps a regression test for exactly that.
 *
 * The fixture hands the shipped renderer two calls and asks four things of the text the writer receives:
 *
 *   1. a flag past the window is gone, and the cut announces itself with the same `…` a cut body gets
 *   2. the arguments shown are the window, exactly, and they do not close as JSON
 *   3. a flag sitting where the old 240-character window cut it now reaches the writer whole — the regression
 *      the 2026-10-24 arm priced, with the narrow window still reproducible through the measurement knob, and
 *      no shipped caller setting it
 *   4. a long *body* in the same chunk is cut at maxEntryChars and does say so, with `…`
 *
 * What this fixture cannot decide is the assertion the tier still owes: whether a visible marker changes what
 * the writer does with the missing tail, or whether it induces it to invent one. That needs a model in the
 * loop. What it can pin is the shape of the writer's view — the flag absent or present depending on the window,
 * the cut marked, the JSON still not closing, and the two clip paths agreeing on the marker.
 */

import { readFileSync } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ARGS_WINDOW, renderEntry } from "../src/entries.js";

let failures = 0;
function assert(cond: boolean, label: string): void {
	if (!cond) {
		console.error(`FAIL: ${label}`);
		failures += 1;
	}
}

const MAX_ENTRY_CHARS = 3000;

/** Past the shipped window, with the decision-relevant flag past the cut. */
const longArgs = {
	command:
		"cd repo/src/queue && go test ./internal/queue/... -run TestDrainLock -count=1 -timeout 180s -vet=off -cover -coverprofile=coverage.out 2>&1 | tail -n 120 && gofmt -l internal/queue && git diff --stat HEAD~3 && grep -rn drainTimeout internal/queue cmd/queue pkg/store && go vet ./internal/queue/... ./cmd/queue/... && ls -l coverage.out && git log --oneline -n 5 -- internal/queue && cargo clippy -p queue --all-targets --all-features && go test ./pkg/store/... -run TestPurgeAges",
	depth: 3,
	retentionDays: 90,
	description: "drain the queue with the retention flag from the manual, line 63",
	purgeAgeFlag: "--purge-age=90d",
};

/**
 * Long enough that the window this file's fixture replaced would have cut it, short enough that the shipped
 * one shows it whole. This is the value the 2026-10-24 arm measured: a flag past 240 and inside 600.
 */
const midArgs = {
	command:
		"cd repo/src/queue && go test ./internal/queue/... -run TestDrainLock -count=1 -timeout 180s -vet=off -cover 2>&1 | tail -n 60 && gofmt -l internal/queue && git diff --stat HEAD~3 && ls internal/queue && pwd",
	depth: 3,
	purgeAgeFlag: "--purge-age=90d",
};

const argsJson = JSON.stringify(longArgs);
const midJson = JSON.stringify(midArgs);
const FLAG = '"purgeAgeFlag":"--purge-age=90d"';
const LATE = "--purge-age=90d";

function entry(type: string, message: Record<string, unknown>, id: string): SessionEntry {
	return { id, type, message } as unknown as SessionEntry;
}

const assistantEntry = entry(
	"message",
	{
		role: "assistant",
		content: [
			{ type: "text", text: "Running the drain test with the retention flag." },
			{ type: "toolCall", name: "bash", arguments: longArgs },
		],
	},
	"clip-assistant",
);
const midEntry = entry(
	"message",
	{
		role: "assistant",
		content: [
			{ type: "text", text: "Running the drain test with the purge age flag." },
			{ type: "toolCall", name: "bash", arguments: midArgs },
		],
	},
	"clip-mid-assistant",
);
const longResultEntry = entry(
	"message",
	{
		role: "toolResult",
		toolName: "bash",
		isError: false,
		content: [{ type: "text", text: `output ${"x".repeat(MAX_ENTRY_CHARS + 400)} tail marker` }],
	},
	"clip-result",
);

const shortResultEntry = entry(
	"message",
	{
		role: "toolResult",
		toolName: "bash",
		isError: false,
		content: [{ type: "text", text: `output ${"y".repeat(900)}` }],
	},
	"clip-result-short",
);

const shown = renderEntry(assistantEntry, MAX_ENTRY_CHARS) ?? "";
const shownMid = renderEntry(midEntry, MAX_ENTRY_CHARS) ?? "";
const shownMidAt240 = renderEntry(midEntry, MAX_ENTRY_CHARS, 240) ?? "";
const shownLongResult = renderEntry(longResultEntry, MAX_ENTRY_CHARS) ?? "";
const shownShortResult = renderEntry(shortResultEntry, MAX_ENTRY_CHARS) ?? "";

assert(
	argsJson.length > ARGS_WINDOW,
	`the fixture's arguments must exceed the argument window, saw ${argsJson.length} chars`,
);

// 1 and 2: the flag is gone, and the cut says so.
assert(
	!shown.includes(LATE),
	`the flag past the argument window never reaches the writer, saw: ${shown.slice(0, 260)}`,
);
assert(shown.includes("[called bash {"), "the call itself is shown, so the writer knows a command ran");
assert(shown.endsWith("…]"), `a cut call announces itself with clip()'s marker, saw: ${shown.slice(-30)}`);

// The arguments the writer is shown are the window, exactly, and they do not close as JSON.
const window = shown.slice(shown.indexOf("[called bash {") + "[called bash ".length);
assert(window.endsWith("]"), "the rendered call still ends with its wrapper");
const shownArgs = window.slice(0, -1);
assert(
	shownArgs === `${argsJson.slice(0, ARGS_WINDOW)}…`,
	`the writer is shown ${ARGS_WINDOW} characters of arguments and one marker, saw ${shownArgs.length}`,
);
let closed = true;
try {
	JSON.parse(shownArgs);
} catch {
	closed = false;
}
assert(!closed, "the marker says text was removed, but the arguments still never close as JSON");

// 3: a flag sitting between the window this replaced and the shipped one now reaches the writer. This is the
// regression the 2026-10-24 arm priced: the same entry, the same renderer, only the window differing.
assert(
	midJson.length > 240 && midJson.length <= ARGS_WINDOW,
	`the mid call must sit past the window 600 replaced and inside the shipped one, saw ${midJson.length} chars at a ${ARGS_WINDOW}-char window`,
);
assert(shownMid.includes(FLAG), `the shipped window shows the flag the old one cut, saw ${shownMid.length} chars`);
assert(!shownMid.includes("…"), "a call inside the window carries no marker");
assert(!shownMidAt240.includes(LATE), "at 240 the same entry hides that flag — the loss the arm measured");
assert(shownMidAt240.endsWith("…]"), "and the narrow render says it cut");
assert(
	renderEntry(assistantEntry, MAX_ENTRY_CHARS) === shown,
	"leaving the window unset reproduces the shipped render exactly",
);
const shippedCallers = ["src/index.ts", "src/flush.ts"]
	.map((f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8"))
	.join("\n");
assert(!shippedCallers.includes("maxArgChars"), "no shipped caller sets the window — only a measurement harness may");

// 4: a long body is cut too, and that cut announces itself.
assert(shownLongResult.includes("…"), "clip() leaves the trailing marker on a body it cut");
const body = shownLongResult.slice(shownLongResult.indexOf("]: ") + 3);
assert(
	body.length === MAX_ENTRY_CHARS + 1,
	`the body is cut at maxEntryChars and keeps one marker, saw ${body.length - 1}`,
);
assert(body.endsWith("…"), "the marker is the last thing the writer reads");
assert(!shownShortResult.includes("…"), "a body inside the window carries no marker");

if (failures === 0) {
	console.log(
		`ok: clip fixture — a ${argsJson.length}-character argument list reaches the writer as ${ARGS_WINDOW} ` +
			`characters plus clip()'s visible …, with ${LATE} past the window and the arguments still not ` +
			`closing as JSON; a ${midJson.length}-character call whose flag sits past 240 is shown whole, and ` +
			`the same entry at 240 hides it; a body over ${MAX_ENTRY_CHARS} is cut with the same marker`,
	);
} else {
	console.error(`FAIL: ${failures} clip assertion(s) failed`);
	process.exit(1);
}
