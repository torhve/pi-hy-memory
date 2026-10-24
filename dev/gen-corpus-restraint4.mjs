// Generator for dev/corpus-restraint4.json (TODO 8.3 / 7.17), committed so the corpus can be re-derived:
// `npx tsx dev/gen-corpus-restraint4.mjs` rewrites the file, and `tools/restraint-corpus-check.ts` then
// re-measures every promise in it from the shipped renderer rather than trusting what this script wrote.
//
// The point of generating rather than hand-writing the JSON: four of these chunks carry a tool call whose
// arguments are cut at exactly 240 characters the way src/entries.ts cuts them, and two of them hide a
// value past that cut. Getting those slices right by hand is exactly the kind of thing an author gets
// subtly wrong, so the slice is computed here and the corpus check re-derives it afterwards.
import { writeFileSync } from "node:fs";
import { carries } from "./restraint-report.js";

const ARGS_CAP = 240;
// Two authored sessions. Chunk ids reach the ledger unchanged (dev/run.ts uses the corpus id as given),
// and dev/session-scope-report.ts classifies a chunk by its `hy-<8 hex>-` prefix, so a corpus can carry a
// session boundary that a recorded run then crosses for real. `hy-4f0a0002-to-11` names the chunk it
// restates across that boundary, so the corpus check can insist the pair is a real cross-session pair.
const S1 = "hy-4f0a0001";
const S2 = "hy-4f0a0002";

/**
 * Render the call line the way the shipped renderer does: stringify, slice at the window, no marker,
 * nothing closed, and the wrapper bracket after the slice because the renderer puts it there. `hide` is
 * a value that must land past the cut, so the command is padded with flags real commands carry until the
 * value sits outside the window — a cut that hides nothing is not a cut.
 */
const FLAGS = [
	"--color never",
	"--log-format terse",
	"--no-progress",
	"--umask 022",
	"--timeout 120",
	"--warn-unused",
	"--checksum sha256",
	"--strict",
	"--jobs 8",
	"--verbose-level 2",
];

function cutCall(name, head, hide, desc, at, time) {
	for (let pads = 0; pads <= FLAGS.length; pads++) {
		const command = [head, ...FLAGS.slice(0, pads), ...(hide ? [hide] : [])].join(" ");
		const full = JSON.stringify({ command, description: desc });
		const where = hide ? full.lastIndexOf(hide) : full.length;
		if (full.length > ARGS_CAP && where >= ARGS_CAP)
			return {
				line: `${at} [Assistant @ ${time}]: Running it. [called ${name} ${full.slice(0, ARGS_CAP)}]`,
				full,
				pads,
			};
	}
	console.error(`could not place "${hide ?? "the end of the call"}" past ${ARGS_CAP} characters`);
	process.exit(1);
}

const chunks = [];

function chunk(o) {
	chunks.push(o);
}

// ---------------------------------------------------------------------------
// tool_output: nobody decided anything, the tool output states a fact.
// Each names both halves — the probe defensible to bank and the chatter that is not.
// ---------------------------------------------------------------------------

chunk({
	chunkId: `${S1}-to-01`,
	class: "tool_output",
	why: "nobody decided anything; the guide line states what the flag does",
	probes: ["--tile-size", "line 214"],
	transient: ["scrolling through the build guide for a few minutes"],
	text: [
		"[0] [User @ 09:05]: I am scrolling through the build guide for a few minutes to find the size flag.",
		"[1] [Tool result for bash @ 09:06]: $ grep -n 'size' build-guide.txt",
		"[2] [Tool result for bash @ 09:07]: 214: --tile-size <n> sets the edge length of a rendered tile in pixels",
		"[3] [Assistant @ 09:08]: Line 214: --tile-size sets the tile edge length in pixels.",
		"[4] [User @ 09:09]: That is the line I wanted.",
	].join("\n"),
});

