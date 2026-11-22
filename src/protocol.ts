/**
 * Model output is treated as untrusted input: parse, validate, sanitize, reject.
 * The model proposes; code decides what enters the bank.
 */

import { errorPosition, OutputParseError } from "./errors.js";
import type { BankEntry, Draft, ExtractResult, ReconcileOp, ReconcileResult } from "./types.js";
import { isId } from "./types.js";
import { valuesTheDraftDrops } from "./values.js";

const MAX_STATEMENT_CHARS = 420;
const MAX_TASK_CHARS = 120;

/**
 * Repairs for the malformed completions measured in production, attempted only after a
 * strict parse has already failed, so valid output is never rewritten.
 *
 * 1. Invalid escapes inside strings. The writer copies code verbatim, so a regex in a
 *    statement arrives as `/^[\s]*(\d+).../`, and `\s`/`\d` are not legal JSON escapes.
 *    Measured in the audit: 25 write failures across 12 sessions, every one worded
 *    `Bad escaped character …`. A `\u` not followed by four hex digits is the same class.
 * 2. A stray quote after a numeric field: `"draft":5"` (measured on chunk 005 of the
 *    extended corpus, which then failed three times because the retry reused the same
 *    persisted drafts).
 * 3. A bare token inside an array — see `quoteBareArrayTokens`.
 *
 * An escape repair has to consume a legal escape whole. The first version was
 * `text.replace(/\\(?![\\"/bfnrtu])/g, "\\\\")`, which weighed every backslash on its own.
 * In `\\s` — a legal escaped backslash followed by `s` — the first backslash is skipped and
 * the second is repaired, so the output is `\\\s`: the repair wrote the defect it was
 * meant to remove. A completion that mixes legal pairs with one illegal escape then failed
 * its second parse, and the chunk was lost over a defect the repair invented.
 */
/**
 * Quote bare tokens inside JSON arrays: `"refs":[0,66594cfa]` -> `"refs":[0,"66594cfa"]`.
 *
 * Measured on `hy-reload-006`, where the writer answered with entry ids rather than the `[n]`
 * indices the chunk shows, and emitted them unquoted. The strict parse failed, the retry at
 * temperature 0 produced the same bytes, and the chunk was lost over the syntax — not over
 * truncation, which is what TODO 6.14 had assumed.
 *
 * The walk tracks whether it is inside a string, so prose that merely looks like a list
 * (`refs:[0,x]` written inside a statement) is left exactly as the model wrote it. Numbers,
 * `true`, `false` and `null` stay unquoted; only object/array *values* inside `[...]` are touched.
 */
function quoteBareArrayTokens(text: string): { text: string; repaired: boolean } {
	let out = "";
	let inString = false;
	let escaped = false;
	let repaired = false;
	const containers: string[] = [];
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			out += ch;
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === "[" || ch === "{") {
			containers.push(ch);
			out += ch;
			continue;
		}
		if (ch === "]" || ch === "}") {
			containers.pop();
			out += ch;
			continue;
		}
		const inArray = containers.length > 0 && containers[containers.length - 1] === "[";
		if (inArray && ch !== "," && ch !== " " && ch !== "\n" && ch !== "\t" && ch !== "\r") {
			let end = i;
			while (end < text.length && !",]}".includes(text[end])) end++;
			const token = text.slice(i, end).trim();
			// A valid array value stays as written: a number (including a negative or a
			// fraction), a boolean, or null. Everything else was never valid JSON there — a bare
			// identifier, or a hex entry id that merely starts with a digit.
			const valid = /^-?\d+(?:\.\d+)?$/.test(token) || token === "true" || token === "false" || token === "null";
			if (token.length > 0 && !valid) {
				repaired = true;
				out += `"${token.replace(/"/g, "")}"`;
			} else {
				out += text.slice(i, end);
			}
			i = end - 1;
			continue;
		}
		out += ch;
	}
	return { text: out, repaired };
}

/** The single character that may follow a backslash inside a JSON string. */
const LEGAL_ESCAPE = '\\"/bfnrt';

/**
 * One left-to-right pass. A legal escape is copied and its second character is consumed,
 * so a later backslash is only ever read as what it really is. A backslash that starts
 * nothing legal — `\s`, `\d`, `\.` — is doubled, and `\u` counts as legal only when four
 * hex digits follow it.
 */
