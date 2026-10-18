/**
 * The writer: one model from pi's own model list, called twice per chunk.
 *
 * There is deliberately no HTTP client here. Pi's model registry already knows
 * the provider, the base URL, the credential, the context window and the
 * provider's request quirks, including for models a provider registers
 * dynamically at runtime. A second copy of that knowledge in this extension
 * would drift from the one pi actually uses.
 *
 * Two things this file does own:
 *
 * 1. **Which model.** `writeChunk` must know exactly which model wrote a memory
 *    bank, and the writer is not the session model, so it is resolved by name
 *    from the registry (`provider/modelId`, or a bare model id). Resolution is
 *    lazy: the registry may still be filling itself when the session starts.
 * 2. **A hard time cap.** `timeoutMs` bounds *total* wall time, not stream
 *    idleness: a CPU-offloaded writer answers continuously for minutes, so an
 *    idle timeout never fires while a 5-minute total cap is what protects the
 *    session from a wedged generation.
 *
 * Errors: `registry.complete()` resolves with an `AssistantMessage` even when
 * the provider failed (`stopReason: "error"`, message in `errorMessage`); it does
 * not reject. Everything that looks like a failed call is therefore converted to
 * a `WriterError` here, carrying the HTTP status when the message reveals one, so
 * the failover classification below keeps working.
 */

import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { CallUsage } from "./types.js";

/** The model a completion came from, after name resolution. */
export interface ModelRef {
	provider: string;
	id: string;
}

export interface Completion {
	content: string;
	usage: CallUsage;
	/**
	 * Resolution is dynamic and may differ per call (primary vs fallback, or a
	 * provider that changed its model list mid-session), so the answer carries the
	 * model rather than trusting the configured name.
	 */
	model: ModelRef;
}

export interface Writer {
	/** Model name used in audit lines and error messages. */
	readonly model: string;
	complete(system: string, user: string, label: string, signal?: AbortSignal): Promise<Completion>;
}

export interface WriterOptions {
	/** `provider/modelId` as pi lists it. A bare model id also works when unambiguous. */
	model: string;
	temperature?: number;
	maxTokens?: number;
	/**
	 * Merged into the request body last, so it can override named fields. This is
	 * how llama.cpp's `chat_template_kwargs` (e.g. `{"reasoning_effort":"no_think"}`)
	 * reaches the server even though the provider marks the model as non-reasoning.
	 */
	samplingParams?: Record<string, unknown>;
	/** Total wall-clock cap for one call. */
	timeoutMs?: number;
}

/** A failed writer call, normalised so failover rules can read the status. */
export class WriterError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "WriterError";
	}
}

/** `HTTP 429`, `status: 503`, `429 Too Many Requests` → 429 / 503. */
function statusFrom(message: string): number | undefined {
	const patterns = [/HTTP\s*\/?[\d.]*\s+(\d{3})\b/i, /status\s*:?\s*(\d{3})\b/i, /\b(4\d{2}|5\d{2})\b/];
	for (const pattern of patterns) {
		const found = pattern.exec(message);
		if (found) {
			const value = Number(found[1]);
			if (value >= 400 && value <= 599) return value;
		}
	}
	return undefined;
}

/**
 * Resolve a model from pi's registry.
 *
 * Exact `provider/id` wins. Model ids may themselves contain slashes
 * (`llama-swap` serves ids like `local/hy-memory-30b-a3b`), so a plain
 * `provider.split("/")` is wrong: the spec is matched against `provider + "/" + id`
 * first, then against a bare id, then against ids the spec ends with.
 */
export async function resolveWriterModel(registry: ModelRegistry, spec: string): Promise<Model<Api>> {
	const match = (): Model<Api> | undefined => {
		const all = registry.getAll();
		const full = all.filter((m) => `${m.provider}/${m.id}` === spec);
		if (full.length === 1) return full[0];
		const bare = all.filter((m) => m.id === spec);
		if (bare.length === 1) return bare[0];
		// Suffix matching covers a spec written as `provider/id` when the provider is
		// unknown, or a bare id when the registry stores `group/id`. An empty tail
		// would match every model (`id.endsWith("")`), so it is skipped.
		const tail = spec.includes("/") ? spec.slice(spec.indexOf("/") + 1) : "";
		const suffix = all.filter(
			(m) => spec.endsWith(m.id) || (tail !== "" ? m.id.endsWith(tail) : m.id.endsWith(`/${spec}`)),
		);
		return suffix.length === 1 ? suffix[0] : undefined;
	};

	let model = match();
	if (!model) {
		// Providers that register their models at startup finish asynchronously; the
		// first write can beat them. Refreshing is cheap and bounded.
		await registry.refresh({ allowNetwork: false }).catch(() => undefined);
		model = match();
	}
	if (model) return model;

	const names = registry
		.getAll()
		.map((m) => `${m.provider}/${m.id}`)
		.sort();
	const related = names.filter((n) => spec.split("/").some((part) => part && n.includes(part)));
	throw new WriterError(
		`writer model "${spec}" is not in pi's model list.` +
			(related.length > 0
				? ` Closest matches: ${related.slice(0, 5).join(", ")}.`
				: ` Known models: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}.`) +
			" A provider that discovers its models over the network registers none until its server answers, so this can be transient; the watermark does not advance and the next write retries.",
	);
}

