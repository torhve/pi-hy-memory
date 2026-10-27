/**
 * pi-hy-memory — a pi extension that keeps a durable fact bank, written by
 * Hy-Memory-30B-A3B as a memory-bank writer rather than as an agent with tools.
 *
 * Write path per chunk (see DESIGN.md for why each piece is shaped this way):
 *   turn_end -> due check -> serialize entries (ids hidden) -> extract drafts
 *            -> retrieve bank candidates -> reconcile ADD/UPDATE/DELETE
 *            -> validate + sanitize -> apply -> budget -> append ledger entries
 *
 * Compaction is a string build over the bank: no model call.
 * Deletes are tombstones. Nothing in this extension removes history.
 *
 * Config: ~/.pi/agent/pi-hy-memory.json
 * Audit + per-session ledger mirror: ~/.pi/agent/pi-hy-memory/
 */

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import { enforceBudget, foldLedger } from "./bank.js";
import { COMPACT_OVERHEAD_TOKENS, DIGEST_ENTRY_CHARS, resolveBudget } from "./budget.js";
import { IDLE_DRAIN_TRIGGER_FACTOR, shouldChainWrite, shouldFlushWrite, shouldIdleDrain } from "./chain.js";
import { EXTRACT_RECORD, highestChunkSeq, nextChunkId } from "./chunks.js";
import { type HyConfig, legacyKeys, SETTING_DEFAULTS } from "./config.js";
import {
	type ChunkBuild,
	coverageWindow,
	entryTokens,
	fileOperations,
	renderEntry,
	selectTail,
	serializeEntries,
} from "./entries.js";
import { nextFailoverState } from "./failover.js";
import { failureClass, shrinksChunk, writeCooldownMs } from "./failures.js";
import {
	FLUSH_DESCRIPTION,
	FLUSH_GUIDELINES,
	FLUSH_PARAM_TO,
	FLUSH_SNIPPET,
	flushQueuedText,
	flushRows,
	rangeEntries,
	renderUnwritten,
	unwrittenRange,
} from "./flush.js";
import {
	buildHifiPrompt,
	checkHifi,
	hifiFacts,
	hifiReasoning,
	hifiSummary,
	recordOffers,
	withRecallNote,
} from "./hifi.js";
import { decideCompactionWait, type InFlightWrite, TIMING_WINDOW, type WriteTiming } from "./lag.js";
import { createWriter, type Writer } from "./llm.js";
import { writeChunk } from "./pipeline.js";
import { recallHits, renderFileOperations, renderMemory, renderRecallHit, summaryBudget } from "./render.js";
import { pruneSessions } from "./state.js";
import { type SessionStats, statsFromLedger } from "./stats.js";
import { createStatusBar } from "./status.js";
import { type BankEntry, type Draft, estimateTokens, type LedgerRecord } from "./types.js";

// Env override so experiments never mutate the live config of a running session.
const CONFIG_FILE = process.env.PI_HY_MEMORY_CONFIG ?? join(os.homedir(), ".pi", "agent", "pi-hy-memory.json");
const STATE_DIR = process.env.PI_HY_MEMORY_STATE ?? join(os.homedir(), ".pi", "agent", "pi-hy-memory", "state");
const AUDIT_FILE = join(STATE_DIR, "audit.ndjson");
const SESSIONS_DIR = join(STATE_DIR, "sessions");

const OPS_RECORD = "hy.ops";
const GAP_RECORD = "hy.gap";
const EVICT_RECORD = "hy.evict";

/**
 * The wait for a write that lands during a compaction is polled, not hung on: a slice this short
 * notices a replaced session or a chain that never starts, while costing nothing when the promise
 * settles first. `WAIT_GRACE_MS` is the beat a chained follow-up gets after its parent write's own
 * promise settles, because `startWrite` assigns it inside that write's `finally`.
 */
const WAIT_POLL_MS = 250;
const WAIT_GRACE_MS = 250;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * What a refused `hy_flush` answers with. The wording differs by reason because the useful next step
 * differs: a thin write should be asked again later with a larger range, a write that is already
 * running must not be asked again at all, and anything else is just the bank staying as it is.
 */
function flushRefusal(reason: string, tokens: number, minTokens: number): string {
	if (reason === "under flush token floor")
		return `hy_flush: not written, this write would carry ${tokens} tokens and a write needs ${minTokens}. Ask again with a larger \`to\`, or keep working: the threshold folds these entries shortly and hy_recall answers what is already in the bank.`;
	if (reason === "write in flight" || reason === "extract awaiting reconcile" || reason === "write cooling down")
		return `hy_flush: not written (${reason}). A write over this window is already running or queued, and coverage is monotone, so calling again for the same range adds nothing. Answer from hy_recall; the bank grows when that write lands.`;
	return `hy_flush: not written (${reason}). The bank is unchanged; hy_recall still answers what it holds.`;
}

/**
 * The config file is optional, but a *malformed* file is not: falling back to
 * defaults in silence would run a different writer model than the one the user
 * configured, with no warning anywhere. A missing file is simply "all
 * defaults".
 */
export function loadConfigFile(path: string): { config: HyConfig; parseError: string | null } {
	try {
		return { config: { ...SETTING_DEFAULTS, ...JSON.parse(readFileSync(path, "utf8")) }, parseError: null };
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
			return { config: { ...SETTING_DEFAULTS }, parseError: null };
		return { config: { ...SETTING_DEFAULTS }, parseError: String((error as Error)?.message ?? error) };
	}
}

function audit(event: string, data: Record<string, unknown>): void {
	try {
		mkdirSync(STATE_DIR, { recursive: true });
		appendFileSync(AUDIT_FILE, `${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`);
	} catch {
		/* audit must never break a session */
	}
}

type PendingExtract = {
	chunkId: string;
	coversUpToId: string;
	drafts: Draft[];
	rejected: { reason: string; draft: unknown }[];
	usage: { inTokens: number; outTokens: number; wallS: number };
	refs: string[];
};

type SessionState = {
	sessionId: string;
	bank: BankEntry[];
	ledger: LedgerRecord[];
	cursorId: string | undefined;
	/** Set when a compaction gap dropped the cursor; coverage resumes at this entry. */
	resumeFromId?: string;
	/** Writing is on for this session; `/hy off` clears it, the marker file persists it. */
	enabled: boolean;
	/** `coverage_drift` is audited once per episode, not every turn. */
	coverageDriftAudited?: boolean;
	/** Consecutive failed attempts of any class; drives the writer cooldown. */
	consecutiveFailures: number;
	/** No write attempt before this time; set after a failure. */
	writeCooldownUntil: number;
	/** The cooldown has been reported once, so a storm does not fill the audit. */
	cooldownAudited?: boolean;
	chunkSeq: number;
	/** Consecutive failed writes; shrinks the chunk so a retry can complete. */
	failures: number;
	/** Drafts from an extract that already succeeded but whose reconcile failed. */
	pendingExtract: PendingExtract | null;
	/** When the primary was last seen down; skip it until this passes. */
	primaryDownUntil: number;
	inFlight: boolean;
	pending: Promise<void> | null;
	/**
	 * The write running right now. `session_before_compact` reads it to decide whether the
	 * backlog it would drop is a write that is seconds from landing (`src/lag.ts`), so this is
	 * the writer's own stage report rather than an outside guess.
	 */
	inFlightWrite: InFlightWrite | null;
	/** Completed writes this process has seen, oldest first, capped at `TIMING_WINDOW`. */
	timings: WriteTiming[];
	/**
	 * The last model-written checkpoint, and the chunk sequence it covered. The next
	 * hi-fi call gets this text as `<previous-summary>` and only the facts newer than
	 * `seq`, which is what keeps the request delta-sized instead of whole-bank.
	 */
	hifi?: { text: string; seq: number; at: string; attempts?: Record<string, number> };
	stats: SessionStats;
};

/** Read the ledger out of the session branch. Exported so the ceiling record's survival
 * through a reload is a test rather than a claim (`tools/evict-record-check.ts`). */
export function ledgerFromSession(entries: SessionEntry[]): LedgerRecord[] {
	const records: LedgerRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		const data = entry.data as LedgerRecord | undefined;
		if (!data || typeof data.type !== "string") continue;
		// A gap is coverage, not a write: nothing folds it into the bank and no write
		// path carries it. If it is not read back here, a reload rebuilds coverage
		// from write records alone and the window `/hy on` discarded comes straight
		// back. Measured on session 01a15860 (2026-10-20): 450 694 tokens discarded
		// at 17:08, 428 612 pending again by 17:26, and every compaction after that
		// fell back to pi's own summariser.
		if (data.type === GAP_RECORD) {
			if (typeof data.coversUpToId === "string" && typeof data.fromId === "string") records.push(data);
			continue;
		}
		// A ceiling record is not a write, but it has to be read back: the mirror is
		// rewritten from the ledger on every flush, so a record reload drops would be
		// erased from the copy that wins on the next reload.
		if (entry.customType === EVICT_RECORD) {
			const droppedIds = (data as { droppedIds?: unknown }).droppedIds;
			if (typeof data.coversUpToId === "string" && Array.isArray(droppedIds)) records.push(data);
			continue;
		}
		if (entry.customType !== EXTRACT_RECORD && entry.customType !== OPS_RECORD) continue;
		if (Array.isArray((data as any).drafts ?? (data as any).ops)) records.push(data);
	}
	return records;
}

/**
 * Stage timings for the compaction ETA, from the records this session already holds.
 *
 * A reload has no completed write in this process, and the policy refuses to wait without history
 * (`src/lag.ts`), so the first compaction after a resume would never wait. The ledger carries each
 * call's own `usage.wallS`, which is exactly the split the ETA needs: `hy.extract` is the extract
 * stage, `hy.ops` is the reconcile stage, and the two share a `chunkId`.
 *
 * Only a pair counts. An `hy.extract` with no `hy.ops` is a write that failed before its reconcile,
 * and seeding from it would estimate a total write from half of one.
 */
