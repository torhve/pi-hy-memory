#!/usr/bin/env npx tsx
import { createHash } from "node:crypto";
/**
 * Synthesize a compaction summary from a real session and a real bank, in two arms:
 *
 *   **today**   — what pi-hy-memory renders now: the bank selection plus pi's file lists.
 *   **proposed** — the same bank selection with `--brief` tokens carved out of the summary
 *                 cap, and pi-vcc's deterministic sections and ranked brief underneath it.
 *
 * Nothing here calls a model. The cut is hy's own `compactionBoundary`, the facts are
 * hy's own `renderMemory` with hy's own shares, and the skeleton is pi-vcc's own
 * `compileRanked` run over the same prefix. The bank comes from a PoC run of the real
 * writer over the same session file, so both arms are answering with real memory.
 *
 *     npx tsx dev/hyvcc-demo.ts \
 *       --session ~/.pi/agent/sessions/<dir>/<file>.jsonl \
 *       --bank out/halves-2026-10-21/bank.json \
 *       [--snapshot] [--fixture out/hyvcc-fixture] \
 *       [--window last|<k>|branch] [--keep 6000] [--brief 1500] [--summary 8000]
 *       [--track none] [--out out/hyvcc-demo] [--vcc /tmp/pi-vcc/src/core]
 *
 * `--snapshot` freezes both inputs into `--fixture` (default `out/hyvcc-fixture/`) with a manifest
 * naming what was copied — bytes, entry count and a content digest per leg. `--fixture` measures
 * that copy and needs no `--session` / `--bank`. Without them the harness measures live files and
 * says so on the first line of its report, because a live session file is a moving target.
 *
 * Output goes to `--out` (default `out/hyvcc-demo/`, gitignored) and to stdout. Text is
 * redacted on the way out: absolute paths under a home directory, project directory names,
 * `sk-…` keys and `Bearer …` tokens. `--no-redact` keeps them for local reading only.
 * The block is also fed back to itself as `previousSummary` — a second compaction of identical
 * content — which is the cheap half of S5 in `DESIGN_HYVCC.md`: how much of a stored skeleton
 * survives its own merge, and what the merge costs to do it.
 *
 * See `DESIGN_HYVCC.md` § "A synthesized compaction, from a real session".
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { compactionBoundary, entryTokens, fileOperations, serializeEntries } from "../src/entries.js";
import { renderFileOperations, renderMemory, summaryBudget } from "../src/render.js";
import { type BankEntry, estimateTokens } from "../src/types.js";

type Entry = { type: string; id: string; message?: Record<string, unknown>; timestamp?: string };

/**
 * A frozen copy of the two inputs, with an identity.
 *
 * The session file a spike measures against is a *live* pi file: it was 44.5 MB and
 * still being appended to when this harness last read it, and the numbers it printed then
 * cannot be reproduced from it now. Every published figure therefore has to name the copy
 * it came from, the way `dev/live-bank-report.ts --snapshot` names its copy — otherwise a
 * design document quotes an measurement of a moving target, and a two-arm A/B run compares
 * two different files without saying so.
 *
 * The manifest names both legs. Naming only the session would leave the bank free to drift
 * while the numbers look pinned. It records no paths and no session directory names, so
 * quoting the identity line in a document cannot leak where the session was taken.
 */
export type FixtureManifest = {
	takenAt: string;
	session: { label: string; bytes: number; sha: string; entries: number };
	bank: { bytes: number; sha: string; facts: number; active: number; userStated: number };
};

export const sha12 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

/**
 * `01a1787f…8bc63` — pi names a session file `<timestamp>_<uuid>.jsonl`, and the uuid is the
 * part worth quoting. Naming the timestamp and the project directory would say where the
 * session was taken as well as which one it was.
 */
export function sessionLabel(file: string): string {
	const name = (file.split("/").pop() ?? file).replace(/\.jsonl$/, "");
	const uuid = (name.split("_").pop() ?? name).replace(/[^0-9a-f-]/gi, "");
	return uuid.length <= 14 ? uuid : `${uuid.slice(0, 8)}…${uuid.slice(-5)}`;
}

/**
 * Freeze both legs into `dir` — the session copy, the bank copy, and a manifest naming what
 * was copied. Writing the copies here rather than at the call site is the point: a caller
 * cannot freeze one leg and forget the other.
 */
