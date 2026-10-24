/**
 * The actor-frame extract prompt is an experiment arm: the shipped prompt plus the clauses
 * the upstream Hy-Memory coding harness puts at the top of its own extract prompt. A run
 * measures the model; this file pins the plumbing around it.
 *
 * What it proves: the arm reaches only the extract call and never the transcript; the
 * flagless path is byte-identical to the one every published baseline ran on; the arm is
 * additive, so its difference from the shipped prompt is the new clauses rather than a
 * rewrite that could quietly move something else; it asks the writer for no field it was
 * never trained to emit, and it does not smuggle in upstream's mandate to store something,
 * which is the one place the arm deliberately disagrees with upstream; reconcile is not
 * touched; the variant survives the JSON re-ask; and the shipped extension never sets it.
 *
 * What it cannot prove is model behaviour. Whether the writer stops banking narration when
 * the prompt names the actor frame is a run measurement, and this file says so rather than
 * implying otherwise.
 */

import { readFileSync } from "node:fs";
import { ACTOR_FRAME_EXTRACT_SYSTEM } from "../dev/prompts-actorframe.js";
import { writeChunk } from "../src/pipeline.js";
import { EXTRACT_SYSTEM } from "../src/prompts.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

/**
 * Labeled the way a real chunk arrives, so serialization has something to turn into refs and
 * a draft can be accepted: the writer sees `[0]`, never the id.
 */
const LABELED =
	"[Source entry id: aaaa1111bbbb] run tctl drain\n[Source entry id: cccccccc2222] drain refused: lock held by pid 4412";
const SERIALIZED = "[0] run tctl drain\n[1] drain refused: lock held by pid 4412";
const DRAFT_REPLY = JSON.stringify({
	drafts: [
		{
			task: "drain lock",
			statement: "tctl drain fails while the lock is held by pid 4412.",
			keys: ["drain", "lock"],
			refs: [1],
		},
	],
});

function spy(badExtractOnce = false) {
	const seen: { label: string; system: string; user: string }[] = [];
	let extractAnswers = 0;
	return {
		seen,
		writer: {
			model: "fake",
			async complete(system: string, user: string, label: string) {
				seen.push({ label, system, user });
				if (label.startsWith("extract")) {
					extractAnswers++;
					return {
						content:
							badExtractOnce && extractAnswers === 1
								? "I could not shape this as JSON: the fact is about the drain lock"
								: DRAFT_REPLY,
						usage: { inTokens: 100, outTokens: 5, wallS: 0 },
						model: { provider: "test", id: "fake" },
					};
				}
				return {
					content: JSON.stringify({ ops: [] }),
					usage: { inTokens: 200, outTokens: 5, wallS: 0 },
					model: { provider: "test", id: "fake" },
				};
			},
		},
	};
}

const extractCalls = (s: ReturnType<typeof spy>) => s.seen.filter((c) => c.label.startsWith("extract"));
const reconcileCalls = (s: ReturnType<typeof spy>) => s.seen.filter((c) => c.label.startsWith("reconcile"));

// ---- 1) the flagless path is the published one -------------------------------------
{
	const s = spy();
	await writeChunk(s.writer as never, [], "chunk-1", LABELED, {});
	check("no variant: extract is shown the shipped prompt exactly", extractCalls(s)[0].system, EXTRACT_SYSTEM);
	check("and the chunk as serialized", extractCalls(s)[0].user, SERIALIZED);
	check("the writer was never shown an entry id", extractCalls(s)[0].user.includes("aaaa1111bbbb"), false);
}

// ---- 2) the variant moves the system prompt and nothing else ----------------------
{
	const s = spy();
	await writeChunk(s.writer as never, [], "chunk-1", LABELED, { extractSystem: ACTOR_FRAME_EXTRACT_SYSTEM });
	const extract = extractCalls(s)[0];
	check("variant reaches extract", extract.system, ACTOR_FRAME_EXTRACT_SYSTEM);
	check("the transcript is untouched by the arm", extract.user, SERIALIZED);
	check("the arm is not a bank-visibility arm", extract.user.includes("<existing_memory>"), false);
	// Reconcile is a separate contract and this arm says nothing about it.
	const reconcile = reconcileCalls(s)[0];
	check("reconcile still runs", reconcile !== undefined, true);
	check("reconcile carries no actor-frame clause", reconcile.system.includes("grammatical subject"), false);
}

