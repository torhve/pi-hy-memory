#!/usr/bin/env npx tsx
/**
 * dev/clip-window-report.ts — tier 4's priced half: the same authored chunks rendered by the shipped
 * renderer at two argument windows, so the 240-vs-600 question is answered by a bank and not by prose.
 *
 * The corpus here is authored as *entries*, not as chunk text, because the thing under measurement is the
 * renderer: `serializeEntries` produces each arm's chunk text with `maxArgChars` set to that arm's window,
 * which is the only way both arms are rendered by the same code rather than by two descriptions of it.
 * The shipped extension never sets `maxArgChars`; only this harness does.
 *
 * Every chunk that hides a value hides it **between** the two windows: past the window the shipped one
 * replaced, inside the shipped one. A value past both windows measures nothing (neither arm can read it) and
 * a value inside both measures nothing (both can), so the harness refuses a spec where the value is not
 * strictly past `REPLACED_WINDOW` and strictly inside `ARGS_WINDOW` — an author getting the position wrong is
 * exactly what this instrument would silently score as a null result. Run it and the shipped window still
 * reproduces the 2026-10-24 measurement: `REPLACED_WINDOW` is kept so the published 1-of-7 against 7-of-7
 * result can be re-derived rather than trusted.
 *
 *   npx tsx dev/clip-window-report.ts --render
 *   npx tsx dev/run.ts --run clipwindow-240 --corpus out/clipwindow/corpus-240.json --pool 12000 --candidate-render-mode perDraft
 *   npx tsx dev/run.ts --run clipwindow-600 --corpus out/clipwindow/corpus-600.json --pool 12000 --candidate-render-mode perDraft
 *
 * Then score both arms with the published instrument:
 *
 *   npx tsx dev/restraint-report.ts --corpus out/clipwindow/corpus-240.json --run clipwindow-240
 *   npx tsx dev/restraint-report.ts --corpus out/clipwindow/corpus-600.json --run clipwindow-600
 *
 * It prints lengths and positions only. Command text is authored synthetic material, but it is still not
 * printed: the output is meant to be pasted into a commit.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ARGS_WINDOW, serializeEntries } from "../src/entries.js";

/**
 * The window `ARGS_WINDOW` replaced on 2026-10-24. Kept as a named constant so the published comparison —
 * this window against the shipped one — stays reproducible after the shipped default moved.
 */
export const REPLACED_WINDOW = 240;

type Turn =
	| { role: "user"; text: string; at: string }
	| { role: "assistant"; text: string; at: string; call?: { name: string; args: Record<string, unknown> } }
	| { role: "result"; name: string; text: string; at: string };

export interface ClipChunk {
	chunkId: string;
	/** The value the cut removes and no other chunk shows. Must sit past the narrow window, inside the wide. */
	hides: string | null;
	/** A control value that sits inside both windows: readable in every arm, so a null result means the
	 * window is not the thing that lost it. */
	shows?: string;
	/** The tool fact defensible to bank, in the scorer's sense of a probe. */
	probes: string[];
	turns: Turn[];
}

/** Flags real commands carry, used to push the hidden value past the window without inventing a weird call. */
const PADS = [
	"--color never",
	"--log-format terse",
	"--no-progress",
	"--umask 022",
	"--timeout 120",
	"--warn-unused",
	"--checksum sha256",
	"--strict",
	"--jobs 8",
	"--verbose-level 2",
	"--no-clobber",
	"--retain 3",
	"--report-only",
	"--fsync always",
	"--sort-key mtime",
	"--locale C",
];

/**
 * Choose how many padding flags this call needs so the hidden value starts past the narrow window and ends
 * inside the wide one. The position is measured in the stringified arguments, which is what the renderer
 * slices, so the placement is the renderer's arithmetic and not an estimate.
 */
function hiddenArgs(head: string, description: string, hide: string): { command: string; description: string } {
	for (let pads = 0; pads <= PADS.length; pads++) {
		const command = [head, ...PADS.slice(0, pads), hide].join(" ");
		const full = JSON.stringify({ command, description });
		const at = full.lastIndexOf(hide);
		if (at >= REPLACED_WINDOW && at + hide.length <= ARGS_WINDOW) return { command, description };
	}
	throw new Error(
		`"${hide}" cannot be placed past ${REPLACED_WINDOW} and inside ${ARGS_WINDOW} characters of "${head.slice(0, 40)}…"`,
	);
}