function repairEscapes(text: string): { text: string; repairs: string[] } {
	const repairs: string[] = [];
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch !== "\\") {
			out += ch;
			continue;
		}
		const next = text[i + 1];
		if (next === "u") {
			const hex = text.slice(i + 2, i + 6);
			if (/^[0-9a-fA-F]{4}$/.test(hex)) {
				out += `\\u${hex}`;
				i += 5;
				continue;
			}
			if (!repairs.includes("unicode-escape")) repairs.push("unicode-escape");
			out += "\\\\";
			continue;
		}
		if (next !== undefined && LEGAL_ESCAPE.includes(next)) {
			out += ch + next;
			i++;
			continue;
		}
		if (!repairs.includes("escaped-backslash")) repairs.push("escaped-backslash");
		out += "\\\\";
	}
	return { text: out, repairs };
}

function repairJson(text: string): { text: string; repairs: string[] } {
	const escapes = repairEscapes(text);
	const repairs = [...escapes.repairs];
	// `"draft":5"` -> `"draft":5`.
	const numeric = escapes.text.replace(/("(?:draft|index)"\s*:\s*-?\d+)\s*"/g, (_m, head: string) => {
		if (!repairs.includes("quote-after-number")) repairs.push("quote-after-number");
		return head;
	});
	const arrays = quoteBareArrayTokens(numeric);
	if (arrays.repaired && !repairs.includes("array-bare-token")) repairs.push("array-bare-token");
	return { text: arrays.text, repairs };
}

/**
 * Repairs applied by the most recent successful parse, for the audit. Cleared on every
 * strict parse so a stale value can never be attributed to the wrong chunk.
 */
let lastRepair: string[] | undefined;
export function takeJsonRepair(): string[] | undefined {
	const repairs = lastRepair;
	lastRepair = undefined;
	return repairs;
}

/** Scan out the first balanced object and parse it strictly. */
function scanJson(raw: string): unknown {
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

type ParseAttempt = { ok: true; value: unknown } | { ok: false; error: Error };

function attemptScan(raw: string): ParseAttempt {
	try {
		return { ok: true, value: scanJson(raw) };
	} catch (error) {
		return { ok: false, error: error as Error };
	}
}

/**
 * Strict parse first. Anything else is the model's malformation, and three of those have
 * been measured — see `repairJson`. The repair has to run before the scan, not after: a
 * stray quote makes the balanced-brace scanner swallow the rest of the object, which is
 * why the reported error was "unbalanced" rather than a parse position.
 *
 * A failure always says which attempt blocked the write. The first version rethrew the
 * strict error whenever the repaired text failed, so an audit line blamed the defect the
 * repair had already fixed and hid the one that actually stopped the parse.
 */
export function parseJsonObject(raw: string): unknown {
	lastRepair = undefined;
	const strict = attemptScan(raw);
	if (strict.ok) return strict.value;
	const { text, repairs } = repairJson(raw);
	const position = errorPosition(strict.error.message);
	if (repairs.length === 0)
		throw new OutputParseError({ strictMessage: strict.error.message, repairs: [], position, cause: strict.error });
	const repaired = attemptScan(text);
	if (repaired.ok) {
		lastRepair = repairs;
		return repaired.value;
	}
	// `position` is the strict one on purpose: it indexes the completion as the model
	// wrote it, which is the text a capture window has to point at.
	throw new OutputParseError({
		strictMessage: strict.error.message,
		repairs,
		repairedMessage: repaired.error.message,
		position,
		cause: strict.error,
	});
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

/**
 * Mask credential-shaped text. Exported because the audit keeps a window of a failing
 * completion, and that window is raw model text: it carries whatever the writer read off
 * the tool output it was summarising.
 */
export function redactSecrets(text: string): string {
	let out = text;
	for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, (match) => `${match.slice(0, 3)}…redacted…`);
	return out;
}

export function sanitizeStatement(value: string, sourceIds: Set<string>): string {
	let text = value.replace(/\[Source entry id:\s*[a-f0-9]{6,12}\]/gi, "").replace(/\[\d{1,4}\]/g, " ");
	// A copied chunk line drags its label with it: `[da8e7079] [Assistant @ 16:59]: …`. The id is
	// dropped only when a role label follows it, so a bracketed commit sha standing alone in a
	// statement is not mistaken for an internal id and quietly deleted from a fact.
	text = text.replace(/\[[0-9a-f]{6,12}\](?=\s*\[(?:User|Assistant|Tool|System|Earlier|Custom|Model))/gi, "");
	for (const id of sourceIds) text = text.split(id).join("");
	text = redactSecrets(text);
	return text.replace(/\s+/g, " ").trim().slice(0, MAX_STATEMENT_CHARS);
}

function normalizeKey(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9._/-]+/g, " ")
		.trim()
		.slice(0, 48);
}

