#!/usr/bin/env npx tsx
/**
 * dev/summary-arms.ts — three summaries of the same cut, graded blind.
 *
 * The README claims hy replaces pi's summarizer with a deterministic render, and `hifiCompaction`
 * offers a model-written checkpoint instead. No arm has ever put the three side by side at one
 * real boundary, which is the comparison DESIGN says decides whether hi-fi is worth funding.
 *
 * A boundary is one compaction row in a real session file. Three texts are built for it:
 *
 * - `pi`   — the summary pi actually wrote. Only boundaries pi summarized itself have one, which
 *            is also why those boundaries are the fair ones: all three faced the same cut.
 * - `render` — what the shipped render would have handed over at that cut, with the shipped budget.
 * - `hifi`   — what the shipped hi-fi path would have asked the session model to write.
 *
 * The bank is rebuilt from the ledger records whose `coversUpToId` names an entry the cut still
 * held *and* whose `createdAt` predates the cut. Coverage alone would admit a write that landed
 * after the compaction, which is how a reconstruction quietly gets facts the session never had at
 * that moment. The active count is printed against both cuts so a reader can see the difference.
 * It is still a reconstruction, not a snapshot.
 *
 * Questions come from the conversation the cut removed and from ledger transitions — never from a
 * candidate text, and never from the rendered bank, because the render arm prints bank statements
 * verbatim and questions mined from them would score memory rather than summarizing. Each
 * candidate is graded on its own, unlabeled, by a model that wrote none of them, on one standard:
 * what a next session can answer from the summary alone. False claims and essential omissions are
 * recorded next to the score, so a fluent wrong summary cannot win.
 *
 *   npx tsx dev/summary-arms.ts --session <pi session .jsonl> [--row <index>]...
 *       [--model <provider/id>] [--judge <provider/id>] [--thinking-format qwen-chat-template]
 *       [--max-tokens 4000] [--summary-max-tokens 12000] [--out out/summary-arms] [--dry]
 *
 * Costs one writer call and three judge calls per boundary. `--dry` spends no call and prints
 * only the sizes the two deterministic arms produce.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { foldLedger } from "../src/bank.js";
import { SETTING_DEFAULTS } from "../src/config.js";
import { fileOperations, selectTail, serializeEntries } from "../src/entries.js";
import { buildHifiPrompt, checkHifi, hifiFacts, hifiSummary } from "../src/hifi.js";
import { renderFileOperations, renderMemory, summaryBudget } from "../src/render.js";
import { estimateTokens, type LedgerRecord } from "../src/types.js";
import { probeModel } from "./probe-model.js";
import { rawWriter } from "./raw-writer.js";
import { resolveRoute } from "./run.js";

const args = process.argv.slice(2);
const arg = (flag: string, fallback: string): string => {
	const at = args.indexOf(flag);
	return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const rowsOf = (flag: string): number[] => {
	const found: number[] = [];
	args.forEach((a, i) => {
		if (a === flag && args[i + 1]) found.push(Number(args[i + 1]));
	});
	return found;
};
const dry = args.includes("--dry");

const sessionPath = arg("--session", "");
if (!sessionPath) {
	console.error("usage: npx tsx dev/summary-arms.ts --session <pi session .jsonl> [--row <index>]...");
	process.exit(1);
}

const sessionId = basename(sessionPath).match(/_(01[0-9a-f-]{30,})\.jsonl$/)?.[1] ?? "";
const ledgerPath = arg(
	"--ledger",
	join(homedir(), ".pi", "agent", "pi-hy-memory", "state", "sessions", `${sessionId}.ledger.jsonl`),
);

const rows = readFileSync(sessionPath, "utf8")
	.split("\n")
	.filter((l) => l.trim())
	.map((l) => JSON.parse(l) as Record<string, any>);
const ledger = readFileSync(ledgerPath, "utf8")
	.split("\n")
	.filter((l) => l.trim())
	.map((l) => JSON.parse(l) as LedgerRecord);

const branch = rows.flatMap((r, i) =>
	r.type === "message" || r.type === "custom_message" ? [{ row: i, entry: r as unknown as SessionEntry }] : [],
);

/** pi wrote its own summary here, so a `pi` arm exists for these boundaries. */
const wanted = rowsOf("--row");
const boundaries = rows.flatMap((r, i) => {
	if (r.type !== "compaction") return [];
	if (wanted.length > 0) return wanted.includes(i) ? [{ row: i, entry: r }] : [];
	return r.fromHook === false ? [{ row: i, entry: r }] : [];
});
if (boundaries.length === 0) {
	console.error("no boundary rows matched; pass --row <index> for a compaction row");
	process.exit(1);
}

