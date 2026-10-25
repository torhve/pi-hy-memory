#!/usr/bin/env node
import { parseDrafts } from "../src/protocol.js";
/**
 * Source refs. Run: npx tsx tools/source-ref-check.ts
 *
 * The chunk shows the writer `[0]`, `[1]`, … and `parseDrafts` demands those indices. Two things
 * have been measured against that (TODO 6.14): captured corpora hand over text whose lines still
 * carry the old `[da8e7079]` labels, and the writer then answers in ids — bare in the JSON, which
 * is a syntax failure before it is a citation failure. Both halves are pinned here, and the point
 * of the second half is that mapping an id is *counted*, never silently forgiven.
 */
import { normalizeLegacyLabels } from "../src/serialize.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const statement = "the nightly pool stays at 12000 tokens per pass, decided on the first pass";
const draft = (refs: unknown[]) => ({ task: "pool", statement, keys: ["pool"], refs });
const raw = (refs: unknown[]) => JSON.stringify({ drafts: [draft(refs)] });

const ids = ["da8e7079", "eb626334bdb5", "eb626399aabb", "0123456789ab"];

check("an index stays an index and is not counted as an id", parseDrafts(raw([1]), ids), {
	drafts: [{ task: "pool", statement, keys: ["pool"], refs: [1] }],
	rejected: [],
	idRefs: 0,
});
check("a digit written as a string is still an index", parseDrafts(raw(["2"]), ids).drafts[0].refs, [2]);
check(
	"an id naming one source entry becomes its index, and is counted",
	[parseDrafts(raw(["eb626334bdb5"]), ids).drafts[0].refs, parseDrafts(raw(["eb626334bdb5"]), ids).idRefs],
	[[1], 1],
);
check(
	"a truncated id resolves while it names one entry",
	[parseDrafts(raw(["eb626399"]), ids).drafts[0].refs, parseDrafts(raw(["eb626399"]), ids).idRefs],
	[[2], 1],
);
check(
	"an id that names two entries is refused, not guessed",
	parseDrafts(raw(["eb6263"]), ids).rejected.map((r) => r.reason),
	["ref names an entry id, not an index"],
);
check(
	"an unknown id gets the same reason rather than the generic one",
	parseDrafts(raw(["ff00ff00"]), ids).rejected.map((r) => r.reason),
	["ref names an entry id, not an index"],
);
check(
	"a mix of indices and ids keeps the draft and still counts the id ref",
	[parseDrafts(raw([0, "da8e7079"]), ids).drafts[0].refs, parseDrafts(raw([0, "da8e7079"]), ids).idRefs],
	[[0], 1],
);
check(
	"a ref out of range with nothing else is still 'no valid source refs'",
	parseDrafts(raw([99]), ids).rejected.map((r) => r.reason),
	["no valid source refs"],
);

// The harness half: captured and authored corpora carry line-leading id labels, production text
// does not.
const captured = [
	"[da8e7079] [Assistant @ 16:59]: the pool is sized in tokens",
	"[eb626334bdb5] [Tool result for bash @ 16:60]: pool=12000",
	"[a1b2c3d4] fixed the sizing pass, the suite is green after it",
].join("\n");
const normalized = normalizeLegacyLabels(captured);
check(
	"labels become the indices the shipped path shows, in the order they appeared",
	[
		normalized.text.split("\n")[0].startsWith("[0] [Assistant"),
		normalized.text.split("\n")[1].startsWith("[1] [Tool result"),
	],
	[true, true],
);
check("the refs are the labels, in order", normalized.refs, ["da8e7079", "eb626334bdb5"]);
check(
	"a bracketed commit sha at a line head is not a label and stays as written",
	[normalized.text.split("\n")[2].startsWith("[a1b2c3d4] fixed"), normalized.refs.includes("a1b2c3d4")],
	[true, false],
);
check("nothing inside a line is touched", normalized.text.includes("pool=12000"), true);
check(
	"text without labels comes back unchanged",
	normalizeLegacyLabels("[0] [User @ 09:00]: plain").text,
	"[0] [User @ 09:00]: plain",
);
check("and yields no refs of its own", normalizeLegacyLabels("[0] [User @ 09:00]: plain").refs, []);

console.log(failures === 0 ? "ok: refs arrive as indices, ids are mapped and counted" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
