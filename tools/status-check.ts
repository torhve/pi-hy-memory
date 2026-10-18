#!/usr/bin/env node
/**
 * Status bar check. Run: npx tsx tools/status-check.ts
 *
 * Renders the footer line in each state and asserts the shape, with the theme
 * stripped so the output is readable. The bars are the point: the window bar must
 * grow with pending tokens and turn warning/error as it approaches the threshold.
 */
import { createStatusBar } from "../src/status.js";

const written: (string | undefined)[] = [];
const ui = {
	setStatus: (_key: string, text: string | undefined) => written.push(text),
	theme: { fg: (_c: string, t: string) => t },
};

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};
const strip = (s: string | undefined) => (s ?? "").replace(/⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/g, "⠋");

const bar = createStatusBar("hy");
bar.attach(ui as never);

// idle, empty window
bar.snapshot({ pending: 0, budget: 15000, bank: 0, pool: 5000 });
check("idle bar", strip(bar.text()), "hy ▕░░░░░░░░▏ 0/15k  ▕░░░░░░░░▏ 0/5k");

// window growing
bar.snapshot({ pending: 6200, budget: 15000, bank: 1400, pool: 5000 });
check("growing window", strip(bar.text()), "hy ▕███░░░░░▏ 6.2k/15k  ▕██░░░░░░▏ 1.4k/5k");

// near the threshold: the bar must switch to the warning colour, which the plain
// theme cannot show, so assert on the fill instead.
bar.snapshot({ pending: 13000, budget: 15000, bank: 4800, pool: 5000 });
check("near threshold fill", strip(bar.text()).includes("▕███████░▏"), true);

// writing: spinner + stage
bar.stage("extract", "8 entries");
const extracting = strip(bar.text());
check("spinner and stage shown", [extracting.includes("⠋ extract"), extracting.includes("8 entries")], [true, true]);

// waiting on a busy peer
bar.stage("waiting", "busy 15s");
check("waiting shows bus", strip(bar.text()).includes("⠋ wait busy 15s"), true);

// finished: delta flash
bar.done(6, 2);
check("done flash", strip(bar.text()).includes("✓ +6 ~2"), true);

// failure
bar.failed("reconcile hy-x-001: HTTP 504");
check("failure shown", strip(bar.text()).includes("✗ reconcile hy-x-001: HTTP 504"), true);

// detach clears the footer entry
const before = written.length;
bar.detach();
check("detach clears", written.slice(before), [undefined]);
check("silent after detach", bar.text().length > 0, true); // render still works, nothing is written
const after = written.length;
bar.snapshot({ pending: 100, budget: 15000, bank: 10, pool: 5000 });
check("no writes while detached", written.length, after);

// a throwing ui must not propagate
const throwing = createStatusBar("hy2");
let threw = false;
try {
	throwing.attach({
		setStatus: () => {
			throw new Error("extension ctx is stale");
		},
		theme: { fg: (_c: string, t: string) => t },
	} as never);
	throwing.stage("extract");
	throwing.done(1, 0);
} catch {
	threw = true;
}
check("stale ctx never throws", threw, false);

console.log(failures === 0 ? "ok: status bar" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
