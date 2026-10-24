#!/usr/bin/env npx tsx
/**
 * tools/clip-window-check.ts — the 240-against-600 harness pinned with known answers.
 *
 * `dev/clip-window-report.ts` refuses a spec whose hidden value is not strictly between the two windows,
 * because a value past both windows or inside both produces a null result that looks like a finding. This
 * check breaks that rule on purpose, four ways, and requires the harness to refuse each one by name:
 *
 *   1. the committed spec renders, with every declared value invisible at 240 and readable at 600, its
 *      control readable at both, and the two arms identical everywhere except the arguments;
 *   2. a value inside the narrow window is refused — that arm can read it, so there is nothing to compare;
 *   3. a value past both windows is refused — both arms are blind, which is the same null result;
 *   4. a control chunk whose value the narrow arm cannot read is refused, because then a lost control value
 *      would be indistinguishable from a lost hidden one.
 *
 * It also asserts the window knob is still unset in shipped code, which is what keeps the arms a measurement
 * rather than a behaviour change.
 */

import { readFileSync } from "node:fs";
import { CHUNKS, type ClipChunk, REPLACED_WINDOW, renderChunks } from "../dev/clip-window-report.js";
import { ARGS_WINDOW, renderEntry, serializeEntries } from "../src/entries.js";

let failures = 0;
function assert(cond: boolean, label: string): void {
	if (!cond) {
		console.error(`FAIL: ${label}`);
		failures++;
	}
}