const HEX_ID = /^[0-9a-f]{6,12}$/i;

/**
 * Resolve one ref. An index arrives as a number or a digit string; the shape the writer has been
 * measured emitting instead is the entry id itself — bare in the JSON until `repairJson` quotes
 * it, and either exact or truncated. An id resolves only when it names one source entry: an
 * ambiguous prefix is refused rather than guessed.
 */
function resolveSourceRef(
	raw: unknown,
	sourceIds: string[],
	indexById: Map<string, number>,
): { index: number; byId: boolean } | undefined {
	if (typeof raw === "number") {
		return Number.isInteger(raw) && raw >= 0 && raw < sourceIds.length ? { index: raw, byId: false } : undefined;
	}
	if (typeof raw !== "string") return undefined;
	const text = raw.trim();
	if (/^\d+$/.test(text)) {
		const n = Number(text);
		return n >= 0 && n < sourceIds.length ? { index: n, byId: false } : undefined;
	}
	if (!HEX_ID.test(text)) return undefined;
	const lower = text.toLowerCase();
	const exact = indexById.get(lower);
	if (exact !== undefined) return { index: exact, byId: true };
	const hits = sourceIds.filter((id) => id.toLowerCase().startsWith(lower));
	return hits.length === 1 ? { index: sourceIds.indexOf(hits[0]), byId: true } : undefined;
}

/**
 * The contract's top-level key, which is always an array. An object, a string or a missing key
 * attempted the shape of the answer and got it wrong, so it is the model's output and gets the
 * one corrective re-ask. Reading those shapes as an empty list instead threw the chunk's work
 * away and recorded a clean write, which is why the malformation never reached the audit or the
 * writer's notice: `{"drafts":[]}` is the only completion that means "nothing durable here".
 */
function requireArray(data: any, key: "drafts" | "ops"): any[] {
	const value = data?.[key];
	if (Array.isArray(value)) return value;
	throw new OutputParseError({
		strictMessage: `the answer's "${key}" is ${typeNamed(value)}, not an array`,
		repairs: [],
	});
}

/** What the key held, phrased for the model to read back in the corrective re-ask. */
function typeNamed(value: unknown): string {
	if (value === undefined) return "missing";
	if (value === null) return "null";
	if (typeof value === "object") return "an object";
	if (typeof value === "string") return "a string";
	if (typeof value === "number") return "a number";
	if (typeof value === "boolean") return "a boolean";
	return typeof value;
}

export function parseDrafts(raw: string, sourceIds: string[]): ExtractResult {
	const data = parseJsonObject(raw) as any;
	const list = requireArray(data, "drafts");
	const idSet = new Set(sourceIds);
	const drafts: Draft[] = [];
	const rejected: { reason: string; draft: unknown }[] = [];
	const seen = new Set<string>();
	const indexById = new Map(sourceIds.map((id, i) => [String(id).toLowerCase(), i]));
	let idRefs = 0;

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
		const refs: number[] = [];
		let namedById = 0;
		let unresolvableById = 0;
		for (const raw of Array.isArray(item.refs) ? item.refs : []) {
			const resolved = resolveSourceRef(raw, sourceIds, indexById);
			if (!resolved) {
				if (typeof raw === "string" && HEX_ID.test(raw.trim())) unresolvableById++;
				continue;
			}
			if (resolved.byId) namedById++;
			refs.push(resolved.index);
		}
		if (refs.length === 0) {
			rejected.push({
				reason: unresolvableById > 0 ? "ref names an entry id, not an index" : "no valid source refs",
				draft: item,
			});
			continue;
		}
		idRefs += namedById;
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
		drafts.push({ task, statement, keys, refs: [...new Set(refs)] });
	}
	return { drafts, rejected, idRefs };
}

