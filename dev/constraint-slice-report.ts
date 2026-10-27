/**
 * Does a constraint slice built on the statement's shape fill anything the mark-based one does not?
 * (TODO 6.20c)
 *
 * 6.20b found that the summary's reserved constraint slice selects on `fromUser` and can fill from
 * 3 facts out of 820, because a user turn is usually a go-ahead and the mark leaves when a merge
 * restates the fact. The other way to choose that slice is the statement itself: a fact that states
 * a rule rather than a measurement. This prices that without changing the shipped selector — it runs
 * `selectForSummary` on a shadow bank whose mark has been moved onto rule-shaped statements, so the
 * comparison is the shipped code path with one input changed, not a reimplementation.
 *
 * It reports both a narrow and a broad rule test, because a shape test is wording and the count is
 * an approximation either way, and it reports which facts the counterfactual displaces rather than
 * only how many it selects. One caveat it prints: the shadow bank's marks also change *foundations*
 * eligibility, which excludes marked facts, so the difference reported is both effects together,
 * not a clean slice-only comparison. Offline: reads the frozen snapshot beside `dev/live-bank-report.ts`.
 *
 *   npx tsx dev/constraint-slice-report.ts [--snapshot <dir>] [--max-tokens <n>] [--samples]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { selectForSummary } from "../src/render.js";
import type { BankEntry, LedgerRecord } from "../src/types.js";
import { parseJsonl, snapshotIdentityLine } from "./live-bank-report.js";

type Args = { dir: string; maxTokens: number; samples: boolean; list: boolean };

/** The same three files `dev/live-bank-report.ts` reads, from a snapshot directory by default. */
function parseCli(argv: string[]): Args {
	const args = argv.slice(2);
	const arg = (name: string): string | undefined => {
		const at = args.indexOf(`--${name}`);
		return at >= 0 ? args[at + 1] : undefined;
	};
	return {
		dir: arg("snapshot") ?? arg("dir") ?? "out/live-snapshot",
		maxTokens: Number(arg("max-tokens") ?? 1500),
		samples: args.includes("--samples"),
		list: args.includes("--list"),
	};
}

function sessionIds(dir: string): string[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith(".bank.json"))
		.map((f) => f.slice(0, -".bank.json".length))
		.sort();
}

/**
 * A statement that reads as a rule: an instruction about what to do, not a report of what was
 * found. Narrow means the wording could hardly be a measurement; broad adds obligation words that
 * do appear inside measurements ("only 3 of 12 tests passed"), so the two bounds are reported.
 */
