/**
 * Hi-fi compaction: an optional model-written summary at the compaction boundary.
 *
 * The default compaction needs no model — the bank is already a summary and the render is a
 * string build. That is the right default, but it is not the best achievable summary: pi's own
 * compaction produces a *checkpoint* (goal, constraints, progress, next steps), and only the
 * executor knows which work is finished and what comes next.
 *
 * So hi-fi keeps pi's shape and our material: the sections come from the prompt, the content
 * comes from the bank plus the recent tail, and every fact id survives so each claim stays
 * traceable to a fact and a fact to its source entries. The input is a delta — the previous
 * hi-fi summary plus what changed since it — which is a few thousand tokens rather than the
 * ~150 k tokens of history pi re-reads.
 *
 * Two rules are not negotiable. The model is the executor's, never the writer's: the writer is
 * forbidden from grading its own output, and that does not change because the task got bigger.
 * And a truncated or malformed answer is a failure, not a summary — pi applies the same rule to
 * its own compaction, and a checkpoint that silently lost its tail is worse than no checkpoint.
 */

import type { Model, Usage } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { type SelectionOptions, selectForSummary } from "./render.js";
import type { BankEntry } from "./types.js";

/** Mirrors pi's own summarization system prompt: summarize, never continue. */
export const HIFI_SYSTEM_PROMPT = `You are a context summarization assistant. You are given durable facts from a coding session, the recent conversation tail, and optionally a previous summary. Write a checkpoint that lets the assistant continue the work after its earlier context is discarded.

Do NOT continue the conversation, do NOT call tools, and do NOT answer any question. Respond with the summary text only.

Preserve every fact id you use, in brackets, exactly as given. Keep exact file paths, function names, flags, and error messages.`;

export const HIFI_SECTIONS = [
	"Goal",
	"Constraints & preferences",
	"Progress",
	"Key decisions",
	"Next steps",
	"Critical context",
] as const;

export interface HifiInput {
	/** The previous hi-fi summary, if this session has one. */
	previous?: string;
	/** Facts the previous checkpoint has not seen, or saw and dropped. */
	facts: BankEntry[];
	/** The recent conversation, serialized. This is what pi keeps verbatim; here it is context for judgement. */
	tail: string;
	/** Deterministic file operations in the summarized range. */
	files: { readFiles: string[]; modifiedFiles: string[] };
}

const line = (e: BankEntry): string => `[${e.id}] (${e.task}) ${e.statement}`;

/**
 * Build the request. Budgets are per part, and the parts are ordered so the cheapest, most
 * reliable material comes first: the facts we are certain about, then the previous checkpoint,
 * then the raw tail last (a model weights what it reads later, and the tail is the least
 * trustworthy source of durable truth).
 */
export function buildHifiPrompt(input: HifiInput): string {
	const parts: string[] = [];
	if (input.previous?.trim()) parts.push(`<previous-summary>\n${input.previous.trim()}\n</previous-summary>`);
	if (input.facts.length > 0) {
		parts.push(
			`<facts-new-since-last-checkpoint>\n${input.facts.map(line).join("\n")}\n</facts-new-since-last-checkpoint>`,
		);
	}
	if (input.tail.trim()) parts.push(`<recent-conversation>\n${input.tail.trim()}\n</recent-conversation>`);
	if (input.files.readFiles.length > 0 || input.files.modifiedFiles.length > 0) {
		parts.push(
			`<read-files>\n${input.files.readFiles.join("\n")}\n</read-files>\n<modified-files>\n${input.files.modifiedFiles.join("\n")}\n</modified-files>`,
		);
	}
	const sections = HIFI_SECTIONS.map((s) => `## ${s}`).join("\n");
	parts.push(
		`Write the checkpoint with exactly these sections:\n\n${sections}\n\nRules:\n- Merge the new facts into the previous checkpoint instead of appending a second copy of the same state.\n- Progress: mark work finished, and keep unfinished work under Progress as unfinished. Do not invent completion.\n- Constraints & preferences: keep everything the user stated, verbatim where it matters.\n- Key decisions: keep the decision and its reason; drop the discussion that produced it.\n- Next steps: only steps the conversation actually commits to.\n- Critical context: gotchas, constraints, and exact identifiers a continuation would otherwise rediscover the hard way.\n- Cite a fact id on any line that comes from a fact. Do not invent ids.`,
	);
	return parts.join("\n\n");
}

