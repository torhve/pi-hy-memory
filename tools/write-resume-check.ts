#!/usr/bin/env node
/**
 * Coverage and resume checks. Run: npx tsx tools/write-resume-check.ts
 *
 * 1) serializeEntries must take the OLDEST pending entries that fit. The
 *    watermark is one id, so skipping a middle entry loses it forever. The old
 *    suffix-first walk would have dropped ~3 000 of the oldest tokens on session
 *    01a14a46 (23 365 pending against a 20 000 cap).
 *
 * 2) A reconcile that fails after a successful extract must not re-extract on the
 *    retry: 25 failures in a row re-paid a 15–20 k-token extraction each time.
 */
import { serializeEntries } from "../src/entries.js";
import { type Writer, WriterError } from "../src/llm.js";
import { writeChunk } from "../src/pipeline.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

// --- 1) contiguity ---------------------------------------------------------
{
	const entry = (id: string, chars: number) => ({
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(1700000000000).toISOString(),
		message: { role: "user", content: "x".repeat(chars) },
	});
	const entries = Array.from({ length: 10 }, (_, i) => entry(`e${i}`, 400)) as any[];
	const chunk = serializeEntries(entries, { maxTokens: 300 });
	// Each rendered line is ~105 tokens, so a 300-token budget fits two.
	check("keeps a contiguous prefix", chunk.refs, ["e0", "e1"]);
	check("reports the dropped tail", chunk.droppedEntries, 8);
	const big = serializeEntries(entries, { maxTokens: 10000 });
	check("everything fits", [big.refs.length, big.droppedEntries], [10, 0]);
}

// --- 2) resume after a failed reconcile ------------------------------------
const drafts = {
	drafts: [
		{
			task: "t",
			statement: "a perfectly good durable fact that passes validation",
			keys: ["k"],
			confidence: 0.9,
			refs: [0],
		},
	],
};
let extractCalls = 0;
let reconcileCalls = 0;
/** extract always succeeds; the first reconcile fails the way the proxy did. */
const writer: Writer = {
	model: "fake",
	async complete(_system, _user, label) {
		if (label.startsWith("extract")) {
			extractCalls++;
			return { content: JSON.stringify(drafts), usage: { inTokens: 100, outTokens: 50, wallS: 0 } };
		}
		reconcileCalls++;
		if (reconcileCalls === 1) throw new WriterError(`${label}: HTTP 504 Gateway Time-out`, 504);
		return {
			content: JSON.stringify({ ops: [{ action: "ADD", draft: 0 }] }),
			usage: { inTokens: 200, outTokens: 30, wallS: 0 },
		};
	},
};

{
	const chunk = { text: "[0] something", refs: ["aaaa1111"], entryCount: 1, droppedEntries: 0, chars: 12 };
	const bank: any[] = [];

	let saved: any = null;
	const persist = (record: any) => {
		saved = {
			chunkId: record.chunkId,
			coversUpToId: record.coversUpToId,
			drafts: record.drafts,
			rejected: [],
			usage: record.usage,
			refs: chunk.refs,
		};
	};

	try {
		await writeChunk(writer, bank, "hy-test-001", chunk, { onExtract: persist });
		check("first attempt should fail", "succeeded", "threw");
	} catch (error) {
		check(
			"first attempt fails at reconcile",
			String((error as Error).message).includes("reconcile hy-test-001"),
			true,
		);
	}
	check("extract ran once", extractCalls, 1);
	check("extract record captured", saved?.chunkId, "hy-test-001");

	const result = await writeChunk(writer, bank, "hy-test-001", chunk, {
		resume: {
			drafts: saved.drafts,
			rejected: [],
			usage: saved.usage,
			refs: saved.refs,
			coversUpToId: saved.coversUpToId,
		},
		onExtract: () => check("resume must not re-persist", "called", "skipped"),
	});
	check("extract not repeated on retry", extractCalls, 1);
	check("reconcile retried", reconcileCalls, 2);
	check(
		"records produced",
		result.records.map((r) => r.type),
		["hy.extract", "hy.ops"],
	);
	check("one fact added", bank.filter((e) => e.status === "active").length, 1);

	console.log(failures === 0 ? "ok: coverage + resume" : `${failures} failure(s)`);
	process.exit(failures === 0 ? 0 : 1);
}
