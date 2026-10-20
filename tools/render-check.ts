/**
 * Compaction rendering check.
 *
 * Pins the properties `renderMemory` must hold, all of which bit at some point:
 *
 * 1. Budget violation. The rendered string could exceed `maxTokens` by a wide
 *    margin (measured: 299 tokens against a 150-token budget) because a
 *    weakest-fact replacement never adjusted the running total, and because the
 *    header and the omission tail were not counted against the budget at all.
 * 2. Admission order. Facts are admitted newest-first, because the header promises
 *    the model that the later of two conflicting lines is the current state.
 *    Chronological admission kept the oldest N instead (measured on session
 *    01a1510e: the one omitted fact was the newest in the bank).
 * 3. Omission is a bin-packing skip, not a cut: one oversized fact does not take
 *    the budget of the facts that would have fit around it.
 *
 * There is no relevance tier any more (see DESIGN.md, *Ranking*), so nothing here
 * asserts that one fact outranks another on anything but recency.
 */

import { renderMemory, summaryBudget } from "../src/render.js";

const estimate = (s: string): number => Math.max(1, Math.round(s.length / 4));

const fact = (id: string, chars: number, createdAt: string) =>
	({
		id,
		createdAt,
		status: "active",
		chunkId: "c",
		task: "t",
		statement: "x".repeat(chars),
		keys: [],
		sourceEntryIds: [],
		tokenCount: Math.round(chars / 4),
	}) as never;

/** Header + tail overhead, measured through the module itself. */
const tiny = renderMemory([fact("t", 4, "2026-01-01T00:00:00Z")], 1_000_000);
const overhead = estimate(tiny) - Math.round(`[t] (t) ${"x".repeat(4)}`.length / 4);

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// (a) Everything fits: all facts present, chronological, no omission tail.
const many = Array.from({ length: 50 }, (_, i) =>
	fact(`f${i}`, 200, `2026-01-01T00:${String(i).padStart(2, "0")}:00Z`),
);
const wide = renderMemory(many, 12_000);
check("fits under 12k", wide.includes("f49") && wide.includes("f0") && !wide.includes("not shown"));
check("chronological order", wide.indexOf("[f0]") < wide.indexOf("[f49]"));
check("respects 12k", estimate(wide) <= 12_000, `${estimate(wide)} tokens`);

// (b) Over budget: the whole string stays within the cap and says how much it hid.
const tight = renderMemory(many, 300);
const hidden = Number(/(\d+) more facts? not shown/.exec(tight)?.[1] ?? -1);
check("stays within 300", estimate(tight) <= 300, `${estimate(tight)} tokens`);
check("reports what it hid", hidden >= 0, `hidden=${hidden}`);
check(
	"hidden count matches",
	hidden === 50 - (tight.match(/^\[f\d+\]/gm) ?? []).length,
	`hidden=${hidden} shown=${(tight.match(/^\[f\d+\]/gm) ?? []).length}`,
);

// (c) A pool-full bank must still render completely: the pool counts fact text,
//     the summary adds ~14 tokens per fact of id/task overhead (measured 1.19x),
//     so rendering a full pool at the pool number silently drops the newest facts.
const full = Array.from({ length: 161 }, (_, i) =>
	fact(`g${i}`, 288, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()),
);
const atPool = renderMemory(full, 12_000);
const withSummaryBudget = renderMemory(full, summaryBudget(12_000, full));
check("pool number truncates a full bank", atPool.includes("not shown"), `${estimate(atPool)} tokens`);
check(
	"summaryBudget renders it whole",
	!withSummaryBudget.includes("not shown") && estimate(withSummaryBudget) <= summaryBudget(12_000, full),
	`${estimate(withSummaryBudget)}/${summaryBudget(12_000, full)} tokens`,
);

// (d) Over budget: the newest facts survive and the oldest are omitted.
const sameRank = Array.from({ length: 20 }, (_, i) =>
	fact(`s${i}`, 400, new Date(Date.UTC(2026, 0, 1, 0, 1, i)).toISOString()),
);
const tightSame = renderMemory(sameRank, overhead + 1_200);
check("newest survives", tightSame.includes("[s19]"));
check("oldest is the one omitted", !tightSame.includes("[s0]"), tightSame.match(/^\[s\d+\]/m)?.[0]);
check(
	"omission count",
	Number(/(\d+) more facts? not shown/.exec(tightSame)?.[1] ?? -1) ===
		20 - (tightSame.match(/^\[s\d+\]/gm) ?? []).length,
);
check(
	"printing stays chronological",
	tightSame.indexOf("[s19]") > tightSame.indexOf(tightSame.match(/^\[s\d+\]/m)?.[0] ?? ""),
);

// (e) One oversized fact is skipped, not fatal: it does not consume the budget that
//     the smaller facts behind it in admission order can still use.
const skip = renderMemory(
	[
		fact("small-old", 200, "2026-01-01T00:00:00Z"),
		fact("small-mid", 200, "2026-01-01T00:01:00Z"),
		fact("huge-new", 4_000, "2026-01-01T00:02:00Z"),
	],
	overhead + 600,
);
check(
	"an oversized fact is skipped, not fatal",
	skip.includes("[small-mid]") && skip.includes("[small-old]") && !skip.includes("[huge-new]"),
);
check("and it is counted as omitted", /1 more fact not shown/.test(skip), skip.match(/\d+ more facts? not shown/)?.[0]);

console.log(failures === 0 ? "ok: render budget + admission" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