// ---- 3) the arm is additive: every shipped line is still there, verbatim ----------
{
	const shippedLines = EXTRACT_SYSTEM.split("\n").filter((line) => line.trim().length > 0);
	const missing = shippedLines.filter((line) => !ACTOR_FRAME_EXTRACT_SYSTEM.includes(line));
	check("no shipped clause was dropped or reworded", missing, []);
	const variantLines = ACTOR_FRAME_EXTRACT_SYSTEM.split("\n").filter((line) => line.trim().length > 0);
	check("the arm adds lines", variantLines.length > shippedLines.length, true);
	check(
		"what it adds names the actor frame",
		[
			ACTOR_FRAME_EXTRACT_SYSTEM.includes("Its grammatical subject is never a person and never the agent"),
			ACTOR_FRAME_EXTRACT_SYSTEM.includes("Never close a statement with a bookkeeping phrase"),
			ACTOR_FRAME_EXTRACT_SYSTEM.includes("Spend the same budget on higher-value tokens"),
			ACTOR_FRAME_EXTRACT_SYSTEM.includes("Never complete a command with a customary flag"),
		],
		[true, true, true, true],
	);
	// A stated constraint must survive as the constraint, or the actor-frame rule reads as a
	// ban on every fact about a user instruction and the attribution pairs die of the arm's
	// own wording rather than of the model's behaviour.
	check(
		"a user-stated constraint survives as the constraint",
		ACTOR_FRAME_EXTRACT_SYSTEM.includes("survives as the constraint itself"),
		true,
	);
}

// ---- 4) the arm asks for nothing the writer was not trained to emit --------------
{
	const schemaLine =
		'{"drafts":[{"task":"short subject","statement":"one self-contained sentence","keys":["keyword","keyword"],"refs":[7,9]}]}';
	check("the draft schema line is identical in the variant", ACTOR_FRAME_EXTRACT_SYSTEM.includes(schemaLine), true);
	check("and identical in the shipped prompt", EXTRACT_SYSTEM.includes(schemaLine), true);
	for (const forbidden of ["confidence", "relevance", "durability", "score", "<id>", "existing_memory"]) {
		check(`the variant does not ask for "${forbidden}"`, ACTOR_FRAME_EXTRACT_SYSTEM.includes(forbidden), false);
	}
	// Upstream mandates at least one record. This arm keeps our empty answer: that is the one
	// place it disagrees with upstream, on purpose, and it has to stay visible.
	check("the empty answer is still offered", ACTOR_FRAME_EXTRACT_SYSTEM.includes('return {"drafts":[]}'), true);
	check("and no mandate to produce something", /MUST output at least ONE/i.test(ACTOR_FRAME_EXTRACT_SYSTEM), false);
}

// ---- 5) reconcile is the same call in both arms ----------------------------------
{
	const plain = spy();
	await writeChunk(plain.writer as never, [], "chunk-1", LABELED, {});
	const armed = spy();
	await writeChunk(armed.writer as never, [], "chunk-1", LABELED, { extractSystem: ACTOR_FRAME_EXTRACT_SYSTEM });
	check(
		"the reconcile system prompt is identical in both arms",
		reconcileCalls(armed)[0].system,
		reconcileCalls(plain)[0].system,
	);
	check("both arms proposed the same draft", reconcileCalls(armed).length, reconcileCalls(plain).length);
}

// ---- 6) the JSON re-ask carries the same contract as the first attempt -----------
{
	const s = spy(true);
	await writeChunk(s.writer as never, [], "chunk-1", LABELED, { extractSystem: ACTOR_FRAME_EXTRACT_SYSTEM });
	const asks = extractCalls(s);
	check("the unparseable reply was re-asked once", asks.length, 2);
	check("the re-ask uses the variant, not the shipped prompt", asks[1].system, ACTOR_FRAME_EXTRACT_SYSTEM);
	check("both attempts used the same system prompt", asks[0].system === asks[1].system, true);
	check("the re-ask still carries the chunk", asks[1].user.includes(SERIALIZED), true);
}

// ---- 7) the shipped extension never sets the arm ---------------------------------
{
	const shipped = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	check("src/index.ts never passes extractSystem", shipped.includes("extractSystem"), false);
	check("src/index.ts never imports the variant", shipped.includes("prompts-actorframe"), false);
}

if (failures > 0) {
	console.log(`FAILED: ${failures} assertion(s)`);
	process.exit(1);
}
console.log(
	"ok: the variant reaches only the extract call, is additive against the shipped prompt, adds the actor-frame clauses and nothing the writer was not trained to emit, keeps the empty answer, leaves reconcile alone, survives the JSON re-ask, and is never set by the shipped extension",
);