export interface HifiCheck {
	ok: boolean;
	reason?: string;
	/** How many of the ids we supplied appear in the answer. */
	idsKept: number;
	idsGiven: number;
}

/**
 * Validate an answer. A truncated summary is a failure rather than a shorter summary: pi
 * refuses to persist one for the same reason — the part that fell off is usually the part that
 * said what to do next.
 */
export function checkHifi(
	text: string,
	given: BankEntry[],
	truncated: boolean,
	options: { outputTokens?: number } = {},
): HifiCheck {
	const idsGiven = new Set(given.map((e) => e.id));
	const idsKept = [...idsGiven].filter((id) => text.includes(`[${id}]`)).length;
	// "Empty" and "no text" are different failures and need different fixes. A model that
	// answers nothing is a transport or prompt problem; a model that spends the entire
	// output budget on reasoning and emits no answer is a budget problem, and it looks
	// identical from the outside unless the token count is reported. Measured on
	// qwen3.8-flash-next: 2 000 output tokens, stop "length", zero text blocks.
	if (!text.trim()) {
		const reason =
			(options.outputTokens ?? 0) > 0
				? `no text in the answer (${options.outputTokens} output tokens, all of it reasoning or tool calls)`
				: "empty answer";
		return { ok: false, reason, idsKept, idsGiven: idsGiven.size };
	}
	if (truncated) return { ok: false, reason: "answer was truncated", idsKept, idsGiven: idsGiven.size };
	const missing = HIFI_SECTIONS.filter((s) => !text.includes(s));
	if (missing.length > 0)
		return { ok: false, reason: `missing sections: ${missing.join(", ")}`, idsKept, idsGiven: idsGiven.size };
	if (idsKept === 0) return { ok: false, reason: "no fact id survived", idsKept, idsGiven: idsGiven.size };
	return { ok: true, idsKept, idsGiven: idsGiven.size };
}

/**
 * The affordance the render carries in its header, re-attached to an accepted checkpoint.
 *
 * A model-written summary is not asked to explain our tooling, and a good one will not: it
 * writes prose about the work. But the ids it cites are only useful if the next reader knows
 * they can be looked up, so the reminder is ours to add rather than ours to hope for.
 */
export const HIFI_RECALL_NOTE = `[ids] are exact references to stored facts: use the recall tool with an id to read the source evidence behind that line, and the memory bank still holds every fact this checkpoint left out.`;

export function withRecallNote(checkpoint: string): string {
	return checkpoint.includes("recall tool") ? checkpoint : `${checkpoint.trim()}\n\n${HIFI_RECALL_NOTE}`;
}

export interface HifiCallOptions {
	model: Model<any>;
	prompt: string;
	maxTokens: number;
	timeoutMs: number;
	/** Reasoning level from the session; "off" means do not ask for reasoning. */
	reasoning?: string;
	signal?: AbortSignal;
	/**
	 * Request auth, resolved by the caller. pi resolves it for its own summarizer; an
	 * extension gets the same thing from `ctx.modelRegistry.getApiKeyAndHeaders(model)`.
	 * Without it a model whose key lives in the provider config fails at the provider.
	 */
	apiKey?: string;
	headers?: Record<string, string | null>;
	/** Diagnostic hook: the provider payload exactly as it is about to be sent. */
	onPayload?: (payload: unknown) => void;
}