const textOf = (entry: any): string => {
	const content = entry?.message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.filter((b: any) => b?.type === "text" && typeof b.text === "string")
			.map((b: any) => b.text)
			.join(" ");
	return "";
};
const isUserTurn = (entry: any): boolean => entry?.type === "message" && entry?.message?.role === "user";
const quote = (text: string, max = 420): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};
/** Evenly spaced picks, so a question set is not five turns from the same minute. */
const spread = <T>(items: T[], count: number): T[] => {
	if (items.length <= count) return items;
	return Array.from({ length: count }, (_, i) => items[Math.round((i * (items.length - 1)) / (count - 1))]);
};

const selection = {
	foundationAfterChunks: SETTING_DEFAULTS.foundationAfterChunks,
	constraintShare: SETTING_DEFAULTS.summaryConstraintShare,
	foundationShare: SETTING_DEFAULTS.summaryFoundationShare,
};

const outDir = arg("--out", "out/summary-arms");
mkdirSync(outDir, { recursive: true });

const writerRoute = await resolveRoute(arg("--model", "qwen3.8-flash-next-gyro_m-strata"));
const maxTokens = Number(arg("--max-tokens", String(SETTING_DEFAULTS.hifiMaxTokens)));
const summaryMaxTokens = Number(arg("--summary-max-tokens", String(SETTING_DEFAULTS.summaryMaxTokens)));
const model = probeModel(writerRoute, {
	maxTokens,
	thinkingFormat: arg("--thinking-format", "qwen-chat-template"),
	offValue: arg("--off-value", ""),
	budgetField: arg("--thinking-budget-field", ""),
});

const judgeSpec = arg("--judge", "deepseek/deepseek-v4-flash");
const judgeRoute = await resolveRoute(judgeSpec);
const judge = rawWriter({
	...judgeRoute,
	temperature: 0,
	maxTokens: 1500,
	// A hosted chat endpoint is not llama.cpp: send it no chat-template fields at all.
	chatTemplateKwargs: false,
});

type Question = { id: string; kind: string; source: string; ask: string };
type ArmScore = {
	arm: string;
	label: string;
	chars: number;
	estTokens: number;
	idsCited: number;
	headings: number;
	yes: number;
	partial: number;
	no: number;
	falseClaims: string[];
	missing: string[];
	answers: { id: string; verdict: string; quote: string }[];
};

const RUBRIC = `You grade one summary of a coding session. A compaction replaced the older
conversation with this summary, and a new session starts from the summary plus a fact bank it can
look things up in. Grade what the summary itself carries.

Rules:
- Size is not a merit. A longer candidate earns nothing for length, and a shorter one is not
  penalised for what it chose not to include unless a question below asks for it.
- A claim the source material contradicts is a false claim. Report it even if the summary scores
  well elsewhere.
- "yes" means the substance is present, in different words is fine. "partial" means hinted,
  truncated or missing the part that changes behaviour. "no" means absent or contradicted.
- Quote the candidate for every yes and partial. Quote nothing for a no.`;