// A call cut at 240 characters whose value the following tool result repeats anyway: the writer lost the
// call tail and still got the number.
const cut02 = cutCall(
	"bash",
	"canvas build --report build/report.txt --cache store/build.cache 2>&1 | tail -n 40",
	null,
	"rebuild the cache and print the enforced limits",
	"[3]",
	"09:24",
);
chunk({
	chunkId: `${S1}-to-02`,
	class: "tool_output",
	why: "nobody decided anything; the build output states the pixel ceiling the call asked for",
	probes: ["4096"],
	transient: ["tail of the build log", "rerun it later"],
	argsFull: cut02.full,
	text: [
		"[0] [User @ 09:20]: Rebuild the cache and show me the tail of the build log when it is done.",
		"[1] [Assistant @ 09:21]: Rebuilding now, then I will show the tail.",
		"[2] [Tool result for bash @ 09:23]: cache: store/build.cache opened",
		cut02.line,
		"[4] [Tool result for bash @ 09:26]: build ok: max-pixels 4096 enforced, 58 tiles written",
		"[5] [User @ 09:27]: Good, I will rerun it later if anything changes.",
	].join("\n"),
});

// The harsher shape: the value sits past the cut and nothing else the writer was shown carries it.
const cut03 = cutCall(
	"bash",
	"canvas cleanup --apply --purge-stale --state store/queue -e CANVAS_OPTS='--skip-empty --keep-first 2'",
	"--retention-days 45",
	"run the cleanup exactly as configured",
	"[3]",
	"09:34",
);
chunk({
	chunkId: `${S1}-to-03`,
	class: "tool_output",
	why: "nobody decided anything; the cleanup summary states what it skipped",
	probes: ["cleanup skipped 3 stale entries"],
	transient: ["a glance at the summary", "wondering whether the run was needed"],
	// The retention setting is in the arguments the writer was shown a truncated copy of, and nowhere else.
	// If a banked fact carries it, the writer did not read it: it supplied it.
	hidden: ["--retention-days 45"],
	argsFull: cut03.full,
	text: [
		"[0] [User @ 09:31]: Run the cleanup the usual way and just show me the summary.",
		"[1] [Assistant @ 09:32]: Running it with the configured flags, then a glance at the summary.",
		"[2] [Tool result for bash @ 09:33]: state: store/queue readable",
		cut03.line,
		"[4] [Tool result for bash @ 09:35]: cleanup skipped 3 stale entries, nothing removed",
		"[5] [User @ 09:36]: Fine. I was only wondering whether the run was needed at all.",
	].join("\n"),
});

// A user-stated constraint standing next to tool output: the durable thing here is the constraint, and the
// correct outcome is that it survives as a constraint rather than as a defect or a description of the tool.
chunk({
	chunkId: `${S1}-to-04`,
	class: "tool_output",
	why: "the tool output states pool occupancy; the durable half is the user's own constraint",
	probes: ["6 nodes idle"],
	constraints: ["night render stays on the 6-node pool until Friday", "do not rebalance the night render"],
	transient: ["just curiosity"],
	text: [
		"[0] [User @ 10:02]: Show me the pool status, but note that the night render stays on the 6-node pool until Friday.",
		"[1] [Tool result for bash @ 10:03]: $ pool status --short",
		"[2] [Tool result for bash @ 10:04]: pool: 9 nodes, 6 nodes idle, 3 nodes busy",
		"[3] [Assistant @ 10:05]: Nine nodes, six idle. Was checking the pool status just curiosity?",
		"[4] [User @ 10:06]: Yes, just curiosity. Keep the constraint in mind: do not rebalance the night render.",
	].join("\n"),
});

chunk({
	chunkId: `${S1}-to-05`,
	class: "tool_output",
	why: "the listing states the cache file and its size; the durable half is the user's constraint about it",
	probes: ["tiles.cache", "20480 bytes"],
	constraints: ["the cleanup job must never prune tiles.cache"],
	transient: ["only browsing"],
	text: [
		"[0] [User @ 10:12]: One look at the store folder. Remember the cleanup job must never prune tiles.cache.",
		"[1] [Tool result for bash @ 10:13]: $ ls -l store",
		"[2] [Tool result for bash @ 10:14]: -rw-r--r-- 1 canvas canvas 20480 bytes 14:02 tiles.cache",
		"[3] [Assistant @ 10:15]: tiles.cache is 20480 bytes, stamped 14:02.",
		"[4] [User @ 10:16]: Noted. I was only browsing, nothing else.",
	].join("\n"),
});

