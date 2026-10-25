import type { LedgerRecord } from "./types.js";

/**
 * What the status line and `stats.json` count.
 *
 * These used to start at zero on every `session_start`, while the ledger they sit beside kept
 * every write the session ever made: a session reloaded at write 145 printed `14 writes`, and
 * the line reads as a session total. The ledger is the durable record, so the counters are
 * derived from it at load and then continued by this process.
 */
export type SessionStats = {
	writes: number;
	drafts: number;
	added: number;
	updated: number;
	deleted: number;
	rejectedOps: number;
	downgraded: number;
	inTokens: number;
	outTokens: number;
	/** Model time, not wall overhead: the ledger records each call's own duration. */
	wallS: number;
	compactions: number;
	/** True when these numbers came from the ledger at load rather than from this process. */
	seededFromLedger: boolean;
	/**
	 * True when a seeded number is a floor. The reason list beside a downgraded op is bounded,
	 * so a ledger written before `downgradedCount` existed can only report what it kept.
	 */
	countsAreFloor: boolean;
};

export function emptyStats(): SessionStats {
	return {
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
		seededFromLedger: false,
		countsAreFloor: false,
	};
}

/**
 * The session's counters as its ledger describes them. Gaps and ceiling records are coverage and
 * pressure, not writes, so only `hy.gap` with reason `compaction` moves `compactions`.
 */
export function statsFromLedger(records: LedgerRecord[]): SessionStats {
	const stats = emptyStats();
	stats.seededFromLedger = records.length > 0;
	for (const record of records) {
		if (record.type === "hy.extract") {
			stats.drafts += record.drafts.length;
			stats.inTokens += record.usage?.inTokens ?? 0;
			stats.outTokens += record.usage?.outTokens ?? 0;
			stats.wallS += record.usage?.wallS ?? 0;
			continue;
		}
		if (record.type === "hy.ops") {
			stats.writes++;
			stats.rejectedOps += record.rejectedCount ?? record.rejectedOps?.length ?? 0;
			if (typeof record.downgradedCount === "number") {
				stats.downgraded += record.downgradedCount;
			} else {
				stats.downgraded += record.downgradedOps?.length ?? 0;
				stats.countsAreFloor = true;
			}
			for (const op of record.ops ?? []) {
				if (op.action === "ADD") stats.added++;
				else if (op.action === "UPDATE") stats.updated++;
				else if (op.action === "DELETE") stats.deleted++;
			}
			stats.inTokens += record.usage?.inTokens ?? 0;
			stats.outTokens += record.usage?.outTokens ?? 0;
			stats.wallS += record.usage?.wallS ?? 0;
			continue;
		}
		if (record.type === "hy.gap" && record.reason === "compaction") stats.compactions++;
	}
	return stats;
}
