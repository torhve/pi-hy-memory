# pi-hy-memory

Design and proof of concept for a pi memory extension built around
**Hy-Memory-30B-A3B** as what it actually is — a memory-bank writer — rather than as an
agent with tools.

- [`DESIGN.md`](DESIGN.md) — the design, the measured evidence behind every choice, and
  what is carried over from
  [`pi-observational-memory`](https://github.com/elpapi42/pi-observational-memory) V3.
- [`RESULTS.md`](RESULTS.md) — the PoC run against four real captured observer chunks.

## Install

```bash
pi install ./pi-hy-memory                       # a local checkout
pi install npm:pi-hy-memory                     # once published
pi install git:github.com/<you>/pi-hy-memory    # straight from a repository
```

The extension reads `~/.pi/agent/pi-hy-memory.json` and writes per-session state to
`~/.pi/agent/pi-hy-memory/state/` — override with `PI_HY_MEMORY_CONFIG` and
`PI_HY_MEMORY_STATE`, which is how the harness in `dev/` keeps a test run from touching a
live session. `/reload` applies config and code changes to a session that is already open.

**Writer model.** It is not the session model, and it is not an endpoint: it is any model
already in your pi model list, named as `provider/modelId` (a bare `modelId` also works when
unambiguous). Provider registration, base URL and credentials stay pi's business — including
providers that populate their model list dynamically at startup.

```json
{ "model": "llama-swap/hy-memory-30b-a3b" }
```

If that model is missing, the write fails with `writer model "…" is not in pi's model list`
and lists the closest matches, so a typo is visible without digging through a log.

A provider that discovers its models over the network registers them during its own startup,
so its list is empty until its server answers. A write in that window fails with the same
message; the watermark does not advance, so the next write retries and succeeds once the
provider is up.

**The watermark survives a rewind.** pi can move the leaf — a rewind, a resumed checkpoint, or
a compaction that re-parents the branch — which leaves the write watermark as an id that is no
longer on the current chain. Falling back to the start of the session then made the whole
history "pending": measured once at **431 329 tokens across 3 617 entries**, re-extracting
facts the bank already held, which is what a burst of writes from an idle-looking session was.
Coverage is monotone in the branch, so the window now starts after the **furthest** position
any ledger record still reaches — which also repairs a watermark that drifted backwards after
such a rewind. If no record lands in the branch, the newest writer record is used, then the
last compaction, and the reset is audited as `coverage_drift`.

Failures are classified, because only some of them say anything about chunk size. A timeout,
a 413 or a context-length rejection halves the next chunk; unparseable output does too. A
transport error, a 5xx, a 429 or an auth failure resets that shrink instead of applying it —
the failover path already handles those, and a smaller chunk would not have helped.

Each failure also starts a cooldown: `writeCooldownS` (30 s), doubling while it keeps failing
and capped at 10 minutes, cleared by any success. Without it, a writer that is down costs one
attempt per turn — measured at **508 attempts in 37 minutes** during a 502 storm — because
nothing backs off between turns. The audit records `write_cooldown { waitS }` and one
`write_deferred` per episode rather than a line per skipped turn.

## Configuration

`~/.pi/agent/pi-hy-memory.json` (all keys optional; defaults in `src/index.ts`):

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | turn the extension off without unloading it |
| `dryRun` | `false` | run the pipeline, append nothing to the session |
| `observeAfterTokens` | `6000` | pending window that triggers a write, measured on the full entries at chars/4 rather than on the clipped text a chunk would carry. Measured on *stored* text: pi stubs old tool output before sending, so a whole-branch figure runs ~2x pi's count while fresh pending text does not (the *first* footer bar) |
| `maxChunkTokens` | `6000` | chunk budget per write. Estimated at chars/4, and code-heavy chunks tokenise at ~1.4–1.5× that, so 6 000 is ~9 000 real prompt tokens. Was 24 000: one wide window found 41 facts over three captures, five ~4 500-token windows found 120 for +5 % input tokens and half the wall time (see "Chunk size") |
| `maxEntryChars` | `3000` | per-entry truncation inside a chunk, so one huge tool output cannot consume the whole budget |
| `bankMaxTokens` | `60000` | ceiling on the *active* bank — the store, not the summary (the *second* footer bar). Reaching it evicts the newest-first tail; most sessions end far below it (the longest measured session had 408 facts / 29 357 tokens). `poolMaxTokens` from older configs is this key |
| `summaryMaxTokens` | `8000` | what a compaction summary renders, selected out of the bank (see DESIGN.md § "The bank is a store; the summary is a selection"). ~72 tokens per fact, and the rendered summary is ~1.2× this |
| `foundationAfterChunks` | `8` | a fact this many chunks old and never superseded counts as a *foundation* for the summary selection |
| `summaryConstraintShare` | `0.1` | share of the summary budget reserved for facts whose evidence was a user turn |
| `summaryFoundationShare` | `0.35` | share reserved for old, never-superseded facts |
| `keepRecentTokens` | `6000` | raw entries kept verbatim by a compaction. The cut is clamped back to the write watermark so nothing unread is dropped, but only by up to `maxChunkTokens`; past that the compaction is handed back to pi (see "Compaction: who decides when") |
| `candidateLimit` | `24` | bank entries shown to the reconcile call, and the per-draft retrieval depth. Was 12: measured on the extended corpus, 12 starved 2.2 % of drafts once the bank passed ~110 entries; 24 starves none for +24 % reconcile input tokens |
| `candidateRenderMode` | `perDraft` | how the `candidateLimit` window is chosen: `perDraft` guarantees every draft its own best bank match before the cap fills; `union` shows the score-sorted union (legacy) |
| `hifiCompaction` | `false` | ask the **session model** (never the writer) to write the compaction checkpoint — Goal / Constraints / Progress / Decisions / Next steps / Critical context — from the bank delta plus the kept tail. A truncated, section-less, or id-less answer is rejected and the render is used instead. Off by default: the render is free and cannot fail |
| `hifiMaxTokens` | `4000` | output cap for the checkpoint. Reasoning shares this cap with the answer: a 64-fact delta wrote 1 470–1 508 tokens of checkpoint and was still cut off at 2 000 |
| `hifiThinkingLevel` | `off` | `"off"` asks the model not to think for the checkpoint, `"inherit"` uses the session's level. Off by default because a model that thinks at a checkpoint can spend the whole output budget without answering |
| `hifiTailTokens` | `6000` | how much of the kept tail the checkpoint call may read as context |
| `hifiDeltaTokens` | `6000` | how many tokens of facts it may read. Facts sent = newer than the last checkpoint, or user-stated, or dropped by the last checkpoint |
| `hifiRetryLimit` | `3` | how many boundaries a fact the checkpoint dropped is offered again. Bounded because the re-offer is the expensive part: measured on a 408-fact bank, a boundary covering two chunks spent 4 206 of its 6 000 delta tokens on facts already offered and already not cited. After that the fact is in the bank and recallable |
| `hifiTimeoutMs` | `120000` | wall-clock cap for the checkpoint call; a timeout falls back to the render |
| `model` | `hy-memory-30b-a3b` | writer model from **your pi model list**: `provider/modelId`, or a bare id |
| `maxTokens` | `8000` | output cap per call |
| `timeoutMs` | `480000` | total wall-clock cap per call; raise it for a CPU-offloaded writer |
| `chatTemplateKwargs` | `false` | llama.cpp only: e.g. `{reasoning_effort:no_think}`. Omitted by default because other providers reject unknown fields |
| `extraBody` | `{}` | extra request fields, merged last (`samplingParams` in pi-ai terms) |
| `fallback` | `false` | `{model, maxTokens?, timeoutMs?}` — a second model id, used when the primary is unavailable |
| `fallbackCooldownS` | `300` | stay on the fallback this long after a failover (cleared only by a **primary** answer) |
| `writeCooldownS` | `30` | wait before writing again after a failed attempt, doubling while it keeps failing (capped at 10 min); `0` disables. A dead endpoint otherwise costs one request per turn |
| `busyRetries` / `busyBackoffMs` | `3` / `4000` | 429 handling: llama-swap rejects a concurrent request to a single-slot model *instantly* instead of queueing. Waits double, capped at 60 s each and at a quarter of `timeoutMs` in total; after that the fallback is used instead of sleeping through the write |
| `pruneAfterDays` | `30` | delete per-session state older than this; `0` disables. The 10 newest sessions and the running one are always kept |
| `waitForWriteOnSettle` | `true` | block the end of a turn on an in-flight write. A write that completes with the window still over the trigger is followed by another, at most twice per turn and only while the writer is healthy |
| `shutdownWaitMs` | `5000` | cap on how long `session_shutdown` waits for a write |
| `statusBar` | `true` | footer bar: window fill, bank fill, spinner, `✓ +N ~M` |

## Commands

```
/hy           status: session switch, bank size, cost so far
/hy summary   the facts a compaction would render, as the model would read them
/hy off       stop memory work for this session (remembered across reloads)
/hy on        resume; the window accumulated while off is not remembered
```

`/hy off` exists because not every session earns its keep. A session that ends before the
next compaction never uses the facts its writes paid for, and two model calls per chunk is
real money on a short-lived session.

While a session is off:

- **writes stop.** The trigger returns before measuring, so nothing is spent. A write that
  was already running is not aborted — it has been paid for — but no follow-up is chained.
- **compaction still uses the bank**, when one exists. That summary is a string build with no
  model call, so dropping it would make an off session strictly worse. With no bank (off from
  the first turn) the hook returns nothing and pi summarises with its own model.
- **`hy_recall` keeps working** on what the bank already holds. Nothing is deleted.
- **the footer says `hy off`** and drops the pending bar: nothing will drain it, and a bar
  pinned at 100 % reads as a stall rather than a choice.

The switch is per session and durable (`state/sessions/<sessionId>.off`), so a reload or a
session resumed tomorrow stays off, and `session_start` says so once instead of silently
writing again. `/hy on` **discards** the window that accumulated while off — it moves the
watermark to the newest entry and records a `hy.gap` with `reason: "disabled"` — because
otherwise a session that was off for hours pays for the whole backlog in a burst of writes on
re-enable. The config's `enabled: false` is the global kill switch and wins over `/hy on`;
the command says so rather than pretending.

## Compaction: who decides when

**pi decides.** The extension never triggers a compaction — it only supplies the summary
through `session_before_compact` (`renderMemory(bank, summaryMaxTokens)`), sets
`firstKeptEntryId` itself (so this extension's `keepRecentTokens` wins over pi's
`compaction.keepRecentTokens`), and logs the event. If the bank is empty it returns
nothing and pi summarises with its own model.

That cut is pi's, with one adjustment: it is clamped back to the write watermark so
entries the writer has not read yet are not dropped from the branch. The clamp is
bounded by `maxChunkTokens` — one chunk's worth of backlog is worth holding, more is not.

Past that bound the extension **hands the compaction back to pi** (`return undefined`):
pi's own summariser compresses the unread entries into prose, which is what would happen
without this extension, instead of the entries disappearing from the live context unread.
The audit line is `compact_deferred { entries, tokens }`. This is the case a writer outage
creates — measured on 2026-10-19, a 36-minute 502 storm left 477 unread entries and the
older behaviour dropped 53 459 tokens of history that no chunk had ever read. The
extension renders a summary for free; when it cannot do that faithfully, paying pi's model
call is the cheaper mistake.

pi's trigger is `contextTokens > contextWindow − compaction.reserveTokens`, default
`reserveTokens: 16384`, plus a manual `/compact` and one compact-and-retry on overflow.
Tune it in `~/.pi/agent/settings.json`:

```json
"compaction": {
  "enabled": true,
  "reserveTokens": 16384,
  "keepRecentTokens": 20000,
  "modelOverrides": {
    "provider/model-262k": { "reserveTokens": 78643 },
    "provider/model-1m":   { "reserveTokens": 629146 }
  }
}
```

A ratio `r` of the window is just `reserveTokens = (1 − r) × window` — so
`modelOverrides` already gives you per-model ratio thresholds, and the ratio is
recomputed correctly if the model's declared window differs from what you assumed. This
is why the extension has no `compactAfterRatio` knob of its own: it would be a second
source of truth for a decision pi already owns, and a disagreement between the two
means either a double compaction or a summary rendered for the wrong boundary.

The incumbents do own the decision, with three different schemes (DESIGN.md §
"Compaction threshold — what the incumbents do"):

| window | pi (`w − 16384`) | pi-observational-memory calibrated (`compactAfterTokens`, 81 000 default) | pi-observational-memory `ratio` mode, 0.68 | pi-blackhole preset curve |
|---|---|---|---|---|
| 40 960 | 24 576 | 81 000 *(can never fire)* | 27 852 | 36 522 (0.892) |
| 168 000 | 151 616 | 81 000 | 114 240 | 129 666 (0.772) |
| 262 144 | 245 760 | 81 000 | 178 257 | 183 500 (0.700) |
| 1 048 576 | 1 032 192 | 81 000 | 713 031 | 419 430 (0.400) |

81 000 is that extension's packaged default, not a tuned local value: `"calibrated"` is the
default mode, so a flat cap is what you get until you switch to `"ratio"`.

### What the summary contains

The bank is a store; the summary is a **selection** over it, capped at `summaryMaxTokens`
plus the real `[id] (task) ` prefixes (`summaryBudget`). Three slices are filled, newest
first inside each, never duplicated:

| slice | what | share |
|---|---|---|
| constraints | facts whose evidence was a user turn | `summaryConstraintShare` (0.1) |
| foundations | facts older than `foundationAfterChunks` and never superseded | `summaryFoundationShare` (0.35) |
| current state | everything else | the rest |

Unused share spills forward, so a session with no user-stated facts still fills the summary.
Lines are printed under `## Current state` (younger than `foundationAfterChunks`) and then
`## Earlier`, chronological inside each, so live state comes before history; the omission tail
says how many were hidden (each is reachable with `hy_recall <id>`). A compaction also appends
the `<read-files>` / `<modified-files>` block, derived from `read` / `write` / `edit` tool calls
rather than from a model — the same lists pi's own summary carries.

Why not recency alone: measured on the longest production session (32 chunks, 408 facts,
29 357 tokens of bank), a newest-first 6 000-token summary kept 84 facts and the oldest was
**7 chunks** old. The same budget with the slices above keeps 122 facts reaching **20
chunks** back. Why not let the writer rank them: it answered `1.0` for 965 of 996 facts
(965/996) and labelled 60 of 65 drafts `detail` on a `stability` field, so both judgements were
removed (see DESIGN.md § *Ranking*). Selection is pinned by `tools/render-check.ts`.

Our summary is bounded by the bank, not by history, so we do not inherit the "summarising
1 M tokens is expensive and lossy" problem that motivates pi-blackhole's shrinking curve. On
a very large window, compacting *late* is cheaper for us, which is what pi's default already
does.

### `summaryMaxTokens` is window-relative

The summary cap is only meaningful next to the session model's window:

| session window | 8 000-token summary is | comfortable range |
|---|---|---|
| 40 960 | 20 % — too big | 3 000–4 000 |
| 168 000 | 4.8 % — about right | 8 000–12 000 |
| 262 144 | 3 % | 12 000–16 000 |
| 1 048 576 | 0.8 % | 20 000–30 000 |

The cap is per session, not per model, so a config used across models should be sized
for the *smallest* window you actually run, or split per project.
### Optional: the model-written checkpoint

`hifiCompaction` replaces the rendered fact list with a checkpoint written by the **session
model** — the same sections pi's own compaction produces (Goal, Constraints & preferences,
Progress, Key decisions, Next steps, Critical context), but built from the bank delta plus the
kept tail rather than from the whole transcript:

