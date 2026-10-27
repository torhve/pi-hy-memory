#!/usr/bin/env npx tsx
/**
 * The fixture has to name itself.
 *
 * `dev/hyvcc-demo.ts` measures a real pi session file against a real bank, and the numbers it
 * prints are quoted in `DESIGN_HYVCC.md` and will be quoted again by the spike gates. That only
 * survives contact with the work if the input is a copy with an identity: the live session file
 * was 44.5 MB and still being appended to when the harness last read it, and a two-arm A/B run
 * over it would compare two different files while both arms looked pinned.
 *
 * So this pins the copy machinery — with a synthetic session, not the private one. Nothing here
 * asserts a real token count, because a check that did would pass only on the machine that has
 * the fixture. What it asserts instead:
 *
 *   1. a frozen copy records both legs, so the bank cannot drift while the numbers look pinned;
 *   2. the identity line is printed against the copy, and a copy that has moved says so;
 *   3. a live file with no manifest is named as one instead of looking like a copy;
 *   4. a torn trailing record — a file caught mid-append — drops one record and no more;
 *   5. the identity line carries no path and no session directory name, so quoting it into a
 *      document cannot leak where the session was taken (`tools/design-leak-check.ts` scans for
 *      exactly those shapes).
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyIdentity, parseSession, readFixture, sessionLabel, sha12, writeFixture } from "../dev/hyvcc-demo.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
	console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ok ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
};

// A session small enough to read here and shaped like pi's: messages in a branch, one
// compaction that kept a tail, and bookkeeping entries the harness is meant to exclude.
const sessionLines = [
	{ type: "message", id: "m1", message: { role: "user", content: "build the memory extension" } },
	{ type: "message", id: "m2", message: { role: "assistant", content: "starting with the ledger" } },
	{ type: "message", id: "m3", message: { role: "toolResult", content: "written src/lag.ts" } },
	{ type: "message", id: "m4", message: { role: "user", content: "now make compaction wait for the write" } },
	{ type: "message", id: "m5", message: { role: "assistant", content: "deferring with an ETA" } },
	{ type: "compaction", id: "c1", firstKeptEntryId: "m4", summary: "kept a tail" },
	{ type: "message", id: "m6", message: { role: "toolResult", content: "npm run check exit 0" } },
	{ type: "message", id: "m7", message: { role: "assistant", content: "green" } },
];
const sessionText = `${sessionLines.map((e) => JSON.stringify(e)).join("\n")}\n`;
const bankText = JSON.stringify([
	{
		id: "aaaa11112222",
		task: "memory extension",
		statement: "compaction waits for the write in flight",
		keys: ["compaction", "write"],
		sourceEntryIds: ["m4"],
		chunkId: "chunk-1",
		chunkSeq: 1,
		fromUser: true,
		createdAt: "2026-10-26T00:00:00.000Z",
		status: "active",
		tokenCount: 8,
	},
	{
		id: "bbbb11112222",
		task: "memory extension",
		statement: "the old summary was superseded",
		keys: ["supersede"],
		sourceEntryIds: ["m2"],
		chunkId: "chunk-1",
		chunkSeq: 1,
		fromUser: false,
		createdAt: "2026-10-26T00:00:00.000Z",
		status: "superseded",
		tokenCount: 6,
	},
]);

const dir = mkdtempSync(join(tmpdir(), "hyvcc-fixture-"));
const fixtureDir = join(dir, "copy");
// Named exactly the way pi names a session file: `<timestamp>_<uuid>.jsonl`.
const SESSION_UUID = "01a1510e-dead-beef-cafe0123456789ab";
const sourceSession = join(dir, `2026-10-26T09-00-00-855Z_${SESSION_UUID}.jsonl`);
const sourceBank = join(dir, "bank.json");
writeFileSync(sourceSession, sessionText);
writeFileSync(sourceBank, bankText);

// 5. The label names a session without naming where it lives, or when it was taken.
const label = sessionLabel(sourceSession);
check(
	"session label  the uuid, head and tail of it, no path and no timestamp",
	label === `${SESSION_UUID.slice(0, 8)}…${SESSION_UUID.slice(-5)}` &&
		!label.includes("/") &&
		!label.includes("--") &&
		!label.includes("2026-10-26"),
	label,
);

// 1. A frozen copy records both legs.
const manifest = writeFixture({
	dir: fixtureDir,
	sessionFile: sourceSession,
	bankFile: sourceBank,
	sessionText,
	bankText,
});
const back = readFixture(fixtureDir);
check(
	"manifest  round-trips what was written",
	back !== null && JSON.stringify(back) === JSON.stringify(manifest),
	JSON.stringify(back) === JSON.stringify(manifest) ? "" : JSON.stringify(back),
);
check(
	"manifest  names the bank leg too, not only the session",
	manifest.bank.sha === sha12(bankText) &&
		manifest.bank.facts === 2 &&
		manifest.bank.active === 1 &&
		manifest.bank.userStated === 1 &&
		manifest.bank.bytes === Buffer.byteLength(bankText),
	JSON.stringify(manifest.bank),
);
check(
	"manifest  names the session leg with bytes, entries and a digest",
	manifest.session.sha === sha12(sessionText) &&
		manifest.session.bytes === Buffer.byteLength(sessionText) &&
		manifest.session.entries === sessionLines.length,
	JSON.stringify(manifest.session),
);
const manifestText = readFileSync(join(fixtureDir, "manifest.json"), "utf8");
check(
	"manifest  holds no path and no session directory name, so quoting it is safe",
	!manifestText.includes(dir) && !manifestText.includes("Users") && !/--[\w.-]+--/.test(manifestText),
	manifestText.replace(/\s+/g, " ").slice(0, 80),
);

// 2. Reading the copy prints the identity, and a copy that has moved says so.
const identity = copyIdentity({
	fixtureDir,
	manifest: back ?? undefined,
	sessionText: readFileSync(join(fixtureDir, "session.jsonl"), "utf8"),
	bankText: readFileSync(join(fixtureDir, "bank.json"), "utf8"),
	sessionFile: join(fixtureDir, "session.jsonl"),
});
check(
	"identity  names the copy, its taking, and both digests",
	identity.startsWith("copy identity") &&
		identity.includes(manifest.takenAt) &&
		identity.includes(manifest.session.sha) &&
		identity.includes(manifest.bank.sha) &&
		!identity.includes("MOVED"),
	identity.slice(0, 120),
);
const tampered = copyIdentity({
	fixtureDir,
	manifest: back ?? undefined,
	sessionText: `${readFileSync(join(fixtureDir, "session.jsonl"), "utf8")}{"type":"message","id":"m8"}\n`,
	bankText: readFileSync(join(fixtureDir, "bank.json"), "utf8"),
	sessionFile: join(fixtureDir, "session.jsonl"),
});
check(
	"identity  a copy that no longer matches its manifest says MOVED",
	tampered.includes("MOVED") && tampered.includes("session copy now"),
	tampered.slice(-120),
);
const bankMoved = copyIdentity({
	fixtureDir,
	manifest: back ?? undefined,
	sessionText: readFileSync(join(fixtureDir, "session.jsonl"), "utf8"),
	bankText: `${bankText}extra`,
	sessionFile: join(fixtureDir, "session.jsonl"),
});
check(
	"identity  so does the bank leg",
	bankMoved.includes("MOVED") && bankMoved.includes("bank copy now"),
	bankMoved.slice(-90),
);

// 3. A live file is called a live file.
const live = copyIdentity({
	sessionText,
	bankText,
	sessionFile: sourceSession,
});
check(
	"identity  with no manifest it says so, and says how stale the file is",
	/no manifest/i.test(live) &&
		/last written \d+ s ago/.test(live) &&
		live.includes(sourceSession.split("/").pop() ?? "") &&
		!live.includes(dir),
	live,
);

// 4. A file caught mid-append loses its torn record and nothing else.
const torn = `${sessionText}{"type":"message","id":"m9","message":{"role":"user","content":"half a re`;
const parsed = parseSession(torn);
check(
	"torn read  drops the half-written record and keeps every whole one",
	parsed.length === sessionLines.length && parsed.at(-1)?.id === "m7",
	`${parsed.length} entries parsed against ${sessionLines.length} whole records`,
);
check(
	"torn read  the entry count a manifest recorded is what a later reading is checked against",
	manifest.session.entries === sessionLines.length,
	`${manifest.session.entries}`,
);

// The identity line is the first thing the harness prints, so a quoted number always arrives
// with the copy it came from.
const order = [identity, tampered, live];
check(
	"identity  no identity line leaks a path",
	order.every((line) => !line.includes(dir) && !line.includes("Users")),
	order.find((line) => line.includes(dir) || line.includes("Users")) ?? "",
);

console.log(
	failures === 0
		? `\n${"ok"}: the fixture names itself, and a copy that moved says so. The spikes measure a copy, not a live file.`
		: `\n${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
