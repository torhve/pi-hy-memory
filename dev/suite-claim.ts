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

export type SuiteClaim = { mode: "lan" | "offline"; value: number };

const LAN_MARKERS = /\b(lan|tctl_lan|vpn|handshake section)\b/i;

const CHECK_WORD = /\b(checks|check|tests|green|passing|passed|suite)\b/i;
const COUNT_AFTER_NUMBER = /(\d{2,4})\s*(?:checks|check\b|green)\b/i;
const PASS_AFTER_NUMBER = /(\d{2,4})\s+(?:passing|passed|pass)\b/i;
const COUNT_AFTER_WORD = /(?:checks|tests)\s*(?:of|:)?\s*(\d{2,4})\b/i;
const COUNT_AFTER_VERB =
	/(?:reports|reported|passes|passed|totals|counts|has|have|contains|moved to|up to|increased to|rose to|dropped to|left|now reports)\s+(\d{2,4})\b/i;
const BARE_NUMBER = /\b(\d{2,4})\b/;

const clauseClaim = (clause: string): SuiteClaim | undefined => {
	const mode = LAN_MARKERS.test(clause) ? "lan" : "offline";
	const direct = COUNT_AFTER_NUMBER.exec(clause) ?? PASS_AFTER_NUMBER.exec(clause) ?? COUNT_AFTER_WORD.exec(clause);
	if (direct) return { mode, value: Number(direct[1]) };
	// "the suite currently has 238" names no count word next to the number, so it needs a check word elsewhere.
	if (CHECK_WORD.test(clause)) {
		const verb = COUNT_AFTER_VERB.exec(clause);
		if (verb) return { mode, value: Number(verb[1]) };
	}
	// "371 with TCTL_LAN=1" names no check word at all, but a LAN marker plus a bare number is a LAN count.
	if (mode === "lan") {
		const bare = BARE_NUMBER.exec(clause);
		if (bare) return { mode, value: Number(bare[1]) };
	}
	return undefined;
};
export const suiteClaims = (statement: string): SuiteClaim[] => {
	const found: SuiteClaim[] = [];
	// Split on conjunctions too, because a writer packs both counts into one sentence: "334 green and LAN tests
	// passed with 341". A zero is a failure count, not a suite total, so it asserts nothing.
	for (const clause of statement.split(/[;\n]+|\s+and\s+|\.\s+/i)) {
		const claim = clauseClaim(clause);
		if (!claim || claim.value === 0) continue;
		if (!found.some((c) => c.mode === claim.mode && c.value === claim.value)) found.push(claim);
	}
	return found;
};

/** The first count a statement asserts, for scripts that track one claim at a time. */
export const suiteClaim = (statement: string): SuiteClaim | undefined => suiteClaims(statement)[0];