const SESSION = "hy-4f0c0001";

/**
 * Four chunks, one session. Three carry a call whose decision-relevant value the narrow window removes and
 * the wide window keeps; the fourth is the control — a value well inside both windows, which must survive
 * in both arms or the harness is measuring something else.
 */
export const CHUNKS: ClipChunk[] = [
	{
		chunkId: `${SESSION}-cw-01`,
		hides: "--drain-timeout 90s",
		probes: ["--drain-timeout", "90s"],
		turns: [
			{
				role: "user",
				text: "Drain the queue with the timeout the runbook gives, then tell me what came out.",
				at: "09:02",
			},
			{
				role: "assistant",
				text: "Running the drain with the runbook's flags.",
				at: "09:03",
				call: {
					name: "bash",
					args: hiddenArgs(
						"queue drain --state store/queue --batch 200 --confirm 2>&1 | tail -n 30",
						"drain the queue with the runbook timeout",
						"--drain-timeout 90s",
					),
				},
			},
			{ role: "result", name: "bash", text: "drained 18 entries, 0 errors, 3 left pending", at: "09:05" },
			{ role: "user", text: "Good, three left pending is expected.", at: "09:06" },
		],
	},
	{
		chunkId: `${SESSION}-cw-02`,
		hides: null,
		shows: "--tile-size 64",
		probes: ["--tile-size 64"],
		turns: [
			{ role: "user", text: "Render one canvas at the size we always use.", at: "09:20" },
			{
				role: "assistant",
				text: "Rendering it now.",
				at: "09:21",
				call: {
					name: "bash",
					args: {
						command: "canvas render --tile-size 64 --out build/one.png",
						description: "render one canvas",
					},
				},
			},
			{ role: "result", name: "bash", text: "render wrote build/one.png", at: "09:23" },
			{ role: "user", text: "Fine.", at: "09:24" },
		],
	},
	{
		chunkId: `${SESSION}-cw-03`,
		hides: "--cache-shard 7",
		probes: ["--cache-shard", "shard 7"],
		turns: [
			{ role: "user", text: "Rebuild the cache on the shard the runbook names.", at: "10:10" },
			{
				role: "assistant",
				text: "Rebuilding it on that shard.",
				at: "10:11",
				call: {
					name: "bash",
					args: hiddenArgs(
						"canvas cache rebuild --index store/tiles.idx --verify 2>&1 | tail -n 40",
						"rebuild the cache on the runbook shard",
						"--cache-shard 7",
					),
				},
			},
			{ role: "result", name: "bash", text: "cache rebuilt, 58 tiles, 0 mismatch", at: "10:14" },
			{ role: "user", text: "Right.", at: "10:15" },
		],
	},
	{
		chunkId: `${SESSION}-cw-04`,
		hides: "--subset-allowlist fonts-latin",
		probes: ["--subset-allowlist", "fonts-latin"],
		turns: [
			{ role: "user", text: "Check the font subsets against the allowlist we agreed on.", at: "11:02" },
			{
				role: "assistant",
				text: "Checking them against it.",
				at: "11:03",
				call: {
					name: "bash",
					args: hiddenArgs(
						"canvas subset --manifest fonts/manifest.json --report fonts/subset-report.txt 2>&1 | tail -n 20",
						"subset fonts against the agreed allowlist",
						"--subset-allowlist fonts-latin",
					),
				},
			},
			{ role: "result", name: "bash", text: "subset report: 12 subsets, 0 unresolved", at: "11:06" },
			{ role: "user", text: "Twelve then.", at: "11:07" },
		],
	},
];

function entryId(chunkId: string, index: number): string {
	return `${chunkId}-e${index}`;
}

/** The authored clock reading as an entry timestamp. Both arms read the same value, so the window stays the only difference between them. */
function stamp(at: string): string {
	return `2026-06-01T${at}:00Z`;
}

