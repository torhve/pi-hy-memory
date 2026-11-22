#!/usr/bin/env node
/**
 * Empty-shape check. Run: npx tsx tools/empty-shape-check.ts
 *
 * The extract contract is `{"drafts": [...]}`, the reconcile contract is `{"ops": [...]}`. A
 * completion that answers with an object, a string, or no such key at all is not an empty
 * answer — it is a completion that failed the contract. `parseDrafts` and `parseOps` used to
 * read `Array.isArray(x) ? x : []`, so all three shapes came back as a successful parse with
 * nothing in it: the chunk's drafts were discarded, `ChunkWrite.ops` was `[]`, the ledger
 * recorded a clean write, and the model's mistake never reached the corrective re-ask or the
 * audit.
 *
 * An empty array is different. `{"drafts":[]}` is the answer the prompt asks for when a chunk
 * holds nothing durable, and it stays a legitimate empty write.
 */

import { failureClass } from "../src/failures.js";
import { writeChunk } from "../src/pipeline.js";
import { parseDrafts, parseOps } from "../src/protocol.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const ids = ["4f2a9c1b7d33", "9a01c4de22f7"];
const bankIds = new Set(["5882a9281052", "c0ffee00cafe"]);

/** Run `fn` and return what it threw, or undefined when it returned. */
const threw = (fn: () => unknown): unknown => {
	try {
		fn();
		return undefined;
	} catch (error) {
		return error;
	}
};

const textOf = (error: unknown): string | undefined =>
	error === undefined ? undefined : error instanceof Error ? error.message : String(error);

// --- 1) a top-level key that is not an array is a parse failure ------------------------------

for (const [raw, key, held] of [
	[`{"drafts":{}}`, "drafts", "an object"],
	[`{"drafts":"none"}`, "drafts", "a string"],
	[`{"drafts":null}`, "drafts", "null"],
	[`{"notes":"nothing durable here"}`, "drafts", "missing"],
	[`{"ops":"none"}`, "ops", "a string"],
	[`{"ops":{}}`, "ops", "an object"],
	[`{"notes":"nothing durable here"}`, "ops", "missing"],
] as const) {
	const parse = () => (key === "drafts" ? parseDrafts(raw, ids) : parseOps(raw, 2, bankIds));
	const error = threw(parse);
	const text = textOf(error);
	check(`${raw} fails the parse`, error !== undefined, true);
	check(`${raw} names "${key}"`, text?.includes(`"${key}"`), true);
	check(`${raw} says what it held instead of an array`, text?.includes(`${held}, not an array`), true);
	check(
		`${raw} is the model's output, not an endpoint fault`,
		error === undefined ? undefined : failureClass(error),
		"output",
	);
}

// --- 2) an empty array stays the legitimate empty answer -------------------------------------

check(
	"an empty drafts array parses as nothing to do",
	[parseDrafts('{"drafts":[]}', ids).drafts.length, threw(() => parseDrafts('{"drafts":[]}', ids))],
	[0, undefined],
);
check("and nothing is rejected on the way", parseDrafts('{"drafts":[]}', ids).rejected.length, 0);
check(
	"an empty ops array parses as nothing to do",
	[parseOps('{"ops":[]}', 2, bankIds).ops.length, threw(() => parseOps('{"ops":[]}', 2, bankIds))],
	[0, undefined],
);
check("and nothing is rejected on the way there either", parseOps('{"ops":[]}', 2, bankIds).rejected.length, 0);

// --- 3) the shape failure reaches the corrective re-ask and the audit ------------------------

const chunk = { text: "[0] a durable fact and [1] another one", refs: ids, entryCount: 2 };

const validExtract =
	'{"drafts":[{"task":"build target","statement":"the memory extension builds to dist with the tsx runner and nothing else","keys":["build"],"refs":[0]}]}';
const validOps = '{"ops":[{"action":"ADD","draft":0}]}';

type Answer = { extract?: string; retry?: string; reconcile?: string };

/** A writer that answers `extract` / `reconcile` first, and `retry` when re-asked. */
const scripted = (answers: Answer) => {
	const calls: string[] = [];
	const asks: { label: string; user: string }[] = [];
	const writer = {
		model: "fake",
		async complete(_system: string, user: string, label: string) {
			const stage = label.startsWith("extract") ? "extract" : "reconcile";
			const asked = calls.filter((c) => c === stage).length;
			calls.push(stage);
			asks.push({ label, user });
			const content =
				stage === "extract"
					? asked === 0
						? (answers.extract ?? validExtract)
						: (answers.retry ?? validExtract)
					: asked === 0
						? (answers.reconcile ?? validOps)
						: validOps;
			return {
				content,
				usage: { inTokens: 10, outTokens: 10, wallS: 1 },
				model: { provider: "test", id: "fake" },
			};
		},
	};
	return { calls, asks, writer };
};

async function drive(answers: Answer) {
	const { calls, asks, writer } = scripted(answers);
	const audited: { stage: string; class: string; message: string }[] = [];
	let error: string | undefined;
	let drafts = 0;
	let ops = 0;
	try {
		const write = await writeChunk(writer as never, [], "hy-shape-001", chunk, {
			onParseFailure: (f) =>
				audited.push({
					stage: f.stage,
					class: failureClass(f.error),
					message: f.error.message,
				}),
		});
		drafts = write.drafts.length;
		ops = write.ops.length;
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}
	return { calls, asks, audited, error, drafts, ops };
}

{
	const run = await drive({ extract: '{"drafts":{}}' });
	check("a wrong-shape extract is asked again, once", run.calls, ["extract", "extract", "reconcile"]);
	check("its drafts survive the re-ask", [run.drafts, run.ops], [1, 1]);
	check(
		"the audit sees the extract shape",
		run.audited.map((a) => [a.stage, a.class]),
		[["extract", "output"]],
	);
	check(
		"the audit line carries the shape, not the parser's silence",
		run.audited[0]?.message.includes('"drafts" is an object, not an array'),
		true,
	);
	check("the re-ask tells the writer what it got", run.asks[1]?.user.includes("not an array"), true);
}

{
	const run = await drive({ reconcile: '{"ops":"none"}' });
	check("a wrong-shape reconcile is asked again, once", run.calls, ["extract", "reconcile", "reconcile"]);
	check("its op survives the re-ask", [run.drafts, run.ops], [1, 1]);
	check(
		"the audit sees the reconcile shape as the model's output",
		run.audited.map((a) => [a.stage, a.class]),
		[["reconcile", "output"]],
	);
}

{
	const run = await drive({ extract: '{"drafts":{}}', retry: '{"drafts":"still not an array"}' });
	check("a second wrong shape ends the write", run.calls, ["extract", "extract"]);
	check("with no drafts and no ops written", [run.drafts, run.ops], [0, 0]);
	check("and the failure says which key was wrong", run.error?.includes('"drafts"'), true);
	check("after exactly one re-ask", run.asks.length, 2);
}

{
	const run = await drive({ extract: '{"drafts":[]}' });
	check(
		"an empty drafts array is still a clean write",
		[run.error, run.drafts, run.audited.length],
		[undefined, 0, 0],
	);
}

console.log(failures === 0 ? "\nall shape assertions pass" : `\n${failures} shape assertions failed`);
process.exit(failures === 0 ? 0 : 1);
