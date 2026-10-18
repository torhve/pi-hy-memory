/**
 * Chunk ids.
 *
 * Entry ids are derived from `${chunkId}:${draft}:${action}`, so a reused chunk
 * id silently creates pairs of bank entries with identical ids — which then
 * break UPDATE targeting (byId keeps the last one) and make `hy_recall <id>`
 * ambiguous.
 *
 * Measured in session 01a14a46: chunk 003 failed and left no ledger record, so
 * the sequence was derived from "how many extract records exist" (4) and issued
 * 005 again after a reload, colliding with the pre-reload 005. Seven pairs of
 * duplicate ids followed. The sequence must come from the highest id in use, and
 * the generated id must not already exist.
 */

const CHUNK_ID = /^hy-([0-9a-f]{8})-(\d+)$/;

export const EXTRACT_RECORD = "hy.extract";

export function highestChunkSeq(records: { chunkId?: string; type?: string }[]): number {
	let max = 0;
	for (const record of records) {
		const match = CHUNK_ID.exec(String(record.chunkId ?? ""));
		if (match) max = Math.max(max, Number(match[2]));
	}
	return max || records.filter((r) => r.type === EXTRACT_RECORD).length;
}

export function nextChunkId(
	sessionId: string,
	records: { chunkId?: string; type?: string }[],
	bump: () => number,
): string {
	const taken = new Set(records.map((r) => r.chunkId).filter(Boolean));
	const prefix = `hy-${sessionId.slice(0, 8)}-`;
	for (let attempt = 0; attempt < 1000; attempt++) {
		const seq = Math.max(bump(), highestChunkSeq(records));
		const id = `${prefix}${String(seq).padStart(3, "0")}`;
		if (!taken.has(id)) return id;
	}
	return `${prefix}999`;
}
