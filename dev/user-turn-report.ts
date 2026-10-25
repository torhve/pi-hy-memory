#!/usr/bin/env tsx
/**
 * Is a user turn groundable at all (TODO 6.20b). Run: npx tsx dev/user-turn-report.ts
 *   [--captures <dir>]... [--snapshot <dir>]
 *
 * 6.20 found 3 user-grounded facts in a bank of 820, and `fromUser` turned out to mean "a draft
 * cited a line whose label says User" — which in a real session is mostly the user *asking*. The
 * constraint usually arrives one turn later, in the assistant's restatement, and a draft citing
 * that restatement is marked as if it came from the tool output. This measures the two halves
 * separately, offline, over captured chunks plus a frozen snapshot:
 *
 *   - what shape the user's turns actually are: a question, a directive, both, neither
 *   - whether a directive is restated by a later assistant turn in the same chunk, and where
 *   - which lines the drafts cited, split by the shape of the line cited
 *   - banked facts that carry a directive's own words, and how many of those carry the `fromUser`
 *     mark. The gap between those two numbers is the whole finding: it counts facts the user
 *     decided that the bank cannot tell apart from tool output.
 *
 * Nothing here decides anything about the summary's constraint slice; it counts what such a slice
 * could actually fill from. Coverage is printed: chunks with a capture are not all the writes in
 * the ledger, so a zero here can mean "no capture for that chunk", and the report says which.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { rolesFromText } from "../src/serialize.js";
import type { BankEntry, LedgerRecord } from "../src/types.js";

const STOP = new Set(
	"the a an and or of to in on for with that this it is are was were be been as at by from into about over under then than when while which who what why how where any can could should would will do does did".split(
		" ",
	),
);

export type TurnShape = "question" | "directive" | "both" | "ack" | "neither";

export type UserTurn = {
	chunkId: string;
	index: number;
	label: string;
	text: string;
	shape: TurnShape;
	/** Index of the first later assistant turn in the same chunk that restates it, or null. */
	restatedBy: number | null;
};

export type SessionRead = {
	session: string;
	/** Chunk ids with a capture, and all chunk ids in the ledger. A capture gap is stated, not hidden. */
	capturedChunks: number;
	ledgerWrites: number;
	labelledTurns: number;
	userTurns: number;
	shapes: Record<TurnShape, number>;
	directivesRestated: number;
	/** Drafts whose cited lines include a user turn, split by the shape of the line cited. */
	draftsCitingUser: Record<TurnShape, number>;
	/** Drafts that carry a directive's words while citing no user turn — usually citing the restatement. */
	draftsCarryingDirectiveUnmarked: number;
	/** Banked facts carrying the words of some directive turn. */
	bankFactsCarryingDirective: number;
	/** Of those, how many are marked user-grounded. */
	bankFactsCarryingDirectiveMarked: number;
	/** Of those, how many are the successor of a marked fact: the mark was written, then lost to a merge. */
	bankFactsCarryingDirectiveFromMarkedAncestor: number;
	/**
	 * Marked entries in the whole bank, and where the ones that are no longer current went. The
	 * causes are different findings: a merge rewrote the fact and dropped the mark with the row it
	 * replaced, while the bank ceiling retired it unchanged — only the first is a durability claim
	 * about the mark itself.
	 */
	marksWritten: number;
	marksLostToMerge: number;
	marksLostToInvalidation: number;
	marksLostToCeiling: number;
	marksLostUnattributed: number;
	/** marksWritten minus marksCurrent, so the causes above have to add up to this. */
	marksLost: number;
	bankFactsMarkedUser: number;
	bankActive: number;
	turns: UserTurn[];
};

const contentWords = (text: string): Set<string> =>
	new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9._+-]+/)
			.filter((word) => word.length > 2 && !STOP.has(word)),
	);

