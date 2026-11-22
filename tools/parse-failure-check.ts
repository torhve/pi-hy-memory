#!/usr/bin/env node
/**
 * Parse-failure check. Run: npx tsx tools/parse-failure-check.ts
 *
 * Session 01a1ab1d (2026-11-05) stopped writing memory with
 * `write failed: extract hy-01a1ab1d-001: Bad escaped character in JSON at position 2223`.
 * The audit carries 25 of these across 12 sessions, and every one of them was recorded as
 * `failureClass:"endpoint"`, which cost a write cooldown and a skipped chain instead of the
 * one corrective re-ask src/pipeline.ts already has. Three things had to hold for that
 * warning to stop happening, and this file pins each one:
 *
 * 1. A completion that mixes a legal escaped backslash (`\\s`) with an illegal one (`\s`)
 *    parses. The first escape repair looked at every backslash on its own, repaired the
 *    second half of the legal pair, and produced `\\\s` — the defect it was meant to remove.
 * 2. A malformed completion is classified as the model's output, whatever the runtime called
 *    it, so the stage gets its corrective re-ask.
 * 3. A failure that survives the repair names the attempt that actually blocked it, and hands
 *    the audit the bytes around the position it stopped at.
 */

import { failureClass } from "../src/failures.js";
import { writeChunk } from "../src/pipeline.js";
import { parseDrafts, takeJsonRepair } from "../src/protocol.js";

/** A backslash, spelled so the fixture below says exactly what the model emitted. */
const B = String.fromCharCode(92);

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const ids = ["4f2a9c1b7d33", "9a01c4de22f7"];

/** `\\s` (legal escaped backslash, then `s`) in one draft, `\s` (illegal) in the other. */
const mixedShape =
	`{"drafts":[` +
	`{"task":"font scaling","statement":"the fontsize effect parses with /^[${B}s]*(${B}d+)[${B}s]*$/ and applies it to the root element","keys":["fontsize"],"refs":[0]},` +
	`{"task":"path separators","statement":"a Windows path is written with a doubled separator as in C:${B}${B}users${B}${B}tor and stays literal","keys":["paths"],"refs":[1]}` +
	`]}`;

// --- 1) the mixed shape parses, and neither statement is rewritten -------------------
{
	const parsed = parseDrafts(mixedShape, ids);
	check("a completion mixing a legal pair with an illegal escape parses", parsed.drafts.length, 2);
	check(
		"the illegal escape is repaired into the text the model meant",
		parsed.drafts[0]?.statement.includes(`/^[${B}s]*(${B}d+)[${B}s]*$/`),
		true,
	);
	check(
		"the legal pair keeps one backslash and is not doubled",
		parsed.drafts[1]?.statement.includes(`C:${B}users${B}tor`),
		true,
	);
	check("the repair is named", takeJsonRepair(), ["escaped-backslash"]);
}

// --- 2) a legal pair on its own is never rewritten -----------------------------------
{
	const legal = `{"drafts":[{"task":"regex quoting","statement":"the writer docs spell the class as ${B}${B}s and a bare backslash ${B}${B}d stays a backslash","keys":["quoting"],"refs":[0]}]}`;
	const parsed = parseDrafts(legal, ids);
	check("legal escapes parse without help", parsed.drafts.length, 1);
	check("with no repair claimed", takeJsonRepair(), undefined);
}

// --- 3) `\u` counts as an escape only with four hex digits ---------------------------
{
	const badUnicode = `{"drafts":[{"task":"unicode","statement":"the docs mention ${B}uXXXX escapes and ${B}u00e9 for a letter","keys":["unicode"],"refs":[0]}]}`;
	const parsed = parseDrafts(badUnicode, ids);
	check("a bad \\u parses after repair", parsed.drafts.length, 1);
	check(
		"the bad \\u survives as text and the good one as the character",
		parsed.drafts[0]?.statement.includes(`${B}uXXXX`),
		true,
	);
	check("the legal \\u00e9 became the character", parsed.drafts[0]?.statement.includes("é"), true);
	check("and both repairs are named", takeJsonRepair(), ["unicode-escape"]);
}

