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
	/** Ceiling on the active bank: the store, not the summary. */
	bankMaxTokens: number;
	/** What a compaction summary renders; a selection over the bank. */
	summaryMaxTokens: number;
	/** A fact this many chunks old and never superseded counts as a foundation. */
	foundationAfterChunks: number;
	/** Share of the summary budget reserved for user-stated facts. */
	summaryConstraintShare: number;
	/** Share reserved for old, never-superseded facts. */
	summaryFoundationShare: number;
	/**
	 * Ceiling on the verbatim tail a compaction keeps. It is a ceiling, not a delivered size:
	 * `keepRecentShare` decides how much of the room the tail asks for, and the walk back through
	 * the branch stops there rather than at this number — so a 24 k window delivers a share of its
	 * room and a 168 k window delivers this much, and the leftover room is left unbudgeted instead
	 * of being spent on conversation the next turn will truncate anyway.
	 */
	keepRecentTokens: number;
	/**
	 * Share of the room left after pi's reserve, the measured overhead and the digest reservation
	 * that the tail asks for, before `keepRecentTokens` caps it. The tail is verbatim conversation
	 * and nothing can rebuild it; the note is re-rendered from the fact bank at every compaction, so
	 * the note takes what the tail left, up to `summaryMaxTokens`, and gives way first. Accepted range is
	 * 0…1 and the split clamps it there: 0 leaves the note the whole room, 1 leaves it the 500-token floor.
	 */
	keepRecentShare: number;
	/**
	 * How much of the compaction budget the overflow digest may use: when the kept tail has to be cut
	 * to fit the model's window, the entries the writer never read are folded into the summary as a
	 * bounded deterministic digest instead of disappearing. `0` drops them without a digest. The room
	 * is only reserved when a trim is actually going to happen, and only in the size that drop set
	 * can use.
	 */
	overflowDigestTokens: number;
	candidateLimit: number;
	/**
	 * Ask the executor's own model to write the compaction checkpoint instead of rendering
	 * the bank. Off by default: the render is free and cannot fail, and this reintroduces a
	 * model call at the slowest moment in the session.
	 */
	hifiCompaction: boolean;
	/**
	 * Output cap for the checkpoint. Measured: a 64-fact delta from a 408-fact bank wrote
	 * 1 470–1 508 tokens of checkpoint and was still cut off at 2 000, so the old default
	 * truncated a good answer. Reasoning shares this cap with the answer.
	 */
	hifiMaxTokens: number;
	/**
	 * Whether the checkpoint call thinks. "off" asks the model not to; "inherit" uses the
	 * session's own level. "off" is the default because reasoning and the answer share one
	 * output budget, and a model that thinks at a checkpoint spends it without answering —
	 * measured three times on a local Qwen build before any fix was applied.
	 */
	hifiThinkingLevel: "off" | "inherit";
	/** How much of the kept tail the model may read as context. */
	hifiTailTokens: number;
	/** How many tokens of new facts the model may read. */
	hifiDeltaTokens: number;
	/**
	 * How many boundaries a fact the checkpoint dropped is offered again. Bounded because the
	 * re-offer is the most expensive part of the delta: measured on a 408-fact bank, a boundary
	 * covering two chunks spent 4 206 of its 6 000 delta tokens on facts already offered and
	 * already not cited. After this many attempts the fact stays in the bank, recallable.
	 */
	hifiRetryLimit: number;
	/** Wall-clock cap for the checkpoint call. */
	hifiTimeoutMs: number;
	candidateRenderMode: "union" | "perDraft";
	/**
	 * Refuse an UPDATE whose draft drops a value its target carries — a number, a flag, a dotted file
	 * name, a path, an underscored identifier — even when the subject guard calls the two one subject.
	 * TODO 7.18's third option, priced in `dev/guard-fold-report.ts`: across 10 recorded runs the wording
	 * rule alone loses 9 corpus-declared values at merges and this gate loses none, at +7 % bank tokens
	 * and +7 values held by two facts at once. Off until the live run agrees with the re-fold — refusing
	 * a merge leaves its target active, so a run under this gate drafts against a different bank, which
	 * is the one thing a re-fold cannot see.
	 */
	mergeValueGate: boolean;
	waitForWriteOnSettle: boolean;
	/**
	 * Wait for an in-flight write before handing a compaction back to pi. pi checks compaction
	 * *before* `agent_before_settle`, so the backlog that would be dropped is very often a write
	 * started at `turn_end` that is seconds from landing: on session `01a17818` two deferrals
	 * covered a write that finished 39 s after the first one. The wait is bounded by
	 * `compactWaitMs`, stage-aware, and never applies to overflow. `false` is the rollback: the
	 * deferral and its notification go away and pi summarises as before.
	 */
	waitForWriterBeforeCompact: boolean;
	/**
	 * Ceiling on that wait, shared by the running write and its chained follow-ups. 60 000 covers
	 * the reconcile p75 (~55 s) and both incidents in the live audit (2 s and 11 s remaining); it
	 * deliberately does not cover most extract-stage waits, where the ETA says do not bother.
	 */
	compactWaitMs: number;
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
	/**
	 * Drain a session that is idle instead of waiting for its next turn. A write is
	 * otherwise only ever started by `turn_end`, so a session left open with a large
	 * backlog never pays it down. This starts one write once the session has been
	 * quiet this long *and* the unread window is at least four times the write
	 * trigger. 0 disables it.
	 */
	idleDrainAfterMs: number;
	/**
	 * Offer the session model a `hy_flush` tool so it can name the range the writer
	 * should read instead of waiting for the token threshold. On by default: the cost
	 * is the tool's prompt surface, and the payoff is a chunk boundary chosen where
	 * work settled rather than where 6 000 estimated tokens landed.
	 */
	flushTool: boolean;
	/** How many unwritten entries the listing shows before it summarises the rest. */
	flushListEntries: number;
	/**
	 * Refuse a model-initiated write while less than this much is unwritten. A boundary
	 * experiment on identical content (24 pieces against 12 whole captures, same writer and
	 * judge) found finer boundaries do not raise statement quality — specificity stayed flat
	 * and the durable share fell from 60 % to 51 % — while the writes doubled. A floor keeps a
	 * flush near threshold-sized instead of one chunk per settled turn.
	 */
	flushMinTokens: number;
};

