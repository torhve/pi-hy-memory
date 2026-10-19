/**
 * Corpus capture: rebuild the exact chunk payloads this extension already wrote.
 *
 *   npx tsx dev/capture-session.ts [--session <id>] [--out captures-dev/]
 *
 * The extension stores every write as `hy.extract` / `hy.ops` ledger records whose
 * `coversUpToId` forms a contiguous coverage chain over the session branch. Walking
 * that chain in ledger order gives the entry window each chunk was built from; the
 * window is re-rendered with `src/entries.ts` — the same serializer the live write
 * path uses — so the capture text is byte-identical to what the writer saw.
 *
 * Validation per chunk (a capture is only written when the first two hold):
 *   - the last positional ref maps back to the record's `coversUpToId`;
 *   - every draft's `sourceEntryIds` resolves inside the window;
 *   - the audit `write_start` chunkTokens is within 2 % of the estimate here.
 *
 * Captures stay under `captures-dev/` (gitignored): they contain real transcripts.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SETTING_DEFAULTS } from "../src/config.js";
import { serializeEntries } from "../src/entries.js";
import { estimateTokens } from "../src/types.js";

type Row = Record<string, any>;

function arg(flag: string, fallback: string): string {
	const at = process.argv.indexOf(flag);
	return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

function readJsonl(path: string): Row[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Row);
}

function stateDir(): string {
	return process.env.PI_HY_MEMORY_STATE ?? join(homedir(), ".pi", "agent", "pi-hy-memory", "state");
}

function configMaxEntryChars(): number {
	const path = process.env.PI_HY_MEMORY_CONFIG ?? join(homedir(), ".pi", "agent", "pi-hy-memory.json");
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return typeof raw.maxEntryChars === "number" ? raw.maxEntryChars : SETTING_DEFAULTS.maxEntryChars;
	} catch {
		return SETTING_DEFAULTS.maxEntryChars;
	}
}

/** Find the session file for a session id under the pi sessions directory. */
function findSessionFile(sessionId: string): string {
	const env = process.env.PI_SESSION_FILE;
	if (env && env.endsWith(`_${sessionId}.jsonl`)) return env;
	const root = join(homedir(), ".pi", "agent", "sessions");
	const hits: string[] = [];
	for (const dir of readdirSync(root)) {
		const full = join(root, dir);
		try {
			for (const name of readdirSync(full)) {
				if (name.endsWith(`_${sessionId}.jsonl`)) hits.push(join(full, name));
			}
		} catch {
			/* not a directory */
		}
	}
	if (hits.length === 0) throw new Error(`no session file found for ${sessionId}`);
	hits.sort((a, b) => readFileSync(a, "utf8").length - readFileSync(b, "utf8").length);
	return hits[hits.length - 1];
}

/** Rebuild the current branch: parentId chain from the newest unreferenced row, reversed. */
function branchRows(path: string): Row[] {
	const rows = readJsonl(path).filter((r) => r.type !== "session");
	const byId = new Map<string, Row>(rows.map((r) => [r.id, r]));
	const referenced = new Set(rows.map((r) => r.parentId).filter(Boolean));
	const leaves = rows.filter((r) => !referenced.has(r.id));
	if (leaves.length === 0) throw new Error("session file has no leaf");
	const leaf = leaves.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
	const chain: Row[] = [];
	let at: Row | undefined = leaf;
	while (at) {
		chain.push(at);
		at = at.parentId ? byId.get(at.parentId) : undefined;
	}
	return chain.reverse();
}

