#!/usr/bin/env npx tsx

/**
 * tools/verbatim-report-check.ts — tier 1's matching rules against a chunk with known answers.
 *
 * dev/verbatim-report.ts claims that a verbatim copy of a chunk would have preserved the values an
 * accepted merge destroyed. That claim is worthless if "present in the source text" is measured
 * loosely, because the two classic loose readings both produce a recovery that no reader would grant:
 * 4096 found inside 14096, and --dry-run found inside --dry-run-all. This fixture constructs both,
 * plus the recovery cases that must survive a strict rule, plus the distinction the report turns on:
 * a value the machine printed, against a value only someone said.
 *
 *   1. 4096 inside 14096            -> false-hit: naive search claims it, the boundary rule refuses
 *   2. --dry-run inside --dry-run-all -> false-hit, same failure in flag shape
 *   3. 0640 inside *0640*           -> recoverable from the tool output once emphasis markers go
 *   4. "line 12" in an assistant line -> recoverable, but only in a spoken line
 *   5. 9999 nowhere                 -> absent, and a paraphrase of it is still absent
 *   6. an active entry sharing 4+ consecutive words with its source -> still carries source wording
 *   7. an active entry that paraphrases its source -> model restatement
 *   8. pricing: the narrow surface (chunks behind the lost values) is far smaller than storing a
 *      verbatim block for every entry, and both are reported
 */

import type { CorpusChunk } from "../dev/restraint-report.js";
import { analyseVerbatim, normalise, recoverability, sharedWordRun } from "../dev/verbatim-report.js";
import { newId } from "../src/bank.js";
import type { LedgerRecord } from "../src/types.js";

let failures = 0;
function assert(cond: boolean, label: string): void {
	if (!cond) {
		console.error(`FAIL: ${label}`);
		failures += 1;
	}
}

// ---------------------------------------------------------------- the rules, tested directly

const boundaryTrap = recoverability("4096", "[2] [Tool result for bash @ 10:03]: 14096 entries max");
assert(boundaryTrap.verdict === "false-hit", "4096 inside 14096 is a false hit, not a recovery");
assert(boundaryTrap.naive, "and it is exactly the kind a naive substring search would report");

const flagTrap = recoverability("--dry-run", "[1] [Assistant]: tctl --dry-run-all is a different flag entirely");
assert(flagTrap.verdict === "false-hit", "--dry-run inside --dry-run-all is a false hit");

const emphasis = recoverability("0640", "[2] [Tool result for bash @ 10:03]: mode *0640* for the file");
assert(emphasis.verdict === "recoverable", "markdown emphasis markers are stripped, so 0640 is genuinely there");
assert(emphasis.foundIn === "tool output", "and it was the machine that wrote it");

const dashForm = recoverability("\u2013archive", "[2] [Tool result for bash]: tctl \u2013archive keeps the old queue");
assert(dashForm.verdict === "recoverable", "a typographic dash normalises on both sides of the comparison");
assert(dashForm.foundIn === "tool output", "and it was the machine that wrote it");

const dashCount = recoverability("--archive", "[2] [Tool result for bash]: tctl \u2013archive keeps the old queue");
assert(dashCount.verdict === "false-hit", "two dashes in the value against one in the source is not the same spelling");
assert(
	dashCount.foundIn === "spoken line" ||
		dashCount.foundIn === "tool output" ||
		dashCount.foundIn === "both" ||
		dashCount.foundIn === "nowhere",
	"the lookup still names where the closest wording was",
);

const spoken = recoverability("line 12", "[4] [Assistant @ 10:04]: Found it on line 12, the archive flag.");
assert(spoken.verdict === "recoverable", "a value that only the assistant said is still present in the transcript");
assert(spoken.foundIn === "spoken line", "but it is recovered from a wording, not from the source that produced it");

const missing = recoverability("9999", "[2] [Tool result for bash]: 14096 entries max");
assert(missing.verdict === "absent", "a value nobody wrote is absent");
assert(missing.foundIn === "nowhere", "and it is found in no line of the chunk");