/** Authored turns -> the entries pi would hold, so the shipped renderer is what cuts the call. */
function entriesFor(chunk: ClipChunk): SessionEntry[] {
	return chunk.turns.map((turn, index) => {
		if (turn.role === "user")
			return {
				type: "message",
				id: entryId(chunk.chunkId, index),
				timestamp: stamp(turn.at),
				message: { role: "user", content: [{ type: "text", text: turn.text }] },
			} as unknown as SessionEntry;
		if (turn.role === "result")
			return {
				type: "message",
				id: entryId(chunk.chunkId, index),
				timestamp: stamp(turn.at),
				message: {
					role: "toolResult",
					toolName: turn.name,
					isError: false,
					content: [{ type: "text", text: turn.text }],
				},
			} as unknown as SessionEntry;
		const content: Record<string, unknown>[] = [{ type: "text", text: turn.text }];
		if (turn.call)
			content.push({ type: "toolCall", name: turn.call.name, arguments: turn.call.args, id: `call-${index}` });
		return {
			type: "message",
			id: entryId(chunk.chunkId, index),
			timestamp: stamp(turn.at),
			message: { role: "assistant", content },
		} as unknown as SessionEntry;
	});
}

export interface RenderedChunk {
	chunkId: string;
	text: string;
	/** The full argument list of the call the window cut, so a check can measure the position it hid. */
	argsFull: string | null;
	/** Where the hidden value starts in that argument list, at this window. */
	hiddenAt: number | null;
	/** Whether the writer of this arm could read the hidden value at all. */
	hiddenShown: boolean;
	/** What the call line looks like to this arm, minus the wrapper. */
	visibleArgs: string;
}

/**
 * Render every chunk at one window. `readable` is what this arm must be able to do with each declared value:
 * the narrow arm may not read it, the wide arm must. A value past both windows or inside both measures
 * nothing, so a spec that gets the position wrong is refused here rather than scored as a null result later.
 */
export function renderChunks(chunks: ClipChunk[], window: number, readable: boolean): RenderedChunk[] {
	const out: RenderedChunk[] = [];
	for (const chunk of chunks) {
		const built = serializeEntries(entriesFor(chunk), {
			maxTokens: 100_000,
			maxEntryChars: 3000,
			maxArgChars: window,
		});
		let argsFull: string | null = null;
		let visibleArgs = "";
		for (const turn of chunk.turns) {
			if (turn.role !== "assistant" || !turn.call) continue;
			const full = JSON.stringify(turn.call.args);
			if (argsFull === null || full.length > argsFull.length) {
				argsFull = full;
				visibleArgs = full.length > window ? `${full.slice(0, window)}…` : full;
			}
		}
		const hiddenAt = chunk.hides && argsFull ? argsFull.lastIndexOf(chunk.hides) : null;
		const hiddenShown = chunk.hides !== null && built.text.includes(chunk.hides);
		if (chunk.hides !== null) {
			if (readable) {
				if (!hiddenShown)
					throw new Error(
						`${chunk.chunkId}: "${chunk.hides}" is missing at the ${window}-character window too, so both arms are blind and the comparison measures nothing`,
					);
				if (hiddenAt === null || hiddenAt < REPLACED_WINDOW)
					throw new Error(
						`${chunk.chunkId}: "${chunk.hides}" starts at character ${hiddenAt ?? -1}, inside the ${REPLACED_WINDOW}-character window, so the narrow arm reads it as well and there is nothing to compare`,
					);
			} else {
				if (hiddenShown)
					throw new Error(
						`${chunk.chunkId}: "${chunk.hides}" survives the ${window}-character window, so the narrow arm reads it and there is nothing to compare`,
					);
				if (hiddenAt === null || hiddenAt < window)
					throw new Error(
						`${chunk.chunkId}: "${chunk.hides}" is not past this arm's ${window}-character cut, so it should have been readable here`,
					);
			}
		}
		if (chunk.shows !== undefined && !built.text.includes(chunk.shows))
			throw new Error(
				`${chunk.chunkId}: its control value "${chunk.shows}" is not readable at the ${window}-character window, so this arm has no readable control to compare against`,
			);
		out.push({ chunkId: chunk.chunkId, text: built.text, argsFull, hiddenAt, hiddenShown, visibleArgs });
	}
	return out;
}

