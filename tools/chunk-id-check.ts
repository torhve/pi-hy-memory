#!/usr/bin/env node
/**
 * Chunk-id check. Run: npx tsx tools/chunk-id-check.ts
 *
 * Reproduces the collision from session 01a14a46: chunk 003 failed and left no
 * record, so "count the extract records" reported 4 writes and issued 005 again
 * after a reload — the pre-reload 005 already existed. Entry ids are derived
 * from `${chunkId}:${draft}:${action}`, so that produced 7 pairs of bank entries
 * with identical ids.
 */
import { highestChunkSeq } from "../src/chunks.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const rec = (chunkId: string, type = "hy.ops") => ({ chunkId, type });

// The real ledger: 001, 002, 004, 005 then a second 005 after a reload.
const real = [
	rec("hy-01a14a46-001", "hy.extract"),
	rec("hy-01a14a46-001"),
	rec("hy-01a14a46-002", "hy.extract"),
	rec("hy-01a14a46-002"),
	rec("hy-01a14a46-004", "hy.extract"),
	rec("hy-01a14a46-004"),
	rec("hy-01a14a46-005", "hy.extract"),
	rec("hy-01a14a46-005"),
];
check("highest wins over count", highestChunkSeq(real), 5);

// A gap (003 failed) must not shift the counter backwards.
check("gap does not regress", highestChunkSeq([rec("hy-aaaaaaaa-001"), rec("hy-aaaaaaaa-004")]), 4);

// Unparseable ids fall back to the number of extract records.
check(
	"fallback to count",
	highestChunkSeq([
		{ chunkId: "weird", type: "hy.extract" },
		{ chunkId: "weird2", type: "hy.extract" },
	]),
	2,
);

// Two-digit sequences are ordered numerically, not lexically.
check("numeric order", highestChunkSeq([rec("hy-aaaaaaaa-009"), rec("hy-aaaaaaaa-010")]), 10);

console.log(failures === 0 ? "ok: chunk ids" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
