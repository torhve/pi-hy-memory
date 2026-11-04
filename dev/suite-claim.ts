/**
 * A claim a bank entry makes about a test suite count, and whether the entry asserts that count as current or
 * records a number some document carries.
 *
 * The distinction decides which superseded counts a run is graded as getting wrong. An entry holding an old number
 * inside a record — a changelog line, a log file, a hard-coded script — is a correct fact about that document. The
 * same number sitting in a sentence about the suite is a stale claim nobody retired.
 */

export type SuiteClaim = { mode: "lan" | "offline"; value: number; record: boolean };

const LAN_MARKERS = /\b(lan|tctl_lan|vpn|handshake section)\b/i;
const OFFLINE_MARKERS = /\b(offline|tctl_offline|dry mode|dry run|tctl_dry)\b/i;

/**
 * Segments of an entry, split at sentence ends and conjunctions. One entry can state both counts — "the suite
 * passes 358 checks in dry mode (TCTL_DRY=1) and 371 checks when including the LAN section" — and the marker that
 * belongs to a number sits inside its own segment, not at the start of the entry.
 */
const segmentsOf = (statement: string): { from: number; to: number }[] => {
	const separator = /(?<=[.;])\s+|\s+and\s+/gi;
	const out: { from: number; to: number }[] = [];
	let from = 0;
	for (let m = separator.exec(statement); m; m = separator.exec(statement)) {
		out.push({ from, to: m.index });
		from = m.index + m[0].length;
		if (separator.lastIndex <= m.index) separator.lastIndex = m.index + 1;
	}
	out.push({ from, to: statement.length });
	return out;
};

/** The match of a marker pattern nearest the number, as its centre and its distance from that number. */
const nearestMatch = (pattern: RegExp, text: string, at: number): { center: number; dist: number } | undefined => {
	const scan = new RegExp(pattern.source, "gi");
	let best: { center: number; dist: number } | undefined;
	for (let m = scan.exec(text); m; m = scan.exec(text)) {
		const center = m.index + m[0].length / 2;
		const dist = Math.abs(center - at);
		if (!best || dist < best.dist) best = { center, dist };
		if (scan.lastIndex <= m.index) scan.lastIndex = m.index + 1;
	}
	return best;
};

/**
 * Which suite a number counts. The marker inside the number's own segment decides it. When one segment carries both
 * flags — "TCTL_LAN=1 TCTL_DRY=1 node test/run.mjs reports 241 checks passed" — the run is a LAN run: the LAN flag
 * is the point of it. Two markers far apart describe two different counts, and the nearer one wins.
 */
const modeOf = (statement: string, at: number): "lan" | "offline" => {
	const segment = segmentsOf(statement).find((s) => at >= s.from && at < s.to) ?? { from: 0, to: statement.length };
	const text = statement.slice(segment.from, segment.to);
	const offset = at - segment.from;
	const lan = nearestMatch(LAN_MARKERS, text, offset);
	const offline = nearestMatch(OFFLINE_MARKERS, text, offset);
	if (!lan) return "offline";
	if (!offline) return "lan";
	if (Math.abs(lan.center - offline.center) <= 20) return "lan";
	return lan.dist < offline.dist ? "lan" : "offline";
};

/**
 * A number is a record when the text around it points at the document carrying it — a file path or a quoted string
 * — and says that the document holds the number or that the number is no longer current. Neither half is enough on
 * its own: "the changelog claims 214" names no document, and "the suite currently passes 402 checks after the lease
 * module was added to test/run.mjs" names a file that changed rather than a file that recorded anything.
 */
const ARTIFACT = /[\w./-]+\.(md|log|json|sh|mjs|ts|py|yml|yaml)\b|["'`][^"'`]*\b\d{2,4}\b[^"'`]*["'`]/i;

/**
 * A file named as something to run — `node test/run.mjs`, or a path inside backticks — is a program that produced
 * the number, not a document holding it. "node test/run.mjs reports 241 checks passed" is a claim about the suite.
 * Remove those mentions before asking whether a document carries the number.
 */
