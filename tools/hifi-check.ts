#!/usr/bin/env node
/**
 * Hi-fi compaction check. Run: npx tsx tools/hifi-check.ts
 *
 * Hi-fi is the one part of this extension where a model writes the compaction summary, so the
 * checks are about what happens when that model is bad:
 *
 *   - a truncated answer is not a shorter summary, it is a failure, and the deterministic
 *     render must take its place;
 *   - an answer that invents structure (missing sections) or drops every fact id is rejected
 *     the same way, because an unattributable checkpoint is pi's summary with our bank thrown
 *     away;
 *   - the delta is what keeps the request small, and a fact the last checkpoint forgot has to
 *     be offered again rather than lost.
 *
 * The provider is pi-ai's faux provider, so every branch is scripted rather than raced.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";

const dir = mkdtempSync(join(tmpdir(), "hy-hifi-"));
process.env.PI_HY_MEMORY_STATE = join(dir, "state");
process.env.PI_HY_MEMORY_CONFIG = join(dir, "config.json");
writeFileSync(
	process.env.PI_HY_MEMORY_CONFIG,
	JSON.stringify({
		model: "test/writer",
		timeoutMs: 1000,
		hifiCompaction: true,
		hifiMaxTokens: 900,
		hifiTailTokens: 1200,
		maxChunkTokens: 20000,
	}),
);

const { buildHifiPrompt, checkHifi, hifiFacts } = await import("../src/hifi.js");
const { estimateTokens } = await import("../src/types.js");
const { default: piHyMemory } = await import("../src/index.js");

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const fact = (id: string, chunkSeq: number, fromUser: boolean, statement = `fact ${id} statement`): any => ({
	id,
	task: `task-${id}`,
	statement,
	status: "active",
	chunkSeq,
	fromUser,
	createdAt: "2026-10-20T00:00:00.000Z",
	tokenCount: estimateTokens(statement),
	supersedes: [],
	supersededBy: null,
	sourceEntryIds: ["e-src-1"],
	sourceChunkIds: ["hy-01234567-001"],
	key: id,
});

/* ---------------------------------------------------------------- prompt ---- */

const bank = [fact("aaaa1111", 1, true), fact("bbbb2222", 4, false), fact("cccc3333", 9, false)];
const prompt = buildHifiPrompt({
	previous: "## Goal\nold checkpoint",
	facts: [bank[1], bank[2]],
	tail: "user: keep going\nassistant: done",
	files: { readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] },
});
check("previous checkpoint is offered", prompt.includes("<previous-summary>\n## Goal\nold checkpoint"), true);
check("new facts carry their ids", prompt.includes("[bbbb2222] (task-bbbb2222) fact bbbb2222 statement"), true);
check("the tail is fenced as conversation", prompt.includes("<recent-conversation>\nuser: keep going"), true);
check("file lists are included", prompt.includes("<modified-files>\nsrc/b.ts"), true);
check(
	"all six sections are demanded",
	["Goal", "Constraints & preferences", "Progress", "Key decisions", "Next steps", "Critical context"].every((s) =>
		prompt.includes(`## ${s}`),
	),
	true,
);
check("ids are required, not suggested", prompt.includes("Do not invent ids."), true);
check(
	"no empty part leaves an empty tag",
	buildHifiPrompt({ facts: [], tail: "", files: { readFiles: [], modifiedFiles: [] } }).includes(
		"<recent-conversation>",
	),
	false,
);

/* ----------------------------------------------------------------- delta ---- */

const ids = (list: any[]) => list.map((e: any) => e.id).sort();
const deltaOf = (list: any[], previous?: string) =>
	hifiFacts(list, { lastSeq: 4, previous, maxTokens: 4000, estimate: estimateTokens });

const plain = [fact("bbbb2222", 4, false), fact("cccc3333", 9, false)];
check("with no checkpoint yet, everything is offered", ids(deltaOf(plain)), ["bbbb2222", "cccc3333"]);
check("once checkpointed, only the newer fact is", ids(deltaOf(plain, "Progress: [bbbb2222] shipped")), ["cccc3333"]);
check(
	"a fact the last checkpoint dropped comes back",
	ids(deltaOf(plain, "Progress: [cccc3333] shipped, bbbb2222 was dropped")),
	["bbbb2222", "cccc3333"],
);
check(
	"user-stated facts are re-offered however old",
	ids(deltaOf([fact("aaaa1111", 1, true), fact("cccc3333", 9, false)], "[aaaa1111] and [cccc3333] both cited")),
	["aaaa1111", "cccc3333"],
);

// A tight budget must not starve the old facts out, or the same 70 would be sent forever.
{
	const wide = Array.from({ length: 30 }, (_, i) => fact(`f${String(i).padStart(2, "0")}xxxx`, i + 1, false));
	const picked = hifiFacts(wide, { lastSeq: 0, maxTokens: 260, estimate: estimateTokens });
	const seqs = picked.map((e: any) => e.chunkSeq);
	check(
		"a tight budget still sends old foundations",
		seqs.some((s: number) => s <= 8),
		true,
	);
	check(
		"and it still sends the newest work",
		seqs.some((s: number) => s >= 25),
		true,
	);
	check("the budget is respected", picked.length < wide.length, true);
}

