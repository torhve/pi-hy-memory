/**
 * The bank-aware draft gate is an experiment arm (TODO 7.10). Normally the extract call
 * sees one chunk of transcript and nothing else, which is why a redundant draft is
 * proposed before anything knows it is redundant. With the option on, extract also sees
 * the bank's task lines.
 *
 * This check pins the plumbing and the shape of what arrives: the index reaches the call
 * when the option is set and reaches nothing when it is not; it never arrives looking
 * like transcript; the cap drops whole entries rather than cutting one in half; and the
 * default path is byte-identical to the one every published baseline ran on.
 *
 * What it cannot prove is model behaviour. Whether a writer withholds a redundant draft
 * when it sees the index is a run measurement, not a fixture, and this file says so
 * rather than implying otherwise.
 */

import { writeChunk } from "../src/pipeline.js";
import { BANK_INDEX_CLAUSE, renderBankIndex } from "../src/render.js";
import type { BankEntry } from "../src/types.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const entry = (id: string, task: string, statement: string, over: Partial<BankEntry> = {}): BankEntry => ({
	id,
	task,
	statement,
	keys: [task.toLowerCase()],
	sourceEntryIds: ["aaaa1111bbbb2222"],
	chunkId: "chunk-1",
	chunkSeq: 1,
	fromUser: true,
	createdAt: "2026-01-01T00:00:00.000Z",
	status: "active",
	tokenCount: Math.ceil(statement.length / 4),
	...over,
});

const CHUNK = "[0] user: keep the retry window at 90s\n[1] assistant: set to 90s";

/** Records what each stage was actually shown. `badExtractOnce` makes the first extract
 * reply unparseable, which is what forces the JSON re-ask. */
function spy(badExtractOnce = false) {
	const seen: { label: string; system: string; user: string }[] = [];
	let extractAnswers = 0;
	return {
		seen,
		writer: {
			model: "fake",
			async complete(system: string, user: string, label: string) {
				seen.push({ label, system, user });
				if (label.startsWith("extract")) {
					extractAnswers++;
					return {
						content:
							badExtractOnce && extractAnswers === 1
								? "I could not shape this as JSON: the fact is about the retry window"
								: JSON.stringify({ drafts: [] }),
						usage: { inTokens: 100, outTokens: 5, wallS: 0 },
						model: { provider: "test", id: "fake" },
					};
				}
				return {
					content: JSON.stringify({ ops: [] }),
					usage: { inTokens: 200, outTokens: 5, wallS: 0 },
					model: { provider: "test", id: "fake" },
				};
			},
		},
	};
}

const bank: BankEntry[] = [
	entry("aaaaaaaaaaaa", "retry window", "The retry window stays at 90 seconds.", {
		createdAt: "2026-01-01T00:00:01.000Z",
	}),
	entry("bbbbbbbbbbbb", "queue depth", "Queue depth is 64.", { createdAt: "2026-01-01T00:00:02.000Z" }),
	entry("cccccccccccc", "old decision", "Superseded: the lock was replaced by flock.", {
		status: "superseded",
		createdAt: "2026-01-01T00:00:03.000Z",
	}),
];

// ---- 1) the flagless path is the published path ------------------------------------
{
	const s = spy();
	await writeChunk(s.writer as never, bank, "chunk-2", CHUNK, {});
	const extract = s.seen.find((c) => c.label.startsWith("extract"))!;
	check("no option, no index: extract is shown the chunk and nothing else", extract.user, CHUNK);
	check("no option, no clause either", extract.user.includes("existing_memory"), false);
}

