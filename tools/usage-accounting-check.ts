#!/usr/bin/env node
/**
 * Usage accounting check. Run: npx tsx tools/usage-accounting-check.ts
 *
 * A stage that answers with something unparseable gets one corrective re-ask (`src/pipeline.ts`).
 * Both calls cost tokens, and the ledger record is the only place those tokens outlive the
 * session: `statsFromLedger` sums them, the footer prints the sum, and `writeTimingsFromLedger`
 * reads `wallS` to predict the next write. A record that names only the first call therefore
 * understates the write permanently — a replay cannot recover a number that was never written.
 *
 * What this check pins is the sum of the calls, in each place a reader looks: the value
 * `writeChunk` returns, the `hy.extract` record, and the `hy.ops` record. Every case also asserts
 * the calls the writer actually made and the `retriedJson` flag, so a total that matches only
 * because the writer never re-asked fails too.
 *
 * What it cannot prove: that a retried stage's `wallS` equals the elapsed time of the stage. The
 * two calls are serial, so the sum is their combined call time and excludes the gap between them.
 */

import type { Writer } from "../src/llm.js";
import { writeChunk } from "../src/pipeline.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const CALLS = {
	extractFirst: { inTokens: 1000, outTokens: 50, wallS: 3 },
	extractRetry: { inTokens: 1200, outTokens: 60, wallS: 2.5 },
	reconcileFirst: { inTokens: 800, outTokens: 30, wallS: 2 },
	reconcileRetry: { inTokens: 900, outTokens: 40, wallS: 1.5 },
};
const SUM = {
	extract: { inTokens: 2200, outTokens: 110, wallS: 5.5 },
	reconcile: { inTokens: 1700, outTokens: 70, wallS: 3.5 },
};

const EXTRACT_OK = JSON.stringify({
	drafts: [
		{
			task: "nightly pool",
			statement: "the nightly pool stays at 12000 tokens per pass",
			keys: ["pool"],
			refs: [0],
		},
	],
});
const RECONCILE_OK = '{"ops":[{"action":"ADD","draft":0}]}';
// Both malformed beyond `repairJson`: the first breaks inside the object, the second inside the
// array, so each stage fails its strict parse and takes the re-ask.
const EXTRACT_BAD = '{"drafts":[{"statement":}]}';
const RECONCILE_BAD = '{"ops":[{"action":"ADD","draft":}]}';

const chunk = {
	text: "[0] the nightly pool stays at 12000 tokens per pass",
	refs: ["4f2a9c1b7d33"],
	entryCount: 1,
};

/** A writer that answers each stage once, or twice when that stage's first reply is the bad one. */
const fakeWriter = (opts: { badExtractFirst?: boolean; badReconcileFirst?: boolean }) => {
	const calls: { stage: "extract" | "reconcile"; usage: { inTokens: number; outTokens: number; wallS: number } }[] =
		[];
	const writer: Writer = {
		model: "fake",
		async complete(_system, _user, label) {
			const isExtract = label.startsWith("extract");
			const seen = calls.filter((c) => (c.stage === "extract") === isExtract).length;
			const usage = isExtract
				? seen === 0
					? CALLS.extractFirst
					: CALLS.extractRetry
				: seen === 0
					? CALLS.reconcileFirst
					: CALLS.reconcileRetry;
			calls.push({ stage: isExtract ? "extract" : "reconcile", usage });
			const firstFails = isExtract ? opts.badExtractFirst : opts.badReconcileFirst;
			const content =
				isExtract && seen === 0
					? firstFails
						? EXTRACT_BAD
						: EXTRACT_OK
					: !isExtract && seen === 0
						? firstFails
							? RECONCILE_BAD
							: RECONCILE_OK
						: isExtract
							? EXTRACT_OK
							: RECONCILE_OK;
			return { content, usage, model: { provider: "test", id: "fake" } };
		},
	};
	return { writer, calls };
};

