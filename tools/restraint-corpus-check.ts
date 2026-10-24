#!/usr/bin/env npx tsx
/**
 * tools/restraint-corpus-check.ts - the contrast-pair contract of dev/corpus-restraint.json.
 *
 * A contrast pair is only worth anything if the two sides differ in exactly one thing. This check
 * is what keeps that true: it refuses a pair whose sides differ in a second declared token, a
 * marker that leaks onto the side that must not name it, an anchor that appears in an unrelated
 * chunk, and — the failure an external benchmark actually caught — a probe string that also
 * appears in the writer's own instructions, which measures the prompt instead of the model.
 *
 * It also runs the repo's privacy rules over the authored text, because this corpus is committed
 * while the transcripts it imitates are not.
 * Three classes, because the v1 label audit found the old two-class split was doing two jobs at once:
 * `nothing_work` is a chunk where nothing durable about the work occurred, and `tool_output` is a chunk
 * where the user decided nothing but the tool output states a fact worth keeping. A tool_output chunk
 * must name both halves — the probe that is defensible to bank and the chatter that is not — or the
 * score cannot be wrong, which is the same reason a contrast pair must name its one variable.
 *
 * The fourth corpus adds three labels the earlier ones do not have, and each needs its own rule:
 * `constraints` (a user-stated rule that has to survive as a rule), `argsFull` plus `hidden` (a tool
 * call long enough for the shipped argument window to cut it, with a value that sits past the cut and
 * nowhere else in what the writer was shown), and `crossSession` (a chunk that restates a subject a
 * different authored session established). `hidden` is the one the check has to be strict about: a
 * value the window did not actually remove makes the fabrication probe measure nothing, so the window
 * here is measured from `renderEntry` rather than written down as a number.
 */

import { readFileSync } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { carries, hiddenSignatures } from "../dev/restraint-report.js";
import { renderEntry } from "../src/entries.js";
import { EXTRACT_SYSTEM, reconcileSystem } from "../src/prompts.js";

// `--corpus <file>` exists so the check can be pointed at a deliberately broken copy and shown
// to fail; `npm run test` runs it against the committed corpus with no arguments.
const argCorpus = process.argv.indexOf("--corpus");
// `--corpus <file>` exists so the check can be pointed at a deliberately broken copy and shown to
// fail. With no argument it runs over every committed corpus, because a rule enforced on one corpus
// and not the others is a rule that is not enforced.
const TARGETS =
	argCorpus >= 0 && process.argv[argCorpus + 1]
		? [process.argv[argCorpus + 1]]
		: [
				"dev/corpus-restraint.json",
				"dev/corpus-restraint2.json",
				"dev/corpus-restraint3.json",
				"dev/corpus-restraint4.json",
			].map((f) => new URL(`../${f}`, import.meta.url).pathname);

class CheckFailure extends Error {}

interface CorpusChunk {
	chunkId: string;
	class: string;
	pair?: string;
	side?: string;
	anchors?: string[];
	marker?: string;
	claim?: string;
	why?: string;
	probes?: string[];
	transient?: string[];
	/** A rule the user stated that has to survive as a rule. */
	constraints?: string[];
	/** A value past the argument window that appears nowhere else in the chunk. */
	hidden?: string[];
	/** The whole argument list of the call the window cut. */
	argsFull?: string;
	/** A chunk in the other authored session that restates this chunk's subject. */
	crossSession?: string;
	text: string;
}

function assert(cond: boolean, label: string): void {
	if (!cond) throw new CheckFailure(label);
}

/**
 * The window the shipped renderer applies to a tool call's arguments, measured from the renderer.
 *
 * A corpus rule written against a typed-in 240 stops meaning anything the day the window moves — and
 * upstream's own window has already moved once, from 80 to 600, because 80 cut real flags. Measured,
 * the rule moves with the code it is a rule about.
 */
