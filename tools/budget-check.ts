/**
 * Pool-budget check.
 *
 * `enforceBudget` is the dropper agent, in code: it keeps the newest facts that fit
 * and tombstones the rest. Recency is the only rank (see DESIGN.md, *Ranking*), so
 * this check pins exactly that — newest kept, oldest dropped, the tombstone reason
 * set, and a bin-packing skip rather than a tail cut.
 */

import { enforceBudget } from "../src/bank.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const mk = (id: string, createdAt: string, tokens = 100) =>
	({
		id,
		createdAt,
		tokenCount: tokens,
		status: "active",
		chunkSeq: 1,
		fromUser: false,
		statement: `fact ${id}`,
		chunkId: "c",
		task: "t",
		keys: [],
		sourceEntryIds: [],
	}) as any;

// 10 facts, pool fits 5 → recency decides, regardless of insertion order.
const bank = Array.from({ length: 10 }, (_, i) => mk(`id${i}`, `2026-10-17T10:${String(i).padStart(2, "0")}:00Z`));
const { dropped } = enforceBudget(bank, 500);
const kept = bank.filter((e: any) => e.status === "active").map((e: any) => e.id);
check(
	"newest kept",
	["id9", "id8", "id7", "id6", "id5"].every((id) => kept.includes(id)),
	kept.join(","),
);
check(
	"oldest dropped",
	dropped.some((e: any) => e.id === "id0"),
	dropped.map((e: any) => e.id).join(","),
);
check(
	"reason set",
	dropped.every((e: any) => e.supersedeReason === "bank budget"),
);

// Insertion order must not matter: the same facts handed over shuffled keep the same set.
const shuffled = [...bank].reverse().map((e: any) => ({ ...e, status: "active" }));
enforceBudget(shuffled, 500);
check(
	"insertion order does not decide",
	JSON.stringify(
		shuffled
			.filter((e: any) => e.status === "active")
			.map((e: any) => e.id)
			.sort(),
	) === JSON.stringify([...kept].sort()),
);

// Under budget: nothing touched.
const under = [mk("a", "2026-10-17T09:00:00Z")];
check("under budget untouched", enforceBudget(under, 5_000).dropped.length === 0 && under[0].status === "active");

// Bin-packing, not a tail cut: the small middle fact fits in the space the oldest
// long fact cannot, so one long fact does not evict several short ones.
const packing = [
	mk("oldest-long", "2026-10-17T09:00:00Z", 300),
	mk("middle-small", "2026-10-17T10:00:00Z", 100),
	mk("newest-long", "2026-10-17T11:00:00Z", 300),
];
enforceBudget(packing, 400);
const packed = packing.filter((e: any) => e.status === "active").map((e: any) => e.id);
check(
	"bin-packing fills the pool",
	packed.includes("newest-long") && packed.includes("middle-small"),
	packed.join(","),
);
check("and the one that cannot fit is dropped", packed.length === 2 && !packed.includes("oldest-long"));

// Already-superseded entries are neither counted nor re-dropped.
const withSuperseded = [
	{ ...mk("dead", "2026-10-17T09:00:00Z", 300), status: "superseded" },
	mk("live", "2026-10-17T10:00:00Z", 100),
];
const again = enforceBudget(withSuperseded, 100);
check(
	"superseded entries do not count toward the pool",
	again.dropped.length === 0 && withSuperseded[1].status === "active",
);

console.log(failures === 0 ? "ok: bank budget keeps the newest that fit" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
