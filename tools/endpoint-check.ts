/**
 * Writer check: model resolution, request options, and error mapping.
 *
 * The extension no longer speaks HTTP (see src/llm.ts): it asks pi's model
 * registry for a model by name and calls it. That moves three things into view
 * that used to be somebody else's problem, and each one has a failure mode worth
 * pinning:
 *
 * 1. **Resolution.** Model ids can contain slashes (`llama-swap` serves
 *    `local/hy-memory-30b-a3b`), so a naive split on `/` picks the wrong
 *    provider. Providers that register models asynchronously may also be empty on
 *    the first write, which is why resolution refreshes and retries once.
 * 2. **The request.** This writer is deterministic and non-thinking: temperature
 *    0, an output cap, and llama.cpp's `chat_template_kwargs` merged *last* so it
 *    survives the provider's own defaults.
 * 3. **Failure shape.** `registry.complete()` *resolves* with an
 *    `AssistantMessage` on provider failure (`stopReason: "error"`); it does not
 *    reject. Treating that as success would store an empty completion.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createWriter, isBusyError, isFailoverError, resolveWriterModel, WriterError } from "../src/llm.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const model = (provider: string, id: string) =>
	({
		provider,
		id,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9090",
		contextWindow: 131072,
		maxTokens: 8192,
		input: ["text"],
		cost: {},
		reasoning: false,
	}) as never;

const registry = (
	models: unknown[],
	options: { refreshAdds?: unknown[]; complete?: (opts: unknown) => unknown; fail?: string } = {},
) => {
	let list = [...models];
	const calls = { refresh: 0, complete: [] as unknown[] };
	const self = {
		getAll: () => list,
		async refresh() {
			calls.refresh++;
			if (options.refreshAdds) list = [...list, ...options.refreshAdds];
			return {};
		},
		async complete(_m: unknown, _c: unknown, opts: unknown) {
			calls.complete.push(opts);
			if (options.fail === "throw") throw new Error("HTTP 503 Service Unavailable");
			if (options.fail) {
				return {
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: options.fail,
					provider: "p",
					model: "m",
					api: "openai-completions",
				};
			}
			return {
				role: "assistant",
				content: [{ type: "text", text: '{"drafts":[]}' }],
				stopReason: "stop",
				usage: { input: 1234, output: 56 },
				durationMs: 2000,
				provider: "p",
				model: "m",
				api: "openai-completions",
			};
		},
	};
	return { registry: self as unknown as ModelRegistry, calls };
};

// 1. Resolution: exact provider/id, bare id, and ids that themselves contain a slash.
const slashy = [model("llama-swap", "local/hy-memory-30b-a3b"), model("other", "qwen3.8")];
const exact = await resolveWriterModel(registry(slashy).registry, "llama-swap/local/hy-memory-30b-a3b");
check("resolves provider/slashy-id", exact.provider === "llama-swap" && exact.id === "local/hy-memory-30b-a3b");
const bare = await resolveWriterModel(registry(slashy).registry, "qwen3.8");
check("resolves a bare model id", bare.id === "qwen3.8");
const suffix = await resolveWriterModel(registry(slashy).registry, "local/hy-memory-30b-a3b");
check("resolves an id that contains slashes", suffix.id === "local/hy-memory-30b-a3b");

// 1b. A bare spec must not match everything (empty suffix), and must still resolve
//     when the registry stores the model under a group id.
let ambiguous = "";
try {
	await resolveWriterModel(registry([model("p", "a-one"), model("p", "b-two")]).registry, "unknown");
} catch (error) {
	ambiguous = String((error as Error).message);
}
check("bare spec does not match everything", ambiguous.includes("not in pi's model list"), ambiguous.slice(0, 70));
const grouped = await resolveWriterModel(registry([model("llama-swap", "grp/only-one")]).registry, "only-one");
check("bare id resolves a grouped model", grouped.id === "grp/only-one");

// 2. Models registered late are picked up after one refresh.
const late = registry([], { refreshAdds: [model("llama-swap", "hy-memory-30b-a3b")] });
const lateModel = await resolveWriterModel(late.registry, "llama-swap/hy-memory-30b-a3b");
check("refreshes when the list is empty", lateModel.id === "hy-memory-30b-a3b" && late.calls.refresh === 1);

// 3. A miss says what the registry actually has, instead of "not found".
let message = "";
try {
	await resolveWriterModel(registry([model("llama-swap", "qwen3.8")]).registry, "llama-swap/hy-memory-30b-a3b");
} catch (error) {
	message = String((error as Error).message);
}
check("miss lists the model list", message.includes("not in pi's model list"), message.slice(0, 90));

// 4. The request carries determinism, the cap, and the llama.cpp kwargs last.
const ok = registry([model("llama-swap", "hy-memory-30b-a3b")]);
const writer = createWriter(ok.registry, {
	model: "llama-swap/hy-memory-30b-a3b",
	temperature: 0,
	maxTokens: 8000,
	samplingParams: { chat_template_kwargs: { reasoning_effort: "no_think" } },
	timeoutMs: 60_000,
});
const out = await writer.complete("system", "chunk", "extract hy-001");
const opts = ok.calls.complete[0] as Record<string, unknown>;
check("temperature 0", opts.temperature === 0);
check("output cap passed", opts.maxTokens === 8000);
check(
	"llama.cpp kwargs passed",
	JSON.stringify(opts.samplingParams) === JSON.stringify({ chat_template_kwargs: { reasoning_effort: "no_think" } }),
);
check("has an abort signal", opts.signal instanceof AbortSignal);
check("usage mapped", out.usage.inTokens === 1234 && out.usage.outTokens === 56 && out.usage.wallS === 2);

// 5. A provider failure that *resolves* must not look like a completion.
const failed = registry([model("llama-swap", "m")], { fail: "HTTP 429 Too Many Requests" });
let thrown: unknown;
try {
	await createWriter(failed.registry, { model: "llama-swap/m" }).complete("s", "u", "extract hy-002");
} catch (error) {
	thrown = error;
}
check(
	"error stopReason becomes a throw",
	thrown instanceof WriterError,
	String((thrown as Error)?.message).slice(0, 60),
);
check("status parsed from the message", (thrown as WriterError)?.status === 429);
check("busy is recognised", isBusyError(thrown));
check("busy is failover-eligible", isFailoverError(thrown));

// 6. A transport rejection is normalised too.
const rejected = registry([model("llama-swap", "m")], { fail: "throw" });
let rejectedError: unknown;
try {
	await createWriter(rejected.registry, { model: "llama-swap/m" }).complete("s", "u", "extract hy-003");
} catch (error) {
	rejectedError = error;
}
check("transport error becomes a WriterError", rejectedError instanceof WriterError);
check("5xx is failover-eligible", isFailoverError(rejectedError));

// 7. Client-shaped errors are not retried on another model.
check("a 400 is not failover", !isFailoverError(new WriterError("reconcile hy-004: HTTP 400 bad field", 400)));
check("unparseable output is not failover", !isFailoverError(new WriterError("extract hy-005: Expected ',' or ']'")));

console.log(failures === 0 ? "ok: writer (registry)" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