export function writeFixture(args: {
	dir: string;
	sessionFile: string;
	bankFile: string;
	sessionText: string;
	bankText: string;
}): FixtureManifest {
	const bank = JSON.parse(args.bankText) as { status?: string; fromUser?: boolean }[];
	const manifest: FixtureManifest = {
		takenAt: new Date().toISOString(),
		session: {
			label: sessionLabel(args.sessionFile),
			bytes: Buffer.byteLength(args.sessionText),
			sha: sha12(args.sessionText),
			entries: args.sessionText.split("\n").filter((l) => l.trim()).length,
		},
		bank: {
			bytes: Buffer.byteLength(args.bankText),
			sha: sha12(args.bankText),
			facts: bank.length,
			active: bank.filter((e) => e.status === "active").length,
			userStated: bank.filter((e) => e.fromUser === true).length,
		},
	};
	mkdirSync(args.dir, { recursive: true });
	writeFileSync(join(args.dir, "session.jsonl"), args.sessionText);
	writeFileSync(join(args.dir, "bank.json"), args.bankText);
	writeFileSync(join(args.dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	return manifest;
}

export function readFixture(dir: string): FixtureManifest | null {
	const path = join(dir, "manifest.json");
	if (!existsSync(path)) return null;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<FixtureManifest>;
		if (!raw.session || !raw.bank || typeof raw.takenAt !== "string") return null;
		const session = raw.session as FixtureManifest["session"];
		const bank = raw.bank as FixtureManifest["bank"];
		return typeof session.sha === "string" && typeof bank.sha === "string" ? (raw as FixtureManifest) : null;
	} catch {
		return null;
	}
}

/**
 * The line printed before any number. It says which copy produced them, and whether the files
 * being read still match that copy. A live file with no manifest is called what it is.
 */
export function copyIdentity(args: {
	fixtureDir?: string;
	manifest?: FixtureManifest;
	sessionText: string;
	bankText: string;
	sessionFile: string;
}): string {
	if (!args.manifest) {
		const mtimeS = Math.max(0, Math.round((Date.now() - statSync(args.sessionFile).mtimeMs) / 1000));
		const stale =
			mtimeS < 900
				? `last written ${mtimeS} s ago, so these numbers are one reading of a moving target and cannot be re-run`
				: `last written ${mtimeS} s ago`;
		return (
			`copy identity  none. No manifest names a copy: the numbers come from ` +
			`${args.sessionFile.split("/").pop()}, ${stale}`
		);
	}
	const { manifest } = args;
	const sessionSha = sha12(args.sessionText);
	const bankSha = sha12(args.bankText);
	const moved: string[] = [];
	if (sessionSha !== manifest.session.sha)
		moved.push(`session copy now ${sessionSha} against ${manifest.session.sha} recorded`);
	if (bankSha !== manifest.bank.sha) moved.push(`bank copy now ${bankSha} against ${manifest.bank.sha} recorded`);
	// Only the copy's last path segment: an identity quoted into a document must name the copy,
	// not the directory it was taken into.
	const named = (args.fixtureDir ?? "fixture").split("/").filter(Boolean).pop() ?? "fixture";
	return (
		`copy identity  ${named} taken ${manifest.takenAt}, session ${manifest.session.label} ` +
		`${manifest.session.bytes} bytes / ${manifest.session.entries} entries / sha ${manifest.session.sha}, ` +
		`bank ${manifest.bank.bytes} bytes / ${manifest.bank.facts} facts (${manifest.bank.active} active, ` +
		`${manifest.bank.userStated} user-stated) / sha ${manifest.bank.sha}` +
		(moved.length > 0 ? ` — MOVED: ${moved.join("; ")}` : "")
	);
}
/** The roles that are conversation content. pi >= 1.0 persists the loadout as `system`. */
const LIVE_ROLES = new Set(["user", "assistant", "toolResult", "bashExecution"]);

function parseArgs(argv: string[]): Record<string, string | boolean> {
	const out: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) out[key] = true;
		else {
			out[key] = next;
			i++;
		}
	}
	return out;
}
/** Session JSONL -> entries. Malformed lines are skipped, as pi's own loader does: a file
 * caught mid-append contributes every whole record it holds, and the manifest's entry count
 * says whether one was lost. */
export function parseSession(text: string): Entry[] {
	const out: Entry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line) as Entry;
			if (e && typeof e.id === "string") out.push(e);
		} catch {
			// pi drops corrupt lines; so do we.
		}
	}
	return out;
}

