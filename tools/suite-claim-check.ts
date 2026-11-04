#!/usr/bin/env npx tsx
/**
 * tools/suite-claim-check.ts — the claim parser has to tell an assertion from a record, because that is what
 * decides whether a bank is holding a stale count or a correct note about a document.
 *
 * `dev/supersede-outcome-report.ts` grades a run by asking how many superseded numbers are still *asserted* as
 * current. A superseded number quoted by a log file, a changelog line or a hard-coded CI script is the fact the
 * corpus wants kept, so the whole grade rests on this parse. The trap that matters is the middle case: an entry
 * that started as a record and was rewritten into an assertion. Provenance would keep calling it a record forever;
 * the wording test does not.
 *
 * What it cannot prove: that the wording test catches every phrasing a model can invent. It pins the shapes the
 * two corpora contain and the rewrite case, and says nothing about the rest.
 */
import { suiteClaims } from "../dev/suite-claim.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const shape = (statement: string) =>
	suiteClaims(statement).map((c) => `${c.mode} ${c.value} ${c.record ? "record" : "assert"}`);

// Asserting the current count, in the phrasings the corpora use.
check("a plain current claim", shape("the offline suite is at 251 green"), ["offline 251 assert"]);
check(
	"a current claim in past tense is still an assertion",
	shape("after the cache fix the test suite reported 251 passing tests"),
	["offline 251 assert"],
);
check("a terse claim with a flag", shape("402 green offline"), ["offline 402 assert"]);
check("a LAN count", shape("the LAN suite is at 341 green"), ["lan 341 assert"]);
check("a LAN count with no check word", shape("371 with TCTL_LAN=1"), ["lan 371 assert"]);

// Recording a number an artifact carries.
check("a changelog line", shape("docs/CHANGELOG.md still opens with 214 checks passed"), ["offline 214 record"]);
check("a log file", shape("logs/release-14.log records 238 checks passed"), ["offline 238 record"]);
check("a hard-coded script", shape(".ci/legacy.sh hard-codes 251 checks passed and does not measure the suite"), [
	"offline 251 record",
]);
check("a quoted count in a named file", shape("README.md claims '238 checks passed'"), ["offline 238 record"]);
check("a quoted count with the file named", shape("README.md claims 238 checks passed in '238 checks passed'"), [
	"offline 238 record",
]);

// The case the grade depends on: the same entry holding both.
check(
	"one entry, one record and one current claim",
	shape("logs/release-14.log records 238 checks and the offline suite is now at 402 green"),
	["offline 238 record", "offline 402 assert"],
);
check(
	"an entry counts as a record carrier only when every claim in it is a record",
	shape("logs/release-14.log records 238 checks").every((c) => c.endsWith("record")) &&
		!shape("logs/release-14.log records 238 checks and the offline suite is now at 402 green").every((c) =>
			c.endsWith("record"),
		),
	true,
);

// A verb attributes the number to the artifact only when the entry names one.
check("an attributing verb with no file named is still an assertion", shape("the changelog claims 214 checks passed"), [
	"offline 214 assert",
]);
check(
	"an attributing verb in an entry that names a file is a record",
	shape("docs/CHANGELOG.md line 12 claims 214 checks passed"),
	["offline 214 record"],
);
// A file named near a current count is the shape that fooled the classifier once: the entry names the file that
// changed, not a document that records the number.
check(
	"a file named in the same sentence as a current count is still an assertion",
	shape(
		"the offline test suite currently passes 402 checks after the lease module section was added to test/run.mjs",
	),
	["offline 402 assert"],
);
check(
	"a file named in a different sentence does not make this count a record",
	shape("The offline test suite currently passes 402 checks. test/run.mjs was extended with a lease module."),
	["offline 402 assert"],
);
// The real bank entries that an earlier version of this parser read wrong, kept as they were written.
check(
	"a README bug report records the wrong number and asserts the live one",
	shape(
		"README.md lines 22 and 23 incorrectly claim 238 checks while the suite reports 251; the user instructed to leave the README unchanged for now but noted it is wrong.",
	),
	["offline 238 record", "offline 251 assert"],
);
check(
	"a log file reporting an old run is a record",
	shape(
		"The logs/release-14.log file reports 238 passing checks and 0 failing checks with a warm cache, reflecting the test suite state before the cache fix was applied.",
	),
	["offline 238 record"],
);
check(
	"running a script and reporting its result is an assertion",
	shape(
		"Running `node test/run.mjs --offline` after fixing handshake assumptions resulted in 262 checks passed and 0 failed.",
	),
	["offline 262 assert"],
);
check(
	"a changelog line calls its own number outdated and names the live one",
	shape(
		"docs/CHANGELOG.md line 12 currently reports 214 checks passed, which is stale relative to the current offline test suite results of 358.",
	),
	["offline 214 record", "offline 358 assert"],
);
// One entry stating both counts: each number takes the marker in its own half of the sentence.
check(
	"dry mode and LAN in one entry split by which half each number sits in",
	shape(
		"The test suite passes 358 checks in dry mode (TCTL_DRY=1) and 371 checks when including the LAN section (TCTL_LAN=1).",
	),
	["offline 358 assert", "lan 371 assert"],
);
check("a LAN count with the marker after the number", shape("371 checks passed with TCTL_LAN=1"), ["lan 371 assert"]);
check(
	"a run command carrying both flags is the LAN run it flags",
	shape("TCTL_LAN=1 TCTL_DRY=1 node test/run.mjs reports 241 checks passed and 0 failed"),
	["lan 241 assert"],
);
// The same number stated twice in one entry, once as a record and once as the current count: the assertion wins.
check(
	"the assertion wins when a number appears as both",
	shape("logs/release-14.log records 238 checks and the suite now has 238 passing"),
	["offline 238 assert"],
);

// A record rewritten into an assertion stops being a record.
check(
	"the rewritten entry asserts the old number as current",
	shape("the offline suite currently has 214 checks passed"),
	["offline 214 assert"],
);
// Things that are not counts at all.
check(
	"a purge age and an entry count are not suite counts",
	shape("node drain.mjs --purge-age 300 dropped 41 entries"),
	[],
);
check("a failure count asserts no total", shape("the suite reports 402 passing tests and 0 failed"), [
	"offline 402 assert",
]);
check("an empty statement asserts nothing", shape(""), []);

if (failures > 0) {
	console.log(`${failures} failure(s)`);
	process.exit(1);
}
