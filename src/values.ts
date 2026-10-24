/**
 * Values, as distinct from wording.
 *
 * The subject guard in `protocol.ts` compares vocabulary, which is how a merge retires a fact the
 * conversation says must survive: "queue purge age is 420, line 63" and "queue retention rule was
 * reviewed" share enough words to look like one claim, and the number dies in the overwrite. A
 * value is the part of a claim that is not vocabulary — a number, a flag, a dotted file name, a
 * path, an underscored identifier — and it is the part a reworded draft most often drops.
 *
 * `TODO.md` 7.18 prices this as a merge gate: an UPDATE is allowed only when the draft restates
 * every value its target carries. The measurement lives in `dev/guard-fold-report.ts`; the gate
 * itself is `mergeValueGate` in `pipeline.ts`, and this file is the single definition both read.
 */

const VALUE_TOKEN = /(-{1,2}[a-z0-9][a-z0-9._/+-]*|[a-z0-9][a-z0-9._/+-]{1,})/g;

/**
 * Tokens that hold a value rather than wording. Ordinary words ("queue", "entries", "seconds") are
 * deliberately excluded — the subject guard already reads those, and a gate that read them too would
 * refuse merges for reasons unrelated to the value.
 *
 * It is a matcher, not a parser: a value reworded into prose ("forty-five days") is a miss, and a
 * value spelled with no specific token ("line 63" aside, "reads settings.toml once") is invisible.
 */
export function valueTokens(text: string): Set<string> {
	const out = new Set<string>();
	for (const raw of text.toLowerCase().match(VALUE_TOKEN) ?? []) {
		const token = raw.replace(/[.,:]+$/, "");
		if (token.length < 2) continue;
		const isNumber = /\d/.test(token);
		const isFlag = token.startsWith("--");
		const isFile = /^[a-z0-9_-]+\.[a-z0-9.]+$/.test(token);
		const isPath = token.includes("/") && token.length > 3;
		const isIdentifier = token.includes("_") && token.length >= 5;
		if (isNumber || isFlag || isFile || isPath || isIdentifier) out.add(token);
	}
	return out;
}

/**
 * Match an anchor as a whole token. A flag-shaped token needs a boundary that does not assume a word
 * character on its outside — a `\b` in front of `--dry-run` matches nothing — while an ordinary token
 * keeps `\b`, which is the boundary every earlier score in this repo was computed with.
 */
export function carries(anchor: string, text: string): boolean {
	const esc = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = anchor.startsWith("-") ? `(?<![\\w-])${esc}(?![\\w-])` : `\\b${esc}\\b`;
	return new RegExp(pattern, "i").test(text);
}

/**
 * Which values an UPDATE draft fails to restate. The text compared is the same three fields the
 * subject guard reads — task, statement, keys — so the two gates look at one surface, not two.
 *
 * Sorted for a stable refusal message: the reason string reaches the ledger and `dev/merge-report.ts`
 * reads it back.
 */
export function valuesTheDraftDrops(
	target: { task: string; statement: string; keys?: string[] },
	draft: { task: string; statement: string; keys?: string[] },
): string[] {
	const surface = (row: { task: string; statement: string; keys?: string[] }) =>
		`${row.task} ${row.statement} ${(row.keys ?? []).join(" ")}`;
	const written = surface(draft);
	return [...valueTokens(surface(target))].filter((value) => !carries(value, written)).sort();
}