export function createWriter(registry: ModelRegistry, options: WriterOptions): Writer {
	let cached: Promise<Model<Api>> | undefined;
	const resolve = (): Promise<Model<Api>> => (cached ??= resolveWriterModel(registry, options.model));

	return {
		model: options.model,
		async complete(system, user, label, outerSignal) {
			const model = await resolve();
			const controller = new AbortController();
			const timer = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;
			const forwardAbort = (): void => controller.abort();
			outerSignal?.addEventListener("abort", forwardAbort, { once: true });
			const started = Date.now();
			try {
				const message = await registry.complete(
					model,
					{
						systemPrompt: system,
						messages: [{ role: "user", content: user, timestamp: started }],
					},
					{
						temperature: options.temperature,
						maxTokens: options.maxTokens,
						samplingParams: options.samplingParams,
						signal: controller.signal,
						sessionId: label,
					},
				);
				return { ...interpret(message, label, started), model: { provider: model.provider, id: model.id } };
			} catch (error) {
				if (error instanceof WriterError) throw error;
				const text = String((error as Error)?.message ?? error);
				throw new WriterError(`${label}: ${text}`, statusFrom(text));
			} finally {
				if (timer) clearTimeout(timer);
				outerSignal?.removeEventListener("abort", forwardAbort);
			}
		},
	};
}

function interpret(message: AssistantMessage, label: string, started: number): Omit<Completion, "model"> {
	const text = message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
	if (message.stopReason === "aborted") {
		const reason = message.errorMessage ?? "request aborted";
		throw new WriterError(`${label}: ${reason}`, 0);
	}
	if (message.stopReason === "error") {
		const reason = message.errorMessage ?? "provider returned an error";
		throw new WriterError(`${label}: ${reason}`, statusFrom(reason));
	}
	if (!text.trim()) {
		throw new WriterError(`${label}: empty completion (stopReason=${message.stopReason})`);
	}
	return {
		content: text,
		usage: {
			inTokens: message.usage?.input ?? 0,
			outTokens: message.usage?.output ?? 0,
			wallS: message.durationMs !== undefined ? message.durationMs / 1000 : (Date.now() - started) / 1000,
		},
	};
}

/** The endpoint is up but its single slot is taken (llama-swap answers 429 at once). */
export function isBusyError(error: unknown): boolean {
	return error instanceof WriterError && error.status === 429;
}

/**
 * Failures worth trying the fallback model for. Anything that is not a
 * client-shaped rejection means "this model will not answer": network errors,
 * timeouts, 5xx, 429, auth/404 misconfiguration. An unparseable completion is a
 * property of the model, not of the network, so it is not retried elsewhere.
 */
export function isFailoverError(error: unknown): boolean {
	if (error instanceof WriterError) {
		if (error.status === undefined) {
			return !/^(extract|reconcile) \S+: (Expected|Unbalanced|no JSON object|Unexpected)/i.test(error.message);
		}
		if (error.status === 0) return true;
		return (
			error.status === 408 ||
			error.status === 429 ||
			error.status >= 500 ||
			[401, 403, 404].includes(error.status)
		);
	}
	return false;
}

/**
 * One call, with the fallback model behind the primary.
 *
 * `preferFallback` skips a primary already known to be down. A busy primary is
 * retried with backoff before the fallback is considered, because llama-swap
 * rejects a concurrent request to a single-slot model instantly rather than
 * queueing: swapping models on the first 429 would defeat the reason the
 * primary was chosen.
 */
export async function completeWithFallback(
	primary: Writer,
	fallback: Writer | null,
	system: string,
	user: string,
	label: string,
	options: {
		preferFallback?: boolean;
		busyRetries?: number;
		busyBackoffMs?: number;
		signal?: AbortSignal;
		/** Progress notices for the footer (waiting for a busy slot, failover). */
		onNotice?: (message: string) => void;
	} = {},
): Promise<Completion & { endpoint: "primary" | "fallback"; failed?: string }> {
	if (fallback && options.preferFallback) {
		options.onNotice?.("on fallback");
		try {
			return { ...(await fallback.complete(system, user, label, options.signal)), endpoint: "fallback" };
		} catch (error) {
			const out = await primary.complete(system, user, label, options.signal);
			return { ...out, endpoint: "primary", failed: String((error as Error)?.message ?? error).slice(0, 200) };
		}
	}

	const retries = options.busyRetries ?? 3;
	const backoff = options.busyBackoffMs ?? 4000;
	let primaryError: unknown;
	for (let attemptIndex = 0; ; attemptIndex++) {
		try {
			return { ...(await primary.complete(system, user, label, options.signal)), endpoint: "primary" };
		} catch (error) {
			if (isBusyError(error) && attemptIndex < retries) {
				const waitMs = backoff * 2 ** attemptIndex;
				options.onNotice?.(`busy ${Math.round(waitMs / 1000)}s`);
				await new Promise((resolve) => setTimeout(resolve, waitMs));
				continue;
			}
			primaryError = error;
			if (!fallback || !isFailoverError(error)) throw error;
			options.onNotice?.("failover");
			break;
		}
	}
	const out = await fallback.complete(system, user, label, options.signal);
	return {
		...out,
		endpoint: "fallback",
		failed: String((primaryError as Error)?.message ?? primaryError).slice(0, 200),
	};
}