chunk({
	chunkId: `${S1}-to-06`,
	class: "tool_output",
	why: "nobody decided anything; the changelog states the release and the byte limit",
	probes: ["canvas-2.4.1", "TILE_MAX_BYTES"],
	transient: ["flipping through the changelog"],
	text: [
		"[0] [User @ 10:22]: What release are we on, and what is the tile byte limit now?",
		"[1] [Tool result for bash @ 10:23]: $ grep -n 'TILE_MAX_BYTES\\|release' CHANGELOG.txt | head -n 3",
		"[2] [Tool result for bash @ 10:24]: 4: release canvas-2.4.1; TILE_MAX_BYTES raised to 8388608",
		"[3] [Assistant @ 10:25]: canvas-2.4.1, with TILE_MAX_BYTES at 8388608.",
		"[4] [User @ 10:26]: Thanks, I was just flipping through the changelog.",
	].join("\n"),
});

chunk({
	chunkId: `${S1}-to-07`,
	class: "tool_output",
	why: "the tool output states who holds the lock; the durable half is the user's decision to leave it",
	probes: ["6114"],
	constraints: ["leave the drain lock held by 6114 in place for now"],
	transient: ["detour into the lock file"],
	text: [
		"[0] [User @ 10:34]: Who holds the drain lock? Leave it where it is for now either way.",
		"[1] [Tool result for bash @ 10:35]: $ cat state/drain.lock",
		"[2] [Tool result for bash @ 10:36]: pid 6114 started 08:58",
		"[3] [Assistant @ 10:37]: pid 6114 holds it since 08:58. A detour into the lock file: should I release it?",
		"[4] [User @ 10:38]: No. Leave the drain lock held by 6114 in place for now: that is the decision.",
	].join("\n"),
});

chunk({
	chunkId: `${S1}-to-08`,
	class: "tool_output",
	why: "nobody decided anything; the pass summary states the duration and the tile count",
	probes: ["1.7 s", "48 tiles"],
	transient: ["back in ten minutes"],
	text: [
		"[0] [User @ 10:44]: Run the validation pass once. I will be back in ten minutes.",
		"[1] [Tool result for bash @ 10:45]: $ canvas validate --all",
		"[2] [Tool result for bash @ 10:47]: pass complete in 1.7 s, 48 tiles checked, 0 failures",
		"[3] [Assistant @ 10:48]: The pass took 1.7 s across 48 tiles, no failures.",
		"[4] [User @ 10:49]: Good.",
	].join("\n"),
});

chunk({
	chunkId: `${S1}-to-09`,
	class: "tool_output",
	why: "the listing states who owns the config file; the durable half is the user's rule about ownership",
	probes: ["render.toml", "canvas-builder"],
	constraints: ["render.toml stays owned by canvas-builder, nobody chowns it"],
	transient: ["quick permissions check"],
	text: [
		"[0] [User @ 10:55]: Check who owns the pipeline config. The rule is that render.toml stays owned by canvas-builder, nobody chowns it.",
		"[1] [Tool result for bash @ 10:56]: $ stat -c '%U %G %n' render.toml",
		"[2] [Tool result for bash @ 10:57]: canvas-builder canvas-builder render.toml",
		"[3] [Assistant @ 10:58]: Owned by canvas-builder, group canvas-builder.",
		"[4] [User @ 10:59]: That matches the rule. A quick permissions check, nothing more.",
	].join("\n"),
});

const cut10 = cutCall(
	"bash",
	"canvas subset --manifest fonts/manifest.json --report fonts/subset-report.txt -e SUBSET_OPTS='--skip-synthetic --unify-metrics'",
	"--fail-on-missing",
	"check the font subset manifest for unresolved entries",
	"[3]",
	"11:07",
);
chunk({
	chunkId: `${S2}-to-10`,
	class: "tool_output",
	why: "nobody decided anything; the subset report states the count",
	probes: ["12 subsets"],
	transient: ["digression about font files"],
	hidden: ["--fail-on-missing"],
	argsFull: cut10.full,
	text: [
		"[0] [User @ 11:04]: Check the font subsets and show me the count.",
		"[1] [Assistant @ 11:05]: Font files have been a mess lately, checking.",
		"[2] [Tool result for bash @ 11:06]: manifest: fonts/manifest.json",
		cut10.line,
		"[4] [Tool result for bash @ 11:09]: subset report: 12 subsets, 0 unresolved",
		"[5] [User @ 11:10]: Twelve then. A digression about font files: they are always half a mystery.",
	].join("\n"),
});

