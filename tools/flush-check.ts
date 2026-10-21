#!/usr/bin/env node

/**
 * Flush check. Run: npx tsx tools/flush-check.ts
 *
 * Pins the two rules `hy_flush` exists to hold. The trigger today is a token
 * threshold, so a chunk boundary is wherever 6 000 estimated tokens landed; this
 * tool lets the session model choose the boundary where work settled. What makes
 * that dangerous is coverage: `coverageWindow` walks the ledger in insertion order
 * and the watermark is a single id, so a flush that skipped front entries writes an
 * advance the ledger can never honour — a hole no later write marks as covered.
 * Hence `to` names the end and the front of the window is always included.
 *
 * The second rule is the gate. A flush bypasses the threshold on purpose, so it must
 * still refuse on the states that make a write wrong or wasteful, and it must bound
 * the queue: a model that flushes after every edit pays ~25 s and 9 000 tokens a call.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type FlushInput, MAX_PENDING_FLUSH, shouldFlushWrite } from "../src/chain.js";
import {
	flushInstructions,
	flushQueuedText,
	flushRows,
	rangeEntries,
	renderUnwritten,
	unwrittenRange,
} from "../src/flush.js";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
	);
};

const message = (id: string, role: "user" | "assistant", text: string): SessionEntry =>
	({
		type: "message",
		id,
		message: { role, content: text },
	}) as unknown as SessionEntry;

const pending: SessionEntry[] = [
	message("u1", "user", "Ship the flush tool behind a setting."),
	{ type: "system", id: "s1" } as unknown as SessionEntry,
	message("a1", "assistant", "Ranges stay monotone, so only `to` is exposed."),
	message("u2", "user", "Queue the write, do not block the turn."),
];

// 1. Refs number renderable rows only, and map back to the entries.
const rows = flushRows(pending);
check(
	"rows skip what the writer never sees",
	rows.map((r) => r.ref),
	[0, 1, 2],
);
check(
	"refs map back to entry positions",
	rows.map((r) => r.entryIndex),
	[0, 2, 3],
);
check(
	"every ref has a preview",
	rows.every((r) => r.preview.length > 0),
	true,
);

// 2. Coverage cannot skip: any `to` starts at the front of the window.
check("to=1 starts at the front", unwrittenRange(rows, 1), { start: 0, end: 1 });
check("to=0 is a real range, not empty", unwrittenRange(rows, 0), { start: 0, end: 0 });
check("to past the end is clamped, not rejected", unwrittenRange(rows, 99), {
	start: 0,
	end: 2,
	clampedTo: 99,
});
check("a missing to is the listing, not a write", unwrittenRange(rows), {
	start: 0,
	end: -1,
	empty: "no-range",
});
check("a negative to writes nothing", unwrittenRange(rows, -3), { start: 0, end: -1, empty: "to-before-start" });
check("a non-finite to writes nothing", unwrittenRange(rows, Number.NaN), {
	start: 0,
	end: -1,
	empty: "no-range",
});
check("an empty window has no range at all", unwrittenRange([], 5), { start: 0, end: -1, empty: "no-entries" });

// 3. A range of refs selects the whole span of entries, gaps included.
check(
	"to=1 hands over the front span",
	rangeEntries(pending, rows, unwrittenRange(rows, 1)).map((e) => e.id),
	["u1", "s1", "a1"],
);
check("to=last reaches the newest entry", rangeEntries(pending, rows, unwrittenRange(rows, 2)).at(-1)?.id, "u2");
check("an empty range hands over nothing", rangeEntries(pending, rows, unwrittenRange(rows)), []);

// 4. The listing stays small and tells the model the call that works.
const listing = renderUnwritten(rows, 2);
check(
	"listing caps at the limit",
	listing.split("\n").filter((line) => line.startsWith("[")),
	[
		"[0] user: Ship the flush tool behind a setting.",
		"[1] assistant: Ranges stay monotone, so only `to` is exposed.",
	],
);
check("listing names what it hid", listing.includes("1 more, up to [2]."), true);
check("listing names the exact call", listing.includes(flushInstructions(rows)), true);
check("the instruction uses the highest valid ref", flushInstructions(rows).includes("to=2"), true);
check("listing one row is still a listing", renderUnwritten(rows.slice(0, 1), 0).startsWith("[0] user:"), true);
check(
	"listing states the size a write needs when the floor is set",
	renderUnwritten(rows, 24, 640, 2000).startsWith("~640 tokens unwritten; a write needs 2000."),
	true,
);
check("listing stays silent about the floor when it is not given", listing.startsWith("[0] user:"), true);
check(
	"nothing unwritten says so",
	renderUnwritten([], 24),
	"Nothing is unwritten: the writer has covered every entry in this session.",
);

// 5. The answer names the clamping the model did not ask for.
check(
	"queued answer reports the clamp",
	flushQueuedText({ start: 0, end: 2, clampedTo: 99 }, 4, 9000, "sess-9/chunk-000"),
	"queued: entries [0]–[2] (to=99 clamped to 2), 4 entries, ~9000 tokens, chunk sess-9/chunk-000. Facts land in the bank when the write finishes; use hy_recall to read them.",
);

// 6. The gate: no threshold, but every unsafe state still refuses.
const open: FlushInput = {
	sessionActive: true,
	inFlight: false,
	pendingExtract: false,
	primaryDown: false,
	coolingDown: false,
	entryCount: 4,
	pendingFlushes: 0,
	pendingTokens: 3000,
	minTokens: 2000,
};
check("a settled range is written", shouldFlushWrite(open), { flush: true, reason: "model asked" });
check("an empty range refuses", shouldFlushWrite({ ...open, entryCount: 0 }), {
	flush: false,
	reason: "nothing unwritten",
});
check("/hy off refuses", shouldFlushWrite({ ...open, sessionActive: false }), {
	flush: false,
	reason: "session off",
});
check("a write in flight refuses", shouldFlushWrite({ ...open, inFlight: true }), {
	flush: false,
	reason: "write in flight",
});
check("a pending extract refuses", shouldFlushWrite({ ...open, pendingExtract: true }), {
	flush: false,
	reason: "extract awaiting reconcile",
});
check("a held primary refuses", shouldFlushWrite({ ...open, primaryDown: true }), {
	flush: false,
	reason: "primary writer held",
});
check("a cooldown refuses", shouldFlushWrite({ ...open, coolingDown: true }), {
	flush: false,
	reason: "write cooling down",
});
check("the queue is bounded", shouldFlushWrite({ ...open, pendingFlushes: MAX_PENDING_FLUSH }), {
	flush: false,
	reason: "flush queue full",
});
check("one queued flush still accepts a second", shouldFlushWrite({ ...open, pendingFlushes: 1 }), {
	flush: true,
	reason: "model asked",
});
// The gate order matters: `nothing unwritten` is answered before a busy writer, so a
// model that flushes an already-written window gets a true reason, not "write in flight".
check("emptiness is answered before busyness", shouldFlushWrite({ ...open, entryCount: 0, inFlight: true }), {
	flush: false,
	reason: "nothing unwritten",
});
// The token floor is the measured fix for fragmentation: finer boundaries than the threshold did
// not raise quality, so a flush over a thin window is refused rather than paid for.
check("a window under the floor refuses", shouldFlushWrite({ ...open, pendingTokens: 1999 }), {
	flush: false,
	reason: "under flush token floor",
});
check("a window at the floor accepts", shouldFlushWrite({ ...open, pendingTokens: 2000 }), {
	flush: true,
	reason: "model asked",
});
check("a floor of 0 accepts any unwritten window", shouldFlushWrite({ ...open, pendingTokens: 1, minTokens: 0 }), {
	flush: true,
	reason: "model asked",
});
check("emptiness is answered before the floor", shouldFlushWrite({ ...open, entryCount: 0, pendingTokens: 10 }), {
	flush: false,
	reason: "nothing unwritten",
});

console.log(failures === 0 ? "ok: flush" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
