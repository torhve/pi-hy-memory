import { enforceBudget } from "../src/bank.js";

const mk = (id: string, createdAt: string, tokens = 100) =>
	({
		id,
		createdAt,
		tokenCount: tokens,
		status: "active",
		statement: `fact ${id}`,
		relevance: "high",
		confidence: 1,
		chunkId: "c",
		task: "t",
		keys: [],
		sourceEntryIds: [],
	}) as any;

// 10 equal-ranked facts, pool fits 5 → recency must decide.
const bank = Array.from({ length: 10 }, (_, i) => mk(`id${i}`, `2026-10-17T10:0${i}:00Z`));
const { dropped } = enforceBudget(bank, 500);
const kept = bank.filter((e: any) => e.status === "active").map((e: any) => e.id);
console.log("kept  :", kept.join(","));
console.log("dropped:", dropped.map((e: any) => e.id).join(","));
console.log("newest kept:", kept.includes("id9") && kept.includes("id8") && kept.includes("id7"));
console.log(
	"oldest dropped:",
	dropped.some((e: any) => e.id === "id0"),
);
console.log(
	"reason set:",
	dropped.every((e: any) => e.supersedeReason === "pool budget"),
);

// Relevance still outranks recency.
const b2 = [mk("old-high", "2026-10-17T09:00:00Z"), { ...mk("new-low", "2026-10-17T11:00:00Z"), relevance: "low" }];
const r2 = enforceBudget(b2, 100);
console.log(
	"high beats new low:",
	b2.find((e: any) => e.id === "old-high")!.status === "active",
	"| dropped",
	r2.dropped.map((e: any) => e.id),
);

// Under budget: nothing touched.
const b3 = [mk("a", "2026-10-17T09:00:00Z")];
console.log("under budget untouched:", enforceBudget(b3, 5000).dropped.length === 0 && b3[0].status === "active");
