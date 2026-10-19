#!/usr/bin/env node
/**
 * Failure classification check. Run: npx tsx tools/failure-class-check.ts
 *
 * `failures` shrinks the next chunk (20 000 → 10 000 → …). That is right when the
 * request itself is the problem and wrong when the endpoint is. Measured on
 * session 01a1510e (2026-10-19): `extract …: terminated` — a dropped stream —
 * halved the budget, and the next chunk had to leave 133 entries behind instead
 * of 43.
 *
 * Every message here is taken from a real audit line, except the synthetic 413
 * and context-length rejections.
 */

import { failureClass, shrinksChunk } from "../src/failures.js";
import { WriterError } from "../src/llm.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const at = (message: string, status?: number) => new WriterError(`extract hy-test: ${message}`, status);

// Endpoint failures: nothing about the chunk caused them, so the budget stays.
check("dropped stream", failureClass(at("terminated")), "endpoint");
check("stream without finish_reason", failureClass(at("Stream ended without finish_reason")), "endpoint");
check("502 from the proxy", failureClass(at("502: peer proxy error: no route to host", 502)), "endpoint");
check("busy peer", failureClass(at('429: {"code":"concurrency_limit"}', 429)), "endpoint");
check("auth", failureClass(at("401: unauthorized", 401)), "endpoint");
check("socket hang up", failureClass(at("socket hang up")), "endpoint");

// Chunk failures: a smaller request finishes inside the same budget.
check("our timeout", failureClass(new WriterError("extract hy-test: Request was aborted", 0)), "chunk");
check("aborted operation", failureClass(new WriterError("extract hy-test: This operation was aborted", 0)), "chunk");
check("413", failureClass(at("413: request too large", 413)), "chunk");
check(
	"context length rejection",
	failureClass(at("400: this model's maximum context length is 8192 tokens", 400)),
	"chunk",
);
check("a plain 400 is not about size", failureClass(at("400: unknown field chat_template_kwargs", 400)), "endpoint");

// Output failures: the model answered with something unusable.
check("unparseable JSON", failureClass(at("Expected ',' or ']' after array element")), "output");
check("unbalanced JSON", failureClass(at("Unbalanced JSON object in completion")), "output");
check("no JSON at all", failureClass(at("no JSON object in completion")), "output");
check("empty completion", failureClass(at("empty completion (stopReason=length)")), "output");

// The mapping the budget uses.
check("endpoint does not shrink", shrinksChunk("endpoint"), false);
check("chunk shrinks", shrinksChunk("chunk"), true);
check("output shrinks", shrinksChunk("output"), true);

console.log(failures === 0 ? "ok: failure classes" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
