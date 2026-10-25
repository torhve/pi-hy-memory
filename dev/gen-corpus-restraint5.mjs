// Generator for dev/corpus-restraint5.json (TODO 8.9), committed so the corpus can be re-derived:
// `npx tsx dev/gen-corpus-restraint5.mjs` rewrites the file, and `tools/restraint-corpus-check.ts`
// then re-measures every promise in it from the shipped code rather than trusting what this script wrote.
//
// What this corpus exists to have that corpora 3 and 4 do not: **every declared value has exactly one
// carrier chunk**, and for each carrier there is a later chunk whose wording the shipped subject guard
// accepts as the same subject while carrying none of the carrier's values. Corpora 3 and 4 bank every
// declared value in more than one chunk, so a merge that retires one carrier leaves the value held
// somewhere else, and `mergeValueGate` cannot be priced on them: corpus 4 never fired it, corpus 3
// refused two merges and changed no value outcome. Here a merge the guard approves destroys the only
// copy of the value, so the only thing standing between the merge and the loss is the value test.
//
// One authored session, because the question is the merge gate rather than the session boundary: a
// crossing would add a second variable to a corpus whose whole point is that it has one.
import { writeFileSync } from "node:fs";
import { sameSubject } from "../src/protocol.js";
import { carries, valueTokens } from "../src/values.js";

const S = "hy-5c0b0001";

/**
 * A carrier chunk: a tool output that states a value and an assistant line that restates it. The value
 * is written into this chunk and nowhere else in the corpus, which is what makes a merge that drops it
 * a loss rather than a reshuffling.
 */
function carrier(n, ask, cmd, shown, spoken, probes, chatter) {
	return {
		chunkId: `${S}-cv-${String(n).padStart(2, "0")}`,
		class: "tool_output",
		role: "carrier",
		why: "nobody decided anything here; the tool output states the value this corpus declares as its only carrier",
		probes,
		transient: [chatter],
		text: [
			`[0] [User @ 09:${String(5 + n).padStart(2, "0")}]: ${ask} (${chatter})`,
			`[1] [Tool result for bash @ 09:${String(6 + n).padStart(2, "0")}]: $ ${cmd}`,
			`[2] [Tool result for bash @ 09:${String(7 + n).padStart(2, "0")}]: ${shown}`,
			`[3] [Assistant @ 09:${String(8 + n).padStart(2, "0")}]: ${spoken}`,
		].join("\n"),
	};
}

/**
 * A pressure chunk: its own single-carrier value, plus an assistant line that re-says the carrier's
 * subject in loose wording and restates none of the carrier's values. This is the chunk that invites
 * the UPDATE the value test has to refuse.
 */
function pressure(n, ask, cmd, count, spoken, probes, mergesInto, chatter) {
	return {
		chunkId: `${S}-pr-${String(n).padStart(2, "0")}`,
		class: "tool_output",
		role: "pressure",
		why: "the only thing said is that the subject was looked at and left alone, which is the wording that invites a merge into the carrier while dropping its value",
		probes,
		mergesInto,
		transient: [chatter],
		text: [
			`[0] [User @ 10:${String(5 + n).padStart(2, "0")}]: ${ask} (${chatter})`,
			`[1] [Tool result for bash @ 10:${String(6 + n).padStart(2, "0")}]: $ ${cmd}`,
			`[2] [Tool result for bash @ 10:${String(7 + n).padStart(2, "0")}]: ${count}`,
			`[3] [Assistant @ 10:${String(8 + n).padStart(2, "0")}]: ${spoken}`,
		].join("\n"),
	};
}

