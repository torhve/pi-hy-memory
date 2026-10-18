/**
 * Retention check: state pruning must delete old sessions and nothing else.
 *
 * Run: npx tsx tools/prune-check.ts
 *
 * The measured problem: 92 session directories worth of bank/ledger/summary/stats
 * files (1.2 MB) with no cleanup, because the bank is a *fold* of the ledger and so
 * has to be kept per session. The risk of adding a pruner is deleting something
 * still in use, so the guards are what this file tests.
 */

import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneSessions } from "../src/state.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);

const dir = mkdtempSync(join(tmpdir(), "hy-prune-"));
const session = (id: string, ageDays: number): void => {
	for (const kind of ["bank.json", "ledger.jsonl", "summary.md", "stats.json"]) {
		const path = join(dir, `${id}.${kind}`);
		writeFileSync(path, "{}");
		const t = (NOW - ageDays * DAY) / 1000;
		utimesSync(path, t, t);
	}
};
writeFileSync(join(dir, "audit.ndjson"), "not a session file");

// 12 old sessions, 3 recent; the floor is the 10 newest overall.
for (let i = 0; i < 12; i++) session(`old${String(i).padStart(5, "0")}-aaaa-bbbb-cccc-dddddddddddd`, 40 + i);
for (let i = 0; i < 3; i++) session(`new${String(i).padStart(5, "0")}-aaaa-bbbb-cccc-dddddddddddd`, 1 + i);

const before = readdirSync(dir).length;
const result = pruneSessions(dir, { afterDays: 30, now: NOW });
const after = readdirSync(dir);

check("old sessions removed", result.removed.length === 5, `${result.removed.length} sessions, ${result.files} files`);
check("all four files per session", result.files === 20);
check("newest 10 kept", after.filter((n) => n.includes("old")).length > 0);
check(
	"recent sessions kept",
	["0", "1", "2"].every((i) => after.some((n) => n.startsWith(`n${"e"}w0000${i}`))),
);
check("unrelated file untouched", after.includes("audit.ndjson"));
check("nothing unexpected deleted", before - after.length === 20, `${before} → ${after.length}`);

// The running session is never pruned, even when old.
const dir2 = mkdtempSync(join(tmpdir(), "hy-prune-"));
for (const _kind of ["bank.json", "ledger.jsonl"]) {
	const path = join(dir2, "running-aaaa-bbbb-cccc-dddddddddddd.bank.json");
	writeFileSync(path, "{}");
	const t = (NOW - 400 * DAY) / 1000;
	utimesSync(path, t, t);
}
const kept = pruneSessions(dir2, { afterDays: 1, keep: ["running-aaaa-bbbb-cccc-dddddddddddd"], now: NOW });
check("current session kept", kept.removed.length === 0 && readdirSync(dir2).length > 0);

// Disabled means disabled.
const dir3 = mkdtempSync(join(tmpdir(), "hy-prune-"));
session3(dir3);
function session3(path: string): void {
	const file = join(path, "ancient-aaaa-bbbb-cccc-dddddddddddd.bank.json");
	writeFileSync(file, "{}");
	const t = (NOW - 900 * DAY) / 1000;
	utimesSync(file, t, t);
}
const off = pruneSessions(dir3, { afterDays: 0, now: NOW });
check("afterDays 0 disables pruning", off.removed.length === 0 && readdirSync(dir3).length === 1);

// A directory that does not exist must not throw: session state can be absent.
const missing = pruneSessions(join(tmpdir(), "hy-prune-does-not-exist"), { afterDays: 30, now: NOW });
check("missing directory is a no-op", missing.removed.length === 0);

console.log(failures === 0 ? "ok: state retention" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