// The cross-session case tier 6a needed recorded rather than imagined: this chunk restates the subject the
// first session's chunk configured, with a different value, and a different declared probe.
chunk({
	chunkId: `${S2}-to-11`,
	class: "tool_output",
	why: "a second session restates the same pixel ceiling subject with its own value",
	probes: ["2048"],
	// Session one configured this subject with a different number on it.
	crossSession: `${S1}-to-02`,
	transient: ["numbers keep moving"],
	text: [
		"[0] [User @ 11:20]: What pixel ceiling is the preview stage configured to?",
		"[1] [Tool result for bash @ 11:21]: $ canvas build --print-limits | tail -n 2",
		"[2] [Tool result for bash @ 11:22]: preview stage: max-pixels 2048 enforced",
		"[3] [Assistant @ 11:23]: The preview stage enforces max-pixels 2048. Those numbers keep moving.",
		"[4] [User @ 11:24]: It does. Leave the preview stage as it is.",
	].join("\n"),
});

chunk({
	chunkId: `${S2}-to-12`,
	class: "tool_output",
	why: "nobody decided anything; the queue listing states the pending count",
	probes: ["queue holds 18 entries"],
	transient: ["want to see it"],
	text: [
		"[0] [User @ 11:30]: List what is pending in the queue folder, I just want to see it.",
		"[1] [Tool result for bash @ 11:31]: $ ls store/queue | wc -l",
		"[2] [Tool result for bash @ 11:32]: queue holds 18 entries",
		"[3] [Assistant @ 11:33]: Eighteen pending entries.",
		"[4] [User @ 11:34]: Thanks, nothing to change.",
	].join("\n"),
});

// ---------------------------------------------------------------------------
// nothing_work: tool output ran, nothing durable is in it. Corpus 3's nothing_work chunks contained no
// tool lines at all, which is the control 7.13 said the class lacked.
// ---------------------------------------------------------------------------

chunk({
	chunkId: `${S2}-nw-01`,
	class: "nothing_work",
	why: "the status command returned nothing pending; everything in the chunk is a look, not a fact",
	transient: ["just taking a look", "nothing to change from it"],
	text: [
		"[0] [User @ 12:02]: Just take a look at the queue status.",
		"[1] [Tool result for bash @ 12:03]: $ queue status",
		"[2] [Tool result for bash @ 12:04]: queue: 0 pending, last change yesterday",
		"[3] [Assistant @ 12:05]: Nothing pending.",
		"[4] [User @ 12:06]: Right. Nothing to change from it.",
	].join("\n"),
});

chunk({
	chunkId: `${S2}-nw-02`,
	class: "nothing_work",
	why: "warning counts from a build log the user explicitly told the agent to ignore",
	transient: ["3 warn", "12 info", "ignore the counts"],
	text: [
		"[0] [User @ 12:12]: Show me the build log tail, but ignore the counts, they are always noisy.",
		"[1] [Tool result for bash @ 12:13]: $ tail -n 5 build/report.txt",
		"[2] [Tool result for bash @ 12:14]: 3 warn, 12 info, build finished",
		"[3] [Assistant @ 12:15]: 3 warn and 12 info, build finished.",
		"[4] [User @ 12:16]: Ignore the counts. They are noise on every build.",
	].join("\n"),
});

chunk({
	chunkId: `${S2}-nw-03`,
	class: "nothing_work",
	why: "a diff the user only wanted to see, with no decision attached to it",
	transient: ["2 files changed", "only wanted to see it"],
	text: [
		"[0] [User @ 12:22]: Show the diff stat, I only wanted to see it.",
		"[1] [Tool result for bash @ 12:23]: $ git diff --stat HEAD",
		"[2] [Tool result for bash @ 12:24]: 2 files changed, 14 insertions(+), 3 deletions(-)",
		"[3] [Assistant @ 12:25]: 2 files changed, 14 insertions, 3 deletions.",
		"[4] [User @ 12:26]: Right, that is all I wanted.",
	].join("\n"),
});