function refuses(fn: () => void, expect: string, label: string): void {
	try {
		fn();
		assert(false, `${label}: the harness accepted it instead of refusing`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(
			message.includes(expect),
			`${label}: refused, but not by the rule under test — expected "${expect}" in: ${message}`,
		);
	}
}

/** A call long enough that the value lands past both windows: 60 named entries is a real batch drain. */
function veryLongHead(hide: string): string {
	const drops = Array.from({ length: 60 }, (_, i) => `--drop entry-${i}`).join(" ");
	return `queue drain --state store/queue ${drops} ${hide}`;
}

function oneChunk(spec: ClipChunk): ClipChunk[] {
	return [spec];
}

// 1: the committed spec.
const narrow = renderChunks(CHUNKS, REPLACED_WINDOW, false);
const wide = renderChunks(CHUNKS, ARGS_WINDOW, true);
for (let i = 0; i < CHUNKS.length; i++) {
	const spec = CHUNKS[i];
	const a = narrow[i];
	const b = wide[i];
	if (spec.hides !== null) {
		assert(
			!a.hiddenShown,
			`${spec.chunkId}: the narrow arm can read "${spec.hides}", so the arms are not a window test`,
		);
		assert(b.hiddenShown, `${spec.chunkId}: the wide arm cannot read "${spec.hides}", so the arms measure nothing`);
		assert(
			a.hiddenAt !== null && a.hiddenAt >= REPLACED_WINDOW && a.hiddenAt < ARGS_WINDOW,
			`${spec.chunkId}: "${spec.hides}" is not between ${REPLACED_WINDOW} and ${ARGS_WINDOW} characters (start ${a.hiddenAt})`,
		);
	}
	if (spec.shows !== undefined) {
		assert(a.hiddenShown === false, `${spec.chunkId}: a control chunk declares no hidden value`);
		assert(b.text.includes(spec.shows), `${spec.chunkId}: the wide arm cannot read its control "${spec.shows}"`);
		assert(a.text.includes(spec.shows), `${spec.chunkId}: the narrow arm cannot read its control "${spec.shows}"`);
	}
	const strip = (text: string): string =>
		text
			.split("\n")
			.map((line) => {
				const at = line.indexOf("[called ");
				if (at < 0) return line;
				const open = line.indexOf("{", at);
				return open < 0 ? line : `${line.slice(0, open)}<args>`;
			})
			.join("\n");
	assert(strip(a.text) === strip(b.text), `${spec.chunkId}: the arms differ outside the arguments`);
}
assert(
	narrow.some((r) => r.text.includes("…")),
	"the narrow arm shows at least one cut, marker included",
);
assert(
	!wide.some((r) => r.text.includes("…")),
	"the wide arm shows no cut at all, so it is the same session at a wider window rather than a different session",
);

// 2: a value inside the narrow window.
refuses(
	() =>
		renderChunks(
			oneChunk({
				chunkId: "hy-4f0c0002-cw-b1",
				hides: "--drain-timeout 90s",
				probes: ["--drain-timeout"],
				turns: [
					{ role: "user", text: "Drain it with the runbook timeout.", at: "09:00" },
					{
						role: "assistant",
						text: "Running it.",
						at: "09:01",
						call: {
							name: "bash",
							args: {
								command: `queue drain --drain-timeout 90s ${Array.from({ length: 40 }, (_, i) => `--drop entry-${i}`).join(" ")}`,
								description: "drain with the timeout early in the arguments",
							},
						},
					},
					{ role: "result", name: "bash", text: "drained 18 entries", at: "09:02" },
				],
			}),
			ARGS_WINDOW,
			false,
		),
	"nothing to compare",
	"a value inside the narrow window",
);

// 3: a value past both windows.
refuses(
	() =>
		renderChunks(
			oneChunk({
				chunkId: "hy-4f0c0002-cw-b2",
				hides: "--cache-shard 7",
				probes: ["--cache-shard"],
				turns: [
					{ role: "user", text: "Drain the whole backlog on that shard.", at: "09:00" },
					{
						role: "assistant",
						text: "Running it.",
						at: "09:01",
						call: {
							name: "bash",
							args: { command: veryLongHead("--cache-shard 7"), description: "a batch drain" },
						},
					},
					{ role: "result", name: "bash", text: "drained 60 entries", at: "09:02" },
				],
			}),
			ARGS_WINDOW,
			true,
		),
	"both arms are blind",
	"a value past both windows",
);

// 4: a control the narrow arm cannot read.
refuses(
	() =>
		renderChunks(
			oneChunk({
				chunkId: "hy-4f0c0002-cw-b3",
				hides: null,
				shows: "--tile-size 64",
				probes: ["--tile-size 64"],
				turns: [
					{ role: "user", text: "Render it at the usual size.", at: "09:00" },
					{
						role: "assistant",
						text: "Running it.",
						at: "09:01",
						call: {
							name: "bash",
							args: {
								command: `canvas render ${Array.from({ length: 60 }, (_, i) => `--part p-${i}`).join(" ")} --tile-size 64`,
								description: "a render with the size at the end of a long argument list",
							},
						},
					},
					{ role: "result", name: "bash", text: "render wrote build/one.png", at: "09:02" },
				],
			}),
			ARGS_WINDOW,
			false,
		),
	"no readable control",
	"a control value past the window under test",
);

// 5: the knob stays unset where it ships.
const shipped = ["src/index.ts", "src/flush.ts", "src/pipeline.ts"]
	.map((f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8"))
	.join("\n");
assert(!shipped.includes("maxArgChars"), "no shipped caller sets maxArgChars");
const entry = {
	type: "message",
	id: "clip-window-entry",
	message: {
		role: "assistant",
		content: [{ type: "toolCall", name: "bash", arguments: { command: `x ${"y".repeat(400)}`, note: "tail" } }],
	},
} as never;
assert(
	renderEntry(entry, 3000) === serializeEntries([entry], { maxTokens: 100_000 }).text.replace(/^\[0\] /, ""),
	"renderEntry's default and serializeEntries' default are the same render",
);

if (failures === 0) {
	console.log(
		`ok: window fixture — ${CHUNKS.filter((c) => c.hides !== null).length} values sit strictly between ${REPLACED_WINDOW} and ${ARGS_WINDOW} characters ` +
			`and are read by the wide arm only, ${CHUNKS.filter((c) => c.shows !== undefined).length} control value read by both, the two arms identical outside the arguments, ` +
			`and three wrongly positioned specs refused by the rule they break`,
	);
} else {
	console.error(`FAIL: ${failures} window assertion(s) failed`);
	process.exit(1);
}
