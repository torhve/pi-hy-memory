#!/usr/bin/env node
/**
 * Lost-watermark check. Run: npx tsx tools/lost-cursor-check.ts
 *
 * The watermark is an entry id, and pi can move the leaf: a rewind, a resumed
 * checkpoint, or a compaction that re-parents the branch leaves the old id in the
 * session file but off the current chain. Falling back to index 0 then made the
 * whole session "pending".
 *
 * Measured on session 01a1510e (2026-10-19): write 064 covered up to `369f8228`,
 * the user rewound, and the next trigger saw **431 329 pending tokens across
 * 3 617 entries** — re-extracting history the bank already held, at one
 * 20 000-token chunk per write, chained three times per turn. That is the burst of
 * requests a reader noticed while the session looked idle.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { coverageWindow, resumeAfterLostCursor } from "../src/entries.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const message = (id: string) =>
	({ id, type: "message", message: { role: "user", content: "x" } }) as unknown as SessionEntry;
const record = (id: string, customType: string) =>
	({ id, type: "custom", customType, data: {} }) as unknown as SessionEntry;
const compaction = (id: string) => ({ id, type: "compaction", summary: "…" }) as unknown as SessionEntry;
const branch = (list: (string | { id: string; type: string })[]): SessionEntry[] =>
	list.map((x) =>
		typeof x === "string" ? message(x) : x.type === "compaction" ? compaction(x.id) : record(x.id, x.type),
	);

// 1. Our own records are the best proxy: resume right after the newest one.
check(
	"resumes after the newest writer record",
	resumeAfterLostCursor(
		branch(["m1", "m2", { id: "r1", type: "hy.extract" }, "m3", { id: "r2", type: "hy.ops" }, "m4"]),
	),
	{ index: 5, from: "record" },
);

// 2. No records in the branch (the rewind went back past the last write): pi
//    summarised everything before the compaction, so nothing before it is worth
//    re-reading.
check(
	"falls back to the last compaction",
	resumeAfterLostCursor(branch(["m1", { id: "c1", type: "compaction" }, "m2", "m3"])),
	{ index: 2, from: "compaction" },
);

// 3. Neither: an untouched session with no records yet genuinely starts at 0.
check("no marker at all", resumeAfterLostCursor(branch(["m1", "m2"])), { index: 0, from: "none" });

// 4. Multiple compactions: the newest one wins, not the oldest.
check(
	"newest compaction wins",
	resumeAfterLostCursor(branch([{ id: "c1", type: "compaction" }, "m1", { id: "c2", type: "compaction" }, "m2"])),
	{ index: 3, from: "compaction" },
);

// 5. A record beats a compaction, because it is strictly newer evidence of what
//    the writer has seen.
check(
	"record beats an older compaction",
	resumeAfterLostCursor(branch([{ id: "c1", type: "compaction" }, "m1", { id: "r1", type: "hy.extract" }, "m2"])),
	{ index: 3, from: "record" },
);

// 6. The pathological case must never come back: a lost cursor with a long
//    history must not resolve to the whole branch.
{
	const long = branch([{ id: "c1", type: "compaction" }, ...Array.from({ length: 500 }, (_, i) => `m${i}`)]);
	const resume = resumeAfterLostCursor(long);
	check("never falls back to the whole branch", resume.index, 1);
	check("and says why", resume.from, "compaction");
}

// ---------------------------------------------------------------------------
// coverageWindow: the rule that decides where the next chunk starts.

const m = (id: string, tokens: number) =>
	({
		id,
		type: "message",
		message: { role: "user", content: "x".repeat(Math.round(tokens * 4)) },
	}) as unknown as SessionEntry;
const nextId = (w: { pending: SessionEntry[] }) => (w.pending[0] as unknown as { id: string })?.id;

// 7. Normal case: the cursor is in the branch and nothing reaches further.
check(
	"window starts after the cursor",
	nextId(coverageWindow([m("a", 10), m("b", 10), m("c", 10)], [{ coversUpToId: "a" }], "b", undefined)),
	"c",
);

// 8. Drift: an older record still reaches further into the branch. This is what a
//    rewind produced — chunk 065 covered index 93 and 066 index 232 while chunk 062
//    had already covered index 3423.
{
	const entries = Array.from({ length: 20 }, (_, i) => m(`e${i}`, 10));
	const ledger = [{ coversUpToId: "e17" }, { coversUpToId: "e2" }, { coversUpToId: "e5" }];
	const w = coverageWindow(entries, ledger, "e5", undefined);
	check("drift uses the furthest coverage", nextId(w), "e18");
	check("drift is reported", w.drift, { from: "e5", to: "e17" });
}

// 9. Cursor lost entirely, but the ledger still knows how far coverage reached.
{
	const entries = Array.from({ length: 20 }, (_, i) => m(`e${i}`, 10));
	const w = coverageWindow(entries, [{ coversUpToId: "e15" }], "gone", undefined);
	check("lost cursor resumes from the ledger", nextId(w), "e16");
}

// 10. A gap record wins over older coverage: it names where coverage resumes, and
//     re-reading the range it recorded as lost would undo it.
{
	const entries = Array.from({ length: 20 }, (_, i) => m(`e${i}`, 10));
	const w = coverageWindow(entries, [{ coversUpToId: "e15" }, { coversUpToId: "gone" }], "gone", "e18");
	check("gap resume point wins", nextId(w), "e18");
}

// 11. Nothing usable at all: records or compaction in the branch, then index 0.
{
	const entries = [m("e0", 10), { id: "c1", type: "compaction" } as unknown as SessionEntry, m("e2", 10)];
	check("falls back to the compaction", nextId(coverageWindow(entries, [], "gone", undefined)), "e2");
}

// 12. A fresh session (no cursor yet) still starts at the beginning.
check("no cursor at all", nextId(coverageWindow([m("a", 10), m("b", 10)], [], undefined, undefined)), "a");

// 13. The measured regression: 3 617 entries must not become the window when the
//     ledger knows coverage reached near the end.
{
	const entries = Array.from({ length: 3617 }, (_, i) => m(`e${i}`, 1));
	const w = coverageWindow(entries, [{ coversUpToId: "e3423" }, { coversUpToId: "e93" }], "e232", undefined);
	check("history is not re-read after a rewind", w.pending.length, 3617 - 3424);
}

console.log(failures === 0 ? "ok: lost cursor" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