```json
{ "hifiCompaction": true, "hifiMaxTokens": 4000, "hifiTailTokens": 6000 }
```

or `/hy-memory hifi` to try it in the current session.

It is opt-in because it puts a model call at the slowest moment in a session. It is *not*
slower than vanilla pi, which makes exactly such a call — it is slower than the render, which
costs nothing and cannot fail.

**A local reasoning model has to be told to stop thinking.** Measured on a quantised Qwen
build over a 5 895-entry session: inheriting the session's thinking level returned 2 000 output
tokens, one `thinking` block and no answer — three times, and again when the cap was raised to
6 000. Reasoning and the answer share a single output budget, and pi only sends a reasoning
field when the model entry says how *that server* switches reasoning off. So:

- `hifiThinkingLevel` defaults to `off`: the checkpoint asks for no reasoning even when the
  session is thinking deeply.
- the model entry still has to name the switch. `compat.thinkingFormat: "qwen-chat-template"`
  sends `chat_template_kwargs.enable_thinking: false` and worked — 6/6 sections, 38 of 64 ids
  cited, no invented ids. `thinkingLevelMap: { "off": "none" }` sends `reasoning_effort: "none"`
  and also worked (5/6 sections, 34/64). A top-level `enable_thinking: false`
  (`compat.thinkingFormat: "qwen"`) was ignored by that server.