const chunks = [
	carrier(
		1,
		"what is the drain timeout set to?",
		"grep -n drain queue.toml",
		"queue.toml:41: drain_timeout = 90s",
		"queue.toml sets drain_timeout to 90s.",
		["drain_timeout", "90s"],
		"just a quick look at the file",
	),
	pressure(
		1,
		"how many drain mentions are in there?",
		"grep -c drain queue.toml",
		"143",
		"The drain timeout is fine the way it is, I am leaving it alone.",
		["143"],
		`${S}-cv-01`,
		"only counting the drain mentions",
	),
	carrier(
		2,
		"how big is the audit store?",
		"ls -l store/audit.db",
		"-rw-r--r-- 1 staff 32768 Oct 24 09:12 store/audit.db",
		"Audit rows live in store/audit.db and the file is capped at 32768 bytes.",
		["store/audit.db", "32768"],
		"only checking the file size",
	),
	pressure(
		2,
		"who reads the audit store?",
		"grep -rl audit.db src | wc -l",
		"19",
		"The audit store location is settled, nothing about it is changing.",
		["19"],
		`${S}-cv-02`,
		"only counting who reads it",
	),
	carrier(
		3,
		"what is the pool size?",
		"cat workers.toml",
		"pool_size = 12\nspin = 3",
		"The worker pool is pool_size = 12 in workers.toml.",
		["pool_size"],
		"only checking the pool line",
	),
	pressure(
		3,
		"how many pool mentions?",
		"grep -c pool workers.toml",
		"29",
		"The worker pool stays as it is for now.",
		["29"],
		`${S}-cv-03`,
		"only counting the pool mentions",
	),
	carrier(
		4,
		"what drives the snapshot cadence?",
		"grep -n snapshot config.toml",
		"config.toml:8: hy_snapshot_interval = 60",
		"Snapshot cadence is hy_snapshot_interval, 60 seconds.",
		["hy_snapshot_interval"],
		"only checking the cadence line",
	),
	pressure(
		4,
		"how many snapshot mentions?",
		"grep -c snapshot config.toml",
		"17",
		"The snapshot interval knob is not going to change.",
		["17"],
		`${S}-cv-04`,
		"only counting the snapshot mentions",
	),
	carrier(
		5,
		"how many cache shards?",
		"cat cache.toml",
		"cache_shards = 512\nwarm = true",
		"The cache is split into cache_shards = 512.",
		["cache_shards"],
		"only checking the shard line",
	),
	pressure(
		5,
		"how many shard mentions?",
		"grep -c shard cache.toml",
		"58",
		"The cache shards are fine, leaving them as they are.",
		["58"],
		`${S}-cv-05`,
		"only counting the shard mentions",
	),
	// A long carrier, on purpose: the shipped subject test is satisfied by the renderer's own role
	// labels (user, tool, result, bash, assistant are five shared subject tokens), so on a short
	// target any two labelled chunks pass. A target of ~34 subject tokens is the shape where the
	// labels alone are not enough, which is the shape the organic failure had: a fact about one node
	// merged over a whole host inventory. `tools/restraint-corpus-mutation-check.ts` breaks this pair
	// to prove the guard does refuse when only the labels overlap.
	carrier(
		6,
		"Which nodes and containers are running, and where does each one live?",
		"nvcc list --nodes",
		"node-a nginx-proxy container 118 port 8443 restart always ; node-b redis-cache container 121 port 6379 restart always ; node-c envoy-gateway container 77 port 8080 restart onfailure ; node-d grafana-agent container 204 port 3000 restart onfailure",
		"Inventory: each host has its own container, port and restart policy. node-a runs nginx-proxy on 8443, node-b runs redis-cache on 6379, node-c runs envoy-gateway on 8080, node-d runs grafana-agent on 3000.",
		["204", "121"],
		"only mapping the hosts",
	),
	pressure(
		6,
		"Are the node names stable?",
		"nvcc list --nodes | wc -l",
		"316",
		"The nodes and containers are the same as before: node-a, node-b, node-c, node-d.",
		["316"],
		`${S}-cv-06`,
		"only checking the node names",
	),
	{
		chunkId: `${S}-ct-06`,
		class: "tool_output",
		role: "constraint",
		why: "the tool output states the nightly schedule, and the two rules the user stated have to survive as rules",
		probes: ["schedule.toml"],
		constraints: ["do not resize the nightly pool before Friday", "leave the audit store where it is"],
		transient: ["just confirming the schedule"],
		text: [
			"[0] [User @ 11:05]: Just confirming the schedule: do not resize the nightly pool before Friday, and leave the audit store where it is.",
			"[1] [Tool result for bash @ 11:06]: $ grep -n nightly schedule.toml",
			"[2] [Tool result for bash @ 11:07]: schedule.toml:7: nightly = 02:30",
			"[3] [Assistant @ 11:08]: Nightly runs at 02:30. I am not resizing the pool before Friday and not moving the audit store.",
		].join("\n"),
	},
	{
		chunkId: `${S}-nw-07`,
		class: "nothing_work",
		why: "a log skim with no decision and no fact worth keeping: the counts are the chatter, and banking anything from here is the failure the abstention control scores",
		transient: ["just skim this log", "nothing here needs changing"],
		text: [
			"[0] [User @ 11:20]: Let me just skim this log for a minute.",
			"[1] [Tool result for bash @ 11:21]: $ tail -n 20 run.log",
			"[2] [Tool result for bash @ 11:22]: 3 warn, 11 info, no errors",
			"[3] [Assistant @ 11:23]: Nothing here needs changing.",
		].join("\n"),
	},
	{
		chunkId: `${S}-nw-08`,
		class: "nothing_work",
		why: "a directory listing of scratch files, which states nothing durable about the work",
		transient: ["what is in the notes directory", "nothing to keep"],
		text: [
			"[0] [User @ 11:35]: I only wanted to see what is in the notes directory.",
			"[1] [Tool result for bash @ 11:36]: $ ls notes",
			"[2] [Tool result for bash @ 11:37]: scratch.md, old-plan.md",
			"[3] [Assistant @ 11:38]: Just scratch files, nothing to keep.",
		].join("\n"),
	},
];