const summarise = (
	text: string,
	activeIds: Set<string>,
): { chars: number; estTokens: number; idsCited: number; headings: number } => ({
	chars: text.length,
	estTokens: estimateTokens(text),
	idsCited: [...text.matchAll(/\[([0-9a-f]{12})\]/g)].filter((m) => activeIds.has(m[1])).length,
	headings: (text.match(/^#{1,3} .*/gm) ?? []).length,
});

for (const boundary of boundaries) {
	const cut = boundary.entry;
	const cutRow = boundary.row;
	const keptRow = rows.findIndex((r) => r.id === cut.firstKeptEntryId);
	const prefix = branch.filter((b) => b.row < cutRow).map((b) => b.entry);
	const keptTail = branch.filter((b) => b.row >= Math.max(keptRow, 0) && b.row < cutRow).map((b) => b.entry);
	const covered = new Set(prefix.map((e) => String((e as any).id)));

	// Coverage puts a record inside the range the cut held; the timestamp keeps out a write that
	// landed after the compaction had already happened.
	const coveredOnly = ledger.filter((r) => covered.has(String(r.coversUpToId)));
	const records = coveredOnly.filter((r) => r.createdAt <= String(cut.timestamp ?? ""));
	const bank = foldLedger(records);
	const active = bank.filter((e) => e.status === "active");
	const activeIds = new Set(active.map((e) => e.id));

	const files = fileOperations(prefix);
	const fileBlock = renderFileOperations(files);
	const fileTokens = fileBlock ? estimateTokens(fileBlock) + 4 : 0;
	// The budget the shipped render is given: `summaryMaxTokens` plus the `[id] (task) ` wrappers
	// it adds on top, less what the file lists took. Printing it makes any overshoot measurable.
	const renderBudget = Math.max(500, summaryBudget(summaryMaxTokens, bank) - fileTokens);
	const renderText = [renderMemory(bank, renderBudget, selection), fileBlock].filter(Boolean).join("\n\n");

	const tail = serializeEntries(selectTail(keptTail, SETTING_DEFAULTS.hifiTailTokens), {
		maxTokens: SETTING_DEFAULTS.hifiTailTokens,
		maxEntryChars: SETTING_DEFAULTS.maxEntryChars,
	});
	const facts = hifiFacts(bank, {
		// No earlier checkpoint exists for this session: hi-fi has never been on, so the first
		// checkpoint is a whole-bank delta, which is the honest starting condition to measure.
		lastSeq: 0,
		previous: undefined,
		maxTokens: SETTING_DEFAULTS.hifiDeltaTokens,
		estimate: estimateTokens,
		selection,
	});
	// `--dry` reports the sizes a compaction could have handed over without spending a call:
	// the render's real size against the budget it was given.
	const hifiCall = dry
		? undefined
		: await hifiSummary({
				model,
				apiKey: writerRoute.apiKey,
				prompt: buildHifiPrompt({
					previous: undefined,
					facts,
					tail: tail.text,
					files,
					budgetTokens: maxTokens,
				}),
				maxTokens,
				timeoutMs: SETTING_DEFAULTS.hifiTimeoutMs,
				reasoning: "off",
			});
	const hifiCheck = hifiCall
		? checkHifi(hifiCall.text, facts, hifiCall.stopReason === "length", {
				outputTokens: hifiCall.usage?.output ?? 0,
			})
		: undefined;

	// Questions: the user's own words from the range the cut removed, and transitions the writer
	// recorded in the ledger. Neither is derived from a candidate.
	const users = prefix.filter(isUserTurn).filter((e) => textOf(e).trim().length >= 40);
	const earlyCut = Math.floor(users.length * 0.4);
	const questions: Question[] = spread(users.slice(0, Math.max(earlyCut, 1)), 5).map((e, i) => ({
		id: `C${i + 1}`,
		kind: "constraint",
		source: quote(textOf(e)),
		ask: "The user stated requirements here. Does the summary carry them, in substance?",
	}));
	const state = users.slice(-3);
	questions.push(
		...state.map((e, i) => ({
			id: `S${i + 1}`,
			kind: "state",
			source: quote(textOf(e)),
			ask: "This was live when the cut happened. Does the summary say what was being worked on?",
		})),
	);

	const draftsByChunk = new Map<string, { statement: string }[]>();
	for (const r of ledger) if (r.type === "hy.extract") draftsByChunk.set(r.chunkId, r.drafts);
	const transitions: { at: string; from: string; to: string; reason: string }[] = [];
	records.forEach((rec, index) => {
		if (rec.type !== "hy.ops") return;
		const before = foldLedger(records.slice(0, index));
		for (const op of rec.ops) {
			if (op.action !== "UPDATE" && op.action !== "DELETE") continue;
			const from = before.find((e) => e.id === op.target);
			const to =
				op.action === "UPDATE"
					? (op.draftStatement ?? draftsByChunk.get(rec.chunkId)?.[op.draft ?? -1]?.statement ?? "")
					: "";
			if (!from?.statement) continue;
			transitions.push({
				at: rec.createdAt.slice(11, 16),
				from: quote(from.statement, 220),
				to: quote(to || "(removed)", 220),
				reason: op.reason ?? "",
			});
		}
	});
	const picks = spread(transitions, 4);
	questions.push(
		...picks.map((t, i) => ({
			id: `T${i + 1}`,
			kind: "transition",
			source: `At ${t.at} the bank changed "${t.from}" to "${t.to}" (reason: ${t.reason || "not given"}).`,
			ask: "Does the summary state the newer state, and does it avoid presenting the older one as current?",
		})),
	);

	const texts: Record<string, string> = {
		pi: String(cut.summary ?? ""),
		render: renderText,
		hifi: hifiCall?.text ?? "",
	};
	const order = ["pi", "render", "hifi"];
	// Deterministic per boundary, so the run is reproducible and no arm is always first.
	const labels = ["A", "B", "C"];
	const seed = cutRow % 3;
	const blind = order.map((arm, i) => ({ arm, label: labels[(i + seed) % 3] }));

	const tag = `${sessionId.slice(0, 8)}-row${cutRow}`;
	const dir = join(outDir, tag);
	mkdirSync(dir, { recursive: true });
	for (const [arm, text] of Object.entries(texts)) writeFileSync(join(dir, `${arm}.md`), text);

	const scores: ArmScore[] = [];
	for (const { arm, label } of dry ? [] : blind.sort((a, b) => a.label.localeCompare(b.label))) {
		const text = texts[arm];
		const prompt = [
			`The session was compacted at ${cut.timestamp}. The candidate below is the summary a new session started from.`,
			"",
			`<candidate>`,
			text,
			`</candidate>`,
			"",
			"Questions. Each quotes material from the conversation the cut removed, not from the candidate.",
			...questions.map((q) => `${q.id} (${q.kind}) ${q.ask}\n  source: ${q.source}`),
			"",
			"Answer with one line per question, choosing exactly one verdict. The id is the question id, for example C1 or T2:",
			"<id>|yes|<quote from the candidate, 120 chars max>",
			"<id>|partial|<quote from the candidate, or nothing>",
			"<id>|no|",
			"Then only if there are any, one line each for a false claim and for an essential omission:",
			"FALSE|<claim the removed conversation contradicts>",
			"MISSING|<what the next session needs and cannot find in the summary>",
		].join("\n");
		const completion = await judge.complete(RUBRIC, prompt, `judge ${tag} ${arm}`);
		writeFileSync(join(dir, `judge-${arm}.txt`), completion.content);
		const lines = completion.content.split("\n").map((l) => l.trim());
		const answers = questions.map((q) => {
			const line = lines.find((l) => l.startsWith(`${q.id}|`));
			const parts = line?.split("|") ?? [];
			return { id: q.id, verdict: parts[1] ?? "missing", quote: (parts[2] ?? "").slice(0, 160) };
		});
		const s = summarise(text, activeIds);
		scores.push({
			arm,
			label,
			...s,
			yes: answers.filter((a) => a.verdict === "yes").length,
			partial: answers.filter((a) => a.verdict === "partial").length,
			no: answers.filter((a) => a.verdict === "no").length,
			falseClaims: lines.filter((l) => l.startsWith("FALSE|")).map((l) => l.slice(6)),
			missing: lines.filter((l) => l.startsWith("MISSING|")).map((l) => l.slice(8)),
			answers,
		});
	}

	const metrics = {
		tag,
		sessionId,
		cutRow,
		cutTimestamp: cut.timestamp,
		firstKeptEntryId: cut.firstKeptEntryId,
		piTokensBefore: cut.tokensBefore,
		summaryMaxTokensUsed: summaryMaxTokens,
		renderBudget,
		branchBefore: prefix.length,
		keptTailEntries: keptTail.length,
		ledgerRecordsCoverageOnly: coveredOnly.length,
		ledgerRecordsUsed: records.length,
		bankFacts: bank.length,
		activeFacts: active.length,
		activeFactsCoverageOnly: foldLedger(coveredOnly).filter((e) => e.status === "active").length,
		questions: questions.map((q) => ({ id: q.id, kind: q.kind })),
		hifiCall: hifiCall
			? {
					model: writerRoute.model,
					wallS: Math.round(hifiCall.ms / 1000),
					stopReason: hifiCall.stopReason,
					usage: hifiCall.usage,
					verdict: hifiCheck?.ok ? "accepted" : `rejected: ${hifiCheck?.reason ?? "not attempted"}`,
					idsGiven: facts.length,
					idsKept: hifiCheck?.idsKept ?? 0,
				}
			: undefined,
		blindLabels: blind,
		arms: scores,
	};
	writeFileSync(join(dir, "metrics.json"), JSON.stringify(metrics, null, 1));

	console.log(`\n=== ${tag}  cut at ${cut.timestamp} (row ${cutRow}) ===`);
	console.log(
		`branch before ${prefix.length}, kept tail ${keptTail.length}, ledger records ${records.length} used ` +
			`(${coveredOnly.length} by coverage alone), active facts ${active.length} ` +
			`(coverage-only ${metrics.activeFactsCoverageOnly})`,
	);
	if (dry) {
		console.log(`render budget ${renderBudget} est tok (summaryMaxTokens ${summaryMaxTokens})`);
		for (const [arm, text] of Object.entries(texts)) {
			const s = summarise(text, activeIds);
			console.log(
				`${arm.padEnd(7)} chars ${String(s.chars).padStart(6)} esttok ${String(s.estTokens).padStart(5)} ` +
					`ids ${String(s.idsCited).padStart(3)} headings ${s.headings}`,
			);
		}
	}
	if (hifiCall && hifiCheck)
		console.log(
			`hifi call: ${writerRoute.model}, ${Math.round(hifiCall.ms / 1000)} s, stop ${hifiCall.stopReason}, ` +
				`in ${hifiCall.usage?.input ?? 0} out ${hifiCall.usage?.output ?? 0} tok, ` +
				`${hifiCheck.ok ? "accepted" : `REJECTED: ${hifiCheck.reason}`}, ids ${hifiCheck.idsKept}/${facts.length}`,
		);
	console.log(`questions: ${questions.map((q) => q.id).join(" ")}`);
	for (const s of scores) {
		console.log(
			`${s.arm.padEnd(7)} (label ${s.label}) chars ${String(s.chars).padStart(6)} esttok ${String(s.estTokens).padStart(5)} ` +
				`ids ${String(s.idsCited).padStart(3)} headings ${s.headings} | yes ${s.yes} partial ${s.partial} no ${s.no} ` +
				`| false ${s.falseClaims.length} missing ${s.missing.length}`,
		);
	}
	for (const s of scores) {
		for (const a of s.answers) console.log(`  ${s.arm} ${a.id}: ${a.verdict}${a.quote ? ` — ${a.quote}` : ""}`);
		for (const c of s.falseClaims) console.log(`  ${s.arm} FALSE: ${c}`);
		for (const m of s.missing) console.log(`  ${s.arm} MISSING: ${m}`);
	}
}
