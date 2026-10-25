#!/usr/bin/env node
/**
 * Would choosing the summary's constraint slice by statement shape fill anything the mark does not
 * (TODO 6.20c)? Run: npx tsx tools/constraint-slice-report-check.ts
 *
 * A bank whose five facts have known shapes, at a budget tight enough that the order of the three
 * slices decides what appears. The counterfactual moves the mark onto rule-shaped statements and
 * runs the shipped selector, so what is pinned is the difference the change would make — including
 * the false positive a shape test admits, and the fact that the summary's size does not change.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listNarrow, readSession, ruleShape } from "../dev/constraint-slice-report.js";
import { entryFromDraft } from "../src/bank.js";
import type { BankEntry } from "../src/types.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const shapeOf = (statement: string) => {
	const r = ruleShape(statement);
	return [r.narrow, r.broad, r.notRuleProxy];
};

check("a prohibition is a rule", shapeOf("Never rotate the audit store while the reader is open"), [true, true, false]);
check(
	"an instruction phrased as an instruction is a rule",
	shapeOf("Keep the deck title two lines and do not add a subtitle"),
	[true, true, false],
);
check("a plain measurement is not a rule", shapeOf("pool_size is 12 in workers.toml and reload keeps it at 12"), [
	false,
	false,
	false,
]);
check(
	"an error message that contains 'must be' is admitted by the narrow test and flagged by the proxy",
	shapeOf("Test failed: the top row must be the active channel in the list"),
	[true, true, true],
);
check(
	"a plan line is admitted by the narrow test and flagged by the proxy",
	shapeOf("Next action: keep the retry count at 5, do not raise it again"),
	[true, true, true],
);
check(
	"the proxy is a floor: a description of regular behaviour matches the narrow test and it does not see it",
	shapeOf("The status line always shows writes, drafts and the pool size"),
	[true, true, false],
);
check(
	"the broad test admits a measurement that merely says 'only'",
	shapeOf("Only 3 of 12 backlog specs reached the writer, the rest timed out"),
	[false, true, false],
);

const refs = ["e0", "e1"];
const drafted = (task: string, statement: string, fromUser: boolean) => ({
	task,
	statement,
	keys: [task],
	refs: [0],
	fromUser,
});

// chunkSeq decides age: 1 is old enough to be a foundation candidate, 9 is current state.
const made = (task: string, statement: string, fromUser: boolean, seq: number, seed: string): BankEntry =>
	entryFromDraft(drafted(task, statement, fromUser), "hy-cs-001", refs, `2026-10-25T12:0${seq}:00.000Z`, seed, seq);

const markedRule = made("nightly pool", "Do not resize the nightly pool before Friday", true, 9, "hy-cs-001:0:ADD");
const markedNotRule = made(
	"deck title",
	"User asked for a build that finishes under a minute",
	true,
	8,
	"hy-cs-001:1:ADD",
);
const unmarkedRuleOld = made(
	"audit store",
	"Never rotate the audit store while the reader is open",
	false,
	1,
	"hy-cs-001:2:ADD",
);
const proxyFlagged = made(
	"backlog spec",
	"Test failed: the top row must be the active channel in the list",
	false,
	7,
	"hy-cs-001:3:ADD",
);
const measurement = made(
	"pool size",
	"pool_size is 12 in workers.toml and reload keeps it at 12",
	false,
	6,
	"hy-cs-001:4:ADD",
);
// Broad-only: an obligation word that is not specific enough to be a rule on its own.
const broadOnly = made(
	"relay",
	"The relay should keep the same name as its parent channel",
	false,
	5,
	"hy-cs-001:5:ADD",
);

// The residual the proxy cannot see: regular behaviour, not an instruction.
const behaviour = made(
	"status line",
	"The status line always shows writes, drafts and the pool size",
	false,
	4,
	"hy-cs-001:6:ADD",
);
const dir = mkdtempSync(join(tmpdir(), "hy-constraint-slice-"));
const SESSION = "hy-cs-001";
writeFileSync(
	join(dir, `${SESSION}.bank.json`),
	JSON.stringify([markedRule, markedNotRule, unmarkedRuleOld, proxyFlagged, measurement, broadOnly, behaviour]),
);
writeFileSync(join(dir, `${SESSION}.ledger.jsonl`), "");

// 240 tokens is the tight arm: the reserved 10 % of the fact budget is a few tokens wide, so the
// order inside the slices is what decides the summary.
const read = readSession(SESSION, dir, 240, true);

check("the bank has 7 current facts", read.bankActive, 7);
check("the shipped slice has 2 marked facts to select from", read.markedSelected, 2);
check(
	"a rule-shaped statement selects 4, of which 3 carry no mark today",
	[read.ruleNarrow, read.ruleNarrowUnmarked],
	[4, 3],
);
check("one narrow match is flagged by the not-a-rule proxy", read.ruleNarrowNotRuleProxy, 1);
check("the broad test selects 5, so it is a bound and not an answer", read.ruleBroad, 5);
check("swapping the selection does not lengthen the summary", [read.shownShipped, read.shownShadow], [5, 5]);
check("it changes two facts and no more", [read.displacedByRule, read.addedByRule], [2, 2]);
check(
	"the marked fact that is not a rule is the one admitted",
	read.addedSamples.join("\n").includes("build that finishes under a minute"),
	true,
);
check("two rule-shaped facts are chosen into the reserved slice before anything spills", read.ruleFactsChosenFirst, 2);

// The trap 6.20c has to price: `foundations` excludes facts carrying the mark, so moving the mark
// onto a rule-shaped statement also moves that fact out of the foundations slice — and at a tight
// budget the old rule leaves the summary instead of entering it.
const tight = readSession(SESSION, dir, 200, true);
check(
	"at a tight budget neither arm fills the reserved slice",
	[read.ruleFactsChosenFirst, tight.ruleFactsChosenFirst],
	[2, 0],
);
check(
	"and the rule-shaped arm loses the old rule fact it marked",
	tight.displacedSamples.join("\n").includes("Never rotate the audit store"),
	true,
);

// --list is what makes the true-rule rate labelled rather than regexed (TODO 6.20d): it offers
// exactly the narrow matches, with the proxy's verdict beside each.
const lines = listNarrow(SESSION, dir);
check(
	"the list offers every narrow match, proxy verdict beside each",
	[lines.length, lines.filter((l) => l.startsWith("proxy")).length],
	[4, 1],
);
check(
	"a match the proxy cannot see is still offered for labelling",
	lines.some((l) => l.includes("always shows writes")),
	true,
);

const survived = readSession(SESSION, dir, 2000, false);
check(
	"a rule-shaped fact is not more durable than a marked one",
	[survived.ruleActive, survived.ruleTotal, survived.markedActive, survived.markedTotal],
	[4, 4, 2, 2],
);

console.log(
	failures === 0
		? "ok: the rule-shaped slice fills what the mark cannot, and admits what it should not"
		: `FAIL: ${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
