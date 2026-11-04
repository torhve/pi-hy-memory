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