/**
 * Keys this extension used to read and no longer does. The writer is a model from
 * pi's list now, so an `origin`/`apiKey` pair is a leftover from an endpoint config;
 * silently ignoring it would leave a session writing to the wrong model.
 */
export function legacyKeys(config: Record<string, unknown>): string[] {
	return ["origin", "apiKey", "maxTokensParam", "reasoningEffort", "poolMaxTokens"].filter(
		(key) => config[key] !== undefined,
	);
}

/** The documented defaults. Every key in `HyConfig` belongs here. */
export const SETTING_DEFAULTS: HyConfig = {
	enabled: true,
	dryRun: false,
	observeAfterTokens: 6000,
	maxChunkTokens: 6000,
	maxEntryChars: 3000,
	bankMaxTokens: 60000,
	summaryMaxTokens: 12000,
	foundationAfterChunks: 8,
	summaryConstraintShare: 0.1,
	summaryFoundationShare: 0.35,
	keepRecentTokens: 20000,
	keepRecentShare: 0.4,
	overflowDigestTokens: 1500,
	candidateLimit: 24,
	hifiCompaction: false,
	hifiMaxTokens: 4000,
	hifiThinkingLevel: "off",
	hifiTailTokens: 6000,
	hifiDeltaTokens: 6000,
	hifiRetryLimit: 3,
	hifiTimeoutMs: 120_000,
	candidateRenderMode: "perDraft",
	mergeValueGate: false,
	waitForWriteOnSettle: true,
	waitForWriterBeforeCompact: true,
	compactWaitMs: 60_000,
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
	idleDrainAfterMs: 180_000,
	// Off by default. The compaction-survival pilot measured no retention advantage while the tool
	// costs extra writer work and a prompt surface (`RESULTS.md`, item 6.4); opt in per session.
	flushTool: false,
	flushListEntries: 24,
	flushMinTokens: 2000,
	pruneAfterDays: 30,
	shutdownWaitMs: 5000,
	statusBar: true,
};