- `hifiMaxTokens` is 4 000 because 2 000 truncated a good checkpoint at 1 508 tokens.

What it guarantees:

- **It never replaces the render with something worse.** A truncated answer, a provider error, a
  missing section, or an answer that cites no fact id is rejected and the rendered bank is
  persisted instead. The audit says which happened (`hifi_ok`, `hifi_rejected`, `hifi_failed`)
  and every `compact` record carries `summaryKind: "hifi" | "render"`.
- **Facts are not lost by being forgotten.** A fact is re-offered at the next boundary if it is
  new, if the user stated it, or if the previous checkpoint dropped it.
- **The writer model is never used.** The checkpoint is written by the executor's model; the
  writer is not allowed to grade its own output.
`dev/hifi-probe.ts` runs one real checkpoint from a real session file and reports request size,
wall time, ids kept and whether the answer would have been accepted:

```bash
npx tsx dev/hifi-probe.ts --session ~/.pi/agent/sessions/<project>/<file>.jsonl \
  --model <provider>/<id> --reasoning off --thinking-format qwen-chat-template --max-tokens 4000
```
## Footer

```
hy ▕███░░░░░▏ 6.2k/15k   ▕██░░░░░░▏ 1.4k/5k   ⠼ extract 8 entries
```

First bar is the window that triggers the next write, second is the bank against
`bankMaxTokens` (the store ceiling, not the summary). While a write runs the braille spinner names the stage — `extract`,
`reconcile`, or `wait busy 15s` when backing off a 429 — and a finished write flashes
`✓ +6 ~2` for five seconds. `✗ <reason>` replaces it on failure, and `hy off` replaces the
whole first bar when the session switch is off. Derived from
pi-blackhole's footer ([k0valik/pi-blackhole](https://github.com/k0valik/pi-blackhole)), adapted to the budgets this extension actually maintains.