const chunk = { text: "[0] a durable fact and [1] another one", refs: ids, entryCount: 2 };

/** A writer that always answers with the same text. */
const bareWriter = (content: string) => ({
	model: "fake",
	async complete(_system: string, _user: string, _label: string) {
		return {
			content,
			usage: { inTokens: 10, outTokens: 10, wallS: 0 },
			model: { provider: "test", id: "fake" },
		};
	},
});

// --- 4) a bad escape now gets the corrective re-ask ----------------------------------
{
	// Balanced, so the strict parse reaches JSON.parse and stops on the escape. The trailing
	// comma in `refs` is the defect the escape repair cannot touch.
	const unrepairable = `{"drafts":[{"task":"limits","statement":"the writer wrote ${B}s in this statement and it is comfortably long enough","keys":[],"refs":[0,]}]}`;
	const asks: { label: string; user: string }[] = [];
	const captured: { stage: string; content: string; position?: number; repairs: string[] }[] = [];
	const writer = {
		model: "fake",
		async complete(_system: string, user: string, label: string) {
			asks.push({ label, user });
			return {
				content: unrepairable,
				usage: { inTokens: 10, outTokens: 10, wallS: 0 },
				model: { provider: "test", id: "fake" },
			};
		},
	};
	let error: unknown;
	try {
		await writeChunk(writer as never, [], "hy-parse-001", chunk, {
			onParseFailure: (f) =>
				captured.push({
					stage: f.stage,
					content: f.content,
					position: f.error.position,
					repairs: f.error.repairs,
				}),
		});
	} catch (e) {
		error = e;
	}
	const message = String((error as Error)?.message ?? error);
	check("the stage was re-asked once with the parse error", asks.length, 2);
	check("the second ask is labelled as the retry", /json retry/.test(asks[1]?.label ?? ""), true);
	check("the re-ask carries the parse error", asks[1]?.user.includes("could not be parsed"), true);
	check("the failure is the model's output, not an endpoint outage", failureClass(error), "output");
	check(
		"the message names the strict defect and the one that survived the repair",
		/Bad escaped character/.test(message) &&
			/repaired with escaped-backslash/.test(message) &&
			/still failed/.test(message),
		true,
	);
	check("the failing completion was handed over", captured.length, 2);
	check("for the extract stage", captured[0]?.stage, "extract");
	check("with the repair that was attempted", captured[0]?.repairs, ["escaped-backslash"]);
	check(
		"with a position that points at the escape in the bytes the model wrote",
		// The runtime names the character after the backslash, so the backslash is one earlier.
		[
			captured[0]?.content.charAt((captured[0]?.position ?? 0) - 1),
			captured[0]?.content.charAt(captured[0]?.position ?? -1),
		],
		[B, "s"],
	);
}

// --- 5) a completion with no JSON in it is captured too --------------------------------
{
	// The runtime named no position for this one, so the capture must still work and the stage
	// must still get its re-ask.
	const caught: { position?: number; repairs: string[] }[] = [];
	let error: unknown;
	try {
		await writeChunk(bareWriter("I could not answer this chunk."), [], "hy-parse-002", chunk, {
			onParseFailure: (f) => caught.push({ position: f.error.position, repairs: f.error.repairs }),
		});
	} catch (e) {
		error = e;
	}
	check("a completion with no JSON in it is still the model's output", failureClass(error), "output");
	check("and it is captured with no position rather than a wrong one", caught[0], {
		position: undefined,
		repairs: [],
	});
}

// --- 6) a transport failure is still an endpoint failure -----------------------------
{
	const wrapped = new Error("extract hy-parse-002: terminated", {
		cause: Object.assign(new Error("socket closed"), { status: undefined }),
	});
	check("a dropped stream stays an endpoint failure", failureClass(wrapped), "endpoint");
	const withStatus = Object.assign(new Error("reconcile hy-parse-002: 502 Bad Gateway"), { status: 502 });
	check("an HTTP status outranks wording", failureClass(withStatus), "endpoint");
}

console.log(
	failures === 0
		? "ok: parse failures — a mixed-escape completion parses, a malformed completion is the model's fault and gets its re-ask, and the audit gets the bytes"
		: `${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