function argumentWindow(): number {
	const probe = {
		type: "message",
		id: "hy-window-probe",
		timestamp: "2026-01-01T09:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "hy-window-call", name: "k", arguments: { a: "z".repeat(900) } }],
		},
	} as unknown as SessionEntry;
	const shown = renderEntry(probe, 100_000) ?? "";
	const at = shown.indexOf("[called k ");
	assert(at >= 0, "the shipped renderer no longer renders a tool call as [called <name> <arguments>]");
	// The rendered call is `[called k <arguments>]`: the wrapper's bracket is not part of the arguments.
	const visible = shown.slice(at + "[called k ".length, -1);
	assert(visible.length > 0, "the shipped renderer shows no arguments at all");
	return visible.length;
}

const SESSION_ID = /^hy-([0-9a-f]{8})-/;

/** The session a chunk id names, when it names one: pi chunk ids are `hy-<sessionId8>-<seq>`. */
function sessionOf(chunkId: string): string | undefined {
	return SESSION_ID.exec(chunkId)?.[1];
}

interface CallShown {
	/** The arguments exactly as the writer was shown them. */
	visible: string;
	/** Whether that is the whole call or a cut one. */
	whole: boolean;
}

/**
 * Every tool call a chunk shows, and whether the writer was shown the whole argument list. A call the
 * window cut does not parse: it stops mid-value, with the wrapper's bracket on it and no closing brace
 * of its own — which is the whole reason the cut is hard for a model to notice.
 */
function callsShown(c: CorpusChunk): CallShown[] {
	const out: CallShown[] = [];
	for (const line of c.text.split("\n")) {
		const at = line.indexOf("[called ");
		if (at < 0) continue;
		const rest = line.slice(at + "[called ".length);
		const open = rest.indexOf("{");
		assert(open >= 0, `${c.chunkId}: a [called line carries no arguments object: "${line.slice(0, 24)}…"`);
		const body = rest.slice(open);
		assert(
			body.endsWith("]"),
			`${c.chunkId}: the call line does not end with the renderer's wrapper: "${line.slice(0, 24)}…"`,
		);
		const visible = body.slice(0, -1);
		let whole = true;
		try {
			JSON.parse(visible);
		} catch {
			whole = false;
		}
		out.push({ visible, whole });
	}
	return out;
}

