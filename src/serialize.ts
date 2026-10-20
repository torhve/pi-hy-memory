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
	/**
	 * ref index -> entry role ("user", "assistant", "toolResult", …). Code uses it to
	 * mark drafts whose evidence is a user turn; the writer never sees it.
	 */
	roles?: string[];
};

export function serializeChunk(userContent: string): SerializedChunk {
	const refs: string[] = [];
	const text = userContent.replace(ID_LABEL, (_m, id: string) => {
		const existing = refs.indexOf(id);
		if (existing >= 0) return `[${existing}]`;
		refs.push(id);
		return `[${refs.length - 1}]`;
	});
	// Already-serialized text (captures, replay) has no id labels to count, so the
	// roles are read back from the rendered line prefixes instead.
	return { text, refs, entryCount: refs.length, roles: rolesFromText(text) };
}

/** `[3] [User @ 09:17]: …` -> "user" at index 3. Undefined for lines without a prefix. */
export function rolesFromText(text: string): string[] | undefined {
	const roles: string[] = [];
	for (const line of text.split("\n")) {
		const at = /^\[(\d+)\] \[([A-Za-z ]+)/.exec(line);
		if (!at) continue;
		const index = Number(at[1]);
		const label = at[2].trim().toLowerCase();
		const role = label.startsWith("user")
			? "user"
			: label.startsWith("assistant")
				? "assistant"
				: label.startsWith("tool result")
					? "toolResult"
					: label;
		while (roles.length < index) roles.push("?");
		roles[index] = role;
	}
	return roles.length > 0 ? roles : undefined;
}