assert(
	sharedWordRun("MAX_QUEUE 14096 entries hard cap per queue", "MAX_QUEUE 14096 entries hard cap per queue file") ===
		7,
	"a shared run of source words is counted",
);
assert(
	sharedWordRun("queue ceiling sits at 14096 hard", "MAX_QUEUE 14096 entries hard cap per queue file") < 4,
	"a paraphrase shares no long run",
);
assert(normalise("a  b\u2013c *d* `e`") === "a b-c d e", "normalisation does exactly the three allowed things");

// ---------------------------------------------------------------- the fixture run

const SOURCE_TOOL =
	"[1] [User @ 10:01]: Check the queue cap and the file mode. " +
	"[2] [Tool result for bash @ 10:02]: $ stat -c '%a' audit.toml; tctl queue --show [3] [Tool result for bash @ 10:03]: 14096 entries max, mode *0640* " +
	"[4] [Assistant @ 10:04]: Mode is 0640. The cap line is line 12 of queue.toml.";

const SOURCE_CAP = "[1] [Tool result for bash @ 11:01]: MAX_QUEUE 14096 entries hard cap per queue file";

const chunks: CorpusChunk[] = [
	{
		chunkId: "fx-to-01",
		class: "tool_output",
		probes: ["4096", "0640", "line 12"],
		text: SOURCE_TOOL,
	},
	{
		chunkId: "fx-to-02",
		class: "tool_output",
		probes: ["MAX_QUEUE", "14096"],
		text: SOURCE_CAP,
	},
	{
		chunkId: "fx-nw-01",
		class: "nothing_work",
		text: "[1] [User @ 12:01]: Just wanted to see the output, nothing to change.",
	},
];

const entryCap = {
	task: "queue cap location",
	statement: "MAX_QUEUE 14096 entries hard cap per queue",
	keys: ["MAX_QUEUE"],
};
const entryParaphrase = {
	task: "queue ceiling restated",
	statement: "The ceiling 14096 was restated later from memory",
	keys: ["14096"],
};
const entryCarriesEverything = {
	task: "queue limits and file mode",
	statement: "Queue cap is line 12 of queue.toml with 4096 entries max and mode 0640",
	keys: ["4096", "0640", "line 12", "queue.toml"],
};
const entryRestated = {
	task: "queue limits confirmed",
	statement: "User confirmed the queue limits and the file mode 0640",
	keys: ["0640"],
};

const records: LedgerRecord[] = [
	{
		type: "hy.extract",
		chunkId: "fx-to-01",
		coversUpToId: "fx-to-01-r1",
		createdAt: "2026-10-23T10:05:00.000Z",
		drafts: [
			{ ...entryCarriesEverything, refs: [], fromUser: false, sourceEntryIds: [] },
			{ ...entryRestated, refs: [], fromUser: true, sourceEntryIds: [] },
		],
		rejectedCount: 0,
		usage: { inTokens: 0, outTokens: 0, wallS: 0 },
	},
	{
		type: "hy.ops",
		chunkId: "fx-to-01",
		coversUpToId: "fx-to-01-r1",
		createdAt: "2026-10-23T10:05:01.000Z",
		ops: [
			{ action: "ADD", draft: 0 },
			{ action: "ADD", draft: 1 },
		],
		rejectedCount: 0,
		usage: { inTokens: 0, outTokens: 0, wallS: 0 },
	},
	{
		type: "hy.extract",
		chunkId: "fx-to-02",
		coversUpToId: "fx-to-02-r1",
		createdAt: "2026-10-23T11:05:00.000Z",
		drafts: [
			{ ...entryCap, refs: [], fromUser: false, sourceEntryIds: [] },
			{ ...entryParaphrase, refs: [], fromUser: false, sourceEntryIds: [] },
		],
		rejectedCount: 0,
		usage: { inTokens: 0, outTokens: 0, wallS: 0 },
	},
	{
		type: "hy.ops",
		chunkId: "fx-to-02",
		coversUpToId: "fx-to-02-r1",
		createdAt: "2026-10-23T11:05:01.000Z",
		ops: [
			{ action: "ADD", draft: 0 },
			{ action: "ADD", draft: 1 },
		],
		rejectedCount: 0,
		usage: { inTokens: 0, outTokens: 0, wallS: 0 },
	},
	{
		type: "hy.extract",
		chunkId: "fx-nw-01",
		coversUpToId: "fx-nw-01-r1",
		createdAt: "2026-10-23T12:05:00.000Z",
		drafts: [{ ...entryRestated, refs: [], fromUser: true, sourceEntryIds: [] }],
		rejectedCount: 0,
		usage: { inTokens: 0, outTokens: 0, wallS: 0 },
	},
	{
		type: "hy.ops",
		chunkId: "fx-nw-01",
		coversUpToId: "fx-nw-01-r1",
		createdAt: "2026-10-23T12:05:01.000Z",
		ops: [
			{
				action: "UPDATE",
				draft: 0,
				target: newId("fx-to-01:0:ADD"),
				reason: "same file mode, one entry",
			},
		],
		rejectedCount: 0,
		usage: { inTokens: 0, outTokens: 0, wallS: 0 },
	},
];

