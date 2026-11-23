/**
 * tools/reconcile-render-check.ts — the reconcile render is plain, and the prompt does not claim otherwise.
 *
 * The candidate list once carried a recency marker: entries were re-sorted newest first and each printed its
 * age. A 30-chunk corpus built to test that change ended with the same bank in every arm — 9 active count
 * claims, 7 of them superseded, no DELETEs — so the marker was removed on 2026-11-03. `EXPERIMENTS.md` keeps
 * the measurements. This file guards the removal, because the tempting fix is always to put the age back.
 *
 * What it proves: the render prints id, task and statement in the order selection produced, and nothing else;
 * the reconcile prompt makes no claim about ordering or age, so the two cannot drift apart; a bank entry that
 * is a day old and one written a second ago render identically, which is the point.
 *
 * What it cannot prove: whether the writer picks the right target. That is a run measurement
 * (`dev/supersede-outcome-report.ts`, `dev/reconcile-recency-report.ts`).
 */

import { reconcileSystem } from "../src/prompts.js";
import { renderBankForReconcile } from "../src/protocol.js";
import type { BankEntry } from "../src/types.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const entry = (id: string, task: string, statement: string, createdAt: string): BankEntry => ({
	id,
	task,
	statement,
	keys: [],
	sourceEntryIds: [],
	chunkId: `c-${id}`,
	chunkSeq: 1,
	fromUser: false,
	createdAt,
	status: "active",
	tokenCount: Math.ceil(statement.length / 4),
});

// Deliberately out of date order, and one entry carrying a number, so a re-introduced age or sort shows up.
const old = entry(
	"aaaa00000001",
	"offline suite count",
	"the offline suite reports 214 checks passed",
	"2026-11-01T09:00:00.000Z",
);
const recent = entry(
	"bbbb00000002",
	"cache fix retest",
	"after the cache fix the suite reported 251 passing",
	"2026-11-02T18:40:00.000Z",
);

const rendered = renderBankForReconcile([old, recent]);
const lines = rendered.split("\n");

check("header is plain, with no ordering claim", lines[0], "Existing bank entries:");
check("one line per entry: id, task, statement", lines.slice(1), [
	"<id>aaaa00000001</id> (offline suite count) the offline suite reports 214 checks passed",
	"<id>bbbb00000002</id> (cache fix retest) after the cache fix the suite reported 251 passing",
]);
check("input order is kept, newest last as given", lines[1]?.includes("aaaa00000001"), true);
check("no age is printed", /ago|just now|\d+[mhd]\b/.test(rendered), false);
check("an empty bank renders as none", renderBankForReconcile([]), "Existing bank entries: (none)");
check(
	"the render adds nothing per entry",
	rendered.length,
	"Existing bank entries:\n".length + lines.slice(1).join("\n").length,
);

const prompt = reconcileSystem(2);
check("the prompt claims no ordering", /newest first|states its age|UPDATE the newest one/i.test(prompt), false);
check(
	"the prompt still says what UPDATE means",
	prompt.includes("an existing entry covers the same subject and the draft is more current"),
	true,
);

if (failures > 0) {
	console.log(`${failures} failure(s)`);
	process.exit(1);
}