// ── The promises this corpus makes, checked here so a wrong corpus cannot be written. ─────────────
// `tools/restraint-corpus-check.ts` re-measures all of this from the shipped code afterwards; the
// checks here exist so an edit to the chunks above fails at generation rather than at scoring.
const failures = [];
const allValues = chunks.flatMap((c) => c.probes ?? []);
for (const value of allValues) {
	const holders = chunks.filter((c) => carries(value, c.text));
	if (holders.length !== 1) failures.push(`${value}: ${holders.length} carrier chunks, exactly 1 is the point`);
	if (!valueTokens(value).has(value))
		failures.push(`${value}: not a specific token, so the value test cannot see it being dropped`);
}
for (const p of chunks.filter((c) => c.role === "pressure")) {
	const target = chunks.find((c) => c.chunkId === p.mergesInto);
	if (!target) {
		failures.push(`${p.chunkId}: names no carrier chunk`);
		continue;
	}
	const verdict = sameSubject({ task: "", statement: p.text }, { task: target.chunkId, statement: target.text });
	if (!verdict.ok)
		failures.push(
			`${p.chunkId}: the shipped subject guard would refuse this merge (${verdict.shared}/${verdict.targetSize} shared), so there is no merge to price`,
		);
	for (const value of target.probes ?? [])
		if (carries(value, p.text)) failures.push(`${p.chunkId}: restates ${value} from ${target.chunkId}, so the merge would not drop it`);
}
if (failures.length) {
	console.error(`corpus 5 refuses to be written:\n${failures.map((f) => `  ${f}`).join("\n")}`);
	process.exit(1);
}

const gate = {
	attribution_pair: 0,
	empty_chunk: 0,
	nothing_work: chunks.filter((c) => c.class === "nothing_work").length,
	tool_output: chunks.filter((c) => c.class === "tool_output").length,
	constraint_chunk: chunks.filter((c) => c.constraints).length,
	sole_carrier_value: allValues.length,
	merge_pressure_pair: chunks.filter((c) => c.role === "pressure").length,
	session_span: 1,
};

const corpus = {
	note:
		"TODO 8.9: a corpus where every declared value has exactly one carrier chunk. Each `pressure` chunk re-says its carrier's" +
		" subject in wording the shipped `sameSubject` accepts and restates none of the carrier's values, so a merge the guard" +
		" approves destroys the only copy of that value and only `mergeValueGate` can stop it. `hy-5c0b0001` is an authored" +
		" session id, not an organic capture.",
	gate,
	chunks,
};

writeFileSync(new URL("./corpus-restraint5.json", import.meta.url), `${JSON.stringify(corpus, null, 1)}\n`);
console.log(
	`dev/corpus-restraint5.json: ${chunks.length} chunks, ${allValues.length} single-carrier values, ${gate.merge_pressure_pair} merge-pressure pairs`,
);