const NARROW =
	/\b(?:don'?t|do not|never|avoid|make sure|must|always|keep it|leave it|stay[s]? alone|stick to|only use|prefer)\b/i;
const BROAD_EXTRA = /\b(?:should|requires?|prefer|only|use the|before you|after you|same as|remember)\b/i;

const NOT_RULE_PROXY =
	/\b(?:failed|error|exception|traceback|returns|is exported|must be|cannot|undefined|expected|next[:\s]|next step|next action|plan[:\s]|steps[:\s])\b/i;

export function ruleShape(statement: string): { narrow: boolean; broad: boolean; notRuleProxy: boolean } {
	const narrow = NARROW.test(statement);
	return {
		narrow,
		broad: narrow || BROAD_EXTRA.test(statement),
		notRuleProxy: narrow && NOT_RULE_PROXY.test(statement),
	};
}

export type SliceRead = {
	sessionId: string;
	bankActive: number;
	markedSelected: number;
	ruleNarrow: number;
	ruleBroad: number;
	/** Rule-shaped facts the shipped slice cannot select, because they carry no mark. */
	ruleNarrowUnmarked: number;
	ruleBroadUnmarked: number;
	/**
	 * A *proxy* for how many narrow matches are not rules: wording belonging to an error quote, a
	 * code fact or a plan. It is a floor, not a precision measurement — a statement describing
	 * regular behaviour ("the status line always shows writes") matches the narrow test and this
	 * proxy cannot see it. Reported so the shape test is not taken as validated.
	 */
	ruleNarrowNotRuleProxy: number;
	/** Of the facts the counterfactual admits, how many the proxy flags. */
	addedNotRuleProxy: number;
	/** Of all entries whose statement is rule-shaped, how many are still current, and how many
	 * reached current through a merge — the survival question 6.20c asked. */
	ruleTotal: number;
	ruleActive: number;
	ruleReachedCurrentByMerge: number;
	markedTotal: number;
	markedActive: number;
	markedReachedCurrentByMerge: number;
	/** The shipped selection and the shadow selection over the same bank and budget. */
	shownShipped: number;
	shownShadow: number;
	/** Facts in the shipped summary that the rule-shaped slice pushed out, and vice versa. */
	displacedByRule: number;
	addedByRule: number;
	/** What the rule-shaped constraint slice actually got in before the budget spilled. */
	ruleFactsChosenFirst: number;
	displacedSamples: string[];
	addedSamples: string[];
};

/**
 * The narrow matches, one per line, with the proxy's verdict beside each. `--list` exists so the
 * true-rule rate can be *labelled by a reader* rather than guessed by a regex (TODO 6.20d): the
 * proxy sees error and code wording and nothing else.
 */
export function listNarrow(sessionId: string, dir: string): string[] {
	const bank = JSON.parse(readFileSync(join(dir, `${sessionId}.bank.json`), "utf8")) as BankEntry[];
	return bank
		.filter((entry) => entry.status === "active" && ruleShape(entry.statement).narrow)
		.map((entry) => `${ruleShape(entry.statement).notRuleProxy ? "proxy" : "     "} ${entry.statement}`)
		.sort();
}

function describe(entry: BankEntry): string {
	return `[${entry.id}] (${entry.task}) ${entry.statement.slice(0, 110)}`;
}

export function readSession(sessionId: string, dir: string, maxTokens: number, samples: boolean): SliceRead {
	// (readSession keeps its signature; --list is handled by listNarrow below.)
	const bank = JSON.parse(readFileSync(join(dir, `${sessionId}.bank.json`), "utf8")) as BankEntry[];
	const active = bank.filter((entry) => entry.status === "active");
	const shape = (entry: BankEntry) => ruleShape(entry.statement);

	const shipped = selectForSummary(bank, maxTokens, { constraintShare: 0.1, foundationShare: 0.35 });
	// The shadow bank carries the mark on rule-shaped statements instead of on citations, and
	// nowhere else: everything about the entries, including token cost, is unchanged.
	const shadowBank: BankEntry[] = bank.map((entry) => ({
		...entry,
		fromUser: shape(entry).narrow,
	}));
	const shadow = selectForSummary(shadowBank, maxTokens, { constraintShare: 0.1, foundationShare: 0.35 });

	const shippedIds = new Set(shipped.shown.map((entry) => entry.id));
	const shadowIds = new Set(shadow.shown.map((entry) => entry.id));
	const displaced = active.filter((entry) => shippedIds.has(entry.id) && !shadowIds.has(entry.id));
	const added = active.filter((entry) => shadowIds.has(entry.id) && !shippedIds.has(entry.id));
	// The constraint slice is filled first, so the first `constraintShare` of the budget is the
	// part the counterfactual fills with rule-shaped facts before anything spills forward.
	const ruleChosen = shadow.shown.filter((entry) => shape(entry).narrow).length;

	return {
		sessionId,
		bankActive: active.length,
		markedSelected: active.filter((entry) => entry.fromUser === true).length,
		ruleNarrow: active.filter((entry) => shape(entry).narrow).length,
		ruleBroad: active.filter((entry) => shape(entry).broad).length,
		ruleNarrowUnmarked: active.filter((entry) => shape(entry).narrow && entry.fromUser !== true).length,
		ruleBroadUnmarked: active.filter((entry) => shape(entry).broad && entry.fromUser !== true).length,
		ruleNarrowNotRuleProxy: active.filter((entry) => shape(entry).notRuleProxy).length,
		addedNotRuleProxy: added.filter((entry) => shape(entry).notRuleProxy).length,
		ruleTotal: bank.filter((entry) => shape(entry).narrow).length,
		ruleActive: bank.filter((entry) => shape(entry).narrow && entry.status === "active").length,
		ruleReachedCurrentByMerge: bank.filter(
			(entry) => shape(entry).narrow && entry.status === "active" && entry.supersedes !== undefined,
		).length,
		markedTotal: bank.filter((entry) => entry.fromUser === true).length,
		markedActive: bank.filter((entry) => entry.fromUser === true && entry.status === "active").length,
		markedReachedCurrentByMerge: bank.filter(
			(entry) => entry.fromUser === true && entry.status === "active" && entry.supersedes !== undefined,
		).length,
		shownShipped: shipped.shown.length,
		shownShadow: shadow.shown.length,
		displacedByRule: displaced.length,
		addedByRule: added.length,
		ruleFactsChosenFirst: ruleChosen,
		displacedSamples: samples ? displaced.slice(0, 4).map(describe) : [],
		addedSamples: samples ? added.slice(0, 4).map(describe) : [],
	};
}

function main(): void {
	const opts = parseCli(process.argv);
	const dir = opts.dir;
	if (!existsSync(dir)) {
		console.log(`no snapshot directory at ${dir} — run dev/live-bank-report.ts --snapshot first`);
		return;
	}
	console.log(`   ${snapshotIdentityLine(dir)}`);
	const ledgerBySession = new Map<string, { writes: number }>();
	for (const id of sessionIds(dir)) {
		const path = join(dir, `${id}.ledger.jsonl`);
		const records: LedgerRecord[] = existsSync(path) ? parseJsonl(readFileSync(path, "utf8")) : [];
		ledgerBySession.set(id, { writes: records.filter((r) => r.type === "hy.ops").length });
	}

	const reads: SliceRead[] = [];
	for (const id of sessionIds(dir)) {
		const read = readSession(id, dir, opts.maxTokens, opts.samples);
		reads.push(read);
		if (opts.list) {
			const lines = listNarrow(id, dir);
			console.log(`   narrow matches to label (${lines.length}):`);
			for (const line of lines) console.log(`   ${line}`);
		}
		const ledger = ledgerBySession.get(id);
		console.log(`== ${id} — bank ${read.bankActive} current, ${ledger?.writes ?? "?"} writes`);
		console.log(
			`   constraint slice as shipped selects ${read.markedSelected} marked facts; a rule-shaped statement selects ${read.ruleNarrow} narrow / ${read.ruleBroad} broad, of which ${read.ruleNarrowUnmarked} / ${read.ruleBroadUnmarked} carry no mark today`,
		);
		console.log(
			`   precision proxy: ${read.ruleNarrowNotRuleProxy} of ${read.ruleNarrow} narrow matches carry error, code or plan wording — a floor on false positives, since the proxy cannot see a statement describing regular behaviour`,
		);
		console.log(
			`   the two slices differ at selection: shipped summary shows ${read.shownShipped} facts, rule-shaped slice shows ${read.shownShadow}, displacing ${read.displacedByRule} and admitting ${read.addedByRule} (${read.addedNotRuleProxy} flagged by the proxy)`,
		);
		console.log(
			`   survival: rule-shaped entries ${read.ruleActive} of ${read.ruleTotal} current (${read.ruleReachedCurrentByMerge} reached current through a merge), marked entries ${read.markedActive} of ${read.markedTotal} (${read.markedReachedCurrentByMerge} through a merge)`,
		);
		for (const line of read.addedSamples) console.log(`   + ${line}`);
		for (const line of read.displacedSamples) console.log(`   - ${line}`);
	}

	const sum = (pick: (r: SliceRead) => number): number => reads.reduce((n, r) => n + pick(r), 0);
	console.log("\n== sessions together");
	console.log(
		`   current facts ${sum((r) => r.bankActive)}: marked ${sum((r) => r.markedSelected)}, rule-shaped narrow ${sum((r) => r.ruleNarrow)} (broad ${sum((r) => r.ruleBroad)}), rule-shaped and unmarked ${sum((r) => r.ruleNarrowUnmarked)}`,
	);
	console.log(
		`   proxy-flagged narrow matches ${sum((r) => r.ruleNarrowNotRuleProxy)} of ${sum((r) => r.ruleNarrow)}; the swap displaces ${sum((r) => r.displacedByRule)} and admits ${sum((r) => r.addedByRule)} (${sum((r) => r.addedNotRuleProxy)} proxy-flagged) — moving the marks also re-partitions foundations, so this difference is not slice-only; rule-shaped facts chosen first ${sum((r) => r.ruleFactsChosenFirst)}`,
	);
	console.log(
		`   rule-shaped entries current ${sum((r) => r.ruleActive)} of ${sum((r) => r.ruleTotal)}, marked entries current ${sum((r) => r.markedActive)} of ${sum((r) => r.markedTotal)}`,
	);
	if (sum((r) => r.markedSelected) === 0)
		console.log(
			"   note: no current fact is marked, so the shipped slice is empty wherever it is not refilled by spill",
		);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