const QUESTION_START =
	/^(?:what|why|how|where|when|which|who|can|could|should|would|will|is|are|do|does|did|any|there's|anyth)\b/;
const DIRECTIVE =
	/\b(don'?t|do not|never|always|must|keep|leave|stay|avoid|stop|only|make sure|remember|prefer|rename|stick|leave it|before you|after you|use the|same as|do not touch)\b/i;

/** A go-ahead: "proceed", "ok next". It grounds nothing — there is no constraint in it. */
const ACK =
	/^(?:ok+|okay|proceed|continue|next|go\s+ahead|go\s*on|do\s+it|yes|yep|sure|same|as\s+before)[\s\w,.]{0,14}$/i;

export function classifyTurn(text: string): TurnShape {
	const question = text.includes("?") || QUESTION_START.test(text.trim().toLowerCase());
	const directive = DIRECTIVE.test(text);
	if (question && directive) return "both";
	if (question) return "question";
	if (directive) return "directive";
	if (ACK.test(text.trim())) return "ack";
	return "neither";
}

/** Turn the rendered chunk into its labelled turns, keeping each entry's full body. */
export function parseTurns(text: string): { index: number; role: string; label: string; body: string }[] {
	const roles = rolesFromText(text) ?? [];
	const out: { index: number; role: string; label: string; body: string }[] = [];
	let current: { index: number; role: string; label: string; body: string } | undefined;
	for (const line of text.split("\n")) {
		const at = /^\[(\d+)\] \[([A-Za-z ]+?)\s*(?:@\s*[0-9:]+)?\s*\]:\s*(.*)$/.exec(line);
		if (at) {
			const index = Number(at[1]);
			const label = at[2].trim();
			current = { index, role: roles[index] ?? label.toLowerCase(), label, body: at[3] ?? "" };
			out.push(current);
			continue;
		}
		// A multi-line entry: its continuation belongs to the turn that opened it.
		if (current) current.body += `\n${line}`;
	}
	return out;
}

function restatedBy(
	turns: { index: number; role: string; body: string }[],
	turn: { index: number; body: string },
): number | null {
	const words = contentWords(turn.body);
	if (words.size < 3) return null;
	for (const later of turns) {
		if (later.index <= turn.index || later.role !== "assistant") continue;
		const shared = [...contentWords(later.body)].filter((word) => words.has(word));
		if (shared.length >= 3) return later.index;
	}
	return null;
}

function readCaptures(dir: string): { chunkId: string; text: string; refs: string[] }[] {
	return readdirSync(dir)
		.filter((f) => /^hy-.+\.json$/.test(f))
		.sort()
		.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
		.filter((row) => typeof row?.chunkId === "string" && typeof row?.text === "string")
		.map((row) => ({ chunkId: row.chunkId, text: row.text, refs: Array.isArray(row.refs) ? row.refs : [] }));
}

function readJsonl(path: string): LedgerRecord[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as LedgerRecord);
}

export function analyseSession(
	session: string,
	captures: { chunkId: string; text: string; refs: string[] }[],
	records: LedgerRecord[],
	bank: BankEntry[],
): SessionRead {
	const turns: UserTurn[] = [];
	const directiveWords = new Map<number, Set<string>>();
	for (const capture of captures) {
		const parsed = parseTurns(capture.text);
		for (const turn of parsed) {
			if (turn.role !== "user") continue;
			const shape = classifyTurn(turn.body);
			const restated = shape === "directive" || shape === "both" ? restatedBy(parsed, turn) : null;
			if (shape === "directive" || shape === "both") directiveWords.set(turns.length, contentWords(turn.body));
			turns.push({
				chunkId: capture.chunkId,
				index: turn.index,
				label: turn.label,
				text: turn.body.slice(0, 200),
				shape,
				restatedBy: restated,
			});
		}
	}

	const shapes: Record<TurnShape, number> = { question: 0, directive: 0, both: 0, ack: 0, neither: 0 };
	for (const turn of turns) shapes[turn.shape]++;

	// Which lines the drafts cited, by the role and shape of the line cited.
	const draftsCitingUser: Record<TurnShape, number> = { question: 0, directive: 0, both: 0, ack: 0, neither: 0 };
	let draftsCarryingDirectiveUnmarked = 0;
	const shapeByChunkIndex = new Map<string, Map<number, TurnShape>>();
	for (const turn of turns) {
		const inner = shapeByChunkIndex.get(turn.chunkId) ?? new Map<number, TurnShape>();
		inner.set(turn.index, turn.shape);
		shapeByChunkIndex.set(turn.chunkId, inner);
	}
	const indexFor = (refs: string[], entryId: string): number => refs.indexOf(entryId);
	const capturesById = new Map(captures.map((c) => [c.chunkId, c]));
	for (const record of records) {
		if (record.type !== "hy.extract") continue;
		const capture = capturesById.get(record.chunkId);
		if (!capture) continue;
		const shapesHere = shapeByChunkIndex.get(record.chunkId);
		for (const drafted of record.drafts) {
			let citedUser: TurnShape | null = null;
			for (const entryId of drafted.sourceEntryIds ?? []) {
				const at = indexFor(capture.refs, entryId);
				if (at < 0) continue;
				const shape = shapesHere?.get(at);
				if (shape && !citedUser) citedUser = shape;
			}
			if (citedUser) draftsCitingUser[citedUser]++;
			else {
				const words = contentWords(`${drafted.task} ${drafted.statement}`);
				const carries = [...directiveWords.values()].some(
					(set) => [...words].filter((word) => set.has(word)).length >= 3,
				);
				if (carries) draftsCarryingDirectiveUnmarked++;
			}
		}
	}

	const directives = [...directiveWords.values()];
	const carriesDirective = (entry: { task: string; statement: string }) => {
		const words = contentWords(`${entry.task} ${entry.statement}`);
		return directives.some((set) => [...words].filter((word) => set.has(word)).length >= 3);
	};
	const active = bank.filter((entry) => entry.status === "active");
	// Where the marks that are no longer current went. The causes are different findings: a merge
	// rewrote the fact and the mark went with the row it replaced, while the bank ceiling retired it
	// unchanged. A supersede reason is the writer's own wording, so attribution uses the pointer and
	// the two reasons the code itself sets, not the text.
	const lost = bank.filter((entry) => entry.fromUser === true && entry.status !== "active");
	const byId = new Map(bank.map((entry) => [entry.id, entry]));
	/** Did some earlier fact in this fact's supersede chain carry the mark a merge replaced? */
	const reachesMarkedAncestor = (entry: BankEntry): boolean => {
		let at = entry.supersedes;
		const seen = new Set<string>([entry.id]);
		while (at) {
			const prev = byId.get(at);
			if (!prev || seen.has(prev.id)) break;
			if (prev.fromUser === true) return true;
			seen.add(prev.id);
			at = prev.supersedes;
		}
		return false;
	};
	return {
		session,
		capturedChunks: captures.length,
		ledgerWrites: records.filter((r) => r.type === "hy.ops").length,
		labelledTurns: captures.reduce((n, c) => n + parseTurns(c.text).length, 0),
		userTurns: turns.length,
		shapes,
		directivesRestated: turns.filter((t) => t.restatedBy !== null).length,
		draftsCitingUser,
		draftsCarryingDirectiveUnmarked,
		bankFactsCarryingDirective: active.filter((entry) => carriesDirective(entry)).length,
		bankFactsCarryingDirectiveMarked: active.filter((entry) => carriesDirective(entry) && entry.fromUser === true)
			.length,
		bankFactsCarryingDirectiveFromMarkedAncestor: active.filter(
			(entry) => carriesDirective(entry) && !entry.fromUser && reachesMarkedAncestor(entry),
		).length,
		marksWritten: bank.filter((entry) => entry.fromUser === true).length,
		marksLostToMerge: lost.filter((e) => e.supersededBy !== undefined && e.supersedeReason !== "bank budget")
			.length,
		marksLostToInvalidation: lost.filter(
			(e) => !e.supersededBy && e.supersedeReason === "invalidated by newer chunk",
		).length,
		marksLostToCeiling: lost.filter((e) => e.supersedeReason === "bank budget").length,
		marksLost: lost.length,
		marksLostUnattributed: lost.filter(
			(e) =>
				!e.supersededBy &&
				e.supersedeReason !== "bank budget" &&
				e.supersedeReason !== "invalidated by newer chunk",
		).length,
		bankFactsMarkedUser: active.filter((entry) => entry.fromUser === true).length,
		bankActive: active.length,
		turns,
	};
}

function discoverCaptureDirs(): string[] {
	if (!existsSync("captures-dev")) return [];
	return readdirSync("captures-dev", { withFileTypes: true })
		.filter(
			(d) => d.isDirectory() && readdirSync(join("captures-dev", d.name)).some((f) => /^hy-.+\.json$/.test(f)),
		)
		.map((d) => join("captures-dev", d.name))
		.sort();
}

function sessionIdFrom(captures: { chunkId: string }[]): string | null {
	const first = captures[0]?.chunkId;
	if (!first) return null;
	const short = first.replace(/^hy-/, "").split("-")[0];
	return short ?? null;
}

function loadSnapshot(dir: string, short: string): { records: LedgerRecord[]; bank: BankEntry[] } | null {
	const sessions = readdirSync(dir).filter((f) => f.endsWith(".ledger.jsonl"));
	const match = sessions.find((f) => f.startsWith(short));
	if (!match) return null;
	const sessionId = match.replace(/\.ledger\.jsonl$/, "");
	const bankPath = join(dir, `${sessionId}.bank.json`);
	return {
		records: readJsonl(join(dir, match)),
		bank: existsSync(bankPath) ? (JSON.parse(readFileSync(bankPath, "utf8")) as BankEntry[]) : [],
	};
}

function print(read: SessionRead): void {
	console.log(
		`${read.session}: ${read.capturedChunks} captured chunks (${read.ledgerWrites} writes in the ledger), ${read.labelledTurns} labelled turns, ${read.userTurns} of them the user's`,
	);
	console.log(
		`   shapes: ${read.shapes.question} question, ${read.shapes.directive} directive, ${read.shapes.both} both, ${read.shapes.ack} go-ahead, ${read.shapes.neither} neither; directives restated by a later assistant turn ${read.directivesRestated}`,
	);
	console.log(
		`   drafts citing a user line: ${read.draftsCitingUser.question} on a question, ${read.draftsCitingUser.directive} on a directive, ${read.draftsCitingUser.both} on a line that is both, ${read.draftsCitingUser.ack} on a go-ahead, ${read.draftsCitingUser.neither} on neither`,
	);
	console.log(
		`   drafts carrying a directive's words while citing no user line ${read.draftsCarryingDirectiveUnmarked}; bank carries a directive's words in ${read.bankFactsCarryingDirective} of ${read.bankActive} current facts, marked user-grounded ${read.bankFactsCarryingDirectiveMarked}`,
	);
	console.log(
		`   marks written ${read.marksWritten}, still current ${read.bankFactsMarkedUser}; lost to a merge ${read.marksLostToMerge}, to an invalidation ${read.marksLostToInvalidation}, to the bank ceiling ${read.marksLostToCeiling}, unattributed ${read.marksLostUnattributed}`,
	);
	if (read.bankFactsCarryingDirective > read.bankFactsCarryingDirectiveMarked) {
		console.log(
			`   ${read.bankFactsCarryingDirective - read.bankFactsCarryingDirectiveMarked} fact(s) carry the user's own wording with no mark on them`,
		);
	}
	if (read.bankFactsCarryingDirectiveFromMarkedAncestor > 0) {
		console.log(
			`   ${read.bankFactsCarryingDirectiveFromMarkedAncestor} of them sit where a marked fact used to be: a later merge restated the constraint and the mark went with the row it replaced`,
		);
	}
	for (const turn of read.turns.slice(0, 4)) {
		console.log(
			`     [${turn.index}] ${turn.shape}${turn.restatedBy !== null ? ` restated at [${turn.restatedBy}]` : ""}: ${turn.text.slice(0, 90)}`,
		);
	}
}

function main(): void {
	const args = process.argv.slice(2);
	const flag = (name: string): string | undefined => {
		const at = args.indexOf(name);
		return at >= 0 ? args[at + 1] : undefined;
	};
	const captureDirs = args.includes("--captures") ? [flag("--captures")!] : discoverCaptureDirs();
	const snapshot = flag("--snapshot") ?? "out/live-snapshot";
	if (captureDirs.length === 0) {
		console.error("no capture directories found (pass --captures <dir>)");
		process.exit(2);
	}
	// Two directories can hold the same session: whole chunks and the pieces a chunk was cut into.
	// Whole chunks win, because a piece is a fragment of a turn the writer saw whole.
	const bySession = new Map<string, { whole: boolean; captures: ReturnType<typeof readCaptures> }>();
	for (const dir of captureDirs) {
		const captures = readCaptures(dir);
		const short = sessionIdFrom(captures);
		if (!short) continue;
		const whole = captures.every((c) => !/\.\d+$/.test(c.chunkId));
		const held = bySession.get(short);
		if (!held || (whole && !held.whole) || (whole === held.whole && captures.length > held.captures.length)) {
			bySession.set(short, { whole, captures });
		}
	}
	if (bySession.size < captureDirs.length) {
		console.log(
			`${captureDirs.length} capture directories, ${bySession.size} sessions — fragments set aside where the whole chunk was captured`,
		);
	}

	const reads: SessionRead[] = [];
	for (const [short, held] of [...bySession.entries()].sort()) {
		const snapshotData = existsSync(snapshot) ? loadSnapshot(snapshot, short) : null;
		if (!snapshotData) {
			console.log(
				`${short}: captures read, no ledger in ${snapshot} — draft citation and bank numbers are not available here, not zero`,
			);
			continue;
		}
		reads.push(analyseSession(short, held.captures, snapshotData.records, snapshotData.bank));
	}
	if (reads.length === 0) process.exit(1);
	for (const read of reads) print(read);

	const sum = (pick: (read: SessionRead) => number) => reads.reduce((n, read) => n + pick(read), 0);
	console.log(`\n== ${reads.length} sessions together`);
	console.log(
		`   user turns: ${sum((r) => r.userTurns)} of ${sum((r) => r.labelledTurns)} labelled turns — ${sum((r) => r.shapes.question)} questions, ${sum((r) => r.shapes.directive)} directives, ${sum((r) => r.shapes.both)} both, ${sum((r) => r.shapes.ack)} go-aheads, ${sum((r) => r.shapes.neither)} neither`,
	);
	console.log(
		`   directives restated by the assistant ${sum((r) => r.directivesRestated)} of ${sum((r) => r.shapes.directive + r.shapes.both)}`,
	);
	console.log(
		`   drafts citing a user line: ${sum((r) => r.draftsCitingUser.question)} questions, ${sum((r) => r.draftsCitingUser.directive)} directives, ${sum((r) => r.draftsCitingUser.both)} both, ${sum((r) => r.draftsCitingUser.ack)} go-aheads, ${sum((r) => r.draftsCitingUser.neither)} neither`,
	);
	console.log(
		`   bank: ${sum((r) => r.bankActive)} current facts, ${sum((r) => r.bankFactsCarryingDirective)} carry a directive's words, ${sum((r) => r.bankFactsCarryingDirectiveMarked)} of those marked, ${sum((r) => r.bankFactsCarryingDirectiveFromMarkedAncestor)} sitting where a marked fact used to be`,
	);
	console.log(
		`   marks written ${sum((r) => r.marksWritten)}, still current ${sum((r) => r.bankFactsMarkedUser)}; lost to a merge ${sum((r) => r.marksLostToMerge)}, to an invalidation ${sum((r) => r.marksLostToInvalidation)}, to the bank ceiling ${sum((r) => r.marksLostToCeiling)}, unattributed ${sum((r) => r.marksLostUnattributed)}`,
	);
	console.log(
		`   so the mark counts ${sum((r) => r.draftsCitingUser.directive + r.draftsCitingUser.both)} citations of an instruction against ${sum((r) => r.draftsCitingUser.question)} of a question and ${sum((r) => r.draftsCitingUser.ack)} of a go-ahead, and ${sum((r) => r.bankFactsCarryingDirective - r.bankFactsCarryingDirectiveMarked)} facts carry the user's wording with no mark on them`,
	);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
