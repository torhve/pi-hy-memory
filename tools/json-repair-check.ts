#!/usr/bin/env node
/**
 * JSON repair check. Run: npx tsx tools/json-repair-check.ts
 *
 * The writer occasionally emits JSON that is nearly right. Two classes have been
 * measured in production, both reproduced here byte-for-byte in shape:
 *
 * 1. A stray quote closing a numeric field — `"draft":5"`. Chunk 005 of the extended
 *    corpus lost three attempts to it, because the retry resumed the same drafts and
 *    produced the same string.
 * 2. A regex copied verbatim into a string — `/^[\s]*(\d+)[\s]*(?:px)?[\s]*$/` — where
 *    `\s` and `\d` are not legal JSON escapes. Chunk 003 failed its extract with
 *    `Bad escaped character in JSON at position 4825`.
 *
 * `repairJson` runs only after a strict parse has failed, so the properties that matter
 * are: the real payloads parse, the content survives intact, valid output is never
 * rewritten, and anything else still raises the strict error.
 */

import type { Writer } from "../src/llm.js";
import { writeChunk } from "../src/pipeline.js";
import { parseDrafts, parseOps, takeJsonRepair } from "../src/protocol.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const ids = ["4f2a9c1b7d33", "9a01c4de22f7", "5882a9281052", "e346eec8cf15"];

// --- 1) stray quote after the draft index (the reconcile failure) ------------
{
	const raw = `{
  "ops":[
    {"action":"ADD","draft":1,"reason":"gates for servers store deletion"},
    {"action":"ADD","draft":5","reason":"knip baseline line counts, git baseline"}
  ]
}`;
	const parsed = parseOps(raw, 8, new Set(["5882a9281052"]), undefined);
	check("reconcile with a stray quote parses", parsed.ops, [
		{ action: "ADD", draft: 1 },
		{ action: "ADD", draft: 5 },
	]);
	check("and the repair is named", takeJsonRepair(), ["quote-after-number"]);
}

// --- 2) a regex copied into a string (the extract failure) -------------------
{
	const regex = "/^[\\s]*(\\d+)[\\s]*(?:px)?[\\s]*$/";
	const raw = JSON.stringify({
		drafts: [
			{
				task: "font scaling",
				statement: `the fontsize effect parses with ${regex} and applies it to the root element`,
				keys: ["fontsize"],
				refs: [0],
			},
		],
	}).replace(/\\\\/g, "\\");
	// `raw` now carries single-backslash escapes exactly as the model emitted them.
	const parsed = parseDrafts(raw, ids);
	check("extract with an illegal escape parses", parsed.drafts.length, 1);
	check("the regex survives intact", parsed.drafts[0]?.statement.includes(regex), true);
	check("and the repair is named", takeJsonRepair(), ["escaped-backslash"]);
}

// --- 3) valid output is never rewritten -------------------------------------
{
	const raw = JSON.stringify({ ops: [{ action: "ADD", draft: 0 }] });
	parseOps(raw, 4, new Set(), undefined);
	check("valid JSON reports no repair", takeJsonRepair(), undefined);
}

// --- 4) anything else still fails loudly ------------------------------------
{
	let error = "";
	try {
		parseOps('{"ops":[{"action":"ADD","draft":}]}', 4, new Set(), undefined);
	} catch (e) {
		error = String((e as Error).message);
	}
	check("unrepairable output still throws", error.length > 0, true);
	check("and reports no repair", takeJsonRepair(), undefined);
}

