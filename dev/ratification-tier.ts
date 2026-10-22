/**
 * Offline: what would a bounded durability tier change in the recency cut?
 *
 *   npx tsx dev/ratification-tier.ts --session <session.jsonl> [--bank <file>] [--cap 60000]
 *
 * No model calls and no code change: it takes the real bank file, marks the entries
 * whose source lines include a ratified proposal (an assistant turn a bare acceptance
 * settled), then replays `enforceBudget`'s rule with and without a protected tier and
 * reports exactly which facts change side.
 *
 * `enforceBudget` (src/bank.ts) sorts active entries newest-first and keeps filling to
 * the cap. The variant keeps protected facts first — newest-first inside the tier, and
 * capped at a share of the total so protection cannot starve the working set — then
 * fills the remainder by recency.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { foldLedger } from "../src/bank.js";
import type { LedgerRecord } from "../src/types.js";
import { ACCEPT_MAX_CHARS, ACCEPTANCE, type Entry, loadSession } from "./ratification-analysis.js";

type Row = Record<string, any>;

function arg(flag: string, fallback: string): string {
	const at = process.argv.indexOf(flag);
	return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

function numArg(flag: string, fallback: number): number {
	const at = process.argv.indexOf(flag);
	return at >= 0 ? Number(process.argv[at + 1]) : fallback;
}

/** Proposal entry ids that a bare acceptance settled. */
function ratifiedIds(entries: Entry[]): Set<string> {
	const ids = new Set<string>();
	for (const e of entries) {
		if (e.role !== "user") continue;
		const text = e.text.trim();
		if (!text || text.length > ACCEPT_MAX_CHARS || !ACCEPTANCE.test(text)) continue;
		for (let i = e.index - 1; i >= 0; i--) {
			const prev = entries[i];
			if (prev.role === "assistant" && prev.text.trim()) {
				ids.add(prev.id);
				break;
			}
			if (prev.role === "user") break;
		}
	}
	return ids;
}

/** Same walk as `enforceBudget`: newest-first, keep what fits, skipping what doesn't. */
function recencyCut(active: Row[], cap: number): Set<string> {
	const ordered = [...active].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
	let kept = 0;
	const ids = new Set<string>();
	for (const entry of ordered) {
		if (kept + entry.tokenCount > cap) continue;
		kept += entry.tokenCount;
		ids.add(entry.id);
	}
	return ids;
}

/** Which class the replay protects: `user`, `ratified`, or their union (default). */
function protectMode(): string {
	if (process.argv.includes("--protect-user")) return "user";
	if (process.argv.includes("--protect-ratified")) return "ratified";
	return "both";
}

function tierCut(active: Row[], cap: number, protectedShare: number): { kept: Set<string>; tierTokens: number } {
	const protectedMax = Math.floor(cap * protectedShare);
	const mode = protectMode();
	const isProtected = (e: Row): boolean =>
		mode === "user"
			? e.fromUser === true
			: mode === "ratified"
				? e.ratified === true
				: e.fromUser === true || e.ratified === true;
	const byRecency = (a: Row, b: Row): number => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);
	const protectedEntries = active.filter(isProtected).sort(byRecency);
	const rest = active.filter((e) => !isProtected(e)).sort(byRecency);

	const kept = new Set<string>();
	let used = 0;
	let tierTokens = 0;
	for (const entry of protectedEntries) {
		if (tierTokens + entry.tokenCount > protectedMax) continue;
		if (used + entry.tokenCount > cap) continue;
		tierTokens += entry.tokenCount;
		used += entry.tokenCount;
		kept.add(entry.id);
	}
	for (const entry of rest) {
		if (used + entry.tokenCount > cap) continue;
		used += entry.tokenCount;
		kept.add(entry.id);
	}
	return { kept, tierTokens };
}

