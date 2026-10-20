/**
 * Configuration: the type, the defaults, and the keys that no longer exist.
 *
 * This lives apart from `index.ts` so `tools/config-docs-check.ts` can compare it
 * with the README table without loading the extension. Drift had already happened
 * once: `maxEntryChars` was in the code and absent from the docs, and several
 * defaults existed only as `?? 5000` at their use sites.
 */

export type HyConfig = {
	enabled: boolean;
	dryRun: boolean;
	observeAfterTokens: number;
	maxChunkTokens: number;
	maxEntryChars: number;
	poolMaxTokens: number;
	keepRecentTokens: number;
	candidateLimit: number;
	candidateRenderMode: "union" | "perDraft";
	waitForWriteOnSettle: boolean;
	/** Upper bound on how long session_shutdown waits for an in-flight write. */
	shutdownWaitMs?: number;
	/** Writer model, as pi lists it: `provider/modelId`, or a bare model id. */
	model: string;
	/** Output cap per call. */
	maxTokens?: number;
	/**
	 * Merged into the request body last (see `samplingParams` in pi-ai). This is
	 * how llama.cpp's no-think kwargs reach the server; leave unset for providers
	 * that reject unknown fields.
	 */
	chatTemplateKwargs?: Record<string, unknown> | false;
	extraBody?: Record<string, unknown>;
	/** Total wall-clock cap for one writer call. */
	timeoutMs?: number;
	/**
	 * Second model used when the primary does not answer (network error, timeout,
	 * 5xx/429/401). Resolved from pi's model list like `model`.
	 */
	fallback?: { model: string; maxTokens?: number; timeoutMs?: number } | false;
	/** How long to stay on the fallback after a failover, in seconds. */
	fallbackCooldownS?: number;
	/** Footer progress bar (progress window + spinner). */
	statusBar?: boolean;
	/** Delete per-session state older than this many days; 0 disables. */
	pruneAfterDays?: number;
	/** Retries on 429 (single-slot peer) before the fallback is considered. */
	busyRetries?: number;
	/** Base backoff for those retries; doubles each attempt. */
	busyBackoffMs?: number;
	/**
	 * Seconds to wait before writing again after a failed attempt, doubling while it
	 * keeps failing (capped at 10 minutes). 0 disables the wait.
	 */
	writeCooldownS?: number;
};

/**
 * Keys this extension used to read and no longer does. The writer is a model from
 * pi's list now, so an `origin`/`apiKey` pair is a leftover from an endpoint config;
 * silently ignoring it would leave a session writing to the wrong model.
 */
export function legacyKeys(config: Record<string, unknown>): string[] {
	return ["origin", "apiKey", "maxTokensParam", "reasoningEffort"].filter((key) => config[key] !== undefined);
}

/** The documented defaults. Every key in `HyConfig` belongs here. */
export const SETTING_DEFAULTS: HyConfig = {
	enabled: true,
	dryRun: false,
	observeAfterTokens: 6000,
	maxChunkTokens: 6000,
	maxEntryChars: 3000,
	poolMaxTokens: 6000,
	keepRecentTokens: 6000,
	candidateLimit: 12,
	candidateRenderMode: "perDraft",
	waitForWriteOnSettle: true,
	model: "hy-memory-30b-a3b",
	maxTokens: 8000,
	timeoutMs: 480_000,
	chatTemplateKwargs: false,
	extraBody: {},
	fallback: false,
	fallbackCooldownS: 300,
	busyRetries: 3,
	busyBackoffMs: 4000,
	writeCooldownS: 30,
	pruneAfterDays: 30,
	shutdownWaitMs: 5000,
	statusBar: true,
};