// --- 5) an unparseable completion is re-asked once, not retried blind ----------
{
	// The first reconcile is hopeless; the second (prompted with the parse error) is a
	// valid object with a stray quote, which `repairJson` then fixes.
	let reconciles = 0;
	let sawNote = false;
	const writer: Writer = {
		model: "fake",
		async complete(_system, user, label) {
			if (label.startsWith("extract")) {
				return {
					content: JSON.stringify({
						drafts: [
							{
								task: "t",
								statement: "a durable fact that is long enough to pass validation",
								keys: ["k"],
								refs: [0],
							},
						],
					}),
					usage: { inTokens: 10, outTokens: 10, wallS: 0 },
					model: { provider: "test", id: "fake" },
				};
			}
			reconciles++;
			if (reconciles === 1) {
				return {
					content: '{"ops":[{"action":"ADD","draft":}]}',
					usage: { inTokens: 10, outTokens: 10, wallS: 0 },
					model: { provider: "test", id: "fake" },
				};
			}
			sawNote = user.includes("could not be parsed");
			return {
				content: '{"ops":[{"action":"ADD","draft":0"}]}',
				usage: { inTokens: 10, outTokens: 10, wallS: 0 },
				model: { provider: "test", id: "fake" },
			};
		},
	};
	const bank: any[] = [];
	const chunk = { text: "[0] a durable fact", refs: ["4f2a9c1b7d33"], entryCount: 1 };
	const write = await writeChunk(writer, bank, "hy-json-001", chunk);
	check("the reconcile was re-asked once", reconciles, 2);
	check("the re-ask carries the parse error", sawNote, true);
	check("the retry's repair is recorded", write.repaired.reconcile, ["quote-after-number"]);
	check("and the re-ask is flagged", write.retriedJson.reconcile, true);
	check("one fact landed", bank.filter((e) => e.status === "active").length, 1);
}

// --- 3) bare tokens inside an array (the `hy-reload-006` shape) --------------
{
	// Measured shape: the writer answered with entry ids instead of the `[n]` indices the chunk
	// shows, and left them unquoted. Strict parse fails at the first bare token; at temperature 0
	// the retry produced the same bytes, so the chunk was lost over syntax.
	const idsWithShort = ["da8e7079", "eb626334bdb5", "0123456789ab"];
	const bare = `{
  "drafts":[
    {"task":"nightly pool","statement":"the nightly pool stays at 12000 tokens per pass","keys":["pool"],"refs":[0,da8e7079]},
    {"task":"audit store","statement":"the audit store is capped at 64MB and is not to be moved","keys":["audit"],"refs":[1]}
  ]
}`;
	const parsed = parseDrafts(bare, idsWithShort);
	check("an unquoted array token parses after repair", parsed.drafts.length, 2);
	check("the repair is named", takeJsonRepair(), ["array-bare-token"]);
	check(
		"the repaired statement is intact",
		parsed.drafts[0].statement.startsWith("the nightly pool stays at 12000"),
		true,
	);
}

{
	// A list written inside a statement is prose. Quoting it would rewrite a fact's own wording.
	const prose = `{
  "drafts":[
    {"task":"ref syntax","statement":"refs are written as refs:[0,x] in this writer's docs and must stay indices","keys":["refs"],"refs":[2]}
  ]
}`;
	const parsed = parseDrafts(prose, ["aaaa1111", "bbbb2222", "cccc3333"]);
	check("prose that looks like a list keeps its brackets", parsed.drafts[0].statement.includes("refs:[0,x]"), true);
	check("and no repair is claimed for it", takeJsonRepair(), undefined);
}

{
	// Numbers, booleans and already-quoted strings are valid JSON array values.
	const fine = `{"drafts":[{"task":"limits","statement":"the ceiling is 24 candidates, true or false as flags","keys":["limit"],"refs":[0,1]}]}`;
	check("a well-formed array is untouched", parseDrafts(fine, ["aaaa1111", "bbbb2222"]).drafts[0].refs, [0, 1]);
	check("with no repair recorded", takeJsonRepair(), undefined);
}

{
	// A repair never invents missing structure: a truncated completion still raises.
	const truncated = `{"drafts":[{"task":"half","statement":"this statement is cut off mid sent`;
	let threw = "";
	try {
		parseDrafts(truncated, ["aaaa1111"]);
	} catch (error) {
		threw = String((error as Error).message.slice(0, 20));
	}
	check("a truncated completion still fails", threw.length > 0, true);
}

console.log(failures === 0 ? "ok: json repair" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
