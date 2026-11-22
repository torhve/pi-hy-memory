#!/usr/bin/env node
/**
 * Command docs check. Run: npx tsx tools/command-docs-check.ts
 *
 * The README is where a user learns what to type. The registration is what decides what works.
 * They drifted once: the README told the reader to run `/hy-memory hifi` while the command is
 * registered as `hy`, so the documented form never ran and nothing noticed.
 *
 * The names come from the live registration, never from the text of `src/index.ts`: the names
 * passed to `registerCommand` and `registerTool`, and the subcommands the command itself offers
 * through `getArgumentCompletions`. The README is then read in both directions — every name the
 * extension offers must be documented, and every `/command` the README shows must be offered.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

/** A backtick, spelled so the patterns below can name one inside a template literal. */
const BACKTICK = String.fromCharCode(96);

// A real extension instance, pointed at a throwaway state directory, so the registration runs the
// way it does in a session. Same shape as tools/session-off-check.ts.
const dir = mkdtempSync(join(tmpdir(), "hy-command-docs-"));
process.env.PI_HY_MEMORY_STATE = join(dir, "state");
process.env.PI_HY_MEMORY_CONFIG = join(dir, "config.json");
writeFileSync(process.env.PI_HY_MEMORY_CONFIG, JSON.stringify({ model: "test/writer", timeoutMs: 1000 }));

const { default: piHyMemory } = await import("../src/index.js");

type CommandDef = {
	description?: string;
	getArgumentCompletions?: (prefix: string) => { value: string }[] | null;
};

const commands = new Map<string, CommandDef>();
const tools: string[] = [];
piHyMemory({
	on: () => {},
	registerTool: (tool: { name: string }) => {
		tools.push(tool.name);
	},
	registerCommand: (name: string, def: CommandDef) => {
		commands.set(name, def);
	},
} as never);

const commandNames = [...commands.keys()];
const subcommands = commandNames.flatMap((name) =>
	(commands.get(name)?.getArgumentCompletions?.("") ?? []).map((item) => item.value),
);
console.log(`registered: commands ${JSON.stringify(commandNames)}, tools ${JSON.stringify(tools)}`);
console.log(`subcommands the command offers: ${JSON.stringify(subcommands)}`);

const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
const readmeLines = readme.split("\n");

// --- every name the extension offers is documented ------------------------------------------

for (const name of commandNames) {
	const shown = readmeLines.filter((line) =>
		new RegExp(`(^|[(${BACKTICK}\\s])/${name}(?![a-z0-9-])`).test(line),
	).length;
	check(`the command /${name} is documented`, shown > 0, true);
}

for (const tool of tools) {
	check(`the tool \`${tool}\` is documented`, readme.includes(`\`${tool}\``), true);
}

for (const sub of subcommands) {
	const shown = readmeLines.some((line) =>
		commandNames.some((name) => new RegExp(`/${name} ${sub}(?![a-z])`).test(line)),
	);
	check(`the subcommand "${sub}" is documented`, shown, true);
}

// --- every /command the README shows is offered ---------------------------------------------

/**
 * A command mention: a slash-word at a line start or after a space, backtick or bracket. The
 * model names in the config sample (`llama-swap/hy-memory-30b-a3b`) sit behind a package name and
 * are not mentions, so they are not collected.
 */
const mentions = [...readme.matchAll(/(^|[`(\s])\/(hy[a-z0-9-]*)(?:[ ]([a-z]+))?/gm)].map((m) => ({
	name: m[2] as string,
	sub: m[3],
	line: readme.slice(0, m.index).split("\n").length,
}));

check(
	"the README mentions no command that is not registered",
	mentions.filter((m) => !commandNames.includes(m.name)).map((m) => [`/${m.name}`, m.line]),
	[],
);
check(
	"and no subcommand that the command does not offer",
	mentions
		.filter((m) => m.sub && commandNames.includes(m.name) && !subcommands.includes(m.sub))
		.map((m) => [`/${m.name} ${m.sub}`, m.line]),
	[],
);

console.log(
	failures === 0
		? `\nall docs assertions pass over ${mentions.length} documented mentions`
		: `\n${failures} docs assertions failed`,
);
process.exit(failures === 0 ? 0 : 1);