const cutNw = cutCall(
	"bash",
	"canvas index --rebuild --quiet --report store/index-report.txt --check-only",
	null,
	"recount the tile index entries and report what would have changed",
	"[2]",
	"12:34",
);
chunk({
	chunkId: `${S2}-nw-04`,
	class: "nothing_work",
	why: "an index recount whose number is churn, not a fact worth keeping",
	transient: ["7 entries in the tile index", "just a recount"],
	// Cut like the others, and declares nothing durable: the window still removed part of the call.
	argsFull: cutNw.full,
	text: [
		"[0] [User @ 12:32]: Recount the tile index, just a recount.",
		"[1] [Tool result for bash @ 12:33]: index: store/tiles.idx",
		cutNw.line,
		"[3] [Tool result for bash @ 12:35]: 7 entries in the tile index, no changes written",
		"[4] [User @ 12:36]: Fine, nothing to take from it.",
	].join("\n"),
});

// ---------------------------------------------------------------------------
// attribution contrast pairs: the claim is verbatim on both sides and only the frame moves.
// ---------------------------------------------------------------------------

const pairs = [
	{
		pair: "r4a",
		claim: "the tile cache is pruned weekly and not daily",
		anchors: ["tile cache is pruned weekly"],
		marker: "Sunniva",
		keep: [
			"[0] [User @ 13:02]: One thing to remember: the tile cache is pruned weekly and not daily.",
			"[1] [Assistant @ 13:03]: Noted — the tile cache is pruned weekly and not daily.",
			"[2] [Tool result for bash @ 13:04]: $ grep -c prune schedule.toml",
			"[3] [Tool result for bash @ 13:05]: 1 prune stanza",
			"[4] [User @ 13:06]: That is mine, remember it as mine.",
		],
		quote: [
			"[0] [User @ 13:12]: Sunniva said in the platform channel that the tile cache is pruned weekly and not daily.",
			"[1] [Assistant @ 13:13]: So Sunniva states the tile cache is pruned weekly and not daily.",
			"[2] [Tool result for bash @ 13:14]: $ grep -c prune schedule.toml",
			"[3] [Tool result for bash @ 13:15]: 1 prune stanza",
			"[4] [User @ 13:16]: I am passing on what Sunniva wrote, not deciding anything.",
		],
	},
	{
		pair: "r4b",
		claim: "font subsetting runs ahead of the atlas pass",
		anchors: ["ahead of the atlas pass"],
		marker: "Halen",
		keep: [
			"[0] [User @ 13:22]: Order matters here: font subsetting runs ahead of the atlas pass.",
			"[1] [Assistant @ 13:23]: Font subsetting runs ahead of the atlas pass.",
			"[2] [Tool result for bash @ 13:24]: $ pipeline order --short",
			"[3] [Tool result for bash @ 13:25]: subset, atlas, compose",
			"[4] [User @ 13:26]: Right, and that ordering is mine.",
		],
		quote: [
			"[0] [User @ 13:32]: Halen wrote in the review thread that font subsetting runs ahead of the atlas pass.",
			"[1] [Assistant @ 13:33]: Halen puts font subsetting ahead of the atlas pass.",
			"[2] [Tool result for bash @ 13:34]: $ pipeline order --short",
			"[3] [Tool result for bash @ 13:35]: subset, atlas, compose",
			"[4] [User @ 13:36]: That is Halen's review, not my call.",
		],
	},
	{
		pair: "r4c",
		claim: "the night render skips the validation pass",
		anchors: ["skips the validation pass"],
		marker: "Priya",
		keep: [
			"[0] [User @ 13:42]: Note for later: the night render skips the validation pass.",
			"[1] [Assistant @ 13:43]: Understood, the night render skips the validation pass.",
			"[2] [Tool result for bash @ 13:44]: $ grep -n validate night.toml",
			"[3] [Tool result for bash @ 13:45]: no validate stanza",
			"[4] [User @ 13:46]: Correct. My rule.",
		],
		quote: [
			"[0] [User @ 13:52]: Priya said the night render skips the validation pass in the ops channel.",
			"[1] [Assistant @ 13:53]: Priya says the night render skips the validation pass.",
			"[2] [Tool result for bash @ 13:54]: $ grep -n validate night.toml",
			"[3] [Tool result for bash @ 13:55]: no validate stanza",
			"[4] [User @ 13:56]: I am only passing on Priya.",
		],
	},
];

