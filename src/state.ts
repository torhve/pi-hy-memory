/**
 * Retention for per-session state.
 *
 * Every session that ever wrote memory leaves four files behind (bank, ledger,
 * summary, stats). That is deliberate — the bank is a fold of the ledger, and the
 * summary is what compaction will inject — but it grows without bound: 92
 * sessions and 1.2 MB after a few weeks of heavy use, with no cleanup.
 *
 * Pruning is age-based on file mtime, and refuses to delete:
 *   - the current session,
 *   - the newest `keepAtLeast` sessions (default 10),
 *   - anything whose name is not `<sessionId>.<kind>` (so an unrelated file in the
 *     directory is never removed by accident).
 */

import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** `<uuid-ish session id>.<kind>`; the id may contain dashes, never a dot. */
const SESSION_FILE = /^([0-9a-zA-Z][0-9a-zA-Z-]{7,})\.([A-Za-z0-9._-]+)$/;

export interface PruneOptions {
	/** Delete sessions whose newest file is older than this many days. 0 disables. */
	afterDays: number;
	/** Always keep this many of the newest sessions, regardless of age. */
	keepAtLeast?: number;
	/** Session ids that are never pruned (the running session). */
	keep?: string[];
	now?: number;
}

export interface PruneResult {
	removed: string[];
	files: number;
	kept: number;
}

export function pruneSessions(dir: string, options: PruneOptions): PruneResult {
	const empty: PruneResult = { removed: [], files: 0, kept: 0 };
	if (!(options.afterDays > 0)) return empty;

	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return empty;
	}

	// Group files per session; the session's age is its newest file.
	const newest = new Map<string, number>();
	const files = new Map<string, string[]>();
	for (const name of names) {
		const match = SESSION_FILE.exec(name);
		if (!match) continue;
		const [, sessionId] = match;
		let mtime: number;
		try {
			mtime = statSync(join(dir, name)).mtimeMs;
		} catch {
			continue;
		}
		newest.set(sessionId, Math.max(newest.get(sessionId) ?? 0, mtime));
		const bucket = files.get(sessionId);
		if (bucket) bucket.push(name);
		else files.set(sessionId, [name]);
	}

	const order = [...newest.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
	const floor = Math.max(0, options.keepAtLeast ?? 10);
	const protectedIds = new Set([...order.slice(0, floor), ...(options.keep ?? [])]);
	const cutoff = (options.now ?? Date.now()) - options.afterDays * 86_400_000;

	const result: PruneResult = { removed: [], files: 0, kept: protectedIds.size };
	for (const sessionId of order) {
		if (protectedIds.has(sessionId)) continue;
		if ((newest.get(sessionId) ?? 0) >= cutoff) continue;
		for (const name of files.get(sessionId) ?? []) {
			try {
				unlinkSync(join(dir, name));
				result.files++;
			} catch {
				/* a racing write wins; the next start prunes it */
			}
		}
		result.removed.push(sessionId);
	}
	return result;
}
