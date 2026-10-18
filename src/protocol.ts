/**
 * Model output is treated as untrusted input: parse, validate, sanitize, reject.
 * The model proposes; code decides what enters the bank.
 */

import type { BankEntry, Draft, ExtractResult, ReconcileOp, ReconcileResult, Relevance } from "./types.js";
import { isId } from "./types.js";

const MAX_STATEMENT_CHARS = 420;
const MAX_TASK_CHARS = 120;

/** Strip fences and pull the first balanced JSON object out of a completion. */
export function parseJsonObject(raw: string): unknown {
	let text = raw.trim();
	text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
	const start = text.indexOf("{");
	if (start < 0) throw new Error("no JSON object in completion");
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return JSON.parse(text.slice(start, i + 1));
		}
	}
	throw new Error("unbalanced JSON object in completion");
}

/**
 * The model tends to copy the whole rendered label when it names a bank entry
 * ("[9f1a07bd7a8e] (llama-swap local instance API endpoints)"). The id is what
 * matters, so it is extracted rather than the string compared. Measured: 4 of 21
 * drafts on chunk 503 were lost to exactly this.
 */
function extractId(value: string): string {
	return (value.match(/[0-9a-f]{12}/i)?.[0] ?? value).trim().toLowerCase();
}

/**
 * The grounding defect (internal source labels leaking into memory text) plus a
 * secret guard: the writer sees raw tool output and will happily store an API key
 * it finds there. Measured on chunk 482: the model wrote "apiKey sk-live-example-9f2c1a"
 * into a statement. Source ids are stripped by exact match against the ids that
 * were actually in the chunk, so ordinary words are never damaged.
 */
const SECRET_PATTERNS: RegExp[] = [
	// Credential *values* only. The earlier version matched any `<prefix>_<word>`
	// and so redacted identifiers instead of secrets: `relay_api_version` became
	// `rel…redacted…` and `API_PASSWORD=9010` lost its variable name, while
	// `password testpassword123` passed through untouched. Require a long,
	// digit-bearing value after the prefix, and never match mid-identifier (\b).
	/\b(?:sk|pk|wt|ghp|oauth|xox[bp]|npm)[-_](?:live|test|prod)?[-_]?[A-Za-z0-9][A-Za-z0-9._-]{11,}\b/gi,
	// provider-prefixed credentials: <prefix>_(live|test|prod|secret)_<long value>
	/\b[a-z]{2,8}_(?:live|test|prod|secret)[ _-][A-Za-z0-9][A-Za-z0-9._-]{11,}\b/gi,
	// "Bearer <token>" written with a space
	/\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
	// long opaque blobs: 32+ chars mixing letters and digits (raw API keys)
	/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g,
	// long opaque hex blobs (hashes, hex keys)
	/\b[a-f0-9]{20,}\b/g,
];

export function sanitizeStatement(value: string, sourceIds: Set<string>): string {
	let text = value.replace(/\[Source entry id:\s*[a-f0-9]{6,12}\]/gi, "").replace(/\[\d{1,4}\]/g, " ");
	for (const id of sourceIds) text = text.split(id).join("");
	for (const pattern of SECRET_PATTERNS) {
		text = text.replace(pattern, (match) => `${match.slice(0, 3)}…redacted…`);
	}
	return text.replace(/\s+/g, " ").trim().slice(0, MAX_STATEMENT_CHARS);
}

function normalizeKey(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9._/-]+/g, " ")
		.trim()
		.slice(0, 48);
}

export function relevanceOf(confidence: number, refCount: number): Relevance {
	if (confidence >= 0.8 && refCount >= 1) return "high";
	if (confidence >= 0.5) return "medium";
	return "low";
}

