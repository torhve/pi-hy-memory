#!/usr/bin/env npx tsx
/**
 * tools/arg-window-cost-check.ts — the window cost instrument, against constructed calls of known length.
 *
 * `dev/arg-window-cost.ts` reads real session files, which no test can pin: the calls in them are whatever
 * the sessions happened to contain. This writes two session-shaped files whose calls have known argument
 * lengths, and pins what the pricing must say — a call inside the window contributes nothing, a call past it
 * contributes what the wider window shows and no more, a call past the wider window is counted as still cut,
 * and a message that is not an assistant tool call is not counted at all. It also pins that the numbers are
 * all the instrument can report: a value planted in a call's arguments appears nowhere in what it returns.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { priceWindows, sessionFiles } from "../dev/arg-window-cost.js";

const NARROW = 240;
const WIDE = 600;

function line(message: unknown): string {
	return `${JSON.stringify({ id: "x", parentId: null, timestamp: "2026-10-24T12:00:00.000Z", type: "message", message })}\n`;
}

function callLine(name: string, args: Record<string, unknown>): string {
	return line({
		role: "assistant",
		content: [{ type: "toolCall", id: "t", name, arguments: args }],
	});
}

/** A call whose serialised arguments are exactly `length` characters. */
function callOfLength(length: number): string {
	const overhead = JSON.stringify({ command: "" }).length;
	return callLine("bash", { command: "q".repeat(length - overhead) });
}

const SECRET = "a-value-the-instrument-must-not-echo";

const dir = mkdtempSync(join(tmpdir(), "arg-window-cost-"));
try {
	// One call that fits the narrow window, one that the wide window shows in full, one that the wide
	// window still cuts, and the lines that must not be counted: a user message, a tool result, a malformed
	// line, and a file with no calls at all.
	const a =
		callOfLength(200) +
		callOfLength(363) +
		callOfLength(900) +
		callLine("bash", { command: SECRET }) +
		line({ role: "user", content: [{ type: "text", text: "run the thing" }] }) +
		line({ role: "toolResult", content: [{ type: "text", text: "ok" }] }) +
		"not json at all\n";
	const b = line({ role: "user", content: [{ type: "text", text: "no calls here" }] });
	mkdirSync(join(dir, "proj-a"), { recursive: true });
	mkdirSync(join(dir, "proj-b"), { recursive: true });
	writeFileSync(join(dir, "proj-a", "session-a.jsonl"), a, "utf8");
	writeFileSync(join(dir, "proj-b", "session-b.jsonl"), b, "utf8");

	const files = sessionFiles(dir);
	const s = priceWindows(files, NARROW, WIDE);
	const secretVisible = JSON.stringify(s).includes(SECRET);

	// The planted lengths: 200 fits, 363 is shown whole only by the wide window (+123 characters), 900 is cut
	// by both and contributes exactly the wide window's extra 360. The secret-bearing call is short, so it is
	// counted like any whole call and reported as a length only — the planted value never leaves the fixture.
	const failures: string[] = [];
	const want = (label: string, got: number, expected: number): void => {
		if (got !== expected) failures.push(`${label}: got ${got}, expected ${expected}`);
	};
	want("files read", s.files, 2);
	want("files with calls", s.filesWithCalls, 1);
	want("calls counted", s.calls, 4);
	want("whole at narrow", s.wholeNarrow, 2);
	want("cut at narrow", s.cutNarrow, 2);
	want("still cut at wide", s.cutWide, 1);
	want("extra chars the wide window shows", s.extraChars, 123 + 360);
	want("longest call", s.longest, 900);
	want("total argument chars", s.totalChars, 200 + 363 + 900 + JSON.stringify({ command: SECRET }).length);
	if (s.extraTokens !== Math.ceil(s.extraChars / 4) && s.extraTokens !== Math.round(s.extraChars / 4))
		failures.push(`extra tokens: got ${s.extraTokens} for ${s.extraChars} characters`);
	if (secretVisible) failures.push("the instrument reported a value from a call's arguments, not just its length");

	if (failures.length > 0) {
		for (const failure of failures) console.error(`FAIL: ${failure}`);
		rmSync(dir, { recursive: true, force: true });
		process.exit(1);
	}
	console.log(
		`ok: ${s.calls} constructed calls priced — two whole at ${NARROW}, one adding ${123}, one adding ${WIDE - NARROW} and still cut, one file with no calls read and ignored, and nothing but lengths reported`,
	);
	rmSync(dir, { recursive: true, force: true });
} catch (error) {
	rmSync(dir, { recursive: true, force: true });
	console.error(`FAIL: ${(error as Error).message}`);
	process.exit(1);
}