export function parseOps(
	raw: string,
	draftCount: number,
	bankIds: Set<string>,
	allowedTargets?: Map<number, Set<string>>,
): ReconcileResult {
	const data = parseJsonObject(raw) as any;
	const list = requireArray(data, "ops");
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
		if (action === "SKIP") {
			const idx = Number(item.draft);
			if (!Number.isInteger(idx) || idx < 0 || idx >= draftCount) {
				rejected.push({ reason: "draft index out of range", op: item });
				continue;
			}
			if (usedDrafts.has(idx)) {
				rejected.push({ reason: "draft already used by another op", op: item });
				continue;
			}
			usedDrafts.add(idx);
			ops.push({ action: "SKIP", draft: idx, reason });
			continue;
		}
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

/**
 * Shown-set selection that guarantees per-draft coverage instead of letting a
 * union slice starve whole drafts: each draft's best candidate is shown first
 * (draft order), remaining slots fill round-robin by descending per-draft rank.
 * Deterministic; never exceeds `cap` entries.
 */
export function selectShownPerDraft(perDraft: Map<number, BankEntry[]>, cap: number): BankEntry[] {
	const chosen: BankEntry[] = [];
	const taken = new Set<string>();
	const add = (entry: BankEntry | undefined): boolean => {
		if (!entry || taken.has(entry.id) || chosen.length >= cap) return false;
		taken.add(entry.id);
		chosen.push(entry);
		return true;
	};
	for (const list of perDraft.values()) add(list[0]);
	for (let rank = 1; chosen.length < cap; rank++) {
		let any = false;
		for (const list of perDraft.values()) {
			if (add(list[rank])) any = true;
		}
		if (!any) break;
	}
	return chosen;
}

export function renderBankForReconcile(entries: BankEntry[]): string {
	if (entries.length === 0) return "Existing bank entries: (none)";
	return `Existing bank entries:\n${entries.map((e) => `<id>${e.id}</id> (${e.task}) ${e.statement}`).join("\n")}`;
}
export function renderDraftsForReconcile(drafts: Draft[], zeroCandidate?: Set<number>): string {
	if (drafts.length === 0) return "New drafts: (none)";
	return (
		"New drafts:\n" +
		drafts
			.map(
				(d, i) =>
					`${i}: (${d.task}) ${d.statement}${zeroCandidate?.has(i) ? " [bank consulted: no matching entries]" : ""}`,
			)
			.join("\n")
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

/**
 * The two write-time checks an UPDATE has to pass, applied to a proposed op list.
 *
 * Both refuse by recording an ADD instead, because the two failure shapes are not equally
 * recoverable: a refused merge leaves the same claim banked twice, which a later write can clean
 * up, while an applied merge overwrites history that nothing can restore.
 *
 *   1. the subject test — an UPDATE must restate its target. Measured: a draft about "node-b
 *      offline, container 121 start failure" was applied over "LXC containers on nodes", a full host
 *      inventory, because the two share a node name. Retrieval cannot see that; the inventory *was*
 *      on screen, because it mentions the same node.
 *   2. the value test (`mergeValueGate`, TODO 7.18) — same subject is not the same question as
 *      keeping what the old fact held. "queue purge age is 420, line 63" and "queue retention rule
 *      was reviewed" are one subject, and the merge destroys 420.
 *
 * Refusals are appended to `downgradedOps` with the reason the bank recorded, which is what
 * `dev/merge-report.ts` and `dev/session-scope-report.ts` read back out of the ledger — so the
 * wording of these two strings is a published interface, not a log line.
 */
export function guardUpdateOps(
	bank: BankEntry[],
	drafts: Draft[],
	ops: ReconcileOp[],
	downgradedOps: { reason: string; op: unknown }[],
	guards: { valueGate: boolean },
): ReconcileOp[] {
	const byId = new Map(bank.map((entry) => [entry.id, entry]));
	return ops.map((op) => {
		if (op.action !== "UPDATE") return op;
		const target = byId.get(op.target);
		const draft = drafts[op.draft];
		if (!target || !draft) return op;
		const verdict = sameSubject(draft, target);
		if (!verdict.ok) {
			downgradedOps.push({
				reason: `target does not restate its subject (${verdict.shared}/${verdict.targetSize} shared); recorded as ADD`,
				op: { action: op.action, draft: op.draft, target: op.target },
			});
			return { action: "ADD" as const, draft: op.draft };
		}
		if (guards.valueGate) {
			const dropped = valuesTheDraftDrops(target, draft);
			if (dropped.length > 0) {
				downgradedOps.push({
					reason: `target carries a value the draft does not restate (${dropped.slice(0, 6).join(", ")}); recorded as ADD`,
					op: { action: op.action, draft: op.draft, target: op.target },
				});
				return { action: "ADD" as const, draft: op.draft };
			}
		}
		return op;
	});
}
