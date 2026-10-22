/**
 * Offline: can a "ratified constraint" class be derived without asking the
 * writer for a new field?
 *
 *   npx tsx dev/ratification-analysis.ts --session <session.jsonl> [--ledger <file>]
 *
 * Reads a real session transcript plus the extension's ledger for the same
 * session, reconstructs the chunk windows the writer actually saw (from each
 * `hy.extract` record's `coversUpToId`), and answers three questions:
 *
 *  1. Which lines do drafts cite? (`refs` are trained provenance; the class
 *     must be derivable from the cited line's role, not from a self-report.)
 *  2. Is ratification inside the writer's window? A short acceptance turn
 *     ("proceed", "ok") settles the preceding assistant proposal. If the
 *     proposal and the acceptance land in different chunks, the extract call
 *     that wrote the fact never saw the acceptance.
 *  3. Does the proposal look like a decision or a status report? A gate that
 *     ratifies status reports protects noise.
 *
 * No model calls: every number is a replay of what the writer already did.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Row = Record<string, any>;

function arg(flag: string, fallback = ""): string {
	const at = process.argv.indexOf(flag);
	return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

/** Short turns that settle whatever the assistant just proposed. */
export const ACCEPTANCE =
	/^(ok|okay|k|ok done|yes|yep|yeah|sure|fine|right|go|go ahead|proceed|do it|do that|continue|keep going|nice|nice one|cool|thanks|ty|y|done|looks good|lgtm|merged|pushed|ship it|go for it|that works|works)\b[\s.!]*$/i;
export const ACCEPT_MAX_CHARS = 24;

/** A proposal worth protecting: it commits to doing, keeping, rejecting or naming. */
export const DECISION =
	/\b(settled|decided|decide|decision|rule|default|instead|reject|won'?t|will not|must|never|always|keep|drop|remove|rename|replace|use |use\b|going to|proposal|recommend|should|switch|prefer|because)\b/i;
/** A progress report: no commitment in it, so nothing to ratify. */
export const STATUS =
	/^(committing|committed|pushed|running|ran|tested|done —|done:|now |next |waiting|checking|reading|working on|writing|updating|fixing|retrying|spawning|waiting for)/i;

export interface Entry {
	id: string;
	index: number;
	role: string;
	text: string;
	timestamp: number;
}

export function loadSession(path: string): Entry[] {
	const out: Entry[] = [];
	let index = 0;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let row: Row;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (row.type !== "message") continue;
		const msg = row.message ?? {};
		const role: string = msg.role ?? "unknown";
		const parts = Array.isArray(msg.content) ? msg.content : [];
		let text = "";
		if (role === "toolResult") {
			text = parts
				.filter((p: Row) => p && typeof p === "object" && p.type === "text")
				.map((p: Row) => String(p.text ?? ""))
				.join("\n");
		} else if (typeof msg.content === "string") {
			text = msg.content;
		} else {
			text = parts
				.filter((p: Row) => p && typeof p === "object" && (p.type === "text" || p.type === "thinking"))
				.filter((p: Row) => p.type === "text")
				.map((p: Row) => String(p.text ?? ""))
				.join("\n");
		}
		out.push({ id: String(row.id ?? ""), index: index++, role, text, timestamp: Number(row.timestamp ?? 0) });
	}
	return out;
}

/** Rebuild chunk windows: each extract record covers entries up to `coversUpToId`. */
export function buildWindows(
	ledgerPath: string,
	byId: Map<string, Entry>,
): { chunkId: string; from: number; to: number }[] {
	const records: Row[] = [];
	for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line));
		} catch {
			/* skip */
		}
	}
	const extracts = records.filter((r) => r.type === "hy.extract" && r.coversUpToId);
	const seen = new Set<string>();
	const deduped = extracts.filter((r) => {
		if (seen.has(String(r.chunkId))) return false;
		seen.add(String(r.chunkId));
		return true;
	});
	deduped.sort((a, b) => String(a.chunkId).localeCompare(String(b.chunkId)));
	const windows: { chunkId: string; from: number; to: number }[] = [];
	let cursor = -1;
	for (const r of deduped) {
		const end = byId.get(String(r.coversUpToId))?.index;
		if (end === undefined || end < cursor) continue;
		windows.push({ chunkId: String(r.chunkId), from: cursor + 1, to: end });
		cursor = end;
	}
	return windows;
}

