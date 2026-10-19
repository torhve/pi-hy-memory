/**
 * Compaction rendering check.
 *
 * Pins two defects in `renderMemory`:
 *
 * 1. Budget violation. The rendered string could exceed `maxTokens` by a wide
 *    margin (measured: 299 tokens against a 150-token budget) because a
 *    weakest-fact replacement never adjusted the running total, and because the
 *    header and the omission tail were not counted against the budget at all.
 * 2. Rank misalignment. The weakest rendered fact was looked up by position in
 *    `active`, so after any skipped entry the comparison used a different fact's
 *    relevance — promoting a medium fact over a high one.
 *
 * Both only bite when the bank is near the pool cap, which is the normal state
 * once `poolMaxTokens` is reached.
 */

import { renderMemory, summaryBudget } from "../src/render.js";

const estimate = (s: string): number => Math.max(1, Math.round(s.length / 4));

const fact = (id: string, relevance: string, chars: number, createdAt: string) =>
	({
		id,
		createdAt,
		status: "active",
		relevance,
		confidence: 1,
		chunkId: "c",
		task: "t",
		statement: "x".repeat(chars),
		keys: [],
		sourceEntryIds: [],
		tokenCount: Math.round(chars / 4),
	}) as never;

/** Header + tail overhead, measured through the module itself. */
const tiny = renderMemory([fact("t", "high", 4, "2026-01-01T00:00:00Z")], 1_000_000);
const overhead = estimate(tiny) - Math.round(`[t] (t) ${"x".repeat(4)}`.length / 4);

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// (a) Everything fits: all facts present, chronological, no omission tail.
const many = Array.from({ length: 50 }, (_, i) =>
	fact(`f${i}`, "medium", 200, `2026-01-01T00:${String(i).padStart(2, "0")}:00Z`),
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

// (c) A high-relevance fact displaces a low-relevance one that is already rendered.
const budget = overhead + 250;
const promote = renderMemory(
	[fact("a", "low", 400, "2026-01-01T00:00:00Z"), fact("b", "high", 800, "2026-01-01T00:01:00Z")],
	budget,
);
check("promotes high over low", promote.includes("[b]") && !promote.includes("[a]"));
check("promotion stays in budget", estimate(promote) <= budget, `${estimate(promote)}/${budget}`);

// (d) After that displacement, a medium fact must not be weighed against the
//     displaced low one (the misalignment): B is rank high and must survive.
const mixed = renderMemory(
	[
		fact("a", "low", 400, "2026-01-01T00:00:00Z"),
		fact("b", "high", 800, "2026-01-01T00:01:00Z"),
		fact("c", "medium", 200, "2026-01-01T00:02:00Z"),
	],
	budget,
);
check("keeps high over later medium", mixed.includes("[b]") && !mixed.includes("[c]"));
check("mixed case stays in budget", estimate(mixed) <= budget, `${estimate(mixed)}/${budget}`);

// (e) A pool-full bank must still render completely: the pool counts fact text,
//     the summary adds ~14 tokens per fact of id/task overhead (measured 1.19x),
//     so rendering a full pool at the pool number silently drops the newest facts.
const full = Array.from({ length: 161 }, (_, i) =>
	fact(`g${i}`, "high", 288, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()),
);
const atPool = renderMemory(full, 12_000);
const withSummaryBudget = renderMemory(full, summaryBudget(12_000, full));
check("pool number truncates a full bank", atPool.includes("not shown"), `${estimate(atPool)} tokens`);
check(
	"summaryBudget renders it whole",
	!withSummaryBudget.includes("not shown") && estimate(withSummaryBudget) <= summaryBudget(12_000, full),
	`${estimate(withSummaryBudget)}/${summaryBudget(12_000, full)} tokens`,
);

// (f) Equal relevance, over budget: the newest facts survive and the oldest are
//     omitted. Before this, chronological admission kept the first N — the oldest —
//     while the header promises that the later line is the current state. Measured
//     on session 01a1510e: the one omitted fact was the newest in the bank.
const sameRank = Array.from({ length: 20 }, (_, i) =>
	fact(`s${i}`, "high", 400, new Date(Date.UTC(2026, 0, 1, 0, 1, i)).toISOString()),
);
const tightSame = renderMemory(sameRank, overhead + 1_200);
check("newest survives at equal rank", tightSame.includes("[s19]"));
check("oldest is the one omitted", !tightSame.includes("[s0]"), tightSame.match(/^\[s\d+\]/m)?.[0]);
check(
	"equal-rank omission count",
	Number(/(\d+) more facts? not shown/.exec(tightSame)?.[1] ?? -1) ===
		20 - (tightSame.match(/^\[s\d+\]/gm) ?? []).length,
);
check(
	"printing stays chronological",
	tightSame.indexOf("[s19]") > tightSame.indexOf(tightSame.match(/^\[s\d+\]/m)?.[0] ?? ""),
);

// (g) Relevance still dominates recency: an older high fact displaces a newer low
//     one. The budget is measured, not guessed: header + tail + room for exactly one
//     ~104-token fact (+30 covers the margin between "rendered size" and "budget",
//     since the header and tail reserve are always subtracted).
const oneFact = estimate(renderMemory([fact("probe", "low", 400, "2026-01-01T00:00:00Z")], 1_000_000));
const rankBeatsRecency = renderMemory(
	[fact("old-high", "high", 400, "2026-01-01T00:00:00Z"), fact("new-low", "low", 400, "2026-01-01T00:09:00Z")],
	oneFact + 30,
);
check(
	"older high outranks newer low",
	rankBeatsRecency.includes("[old-high]") && !rankBeatsRecency.includes("[new-low]"),
);

console.log(failures === 0 ? "ok: render budget + promotion" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
