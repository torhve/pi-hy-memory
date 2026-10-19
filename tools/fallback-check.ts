/**
 * Failover check: which failures move to the second model, and which do not.
 *
 * Run: npx tsx tools/fallback-check.ts
 *
 * The orchestration is unchanged in spirit from when it wrapped HTTP calls, but
 * the seam moved: writers are now pi registry models, so the interesting cases
 * are the classifications (busy vs unavailable vs client-shaped) and the
 * `preferFallback` handshake with src/failover.ts.
 */

import { completeWithFallback, isBusyError, isFailoverError, type Writer, WriterError } from "../src/llm.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** A writer that plays back a script of outcomes, recording who was called. */
const scripted = (name: string, outcomes: (string | WriterError)[], log: string[]): Writer => {
	let index = 0;
	return {
		model: name,
		async complete() {
			const outcome = outcomes[Math.min(index++, outcomes.length - 1)];
			log.push(name);
			if (outcome instanceof Error) throw outcome;
			return {
				content: outcome,
				usage: { inTokens: 1, outTokens: 1, wallS: 0 },
				model: { provider: "test", id: name },
			};
		},
	};
};

const run = async (primary: Writer, fallback: Writer | null, options = {}) =>
	completeWithFallback(primary, fallback, "system", "user", "extract hy-test", {
		busyBackoffMs: 1,
		...options,
	});

// 1. Healthy primary: one call, no fallback.
{
	const log: string[] = [];
	const out = await run(scripted("primary", ["ok"], log), scripted("fallback", ["no"], log));
	check("healthy primary wins", out.endpoint === "primary" && log.join() === "primary");
}

// 2. A busy slot is retried on the same model before any failover.
{
	const log: string[] = [];
	const busy = new WriterError("extract hy-test: HTTP 429 Too Many Requests", 429);
	const out = await run(scripted("primary", [busy, "ok"], log), scripted("fallback", ["no"], log), {
		busyRetries: 3,
	});
	check("busy retries the same model", out.endpoint === "primary" && log.join() === "primary,primary");
}

// 3. Busy retries are bounded; then the second model is used.
{
	const log: string[] = [];
	const busy = new WriterError("extract hy-test: HTTP 429", 429);
	const out = await run(scripted("primary", [busy], log), scripted("fallback", ["ok"], log), { busyRetries: 2 });
	check(
		"exhausted retries fail over",
		out.endpoint === "fallback" && log.join() === "primary,primary,primary,fallback",
	);
	check("failover reason recorded", typeof out.failed === "string" && out.failed.includes("429"), String(out.failed));
}

// 4. A 5xx or a transport abort moves over immediately.
{
	const log: string[] = [];
	const out = await run(
		scripted("primary", [new WriterError("extract hy-test: HTTP 503 upstream", 503)], log),
		scripted("fallback", ["ok"], log),
	);
	check("5xx fails over", out.endpoint === "fallback" && log.join() === "primary,fallback");
}
{
	const log: string[] = [];
	const out = await run(
		scripted("primary", [new WriterError("extract hy-test: This operation was aborted", 0)], log),
		scripted("fallback", ["ok"], log),
	);
	check("timeout fails over", out.endpoint === "fallback");
	check("timeout reason mentions abort", String(out.failed).includes("aborted"));
}

// 5. A client-shaped rejection must NOT be retried on another model.
{
	const log: string[] = [];
	let threw = false;
	try {
		await run(
			scripted("primary", [new WriterError("reconcile hy-test: HTTP 400 unknown field", 400)], log),
			scripted("fallback", ["ok"], log),
		);
	} catch {
		threw = true;
	}
	check("a 400 stops the write", threw && log.join() === "primary", log.join());
}

// 5b. A 429 storm must not spend the call budget asleep. With 5 retries and a
// 15 s base wait that used to be 465 s before the fallback was tried at all
// (session 01a15110, 2026-10-18: two concurrent sessions, one model slot).
{
	const log: string[] = [];
	const busy = new WriterError("extract hy-test: HTTP 429 concurrency_limit", 429);
	const out = await run(scripted("primary", [busy], log), scripted("fallback", ["ok"], log), {
		busyRetries: 5,
		busyBackoffMs: 20,
		busyBudgetMs: 50,
	});
	// 20 ms fits, the next 40 ms would exceed the budget: two attempts, then the fallback.
	check("busy budget bounds the wait", out.endpoint === "fallback" && log.join() === "primary,primary,fallback");
}

// 6. `preferFallback` skips a primary already known to be down.
{
	const log: string[] = [];
	const out = await run(scripted("primary", ["no"], log), scripted("fallback", ["ok"], log), {
		preferFallback: true,
	});
	check("preferFallback skips the primary", out.endpoint === "fallback" && log.join() === "fallback");
	check("fallback completion reports its own model", out.model.id === "fallback", out.model.id);
}

// 7. ... and if the fallback then fails, the primary is tried, without marking
//    the primary down (the failure came from the fallback).
{
	const log: string[] = [];
	const out = await run(
		scripted("primary", ["ok"], log),
		scripted("fallback", [new WriterError("fallback down", 0)], log),
		{ preferFallback: true },
	);
	check("fallback failure falls back to primary", out.endpoint === "primary" && log.join() === "fallback,primary");
	check("reason names the fallback", String(out.failed).includes("fallback down"));
}

// 8. No fallback configured: the primary error surfaces unchanged.
{
	let message = "";
	try {
		await run(scripted("primary", [new WriterError("extract hy-test: HTTP 503", 503)], []), null);
	} catch (error) {
		message = String((error as Error).message);
	}
	check("no fallback surfaces the error", message.includes("503"), message);
}

// 9. Classification of an unknown failure: failover-eligible unless the message
//    looks like a model-output problem.
check("unknown error is failover-eligible", isFailoverError(new WriterError("extract hy-test: socket hang up")));
check(
	"busy is not a hard failure",
	isBusyError(new WriterError("429", 429)) && isFailoverError(new WriterError("429", 429)),
);

console.log(failures === 0 ? "ok: fallback endpoint" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