function checkCorpus(CORPUS: string): string {
	// The scorer's own token matcher, imported rather than restated: the corpus check and the score
	// must disagree about nothing except which chunk they are looking at.
	const wordMatch = carries;
	// Measured from `renderEntry` on every run, so the window rules mean what the shipped renderer
	// does rather than what a number written in this file once said.
	const WINDOW = argumentWindow();
	const promptText = `${EXTRACT_SYSTEM}\n${reconcileSystem(12)}`;

	const doc = JSON.parse(readFileSync(CORPUS, "utf8")) as {
		gate?: {
			attribution_pair?: number;
			empty_chunk?: number;
			nothing_work?: number;
			tool_output?: number;
			constraint_chunk?: number;
			cut_argument_chunk?: number;
			hidden_value_chunk?: number;
			tool_bearing_nothing_work?: number;
			cross_session_pair?: number;
			session_span?: number;
		};
		chunks: CorpusChunk[];
	};

	const chunks = doc.chunks;
	const gate = doc.gate ?? {};

	// ---- 1. shape -----------------------------------------------------------------
	const ids = new Set<string>();
	for (const c of chunks) {
		assert(!ids.has(c.chunkId), `duplicate chunkId ${c.chunkId}`);
		ids.add(c.chunkId);
		assert(
			c.class === "attribution" || c.class === "empty" || c.class === "nothing_work" || c.class === "tool_output",
			`${c.chunkId}: unknown class "${c.class}"`,
		);
		assert(c.text.trim().length > 0, `${c.chunkId}: empty text`);
		// Every labelled line carries a positional ref, and refs count from 0.
		const lines = c.text.split("\n");
		let labelled = 0;
		for (const line of lines) {
			if (!line.trim()) continue;
			if (!/^\[\d+\] \[/.test(line)) continue;
			assert(line.startsWith(`[${labelled}]`), `${c.chunkId}: ref out of order in "${line.slice(0, 24)}…"`);
			labelled++;
		}
		assert(labelled >= 4, `${c.chunkId}: only ${labelled} labelled turns, too thin to score`);
	}

	const pairs = new Map<string, CorpusChunk[]>();
	const empties: CorpusChunk[] = [];
	const nothingWork: CorpusChunk[] = [];
	const toolOutput: CorpusChunk[] = [];
	for (const c of chunks) {
		if (c.class === "empty" || c.class === "nothing_work") {
			assert(Boolean(c.why), `${c.chunkId}: a nothing-durable chunk must say why nothing in it is durable`);
			assert(
				!c.anchors?.length && !c.marker,
				`${c.chunkId}: a nothing-durable chunk declares no anchors or marker`,
			);
			assert(
				!c.probes?.length,
				`${c.chunkId}: a nothing-durable chunk names a probe to bank, which its own class denies`,
			);
			(c.class === "empty" ? empties : nothingWork).push(c);
			continue;
		}
		if (c.class === "tool_output") {
			// The class the v1 label audit forced: nothing was decided, but the tool output carries a
			// fact. The chunk has to name both halves or the score is unfalsifiable — a banked fact
			// could be the defensible one or the chatter, and nothing in the corpus would say which.
			assert(Boolean(c.why), `${c.chunkId}: a tool-output chunk must say that nothing was decided`);
			assert(
				!c.anchors?.length && !c.marker,
				`${c.chunkId}: a tool-output chunk declares no pair anchors or marker`,
			);
			assert(Boolean(c.probes?.length), `${c.chunkId}: a tool-output chunk must name the tool fact it tests for`);
			assert(
				Boolean(c.transient?.length),
				`${c.chunkId}: a tool-output chunk must name the chatter that must not be banked`,
			);
			for (const probe of c.probes!)
				assert(wordMatch(probe, c.text), `${c.chunkId}: probe "${probe}" is not in the chunk`);
			for (const small of c.transient!)
				assert(wordMatch(small, c.text), `${c.chunkId}: transient "${small}" is not in the chunk`);
			toolOutput.push(c);
			continue;
		}
		assert(
			Boolean(c.pair && c.side && c.anchors?.length && c.marker && c.claim),
			`${c.chunkId}: attribution chunk needs pair, side, anchors, marker and claim`,
		);
		assert(c.side === "keep" || c.side === "quote", `${c.chunkId}: side must be keep or quote, got ${c.side}`);
		pairs.set(c.pair!, [...(pairs.get(c.pair!) ?? []), c]);
	}

	for (const [pair, sides] of pairs) {
		assert(sides.length === 2, `${pair}: ${sides.length} sides, a contrast pair has exactly two`);
		const keep = sides.find((s) => s.side === "keep");
		const quote = sides.find((s) => s.side === "quote");
		assert(Boolean(keep && quote), `${pair}: needs one keep side and one quote side`);
	}

	const pairCount = pairs.size;
	const wantPairs = gate.attribution_pair ?? 0;
	const wantEmpty = gate.empty_chunk ?? 0;
	const wantNothing = gate.nothing_work ?? 0;
	const wantTool = gate.tool_output ?? 0;
	console.log(
		`corpus: ${chunks.length} chunks, ${pairCount} attribution pairs, ${empties.length + nothingWork.length} nothing-durable chunks (${empties.length} empty, ${nothingWork.length} nothing_work), ${toolOutput.length} tool_output chunks`,
	);
	assert(pairCount >= wantPairs, `gate: ${pairCount} attribution pairs, needs ${wantPairs}`);
	assert(empties.length >= wantEmpty, `gate: ${empties.length} empty chunks, needs ${wantEmpty}`);
	assert(nothingWork.length >= wantNothing, `gate: ${nothingWork.length} nothing_work chunks, needs ${wantNothing}`);
	assert(toolOutput.length >= wantTool, `gate: ${toolOutput.length} tool_output chunks, needs ${wantTool}`);

	// ---- 2. pair isolation --------------------------------------------------------

	for (const [pair, sides] of pairs) {
		const keep = sides.find((s) => s.side === "keep")!;
		const quote = sides.find((s) => s.side === "quote")!;
		for (const anchor of keep.anchors!) {
			assert(wordMatch(anchor, keep.text), `${keep.chunkId}: anchor "${anchor}" is not on the keep side`);
			assert(wordMatch(anchor, quote.text), `${quote.chunkId}: anchor "${anchor}" is not on the quote side`);
		}
		// The claim itself must be verbatim on both sides: the pair's whole point is that the
		// sentence is identical and only the frame around it moved.
		assert(keep.text.includes(keep.claim!), `${keep.chunkId}: the claim is not verbatim on the keep side`);
		assert(quote.text.includes(quote.claim!), `${quote.chunkId}: the claim is not verbatim on the quote side`);
		assert(
			keep.claim === quote.claim,
			`${pair}: the two sides declare different claims, so the pair is not a contrast`,
		);
		// The marker names the third party, so it belongs on the quote side only.
		assert(wordMatch(keep.marker!, quote.text), `${quote.chunkId}: the quote side never names "${keep.marker}"`);
		assert(
			!wordMatch(keep.marker!, keep.text),
			`${keep.chunkId}: the keep side names "${keep.marker}", which erases the contrast`,
		);
	}

	// ---- 3. no leakage ------------------------------------------------------------
	// An anchor or marker that appears in an unrelated chunk makes every score in that chunk
	// ambiguous: an intrusion there could be a leak rather than a decision.
	for (const [pair, sides] of pairs) {
		const keep = sides.find((s) => s.side === "keep")!;
		for (const anchor of keep.anchors!) {
			for (const other of chunks) {
				if (other.pair === pair) continue;
				assert(
					!wordMatch(anchor, other.text),
					`leak: anchor "${anchor}" of ${pair} appears in ${other.chunkId}`,
				);
			}
		}
		for (const other of chunks) {
			if (other.pair === pair) continue;
			assert(
				!wordMatch(keep.marker!, other.text),
				`leak: marker "${keep.marker}" of ${pair} appears in ${other.chunkId}`,
			);
		}
	}

	// The same rule for the classes that name their own probes: a tool fact declared in one chunk
	// and found in another makes a banked fact there ambiguous too.
	for (const c of [...nothingWork, ...toolOutput]) {
		for (const probe of c.probes ?? []) {
			for (const other of chunks) {
				if (other.chunkId === c.chunkId) continue;
				assert(
					!wordMatch(probe, other.text),
					`leak: probe "${probe}" of ${c.chunkId} appears in ${other.chunkId}`,
				);
			}
		}
		for (const small of c.transient ?? []) {
			for (const other of chunks) {
				if (other.chunkId === c.chunkId) continue;
				assert(
					!wordMatch(small, other.text),
					`leak: transient "${small}" of ${c.chunkId} appears in ${other.chunkId}`,
				);
			}
		}
	}

	// ---- 4. the argument window, the constraints, and what the window hides -------
	//
	// Three labels exist only in the fourth corpus, and each one is worth nothing unless the shipped
	// window really cut the call it is written about:
	//
	//   `constraints`  a rule the user stated beside tool output, which has to survive as a rule;
	//   `argsFull`     what the call actually was, so a score can say what the writer lost;
	//   `hidden`       a value past the cut that appears nowhere else in what the writer was shown. A
	//                  banked fact carrying it was supplied by the model, not read — but only if the
	//                  window actually removed it, which is a position checked against WINDOW.
	//   `crossSession` the chunk this one restates from the other authored session, which is how tier
	//                  6a gets a destructive op recorded in a ledger instead of only shown in a fixture.
	const cutChunks: string[] = [];
	const hiddenChunks: string[] = [];
	const constraintChunks: string[] = [];
	const toolBearingNothing: string[] = [];
	const crossPairs: string[] = [];
	const hiddenOwner = new Map<string, string>();
	const sessions = new Set<string>();

	for (const c of chunks) {
		const session = sessionOf(c.chunkId);
		if (session) sessions.add(session);
		const calls = callsShown(c);
		const cut = calls.filter((k) => !k.whole);
		const toolBearing = calls.length > 0 || c.text.includes("[Tool result for ");
		if (c.class === "nothing_work" && toolBearing) toolBearingNothing.push(c.chunkId);

		if (cut.length === 0) {
			assert(!c.argsFull, `${c.chunkId}: names argsFull but shows no call the window cut`);
		} else {
			cutChunks.push(c.chunkId);
			assert(
				Boolean(c.argsFull),
				`${c.chunkId}: a call is cut mid-argument and the corpus names no argsFull, so nothing says what the writer lost`,
			);
			for (const k of cut) {
				assert(
					k.visible.length === WINDOW,
					`${c.chunkId}: a cut call shows ${k.visible.length} characters of arguments; the shipped window shows ${WINDOW}`,
				);
				assert(
					c.argsFull!.startsWith(k.visible),
					`${c.chunkId}: argsFull does not begin with the ${WINDOW} characters the writer was shown`,
				);
			}
			assert(
				c.argsFull!.length > WINDOW,
				`${c.chunkId}: argsFull is ${c.argsFull!.length} characters, which the window would not cut at all`,
			);
		}

		for (const hidden of c.hidden ?? []) {
			const where = c.argsFull ? c.argsFull.lastIndexOf(hidden) : -1;
			assert(
				where >= WINDOW,
				`${c.chunkId}: hidden value "${hidden}" is not past the ${WINDOW}-character argument window${
					c.argsFull ? ` (it starts at character ${where})` : ", and this chunk names no argsFull"
				}: the writer was shown it, or it is not in the call at all`,
			);
			for (const other of chunks)
				assert(
					!wordMatch(hidden, other.text),
					`leak: ${other.chunkId} shows the hidden value "${hidden}" of ${c.chunkId}, so a banked fact there could have read it`,
				);
			for (const owner of chunks) {
				const labels = [
					...(owner.probes ?? []),
					...(owner.transient ?? []),
					...(owner.constraints ?? []),
					...(owner.anchors ?? []),
					...(owner.marker ? [owner.marker] : []),
				];
				for (const label of labels)
					assert(
						!wordMatch(label, hidden) && !wordMatch(hidden, label),
						`${c.chunkId}: hidden value "${hidden}" overlaps the label "${label}" of ${owner.chunkId}, which makes it bankable after all`,
					);
			}
			// The whole phrase being absent is not enough. `--retention-days 45` hides a flag *and* a
			// number, and if some other chunk prints 45 — a timestamp, a line number, another count — then a
			// bank fact carrying 45 read it rather than invented it. At least one token of a hidden value has
			// to be shown by no chunk at all, and the ambiguous tokens are named rather than quietly counted.
			const tokens = hiddenSignatures(hidden, "");
			const unread = hiddenSignatures(hidden, chunks.map((o) => o.text).join("\n"));
			assert(
				unread.length > 0,
				`hidden value "${hidden}" of ${c.chunkId} names no token the writer is ever denied: every token of ${tokens.join(", ")} appears in some chunk, so nothing carried from it could be called supplied rather than read`,
			);
			const shownElsewhere = tokens.filter((t) => !unread.includes(t));
			if (shownElsewhere.length > 0)
				console.log(
					`  note: hidden value "${hidden}" of ${c.chunkId} shows ${shownElsewhere.join(", ")} somewhere in the corpus, so only ${unread.join(", ")} can carry a supplied-not-read reading`,
				);
			const claimed = hiddenOwner.get(hidden);
			assert(!claimed, `${c.chunkId}: hidden value "${hidden}" is already hidden by ${claimed}`);
			hiddenOwner.set(hidden, c.chunkId);
			assert(
				!wordMatch(hidden, promptText),
				`contamination: hidden value "${hidden}" of ${c.chunkId} appears in the writer prompt`,
			);
		}
		if (c.hidden?.length) hiddenChunks.push(c.chunkId);

		for (const constraint of c.constraints ?? []) {
			assert(wordMatch(constraint, c.text), `${c.chunkId}: constraint "${constraint}" is not in the chunk`);
			assert(
				toolBearing,
				`${c.chunkId}: declares a user constraint with no tool output beside it, which is a different case from the one the label names`,
			);
			// A rule is allowed to name the thing it rules — "never prune tiles.cache" has to name
			// tiles.cache. What is not allowed is the rule sitting *inside* the probe, which would make
			// one declared phrase count as both the tool fact and the user's constraint.
			for (const probe of c.probes ?? []) {
				assert(
					probe !== constraint,
					`${c.chunkId}: constraint "${constraint}" is declared twice, once as the probe`,
				);
				assert(
					!wordMatch(constraint, probe),
					`${c.chunkId}: constraint "${constraint}" is carried by the probe "${probe}", so the chunk declares one thing twice`,
				);
			}
			for (const small of c.transient ?? [])
				assert(
					!wordMatch(small, constraint) && !wordMatch(constraint, small),
					`${c.chunkId}: constraint "${constraint}" repeats the transient "${small}", so the chunk calls the same words durable and not durable`,
				);
			for (const other of chunks) {
				if (other.chunkId === c.chunkId) continue;
				assert(
					!wordMatch(constraint, other.text),
					`leak: constraint "${constraint}" of ${c.chunkId} appears in ${other.chunkId}`,
				);
			}
			assert(
				!wordMatch(constraint, promptText),
				`contamination: constraint "${constraint}" of ${c.chunkId} appears in the writer prompt`,
			);
		}
		if (c.constraints?.length) constraintChunks.push(c.chunkId);

		// argsFull is allowed on any class: a chunk can hold a call the window cut and still declare
		// nothing in it durable, which is what the tool-bearing nothing_work control is.
		if (c.class !== "tool_output")
			assert(
				!c.constraints?.length && !c.hidden?.length && !c.crossSession,
				`${c.chunkId}: a ${c.class} chunk declares tool-output labels this corpus cannot score`,
			);

		if (c.crossSession) {
			const other = chunks.find((x) => x.chunkId === c.crossSession);
			assert(Boolean(other), `${c.chunkId}: crossSession names ${c.crossSession}, which is not in the corpus`);
			assert(
				other!.class === c.class,
				`${c.chunkId}: crossSession names a ${other!.class} chunk, and only two ${c.class} chunks restate one subject`,
			);
			const mine = sessionOf(c.chunkId);
			const theirs = sessionOf(other!.chunkId);
			assert(
				mine !== undefined && theirs !== undefined && mine !== theirs,
				`${c.chunkId}: crossSession names ${other!.chunkId}, which is not in a different authored session, so nothing crosses a session boundary`,
			);
			assert(
				Boolean(c.probes?.length && other!.probes?.length),
				`${c.chunkId}: a cross-session pair names no value on one side, so a merge there would have nothing to destroy`,
			);
			assert(
				!other!.probes!.some((v) => c.probes!.includes(v)),
				`${c.chunkId}: the cross-session pair names the same value on both sides, so a merge there would have nothing to destroy`,
			);
			crossPairs.push(c.chunkId);
		}
	}

	console.log(
		`corpus: ${WINDOW}-character argument window, ${cutChunks.length} chunks holding a call it cut, ${hiddenChunks.length} hiding a value past the cut, ${constraintChunks.length} declaring a user constraint, ${toolBearingNothing.length} tool-bearing nothing-durable chunks, ${crossPairs.length} cross-session pair(s), ${sessions.size} authored session(s)`,
	);
	assert(
		cutChunks.length >= (gate.cut_argument_chunk ?? 0),
		`gate: ${cutChunks.length} chunks hold a call the window cut, needs ${gate.cut_argument_chunk ?? 0}`,
	);
	assert(
		hiddenChunks.length >= (gate.hidden_value_chunk ?? 0),
		`gate: ${hiddenChunks.length} chunks hide a value past the cut, needs ${gate.hidden_value_chunk ?? 0}`,
	);
	assert(
		constraintChunks.length >= (gate.constraint_chunk ?? 0),
		`gate: ${constraintChunks.length} chunks declare a user constraint, needs ${gate.constraint_chunk ?? 0}`,
	);
	assert(
		toolBearingNothing.length >= (gate.tool_bearing_nothing_work ?? 0),
		`gate: ${toolBearingNothing.length} nothing-durable chunks contain tool output, needs ${gate.tool_bearing_nothing_work ?? 0}`,
	);
	assert(
		crossPairs.length >= (gate.cross_session_pair ?? 0),
		`gate: ${crossPairs.length} cross-session pair(s), needs ${gate.cross_session_pair ?? 0}`,
	);
	if (gate.session_span) {
		assert(
			sessions.size >= gate.session_span,
			`gate: ${sessions.size} authored sessions, needs ${gate.session_span}`,
		);
		for (const c of chunks)
			assert(
				sessionOf(c.chunkId) !== undefined,
				`${c.chunkId}: a corpus claiming a session span gives every chunk a session-shaped id, and this one has none`,
			);
	}

	// ---- 5. contamination guard ---------------------------------------------------
	// The external benchmark caught a model inventing a fact out of its own instructions. This
	// repo's own measured version of that is 19/590 observations copying a rendered id label.
	// A probe that exists in the prompt measures the prompt.
	for (const [pair, sides] of pairs) {
		const keep = sides.find((s) => s.side === "keep")!;
		for (const anchor of keep.anchors!) {
			assert(
				!wordMatch(anchor, promptText),
				`contamination: anchor "${anchor}" of ${pair} appears in the writer prompt`,
			);
		}
		assert(
			!wordMatch(keep.marker!, promptText),
			`contamination: marker "${keep.marker}" appears in the writer prompt`,
		);
	}

	for (const c of [...nothingWork, ...toolOutput]) {
		for (const probe of c.probes ?? [])
			assert(
				!wordMatch(probe, promptText),
				`contamination: probe "${probe}" of ${c.chunkId} appears in the writer prompt`,
			);
		for (const small of c.transient ?? [])
			assert(
				!wordMatch(small, promptText),
				`contamination: transient "${small}" of ${c.chunkId} appears in the writer prompt`,
			);
	}

	// ---- 6. privacy (AGENTS.md) ---------------------------------------------------
	const HOST = /\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|dev|local|internal|lan)\b/i;
	const ABS_PATH = /(?:^|[\s"'`(])\/(?:Users|home|root|var|etc|tmp|private)\//i;
	const CREDENTIAL = /\b(?:api[_-]?key|secret|token|password|passwd|bearer|authorization|sk-[A-Za-z0-9]{8,})\b/i;
	for (const c of chunks) {
		assert(!HOST.test(c.text), `${c.chunkId}: hostname-shaped text`);
		assert(!ABS_PATH.test(c.text), `${c.chunkId}: absolute path under a home or system directory`);
		assert(!CREDENTIAL.test(c.text), `${c.chunkId}: credential-shaped text`);
	}

	const totalChars = chunks.reduce((n, c) => n + c.text.length, 0);
	return `pairs isolated, no leakage, window and label rules clean, no prompt contamination, privacy clean (${chunks.length} chunks, ~${Math.ceil(totalChars / 4)} est tokens, mean ${Math.round(totalChars / chunks.length / 4)} per chunk)`;
}

let failed = 0;
for (const corpus of TARGETS) {
	console.log(`corpus: ${corpus.replace(/^.*\//, "")}`);
	try {
		console.log(`ok: ${checkCorpus(corpus)}`);
	} catch (error) {
		if (error instanceof CheckFailure) {
			failed++;
			console.error(`FAIL: ${corpus.replace(/^.*\//, "")}: ${error.message}`);
		} else throw error;
	}
}
if (failed > 0) {
	console.error(`FAILED: ${failed} of ${TARGETS.length} corpora broke a rule`);
	process.exit(1);
}