/**
 * The session-global `#N` space, counting every `type === "message"` entry in file order —
 * the same rule pi-vcc's recall and its summaries share, so a ref a summary prints is a
 * ref the recall tool resolves.
 */
function globalIndex(entries: Entry[]): Map<string, number> {
	const map = new Map<string, number>();
	const ambiguous = new Set<string>();
	let index = 0;
	for (const e of entries) {
		if (e.type !== "message" || !e.message) continue;
		if (map.has(e.id) || ambiguous.has(e.id)) {
			map.delete(e.id);
			ambiguous.add(e.id);
		} else map.set(e.id, index);
		index++;
	}
	return map;
}

/** Home paths, project dir names, and credentials never leave the machine. */
function redact(text: string): string {
	return text
		.replace(/\/Users\/[^/\s"']+/g, "~")
		.replace(/(^|\/)--[\w.-]+--/g, "$1<project>")
		.replace(/\bsk-[A-Za-z0-9._-]{6,}/gi, "sk-…")
		.replace(/\bBearer\s+[A-Za-z0-9._-]{6,}/gi, "Bearer …");
}

const SECTION_RE = /^\[[A-Z][^\]\n]*\]$/;
/** The brief's own group headers, which are lowercase — `[user]`, `[assistant]`. */
const BRIEF_HEADER_RE = /^\[(?:user|assistant|bash|tool|custom)\]$/;
/** The section block and the ranked brief under it, with sizes and `(#N)` ref counts. */
function skeletonHalves(skeleton: string) {
	const lines = skeleton.split("\n");
	const i = lines.findIndex((line) => BRIEF_HEADER_RE.test(line) || /^\d+\.\s/.test(line));
	const parts = i < 0 ? [lines, [] as string[]] : [lines.slice(0, i), lines.slice(i)];
	const refs = (list: string[]) => (list.join("\n").match(/\(#\d+\)/g) ?? []).length;
	return {
		sectionsTokens: estimateTokens(parts[0].join("\n")),
		briefTokens: estimateTokens(parts[1].join("\n")),
		sectionsRefs: refs(parts[0]),
		briefRefs: refs(parts[1]),
	};
}

/** Line and token counts per `[Section]` of a compiled skeleton, in the order they appear. */
function sectionBreakdown(text: string): { title: string; lines: number; tokens: number }[] {
	const out: { title: string; lines: number; tokens: number }[] = [];
	let current: { title: string; lines: number; tokens: number } | undefined;
	let preamble = 0;
	// The ranked brief is appended after the sections and has no header of its own; its lines
	// are numbered. Everything after the first numbered line belongs to the brief.
	const brief = { title: "(ranked brief transcript)", lines: 0, tokens: 0 };
	let inBrief = false;
	for (const line of text.split("\n")) {
		if (!inBrief && (BRIEF_HEADER_RE.test(line) || /^\d+\.\s/.test(line))) inBrief = true;
		if (inBrief) {
			if (line.trim()) brief.lines++;
			brief.tokens += estimateTokens(`${line}\n`);
			continue;
		}
		if (SECTION_RE.test(line)) {
			if (current) out.push(current);
			current = { title: line, lines: 0, tokens: 0 };
			continue;
		}
		if (!current) {
			preamble += estimateTokens(`${line}\n`);
			continue;
		}
		if (line.trim()) current.lines++;
		current.tokens += estimateTokens(`${line}\n`);
	}
	if (current) out.push(current);
	if (brief.lines > 0) out.push(brief);
	if (preamble > 0) out.unshift({ title: "(preamble)", lines: 0, tokens: preamble });
	return out;
}

export async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const session = String(args.session ?? "");
	const bankFile = String(args.bank ?? "");
	const fixture = typeof args.fixture === "string" ? args.fixture : undefined;
	// `--snapshot` copies what it is given and measures the copy. `--fixture` measures a copy
	// frozen earlier and needs no --session / --bank: the copy names itself. With neither, the
	// numbers come from live files and the identity line says that out loud.
	const fixtureDir = fixture ?? (args.snapshot ? "out/hyvcc-fixture" : undefined);
	if (args.snapshot && (!session || !bankFile)) {
		console.error("usage: --snapshot needs --session and --bank to copy from");
		process.exit(1);
	}
	if (!fixtureDir && (!session || !bankFile)) {
		console.error(
			"usage: hyvcc-demo.ts --session <file.jsonl> --bank <bank.json> [--snapshot] [--fixture <dir>] [--keep 6000] [--brief 1500]",
		);
		process.exit(1);
	}
	const keep = Number(args.keep ?? 6000);
	const briefTokens = Number(args.brief ?? 1500);
	const summaryMax = Number(args.summary ?? 8000);
	const redactOn = !args["no-redact"];
	const vccCore = String(args.vcc ?? "/tmp/pi-vcc/src/core");
	const dir = String(args.out ?? "out/hyvcc-demo");

	// A spike measures against a copy, not against a file that is still being appended to.
	// `--snapshot` freezes both legs and names what it copied; `--fixture` reads that copy back.
	// Without either, the numbers come from a live file and the identity line says so.
	if (args.snapshot && fixtureDir) {
		const copiedSession = readFileSync(session, "utf8");
		const copiedBank = readFileSync(bankFile, "utf8");
		const frozen = writeFixture({
			dir: fixtureDir,
			sessionFile: session,
			bankFile,
			sessionText: copiedSession,
			bankText: copiedBank,
		});
		console.log(
			`frozen ${fixtureDir}: session ${frozen.session.bytes} bytes / ${frozen.session.entries} entries / sha ${frozen.session.sha}; bank ${frozen.bank.bytes} bytes / ${frozen.bank.facts} facts / sha ${frozen.bank.sha}; taken ${frozen.takenAt}`,
		);
	}
	const sourceSession = fixtureDir ? join(fixtureDir, "session.jsonl") : session;
	const sourceBank = fixtureDir ? join(fixtureDir, "bank.json") : bankFile;
	const sessionText = readFileSync(sourceSession, "utf8");
	const bankText = readFileSync(sourceBank, "utf8");
	const all = parseSession(sessionText);
	const identity = copyIdentity({
		fixtureDir,
		manifest: fixtureDir ? (readFixture(fixtureDir) ?? undefined) : undefined,
		sessionText,
		bankText,
		sessionFile: sourceSession,
	});
	const live = all.filter((e) => e.type === "message" && LIVE_ROLES.has(String(e.message?.role)));
	const byId = globalIndex(all);

	// The window pi would actually compact: everything the last compaction kept forward.
	// `--window branch` replays the whole branch instead, which is the stress case rather than
	// the real one, and is useful for watching the sections saturate their caps.
	// `--window <k>` picks the k-th compaction in file order, which is how the shape gets read at
	// an early, middle and late window instead of only the last one.
	const windowMode = String(args.window ?? "last");
	let scope = live;
	let lastCompaction: Entry | undefined;
	if (windowMode === "last" || /^\d+$/.test(windowMode)) {
		const compactions = all.filter((e) => e.type === "compaction");
		lastCompaction = windowMode === "last" ? compactions.at(-1) : compactions[Number(windowMode) - 1];
		const keptIndex = lastCompaction
			? all.findIndex((e) => e.id === (lastCompaction as { firstKeptEntryId?: string }).firstKeptEntryId)
			: -1;
		// pi-vcc's orphan recovery: a `firstKeptEntryId` that no longer names an entry in the
		// branch means the window starts after the compaction entry itself.
		const from = keptIndex >= 0 ? keptIndex : lastCompaction ? all.indexOf(lastCompaction) : 0;
		const after = new Set(all.slice(from + 1).map((e) => e.id));
		scope = live.filter((e) => after.has(e.id));
	}
	if (scope.length < 3) {
		console.error("window too small; run with --window branch");
		process.exit(1);
	}

	// hy's own cut. No watermark is supplied: this is a replay, so the safe window stands.
	const cut = compactionBoundary(scope as never, {
		cursorId: undefined,
		keepRecentTokens: keep,
		proposedId: undefined,
		maxUncoveredTokens: 6000,
		maxKeepTokens: undefined,
	});
	const prefix = scope.slice(0, cut.firstKeptIndex);
	const tail = scope.slice(cut.firstKeptIndex);
	const prefixTokens = prefix.reduce((s, e) => s + entryTokens(e as never), 0);
	const userTurns = prefix.filter((e) => e.message?.role === "user").length;
	const digest = serializeEntries(prefix.slice(-40) as never, { maxTokens: 1500, maxEntryChars: 240 });

	const bank = JSON.parse(bankText) as BankEntry[];
	const selection = { foundationAfterChunks: 8, constraintShare: 0.1, foundationShare: 0.35 };
	const files = fileOperations(scope as never);
	const filesBlock = renderFileOperations(files);
	void lastCompaction;

	// pi-vcc's summarizer input, per message, so ids stay aligned by construction.
	const messages: never[] = [];
	const sourceIndices: (number | undefined)[] = [];
	for (const e of prefix) {
		const converted = convertToLlm([e.message as never]) as never[];
		if (converted.length === 0) continue;
		messages.push(...converted);
		sourceIndices.push(byId.get(e.id));
	}

	const summarize = await import(`${vccCore}/summarize.ts`);
	const format = await import(`${vccCore}/format.ts`);
	const compileRanked = summarize.compileRanked as (input: unknown) => string;
	const CHARS_PER_TOKEN = 4;
	// pi-vcc's command ledger is opt-in upstream for exactly the reason hy would want it
	// opt-in: in a git-heavy window it is the bulk of the skeleton. `--track none` shows the cost.
	const track = args.track === "none" ? [] : ["git", "pnpm", "npm", "docker", "pytest", "kubectl"];
	const compile = (previousSummary: string | undefined): string =>
		compileRanked({
			messages: messages as never,
			sourceIndices,
			previousSummary,
			fileOps: { readFiles: files.readFiles, modifiedFiles: files.modifiedFiles },
			trackCommands: track,
			ranking: {
				maxBriefChars: 1100 * CHARS_PER_TOKEN,
				maxBriefCharsCeiling: 2000 * CHARS_PER_TOKEN,
				briefCharsPerBlock: 15 * CHARS_PER_TOKEN,
			},
		});
	const started = performance.now();
	const fresh = compile(undefined);
	const compileMs = performance.now() - started;
	// pi-vcc appends its own recall note; hy says its own.
	const skeleton = fresh.split(String(format.RECALL_NOTE)).join("").trimEnd();
	const recallNote =
		"\n\nUse `hy_recall` for a fact and the raw-session arm for anything the bank never held. Do not redo work listed as completed.";

	const factsToday = renderMemory(bank, summaryBudget(summaryMax, bank), selection);
	const factsProposed = renderMemory(bank, summaryBudget(Math.max(500, summaryMax - briefTokens), bank), selection);

	const today = `${factsToday}${filesBlock ? `\n\n${filesBlock}` : ""}`;
	const proposed = `${factsProposed}\n\n${skeleton}${filesBlock ? `\n\n${filesBlock}` : ""}${recallNote}`;

	// The compounding hazard, demonstrated rather than asserted: pi-vcc's merge parses the
	// previous summary by section shape and rolls its "brief" forward by line budget. Hand that
	// merge a memory block and count how much of the memory block comes back.
	const previous = String((lastCompaction as { summary?: string } | undefined)?.summary ?? "");
	const hazard = compile(factsToday);
	const factIds = [...factsToday.matchAll(/^\[([0-9a-f]{12})\]/gm)].map((m) => m[1]);
	const survivors = factIds.filter((id) => hazard.includes(id)).length;
	const hazardWithStored = previous ? compile(previous) : hazard;

	// S5's cheap first half: a second compaction over the same content, merging the skeleton it
	// just produced. Whether a stored skeleton grows or shrinks on its own is visible right here.
	const self = compile(skeleton);
	const ownLines = skeleton.split("\n").filter((line) => line.trim().length > 12 && !SECTION_RE.test(line));
	const selfKept = ownLines.filter((line) => self.includes(line)).length;

	// The split the first release hinges on: the section block carries no `(#N)` refs, so it is
	// useful without the transcript corpus; the ranked brief's refs die without it.
	const halves = skeletonHalves(skeleton);

	const rows = [
		["arm", "part", "chars", "tokens (chars/4)"],
		["today", "bank facts", String(factsToday.length), String(estimateTokens(factsToday))],
		["today", "pi file lists", String(filesBlock.length), String(estimateTokens(filesBlock))],
		["today", "TOTAL", String(today.length), String(estimateTokens(today))],
		["proposed", "bank facts", String(factsProposed.length), String(estimateTokens(factsProposed))],
		["proposed", "skeleton", String(skeleton.length), String(estimateTokens(skeleton))],
		["proposed", "pi file lists", String(filesBlock.length), String(estimateTokens(filesBlock))],
		["proposed", "recall note", String(recallNote.length), String(estimateTokens(recallNote))],
		["proposed", "TOTAL", String(proposed.length), String(estimateTokens(proposed))],
	]
		.map((r) => r.join("\t"))
		.join("\n");

	const report = [
		identity,
		`session           ${sourceSession}`,
		`bank              ${sourceBank}  (${bank.length} facts, ${bank.filter((e) => e.status === "active").length} active, ${bank.filter((e) => e.fromUser === true).length} user-stated)`,
		`branch            ${all.length} entries, ${live.length} live messages (system/bookkeeping excluded)`,
		`window            ${windowMode}: ${scope.length} live messages${lastCompaction ? ` after compaction ${(lastCompaction as { id?: string }).id}` : ""}`,
		`previous summary  ${previous ? `${previous.length} chars / ~${estimateTokens(previous)} tokens, stored in that compaction entry` : "none"} — hy ignores it, pi-vcc merges it`,
		`cut               hy compactionBoundary, keepRecentTokens ${keep} -> keep ${tail.length} entries / ~${cut.used} tokens; prefix ${prefix.length} entries / ~${prefixTokens} tokens`,
		`prefix turns      ${userTurns} user messages among ${prefix.length} entries (what the user-ask sections can draw on)`,
		`boundary          ${cut.boundary}${cut.trimmed ? `, trimmed ${cut.trimmed.entries} entries / ${cut.trimmed.tokens} tokens` : ""}${cut.wouldDrop ? `, wouldDrop ${cut.wouldDrop.entries}` : ""}`,
		`overflow digest   ${digest.text.length} chars / ~${estimateTokens(digest.text)} tokens (the last 40 prefix entries at 240 chars each, what hy ships today for unread ranges)`,
		`merge hazard      hy's fact block handed to the merge as previousSummary: ${survivors}/${factIds.length} fact ids still present, output ~${estimateTokens(hazard)} tokens; the session's own stored summary merged instead: ~${estimateTokens(hazardWithStored)} tokens`,
		`self-merge        a second compaction of the same prefix, merging the skeleton it produced: ${selfKept}/${ownLines.length} lines reappear verbatim, ~${estimateTokens(self)} tokens against ~${estimateTokens(skeleton)} fresh`,
		"",
		rows,
		"",
		"skeleton sections",
		...sectionBreakdown(skeleton).map((s) => `  ${s.title}\t${s.lines} lines\t~${s.tokens} tokens`),
		"",
		`command ledger    ${track.length ? `on (${track.join(", ")})` : "off"}`,
		`facts given up    ${estimateTokens(factsToday) - estimateTokens(factsProposed)} tokens (${factsToday.split("\n").length - factsProposed.split("\n").length} fact lines)`,
		`skeleton earned   ${estimateTokens(skeleton)} tokens, ${estimateTokens(skeleton) > briefTokens ? "OVER the configured budget — the compile is not capped by it" : "inside the configured budget"}`,
		`skeleton split     ${halves.sectionsTokens} tokens in the section block (${halves.sectionsRefs} refs), ${halves.briefTokens} tokens in the ranked brief (${halves.briefRefs} refs) — a (#N) the recall tool cannot resolve is a dead pointer`,
		`compile time      ${compileMs.toFixed(0)} ms for the skeleton over ${prefix.length} prefix entries, no model call (session file ${(statSync(sourceSession).size / 1e6).toFixed(1)} MB)`,
		`written           ${dir}/{today.md,proposed.md,report.md,hazard.md,self-merge.md}`,
	].join("\n");

	mkdirSync(dir, { recursive: true });
	const red = redactOn ? redact : (s: string): string => s;
	writeFileSync(`${dir}/today.md`, red(today));
	writeFileSync(`${dir}/proposed.md`, red(proposed));
	writeFileSync(`${dir}/report.md`, red(report));
	writeFileSync(`${dir}/hazard.md`, red(hazard));
	writeFileSync(`${dir}/self-merge.md`, red(self));
	console.log(red(report));
	console.log(`\n--- TODAY (first 1 200 chars) ---\n${red(today).slice(0, 1200)}`);
	console.log(`\n--- PROPOSED SKELETON ---\n${red(skeleton).slice(0, 6000)}`);
	console.log(
		`\n--- MERGE HAZARD, hy's facts fed to the merge (first 1 200 chars) ---\n${red(hazard).slice(0, 1200)}`,
	);
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