function main(): void {
	const sessionId = arg("--session", process.env.PI_SESSION_ID ?? "");
	if (!sessionId) throw new Error("--session <id> or PI_SESSION_ID is required");
	const outDir = arg("--out", new URL("../captures-dev/", import.meta.url).pathname);
	const sDir = stateDir();
	const ledgerPath = join(sDir, "sessions", `${sessionId}.ledger.jsonl`);
	const auditPath = join(sDir, "audit.ndjson");
	if (!existsSync(ledgerPath)) throw new Error(`no ledger: ${ledgerPath}`);

	const entries = branchRows(findSessionFile(sessionId));
	const index = new Map<string, number>(entries.map((e, i) => [e.id, i]));

	// Audit write_start chunkTokens per chunkId (what the live writer measured).
	const auditTokens = new Map<string, number>();
	if (existsSync(auditPath)) {
		for (const row of readJsonl(auditPath)) {
			if (row.event === "write_start" && row.sessionId === sessionId)
				auditTokens.set(row.chunkId, row.chunkTokens);
		}
	}

	// Extract records in ledger order; a resumed chunk writes the record twice with
	// the same coversUpToId, so keep the first occurrence per chunkId.
	const seenChunk = new Set<string>();
	const extracts: Row[] = [];
	for (const rec of readJsonl(ledgerPath)) {
		if (rec.type !== "hy.extract" || seenChunk.has(rec.chunkId)) continue;
		seenChunk.add(rec.chunkId);
		extracts.push(rec);
	}

	const maxEntryChars = configMaxEntryChars();
	mkdirSync(join(outDir, sessionId), { recursive: true });

	let cursor = -1;
	let written = 0;
	const manifest: object[] = [];
	for (const rec of extracts) {
		const to = index.get(rec.coversUpToId);
		if (to === undefined) {
			manifest.push({
				chunkId: rec.chunkId,
				valid: false,
				reason: `coversUpToId ${rec.coversUpToId} not on branch`,
			});
			continue;
		}
		if (to <= cursor) {
			manifest.push({
				chunkId: rec.chunkId,
				valid: false,
				reason: `coverage moved backwards (${cursor} -> ${to})`,
			});
			continue;
		}
		const window = entries.slice(cursor + 1, to + 1);
		const chunk = serializeEntries(window as never[], { maxTokens: Number.MAX_SAFE_INTEGER, maxEntryChars });
		const lastRef = chunk.refs[chunk.refs.length - 1];
		const problems: string[] = [];
		if (lastRef !== rec.coversUpToId) problems.push(`last ref ${lastRef} != coversUpToId ${rec.coversUpToId}`);
		for (const draft of rec.drafts ?? []) {
			for (const id of draft.sourceEntryIds ?? []) {
				if (!chunk.refs.includes(id)) problems.push(`draft sourceEntryId ${id} outside window`);
			}
		}
		const est = estimateTokens(chunk.text);
		const audit = auditTokens.get(rec.chunkId);
		if (audit !== undefined && Math.abs(est - audit) / audit > 0.02)
			problems.push(`token estimate ${est} vs audit ${audit}`);
		const valid = problems.length === 0;
		const capture = {
			sessionId,
			chunkId: rec.chunkId,
			createdAt: rec.createdAt,
			coversUpToId: rec.coversUpToId,
			entryCount: chunk.entryCount,
			refs: chunk.refs,
			auditChunkTokens: audit ?? null,
			estimateChunkTokens: est,
			draftCount: (rec.drafts ?? []).length,
			text: chunk.text,
		};
		if (valid) {
			writeFileSync(join(outDir, sessionId, `${rec.chunkId}.json`), `${JSON.stringify(capture, null, 2)}\n`);
			written++;
		}
		manifest.push({
			chunkId: rec.chunkId,
			valid,
			entries: chunk.entryCount,
			drafts: capture.draftCount,
			tokens: est,
			problems: valid ? undefined : problems.slice(0, 3),
		});
		cursor = to;
	}

	writeFileSync(join(outDir, sessionId, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`session ${sessionId}: ${written}/${extracts.length} chunks captured -> ${join(outDir, sessionId)}`);
	for (const row of manifest) console.log(`  ${JSON.stringify(row)}`);
}

main();
