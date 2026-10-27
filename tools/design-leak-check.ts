/**
 * Leak check: no private infrastructure in the documentation.
 *
 * Run: npx tsx tools/design-leak-check.ts
 *
 * `AGENTS.md` forbids hostnames, absolute paths under a home directory and credentials in a
 * diff. That rule is easy to break by accident now that a design document quotes text taken
 * out of real session files: a summary excerpt carries the machine's paths, the project's
 * session directory name, and whatever the model happened to write. This checks every markdown
 * file in the repository root for the shapes that would say so.
 *
 * It is deliberately narrow and high-confidence. Long hex ids, session ids, `127.0.0.1` as a
 * local example endpoint, and package specifiers like `@scope/pkg` are not leaks. A placeholder
 * secret shorter than the thresholds below is not flagged either, so the redaction example in
 * `RESULTS.md` passes.
 */

import { readdirSync, readFileSync } from "node:fs";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const PATTERNS: { name: string; re: RegExp; exempt?: RegExp }[] = [
	{ name: "absolute path under a home directory", re: /\/(Users|home|root)\/\S+/ },
	{ name: "pi session directory name", re: /--[\w.-]*\w[\w.-]*--/ },
	{ name: "API-key-shaped token", re: /\bsk-[A-Za-z0-9]{16,}/ },
	{ name: "Bearer token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
	{ name: "private key block", re: /-----BEGIN [A-Z ]+-----/ },
	{ name: "email address", re: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
	{
		name: "IP address",
		re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/,
		exempt: /\b(?:127\.0\.0\.1|0\.0\.0\.0|255\.255\.255\.255)\b/,
	},
];

const files = readdirSync(new URL("..", import.meta.url))
	.filter((name) => name.endsWith(".md"))
	.sort();

for (const file of files) {
	const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
	const hits: string[] = [];
	text.split("\n").forEach((line, index) => {
		for (const pattern of PATTERNS) {
			if (!pattern.re.test(line)) continue;
			// The whole-line exemption lets a document name the shape it is redacting.
			if (pattern.exempt?.test(line)) continue;
			hits.push(`${file}:${index + 1} ${pattern.name}`);
		}
	});
	check(`${file} has no private infrastructure`, hits.length === 0, hits.slice(0, 5).join("; "));
}

console.log(failures === 0 ? "ok: documentation is clean" : `${failures} file(s) carry private infrastructure`);
process.exit(failures === 0 ? 0 : 1);
