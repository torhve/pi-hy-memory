#!/usr/bin/env npx tsx

/**
 * tools/clip-check.ts — tier 4's fixture: what the writer is actually shown when arguments run long.
 *
 * src/entries.ts clips two things differently and DESIGN.md now says so. Message and tool-result bodies
 * go through clip(text, maxEntryChars) at 3000 and keep a trailing `…`. Tool call arguments go through
 * JSON.stringify(...).slice(0, 240) and keep nothing at all. Upstream raised its own argument window
 * from 80 to 600 because 80 cut real flags, and keeps a regression test for that; ours is 240, silent.
 *
 * The fixture hands the shipped renderer a call whose decision-relevant flag sits late in its arguments
 * and asks four things of the text the writer receives:
 *
 *   1. the flag is gone from it
 *   2. nothing in it says anything was removed — no marker, no gap, no sign
 *   3. the same call at a 600-character window keeps the flag, so the loss is the window and not the
 *      content
 *   4. a long *body* in the same chunk is cut at maxEntryChars and does say so, with `…`
 *
 * What this fixture cannot decide is the last assertion the tier plans — that a visible marker does not
 * induce the writer to invent the missing tail. That needs a model in the loop. What it can pin is that
 * the silent case has nothing for the writer to react to at all, which is the precondition for the
 * question, and that the two clip paths really differ.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { renderEntry } from "../src/entries.js";

let failures = 0;
function assert(cond: boolean, label: string): void {
	if (!cond) {
		console.error(`FAIL: ${label}`);
		failures += 1;
	}
}

const MAX_ENTRY_CHARS = 3000;

/** A command long enough to pass the 240-character argument window, with the flag late in it. */
const longArgs = {
	command:
		"cd repo/src/queue && go test ./internal/queue/... -run TestDrainLock -count=1 -timeout 180s -vet=off -cover -coverprofile=coverage.out 2>&1 | tail -n 120 && gofmt -l internal/queue && git diff --stat HEAD~3",
	depth: 3,
	retentionDays: 90,
	purgeAgeFlag: "--purge-age=90d",
	description: "drain the queue with the retention flag from the manual, line 63",
};

const argsJson = JSON.stringify(longArgs);
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
const shownLongResult = renderEntry(longResultEntry, MAX_ENTRY_CHARS) ?? "";
const shownShortResult = renderEntry(shortResultEntry, MAX_ENTRY_CHARS) ?? "";

assert(argsJson.length > 240, `the fixture's arguments must exceed the argument window, saw ${argsJson.length} chars`);

// 1 and 2: the flag is gone, and nothing in the writer's view says so.
assert(!shown.includes(LATE), `the flag past 240 characters never reaches the writer, saw: ${shown.slice(0, 260)}`);
assert(shown.includes("[called bash {"), "the call itself is shown, so the writer knows a command ran");
assert(!shown.includes("…"), "and the cut leaves no marker of any kind: no gap, no ellipsis, no sign");

// The arguments the writer is shown are the window, exactly, and they do not close as JSON.
const window = shown.slice(shown.indexOf("[called bash {") + "[called bash ".length);
assert(window.endsWith("]"), "the rendered call still ends with its wrapper");
const shownArgs = window.slice(0, -1);
assert(shownArgs.length === 240, `the writer is shown exactly 240 characters of arguments, saw ${shownArgs.length}`);
let closed = true;
try {
	JSON.parse(shownArgs);
} catch {
	closed = false;
}
assert(!closed, "and what it is shown is JSON that never closes — the observable signature of the silent cut");

// 3: the same call at the window upstream uses keeps the flag, so the loss is the window.
const at600 = JSON.stringify(longArgs).slice(0, 600);
assert(at600.includes(FLAG), `a 600-character window shows the flag this one hides, saw ${at600.length} chars`);
assert(
	JSON.stringify(longArgs).slice(0, 240).length === 240,
	"and the shipped window truncates this same string rather than fitting it",
);

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
		`ok: clip fixture — a ${argsJson.length}-character argument list reaches the writer as ${shownArgs.length} silent ` +
			`characters with ${LATE} missing, while a body over ${MAX_ENTRY_CHARS} is cut with a visible …`,
	);
} else {
	console.error(`FAIL: ${failures} clip assertion(s) failed`);
	process.exit(1);
}