export function parseDrafts(raw: string, sourceIds: string[]): ExtractResult {
	const data = parseJsonObject(raw) as any;
	const list = Array.isArray(data?.drafts) ? data.drafts : [];
	const idSet = new Set(sourceIds);
	const drafts: Draft[] = [];
	const rejected: { reason: string; draft: unknown }[] = [];
	const seen = new Set<string>();

	for (const item of list) {
		if (!item || typeof item !== "object") {
			rejected.push({ reason: "not an object", draft: item });
			continue;
		}
		const statement = sanitizeStatement(String(item.statement ?? item.content ?? ""), idSet);
		if (statement.length < 24) {
			rejected.push({ reason: "statement too short or empty", draft: item });
			continue;
		}
		const refs: number[] = Array.isArray(item.refs)
			? item.refs
					.map((n: unknown) => Number(n))
					.filter((n: number) => Number.isInteger(n) && n >= 0 && n < sourceIds.length)
			: [];
		if (refs.length === 0) {
			rejected.push({ reason: "no valid source refs", draft: item });
			continue;
		}
		const confidence = Math.max(0, Math.min(1, Number(item.confidence ?? 0.5)));
		if (!Number.isFinite(confidence)) {
			rejected.push({ reason: "confidence not a number", draft: item });
			continue;
		}
		const task =
			sanitizeStatement(String(item.task ?? ""), idSet).slice(0, MAX_TASK_CHARS) ||
			statement.slice(0, MAX_TASK_CHARS);
		const keys = Array.isArray(item.keys)
			? item.keys
					.map((k: unknown) => normalizeKey(String(k)))
					.filter(Boolean)
					.slice(0, 8)
			: [];
		const dedupeKey = statement
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, " ")
			.trim();
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		drafts.push({ task, statement, keys, confidence, refs: [...new Set(refs)] });
	}
	return { drafts, rejected };
}

export function parseOps(
	raw: string,
	draftCount: number,
	bankIds: Set<string>,
	allowedTargets?: Map<number, Set<string>>,
): ReconcileResult {
	const data = parseJsonObject(raw) as any;
	const list = Array.isArray(data?.ops) ? data.ops : [];
	const ops: ReconcileOp[] = [];
	const rejected: { reason: string; op: unknown }[] = [];
	const usedDrafts = new Set<number>();
	const usedTargets = new Set<string>();
	const downgraded: { reason: string; op: unknown }[] = [];

	for (const item of list) {
		if (!item || typeof item !== "object") {
			rejected.push({ reason: "not an object", op: item });
			continue;
		}
		const action = String(item.action ?? "").toUpperCase();
		const reason = item.reason ? String(item.reason).slice(0, 200) : undefined;
		if (action === "ADD" || action === "UPDATE") {
			const idx = Number(item.draft);
			if (!Number.isInteger(idx) || idx < 0 || idx >= draftCount) {
				rejected.push({ reason: "draft index out of range", op: item });
				continue;
			}
			if (usedDrafts.has(idx)) {
				rejected.push({ reason: "draft already used by another op", op: item });
				continue;
			}
			if (action === "UPDATE") {
				const target = extractId(String(item.target ?? ""));
				if (!isId(target) || !bankIds.has(target)) {
					rejected.push({ reason: "target id not in bank", op: item });
					continue;
				}
				if (allowedTargets && !allowedTargets.get(idx)?.has(target)) {
					// The target was on screen for another draft, not for this one.
					usedDrafts.add(idx);
					ops.push({ action: "ADD", draft: idx });
					downgraded.push({
						reason: "update target not retrieved for this draft; recorded as ADD",
						op: item,
					});
					continue;
				}
				if (usedTargets.has(target)) {
					// Two drafts cannot both supersede one entry: the second would find
					// it already superseded and be applied as an orphan ADD with no
					// `supersedes` link. Measured on chunk 006 of session 01a14a46.
					usedDrafts.add(idx);
					ops.push({ action: "ADD", draft: idx });
					downgraded.push({ reason: "target already superseded in this batch; recorded as ADD", op: item });
					continue;
				}
				usedTargets.add(target);
				usedDrafts.add(idx);
				ops.push({ action: "UPDATE", draft: idx, target, reason });
				continue;
			}
			usedDrafts.add(idx);
			ops.push({ action: "ADD", draft: idx });
			continue;
		}
		if (action === "DELETE") {
			const target = extractId(String(item.target ?? ""));
			if (!isId(target) || !bankIds.has(target)) {
				rejected.push({ reason: "target id not in bank", op: item });
				continue;
			}
			ops.push({ action: "DELETE", target, reason });
			continue;
		}
		rejected.push({ reason: `unknown action ${action}`, op: item });
	}
	return { ops, rejected, downgraded };
}

const STOP = new Set(
	"the a an and or of to in on for with that this it is are was were be been as at by from into about over under then than when while which who whom whose how why what where not no yes can will would should could may might must do does did done have has had i you we they he she them his her its their our your".split(
		" ",
	),
);

function tokens(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9._/-]+/)
			.filter((t) => t.length > 2 && !STOP.has(t)),
	);
}

export function overlap(a: string, b: string): number {
	const ta = tokens(a);
	const tb = tokens(b);
	if (ta.size === 0 || tb.size === 0) return 0;
	let shared = 0;
	for (const t of ta) if (tb.has(t)) shared++;
	return shared / Math.min(ta.size, tb.size);
}

