#!/usr/bin/env npx tsx

/**
 * dev/suite-claim.ts — read the check-suite counts a statement asserts, and which run produced each one.
 *
 * The supersession corpora and the bank's own statements state the same fact in prose: a number of checks that
 * passed, from the offline run or the LAN run. The supersession scripts need both halves to say which claim a
 * bank entry holds, so the parse lives here and both scripts use it.
 *
 * A statement can hold both counts — "358 checks passed; 371 with TCTL_LAN=1" — so the parse reads clause by
 * clause and returns a list. Mode comes from a marker inside the clause, because a writer may reorder the
 * sentence: "371 with TCTL_LAN=1" and "the LAN run reports 371 checks passed" are the same claim. A clause with
 * no number, or a number attached to no check word, asserts nothing, which is what keeps a distractor out of the
 * comparison.
 */

/**
 * A count and the run that produced it. `record` says whether the clause presents the number as the current
 * state or as something an older artifact quotes: a file that reports a number, a quoted string a script
 * echoes, or a number named as out of date. Only an assertion can supersede anything, so the two have to be
 * told apart before a bank is graded.
 */
export type SuiteClaim = { mode: "lan" | "offline"; value: number; record: boolean };

const LAN_MARKERS = /\b(lan|tctl_lan|vpn|handshake section)\b/i;

/**
 * A clause records a number rather than asserting it when it names the artifact doing the recording — a file
 * path, a quoted string a script prints — or calls the number out of date. A past tense alone is not enough:
 * "after the fix the suite reported 251 passing" is a plain assertion about the suite, and counting it as a
 * record would hide the fact that it went stale.
 */
const RECORD_CLAUSE = (value: number): RegExp =>
	new RegExp(
		[
			`[\\w./-]+\\.(md|log|json|sh|mjs|ts|py|yml|yaml)\\b`,
			`["'][^"']*\\b${value}\\b[^"']*["']`,
			`\\b(hard-cod\\w*|hardcod\\w*|outdated|obsolete|stale|superseded|no longer current|earlier|last session|prior to|from before)\\b`,
		].join("|"),
		"i",
	);

/**
 * A verb that attributes the number to an artifact rather than to the suite. "reports" is not one of them: a
 * clause saying "the suite reports 402" is a current claim even when the same entry also quotes a log file.
 */
const RECORD_VERB =
	/\b(claims?|states?|stated|records?|recorded|listed|lists|opens with|quotes?|echoes?|hard-cod\w*|incorrectly|wrongly|outdated|stale)\b/i;
const CHECK_WORD = /\b(checks|check|tests|green|passing|passed|suite)\b/i;
const COUNT_AFTER_NUMBER = /(\d{2,4})\s*(?:checks|check\b|green)\b/i;
const PASS_AFTER_NUMBER = /(\d{2,4})\s+(?:passing|passed|pass)\b/i;
const COUNT_AFTER_WORD = /(?:checks|tests)\s*(?:of|:)?\s*(\d{2,4})\b/i;
const COUNT_AFTER_VERB =
	/(?:reports|reported|passes|passed|totals|counts|has|have|contains|moved to|up to|increased to|rose to|dropped to|left|now reports)\s+(\d{2,4})\b/i;
const BARE_NUMBER = /\b(\d{2,4})\b/;

const ARTIFACT = /[\w./-]+\.(md|log|json|sh|mjs|ts|py|yml|yaml)\b|["'][^"']*\d{2,4}[^"']*["']/i;

const clauseClaim = (clause: string, statementNamesArtifact: boolean): SuiteClaim | undefined => {
	const mode = LAN_MARKERS.test(clause) ? "lan" : "offline";
	const direct = COUNT_AFTER_NUMBER.exec(clause) ?? PASS_AFTER_NUMBER.exec(clause) ?? COUNT_AFTER_WORD.exec(clause);
	// A number is a record when the clause itself points at the artifact holding it, or when the clause attributes
	// it ("the changelog claims 214") and the statement names an artifact somewhere. A verb alone is not enough,
	// and neither is an artifact named in some other part of the entry.
	const build = (value: number): SuiteClaim => ({
		mode,
		value,
		record: RECORD_CLAUSE(value).test(clause) || (statementNamesArtifact && RECORD_VERB.test(clause)),
	});
	if (direct) return build(Number(direct[1]));
	// "the suite currently has 238" names no count word next to the number, so it needs a check word elsewhere.
	if (CHECK_WORD.test(clause)) {
		const verb = COUNT_AFTER_VERB.exec(clause);
		if (verb) return build(Number(verb[1]));
	}
	// "371 with TCTL_LAN=1" names no check word at all, but a LAN marker plus a bare number is a LAN count.
	if (mode === "lan") {
		const bare = BARE_NUMBER.exec(clause);
		if (bare) return build(Number(bare[1]));
	}
	return undefined;
};
export const suiteClaims = (statement: string): SuiteClaim[] => {
	const found: SuiteClaim[] = [];
	const namesArtifact = ARTIFACT.test(statement);
	// Split on conjunctions too, because a writer packs both counts into one sentence: "334 green and LAN tests
	// passed with 341". A zero is a failure count, not a suite total, so it asserts nothing.
	for (const clause of statement.split(/[;\n]+|\s+and\s+|\.\s+/i)) {
		const claim = clauseClaim(clause, namesArtifact);
		if (!claim || claim.value === 0) continue;
		// One claim may appear as a record in one clause and as an assertion in another. The assertion wins, so a
		// number cannot be laundered into a record by naming a file somewhere else in the entry.
		const existing = found.find((c) => c.mode === claim.mode && c.value === claim.value);
		if (existing) existing.record = existing.record && claim.record;
		else found.push(claim);
	}
	return found;
};

/** The first count a statement asserts, for scripts that track one claim at a time. */
export const suiteClaim = (statement: string): SuiteClaim | undefined => suiteClaims(statement)[0];
