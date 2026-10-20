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

console.log(failures === 0 ? "ok: json repair" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
