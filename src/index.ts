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
import { EXTRACT_RECORD, highestChunkSeq, nextChunkId } from "./chunks.js";
import { type HyConfig, legacyKeys, SETTING_DEFAULTS } from "./config.js";
import { type ChunkBuild, compactionBoundary, entryTokens, renderEntry, serializeEntries } from "./entries.js";
import { nextFailoverState } from "./failover.js";
import { createWriter, type Writer } from "./llm.js";
import { writeChunk } from "./pipeline.js";
import { renderMemory, summaryBudget } from "./render.js";
import { pruneSessions } from "./state.js";
import { createStatusBar } from "./status.js";
import { type BankEntry, type Draft, estimateTokens, type LedgerRecord } from "./types.js";

// Env override so experiments never mutate the live config of a running session.
const CONFIG_FILE = process.env.PI_HY_MEMORY_CONFIG ?? join(os.homedir(), ".pi", "agent", "pi-hy-memory.json");
const STATE_DIR = process.env.PI_HY_MEMORY_STATE ?? join(os.homedir(), ".pi", "agent", "pi-hy-memory", "state");
const AUDIT_FILE = join(STATE_DIR, "audit.ndjson");
const SESSIONS_DIR = join(STATE_DIR, "sessions");

const OPS_RECORD = "hy.ops";

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
	chunkSeq: number;
	/** Consecutive failed writes; shrinks the chunk so a retry can complete. */
	failures: number;
	/** Drafts from an extract that already succeeded but whose reconcile failed. */
	pendingExtract: PendingExtract | null;
	/** When the primary was last seen down; skip it until this passes. */
	primaryDownUntil: number;
	inFlight: boolean;
	pending: Promise<void> | null;
	stats: {
		writes: number;
		drafts: number;
		added: number;
		updated: number;
		deleted: number;
		rejectedOps: number;
		downgraded: number;
		inTokens: 0 | number;
		outTokens: 0 | number;
		wallS: number;
		compactions: number;
	};
};

function ledgerFromSession(entries: SessionEntry[]): LedgerRecord[] {
	const records: LedgerRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== EXTRACT_RECORD && entry.customType !== OPS_RECORD) continue;
		const data = entry.data as LedgerRecord | undefined;
		if (data && typeof data.type === "string" && Array.isArray((data as any).drafts ?? (data as any).ops))
			records.push(data);
	}
	return records;
}

function tokensSince(
	entries: SessionEntry[],
	cursorId: string | undefined,
	/** Where coverage resumes when the compaction gap dropped the cursor itself. */
	resumeFromId?: string,
): { pending: SessionEntry[]; tokens: number } {
	let start = 0;
	if (cursorId) {
		const at = entries.findIndex((e) => e.id === cursorId);
		if (at >= 0) start = at + 1;
		else if (resumeFromId) {
			// The gap record's fromId is the first entry that survived the cut, and it
			// is uncovered: start there rather than re-reading the whole branch.
			const resumed = entries.findIndex((e) => e.id === resumeFromId);
			if (resumed >= 0) start = resumed;
		}
	}
	const pending = entries.slice(start);
	return { pending, tokens: pending.reduce((sum, e) => sum + entryTokens(e), 0) };
}