const usageOf = (records: { type: string; usage?: unknown }[], type: string) =>
	records.find((r) => r.type === type)?.usage;

// --- 1) one call per stage: the numbers pass through untouched ----------------
{
	const { writer, calls } = fakeWriter({});
	const bank: any[] = [];
	const write = await writeChunk(writer, bank, "hy-usage-001", chunk);
	check(
		"one call each",
		calls.map((c) => c.stage),
		["extract", "reconcile"],
	);
	check("no stage was re-asked", write.retriedJson, {});
	check("the extract usage is that call", write.usage.extract, CALLS.extractFirst);
	check("the reconcile usage is that call", write.usage.reconcile, CALLS.reconcileFirst);
	check("the hy.extract record carries it", usageOf(write.records, "hy.extract"), CALLS.extractFirst);
	check("the hy.ops record carries it", usageOf(write.records, "hy.ops"), CALLS.reconcileFirst);
	check("one fact landed", bank.filter((e) => e.status === "active").length, 1);
}

// --- 2) the extract stage is re-asked: both calls belong to it ----------------
{
	const { writer, calls } = fakeWriter({ badExtractFirst: true });
	const bank: any[] = [];
	const write = await writeChunk(writer, bank, "hy-usage-002", chunk);
	check(
		"extract asked, re-asked, reconcile once",
		calls.map((c) => c.stage),
		["extract", "extract", "reconcile"],
	);
	check("the extract stage is flagged as re-asked", write.retriedJson, { extract: true });
	check("the extract usage sums both extract calls", write.usage.extract, SUM.extract);
	check("the hy.extract record sums them too", usageOf(write.records, "hy.extract"), SUM.extract);
	check("an unretried reconcile keeps its one call", write.usage.reconcile, CALLS.reconcileFirst);
}

// --- 3) the reconcile stage is re-asked --------------------------------------
{
	const { writer, calls } = fakeWriter({ badReconcileFirst: true });
	const bank: any[] = [];
	const write = await writeChunk(writer, bank, "hy-usage-003", chunk);
	check(
		"extract once, reconcile asked and re-asked",
		calls.map((c) => c.stage),
		["extract", "reconcile", "reconcile"],
	);
	check("the reconcile stage is flagged as re-asked", write.retriedJson, { reconcile: true });
	check("the reconcile usage sums both reconcile calls", write.usage.reconcile, SUM.reconcile);
	check("the hy.ops record sums them too", usageOf(write.records, "hy.ops"), SUM.reconcile);
	check("an unretried extract keeps its one call", write.usage.extract, CALLS.extractFirst);
}

// --- 4) a resumed write: the persisted extract sum survives, the re-ask adds ---
{
	// The extract ran in an earlier attempt and its summed usage was persisted with the drafts.
	// A resume must carry that figure forward unchanged, and still count its own reconcile calls.
	const persisted = { inTokens: 3000, outTokens: 120, wallS: 9 };
	const { writer, calls } = fakeWriter({ badReconcileFirst: true });
	const bank: any[] = [];
	const write = await writeChunk(writer, bank, "hy-usage-004", chunk, {
		resume: {
			drafts: [
				{
					task: "nightly pool",
					statement: "the nightly pool stays at 12000 tokens per pass",
					keys: ["pool"],
					refs: [0],
					fromUser: false,
				},
			],
			rejected: [],
			usage: persisted,
			refs: ["4f2a9c1b7d33"],
			coversUpToId: "4f2a9c1b7d33",
		},
	});
	check(
		"no extract call is paid again",
		calls.map((c) => c.stage),
		["reconcile", "reconcile"],
	);
	check("the extract model says resumed", write.models.extract, "resumed");
	check("the persisted extract sum survives", write.usage.extract, persisted);
	check("the resumed hy.extract record carries it", usageOf(write.records, "hy.extract"), persisted);
	check("the re-asked reconcile sums its two calls", write.usage.reconcile, SUM.reconcile);
}

console.log(failures === 0 ? "ok: usage accounting" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