const tight = hifiFacts([fact("old1", 1, false), fact("old2", 2, false), fact("rule", 3, true)], {
	lastSeq: 0,
	maxTokens: 12,
	estimate: estimateTokens,
});
check(
	"a tight budget keeps the user-stated fact",
	tight.map((e: any) => e.id),
	["rule"],
);

/* ------------------------------------------------------------ validation ---- */

const good = `## Goal
Ship the feature [cccc3333]
## Constraints & preferences
Stay in nynorsk [aaaa1111]
## Progress
Done: bbbb2222
## Key decisions
Chose a store
## Next steps
Write the test
## Critical context
Nothing lost`;
check("a complete answer passes", checkHifi(good, bank, false).ok, true);
check("and counts the ids it kept", checkHifi(good, bank, false).idsKept, 2);
check("truncation is a failure", checkHifi(good, bank, true).reason, "answer was truncated");
check("an empty answer is a failure", checkHifi("", bank, false).reason, "empty answer");
check(
	"but a budget eaten by reasoning is named as such",
	checkHifi("", bank, true, { outputTokens: 2000 }).reason,
	"no text in the answer (2000 output tokens, all of it reasoning or tool calls)",
);
check(
	"invented structure is a failure",
	checkHifi("## Goal\nonly this [cccc3333]", bank, false).reason,
	"missing sections: Constraints & preferences, Progress, Key decisions, Next steps, Critical context",
);
check(
	"an unattributable answer is a failure",
	checkHifi(good.replace(/\[(aaaa1111|bbbb2222|cccc3333)\]/g, ""), bank, false).reason,
	"no fact id survived",
);

/* ---------------------------------------------------------------- wiring ---- */

const faux = registerFauxProvider({
	api: "hy-faux",
	provider: "hy-test",
	models: [{ id: "checkpoint", maxTokens: 900 }],
});
const checkpointModel = faux.getModel();

const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
const pi = {
	on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
	registerTool: () => {},
	registerCommand: () => {},
};

const extractRecord = {
	type: "hy.extract",
	chunkId: "hy-01234567-001",
	coversUpToId: "e-src-1",
	createdAt: "2026-10-20T00:00:00.000Z",
	drafts: [
		{ task: "build", statement: "the store is a store", keys: ["store"], refs: [0], sourceEntryIds: ["e-src-1"] },
	],
	rejectedCount: 0,
	usage: { inTokens: 1, outTokens: 1, wallS: 1 },
};
const opsRecord = {
	type: "hy.ops",
	chunkId: "hy-01234567-001",
	coversUpToId: "e-src-1",
	createdAt: "2026-10-20T00:00:00.000Z",
	ops: [{ action: "ADD", draft: 0 }],
	rejectedCount: 0,
	usage: { inTokens: 1, outTokens: 1, wallS: 1 },
};

const branch = [
	{
		id: "e-src-1",
		type: "message",
		message: { role: "user", content: "the store is a store, the summary is a selection" },
	},
	{ id: "c1", type: "custom", customType: "hy.extract", data: extractRecord },
	{ id: "c2", type: "custom", customType: "hy.ops", data: opsRecord },
	...Array.from({ length: 20 }, (_, i) => ({
		id: `p${i}`,
		type: "message",
		message: { role: "user", content: `entry p${i} ` + "x".repeat(200 * 4 - 10) },
	})),
];

/** Every request the extension made, in order. */
const seen: string[] = [];

type Auth = { ok: boolean; apiKey?: string; error?: string };
const registry: { getApiKeyAndHeaders: (model: unknown) => Promise<Auth> } = {
	getApiKeyAndHeaders: async () => ({ ok: true }),
};

const ctx = {
	sessionManager: { getSessionId: () => "01234567", getBranch: () => branch, getEntry: () => undefined },
	ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_c: string, t: string) => t } },
	model: checkpointModel,
	thinkingLevel: "off",
	modelRegistry: registry,
};

piHyMemory(pi as never);
(handlers.get("session_start") as (e: unknown, c: unknown) => unknown)({}, ctx);