function main(): void {
	const sessionPath = arg("--session");
	if (!sessionPath) {
		console.error("usage: npx tsx dev/ratification-analysis.ts --session <file.jsonl> [--ledger <file>]");
		process.exit(1);
	}
	const sessionId = (arg("--session-id") || sessionPath.match(/(01a[0-9a-f-]{30,})/)?.[1] || "").slice(0, 36);
	const stateDir = arg("--state", join(homedir(), ".pi", "agent", "pi-hy-memory", "state", "sessions"));
	const ledgerPath = arg("--ledger", join(stateDir, `${sessionId}.ledger.jsonl`));
	if (!existsSync(ledgerPath)) {
		console.error(`ledger not found: ${ledgerPath}`);
		process.exit(1);
	}

	const entries = loadSession(sessionPath);
	const byId = new Map(entries.map((e) => [e.id, e]));
	const windows = buildWindows(ledgerPath, byId);
	const chunkOf = new Map<number, string>();
	for (const w of windows) for (let i = w.from; i <= w.to; i++) chunkOf.set(i, w.chunkId);

	const records: Row[] = [];
	for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line));
		} catch {
			/* skip */
		}
	}
	const extracts = new Map<string, Row>();
	for (const r of records)
		if (r.type === "hy.extract" && !extracts.has(String(r.chunkId))) extracts.set(String(r.chunkId), r);
	const ops = new Map<string, Row>();
	for (const r of records) if (r.type === "hy.ops") ops.set(String(r.chunkId), r);

	// Q1 — what roles do drafts cite?
	const cite = { user: 0, assistant: 0, tool: 0, other: 0, mixedUserAssistant: 0 };
	let drafts = 0;
	let draftsOnlyAssistant = 0;
	for (const rec of extracts.values()) {
		for (const draft of (rec.drafts ?? []) as Row[]) {
			drafts++;
			const roles = new Set(
				((draft.sourceEntryIds ?? []) as string[]).map((id) => byId.get(id)?.role ?? "other"),
			);
			if (roles.has("user")) cite.user++;
			if (roles.has("assistant")) cite.assistant++;
			if (roles.has("toolResult")) cite.tool++;
			if (![...roles].some((r) => r === "user" || r === "assistant" || r === "toolResult")) cite.other++;
			if (roles.has("user") && roles.has("assistant")) cite.mixedUserAssistant++;
			if (!roles.has("user") && roles.has("assistant")) draftsOnlyAssistant++;
		}
	}

	// Q2 — acceptance turns and how far the proposal sits from them.
	const acceptances: { entry: Entry; proposal?: Entry; sameChunk: boolean; citedByLater: number }[] = [];
	for (const e of entries) {
		if (e.role !== "user") continue;
		const text = e.text.trim();
		if (text.length === 0 || text.length > ACCEPT_MAX_CHARS || !ACCEPTANCE.test(text)) continue;
		let proposal: Entry | undefined;
		for (let i = e.index - 1; i >= 0; i--) {
			const prev = entries[i];
			if (prev.role === "assistant" && prev.text.trim().length > 0) {
				proposal = prev;
				break;
			}
			if (prev.role === "user") break;
		}
		const sameChunk = proposal ? chunkOf.get(proposal.index) === chunkOf.get(e.index) : false;
		// Drafts in the acceptance's own chunk that cite the proposal line.
		const acceptanceChunk = chunkOf.get(e.index);
		let citedByLater = 0;
		if (proposal && acceptanceChunk) {
			const rec = extracts.get(acceptanceChunk);
			for (const draft of (rec?.drafts ?? []) as Row[]) {
				if (((draft.sourceEntryIds ?? []) as string[]).includes(proposal.id)) citedByLater++;
			}
		}
		acceptances.push({ entry: e, proposal, sameChunk, citedByLater });
	}

	// Q3 — is the ratified proposal a decision or a status report?
	const gate = { proposalFound: 0, decisionish: 0, statusish: 0, neither: 0 };
	for (const a of acceptances) {
		if (!a.proposal) continue;
		gate.proposalFound++;
		const tail = a.proposal.text.slice(-900);
		const isStatus = STATUS.test(a.proposal.text.trim().slice(0, 60));
		if (isStatus) gate.statusish++;
		else if (DECISION.test(tail)) gate.decisionish++;
		else gate.neither++;
	}

	// Volume — accepted drafts that cite a ratified proposal line.
	const ratifiedIds = new Set(acceptances.map((a) => a.proposal?.id).filter(Boolean) as string[]);
	let acceptedRatified = 0;
	let acceptedTotal = 0;
	let acceptedTokens = 0;
	let ratifiedTokens = 0;
	for (const [chunkId, rec] of ops) {
		const extract = extracts.get(chunkId);
		const draftsHere = (extract?.drafts ?? []) as Row[];
		for (const op of (rec.ops ?? []) as Row[]) {
			if (op.action !== "ADD" && op.action !== "UPDATE") continue;
			const draft = draftsHere[Number(op.draft)];
			if (!draft) continue;
			acceptedTotal++;
			const tokens = Math.ceil(String(draft.statement ?? "").length / 4);
			acceptedTokens += tokens;
			if (((draft.sourceEntryIds ?? []) as string[]).some((id) => ratifiedIds.has(id))) {
				acceptedRatified++;
				ratifiedTokens += tokens;
			}
		}
	}

	const userTurns = entries.filter((e) => e.role === "user" && e.text.trim()).length;
	console.log(`session   ${sessionId}`);
	console.log(`entries   ${entries.length} (message entries) | user turns ${userTurns} | chunks ${windows.length}`);
	console.log(
		`\nQ1 draft citations (${drafts} drafts) — user ${cite.user}, assistant ${cite.assistant}, tool ${cite.tool}, other ${cite.other}`,
	);
	console.log(`   assistant-only (a user constraint reported through prose): ${draftsOnlyAssistant}`);
	console.log(`   user+assistant mix: ${cite.mixedUserAssistant}`);
	console.log(
		`\nQ2 acceptance turns — ${acceptances.length} (${Math.round((acceptances.length / Math.max(1, userTurns)) * 100)}% of user turns)`,
	);
	console.log(`   proposal in the SAME chunk as the acceptance: ${acceptances.filter((a) => a.sameChunk).length}`);
	console.log(`   proposal in an EARLIER chunk: ${acceptances.filter((a) => a.proposal && !a.sameChunk).length}`);
	console.log(`   no preceding assistant proposal: ${acceptances.filter((a) => !a.proposal).length}`);
	console.log(
		`   acceptance chunk has a draft citing the proposal: ${acceptances.filter((a) => a.citedByLater > 0).length}`,
	);
	console.log(
		`\nQ3 gate on the ratified proposal — found ${gate.proposalFound}: decisionish ${gate.decisionish}, status-report ${gate.statusish}, neither ${gate.neither}`,
	);
	console.log(
		`\nVolume — accepted drafts citing a ratified proposal: ${acceptedRatified} of ${acceptedTotal} (~${ratifiedTokens} tokens)`,
	);
	console.log(
		`   protected tier would hold ${ratifiedTokens} of ${acceptedTokens} accepted tokens (${Math.round((ratifiedTokens / Math.max(1, acceptedTokens)) * 100)}%)`,
	);

	console.log(`\nsamples (acceptance → proposal head):`);
	for (const a of acceptances.slice(0, 14)) {
		const head = a.proposal ? a.proposal.text.trim().replace(/\s+/g, " ").slice(0, 110) : "(none)";
		const flag = a.proposal
			? STATUS.test(a.proposal.text.trim().slice(0, 60))
				? "status"
				: DECISION.test(a.proposal.text.slice(-900))
					? "decision"
					: "neither"
			: "-";
		console.log(
			`  "${a.entry.text.trim().slice(0, 14)}" [${flag}] ${a.sameChunk ? "same-chunk" : "cross-chunk"} → ${head}`,
		);
	}
}

if (process.argv[1] && process.argv[1].endsWith("ratification-analysis.ts")) main();
