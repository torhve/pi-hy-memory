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
			return {
				content: JSON.stringify(drafts),
				usage: { inTokens: 100, outTokens: 50, wallS: 0 },
				model: { provider: "test", id: "fake" },
			};
		}
		reconcileCalls++;
		if (reconcileCalls === 1) throw new WriterError(`${label}: HTTP 504 Gateway Time-out`, 504);
		return {
			content: JSON.stringify({ ops: [{ action: "ADD", draft: 0 }] }),
			usage: { inTokens: 200, outTokens: 30, wallS: 0 },
			model: { provider: "test", id: "fake" },
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
	// Every completed write names the model behind each stage, so the audit can say
	// what answered rather than what was configured. This extract was resumed from
	// the persisted drafts, so it never saw a model: it says "resumed" instead of
	// inventing one.
	check("models reported per stage", result.models, { extract: "resumed", reconcile: "test/fake" });
}

// --- 3) provenance and write order -----------------------------------------
// `fromUser` decides which facts the summary's constraint slice reserves budget for,
// and `chunkSeq` is the age the foundation slice measures. Both are set by code from
// the chunk, never by the writer, and both have to survive into the ledger records.
{
	const provenanceWriter: Writer = {
		model: "fake",
		async complete(_system, _user, label) {
			if (label.startsWith("extract")) {
				return {
					content: JSON.stringify({
						drafts: [
							{
								task: "user pref",
								statement: "the user prefers tabs over spaces everywhere",
								keys: ["tabs"],
								refs: [0],
							},
							{
								task: "tool fact",
								statement: "the config file lives at config/settings.json",
								keys: ["config"],
								refs: [1],
							},
						],
					}),
					usage: { inTokens: 10, outTokens: 10, wallS: 0 },
					model: { provider: "test", id: "fake" },
				};
			}
			return {
				content: JSON.stringify({
					ops: [
						{ action: "ADD", draft: 0 },
						{ action: "ADD", draft: 1 },
					],
				}),
				usage: { inTokens: 10, outTokens: 10, wallS: 0 },
				model: { provider: "test", id: "fake" },
			};
		},
	};
	const provenanceBank: any[] = [];
	const chunk = {
		text: "[0] [User]: tabs\n[1] [Tool result for read]: settings",
		refs: ["aaaa", "bbbb"],
		entryCount: 2,
		roles: ["user", "toolResult"],
	};
	const first = await writeChunk(provenanceWriter, provenanceBank, "hy-prov-001", chunk);
	check(
		"a user-grounded draft is marked",
		provenanceBank.map((e: any) => e.fromUser),
		[true, false],
	);
	check(
		"the first write is chunk 1",
		provenanceBank.map((e: any) => e.chunkSeq),
		[1, 1],
	);
	check(
		"provenance reaches the ledger",
		first.records[0].type === "hy.extract"
			? first.records[0].drafts.map((d: any) => d.fromUser)
			: "no extract record",
		[true, false],
	);
	await writeChunk(provenanceWriter, provenanceBank, "hy-prov-002", chunk);
	check(
		"the next write advances chunkSeq",
		provenanceBank.map((e: any) => e.chunkSeq),
		[1, 1, 2, 2],
	);
	check(
		"a chunk without roles marks nothing as user-grounded",
		(
			await writeChunk(provenanceWriter, [...provenanceBank], "hy-prov-003", { ...chunk, roles: undefined })
		).report.added.every((e) => e.fromUser === false),
		true,
	);

	console.log(failures === 0 ? "ok: coverage + resume + provenance" : `${failures} failure(s)`);
	process.exit(failures === 0 ? 0 : 1);
}
