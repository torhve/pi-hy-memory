/**
 * Chunk serialization for the writer.
 *
 * pi-blackhole and pi-observational-memory label source entries with their
 * session id: `[Source entry id: a9603b54]`. Measured consequence with
 * Hy-Memory-30B-A3B: 19 of 590 observations copied those hex labels into the
 * observation text, which is the one defect class no other candidate in the
 * harness produced — a reference that stops resolving once the chunk is gone.
 *
 * So provenance here is a positional numeric ref. The model cites [7]; code
 * maps 7 back to the real entry id. The model never sees an id it could echo.
 */

const ID_LABEL = /\[Source entry id:\s*([a-f0-9]{6,12})\]/g;

export type SerializedChunk = {
	text: string;
	/** ref index -> real session entry id */
	refs: string[];
	entryCount: number;
};

export function serializeChunk(userContent: string): SerializedChunk {
	const refs: string[] = [];
	const text = userContent.replace(ID_LABEL, (_m, id: string) => {
		const existing = refs.indexOf(id);
		if (existing >= 0) return `[${existing}]`;
		refs.push(id);
		return `[${refs.length - 1}]`;
	});
	return { text, refs, entryCount: refs.length };
}

/** Reconstruct the source text for one entry id (used by recall). */
export function entryText(userContent: string, id: string): string | undefined {
	const label = `[Source entry id: ${id}]`;
	const at = userContent.indexOf(label);
	if (at < 0) return undefined;
	const next = userContent.indexOf("[Source entry id: ", at + label.length);
	return userContent.slice(at, next < 0 ? userContent.length : next).trim();
}