function writeTimingsFromLedger(records: LedgerRecord[]): WriteTiming[] {
	const byChunk = new Map<string, WriteTiming>();
	for (const record of records) {
		if (record.type !== "hy.extract" && record.type !== "hy.ops") continue;
		const wallS = record.usage?.wallS;
		if (typeof wallS !== "number" || !(wallS >= 0)) continue;
		const timing = byChunk.get(record.chunkId) ?? { chunkId: record.chunkId, extractMs: 0, reconcileMs: 0 };
		if (record.type === "hy.extract") timing.extractMs = wallS * 1000;
		else timing.reconcileMs = wallS * 1000;
		byChunk.set(record.chunkId, timing);
	}
	return [...byChunk.values()].filter((t) => t.extractMs > 0 && t.reconcileMs > 0).slice(-TIMING_WINDOW);
}

export default function piHyMemory(pi: ExtensionAPI): void {
	const { config, parseError: configParseError } = loadConfigFile(CONFIG_FILE);
	const status = createStatusBar("hy");
	let lastPending = 0;
	/** Follow-up writes started since the last turn_end; see src/chain.ts. */
	let chained = 0;
	/** Whether the write that just finished failed, for the chain gate. */
	let lastAttemptFailed = false;
	/** Model-initiated writes queued but not finished; bounded by MAX_PENDING_FLUSH. */
	let flushQueued = 0;
	/** Chunk ids started by `hy_flush`, so the queue drains when each one lands. */
	const flushChunks = new Set<string>();
	/** Idle-drain bookkeeping: the last turn that ran, and the timer watching it. */
	let lastActivityAt = Date.now();
	let idleTimer: ReturnType<typeof setInterval> | null = null;
	/** The context to write with when no turn is running to hand one over. */
	let liveCtx: ExtensionContext | null = null;
	let state: SessionState | null = null;
	let warned = false;

	const warn = (ctx: ExtensionContext, message: string): void => {
		audit("warn", { message });
		// A captured ctx becomes a throwing object once pi replaces or closes the
		// session, and even ctx.hasUI is a getter that asserts. Never let a warning
		// crash a session.
		try {
			if (warned || !ctx.hasUI) return;
			warned = true;
			ctx.ui.notify(`pi-hy-memory: ${message}`, "warning");
		} catch {
			/* ctx is stale; the audit line is the record */
		}
	};

	const samplingParams = (): Record<string, unknown> | undefined => {
		const merged: Record<string, unknown> = { ...(config.extraBody ?? {}) };
		if (config.chatTemplateKwargs) merged.chat_template_kwargs = config.chatTemplateKwargs;
		return Object.keys(merged).length > 0 ? merged : undefined;
	};

	/**
	 * The writer is a model from pi's own list, not an endpoint from a config file:
	 * provider registration (including dynamic model lists) and credentials stay
	 * pi's business, and this extension only decides which model writes memory.
	 */
	const writers = (ctx: ExtensionContext): { primary: Writer; fallback: Writer | null } => {
		const params = samplingParams();
		const primary = createWriter(ctx.modelRegistry, {
			model: config.model,
			temperature: 0,
			maxTokens: config.maxTokens ?? 8000,
			samplingParams: params,
			timeoutMs: config.timeoutMs ?? 480_000,
		});
		// `false` in the config is an explicit "no fallback"; normalise before reading.
		const fb = config.fallback ? config.fallback : null;
		if (!fb?.model) return { primary, fallback: null };
		return {
			primary,
			fallback: createWriter(ctx.modelRegistry, {
				model: fb.model,
				temperature: 0,
				maxTokens: fb.maxTokens ?? config.maxTokens ?? 8000,
				samplingParams: params,
				timeoutMs: fb.timeoutMs ?? config.timeoutMs ?? 480_000,
			}),
		};
	};

	/**
	 * The extract is the expensive half of a write and it succeeds far more often
	 * than the reconcile. Keeping it on disk means a retry after a 504 resumes
	 * from the drafts instead of re-paying the extraction — and, because the
	 * retry no longer re-serializes a bigger window, it also breaks the growth
	 * loop that took chunk 008 from 14 876 to 20 203 tokens over 25 failures.
	 */
	const pendingExtractPath = (sessionId: string): string => join(SESSIONS_DIR, `${sessionId}.pending-extract.json`);

	/**
	 * `/hy off` is per session and durable: the marker survives a reload and a
	 * resume, so a session the user disabled last week does not quietly start
	 * writing again. The name matches the `<sessionId>.<kind>` pattern `pruneSessions`
	 * already groups by, so retention needs no changes.
	 */
	const offMarkerPath = (sessionId: string): string => join(SESSIONS_DIR, `${sessionId}.off`);

	const isOffForSession = (sessionId: string): boolean => {
		try {
			return readFileSync(offMarkerPath(sessionId), "utf8").trim().length > 0;
		} catch {
			return false;
		}
	};

	const setSessionOff = (sessionId: string, off: boolean): void => {
		try {
			mkdirSync(SESSIONS_DIR, { recursive: true });
			if (off) writeFileSync(offMarkerPath(sessionId), JSON.stringify({ at: new Date().toISOString() }));
			else rmSync(offMarkerPath(sessionId), { force: true });
		} catch {
			/* the in-memory flag still applies for this run */
		}
	};

	/** The one place that answers "may this session write?", config and switch together. */
	const sessionActive = (): boolean => config.enabled && state?.enabled !== false;

	/**
	 * Is the writer worth waiting on? A failed attempt, an active cooldown or a primary held down
	 * by failover all mean the next write is not about to land, so a compaction should not hold the
	 * user on it. The one question `decideCompactionWait` asks outside the ETA model.
	 */
	const writerHealthy = (live: SessionState): boolean =>
		live.failures === 0 &&
		live.consecutiveFailures === 0 &&
		live.writeCooldownUntil <= Date.now() &&
		live.primaryDownUntil <= Date.now();

	/**
	 * The unread *conversation*. A coverage window starts at the watermark, so the writer's own
	 * `hy.extract` / `hy.ops` records sit inside it too; counting them would put "unread 2 entries"
	 * in the footer of a session that is completely covered.
	 */
	const unreadContent = (pending: SessionEntry[]): number => pending.filter((e) => e.type !== "custom").length;

	function readPendingExtract(sessionId: string): PendingExtract | null {
		try {
			const saved = JSON.parse(readFileSync(pendingExtractPath(sessionId), "utf8")) as PendingExtract;
			return saved?.chunkId && Array.isArray(saved.drafts) ? saved : null;
		} catch {
			return null;
		}
	}

	const writePendingExtract = (value: PendingExtract | null): void => {
		if (!state) return;
		try {
			mkdirSync(SESSIONS_DIR, { recursive: true });
			if (value) writeFileSync(pendingExtractPath(state.sessionId), JSON.stringify(value, null, 1));
			else rmSync(pendingExtractPath(state.sessionId), { force: true });
		} catch {
			/* the next attempt simply re-extracts */
		}
	};

	/** Halve the chunk for each consecutive failure, floor 4 000 tokens. */
	const chunkBudget = (): number => {
		const factor = Math.min(4, state?.failures ?? 0);
		return Math.max(4000, Math.round(config.maxChunkTokens / 2 ** factor));
	};

	/** Summary selection parameters, from the same config the writer uses. */
	const selection = (_bank: unknown) => ({
		foundationAfterChunks: config.foundationAfterChunks,
		constraintShare: config.summaryConstraintShare,
		foundationShare: config.summaryFoundationShare,
	});

	const candidateBudget = (): number =>
		(state?.failures ?? 0) > 0 ? Math.min(config.candidateLimit, 8) : config.candidateLimit;

	/**
	 * Footer numbers. `pending` is the window that will trigger the next write, so
	 * the bar growing is exactly "how close am I to the next memory update"; the
	 * second bar is the bank filling toward poolMaxTokens.
	 */
	const pushStatus = (entries?: SessionEntry[]): void => {
		if (config.statusBar === false || !state) return;
		let pending = lastPending;
		if (entries) {
			try {
				pending = coverageWindow(entries, state.ledger, state.cursorId, state.resumeFromId).tokens;
			} catch {
				pending = 0;
			}
			lastPending = pending;
		}
		status.snapshot({
			pending,
			off: !sessionActive(),
			budget: config.observeAfterTokens,
			bank: state.bank.filter((e) => e.status === "active").reduce((sum, e) => sum + (e.tokenCount ?? 0), 0),
			pool: config.bankMaxTokens,
		});
	};

	const mirror = (): void => {
		if (!state) return;
		try {
			mkdirSync(SESSIONS_DIR, { recursive: true });
			const base = join(SESSIONS_DIR, state.sessionId);
			writeFileSync(`${base}.ledger.jsonl`, `${state.ledger.map((r) => JSON.stringify(r)).join("\n")}\n`);
			writeFileSync(`${base}.bank.json`, JSON.stringify(state.bank, null, 1));
			writeFileSync(
				`${base}.summary.md`,
				`${renderMemory(state.bank, summaryBudget(config.summaryMaxTokens, state.bank), selection(state.bank))}\n`,
			);
			// The last checkpoint, so the next one is a delta rather than a full rewrite
			// after a restart. Without this the self-healing delta still works, it just
			// re-offers the whole bank once.
			if (state.hifi) writeFileSync(`${base}.hifi.json`, JSON.stringify(state.hifi, null, 1));
			writeFileSync(
				`${base}.stats.json`,
				JSON.stringify(
					{ ...state.stats, active: state.bank.filter((e) => e.status === "active").length },
					null,
					1,
				),
			);
		} catch (error) {
			audit("mirror_failed", { error: String((error as Error)?.message ?? error) });
		}
	};

	const reset = (ctx: ExtensionContext): void => {
		const sessionId = ctx.sessionManager.getSessionId();
		const ledger = ledgerFromSession(ctx.sessionManager.getBranch());
		// A write can finish after pi has already closed or replaced the session, in
		// which case its records never reached the session file. The mirror is the
		// fallback: the bank is never lost, only relocated to the state dir.
		let mirrored: LedgerRecord[] = [];
		try {
			mirrored = readFileSync(join(SESSIONS_DIR, `${sessionId}.ledger.jsonl`), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as LedgerRecord);
		} catch {
			mirrored = [];
		}
		const effective = mirrored.length > ledger.length ? mirrored : ledger;
		if (effective.length > ledger.length)
			audit("rehydrated", { sessionId, fromSession: ledger.length, fromMirror: mirrored.length });
		// Budget eviction is pressure, not deletion: it is never written to the ledger,
		// so re-folding restores those facts. Re-apply the current cap here so a reload
		// cannot leave the bank (and the status bar / summary) above it.
		const folded = foldLedger(effective);
		const recheck = enforceBudget(folded, config.bankMaxTokens);
		if (recheck.dropped.length > 0) {
			// The durable naming lives in the ledger's own `hy.evict` records, written when a
			// write pushed the bank over the cap; a reload re-applies that same ceiling, so
			// this audit is the corroborating copy rather than the only record. Bounded,
			// because one reload's drop list can be hundreds of ids.
			audit("budget_reapplied", {
				sessionId,
				pool: config.bankMaxTokens,
				dropped: recheck.dropped.length,
				droppedTokens: recheck.dropped.reduce((n: number, e: { tokenCount: number }) => n + e.tokenCount, 0),
				ids: recheck.dropped.slice(0, 40).map((e: { id: string }) => e.id),
				idsTruncated: recheck.dropped.length > 40,
			});
		}
		const lastGap = [...effective].reverse().find((r) => r.type === "hy.gap");
		// A checkpoint from before a restart is still the newest summary this session has.
		let restoredHifi: SessionState["hifi"];
		try {
			const raw = JSON.parse(
				readFileSync(join(SESSIONS_DIR, `${sessionId}.hifi.json`), "utf8"),
			) as SessionState["hifi"];
			if (raw && typeof raw.text === "string" && raw.text.trim() && typeof raw.seq === "number")
				restoredHifi = raw;
		} catch {
			/* no checkpoint yet */
		}
		chained = 0;
		flushQueued = 0;
		flushChunks.clear();
		const offForSession = isOffForSession(sessionId);
		state = {
			sessionId,
			enabled: !offForSession,
			ledger: effective,
			bank: folded,
			cursorId: effective.at(-1)?.coversUpToId,
			resumeFromId: lastGap?.fromId,
			chunkSeq: highestChunkSeq(effective),
			failures: 0,
			consecutiveFailures: 0,
			writeCooldownUntil: 0,
			pendingExtract: readPendingExtract(sessionId),
			primaryDownUntil: 0,
			inFlight: false,
			pending: null,
			inFlightWrite: null,
			// Seeded, not empty: a resumed session has writes behind it, and the ETA policy
			// refuses to wait with no history to estimate from.
			timings: writeTimingsFromLedger(effective),
			hifi: restoredHifi,
			// The counters continue from the ledger rather than restarting: they sit on a status
			// line that reads as a session total, and a reload used to reset them to this process's
			// own writes, so a session at write 145 printed "14 writes" (TODO 6.22).
			stats: statsFromLedger(effective),
		};
		audit("session_start", {
			sessionId,
			records: effective.length,
			active: state.bank.filter((e) => e.status === "active").length,
			disabled: offForSession,
		});

		// Retention: per-session banks/ledgers accumulate forever otherwise. Runs
		// after the current session's state is loaded, never touches it, and is off
		// when pruneAfterDays is 0.
		const pruned = pruneSessions(SESSIONS_DIR, {
			afterDays: config.pruneAfterDays ?? 0,
			keep: [sessionId],
		});
		if (pruned.removed.length > 0) {
			audit("pruned", { removed: pruned.removed.length, files: pruned.files, ids: pruned.removed.slice(0, 5) });
		}
	};

	pi.on("session_start", (_event, ctx) => {
		markActivity(ctx);
		startIdleTimer();
		if (configParseError) {
			audit("config_parse_failed", { file: CONFIG_FILE, error: configParseError.slice(0, 200) });
			warn(ctx, `config ${CONFIG_FILE} could not be parsed, using defaults: ${configParseError.slice(0, 160)}`);
		}
		// The writer is a model from pi's list now; an endpoint pair left in the
		// config would otherwise be ignored in silence.
		const legacy = legacyKeys(config as unknown as Record<string, unknown>);
		if (legacy.length > 0) {
			audit("legacy_config", { keys: legacy });
			warn(ctx, `ignoring ${legacy.join(", ")}: set "model": "provider/modelId" from your pi model list`);
		}
		try {
			reset(ctx);
			if (config.statusBar !== false) {
				status.attach(ctx.ui as never);
				pushStatus(ctx.sessionManager.getBranch());
			}
			// A remembered "off" must announce itself: silence here is indistinguishable
			// from a broken extension until the user notices whole sessions went by.
			if (state && !state.enabled) {
				try {
					ctx.ui.notify(
						"pi-hy-memory: off for this session (remembered from an earlier /hy off). /hy on resumes it.",
						"warning",
					);
				} catch {
					/* stale ctx; the audit line below is the record */
				}
			}
		} catch (error) {
			warn(ctx, `could not restore bank: ${String((error as Error)?.message ?? error)}`);
		}
	});

	const runWrite = (ctx: ExtensionContext, chunk: ChunkBuild, chunkId: string, sessionId: string): Promise<void> => {
		const started = Date.now();
		audit("write_start", {
			sessionId,
			chunkId,
			writer: config.model,
			chunkTokens: estimateTokens(chunk.text),
			droppedEntries: chunk.droppedEntries,
		});
		return (async () => {
			try {
				const startState = state;
				if (!startState) return;
				const resume = startState.pendingExtract?.chunkId === chunkId ? startState.pendingExtract : null;
				// What a compaction waiting on this write reads: the chunk it is carrying, when it
				// started, and the stage the writer reports below. Cleared when it lands or fails.
				if (startState.sessionId === sessionId) {
					startState.inFlightWrite = {
						chunkId,
						chunkTokens: estimateTokens(chunk.text),
						startedAt: started,
						// A resumed extract skips the extract call and goes straight to reconcile.
						stage: resume ? "reconcile" : "extract",
						stageAt: started,
						...(resume ? { reconcileAt: started } : {}),
					};
				}
				const { primary, fallback } = writers(ctx);
				const result = await writeChunk(primary, startState.bank, chunkId, chunk, {
					bankMaxTokens: config.bankMaxTokens,
					candidateLimit: candidateBudget(),
					candidateRenderMode: config.candidateRenderMode,
					mergeValueGate: config.mergeValueGate,
					fallback,
					preferFallback: (state?.primaryDownUntil ?? 0) > Date.now(),
					busyRetries: config.busyRetries,
					busyBackoffMs: config.busyBackoffMs,
					// A quarter of the call budget: enough for a slot to free, not enough
					// to spend the whole write asleep.
					busyBudgetMs: Math.max(1, Math.round((config.timeoutMs ?? 480_000) / 4)),
					onStage: (stage, detail) => {
						status.stage(stage, detail);
						// The stage report is the only honest signal of what is left of a write, so
						// it goes on the in-flight record as well as the footer.
						const live = state && state.sessionId === sessionId ? state : null;
						const record = live?.inFlightWrite;
						if (!record || record.chunkId !== chunkId) return;
						record.stage = stage;
						record.stageAt = Date.now();
						// Set once: a `waiting` notice afterwards is a 429 backoff inside the same
						// reconcile, not a second reconcile to measure.
						if (stage === "reconcile" && record.reconcileAt === undefined) record.reconcileAt = Date.now();
					},
					resume: resume
						? {
								drafts: resume.drafts,
								rejected: resume.rejected,
								usage: resume.usage,
								refs: resume.refs,
								coversUpToId: resume.coversUpToId,
							}
						: undefined,
					onExtract: (record) => {
						if (!state) return;
						// Idempotent: the resumed path already persisted this record.
						if (state.ledger.some((r) => r.type === "hy.extract" && r.chunkId === record.chunkId)) return;
						state.ledger.push(record);
						state.pendingExtract = {
							chunkId: record.chunkId,
							coversUpToId: String(record.coversUpToId),
							drafts: record.drafts,
							rejected: [],
							usage: record.usage,
							refs: chunk.refs,
						};
						writePendingExtract(state.pendingExtract);
						mirror();
						audit("extract_persisted", {
							sessionId,
							chunkId: record.chunkId,
							drafts: record.drafts.length,
						});
						if (!config.dryRun) {
							try {
								pi.appendEntry(record.type, record);
							} catch {
								/* best effort; the mirror has it */
							}
						}
					},
				});
				const live = state && state.sessionId === sessionId ? state : null;
				if (!live) return;

				// The extract record was appended by onExtract; push only what is new.
				for (const record of result.records) {
					if (
						record.type === "hy.extract" &&
						live.ledger.some((r) => r.type === "hy.extract" && r.chunkId === record.chunkId)
					)
						continue;
					live.ledger.push(record);
				}
				live.cursorId = result.records.at(-1)?.coversUpToId ?? live.cursorId;
				live.resumeFromId = undefined;
				live.coverageDriftAudited = false;
				lastAttemptFailed = false;
				live.consecutiveFailures = 0;
				live.writeCooldownUntil = 0;
				live.cooldownAudited = false;
				live.failures = 0;
				// Only a primary answer clears the cooldown: a fallback-only write never
				// tested the primary, and treating it as recovery made every write pay
				// another timeout (see src/failover.ts).
				const failoverState = nextFailoverState({
					primaryDownUntil: state?.primaryDownUntil ?? 0,
					cooldownMs: Math.max(0, (config.fallbackCooldownS ?? 300) * 1000),
					now: Date.now(),
					result,
				});
				live.primaryDownUntil = failoverState.primaryDownUntil;
				if (failoverState.event) {
					audit(failoverState.event, {
						sessionId,
						chunkId,
						reason: result.failover,
						endpoints: result.endpoints,
						models: result.models,
						primaryDownUntil: failoverState.primaryDownUntil
							? new Date(failoverState.primaryDownUntil).toISOString()
							: null,
					});
				}
				live.pendingExtract = null;
				writePendingExtract(null);
				live.stats.writes++;
				live.stats.drafts += result.drafts.length;
				live.stats.added += result.report.added.length;
				live.stats.updated += result.report.updated.length;
				live.stats.deleted += result.report.deleted.length;
				live.stats.rejectedOps += result.rejectedOps.length;
				live.stats.downgraded += result.downgraded.length;
				live.stats.inTokens += result.usage.extract.inTokens + result.usage.reconcile.inTokens;
				live.stats.outTokens += result.usage.extract.outTokens + result.usage.reconcile.outTokens;
				live.stats.wallS += (Date.now() - started) / 1000;
				// The ETA model's history: one entry per write that landed, bounded. A failure
				// records nothing, so a timeout never teaches the next compaction to wait.
				live.timings = [
					...live.timings,
					{
						chunkId,
						extractMs: Math.round(result.usage.extract.wallS * 1000),
						reconcileMs: Math.round(result.usage.reconcile.wallS * 1000),
					},
				].slice(-TIMING_WINDOW);
				live.inFlightWrite = null;

				// Mirror first: it works even when the session is already closed.
				// Session entries are then best-effort, because a ctx captured before
				// a session replacement throws on appendEntry.
				mirror();
				if (!config.dryRun) {
					for (const record of result.records) {
						try {
							pi.appendEntry(record.type, record);
						} catch (error) {
							audit("append_failed", {
								sessionId,
								chunkId,
								record: record.type,
								error: String((error as Error)?.message ?? error).slice(0, 200),
							});
							break;
						}
					}
				}
				audit("write_end", {
					sessionId,
					chunkId,
					dryRun: config.dryRun,
					drafts: result.drafts.length,
					added: result.report.added.length,
					updated: result.report.updated.length,
					deleted: result.report.deleted.length,
					omitted: result.report.omitted,
					skipped: result.report.skipped.length,
					rejectedDrafts: result.rejectedDrafts.length,
					rejectedOps: result.rejectedOps.length,
					downgraded: result.downgraded.length,
					inTokens: result.usage.extract.inTokens + result.usage.reconcile.inTokens,
					outTokens: result.usage.extract.outTokens + result.usage.reconcile.outTokens,
					wallS: (Date.now() - started) / 1000,
					endpoints: result.endpoints,
					models: result.models,
					budgetDropped: result.budgetDropped.length,
					// A malformed completion that `repairJson` had to fix. Counted rather than
					// hidden: if it climbs, the prompt or the model changed.
					repaired: result.repaired.extract || result.repaired.reconcile ? result.repaired : undefined,
					jsonRetried:
						result.retriedJson.extract || result.retriedJson.reconcile ? result.retriedJson : undefined,
					budgetDroppedIds: result.budgetDropped.slice(0, 5).map((e) => e.id),
					failover: result.failover ? result.failover.slice(0, 120) : undefined,
					active: live.bank.filter((e) => e.status === "active").length,
				});
				pushStatus();
				status.done(
					result.report.added.length,
					result.report.updated.length,
					result.failover ? "fallback" : undefined,
				);
				try {
					if (ctx.hasUI && !config.dryRun) {
						ctx.ui.notify(
							`pi-hy-memory: +${result.report.added.length} ~${result.report.updated.length} -${result.report.deleted.length} facts (${live.bank.filter((e) => e.status === "active").length} active)`,
							"info",
						);
					}
				} catch {
					/* ctx is stale; the audit line is the record */
				}
			} catch (error) {
				lastAttemptFailed = true;
				const kind = failureClass(error);
				if (state && state.sessionId === sessionId) {
					state.consecutiveFailures += 1;
					const waitMs = writeCooldownMs(state.consecutiveFailures, (config.writeCooldownS ?? 30) * 1000);
					state.writeCooldownUntil = Date.now() + waitMs;
					state.cooldownAudited = false;
					// Nothing to wait for any more: a failed write leaves no timing behind, so the
					// next compaction estimates from the writes that did land.
					state.inFlightWrite = null;
					audit("write_cooldown", {
						sessionId,
						failures: state.consecutiveFailures,
						failureClass: kind,
						waitS: Math.round(waitMs / 1000),
					});
				}
				// Only a chunk or output failure says anything about chunk size. An
				// endpoint failure (transport, 5xx, 429) resets the shrink instead of
				// halving the budget for a problem the chunk did not cause.
				if (state && state.sessionId === sessionId) {
					state.failures = shrinksChunk(kind) ? state.failures + 1 : 0;
				}
				const resumed = Boolean(state?.pendingExtract);
				status.failed(String((error as Error)?.message ?? error));
				warn(ctx, `write failed: ${String((error as Error)?.message ?? error)}`);
				audit("write_error", {
					sessionId,
					chunkId,
					resumedExtract: resumed,
					failureClass: kind,
					failures: state?.failures ?? 0,
					nextChunkBudget: chunkBudget(),
					error: String((error as Error)?.message ?? error).slice(0, 400),
				});
			}
		})();
	};

	/**
	 * A finished write does not necessarily leave the window under the trigger: the
	 * next `turn_end` may be minutes away (measured: ten, with the footer bar
	 * saturated). So the completion path re-evaluates once, under the narrow policy
	 * in src/chain.ts.
	 */
	const maybeChainWrite = (ctx: ExtensionContext, sessionId: string): void => {
		if (!state) return;
		const live = state;
		let branch: SessionEntry[];
		let liveSession: string;
		try {
			branch = ctx.sessionManager.getBranch();
			liveSession = ctx.sessionManager.getSessionId();
		} catch {
			return; // session replaced; the next turn_end re-reads it
		}
		const window = coverageWindow(branch, live.ledger, live.cursorId, live.resumeFromId);
		const { pending, tokens } = window;
		const chunk = serializeEntries(pending, { maxTokens: chunkBudget(), maxEntryChars: config.maxEntryChars });
		const decision = shouldChainWrite({
			enabled: sessionActive(),
			sessionMatches: liveSession === sessionId && liveSession === live.sessionId,
			inFlight: live.pending !== null,
			pendingExtract: live.pendingExtract !== null,
			failures: live.failures,
			lastFailed: lastAttemptFailed,
			chained,
			pendingTokens: tokens,
			triggerTokens: config.observeAfterTokens,
			entryCount: chunk.entryCount,
		});
		if (!decision.chain) {
			if (decision.reason !== "under trigger" && decision.reason !== "chain limit") {
				audit("chain_skipped", { sessionId, reason: decision.reason, pendingTokens: tokens, chained });
			}
			return;
		}
		const chunkId = nextChunkId(live.sessionId, live.ledger, () => ++live.chunkSeq);
		chained++;
		audit("write_chained", {
			sessionId,
			chunkId,
			chunkTokens: estimateTokens(chunk.text),
			droppedEntries: chunk.droppedEntries,
			pendingTokens: tokens,
			chained,
		});
		startWrite(ctx, chunk, chunkId, sessionId);
	};

	const startWrite = (ctx: ExtensionContext, chunk: ChunkBuild, chunkId: string, sessionId: string): void => {
		if (!state) return;
		const promise = runWrite(ctx, chunk, chunkId, sessionId).finally(() => {
			if (!state) return;
			state.pending = null;
			// A flush occupies the queue until its write lands; a chained follow-up does not.
			if (flushChunks.delete(chunkId)) flushQueued = Math.max(0, flushQueued - 1);
			maybeChainWrite(ctx, sessionId);
		});
		state.pending = promise;
	};

	/**
	 * Idle drain. `turn_end` is the only place a write is normally started, so a
	 * session that is open but unused keeps its backlog indefinitely: measured on
	 * session 01a15860 (2026-10-20), reloaded with 352 000 tokens unread and
	 * `writes: 0` afterwards because no turn ran. While the session is quiet and the
	 * window is far larger than the trigger, start one write per tick and let the
	 * chain rule decide whether to follow it.
	 */
	const markActivity = (ctx: ExtensionContext): void => {
		lastActivityAt = Date.now();
		liveCtx = ctx;
	};

	const stopIdleTimer = (): void => {
		if (!idleTimer) return;
		clearInterval(idleTimer);
		idleTimer = null;
	};

	const idleDrainTick = (): void => {
		const live = state;
		const ctx = liveCtx;
		if (!live || !ctx) return;
		let branch: SessionEntry[];
		let sessionId: string;
		try {
			branch = ctx.sessionManager.getBranch();
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			return; // session replaced mid-tick; the next tick or a turn re-reads it
		}
		if (sessionId !== live.sessionId) return;
		const window = coverageWindow(branch, live.ledger, live.cursorId, live.resumeFromId);
		const idleMs = Date.now() - lastActivityAt;
		const decision = shouldIdleDrain({
			enabled: config.enabled,
			sessionActive: sessionActive(),
			idleMs,
			idleAfterMs: config.idleDrainAfterMs ?? 0,
			inFlight: live.pending !== null,
			pendingExtract: live.pendingExtract !== null,
			failures: live.consecutiveFailures,
			primaryDown: live.primaryDownUntil > Date.now(),
			coolingDown: live.writeCooldownUntil > Date.now(),
			pendingTokens: window.tokens,
			triggerTokens: config.observeAfterTokens,
			entryCount: window.pending.length,
		});
		if (!decision.drain) return;
		const chunk = serializeEntries(window.pending, {
			maxTokens: chunkBudget(),
			maxEntryChars: config.maxEntryChars,
		});
		if (chunk.entryCount === 0) return;
		const chunkId = nextChunkId(live.sessionId, live.ledger, () => ++live.chunkSeq);
		chained = 0;
		lastAttemptFailed = false;
		audit("idle_drain", {
			sessionId,
			chunkId,
			pendingTokens: window.tokens,
			idleMs,
			thresholdTokens: config.observeAfterTokens * IDLE_DRAIN_TRIGGER_FACTOR,
		});
		status.stage("extract", "idle drain");
		startWrite(ctx, chunk, chunkId, sessionId);
	};

	const startIdleTimer = (): void => {
		stopIdleTimer();
		const after = config.idleDrainAfterMs ?? 0;
		if (after <= 0) return;
		// Ticked more often than the threshold so "quiet for three minutes" is noticed
		// within a minute rather than at the end of the next interval. The 1 s floor is
		// what lets a check drive the timer at all.
		const timer = setInterval(idleDrainTick, Math.max(1_000, Math.min(after, 60_000)));
		timer.unref();
		idleTimer = timer;
	};

	pi.on("turn_end", (_event, ctx) => {
		chained = 0;
		lastAttemptFailed = false;
		markActivity(ctx);
		if (!sessionActive()) return;
		if (!state) {
			try {
				reset(ctx);
			} catch {
				return;
			}
		}
		if (!state || state.pending) return;

		let branch: SessionEntry[];
		let sessionId: string;
		try {
			branch = ctx.sessionManager.getBranch();
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			return; // session replaced mid-turn; the next turn_end re-reads it
		}
		if (sessionId !== state.sessionId) {
			reset(ctx);
			return;
		}

		const live = state;

		// A paid-for extract is waiting for its reconcile: retry that first, with the
		// same chunk id and refs, and without serializing anything new.
		if (live.pendingExtract) {
			const saved = live.pendingExtract;
			const chunk: ChunkBuild = {
				text: "",
				refs: saved.refs,
				entryCount: saved.refs.length,
				droppedEntries: 0,
				chars: 0,
			};
			startWrite(ctx, chunk, saved.chunkId, sessionId);
			return;
		}

		if (live.writeCooldownUntil > Date.now()) {
			if (!live.cooldownAudited) {
				live.cooldownAudited = true;
				audit("write_deferred", {
					sessionId,
					until: new Date(live.writeCooldownUntil).toISOString(),
					consecutiveFailures: live.consecutiveFailures,
				});
			}
			return;
		}

		const window = coverageWindow(branch, live.ledger, live.cursorId, live.resumeFromId);
		const { pending, tokens } = window;
		if (window.drift && !live.coverageDriftAudited) {
			live.coverageDriftAudited = true;
			live.cursorId = window.drift.to;
			audit("coverage_drift", {
				sessionId,
				from: window.drift.from,
				to: window.drift.to,
				entries: pending.length,
				tokens,
			});
		}
		if (pending.length === 0 || tokens < config.observeAfterTokens) return;

		const chunk = serializeEntries(pending, { maxTokens: chunkBudget(), maxEntryChars: config.maxEntryChars });
		if (chunk.entryCount === 0) return;

		const chunkId = nextChunkId(live.sessionId, live.ledger, () => ++live.chunkSeq);
		startWrite(ctx, chunk, chunkId, sessionId);
	});

	/**
	 * agent_before_settle is the last boundary where entries can still be appended.
	 * A write that outlives the run would otherwise wake up on a stale ctx and keep
	 * only its mirror file, so pi waits for it here unless that is disabled.
	 */
	pi.on("agent_before_settle", async (_event, ctx) => {
		markActivity(ctx);
		if (!config.waitForWriteOnSettle || !state?.pending) return undefined;
		void ctx;
		try {
			await state.pending;
		} catch {
			/* already audited by runWrite */
		}
		return undefined;
	});

	/**
	 * Compaction without a model call: the expensive part already happened while
	 * the session ran. If the bank is empty, return nothing and let pi compact as
	 * it normally would.
	 */
	pi.on("session_before_compact", async (event, ctx) => {
		if (!config.enabled || !state) return undefined;
		let active = state.bank.filter((e) => e.status === "active");
		if (active.length === 0) return undefined;

		// The branch pi is cutting. A wait appends entries to it, so every number downstream comes
		// from a snapshot taken after the write lands — never from this one.
		let entries = event.branchEntries;
		const branchEndAtEvent = entries.at(-1)?.id;
		const preparationTokens = event.preparation?.tokensBefore;

		/**
		 * The window split and the cut, for a branch snapshot.
		 *
		 * It runs twice when a write lands during the wait: the cursor moves and the write's own
		 * `hy.extract` / `hy.ops` entries are appended, so the boundary that ends the hook has to be
		 * computed from fresh data. Only pi's cut point survives a wait, because it names an entry
		 * rather than a token count.
		 */
		const boundaryFor = (list: SessionEntry[]) => {
			// What the next request can actually hold. The window is a hard limit, and a compaction
			// that leaves the request oversized is not a recovery — it is the 400 the provider
			// answers with. So the window is split between the three things the retry sends: the kept
			// tail, the summary, and the digest of whatever the cut removes that the writer never
			// read. `budgetSplit` decides the shares; `keepRecentShare` and `keepRecentTokens` are
			// the tail's ask and its ceiling, and the backward walk stops at the figure the split
			// produced.
			const windowTokens = ctx.model?.contextWindow ?? 0;
			const reserve = event.preparation?.settings?.reserveTokens ?? 0;
			const branchTokens = list.reduce((sum, e) => sum + entryTokens(e), 0);
			// The overhead the budget has to absorb is measured, not assumed. Pi's count covers the
			// whole request — system prompt, tool schemas, everything this extension does not render —
			// while `entryTokens` covers only the conversation, so the difference is what the retry
			// will carry on top of the summary and the tail. A session with a large prompt and many
			// tools needs a far bigger allowance than one with none, and guessing too small makes the
			// compaction miss the threshold it was supposed to clear: pi compacts again, and again.
			// `COMPACT_OVERHEAD_TOKENS` stays as the floor for a session pi has not counted. Only part
			// of that gap is prompt: pi counts with a real tokenizer and this file estimates with
			// characters, so a long conversation inflates the difference by counting alone. A third of
			// the window is treated as the most prompt and schemas can plausibly cost, which keeps a
			// large session from trimming its working set away. Pi's count is only a valid overhead
			// while the branch it counted is still the branch being cut; after a wait the branch has
			// grown, and then the floor is what stands.
			const measured =
				preparationTokens === undefined || list.at(-1)?.id !== branchEndAtEvent
					? 0
					: preparationTokens - branchTokens;
			const overheadTokens = Math.max(
				COMPACT_OVERHEAD_TOKENS,
				Math.min(measured, Math.floor(windowTokens * 0.3)),
			);
			// Ask first, then reserve: probe the cut with no digest room, price what it would
			// actually drop, and only then spend room on the digest. A compaction that trims
			// nothing pays nothing for it.
			const resolved = resolveBudget({
				base: {
					windowTokens,
					reserveTokens: reserve,
					overheadTokens,
					keepRecentTokens: config.keepRecentTokens,
					keepRecentShare: config.keepRecentShare,
					summaryMaxTokens: config.summaryMaxTokens,
					overflowDigestTokens: config.overflowDigestTokens,
				},
				entries: list,
				cursorId: state?.cursorId,
				proposedId: event.preparation?.firstKeptEntryId,
				maxUncoveredTokens: config.maxChunkTokens,
			});
			// pi's own cut point and its real token count: the boundary is only worth keeping if
			// holding the backlog does not defeat the compaction entirely.
			return {
				branchTokens,
				windowTokens,
				overheadTokens,
				...resolved,
			};
		};
		type Boundary = ReturnType<typeof boundaryFor>;
		let boundary = boundaryFor(entries);

		/**
		 * Await the in-flight write and its chained follow-ups inside one shared deadline.
		 *
		 * The budget is shared rather than per write: the write that was already running plus up to
		 * `MAX_CHAIN` follow-ups (`src/chain.ts`) ride the same `compactWaitMs`, so a large backlog
		 * cannot pin compaction for chain length × budget.
		 */
		const waitForWrite = async (
			signal: AbortSignal,
			deadline: number,
		): Promise<{ landed: number; outcome: "landed" | "timeout" | "aborted" | "writer_failed" }> => {
			let landed = 0;
			let onAbort: (() => void) | undefined;
			const abortPromise = new Promise<"aborted">((resolve) => {
				onAbort = () => resolve("aborted");
				signal.addEventListener("abort", onAbort, { once: true });
			});
			try {
				for (;;) {
					if (signal.aborted) return { landed, outcome: "aborted" };
					const live = state;
					if (!live) return { landed, outcome: "writer_failed" };
					const promise = live.pending;
					if (!promise) {
						// The write landed. Give a chained follow-up one beat to be assigned — it is
						// started inside this write's own `finally`, so it can appear just after.
						await sleep(WAIT_GRACE_MS);
						if (!state?.pending) return { landed, outcome: "landed" };
						if (Date.now() >= deadline) return { landed, outcome: "timeout" };
						continue;
					}
					const remaining = deadline - Date.now();
					if (remaining <= 0) return { landed, outcome: "timeout" };
					const settled: Promise<"landed" | "writer_failed" | "slice" | "aborted"> = promise.then(
						() => "landed",
						// A failed write is a reason to stop waiting, not to retry: the deferral and
						// the cooldown are already the right response.
						() => "writer_failed",
					);
					const why = await Promise.race([
						settled,
						sleep(Math.min(WAIT_POLL_MS, remaining)).then(() => "slice"),
						abortPromise,
					]);
					if (why === "aborted") return { landed, outcome: "aborted" };
					if (why === "writer_failed") return { landed, outcome: "writer_failed" };
					if (why === "landed") landed++;
				}
			} finally {
				// The listener sits on pi's signal, which outlives this hook.
				if (onAbort) signal.removeEventListener("abort", onAbort);
			}
		};

		/**
		 * Ask the policy, wait when it says yes, then recompute from a fresh branch.
		 *
		 * Never throws, and always returns a boundary the hook can act on: a throwing hook fails
		 * pi's compaction outright, which is worse than the deferral this replaces.
		 */
		const waitBeforeCompact = async (before: Boundary): Promise<Boundary> => {
			const live = state;
			if (!live) return before;
			const cursorBefore = live.cursorId;
			const window = coverageWindow(entries, live.ledger, live.cursorId, live.resumeFromId);
			const decision = decideCompactionWait({
				enabled: config.waitForWriterBeforeCompact,
				dryRun: config.dryRun,
				sessionActive: sessionActive(),
				reason: event.reason,
				wouldDrop: true,
				inFlight: live.inFlightWrite,
				timings: live.timings,
				// A writer that has failed, is cooling down, or has its primary held down is not
				// worth holding a compaction for.
				healthy: writerHealthy(live),
				entries: unreadContent(window.pending),
				tokens: window.tokens,
				maxChunkTokens: config.maxChunkTokens,
				budgetMs: config.compactWaitMs,
				now: Date.now(),
			});
			if (!decision.wait) {
				// Audited only for the shapes that could have waited, so a skip is visible without a
				// line for every compaction that never had a write to wait for.
				if (live.inFlightWrite) {
					audit("compact_wait_skipped", {
						sessionId: live.sessionId,
						reason: decision.reason,
						stage: decision.stage,
						entries: decision.entries,
						tokens: decision.tokens,
						chunksBehind: decision.chunksBehind,
						etaS: decision.etaS,
					});
				}
				return before;
			}

			const budgetMs = config.compactWaitMs;
			const startedAt = Date.now();
			try {
				ctx.ui.notify(
					`pi-hy-memory: writer ${decision.entries} entries behind (~${decision.tokens} tok), ${decision.stage} ${decision.elapsedS}s in, ~${decision.etaS}s left — waiting up to ${Math.round(budgetMs / 1000)}s before compacting`,
					"info",
				);
			} catch {
				/* ctx is stale; the audit line is the record */
			}
			try {
				status.stage("waiting", "compact");
			} catch {
				/* the footer is optional */
			}
			const wait = await waitForWrite(event.signal, startedAt + budgetMs);

			// Recompute, never reuse: the write appended its records and moved the cursor while we
			// waited, so the pre-wait choice, boundary and token sums are stale.
			let fresh = entries;
			try {
				fresh = ctx.sessionManager.getBranch();
			} catch {
				/* session replaced; pi's own snapshot is the best branch left */
			}
			entries = fresh;
			const after = boundaryFor(fresh);
			const outcome =
				wait.outcome === "timeout"
					? "timeout"
					: wait.outcome === "aborted"
						? "aborted"
						: wait.outcome === "writer_failed"
							? "writer_failed"
							: after.choice.wouldDrop
								? "still_would_drop"
								: "boundary_recomputed";
			audit("compact_wait", {
				sessionId: live.sessionId,
				reason: event.reason,
				stage: decision.stage,
				entries: decision.entries,
				tokens: decision.tokens,
				chunksBehind: decision.chunksBehind,
				elapsedS: decision.elapsedS,
				etaS: decision.etaS,
				budgetMs,
				waitedMs: Date.now() - startedAt,
				cursorAdvanced: (state?.cursorId ?? undefined) !== cursorBefore,
				/** Follow-ups waited on beyond the write that was running when compaction started. */
				chainDepth: Math.max(0, wait.landed - 1),
				unreadAfterTokens: after.choice.wouldDrop?.tokens ?? 0,
				outcome,
				deferred: after.choice.wouldDrop !== undefined,
			});
			return after;
		};

		// Hand back to pi when honouring our summary would drop entries the writer has
		// never read. Our boundary can only *keep* a bounded backlog, and the entries
		// past that bound are gone from the live context for good; pi's own summariser
		// compresses them into prose instead, which is what would happen without this
		// extension. Measured on session 01a1510e (2026-10-19): a 36-minute writer
		// outage left 477 unread entries, the boundary took pi's cut, and 53 459 tokens
		// of history were dropped unread — exactly what a fallback would have saved.
		//
		// Not on overflow. pi's summariser has to send the whole conversation to compress it, and
		// overflow is precisely the state where that request cannot fit: session 01a15d4e (2026-10-21)
		// deferred twice at 375 464 tokens against a 196 608-token window, got 400 "request exceeds the
		// context window" both times, and the session was left unrecoverable. Here the trim above has
		// already cut the tail to fit and the unread range it removed is digested into the summary, so
		// producing our own summary degrades the session instead of ending it.
		//
		// Before handing it back, one bounded wait: pi runs its compaction check before
		// `agent_before_settle`, so the backlog it would drop is very often a write that is seconds
		// from landing. The policy and the ETA model are in `src/lag.ts`.
		if (boundary.choice.wouldDrop && event.reason !== "overflow") boundary = await waitBeforeCompact(boundary);
		// A write that landed during the wait also added facts to the bank.
		active = state.bank.filter((e) => e.status === "active");

		if (boundary.choice.wouldDrop && event.reason !== "overflow") {
			audit("compact_deferred", {
				sessionId: state.sessionId,
				reason: event.reason,
				entries: boundary.choice.wouldDrop.entries,
				tokens: boundary.choice.wouldDrop.tokens,
				facts: active.length,
			});
			// The deferral has to be visible: without it a `/compact` that pi did on its own
			// reads as an extension that is not loaded at all, which is how this session's
			// eleven deferrals were reported (2026-10-27, session 01a17310).
			try {
				ctx.ui.notify(
					`pi-hy-memory: compaction handed to pi — ${boundary.choice.wouldDrop.entries} entries ` +
						`(~${boundary.choice.wouldDrop.tokens} tok) the writer has not read yet; pi's ` +
						`summariser keeps them, the bank holds ${active.length} facts. /hy status shows the backlog.`,
					"info",
				);
			} catch {
				/* ctx is stale; the audit line is the record */
			}
			return undefined;
		}

		// Everything downstream is read from the boundary that survived the wait, so the numbers
		// reported are the ones the cut was actually made with.
		const { choice, split, unread, lookupMissed, passes, converged, overheadTokens, windowTokens } = boundary;
		const digestBudget = split.digestTokens;
		const summaryTokenBudget = split.summaryTokenBudget;
		const maxKeepTokens = split.tailTokens;
		const available = split.available;
		const firstKeptIndex = choice.firstKeptIndex;

		// The trim cut past the writer's watermark, so material the bank never learned is leaving the
		// live context. Two things record that: a bounded digest of the unread range inside the
		// summary, and a gap in the ledger so coverage resumes at the first kept entry rather than
		// claiming the dropped range as written. `maxEntryChars` caps each entry before any token
		// counting, because a single 100 k-token tool result must not eat the budget the trim just
		// carved out, and neither the digest nor the gap reaches the fact bank.
		let digest = "";
		let digestEntries = 0;
		if (choice.trimmed) {
			digestEntries = unread.length;
			if (unread.length > 0) {
				const unreadTokens = unread.reduce((sum, e) => sum + entryTokens(e), 0);
				if (digestBudget > 0) {
					const rendered = serializeEntries(unread, {
						maxTokens: digestBudget,
						maxEntryChars: DIGEST_ENTRY_CHARS,
					});
					// The header counts the range; the text holds only what fit. Saying "N entries"
					// over a shorter list would be the one lie this digest exists to prevent.
					const clipped = rendered.droppedEntries > 0 ? ` (${rendered.droppedEntries} not shown)` : "";
					digest = `\n\nDropped to fit the context window — ${unread.length} entries, ~${unreadTokens} tokens${clipped}, never written to the fact bank:\n${rendered.text}`;
				}
				state.ledger.push({
					type: "hy.gap",
					coversUpToId: state.cursorId ?? entries[firstKeptIndex].id,
					fromId: entries[firstKeptIndex].id,
					entries: unread.length,
					tokens: unreadTokens,
					reason: "overflow-trim",
					createdAt: new Date().toISOString(),
				});
				// Coverage restarts at the first kept entry: the old watermark is gone from the branch,
				// and the ledger records past it must not drag the window back over the dropped range.
				state.cursorId = undefined;
				state.resumeFromId = entries[firstKeptIndex].id;
			}
			audit("compact_trimmed", {
				sessionId: state.sessionId,
				reason: event.reason,
				boundary: choice.boundary,
				trimmedEntries: choice.trimmed.entries,
				trimmedTokens: choice.trimmed.tokens,
				keptTokens: choice.used,
				windowTokens,
				overheadTokens,
				availableTokens: split.available,
				maxKeepTokens,
				digestEntries,
				digestTokens: digest ? estimateTokens(digest) : 0,
				/** The reservation settled by probing the cut, not by a constant. */
				digestBudget,
				summaryTokens: summaryTokenBudget,
				probePasses: passes,
				probeConverged: converged,
				/** The watermark or trim id was not found in this branch; coverage unknown. */
				coverageLookupMissed: lookupMissed,
				underprovisioned: split.underprovisioned,
			});
		}

		// File operations are deterministic and free (pi computes the same lists for its
		// own summaries), and they orient a reader faster than prose about them. Their
		// cost comes out of the summary budget rather than being added on top.
		const files = fileOperations(entries);
		const fileBlock = renderFileOperations(files);
		const fileTokens = fileBlock ? estimateTokens(fileBlock) + 4 : 0;
		const rendered = renderMemory(
			state.bank,
			// Never above the share of the window this compaction is allowed to take.
			Math.max(
				500,
				summaryBudget(Math.min(config.summaryMaxTokens, summaryTokenBudget), state.bank) - fileTokens,
			),
			selection(state.bank),
		);
		// The deterministic render is both the default and the fallback: hi-fi is an
		// upgrade attempt, never a dependency.
		const fallback = fileBlock ? `${rendered}\n\n${fileBlock}` : rendered;
		if (!fallback.trim()) return undefined;

		/**
		 * Hi-fi: ask the executor's own model for a checkpoint (goal, constraints,
		 * progress, next steps) built from the bank delta plus the kept tail. Opt-in,
		 * because it puts a model call at the slowest moment in the session; it is the
		 * same cost class as vanilla pi, which makes such a call anyway.
		 *
		 * The writer model is never used here even if it is configured: the writer may
		 * not grade its own output, and a summary is grading.
		 */
		let checkpoint: { text: string; idsKept: number; idsGiven: number; ms: number; usage?: unknown } | undefined;
		// A checkpoint is added to the summary, so it competes for the same share of the window.
		const hifiBudget =
			available === undefined ? config.hifiMaxTokens : Math.min(config.hifiMaxTokens, summaryTokenBudget);
		if (config.hifiCompaction && ctx.model) {
			const facts = hifiFacts(state.bank, {
				lastSeq: state.hifi?.seq ?? 0,
				previous: state.hifi?.text,
				attempts: state.hifi?.attempts,
				retryLimit: config.hifiRetryLimit,
				maxTokens: config.hifiDeltaTokens,
				estimate: estimateTokens,
				selection: {
					foundationAfterChunks: config.foundationAfterChunks,
					constraintShare: config.summaryConstraintShare,
					foundationShare: config.summaryFoundationShare,
				},
			});
			// The tail is read for orientation, so it is the *newest* entries that fit
			// the budget — serializeEntries alone would keep the oldest of the range.
			const tail = serializeEntries(selectTail(entries.slice(firstKeptIndex), config.hifiTailTokens), {
				maxTokens: config.hifiTailTokens,
				maxEntryChars: config.maxEntryChars,
			});
			const started = Date.now();
			try {
				// pi resolves auth for its own summarizer; an extension has to ask for
				// the same resolution or a model keyed from the provider config fails
				// at the provider with "No API key for provider".
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
				if (!auth.ok) throw new Error(`hi-fi auth: ${auth.error}`);
				const answer = await hifiSummary({
					model: ctx.model,
					apiKey: auth.apiKey,
					headers: auth.headers,
					prompt: buildHifiPrompt({
						previous: state.hifi?.text,
						facts,
						tail: tail.text,
						files,
						budgetTokens: hifiBudget,
					}),
					maxTokens: hifiBudget,
					timeoutMs: config.hifiTimeoutMs,
					// Not the session's level by default: reasoning and the answer share one
					// output budget, and a model that thinks at a checkpoint can spend it
					// without producing one.
					reasoning: hifiReasoning(config.hifiThinkingLevel, ctx.thinkingLevel),
					signal: event.signal,
				});
				const verdict = checkHifi(answer.text, facts, answer.stopReason === "length", {
					outputTokens: answer.usage?.output ?? 0,
				});
				if (verdict.ok) {
					checkpoint = {
						text: answer.text,
						idsKept: verdict.idsKept,
						idsGiven: verdict.idsGiven,
						ms: answer.ms,
						usage: answer.usage,
					};
					state.hifi = {
						text: answer.text,
						seq: state.chunkSeq,
						at: new Date().toISOString(),
						// Only an accepted checkpoint updates the attempt counts. A rejected one
						// never judged these facts, so they keep their remaining retries.
						attempts: recordOffers(state.hifi?.attempts, facts, answer.text),
					};
					audit("hifi_ok", {
						sessionId: state.sessionId,
						reason: event.reason,
						model: `${ctx.model.provider}/${ctx.model.id}`,
						factsSent: verdict.idsGiven,
						idsKept: verdict.idsKept,
						tokens: estimateTokens(answer.text),
						outTokens: answer.usage?.output ?? 0,
						ms: answer.ms,
					});
				} else {
					audit("hifi_rejected", {
						sessionId: state.sessionId,
						reason: event.reason,
						why: verdict.reason,
						stopReason: answer.stopReason,
						factsSent: verdict.idsGiven,
						idsKept: verdict.idsKept,
						ms: answer.ms,
					});
				}
			} catch (error) {
				audit("hifi_failed", {
					sessionId: state.sessionId,
					reason: event.reason,
					error: error instanceof Error ? error.message : String(error),
					ms: Date.now() - started,
				});
			}
		}

		// The checkpoint is the model's prose; the reminder that its ids are lookupable is
		// ours to add, because a good checkpoint will not have written it itself.
		const summary = (checkpoint ? withRecallNote(checkpoint.text) : fallback) + digest;
		// Prefer pi's count: ours renders unclipped text, which is the stored branch rather than
		// the request pi builds. That count only describes the branch we cut, so after a wait that
		// appended entries the estimate is what is honest.
		const estimate = boundary.branchTokens;
		const tokensBefore =
			preparationTokens !== undefined && entries.at(-1)?.id === branchEndAtEvent ? preparationTokens : estimate;
		state.stats.compactions++;
		audit("compact", {
			sessionId: state.sessionId,
			reason: event.reason,
			facts: active.length,
			tokensBefore,
			tokensBeforeEstimate: estimate,
			keptEntries: entries.length - firstKeptIndex,
			boundary: choice.boundary,
			summaryTokens: estimateTokens(summary),
			summaryKind: checkpoint ? "hifi" : "render",
			fileOps: { read: files.readFiles.length, modified: files.modifiedFiles.length },
			/**
			 * The split this compaction was actually made with. A compaction that trims nothing emits
			 * no `compact_trimmed`, and then the arithmetic behind the cut is invisible — which is the
			 * one thing a later reader needs to know about a tight window.
			 */
			overheadTokens,
			availableTokens: split.available,
			tailTokens: split.tailTokens,
			summaryTokenBudget,
			digestBudget,
			underprovisioned: split.underprovisioned,
		});
		mirror();
		void ctx;
		return {
			compaction: {
				summary,
				firstKeptEntryId: entries[firstKeptIndex]?.id ?? entries[entries.length - 1].id,
				tokensBefore,
				estimatedTokensAfter: estimateTokens(summary) + choice.used,
				usage: checkpoint?.usage as never,
				details: {
					hyMemory: true,
					facts: active.length,
					// Two different models, and a single "model" key here would misattribute
					// one to the other: the writer extracts facts into the bank, and the
					// checkpoint is always written by the model the session is running.
					writerModel: config.model,
					summaryModel: checkpoint && ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
					hifi: checkpoint
						? { idsKept: checkpoint.idsKept, idsGiven: checkpoint.idsGiven, ms: checkpoint.ms }
						: undefined,
					...files,
				},
			},
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopIdleTimer();
		if (!state) return;
		const sessionId = state.sessionId;
		try {
			void ctx;
			// A write against a slow peer can take minutes; do not hold the exit for
			// it. The extract is already durable and the mirror is written below, so
			// the next session resumes instead of losing work.
			if (state.pending) {
				const cap = config.shutdownWaitMs ?? 5000;
				await Promise.race([
					state.pending.catch(() => undefined),
					new Promise((resolve) => setTimeout(resolve, cap)),
				]);
			}
		} catch {
			/* stale ctx or an audited write failure */
		}
		status.detach();
		try {
			mirror();
			audit("session_shutdown", { sessionId, ...state.stats });
		} catch {
			/* nothing else to do */
		}
	});

	pi.registerTool({
		name: "hy_recall",
		label: "Hy recall",
		description:
			"Look up the session's durable fact bank. Query text searches every fact the store holds, current and retired, and marks a retired one with what dropped it; an entry id returns the fact plus the exact source entries it was written from.",
		promptSnippet: "Search the durable fact bank; id expands a fact with its source evidence.",
		promptGuidelines: [
			"Use hy_recall to check what this session already established, and to read the source entries behind a fact before acting on it.",
		],
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Text to search in active facts." })),
			id: Type.Optional(Type.String({ description: "Exact 12-character fact id to expand with its sources." })),
			limit: Type.Optional(Type.Number({ description: "Maximum facts to return. Default 12." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state)
				return {
					content: [{ type: "text", text: "pi-hy-memory: no bank for this session." }],
					details: undefined,
				};
			const active = state.bank.filter((e) => e.status === "active");

			if (params.id) {
				const wanted = params.id.toLowerCase();
				const entry = state.bank.find((e) => e.id === wanted);
				if (!entry)
					return { content: [{ type: "text", text: `No fact with id ${params.id}.` }], details: undefined };
				const sources: string[] = [];
				for (const sourceId of entry.sourceEntryIds) {
					let source: SessionEntry | undefined;
					try {
						source = ctx.sessionManager.getEntry(sourceId);
					} catch {
						source = undefined;
					}
					const rendered = source ? renderEntry(source, 2000) : undefined;
					sources.push(
						rendered ? `[${sourceId}] ${rendered}` : `[${sourceId}] (source no longer in this session)`,
					);
				}
				const status =
					entry.status === "active"
						? ""
						: ` (superseded by ${entry.supersededBy ?? "-"}: ${entry.supersedeReason ?? ""})`;
				return {
					content: [
						{
							type: "text",
							text: `[${entry.id}] (${entry.task}) ${entry.statement}${status}\n\nSource evidence:\n${sources.join("\n") || "none recorded"}`,
						},
					],
					details: entry,
				};
			}

			const query = String(params.query ?? "")
				.trim()
				.toLowerCase();
			const limit = Math.max(1, Math.min(50, params.limit ?? 12));
			const hits = recallHits(state.bank, query, limit);
			const retired = hits.filter((hit) => hit.superseded).length;
			if (hits.length === 0)
				return {
					content: [
						{
							type: "text",
							text: `No facts match ${JSON.stringify(query)}. The bank holds ${active.length} current and ${state.bank.length - active.length} retired facts; none matched.`,
						},
					],
					details: undefined,
				};
			return {
				content: [
					{
						type: "text",
						text:
							hits.map((hit) => renderRecallHit(hit)).join("\n") +
							(retired > 0
								? `\n\n${retired} of these are retired: a merge or the pool budget dropped them from the current bank. Read them with their id, and read the fact named there for the newer wording.`
								: ""),
					},
				],
				details: { hits: hits.length, active: active.length, retired },
			};
		},
	});

	/**
	 * `/hy on` discards the window accumulated while off. Otherwise a session that was
	 * off for hours pays for its whole backlog in a burst of chained writes — exactly
	 * the work the switch exists to avoid. Recorded as a gap so the ledger keeps
	 * saying what was never read.
	 */
	const skipWhileOff = (ctx: ExtensionContext, live: SessionState): { entries: number; tokens: number } | null => {
		let branch: SessionEntry[];
		try {
			branch = ctx.sessionManager.getBranch();
		} catch {
			return null;
		}
		const newest = branch.at(-1);
		if (!newest) return null;
		const { pending, tokens } = coverageWindow(branch, live.ledger, live.cursorId, live.resumeFromId);
		if (pending.length === 0) return null;
		const gap: LedgerRecord = {
			type: "hy.gap",
			coversUpToId: newest.id,
			fromId: newest.id,
			entries: pending.length,
			tokens,
			reason: "disabled",
			createdAt: new Date().toISOString(),
		};
		live.ledger.push(gap);
		live.cursorId = newest.id;
		live.resumeFromId = undefined;
		mirror();
		// Mirror first (it works even when the session is already closed), then the
		// session entry. Coverage is rebuilt from session records on reload and the
		// longer copy wins, so a gap that lives only in the mirror is discarded the
		// moment the session copy overtakes it.
		try {
			pi.appendEntry(gap.type, gap);
		} catch (error) {
			audit("append_failed", {
				sessionId: live.sessionId,
				record: gap.type,
				error: String((error as Error)?.message ?? error).slice(0, 200),
			});
		}
		audit("skipped_while_off", { sessionId: live.sessionId, entries: pending.length, tokens });
		return { entries: pending.length, tokens };
	};

	/**
	 * `hy_flush`: the session model names the range the writer should read.
	 *
	 * Two calls, deliberately. Bare lists the unwritten entries, because pi never
	 * shows the model entry ids and it cannot name a range it has not seen; `to`
	 * queues a write up to that ref. Queued rather than synchronous: extract is
	 * 28–52 s on a local writer and `timeoutMs` is 480 000, so a synchronous tool
	 * could stall a turn for eight minutes.
	 */
	// Off means no prompt surface at all: a tool the model is not allowed to use still
	// costs its description and its guidelines in every session's prompt.
	if (config.flushTool)
		pi.registerTool({
			name: "hy_flush",
			label: "Hy flush",
			description: FLUSH_DESCRIPTION,
			promptSnippet: FLUSH_SNIPPET,
			promptGuidelines: FLUSH_GUIDELINES,
			parameters: Type.Object({
				to: Type.Optional(Type.Number({ description: FLUSH_PARAM_TO })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const live = state;
				if (!live)
					return {
						content: [{ type: "text", text: "pi-hy-memory: no bank for this session yet." }],
						details: undefined,
					};
				markActivity(ctx);

				let branch: SessionEntry[];
				let sessionId: string;
				try {
					branch = ctx.sessionManager.getBranch();
					sessionId = ctx.sessionManager.getSessionId();
				} catch {
					return {
						content: [{ type: "text", text: "pi-hy-memory: the session changed; call hy_flush again." }],
						details: undefined,
					};
				}
				if (sessionId !== live.sessionId)
					return {
						content: [
							{ type: "text", text: "pi-hy-memory: this session was replaced; call hy_flush again." },
						],
						details: undefined,
					};

				const window = coverageWindow(branch, live.ledger, live.cursorId, live.resumeFromId);
				const rows = flushRows(window.pending);

				// No `to` is the listing, not a write.
				if (params.to === undefined || params.to === null)
					return {
						content: [
							{
								type: "text",
								text: renderUnwritten(
									rows,
									config.flushListEntries ?? 24,
									window.tokens,
									config.flushMinTokens,
								),
							},
						],
						details: { unwritten: rows.length, pendingTokens: window.tokens },
					};

				const range = unwrittenRange(rows, params.to);
				if (range.empty) {
					const why =
						range.empty === "no-entries"
							? "nothing is unwritten"
							: range.empty === "to-before-start"
								? `to=${params.to} is before the start of the window`
								: `to=${params.to} is not a number`;
					audit("flush_skipped", { sessionId, reason: range.empty, to: params.to, unwritten: rows.length });
					return {
						content: [{ type: "text", text: `hy_flush: ${why}. ${rows.length} entries unwritten.` }],
						details: undefined,
					};
				}

				const chunk = serializeEntries(rangeEntries(window.pending, rows, range), {
					maxTokens: chunkBudget(),
					maxEntryChars: config.maxEntryChars,
				});
				// The gated amount and the reported amount have to be the same number, or a refusal
				// names a figure the model cannot reconcile with the listing.
				const tokens = estimateTokens(chunk.text);
				const decision = shouldFlushWrite({
					sessionActive: sessionActive(),
					inFlight: live.pending !== null,
					pendingExtract: live.pendingExtract !== null,
					primaryDown: live.primaryDownUntil > Date.now(),
					coolingDown: live.writeCooldownUntil > Date.now(),
					entryCount: chunk.entryCount,
					pendingFlushes: flushQueued,
					writeTokens: tokens,
					minTokens: config.flushMinTokens,
				});
				if (!decision.flush) {
					audit("flush_skipped", {
						sessionId,
						reason: decision.reason,
						to: params.to,
						end: range.end,
						pendingTokens: window.tokens,
					});
					return {
						content: [
							{
								type: "text",
								text: flushRefusal(decision.reason, tokens, config.flushMinTokens),
							},
						],
						details: undefined,
					};
				}

				const chunkId = nextChunkId(live.sessionId, live.ledger, () => ++live.chunkSeq);
				flushChunks.add(chunkId);
				flushQueued++;
				chained = 0;
				lastAttemptFailed = false;
				audit("hy_flush", {
					sessionId,
					chunkId,
					requestedTo: params.to,
					applied: { from: range.start, to: range.end },
					clampedTo: range.clampedTo ?? null,
					entries: chunk.entryCount,
					droppedEntries: chunk.droppedEntries,
					chunkTokens: tokens,
					windowTokens: window.tokens,
					queued: flushQueued,
				});
				startWrite(ctx, chunk, chunkId, sessionId);
				return {
					content: [{ type: "text", text: flushQueuedText(range, chunk.entryCount, tokens, chunkId) }],
					details: { chunkId, entries: chunk.entryCount, tokens },
				};
			},
		});

	pi.registerCommand("hy", {
		description:
			"pi-hy-memory: [status] bank size and cost, [summary] the facts a compaction renders, [hifi] toggle the model-written checkpoint, [off] stop memory work for this session, [on] resume it",
		getArgumentCompletions: (prefix) =>
			[
				{ value: "status", label: "status", description: "bank size, cost so far, session switch" },
				{ value: "summary", label: "summary", description: "the facts a compaction would render" },
				{ value: "hifi", label: "hifi", description: "toggle the model-written compaction checkpoint" },
				{ value: "off", label: "off", description: "stop writing memory for this session (remembered)" },
				{ value: "on", label: "on", description: "resume; the window accumulated while off is discarded" },
			].filter((item) => item.value.startsWith(prefix.trim().toLowerCase())),
		handler: async (args, ctx) => {
			const arg = String(args ?? "")
				.trim()
				.toLowerCase();
			if (!state) {
				ctx.ui.notify("pi-hy-memory: no bank for this session.", "info");
				return;
			}
			const live = state;

			if (arg === "off" || arg === "disable") {
				if (!config.enabled) {
					ctx.ui.notify(
						"pi-hy-memory: already off for every session in the config (`enabled: false`).",
						"info",
					);
					return;
				}
				if (!live.enabled) {
					ctx.ui.notify("pi-hy-memory: already off for this session.", "info");
					return;
				}
				live.enabled = false;
				setSessionOff(live.sessionId, true);
				audit("disabled", {
					sessionId: live.sessionId,
					inFlight: live.pending !== null,
					active: live.bank.filter((e) => e.status === "active").length,
				});
				pushStatus();
				ctx.ui.notify(
					`pi-hy-memory: off for this session (remembered). No new writes; the ${live.bank.filter((e) => e.status === "active").length} facts already in the bank stay available to recall and compaction.` +
						(live.pending ? " The write already running will finish." : ""),
					"info",
				);
				return;
			}

			if (arg === "on" || arg === "enable") {
				if (!config.enabled) {
					ctx.ui.notify(
						"pi-hy-memory: the config disables it globally (`enabled: false`); edit the config to turn it on.",
						"warning",
					);
					return;
				}
				if (live.enabled) {
					ctx.ui.notify("pi-hy-memory: already on for this session.", "info");
					return;
				}
				const skipped = skipWhileOff(ctx, live);
				live.enabled = true;
				setSessionOff(live.sessionId, false);
				audit("enabled", {
					sessionId: live.sessionId,
					skippedEntries: skipped?.entries ?? 0,
					skippedTokens: skipped?.tokens ?? 0,
				});
				pushStatus();
				ctx.ui.notify(
					`pi-hy-memory: on. Writing resumes from now; ${skipped?.entries ?? 0} entries (${skipped?.tokens ?? 0} tokens) that accumulated while off are not remembered.`,
					"info",
				);
				return;
			}

			if (arg === "hifi") {
				config.hifiCompaction = !config.hifiCompaction;
				audit("hifi_toggled", {
					sessionId: live.sessionId,
					on: config.hifiCompaction,
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				});
				const last = live.hifi;
				ctx.ui.notify(
					`pi-hy-memory: hi-fi compaction ${config.hifiCompaction ? "on" : "off"} for this session. ` +
						(config.hifiCompaction
							? `The next compaction asks ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "the session model"} for a checkpoint and falls back to the render if it is unusable.${last ? ` Last checkpoint: ${estimateTokens(last.text)} tokens at ${last.at}.` : ""}`
							: `Compactions render the bank again.${last ? ` Last checkpoint (${estimateTokens(last.text)} tokens at ${last.at}) stays in context until the next compaction.` : ""}`),
					"info",
				);
				return;
			}

			const active = live.bank.filter((e) => e.status === "active");
			const tokens = active.reduce((sum, e) => sum + e.tokenCount, 0);
			if (arg === "summary") {
				ctx.ui.notify(
					renderMemory(live.bank, summaryBudget(config.summaryMaxTokens, live.bank), selection(live.bank)),
					"info",
				);
				return;
			}
			// What the writer has not read yet, and for a write in flight how far into it it is.
			// The ETA appears only when the compaction policy would actually wait on this write, so
			// the status line can never promise a wait the hook would not make.
			const lag = (): string => {
				let window: ReturnType<typeof coverageWindow> | null = null;
				try {
					window = coverageWindow(
						ctx.sessionManager.getBranch(),
						live.ledger,
						live.cursorId,
						live.resumeFromId,
					);
				} catch {
					return ""; // a replaced session has no branch to measure; the rest still answers
				}
				const pendingEntries = unreadContent(window.pending);
				if (pendingEntries === 0) return "";
				const decision = decideCompactionWait({
					enabled: config.waitForWriterBeforeCompact,
					dryRun: config.dryRun,
					sessionActive: sessionActive(),
					reason: "threshold",
					wouldDrop: true,
					inFlight: live.inFlightWrite,
					timings: live.timings,
					healthy: writerHealthy(live),
					entries: pendingEntries,
					tokens: window.tokens,
					maxChunkTokens: config.maxChunkTokens,
					budgetMs: config.compactWaitMs,
					now: Date.now(),
				});
				const unread = ` · unread ${decision.entries} entries / ~${decision.tokens} tok`;
				if (!decision.wait || !decision.stage) return unread;
				return `${unread} · ${decision.stage} ${Math.round(decision.elapsedS)}s in, ~${decision.etaS}s left`;
			};
			ctx.ui.notify(
				`pi-hy-memory ${live.enabled ? "" : "OFF "}${config.dryRun ? "(dry run) " : ""}· writer ${config.model} · ${active.length}/${live.bank.length} facts active · ${tokens} tokens · ` +
					`${live.stats.writes} writes · +${live.stats.added} ~${live.stats.updated} -${live.stats.deleted} · ` +
					`${live.stats.inTokens} in / ${live.stats.outTokens} out tok · ${live.stats.wallS.toFixed(0)}s · ${live.stats.compactions} compactions` +
					lag(),
				"info",
			);
		},
	});

	audit("loaded", { config });
}