const audit = (): Record<string, unknown>[] =>
	readFileSync(join(process.env.PI_HY_MEMORY_STATE as string, "audit.ndjson"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);

const promptOf = (context: { messages?: { content?: unknown }[] }): string => {
	const content = context.messages?.at(-1)?.content;
	return typeof content === "string" ? content : "";
};

const compact = async (responses: Parameters<typeof faux.setResponses>[0], options: { tokensBefore?: number } = {}) => {
	faux.setResponses(responses);
	return (await (handlers.get("session_before_compact") as (e: unknown, c: unknown) => Promise<any>)(
		{
			type: "session_before_compact",
			reason: "threshold",
			branchEntries: branch,
			preparation: { firstKeptEntryId: "p10", tokensBefore: options.tokensBefore ?? 9000 },
			willRetry: false,
			signal: new AbortController().signal,
		},
		ctx,
	)) as { compaction?: { summary: string } };
};

/** A checkpoint that cites the id the request actually offered, so attribution is real. */
const citing = (body: (id: string) => string) => (context: { messages?: { content?: unknown }[] }) => {
	const id = promptOf(context).match(/\[([0-9a-f]{12})\]/)?.[1] ?? "noid";
	seen.push(promptOf(context));
	return fauxAssistantMessage(body(id), { stopReason: "stop" });
};

// 1. A good checkpoint replaces the render.
{
	const out = await compact([
		citing(
			(id) =>
				`## Goal\nProve the bank is a store [${id}]\n## Constraints & preferences\nNo hostnames in output\n## Progress\nDone: chunk split measured\n## Key decisions\nThe summary is a selection, not the store\n## Next steps\nJudge three arms at a boundary\n## Critical context\nmaxChunkTokens is 6000`,
		),
	]);
	check("the checkpoint is what gets persisted", out?.compaction?.summary.startsWith("## Goal"), true);
	check("and the audit says which path produced it", audit().at(-1)?.summaryKind, "hifi");
	check(
		"hifi_ok records the ids",
		audit()
			.filter((r) => r.event === "hifi_ok")
			.at(-1)?.idsKept,
		1,
	);
	check(
		"the recall affordance is ours, not the model's",
		(out?.compaction?.summary ?? "").includes("use the recall tool with an id"),
		true,
	);
}

// 2. A truncated answer falls back to the render.
{
	const out = await compact([
		fauxAssistantMessage("## Goal\nhalf a checkpoint, then the token budget ran out [000000000000]", {
			stopReason: "length",
		}),
	]);
	check(
		"a truncated answer is not persisted",
		out?.compaction?.summary.startsWith("These are the durable memories"),
		true,
	);
	check(
		"the rejection is audited",
		audit()
			.filter((r) => r.event === "hifi_rejected")
			.at(-1)?.why,
		"answer was truncated",
	);
}

// 3. An answer with no ids falls back too.
{
	await compact([
		fauxAssistantMessage(
			"## Goal\nprose\n## Constraints & preferences\nprose\n## Progress\nprose\n## Key decisions\nprose\n## Next steps\nprose\n## Critical context\nprose",
			{ stopReason: "stop" },
		),
	]);
	check(
		"an unattributable answer is rejected",
		audit()
			.filter((r) => r.event === "hifi_rejected")
			.at(-1)?.why,
		"no fact id survived",
	);
}

// 4. A transport failure falls back.
{
	await compact([fauxAssistantMessage("", { stopReason: "stop", errorMessage: "HTTP 503 unavailable" })]);
	const failure = audit()
		.filter((r) => r.event === "hifi_failed")
		.at(-1);
	check("a transport failure is audited", String(failure?.error).includes("503"), true);
}

// 5. The second boundary sends a delta plus a capped tail, not the transcript.
{
	const branchTokens = branch.filter((e) => (e as { id?: string }).id?.startsWith("p")).length * 200;
	await compact([citing((id) => good.replace("cccc3333", id))], { tokensBefore: 9000 });
	const request = seen.at(-1) ?? "";
	const tail = request.match(/<recent-conversation>\n([\s\S]*?)\n<\/recent-conversation>/)?.[1] ?? "";
	check("the previous checkpoint is offered", request.includes("<previous-summary>"), true);
	check("the kept tail is offered as context", tail.includes("xxxx"), true);
	check("but the tail is capped, not the whole branch", tail.length < branchTokens * 4 && tail.length > 0, true);
	check("and the cap keeps the newest end", tail.includes("entry p19"), true);
	check("dropping the oldest of the kept range", tail.includes("entry p0"), false);
	check("the request is a fraction of the context it summarizes", request.length < branchTokens * 4, true);
}

// 5b. A model with no configured auth never reaches the provider.
{
	const original = registry.getApiKeyAndHeaders;
	registry.getApiKeyAndHeaders = async () => ({ ok: false, error: "no key for provider" });
	const out = await compact([citing((id) => good.replace("cccc3333", id))], { tokensBefore: 9000 });
	check(
		"an unauthenticated model falls back to the render",
		out?.compaction?.summary.startsWith("These are the durable memories"),
		true,
	);
	check(
		"and the reason is audited",
		String(
			audit()
				.filter((r) => r.event === "hifi_failed")
				.at(-1)?.error,
		).includes("no key"),
		true,
	);
	registry.getApiKeyAndHeaders = original;
}

// 6. A restart keeps the checkpoint, so the next boundary is still a delta.
{
	(handlers.get("session_start") as (e: unknown, c: unknown) => unknown)({}, ctx);
	await compact([citing((id) => good.replace("cccc3333", id))], { tokensBefore: 9000 });
	check("the checkpoint survives the restart", (seen.at(-1) ?? "").includes("<previous-summary>"), true);
}

faux.unregister();
console.log(failures === 0 ? "ok: hi-fi compaction" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