export interface HifiResult {
	text: string;
	usage?: Usage;
	stopReason: string;
	ms: number;
}

/** One completion, with a hard timeout. Any transport failure propagates to the caller's fallback. */
export async function hifiSummary(options: HifiCallOptions): Promise<HifiResult> {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	const onOuter = () => controller.abort();
	options.signal?.addEventListener("abort", onOuter);
	try {
		const response = await completeSimple(
			options.model,
			{
				systemPrompt: HIFI_SYSTEM_PROMPT,
				messages: [{ role: "user", content: options.prompt, timestamp: Date.now() }],
			},
			{
				maxTokens: options.maxTokens,
				signal: controller.signal,
				apiKey: options.apiKey,
				headers: options.headers,
				onPayload: options.onPayload,
				reasoning: options.reasoning && options.reasoning !== "off" ? (options.reasoning as never) : undefined,
			},
		);
		// A provider-level error is a failure of the call, not an answer: pi's own
		// summarizer refuses to persist one, and the caller's fallback is the point.
		// `errorMessage` is checked even when the stop reason looks clean, because a
		// stream that reports an error has failed whatever it claims about its ending.
		if (response.stopReason === "error" || response.errorMessage)
			throw new Error(response.errorMessage ?? `hi-fi call failed (${response.stopReason})`);
		const text = response.content
			.filter((b) => b.type === "text")
			.map((b) => (b as { text: string }).text)
			.join("\n");
		return { text, usage: response.usage, stopReason: response.stopReason, ms: Date.now() - started };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onOuter);
	}
}

/**
 * Facts to send. The delta is what the previous checkpoint has not seen; user-stated facts are
 * always sent, because a constraint that drops out of a checkpoint is a constraint the model
 * breaks later, and that is the most expensive possible failure of this feature.
 */
export function hifiFacts(
	bank: BankEntry[],
	options: {
		lastSeq: number;
		previous?: string;
		maxTokens: number;
		estimate: (text: string) => number;
		selection?: SelectionOptions;
	},
): BankEntry[] {
	const { lastSeq, previous, maxTokens, selection: selectionOptions } = options;
	const active = bank.filter((e) => e.status === "active");
	// Three reasons a fact is a candidate: it is new since the last checkpoint, the user
	// stated it, or the last checkpoint dropped it. The third is what makes the feature
	// self-healing — a fact a weak summary forgot is offered again instead of vanishing.
	const candidates = active.filter(
		(e) => (e.chunkSeq ?? 0) > lastSeq || e.fromUser || !(previous ?? "").includes(`[${e.id}]`),
	);
	// Constraints first, absolutely. A user-stated fact missing from a checkpoint is a
	// constraint the model breaks later, which is the most expensive failure this feature
	// can have — so they are admitted before any budget is spent on anything else, newest
	// first. Only a bank of constraints larger than the whole budget can push one out.
	const costOf = (e: BankEntry): number => Math.max(1, Math.ceil(`[${e.id}] (${e.task}) ${e.statement}`.length / 4));
	const kept: BankEntry[] = [];
	let used = 0;
	for (const e of candidates
		.filter((e) => e.fromUser)
		.slice()
		.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))) {
		const cost = costOf(e);
		if (used + cost > maxTokens && kept.length > 0) continue;
		kept.push(e);
		used += cost;
	}
	// Which of the rest go is the same stratified selection the summary uses. A
	// newest-first cap would not: on a 408-fact bank it sends the newest ~70 every time,
	// and the 338 older ones — never cited by a checkpoint that never saw them — are
	// re-offered and cut again, forever. The selection reserves a share for old,
	// never-superseded foundations, so age alone cannot starve them out of the checkpoint.
	const { shown } = selectForSummary(
		candidates.filter((e) => !e.fromUser),
		Math.max(1, maxTokens - used),
		{
			...selectionOptions,
			reserveFixed: false,
		},
	);
	return [...kept, ...shown].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}