## Checks

```bash
npm test          # for t in tools/*check.ts; do npx tsx "$t"; done
```

Every file pins a defect that was observed in a live session, or a contract that is easy
to break silently:

| check | pins |
|---|---|
| `endpoint-check` | model resolution from pi's list (slashes in ids, late registration), the request we hand to `registry.complete()`, and the fact that a provider failure *resolves* with `stopReason: "error"` |
| `fallback-check` | which failures move to the second model (429 retried first, 5xx/abort move, 400 does not) and `preferFallback` |
| `chain-check` | a completed write chains another only on a healthy writer and after a successful attempt, with no persisted extract, and never past `MAX_CHAIN` |
| `session-off-check` | `/hy off` stops the trigger, survives a reload, is announced on resume, and `/hy on` drops the off window as a `hy.gap` |
| `lost-cursor-check` | a rewound branch resumes from the furthest coverage the ledger still reaches, not from index 0 |
| `failure-class-check` | chunk/output failures shrink the next chunk; transport, 5xx, 429 and auth do not — and the failure cooldown doubles to a cap |
| `failover-state-check` | the cooldown is cleared only by a **primary** answer |
| `write-resume-check` | coverage contiguity, and not re-extracting after a failed reconcile |
| `compaction-window-check` | compaction holds uncovered entries while that is affordable, accepts pi's cut when it is not, and sizes entries by their real text |
| `compaction-hook-check` | the hook uses pi's `firstKeptEntryId` and real `tokensBefore`, and a `hy.gap` record reaches the mirrored ledger when the clamp gives way |
| `ops-guard-check`, `subject-guard-check` | wrong-target and wrong-subject UPDATEs |
| `redact-check` | credential redaction without damaging identifiers |
| `json-repair-check` | the two measured malformations (illegal escape, stray quote after a number) parse, content survives, valid output is untouched, and an unparseable reply is re-asked exactly once |
| `budget-check`, `reload-budget-check` | pool eviction order, reload semantics, summary budget |
| `render-check` | compaction summary budget, omission reporting, and newest-first admission |
| `prune-check` | retention deletes old sessions and nothing else |
| `config-docs-check` | every setting in the code is in the table above, with the same default |
| `status-check` | footer rendering, including a stale context |

