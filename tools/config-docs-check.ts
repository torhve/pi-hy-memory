/**
 * Configuration docs check: the README table and the code must agree.
 *
 * Run: npx tsx tools/config-docs-check.ts
 *
 * Drift already happened once in this repository: `maxEntryChars` existed in the
 * code and was missing from the README table, and several defaults lived only as
 * `?? 5000` at their use sites. A settings table that quietly stops matching the
 * code is worse than no table, because it is what users trust.
 */

import { readFileSync } from "node:fs";
import { SETTING_DEFAULTS } from "../src/config.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const tableStart = readme.indexOf("| key | default | meaning |");
const table = readme.slice(tableStart, readme.indexOf("\n\n", tableStart));

/** `| `a` / `b` | `1` / `2` | …` → [{key:"a", default:"1"}, {key:"b", default:"2"}] */
const rows: { key: string; value: string }[] = [];
for (const line of table.split("\n")) {
	const cells = line.split("|").map((cell) => cell.trim());
	if (cells.length < 4) continue;
	const [, keyCell, defaultCell] = cells;
	const keys = [...keyCell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
	const values = [...defaultCell.replace(/`([^`]+)`/g, "`$1`").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
	if (keys.length === 0) continue;
	const flat = values.length === 0 ? [defaultCell.replace(/\*\*|`/g, "").trim()] : values;
	for (const [index, key] of keys.entries()) rows.push({ key, value: flat[index] ?? flat[0] ?? "" });
}

const documented = new Map(rows.map((row) => [row.key, row.value]));
const configKeys = Object.keys(SETTING_DEFAULTS);

const missing = configKeys.filter((key) => !documented.has(key));
check("every setting is documented", missing.length === 0, missing.join(", "));

const stale = [...documented.keys()].filter((key) => !configKeys.includes(key));
check("no documented setting is gone from the code", stale.length === 0, stale.join(", "));

/** `false`/`true`/numbers compare loosely; objects and "none" are only presence-checked. */
const expected = (key: string): string => {
	const raw = (SETTING_DEFAULTS as unknown as Record<string, unknown>)[key];
	if (raw === false) return "false";
	if (raw === true) return "true";
	if (typeof raw === "number") return String(raw);
	if (raw === undefined || raw === null) return "none";
	if (typeof raw === "object") return "{}";
	return String(raw);
};

const wrong = configKeys
	.filter((key) => documented.has(key))
	.filter((key) => {
		const raw = (SETTING_DEFAULTS as unknown as Record<string, unknown>)[key];
		const shown = (documented.get(key) ?? "").replace(/`|\*\*/g, "").trim();
		if (raw === undefined || raw === null) return !["none", "false", ""].includes(shown);
		if (typeof raw === "object") return shown !== "{}";
		return shown !== expected(key);
	})
	.map((key) => `${key}: docs ${documented.get(key)}, code ${expected(key)}`);
check("documented defaults match the code", wrong.length === 0, wrong.join(" | "));

console.log(`     ${configKeys.length} settings, ${documented.size} documented rows`);
console.log(failures === 0 ? "ok: config docs" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