// ---- 2) with the option, the index arrives and the chunk is untouched --------------
{
	const s = spy();
	await writeChunk(s.writer as never, bank, "chunk-2", CHUNK, { bankIndex: true });
	const extract = s.seen.find((c) => c.label.startsWith("extract"))!;
	check("index first", extract.user.startsWith("<existing_memory>"), true);
	check("chunk text arrives verbatim at the end", extract.user.endsWith(CHUNK), true);
	check("the clause is present once", extract.user.split(BANK_INDEX_CLAUSE).length - 1, 1);
	check(
		"active entries are listed",
		[
			extract.user.includes("- (retry window) The retry window stays at 90 seconds."),
			extract.user.includes("- (queue depth) Queue depth is 64."),
		],
		[true, true],
	);
	check("a superseded entry is not offered as current", extract.user.includes("cccccccccccc"), false);
	// The ids belong to reconcile. Extract has no use for them, and an id is the one
	// thing a draft must never have to guess at.
	check(
		"no bank ids in the extract call",
		bank.some((e) => extract.user.includes(e.id)),
		false,
	);
	// A line starting with a bracketed number is a transcript line: refs are how a draft
	// gets grounded, so nothing in the background block may look like one.
	const block = extract.user.slice(0, extract.user.indexOf("</existing_memory>"));
	check(
		"no line in the block reads as a transcript ref",
		block.split("\n").filter((line) => /^\[\d+\]/.test(line)).length,
		0,
	);
	check("the system prompt is untouched", extract.system.includes("Extract durable memory candidates"), true);
}

// ---- 3) the cap drops whole entries, never half a fact -----------------------------
{
	const wide: BankEntry[] = Array.from({ length: 12 }, (_, i) =>
		entry(
			`id${String(i).padStart(11, "0")}`,
			`subject ${i}`,
			`Statement number ${i} long enough to matter: ${"filler ".repeat(12)}`.trim(),
			{ createdAt: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z` },
		),
	);
	const { block, shown, omitted } = renderBankIndex(wide, 200);
	check("the cap bites", shown < wide.length, true);
	check("shown + omitted is every active entry", shown + omitted, wide.length);
	check("the tail says how many are missing", /… \d+ more not shown/.test(block), true);
	const lines = block.split("\n").filter((l) => l.startsWith("- ("));
	check(
		"every line shown is a whole entry",
		wide.filter((e) => lines.includes(`- (${e.task}) ${e.statement}`)).length,
		shown,
	);
	check(
		"no line is a truncated statement",
		lines.filter((l) => !wide.some((e) => l.endsWith(e.statement))).length,
		0,
	);
	// Newest first: when the cap bites, what goes is the oldest knowledge, not the live state.
	check(
		"the newest entries survive the cap",
		wide.slice(-shown).every((e) => block.includes(`- (${e.task})`)),
		true,
	);
}

// ---- 4) an empty bank says nothing -------------------------------------------------
{
	const s = spy();
	await writeChunk(s.writer as never, [], "chunk-2", CHUNK, { bankIndex: true });
	const extract = s.seen.find((c) => c.label.startsWith("extract"))!;
	check("nothing stored, nothing added to the call", extract.user, CHUNK);
	check("renderBankIndex on an empty bank returns no block", renderBankIndex([], 600).block, "");
}

// ---- 5) a resumed extract is not re-paid, index or no index ------------------------
{
	const s = spy();
	await writeChunk(s.writer as never, bank, "chunk-2", CHUNK, {
		bankIndex: true,
		resume: {
			drafts: [],
			rejected: [],
			usage: { inTokens: 100, outTokens: 5, wallS: 0 },
			refs: ["aaaa1111bbbb2222"],
			coversUpToId: "aaaa1111bbbb2222",
		},
	});
	check("resume skips the extract call entirely", s.seen.filter((c) => c.label.startsWith("extract")).length, 0);
}

// ---- 6) the JSON re-ask is not a call that forgets the index ----------------------
{
	const s = spy(true);
	await writeChunk(s.writer as never, bank, "chunk-2", CHUNK, { bankIndex: true });
	const asks = s.seen.filter((c) => c.label.startsWith("extract"));
	check("the unparseable reply was re-asked once", asks.length, 2);
	check("the re-ask is labelled as the retry", /json retry/.test(asks[1].label), true);
	check("the re-ask still carries the index", asks[1].user.startsWith("<existing_memory>"), true);
	check("the re-ask still carries the chunk", asks[1].user.includes(CHUNK), true);
	check("the parse error is appended after the chunk", asks[1].user.endsWith(CHUNK), false);
	check("the system prompt is the same on both attempts", asks[0].system === asks[1].system, true);
}

if (failures > 0) {
	console.log(`FAILED: ${failures} assertion(s)`);
	process.exit(1);
}
console.log(
	"ok: the index reaches extract when asked and never otherwise, arrives as background rather than transcript, survives the JSON re-ask, drops whole entries when the cap bites, and leaves the published flagless path byte-identical",
);