function main(): void {
	const sessionPath = arg("--session", "");
	if (!sessionPath) throw new Error("--session <session.jsonl> is required");
	const sessionId = (sessionPath.match(/(01a[0-9a-f-]{30,})/)?.[1] ?? "").slice(0, 36);
	const cap = numArg("--cap", 60000);
	const share = numArg("--share", 0.15);
	const ratified = ratifiedIds(loadSession(sessionPath));
	const stateDir = join(homedir(), ".pi", "agent", "pi-hy-memory", "state", "sessions");

	const parseLines = (path: string): Row[] =>
		readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => {
				try {
					return JSON.parse(line) as Row;
				} catch {
					return undefined;
				}
			})
			.filter((row): row is Row => row !== undefined);

	// `--fold` replays the ledger instead of the bank file. Budget eviction is never
	// written to the ledger, so the fold is the only state that is genuinely over the
	// cap: the bank file has already been trimmed, which makes the cut a no-op there.
	let rows: Row[];
	let source: string;
	if (process.argv.includes("--fold")) {
		const ledgerPath = arg("--ledger", join(stateDir, `${sessionId}.ledger.jsonl`));
		if (!existsSync(ledgerPath)) throw Error(`ledger not found: ${ledgerPath}`);
		const records = parseLines(ledgerPath).filter((r) => r.type === "hy.extract" || r.type === "hy.ops");
		rows = foldLedger(records as LedgerRecord[]).filter((e) => e.status === "active");
		source = `ledger fold ${ledgerPath.split("/").pop()}`;
	} else {
		const bankPath = arg("--bank", join(stateDir, `${sessionId}.bank.json`));
		if (!existsSync(bankPath)) throw Error(`bank not found: ${bankPath}`);
		rows = (JSON.parse(readFileSync(bankPath, "utf8")) as Row[]).filter((e) => e.status === "active");
		source = `bank file ${bankPath.split("/").pop()}`;
	}
	const active: Row[] = rows.map((e) => ({
		...e,
		ratified: ((e.sourceEntryIds ?? []) as string[]).some((id) => ratified.has(id)),
	}));

	const tokens = (list: Row[]): number => list.reduce((s, e) => s + (e.tokenCount ?? 0), 0);
	const current = recencyCut(active, cap);
	const tiered = tierCut(active, cap, share);

	const activeRatified = active.filter((e) => e.ratified);
	const activeUser = active.filter((e) => e.fromUser === true);
	const droppedNow = active.filter((e) => !current.has(e.id));
	const droppedTiered = active.filter((e) => !tiered.kept.has(e.id));

	const rescued = droppedNow.filter((e) => tiered.kept.has(e.id));
	const sacrificed = droppedTiered.filter((e) => current.has(e.id));

	console.log(`state  ${source}`);
	console.log(
		`active ${active.length} facts / ${tokens(active)} tokens, cap ${cap} (share ${(share * 100).toFixed(0)} % = ${Math.floor(cap * share)} tokens)`,
	);
	console.log(
		`marked ratified ${activeRatified.length} facts / ${tokens(activeRatified)} tokens, fromUser ${activeUser.length}`,
	);
	console.log(
		`\nrecency only  — kept ${current.size}, dropped ${droppedNow.length}, dropped ratified ${droppedNow.filter((e) => e.ratified).length}`,
	);
	console.log(
		`tiered        — kept ${tiered.kept.size}, dropped ${droppedTiered.length}, tier spend ${tiered.tierTokens} tokens`,
	);
	if (process.argv.includes("--explain")) {
		const mode = protectMode();
		const candidates = active
			.filter((e) => e.fromUser === true || e.ratified === true)
			.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
		console.log(`protected candidates (mode ${mode}): ${candidates.length}`);
		for (const e of candidates) {
			const flags = [e.fromUser === true ? "user" : "", e.ratified === true ? "ratified" : ""]
				.filter(Boolean)
				.join("+");
			console.log(
				`  ${tiered.kept.has(e.id) ? "kept  " : "EVICT "}  ${String(e.tokenCount).padStart(3)} tok  [${flags}]  ${String(e.task).slice(0, 48)} :: ${String(e.statement).slice(0, 70)}`,
			);
		}
	}
	console.log(`\nrescued by the tier: ${rescued.length}`);
	for (const e of rescued.slice(0, 12))
		console.log(`  + ${e.tokenCount} tok  ${String(e.task).slice(0, 60)} :: ${String(e.statement).slice(0, 100)}`);
	console.log(`\npushed out by the tier: ${sacrificed.length}`);
	for (const e of sacrificed.slice(0, 12))
		console.log(`  − ${e.tokenCount} tok  ${String(e.task).slice(0, 60)} :: ${String(e.statement).slice(0, 100)}`);
}

main();