## Run the proof of concept

```bash
POC_ORIGIN=http://127.0.0.1:9090 POC_MODEL=hy-memory-30b-a3b \
  npx tsx dev/poc.ts          # replay captured observer payloads through the write path
npx tsx dev/export-judge.ts   # emit one result file per chunk for an external judge
```

`dev/poc.ts` reads payload captures from `$CAPTURE_DIR` (default `./captures`) and writes
to `out/`; `dev/export-judge.ts` writes `out/judge/`. Both need a capture set, so they are
development tools rather than part of the extension. The A/B harness that produced
`RESULTS.md` lives in `dev/` and expects its own judge directory (`$JUDGE_DIR`); neither
is required to use the extension.

## Layout

| file | role |
|---|---|
| `src/types.ts` | bank entry, ledger record, draft, op |
| `src/chunks.ts` | chunk ids (monotonic, derived entry ids) |
| `src/serialize.ts` | pi entry text → chunk with positional `[n]` refs; internal ids hidden |
| `src/prompts.ts` | extract prompt (fixed) + reconcile prompt (size-aware) |
| `src/protocol.ts` | JSON parse, validation, sanitizing, bank/draft rendering |
| `src/bank.ts` | ledger fold, candidate retrieval, op application, budget |
| `src/pipeline.ts` | the two calls and everything deterministic around them |
| `src/render.ts` | model-free compaction summary + omission notice |
| `src/status.ts` | footer bar: window fill, bank fill, spinner, flash |
| `src/failover.ts` | when the primary is considered down, and when it is trusted again |
| `src/state.ts` | retention for per-session state |
| `dev/poc.ts` | replay harness over captured chunks (needs `POC_ORIGIN`) |
| `dev/export-judge.ts` | bank → judge result files |
| `dev/raw-writer.ts` | the only HTTP client, for the shell harnesses above |
