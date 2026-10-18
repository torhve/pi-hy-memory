#!/usr/bin/env node
/**
 * Redaction check: the guard must catch credential VALUES and must never damage
 * ordinary identifiers. Run: npx tsx tools/redact-check.ts
 *
 * The false positives below are real: in a live session's bank
 * `relay_api_version` was stored as "rel…redacted…" and `API_PASSWORD=9010`
 * lost its variable name.
 */
import { sanitizeStatement } from "../src/protocol.js";

const MUST_REDACT = [
	"deploy API key sk-SECRET-12345 must never be committed",
	"warehouse token wt_live_9f1a07bd7a8e is in the README",
	"curl -H 'Authorization: Bearer abcdefghijklmnop'",
	"leaked key sk_live_4f9a8b7c6d5e3f2a1b0c",
	"raw token 9f8e7d6c5b4a39281706f5e4d3c2b1a0",
	"commit hash 3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c",
];

const MUST_NOT_TOUCH = [
	"reports relay_api_version 0.7.0 from upstream main",
	"gbtest start.sh: IRC_PORT=6667, CONTROL_PORT=16667, API_PASSWORD=9010",
	"total_value sums price*qty",
	"discount_lowers_price clamps at zero",
	"inventory/store.py holds the API",
	"key_api_endpoint is a test fixture name",
	"token_budget is 8000",
	"GET /api/buffers/{id}/lines?lines=-3",
	"fetchMoreLines(numLines=0) pages by historyPageSize",
	"handlers.ts uses bufferMsg.pointers for buffer id",
];

let failures = 0;
for (const text of MUST_REDACT) {
	const out = sanitizeStatement(text, new Set());
	if (!out.includes("redacted")) {
		failures++;
		console.log(`FAIL (not redacted): ${text}\n              -> ${out}`);
	}
}
for (const text of MUST_NOT_TOUCH) {
	const out = sanitizeStatement(text, new Set());
	if (out.includes("redacted")) {
		failures++;
		console.log(`FAIL (false positive): ${text}\n              -> ${out}`);
	}
}

// Source-id stripping must still work, and must not eat unrelated words.
const src = "3334369c";
const stripped = sanitizeStatement(`[Source entry id: ${src}] the id is ${src} here`, new Set([src]));
if (stripped.includes(src) || !stripped.includes("here")) {
	failures++;
	console.log(`FAIL (source id strip): ${stripped}`);
}

console.log(
	failures === 0
		? `ok: ${MUST_REDACT.length} redacted, ${MUST_NOT_TOUCH.length} preserved`
		: `${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