/**
 * Retrieval for the reconcile call: only bank entries the new drafts could
 * plausibly touch. This is what keeps the call cheap — the bank is never sent
 * whole, and it is also what makes UPDATE/DELETE possible at all.
 */
export function candidates(bank: BankEntry[], drafts: Draft[], limit = 12): BankEntry[] {
	const active = bank.filter((e) => e.status === "active");
	const scored = active.map((entry) => {
		let best = 0;
		for (const draft of drafts) {
			const score = Math.max(
				overlap(`${entry.statement} ${entry.task}`, `${draft.statement} ${draft.task}`),
				draft.keys.some((k) => entry.keys.includes(k) || entry.statement.toLowerCase().includes(k)) ? 0.5 : 0,
			);
			if (score > best) best = score;
		}
		return { entry, best };
	});
	return scored
		.filter((s) => s.best >= 0.2)
		.sort((a, b) => b.best - a.best)
		.slice(0, limit)
		.map((s) => s.entry);
}

/**
 * Per-draft candidate sets. The reconcile call sees the union, but an UPDATE is
 * accepted only when its target was retrieved for *that* draft — otherwise the
 * model is superseding an entry that merely happened to be on screen.
 */
export function candidatesPerDraft(bank: BankEntry[], drafts: Draft[], limit = 8): Map<number, BankEntry[]> {
	const active = bank.filter((e) => e.status === "active");
	const sets = new Map<number, BankEntry[]>();
	drafts.forEach((draft, index) => {
		const scored = active.map((entry) => ({
			entry,
			score: Math.max(
				overlap(`${entry.statement} ${entry.task}`, `${draft.statement} ${draft.task}`),
				draft.keys.some((k) => entry.keys.includes(k) || entry.statement.toLowerCase().includes(k)) ? 0.5 : 0,
			),
		}));
		sets.set(
			index,
			scored
				.filter((s) => s.score >= 0.2)
				.sort((a, b) => b.score - a.score)
				.slice(0, limit)
				.map((s) => s.entry),
		);
	});
	return sets;
}

export function renderBankForReconcile(entries: BankEntry[]): string {
	if (entries.length === 0) return "Existing bank entries: (none)";
	return `Existing bank entries:\n${entries.map((e) => `<id>${e.id}</id> (${e.task}) ${e.statement}`).join("\n")}`;
}

export function renderDraftsForReconcile(drafts: Draft[]): string {
	if (drafts.length === 0) return "New drafts: (none)";
	return (
		"New drafts:\n" +
		drafts.map((d, i) => `${i}: (${d.task}) ${d.statement} [confidence ${d.confidence}]`).join("\n")
	);
}

/**
 * Does an UPDATE draft restate its target?
 *
 * The model will happily overwrite an unrelated entry when the two share a
 * domain vocabulary. Measured in a real session: a draft about "node-b offline,
 * container 121 start failure" was applied as an UPDATE of "LXC containers on
 * nodes" (a full host inventory), erasing that whole inventory. The per-draft
 * retrieval guard cannot see this — the inventory *was* retrieved, because it
 * mentions the same node name.
 *
 * The prompt already requires an UPDATE draft to restate whatever is still true,
 * so a draft that restates very little of its target is either about a different
 * subject or a lossy rewrite. Requiring that restatement is a deterministic,
 * cheap test: downgrade to ADD (duplication, recoverable) rather than erase
 * (history loss).
 */
const SUBJECT_STOP = new Set(
	"the a an and or of to in on for with that this it is are was were be been as at by from into about over under then than when while which who whom whose how why what where not no yes can will would should could may might must do does did done have has had i you we they he she them his her its their our your also only just now".split(
		" ",
	),
);

export function subjectTokens(text: string): Set<string> {
	const out = new Set<string>();
	for (const word of text.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{3,}/g) ?? []) {
		if (!SUBJECT_STOP.has(word)) out.add(word);
	}
	return out;
}

export function sameSubject(
	draft: { task: string; statement: string },
	target: { task: string; statement: string },
): { ok: boolean; shared: number; targetSize: number } {
	const a = subjectTokens(`${draft.task} ${draft.statement}`);
	const b = subjectTokens(`${target.task} ${target.statement}`);
	let shared = 0;
	for (const token of b) if (a.has(token)) shared++;
	const targetSize = b.size;
	// A restatement of half the target is convincing on its own; otherwise require
	// a few shared specifics and at least 15% of the target's vocabulary.
	const ok = targetSize === 0 || shared / targetSize >= 0.5 || (shared >= 3 && shared / targetSize >= 0.15);
	return { ok, shared, targetSize };
}