const COMMAND = /\b(?:node|deno|bun|npm|npx|tsx|python3?|bash|zsh|sh)\s+[\w./-]+\.[a-z]{1,4}\b|`[^`]*`/gi;

const documentText = (window: string): string => window.replace(COMMAND, " ");

const RECORD_ATTRIBUTION =
	/\b(claims?|claimed|states?|stated|records?|recorded|lists|listed|opens with|quotes?|quoted|echoes?|reports?|reported|says|said|shows|showed|reflects|reflecting|represents|representing|showing|printed|prints|hard-cod\w*|hardcod\w*|outdated|obsolete|stale|superseded|no longer current|earlier|last session|prior to|from before|at that time|incorrectly|wrongly)\b/i;

/** Count phrases the corpora use, each capturing the number itself. */
const COUNT_PATTERNS: RegExp[] = [
	/(\d{2,4})\s*(?:checks|check\b|green)\b/i,
	/(\d{2,4})\s+(?:passing|passed|pass)\b/i,
	/(?:checks|tests)\s*(?:of|:)?\s*(\d{2,4})\b/i,
	/(?:reports|reported|passes|passed|totals|counts|has|have|contains|moved to|up to|increased to|rose to|dropped to|left|now reports)\s+(\d{2,4})\b/i,
	/(?:results?|tally)\s+(?:of|:)?\s*(\d{2,4})\b/i,
];

type Mention = { value: number; index: number };

const mentions = (statement: string): Mention[] => {
	const found: Mention[] = [];
	const add = (value: number, index: number) => {
		if (found.some((m) => m.value === value && Math.abs(m.index - index) < 8)) return;
		found.push({ value, index });
	};
	for (const pattern of COUNT_PATTERNS) {
		const re = new RegExp(pattern.source, "gi");
		for (let m = re.exec(statement); m; m = re.exec(statement)) {
			const digits = m.index + m[0].indexOf(m[1]);
			add(Number(m[1]), digits);
			if (re.lastIndex <= m.index) re.lastIndex = m.index + 1;
		}
	}
	// "371 with TCTL_LAN=1" names no count word at all, but a LAN marker next to a bare number is a LAN count.
	// "371 with TCTL_LAN=1" names no count word at all, but a LAN marker next to a bare number is a LAN count.
	const bare = /\b(\d{2,4})\b/g;
	for (let m = bare.exec(statement); m; m = bare.exec(statement)) {
		const value = Number(m[1]);
		const around = statement.slice(Math.max(0, m.index - 70), m.index + 70);
		if (LAN_MARKERS.test(around) && !found.some((x) => x.value === value)) add(value, m.index);
	}
	return found.sort((a, b) => a.index - b.index);
};

/**
 * The text that explains one number: everything since the previous number in the entry, capped at 90 characters
 * before it. The cap is what keeps a record reading from leaking onto the next count in the same sentence, as in
 * "logs/release-14.log records 238 checks and the offline suite is now at 402 green".
 */
const explainWindow = (statement: string, mention: Mention, previous: Mention | undefined): string => {
	const from = previous ? previous.index + String(previous.value).length : 0;
	return statement.slice(Math.max(from, mention.index - 90), mention.index + 25);
};

/** Ranges of the entry that sit inside a quoted string: the artifact being quoted, not a claim the entry makes. */
const quotedSpans = (statement: string): [number, number][] => {
	const spans: [number, number][] = [];
	const re = /["'`][^"'`]*["'`]/g;
	for (let m = re.exec(statement); m; m = re.exec(statement)) spans.push([m.index, m.index + m[0].length]);
	return spans;
};

export const suiteClaims = (statement: string): SuiteClaim[] => {
	const found = new Map<string, SuiteClaim>();
	const all = mentions(statement).filter((m) => m.value > 0);
	const spans = quotedSpans(statement);
	const outside = all.filter((m) => !spans.some(([start, end]) => m.index >= start && m.index < end));
	// An entry that only quotes a number — a script that prints "251 checks passed" — is still a record of it.
	const list = outside.length > 0 ? outside : all;
	list.forEach((mention, i) => {
		const window = explainWindow(statement, mention, list[i - 1]);
		const claim: SuiteClaim = {
			mode: modeOf(statement, mention.index),
			value: mention.value,
			record: ARTIFACT.test(documentText(window)) && RECORD_ATTRIBUTION.test(window),
		};
		const key = `${claim.mode} ${claim.value}`;
		const seen = found.get(key);
		// One number may read as a record in one clause and as the current count in another. The assertion wins, so
		// a live claim cannot be laundered into a record by restating the same value somewhere else in the entry.
		if (seen) seen.record = seen.record && claim.record;
		else found.set(key, claim);
	});
	return [...found.values()];
};

/** The first count a statement asserts, for scripts that track one claim at a time. */
export const suiteClaim = (statement: string): SuiteClaim | undefined => suiteClaims(statement)[0];