const a = analyseVerbatim("verbatim-fixture", records, chunks, "fixture");

const rowFor = (value: string) => a.rows.find((r) => r.value === value);

assert(a.rows.length === 2, `two declared values were dropped by the merge, saw ${a.rows.length}`);
assert(rowFor("4096")?.verdict === "false-hit", "the fixture's 4096 was never in the source as 4096");
assert(rowFor("line 12")?.verdict === "recoverable", "line 12 was in the source, in an assistant line");
assert(
	rowFor("line 12")?.foundIn === "spoken line",
	"and the report calls it a spoken line, not a recovery of the source",
);
assert(rowFor("line 12")?.survived === false, "nothing in the final bank carries line 12 after the merge");
assert(
	rowFor("4096")?.sourceChunk === "fx-to-01",
	"the lost value is looked up in the chunk that authored the entry it replaces",
);

// 0640 was declared by fx-to-01 and the replacement still carries it, so it is not a loss.
assert(!rowFor("0640"), "a value the merge restated is not reported as lost");

const quoting = a.dependencies.filter((d) => d.quotesSource);
const restating = a.dependencies.filter((d) => !d.quotesSource);
assert(
	quoting.some((d) => d.value === "MAX_QUEUE" && d.sharedWords >= 4),
	"the entry that quotes its source is counted as carrying source wording",
);
assert(
	restating.some((d) => d.value === "14096"),
	"the entry that paraphrases its source is counted as restatement",
);
assert(
	quoting.some((d) => d.value === "14096"),
	"and the value can be quoting in one entry and restated in another",
);
assert(
	a.dependencies.every((d) => d.sourceChunk === "fx-to-01" || d.sourceChunk === "fx-to-02"),
	"every dependency row is anchored to the chunk that authored its entry",
);

assert(
	a.verbatimTokens > 0 && a.verbatimTokens < a.storeAllTokens,
	"pricing the chunks behind the lost values is far cheaper than pricing a verbatim block per entry",
);
assert(a.storeAllTokens > 0, "the whole-surface price is measured, not assumed");

if (failures === 0) {
	console.log(
		`ok: verbatim fixture — ${a.rows.length} declared value(s) dropped, ` +
			`${a.rows.filter((r) => r.verdict === "recoverable").length} recoverable, ` +
			`${a.rows.filter((r) => r.verdict === "false-hit").length} false hit(s), ` +
			`${quoting.length} carrier(s) quoting source, ${restating.length} restating; ` +
			`narrow price ${a.verbatimTokens} vs whole-surface price ${a.storeAllTokens} tokens`,
	);
} else {
	console.error(`FAIL: ${failures} verbatim assertion(s) failed`);
	process.exit(1);
}