/** The two arms, differing only where the window cut: every other character of the chunk text is shared. */
export function assertArmsDifferOnlyAtTheCut(narrow: RenderedChunk[], wide: RenderedChunk[]): void {
	if (narrow.length !== wide.length) throw new Error("the two arms rendered different chunk counts");
	for (let i = 0; i < narrow.length; i++) {
		const a = narrow[i];
		const b = wide[i];
		if (a.chunkId !== b.chunkId) throw new Error(`arm chunk ids disagree at ${i}`);
		const stripped = (text: string): string =>
			text
				.split("\n")
				.map((line) => {
					const at = line.indexOf("[called ");
					if (at < 0) return line;
					const open = line.indexOf("{", at);
					return open < 0 ? line : `${line.slice(0, open)}<args>${line.slice(line.length - 1)}`;
				})
				.join("\n");
		if (stripped(a.text) !== stripped(b.text))
			throw new Error(
				`${a.chunkId}: the two arms differ somewhere other than the arguments, so the arm is not a window test`,
			);
	}
}

interface CorpusChunkOut {
	chunkId: string;
	class: "tool_output";
	probes: string[];
	/** Only the arm that actually cut it carries the label: at 600 the value was read, not supplied. */
	hidden?: string[];
	argsFull?: string;
	text: string;
}

function corpusFor(rendered: RenderedChunk[], chunks: ClipChunk[]): { chunks: CorpusChunkOut[] } {
	const byId = new Map(chunks.map((c) => [c.chunkId, c]));
	return {
		chunks: rendered.map((r) => {
			const chunk = byId.get(r.chunkId);
			const row: CorpusChunkOut = {
				chunkId: r.chunkId,
				class: "tool_output",
				probes: chunk?.probes ?? [],
				text: r.text,
			};
			if (chunk?.hides && r.argsFull) {
				row.argsFull = r.argsFull;
				// Only the arm that could not read it carries the hidden label: at the wide window the
				// value was read off the call, so a fact carrying it did not supply it.
				if (!r.hiddenShown) row.hidden = [chunk.hides];
			}
			return row;
		}),
	};
}

function main(): void {
	const narrow = renderChunks(CHUNKS, REPLACED_WINDOW, false);
	const wide = renderChunks(CHUNKS, ARGS_WINDOW, true);
	assertArmsDifferOnlyAtTheCut(narrow, wide);

	mkdirSync("out/clipwindow", { recursive: true });
	writeFileSync("out/clipwindow/corpus-240.json", `${JSON.stringify(corpusFor(narrow, CHUNKS), null, 2)}\n`);
	writeFileSync("out/clipwindow/corpus-600.json", `${JSON.stringify(corpusFor(wide, CHUNKS), null, 2)}\n`);

	let cut = 0;
	for (let i = 0; i < CHUNKS.length; i++) {
		const chunk = CHUNKS[i];
		const a = narrow[i];
		if (chunk.hides === null) {
			console.log(`  ${chunk.chunkId}: control, no value past the narrow window`);
			continue;
		}
		cut++;
		console.log(
			`  ${chunk.chunkId}: value starts at character ${a.hiddenAt} of a ${a.argsFull?.length} character call — ` +
				`unreadable at ${REPLACED_WINDOW}, readable at ${ARGS_WINDOW}, and the rest of the chunk text is identical`,
		);
	}
	console.log(
		`ok: ${CHUNKS.length} chunks rendered by serializeEntries at ${REPLACED_WINDOW} and ${ARGS_WINDOW}, ` +
			`${cut} of them hiding a value between the two windows, everything else byte-identical`,
	);
	console.log(
		"   reading: the arms are the same entries through the same renderer; the only difference is how much of",
	);
	console.log(
		"   one call the writer was allowed to read. Whether that reaches a bank fact is the run's answer, not this one's.",
	);
}

if (process.argv[1] && process.argv[1].endsWith("clip-window-report.ts")) main();