export default function piHyMemory(pi: ExtensionAPI): void {
	const { config, parseError: configParseError } = loadConfigFile(CONFIG_FILE);
	const status = createStatusBar("hy");
	let lastPending = 0;
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
				pending = tokensSince(entries, state.cursorId, state.resumeFromId).tokens;
			} catch {
				pending = 0;
			}
			lastPending = pending;
		}
		status.snapshot({
			pending,
			budget: config.observeAfterTokens,
			bank: state.bank.filter((e) => e.status === "active").reduce((sum, e) => sum + (e.tokenCount ?? 0), 0),
			pool: config.poolMaxTokens,
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
				`${renderMemory(state.bank, summaryBudget(config.poolMaxTokens, state.bank))}\n`,
			);
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
		const recheck = enforceBudget(folded, config.poolMaxTokens);
		if (recheck.dropped.length > 0) {
			audit("budget_reapplied", {
				sessionId,
				pool: config.poolMaxTokens,
				dropped: recheck.dropped.length,
				ids: recheck.dropped.slice(0, 5).map((e: { id: string }) => e.id),
			});
		}
		const lastGap = [...effective].reverse().find((r) => r.type === "hy.gap");
		state = {
			sessionId,
			ledger: effective,
			bank: folded,
			cursorId: effective.at(-1)?.coversUpToId,
			resumeFromId: lastGap?.fromId,
			chunkSeq: highestChunkSeq(effective),
			failures: 0,
			pendingExtract: readPendingExtract(sessionId),
			primaryDownUntil: 0,
			inFlight: false,
			pending: null,
			stats: {
				writes: 0,
				drafts: 0,
				added: 0,
				updated: 0,
				deleted: 0,
				rejectedOps: 0,
				downgraded: 0,
				inTokens: 0,
				outTokens: 0,
				wallS: 0,
				compactions: 0,
			},
		};
		audit("session_start", {
			sessionId,
			records: effective.length,
			active: state.bank.filter((e) => e.status === "active").length,
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
				const { primary, fallback } = writers(ctx);
				const result = await writeChunk(primary, startState.bank, chunkId, chunk, {
					poolMaxTokens: config.poolMaxTokens,
					candidateLimit: candidateBudget(),
					fallback,
					preferFallback: (state?.primaryDownUntil ?? 0) > Date.now(),
					busyRetries: config.busyRetries,
					busyBackoffMs: config.busyBackoffMs,
					// A quarter of the call budget: enough for a slot to free, not enough
					// to spend the whole write asleep.
					busyBudgetMs: Math.max(1, Math.round((config.timeoutMs ?? 480_000) / 4)),
					onStage: (stage, detail) => status.stage(stage, detail),
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
					rejectedDrafts: result.rejectedDrafts.length,
					rejectedOps: result.rejectedOps.length,
					downgraded: result.downgraded.length,
					inTokens: result.usage.extract.inTokens + result.usage.reconcile.inTokens,
					outTokens: result.usage.extract.outTokens + result.usage.reconcile.outTokens,
					wallS: (Date.now() - started) / 1000,
					endpoints: result.endpoints,
					budgetDropped: result.budgetDropped.length,
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
				if (state && state.sessionId === sessionId) state.failures++;
				const resumed = Boolean(state?.pendingExtract);
				status.failed(String((error as Error)?.message ?? error));
				warn(ctx, `write failed: ${String((error as Error)?.message ?? error)}`);
				audit("write_error", {
					sessionId,
					chunkId,
					resumedExtract: resumed,
					failures: state?.failures ?? 0,
					nextChunkBudget: chunkBudget(),
					error: String((error as Error)?.message ?? error).slice(0, 400),
				});
			}
		})();
	};

	const startWrite = (ctx: ExtensionContext, chunk: ChunkBuild, chunkId: string, sessionId: string): void => {
		if (!state) return;
		const promise = runWrite(ctx, chunk, chunkId, sessionId).finally(() => {
			if (state) state.pending = null;
		});
		state.pending = promise;
	};

	pi.on("turn_end", (_event, ctx) => {
		if (!config.enabled) return;
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

		const { pending, tokens } = tokensSince(branch, live.cursorId, live.resumeFromId);
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
	pi.on("session_before_compact", (event, ctx) => {
		if (!config.enabled || !state) return undefined;
		const active = state.bank.filter((e) => e.status === "active");
		if (active.length === 0) return undefined;

		const summary = renderMemory(state.bank, summaryBudget(config.poolMaxTokens, state.bank));
		if (!summary.trim()) return undefined;

		const entries = event.branchEntries;
		// pi's own cut point and its real token count: the boundary is only worth
		// keeping if holding the backlog does not defeat the compaction entirely.
		const choice = compactionBoundary(entries, {
			cursorId: state.cursorId,
			keepRecentTokens: config.keepRecentTokens,
			proposedId: event.preparation?.firstKeptEntryId,
			maxUncoveredTokens: config.maxChunkTokens,
		});
		const firstKeptIndex = choice.firstKeptIndex;
		if (choice.gap) {
			// Coverage jumps: the entries between the old watermark and pi's cut were
			// dropped from the branch before any chunk read them. The ledger says so,
			// so no later reader believes they were covered.
			const gap: LedgerRecord = {
				type: "hy.gap",
				coversUpToId: choice.gap.toId,
				fromId: choice.gap.fromId,
				entries: choice.gap.entries,
				tokens: choice.gap.tokens,
				reason: "compaction",
				createdAt: new Date().toISOString(),
			};
			state.ledger.push(gap);
			state.resumeFromId = choice.gap.fromId;
			audit("compaction_gap", {
				sessionId: state.sessionId,
				entries: choice.gap.entries,
				tokens: choice.gap.tokens,
				from: choice.gap.fromId,
				after: choice.gap.toId,
			});
		}
		// Prefer pi's count: ours clips each entry at maxEntryChars, so it undercounts
		// the real context by ~1.5x on tool-heavy sessions.
		const estimate = entries.reduce((sum, e) => sum + entryTokens(e), 0);
		const tokensBefore = event.preparation?.tokensBefore ?? estimate;
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
		});
		mirror();
		void ctx;
		return {
			compaction: {
				summary,
				firstKeptEntryId: entries[firstKeptIndex]?.id ?? entries[entries.length - 1].id,
				tokensBefore,
				estimatedTokensAfter: estimateTokens(summary) + choice.used,
				details: { hyMemory: true, facts: active.length, model: config.model },
			},
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
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
			"Look up the session's durable fact bank. Query text searches active facts; an entry id returns the fact plus the exact source entries it was written from.",
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
			const scored = active.map((entry) => {
				const haystack = `${entry.task} ${entry.statement} ${entry.keys.join(" ")}`.toLowerCase();
				const score = query
					? query.split(/\s+/).filter((token) => token.length > 2 && haystack.includes(token)).length
					: 1;
				return { entry, score };
			});
			const hits = scored
				.filter((s) => s.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, limit);
			if (hits.length === 0)
				return {
					content: [
						{
							type: "text",
							text: `No facts match ${JSON.stringify(query)}. ${active.length} facts in the bank.`,
						},
					],
					details: undefined,
				};
			return {
				content: [
					{
						type: "text",
						text: hits.map(({ entry }) => `[${entry.id}] (${entry.task}) ${entry.statement}`).join("\n"),
					},
				],
				details: { hits: hits.length, active: active.length },
			};
		},
	});

	pi.registerCommand("hy", {
		description: "pi-hy-memory status: [status] bank size and cost, [summary] the facts compaction would render",
		handler: async (args, ctx) => {
			if (!state) {
				ctx.ui.notify("pi-hy-memory: no bank for this session.", "info");
				return;
			}
			const active = state.bank.filter((e) => e.status === "active");
			const tokens = active.reduce((sum, e) => sum + e.tokenCount, 0);
			if (
				String(args ?? "")
					.trim()
					.toLowerCase() === "summary"
			) {
				ctx.ui.notify(renderMemory(state.bank, summaryBudget(config.poolMaxTokens, state.bank)), "info");
				return;
			}
			ctx.ui.notify(
				`pi-hy-memory ${config.dryRun ? "(dry run) " : ""}· writer ${config.model} · ${active.length}/${state.bank.length} facts active · ${tokens} tokens · ` +
					`${state.stats.writes} writes · +${state.stats.added} ~${state.stats.updated} -${state.stats.deleted} · ` +
					`${state.stats.inTokens} in / ${state.stats.outTokens} out tok · ${state.stats.wallS.toFixed(0)}s · ${state.stats.compactions} compactions`,
				"info",
			);
		},
	});

	audit("loaded", { config });
}
