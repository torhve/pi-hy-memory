#!/usr/bin/env node
/**
 * Subject-overlap guard check. Run: npx tsx tools/subject-guard-check.ts
 *
 * Both UPDATE pairs reproduce a real failure shape (the first erased a
 * container inventory, the second was a legitimate refinement that must
 * survive). Infrastructure details are replaced with documentation ranges.
 */
import { sameSubject } from "../src/protocol.js";

const WRONG_TARGET = {
	draft: {
		task: "node-b offline and container 121 start failure",
		statement:
			"Node-b (192.0.2.13) was offline (no ARP, no SSH, 0 cluster votes, down since ~2026-10-16 23:33); container 121 (admin@192.0.2.98, 6GB GPU, 4 cores, 24GB RAM) first start failed due to missing /dev/nvidia-uvm at boot; user booted node-b and container 121 now running (status running, 25GB free on 71GB rootfs).",
	},
	target: {
		task: "LXC containers on nodes",
		statement:
			"LXC: node-a 113 games, 114 transcode, 115 streaming, 120 inference (8 cores, 24768 MB, /dev/nvidia0, nvidiactl, nvidia-uvm, nvidia-uvm-tools, dri/renderD128), 205 dns (192.0.2.53), 209 misc. node-b 121 build (4 cores, 24768 MB, nvidia0, nvidiactl, nvidia-uvm, nvidia-uvm-tools, nvidia-caps, dri/renderD128). VM: 100 postgresql, 101 debian, 102 mqtt, 103 mesh, 105 chat, 106 docker ui, 107 backup, 108 media player, 109 media.",
	},
};

const RIGHT_TARGET = {
	draft: {
		task: "Hy-Memory model and GGUF details",
		statement:
			"Hy-Memory-30B-A3B-Hybrid-Q4_K_M.gguf is 18.64 GB, located on the shared NFS export at /mnt/models/hymemory (mounted via 198.51.100.20:/export), to be copied to /ai/gguf on the build node's local disk; chat template hy-memory.chat_template.jinja (11258 bytes) copied to /ai/templates there.",
	},
	target: {
		task: "Hy-Memory GGUF file location and size",
		statement:
			"Hy-Memory-30B-A3B-Hybrid-Q4_K_M.gguf exists at /models/hymemory/ and /nvme/models/hymemory/ (18642665376 bytes, ~18.6 GB), also at /mnt/models/hymemory/. Chat template /ai/chat_templates/hy-memory.chat_template.jinja.",
	},
};

// A short fact refined into a slightly longer one: still the same subject.
const SHORT_FACT = {
	draft: { task: "tax rate", statement: "config tax_rate is 0.25 for the OSL warehouse." },
	target: { task: "tax rate", statement: "tax_rate 0.25." },
};

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const wrong = sameSubject(WRONG_TARGET.draft, WRONG_TARGET.target);
check("erasing update rejected", wrong.ok, false);
console.log(`     ${wrong.shared}/${wrong.targetSize} shared tokens`);

const right = sameSubject(RIGHT_TARGET.draft, RIGHT_TARGET.target);
check("legitimate refinement kept", right.ok, true);
console.log(`     ${right.shared}/${right.targetSize} shared tokens`);

const short = sameSubject(SHORT_FACT.draft, SHORT_FACT.target);
check("short fact refinement kept", short.ok, true);
console.log(`     ${short.shared}/${short.targetSize} shared tokens`);

console.log(failures === 0 ? "ok: subject guard" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