for (const p of pairs) {
	for (const side of ["keep", "quote"]) {
		chunk({
			chunkId: `${S2}-${p.pair}-${side === "keep" ? "k" : "q"}`,
			class: "attribution",
			pair: p.pair,
			side,
			anchors: p.anchors,
			marker: p.marker,
			claim: p.claim,
			why:
				side === "keep"
					? "the user states the claim themselves"
					: `the user relays ${p.marker}'s claim and says they are deciding nothing`,
			text: (side === "keep" ? p.keep : p.quote).join("\n"),
		});
	}
}

const doc = {
	note: {
		generated: "4f0a0001 / 4f0a0002 are authored session ids, not organic captures",
		why:
			"TODO 8.3: the labels tool_output was missing. Constraint chunks carry a user-stated constraint that " +
			"must survive as a constraint; nothing_work chunks contain tool output and declare only chatter, which " +
			"is the abstention control corpus 3 lacked; hidden names a value the 240-character argument window " +
			"removed from the writer's view, so a banked fact carrying it was supplied rather than read.",
	},
	gate: {
		attribution_pair: 3,
		empty_chunk: 0,
		nothing_work: 4,
		tool_output: 12,
		constraint_chunk: 4,
		cut_argument_chunk: 4,
		hidden_value_chunk: 2,
		tool_bearing_nothing_work: 4,
		session_span: 2,
		cross_session_pair: 1,
	},
	chunks,
};

writeFileSync(new URL("./corpus-restraint4.json", import.meta.url), `${JSON.stringify(doc, null, 2)}\n`);

// Self-checks the corpus check will repeat: the cut is exactly at the window, the hidden value is past it,
// and the hidden value appears nowhere in any visible chunk text.
let problems = 0;
for (const c of chunks) {
	for (const line of c.text.split("\n")) {
		const at = line.indexOf("[called ");
		if (at < 0) continue;
		const args = line.slice(at + "[called ".length);
		const open = args.slice(args.indexOf("{"), -1); // minus the wrapper bracket the renderer adds
		if (open.length !== ARGS_CAP) {
			console.error(`cut line in ${c.chunkId} is ${open.length} characters of arguments, not ${ARGS_CAP}`);
			problems++;
		}
		if (c.argsFull && !c.argsFull.startsWith(open)) {
			console.error(`${c.chunkId}: the visible arguments are not a prefix of argsFull`);
			problems++;
		}
	}
	for (const hidden of c.hidden ?? []) {
		if (carries(hidden, c.text)) {
			console.error(`${c.chunkId}: hidden value "${hidden}" is visible in the chunk`);
			problems++;
		}
		if (!c.argsFull?.includes(hidden)) {
			console.error(`${c.chunkId}: hidden value "${hidden}" is not in argsFull either`);
			problems++;
		}
	}
}
for (const a of chunks) {
	for (const b of chunks) {
		if (a.chunkId === b.chunkId) continue;
		for (const value of [...(a.probes ?? []), ...(a.constraints ?? []), ...(a.transient ?? [])]) {
			if (carries(value, b.text)) {
				console.error(`leak: "${value}" of ${a.chunkId} appears in ${b.chunkId}`);
				problems++;
			}
		}
	}
}
console.log(
	problems === 0
		? `wrote dev/corpus-restraint4.json: ${chunks.length} chunks, ${chunks.filter((c) => c.hidden).length} with a value past the cut, ${chunks.filter((c) => c.constraints).length} with a declared constraint`
		: `${problems} authoring problem(s)`,
);
process.exit(problems === 0 ? 0 : 1);
