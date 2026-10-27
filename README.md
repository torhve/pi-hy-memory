# pi-hy-memory

Design and proof of concept for a pi memory extension built around
**Hy-Memory-30B-A3B** as what it actually is — a memory-bank writer — rather than as an
agent with tools.

- [`DESIGN.md`](DESIGN.md) — the design, the measured evidence behind every choice, and
  what is carried over from
  [`pi-observational-memory`](https://github.com/elpapi42/pi-observational-memory) V3.
- [`RESULTS.md`](RESULTS.md) — the PoC run against four real captured observer chunks.
- [`DESIGN_HYVCC.md`](DESIGN_HYVCC.md) — an *unbuilt* proposal: what hy would gain by
  carrying a deterministic transcript layer and a raw-session recall alongside the bank, what
  it would cost, and the five measurements that decide it.

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

`~/.pi/agent/pi-hy-memory.json` (all keys optional; defaults in `src/config.ts`):

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | turn the extension off without unloading it |
| `dryRun` | `false` | run the pipeline, append nothing to the session |
| `observeAfterTokens` | `6000` | pending window that triggers a write, measured on the full entries at chars/4 rather than on the clipped text a chunk would carry. Measured on *stored* text: pi stubs old tool output before sending, so a whole-branch figure runs ~2x pi's count while fresh pending text does not (the *first* footer bar) |
| `maxChunkTokens` | `6000` | chunk budget per write. Estimated at chars/4, and code-heavy chunks tokenise at ~1.4–1.5× that, so 6 000 is ~9 000 real prompt tokens. Was 24 000: one wide window found 41 facts over three captures, five ~4 500-token windows found 120 for +5 % input tokens and half the wall time (see "Chunk size") |
| `maxEntryChars` | `3000` | per-entry truncation inside a chunk, so one huge tool output cannot consume the whole budget |
| `bankMaxTokens` | `60000` | ceiling on the *active* bank — the store, not the summary (the *second* footer bar). Reaching it retires facts by recency and writes an `hy.evict` record naming every id it took; a retired fact stays in `hy_recall`'s query results, marked with what dropped it, and a reload re-applies the same rule. Most sessions end far below it; the longest measured session (159 writes, read from a frozen snapshot) reached it and retired 631 facts, leaving 820 current. `poolMaxTokens` from older configs is this key |
| `summaryMaxTokens` | `8000` | what a compaction summary renders, selected out of the bank (see DESIGN.md § "The bank is a store; the summary is a selection"). ~72 tokens per fact, and the rendered summary is ~1.2× this |
| `foundationAfterChunks` | `8` | a fact this many chunks old and never superseded counts as a *foundation* for the summary selection |
| `summaryConstraintShare` | `0.1` | share of the summary budget reserved for facts whose evidence was a user turn |
| `summaryFoundationShare` | `0.35` | share reserved for old, never-superseded facts |
| `keepRecentTokens` | `6000` | raw entries kept verbatim by a compaction. The cut is clamped back to the write watermark so nothing unread is dropped, but only by up to `maxChunkTokens`; past that a manual or threshold compaction first waits for the write in flight, up to `compactWaitMs`, and is then handed back to pi, and an overflow cut is taken anyway with the unread range digested into the summary (see "Compaction: who decides when") |
| `overflowDigestTokens` | `1500` | share of the window an overflow digest may take. When the kept tail has to be cut to fit the model's context window, the entries the writer never read are folded into the summary as a bounded digest rather than vanishing; the cut is also recorded as a gap in the ledger. `0` cuts without a digest |
| `candidateLimit` | `24` | bank entries shown to the reconcile call, and the per-draft retrieval depth. Was 12: measured on the extended corpus, 12 starved 2.2 % of drafts once the bank passed ~110 entries; 24 starves none for +24 % reconcile input tokens |
| `candidateRenderMode` | `perDraft` | how the `candidateLimit` window is chosen: `perDraft` guarantees every draft its own best bank match before the cap fills; `union` shows the score-sorted union (legacy) |
| `mergeValueGate` | `false` | refuse an UPDATE whose draft drops a value its target carries — a number, a flag, a dotted file name, a path, an underscored identifier — even when the subject guard calls the two one subject, and record it as an ADD instead. The value test is `src/values.ts`; re-folding 10 recorded runs under it loses no corpus-declared value at a merge, against 9 lost as shipped, at +7 % bank tokens and +7 values held by two facts. Two live arms ran: corpus 4 never triggered it, and corpus 3 refused 2 of 9 merges (+2 facts, +4 % tokens) and caught a wrong-subject merge the subject guard passes, with no value outcome changed because that corpus banks every declared value twice. Off until a corpus where each value has one carrier prices it (TODO 8.9) |
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
| `chatTemplateKwargs` | `false` | llama.cpp only: e.g. `{reasoning_effort:none}`. The accepted values are `none`, `low`, `medium`, `high` — llama.cpp ignores a value it does not recognise, the Strata engine answers **400** for one. Omitted by default because other providers reject unknown fields |
| `extraBody` | `{}` | extra request fields, merged last (`samplingParams` in pi-ai terms) |
| `fallback` | `false` | `{model, maxTokens?, timeoutMs?}` — a second model id, used when the primary is unavailable |
| `fallbackCooldownS` | `300` | stay on the fallback this long after a failover (cleared only by a **primary** answer) |
| `writeCooldownS` | `30` | wait before writing again after a failed attempt, doubling while it keeps failing (capped at 10 min); `0` disables. A dead endpoint otherwise costs one request per turn |
| `idleDrainAfterMs` | `180000` | drain a session that is doing nothing: after this much quiet, one write starts if the unread window is at least **4×** `observeAfterTokens`. A write is otherwise only ever started by `turn_end`, so a session left open never pays down its backlog. `0` disables it. A writer that has failed is probed, not vetoed: at most 3 attempts spaced by `writeCooldownS`, then it waits for a turn |
| `flushTool` | `false` | opt in to let the session model name the range the writer reads: `hy_flush` with no arguments lists the unwritten entries, `hy_flush({to})` queues a write up to that ref. The front of the window is always included — coverage is monotone, so a skipped front would be a hole the ledger can never mark. Refuses on `/hy off`, a write in flight, a pending extract, a held primary, an active cooldown, and a queue of 2. Off costs no prompt tokens |
| `flushListEntries` | `24` | how many unwritten entries that listing shows before summarising the rest; previews are 120 characters, never re-serialized into the writer's prompt |
| `flushMinTokens` | `2000` | refuse a model-initiated write whose named range carries less than this much, and answer with the amount it would have carried. The floor is on the write, not the window: naming `to` a quarter of the way up a fat window is still a thin chunk. Cutting the same content into finer pieces than the threshold wrote 53 % more facts at flat specificity and a lower durable share, so a thin flush is refused rather than paid for. 2000 is tuned against that arm (about a third of `maxChunkTokens`), not derived; `0` accepts any flush |
| `busyRetries` / `busyBackoffMs` | `3` / `4000` | 429 handling: llama-swap rejects a concurrent request to a single-slot model *instantly* instead of queueing. Waits double, capped at 60 s each and at a quarter of `timeoutMs` in total; after that the fallback is used instead of sleeping through the write |
| `pruneAfterDays` | `30` | delete per-session state older than this; `0` disables. The 10 newest sessions and the running one are always kept |
| `waitForWriteOnSettle` | `true` | block the end of a turn on an in-flight write. A write that completes with the window still over the trigger is followed by another, at most twice per turn and only while the writer is healthy |
| `waitForWriterBeforeCompact` | `true` | wait for a write that is already running before handing a compaction back to pi. pi checks compaction *before* `agent_before_settle`, so the backlog a cut would drop is very often a write started at `turn_end` that is seconds from landing. Stage-aware and ETA-gated, and never applied to overflow or to a writer that is failing or cooling down. `false` is the rollback: the wait and its notification go away and pi summarises as before |
| `compactWaitMs` | `60000` | ceiling on that wait, shared by the running write and its chained follow-ups — not per write, or a backlog could pin compaction. 60 000 covers the reconcile p75 (~55 s) and both deferrals in the live audit (2 s and 11 s left); it deliberately does not cover most extract-stage waits, where the ETA says do not bother |
| `shutdownWaitMs` | `5000` | cap on how long `session_shutdown` waits for a write |
| `statusBar` | `true` | footer bar: window fill, bank fill, spinner, `✓ +N ~M` |

## Commands

```
/hy           status: session switch, bank size, cost so far, how far behind the writer is
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

**`hy_flush` — the model can name the boundary.** Memory work normally starts on a turn once the
unread window passes `observeAfterTokens`, so a chunk ends wherever that estimate landed. With
`flushTool: true` the session model is also offered a `hy_flush` tool: a bare call lists the entries
the writer has not read (`[n] role: first 120 characters`), and `hy_flush({ to: n })` queues a write
over entries `[0]..[n]`. The front of the unwritten window is always included — coverage along a
branch is monotone, so a flush that skipped the front would leave entries no later write can mark as
covered — and a `to` past the last entry is clamped and reported. The write is queued, so the turn
keeps going: the facts land when it finishes and are readable with `hy_recall`. It refuses when the
session is off, a write is in flight, an extract is awaiting its reconcile, the primary writer is
held, a cooldown is active, two flushes are already queued, or the unwritten window is below
`flushMinTokens` — in which case the listing itself says how much a write needs, because a model
that keeps flushing thin stretches was measured ignoring the refusals.
It is off by default because that pilot measured no compaction-survival advantage — the bank-rendered
summary kept the same 7 of 8 settled specifics as pi's own prose summary, while the extra writes cost
about 28 % more writer tokens — and the misses that did happen were extraction and retrieval use, not
the timing of the write. The tool stays available as an opt-in for sessions that want to choose the
boundary themselves, and the reading is provisional: three runs, one weak session model, one
conversation shape (`RESULTS.md`).

## Compaction: who decides when

**pi decides.** The extension never triggers a compaction — it only supplies the summary
through `session_before_compact` (`renderMemory(bank, summaryMaxTokens)`), sets
`firstKeptEntryId` itself (so this extension's `keepRecentTokens` wins over pi's
`compaction.keepRecentTokens`), and logs the event. If the bank is empty it returns
nothing and pi summarises with its own model.

That cut is pi's, with one adjustment: it is clamped back to the write watermark so
entries the writer has not read yet are not dropped from the branch. The clamp is
bounded by `maxChunkTokens` — one chunk's worth of backlog is worth holding, more is not.

Past that bound the extension **waits first, then hands the compaction back to pi**. The
wait comes first because of where pi asks: `_checkCompaction` runs *before*
`agent_before_settle`, so a threshold compaction arrives while the write that `turn_end`
started is still running, and that whole in-flight chunk counts as unread. On session
`01a17818` a compaction deferred at 12:36:01 with 95 entries / 23 061 tokens unread; the
write it was deferring for landed at 12:37:40, and the next manual `/compact` cut at the
cursor — the deferral was priced on a write that was 39 s from finishing.

The wait is bounded by `compactWaitMs` and priced from the last eight writes
(`src/lag.ts`): which stage the write is in, what that stage usually costs, and whether what
is left fits the budget. It applies only to a write already running, only to `threshold` and
`manual`, only while the writer is healthy, and never to overflow (below) or to a write
sitting in 429 backoff with the endpoint busy. It is announced once, in the shape
`pi-hy-memory: writer 95 entries behind (~23 061 tok), reconcile 38s in, ~11s left — waiting
up to 60s before compacting`, with `wait` in the footer; `waitForWriterBeforeCompact: false`
removes both.

When the write lands, the boundary is recomputed from the branch it left behind — the cursor
moved, and the chunk's own `hy.extract` / `hy.ops` records were appended — and the extension
compacts as usual. When it does not, the extension **hands the compaction back to pi**
(`return undefined`): pi's own summariser compresses the unread entries into prose, which is
what would happen without this extension, instead of the entries disappearing from the live
context unread. The audit lines are `compact_wait { stage, entries, tokens, etaS, budgetMs,
waitedMs, cursorAdvanced, chainDepth, outcome }` and `compact_wait_skipped { reason, etaS }`,
ahead of the existing `compact_deferred { entries, tokens }`. Deferring is still the case a
writer outage creates — measured on 2026-10-19, a 36-minute 502 storm left 477 unread entries
and the older behaviour dropped 53 459 tokens of history that no chunk had ever read. The
extension renders a summary for free; when it cannot do that faithfully, paying pi's model
call is the cheaper mistake.

**Overflow is the exception, and it never defers.** pi's summariser has to send the whole
conversation to compress it, which is exactly the request an overflow cannot make: session
01a15d4e (2026-10-21) deferred twice at 375 464 tokens against a 196 608-token window, the
provider answered both attempts with 400 "request exceeds the context window", and the session
was left unrecoverable — deferring to a fallback that needs the same oversized request is not a
fallback. On overflow the extension produces the summary itself, and the window is divided
before the cut is chosen: kept tail, summary and digest all fit inside
`contextWindow − reserveTokens − overhead`. The overhead is measured rather than guessed — pi's
count of the request minus this branch's own token sum, floored at 2000 and capped at a third of the
window, since that gap is prompt and tool schemas only partly. Guessing it too small is what caused
the thrash: a compaction that misses the threshold it was meant to clear makes pi compact again.
`keepRecentTokens` is a working-set preference and loses to that budget. Inside the split the note gives
way first — it sheds tokens from its configured maximum before the tail gives up an entry, and the tail
is held at 1 000 tokens whenever the room can pay that — so a small window keeps a usable working set. The
newest entry is never dropped because pi needs a real id to cut at. Whatever the cut removes while still
unread is digested into the summary — `overflowDigestTokens` is a ceiling, and what is spent is what the drop set costs — recorded as an `hy.gap` in the
ledger, and audited as `compact_trimmed`, so coverage resumes at the first kept entry instead of
claiming history the extension never sent.

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
| `gap-reload-check` | that discard survives a reload: the gap is a session entry, so the copy of the ledger that wins coverage still holds it |
| `idle-drain-check` | an idle session drains only a backlog 4× the trigger, never over an in-flight write, a held primary, a cooldown, or `/hy off`, and a failed writer is probed 3 times rather than vetoed |
| `lost-cursor-check` | a rewound branch resumes from the furthest coverage the ledger still reaches, not from index 0 |
| `failure-class-check` | chunk/output failures shrink the next chunk; transport, 5xx, 429 and auth do not — and the failure cooldown doubles to a cap |
| `failover-state-check` | the cooldown is cleared only by a **primary** answer |
| `write-resume-check` | coverage contiguity, not re-extracting after a failed reconcile, a user-citing draft marked user-grounded, and the extract record's turn counts (omitted, not zero, when the renderer labelled nothing) |
| `compaction-window-check` | compaction holds uncovered entries while that is affordable, accepts pi's cut when it is not, and sizes entries by their real text |
| `compaction-hook-check` | the hook uses pi's `firstKeptEntryId` and real `tokensBefore`, and a `hy.gap` record reaches the mirrored ledger when the clamp gives way |
| `ops-guard-check`, `subject-guard-check` | wrong-target and wrong-subject UPDATEs |
| `redact-check` | credential redaction without damaging identifiers |
| `json-repair-check` | the three measured malformations (illegal escape, stray quote after a number, a bare token inside an array) parse, content survives, valid output is untouched, and an unparseable reply is re-asked exactly once |
| `source-ref-check` | refs arrive as the `[n]` indices the chunk shows: an id naming one source entry becomes its index and is counted, a truncated id resolves only while it names one entry, an ambiguous or unknown id gets its own rejection reason, prose that looks like a list keeps its brackets, and a captured chunk's line labels become indices while a bracketed commit sha stays as written |
| `budget-check`, `reload-budget-check` | pool eviction order, reload semantics, summary budget |
| `stats-counter-check` | the counters describe the session, not the process: a reload continues writes, drafts, adds, merges and refusals from its ledger, a ledger written before `downgradedCount` reports a floor and admits it, a gap counts as a compaction only when it is one, and a session with no ledger starts at zero and says it is fresh |
| `evict-record-check` | the `hy.evict` record the ceiling writes: it names exactly the ids that write dropped and its arithmetic closes, folding ignores it so a replay restores those facts and shifts no `chunkSeq`, a reload at the same cap drops exactly the ids the record names, an unknown ledger record breaks nothing, and the record survives the reload read path |
| `render-check` | compaction summary budget, omission reporting, and newest-first admission |
| `bank-index-check` | the experimental bank-aware extract call: index arrives as background rather than transcript, carries no bank ids, drops whole entries newest-first, and the flagless request is byte-identical to the shipped one |
| `extract-prompt-check` | an extract-prompt variant reaches only the extract call and nothing else; it is additive against the shipped prompt (no clause dropped or reworded), asks the writer for no field it is not already asked to emit, keeps the empty answer available, survives the JSON re-ask, leaves reconcile untouched, and is never set by the shipped extension |
| `restraint-corpus-check` | the authored restraint corpora keep their promises to each other and to the shipped renderer: contrast pairs differ in exactly one thing, declared values appear only in their own chunk, nothing leaks onto the side that must not name it, no probe is a word in the writer's own prompt, a chunk holding a long tool call keeps its arguments longer than the window the renderer actually cuts at, and every cut call shows the marker that renderer leaves on the cut, a declared hidden value is absent from every chunk's visible text and keeps at least one token — flag name or number — that no chunk shows anywhere, with the ambiguous tokens named instead of counted, a declared constraint or transient is present in its own chunk, and no authored text carries a hostname, an absolute path under a home directory, or a credential-shaped string |
| `restraint-corpus-mutation-check` | deliberate breakings of every committed restraint corpus — one rule broken at a time — each rejected by the rule it breaks. The count is printed by the check itself, not written down here, because a corpus that cannot fail is not evidence |
| `restraint-report-check` | the scorer's own gates score as intended, including the blind spots it now reports rather than hides: a declared value banked twice from one chunk, a fact credited to a chunk that did not author it, a chunk that banks one declared value and loses another, the difference between a flag sentence and the same flag confirmed by a person, a declared rule kept verbatim versus kept only as its content words versus reaching no bank fact, a value the writer was never shown that a banked fact carries anyway — plus the same probe reporting nothing where nothing was supplied and nothing where another chunk prints that token — and chatter that reached the bank reworded rather than quoted |
| `clip-check` | what the writer is shown when a tool call runs long: a call past `ARGS_WINDOW` arrives as the window plus clip()'s `…` and never closes as JSON, a call whose flag sits past the window 600 replaced is shown whole, the same entry at that old window hides it, no shipped caller sets the window, and a body over `maxEntryChars` is cut with the same marker |
| `clip-window-check` | the window arm is a comparison and not a coincidence: three values sit strictly between the window `ARGS_WINDOW` replaced and the shipped one and are read by the wide arm only, one control sits inside both and is read by both, the two arms are identical outside the arguments, and a spec whose value is inside the narrow window, past both windows, or missing its readable control is refused rather than scored as a null result |
| `arg-window-cost-check` | the window cost instrument against constructed calls of known length: a call inside the window contributes nothing, one past it contributes what the wider window shows and no more, one past the wider window is counted as still cut, lines that are not assistant tool calls are not counted, and a value planted in a call's arguments appears nowhere in what the instrument reports |
| `verbatim-report-check` | the recoverability instrument against constructed ledgers: a value quoted in a banked statement is recoverable, one present only as a paraphrase is not, one absent from the bank is destroyed, and the three never mix |
| `guard-fold-check` | the subject guard re-fold reproduces the shipped bank entry for entry, a case where turning the guard off changes the bank is reported as a difference rather than as agreement, and the two value gates are pinned apart: a draft that restates every value on 2/11 shared passes `value-only` and fails `value-carry` |
| `merge-value-gate-check` | the value gate through the shipped write path: with it on, the merge that drops 420 is refused and the refusal names both values; with it off the same merge erases the number; restatements, key-carried values and valueless targets still merge, the subject test refuses first under both settings, and the two ledger-reading reports classify the new refusal reason rather than throwing on it |
| `recall-reach-check` | the recall query over the whole bank: a value that only a pool-budget retirement still carries is answered, live facts fill the result first and a retired fact is added only when it matches better than the weakest live one (at most three of them), a retired row says what dropped it and names what replaced it, a no-query listing returns current facts only, and `hy_recall` is pinned to search the bank rather than an active-only slice |
| `live-bank-report-check` | the organic-session instrument on a constructed store: ledger and stats counts that disagree are both printed rather than reconciled, the fold and the live store disagree by exactly what the ceiling retired, the merge that drops 420 is applied in the shipped replay and refused in the gate replay, a ceiling-retired value is still answered by the query, the gate-off replay agrees entry for entry with `foldLedger`, the ledger's user-turn counts add up across writes, and the digest changes only when the ledger does |
| `retrieval-refusal-report-check` | the refusal report on a four-write ledger: a target that is eligible but ranked past the shipped view is attributed to the limit that would have shown it, a target whose wording never reaches the eligibility floor is counted as unreachable at any view size, a `target id not in bank` is sorted by what the field actually held (bare index, word, real id with one character appended, nothing), a write that downgraded more than its bounded list recorded is reported as a sample, widening is priced rather than assumed, and a store the fold cannot reproduce is refused |
| `session-scope-check` | destructive authority across a session boundary, pinned as the behaviour that ships: candidates are retrieved unscoped, `sameSubject` is blind to session identity, a cross-session UPDATE supersedes the other session's entry leaving only its own session marker, and the ledger classifier keeps applied crossings apart from refused proposals and refuses by the reason the bank recorded |
| `prune-check` | retention deletes old sessions and nothing else |
| `config-docs-check` | every setting in the code is in the table above, with the same default |
| `budget-split-check` | the arithmetic a compaction hands the model: exact values at window boundaries, the digest cap flooring rather than rounding, the order the parts are served in (the note sheds its cap before the tail sheds an entry), the published window table in `DESIGN_HYVCC.md` reproduced row for row, a reservation that only ever moves down and never past its ceiling, the walk and the request cap staying separate so a budget trim always yields a reportable `trimmed` range, monotonicity as the window grows, and a probe loop that reports `converged: false` instead of iterating forever |
| `design-leak-check` | every markdown file in the repository is free of the shapes that would say where it was written: an absolute path under a home directory, a pi session directory name, a credential-shaped token, an e-mail address, a non-local IP. It exists because a design document now quotes a summary synthesized from a real session file |
| `hyvcc-fixture-check` | the fixture that `dev/hyvcc-demo.ts` measures actually names itself: a frozen copy records bytes, entry count and a content digest for both legs (session *and* bank, so neither can drift while the numbers look pinned), the identity line is printed before any figure and carries no path and no session directory name, a copy that no longer matches its manifest reports `MOVED`, a live file with no manifest is called one rather than looking pinned, and a session file caught mid-append loses its half-written record and nothing else. Built on a synthetic session in a temp directory, so it passes on a machine that has never held the fixture — no real token count is asserted anywhere, because a check that pinned one would pass only here |
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
| `src/serialize.ts` | pi entry text → chunk with positional `[n]` refs; internal ids hidden. `labelLinesToIndices` rewrites a captured chunk's legacy `[da8e7079]` line labels into the same indices, so a replay never shows the writer an id it was never meant to see |
| `src/prompts.ts` | extract prompt (fixed) + reconcile prompt (size-aware) |
| `src/protocol.ts` | JSON parse (three measured malformations repaired, each named in the audit), validation, sanitizing, bank/draft rendering; a ref naming a source entry id becomes that entry's index and is counted rather than forgiven |
| `src/values.ts` | what counts as a value rather than wording — numbers, flags, file names, paths, identifiers — and which values an UPDATE draft fails to restate; the one definition the gate and the reports share |
| `src/bank.ts` | ledger fold, candidate retrieval, op application, budget |
| `src/pipeline.ts` | the two calls and everything deterministic around them |
| `src/render.ts` | model-free compaction summary + omission notice, the bank index the experimental extract arm shows the writer (pinned by `tools/bank-index-check.ts`), and the recall query that scores the whole bank, keeps live facts dominant and marks a retired fact (pinned by `tools/recall-reach-check.ts`) |
| `src/status.ts` | footer bar: window fill, bank fill, spinner, flash |
| `src/failover.ts` | when the primary is considered down, and when it is trusted again |
| `src/state.ts` | retention for per-session state |
| `src/stats.ts` | what the footer and `stats.json` count, and how those counters are recovered from the session's own ledger at load instead of restarting at zero (pinned by `tools/stats-counter-check.ts`) |
| `src/config.ts` | every setting and its default |
| `src/entries.ts` | coverage window, entry rendering, chunk building from session entries |
| `src/chain.ts` | when a finished write is followed by another, and when a flush is accepted |
| `src/failures.ts` | failure class, cooldown ladder, whether a chunk should shrink |
| `src/lag.ts` | how far behind the writer is, and whether a compaction should wait for it: stage-aware ETA from the last eight writes, and the gates that make it skip (overflow, unhealthy writer, backoff, no history, ETA past the budget). Pure — pinned by `tools/lag-check.ts`, and its wiring by `tools/compaction-wait-check.ts` |
| `src/budget.ts` | how a compaction splits the room the next request has — tail, digest, note — including who gives way (the note sheds its configured maximum before the tail gives up an entry, and the tail is owed `COMPACT_KEEP_MIN_TOKENS` whenever the room can pay it), a digest reserved at a ceiling and then priced down by a boundary probe, and the difference between the backward walk (`keepRecentTokens`) and the request cap a trim is reported from. Pure — pinned by `tools/budget-split-check.ts` |
| `src/flush.ts` | `hy_flush`: list the unwritten entries, resolve a `to` into a monotone range |
| `src/hifi.ts` | the optional model-written checkpoint and its fact guard |
| `src/llm.ts` | the writer client used by the extension |
| `src/index.ts` | the wiring: triggers, tools, command, footer |
| `dev/poc.ts` | replay harness over captured chunks (needs `POC_ORIGIN`) |
| `dev/export-judge.ts` | bank → judge result files |
| `dev/raw-writer.ts` | the only HTTP client, for the shell harnesses above |
| `dev/run.ts` | replay a corpus of captures through the shipped write path (`--bank-index` runs the bank-aware extract arm and `--extract-prompt actorframe` the actor-frame prompt arm; both are off by default, so baselines are the flagless path). Captured text is normalized to the indices the shipped path shows, and a chunk it gives up on after all attempts is listed in `metrics.json` as `droppedChunks` instead of vanishing from the ledger |
| `dev/prompts-actorframe.ts` | the actor-frame extract prompt: the shipped prompt plus the clauses upstream Hy-Memory puts at the top of its own coding extract prompt — who a statement is about, restraint as budget reallocation rather than abstention, evidence fidelity. Experiment-only; `tools/extract-prompt-check.ts` pins that it is additive, reaches only the extract call, and is never set by the shipped extension |
| `dev/judge.ts` | blind quality judge for one run's writes, rubric in `dev/rubric.md` |
| `dev/boundary-arms.ts` | move the chunk boundary over identical content, compare runs, emit the pieces for the judge |
| `dev/live-wait-replay.ts` | replay the live audit through the compaction wait policy: for every past `compact_deferred`, what the hook would have seen, whether it would have waited, and whether the write landed inside the budget. Read-only; it is how `compactWaitMs` was chosen rather than guessed |
| `dev/live-wait.sh` | watch a live session wait: one headless pi session over RPC, first prompt allowed to finish its write (an ETA needs a completed write to price), second prompt leaves a chunk running, compaction requested while that chunk is in flight. Asks each provider instance what it actually serves before anything runs and drops the ones that do not answer, because a model list broken by a dead instance is what lost two earlier probes their runs mid-session. Prints the audit lines it produced and pi's own answer. `LIVE_MODEL=<provider/modelId>`; scratch HOME, scratch state, scratch provider config so the writer really resolves |
| `dev/live-wait-driver.py` | the RPC client behind it: JSONL over stdin/stdout, keeps `extension_ui_request` notices as evidence, follows the audit filtered to that session, and says whether the wait happened or was skipped and why. The compaction line is read from the audit rather than from pi's event stream — a manual compaction is not an agent run and never says it has settled, and waiting for that is what discarded an earlier probe's verdict |
| `dev/live-flush.sh` | run pi headless with the extension loaded and ask whether the model calls `hy_flush` |
| `dev/live-cadence.sh` | compare model-initiated writes against the token threshold in one live session |
| `dev/corpus-restraint.json` | authored contrast pairs with known-correct output: 8 attribution pairs, 10 empty chunks (contract enforced by `tools/restraint-corpus-check.ts`) |
| `dev/restraint-report.ts` | score a run against those pairs: abstention, speaker attribution at the draft gate and the bank gate, and the `tool_output` axis — what each tool chunk banked, including which facts repeat a declared value, which carry neither half, which a later merge carried in from another chunk, which declared values never reached the bank, which banked statements open with a person or with the agent's own voice, what became of each rule text the chunk declares (kept verbatim in a bank fact / kept only as its content words rearranged / reaching no bank fact — a keep means the wording sits in a banked fact, not that the rule was followed), which banked facts carry a token of a hidden value that no chunk in the corpus shows, and which banked chatter possibly arrived reworded rather than quoted (word matching, so a synonym substitution slips past it; reported columns, not gates) |
| `dev/corpus-restraint2.json` | the second cut, its own gate: 8 new attribution pairs, 6 `nothing_work` chunks, 6 `tool_output` chunks (same contract check, plus `tools/restraint-corpus-mutation-check.ts` proving it rejects a broken corpus) |
| `dev/corpus-restraint3.json` | the `tool_output` class at width: 12 tool-output chunks against 4 attribution pairs (8 chunks) and 2 `nothing_work` — 22 chunks — measured before any rule is written for the class |
| `dev/corpus-restraint4.json` | the fourth corpus, cut for the labels corpus 3 lacks while corpus 3 stays frozen so its published numbers stay comparable: 22 chunks across two authored sessions — 12 `tool_output`, 4 `nothing_work` with tool output under them, 3 attribution pairs — of which 4 hold a tool call whose arguments run past the window the renderer cuts at (`ARGS_WINDOW`, 600 since 2026-10-24), 2 hide a value the writer is never shown anywhere in either session, 4 declare a user rule that must survive as a rule rather than as a defect, and 1 restates a subject the other session established |
| `dev/gen-corpus-restraint4.mjs` | regenerate that corpus: it pads a command with flags real commands carry until the value it must hide falls outside `ARGS_WINDOW`, slices the arguments exactly as `src/entries.ts` slices them, and rewrites the file byte for byte. Committed so the corpus is derivable rather than asserted; `tools/restraint-corpus-check.ts` re-measures every promise in it from the shipped renderer instead of trusting what this script wrote |
| `dev/clip-report.ts` | how often the writer's view of a call is cut, measured on captured chunk texts: cut calls per session, whether the cut lands inside a quoted string, whether the call's own result on the next line carries a flag the visible arguments did not, and how many of those cuts carry the marker — the captures were rendered at the 240-character window and before the marker shipped, so those two numbers describe the captures rather than what ships |
| `dev/clip-window-report.ts` | the window arm: four authored chunks rendered twice by `serializeEntries`, once at the 240-character window `ARGS_WINDOW` replaced and once at the shipped one, with three decision-relevant values placed strictly between the two and one control inside both. Refuses a spec that is not a comparison, and writes the two corpora `dev/run.ts` replays so the banks can be scored against each other |
| `dev/arg-window-cost.ts` | what a wider argument window costs, counted on pi's session files rather than on already-cut chunk texts: calls the window cuts, the characters and estimated tokens a wider window would add, and how many calls it would still cut. Prints lengths and counts only — no command text, no paths, nothing written |
| `dev/verbatim-report.ts` | whether the values a merge destroyed are recoverable at all: for each declared value, quoted in a banked statement, present only as a paraphrase, or absent |
| `dev/guard-fold-report.ts` | the same ledgers re-folded under five merge gates — shipped, tightened, off, and two code-side value gates that accept an UPDATE only when the draft restates every specific token the target carries — with the values each gate dropped, the cascade each refusal caused counted beside its zero, and the re-fold's agreement with the bank on disk reported first |
| `dev/session-scope-report.ts` | destructive ops read off every ledger: applied, refused by the reason the bank recorded, and split by whether the target was written by another session, plus the merge candidates each chunk was offered split by who wrote them, and the tier-6a re-entry trigger when any applied op crossed a session boundary |
| `dev/live-bank-report.ts` | one real session read from its own state files, offline (`--snapshot <dir>` copies the three files and writes a `manifest.json` naming the copy (session, when taken, ledger digest), which every snapshot-reading report prints before its numbers, so a session that is still writing yields numbers that can be re-read and said to be about a named copy): what the pool ceiling retired, the values carried only by retired facts and whether the query reaches them, the fold against the store the session actually had (they differ by the retirements that session never recorded — it ran before `hy.evict` existed), the value gate replayed over the merges the writer really proposed, whether that replay agrees entry for entry with `foldLedger`, the refusal mix, how much of what the writer was shown was the user's own turn (0 of 0 with the note that the session predates the counter), and the stats counters, which for a session reloaded before 2026-10-25 counted only this process while its ledger counted the session |
| `dev/retrieval-refusal-report.ts` | every refusal a frozen session recorded, attributed offline (`--snapshot <dir> --shipped 24 --limits 24,48,96`): each write's bank is rebuilt with `foldLedger` and the shipped candidate selection re-run at each limit, so a "target not retrieved for this draft" is separated into what a wider view would have shown, what is eligible but ranked past every limit tried, and what never reaches the scorer's floor at all; `target id not in bank` is sorted by what the writer put there, and each limit is priced in rendered entries and estimated reconcile input |
| `dev/draft-gate-report.ts` | why the model was never shown some bank entries, offline from a run's ledger: retrieval coverage per drafted fact and every candidate it was actually rendered next to, split by candidate-render mode, and which entries were never candidates for any draft in the run |
| `dev/inspect-supersede.ts` | read-side follow-up on the loss measurement: what replaced a given bank entry, and whether the replacement is a genuine update or a same-subject copy that never made it into retrieval |
| `dev/merge-report.ts` | what every accepted UPDATE in a run did to the entry it replaced, read offline from its ledger with no model call: which value tokens left the entry, which corpus-declared values were lost, which clause of the subject guard let the merge through, what each refusal cost in duplicates, and whether reconcile ever merges two drafts carrying the same declared value. `tools/merge-report-check.ts` pins it on a fixture whose answers are known by construction, including a guard-approved merge that loses a declared value |
| `dev/dedup-report.ts` | the duplicate one chunk writes twice, priced before anything ships (TODO 7.14's residue): re-applies a run's ledger write by write with a deterministic same-batch dedup and compares banks, three ways — drop, drop only what is provably redundant, or retire the duplicate behind a pointer to its survivor. Says what each removal was made of (a value the survivor already held, no value at all, the user's own words, a number the value extractor never named), which later merges aimed at a removed row and rebuilt it as an orphan ADD, and whether any value went dark. `tools/dedup-report-check.ts` pins the rule and the replay trap: folding a ledger that recorded a retirement hands the duplicate back as current |
| `dev/user-turn-report.ts` | what a user's turn actually contains, offline from captured chunks beside a frozen snapshot (TODO 6.20b): each user turn classified by wording (question, directive, both, go-ahead, neither), which directives a later assistant turn restates, which line each draft cited and of what shape, and how many current facts carry a directive's wording with no `fromUser` mark — including ones sitting where a marked fact used to be, which is how a merge drops the mark. Says which numbers are unavailable because a chunk has no capture, rather than printing zeros. `tools/user-turn-report-check.ts` pins the shapes, the restatement test and that decay |
| `dev/constraint-slice-report.ts` | what the summary's reserved constraint slice would contain if it selected on the statement rather than the citation (TODO 6.20c): runs the shipped `selectForSummary` twice over a frozen snapshot, once on the bank as it is and once on a shadow bank whose `fromUser` sits on rule-shaped statements, so the comparison is one code path with one input changed. Reports both a narrow and a broad rule test, how many narrow matches a not-a-rule proxy flags (a floor on false positives, not a precision measurement), which facts the swap displaces and admits — both the slice and the foundations partition move when the mark moves — and whether rule-shaped facts stay current better than marked ones. `--list` prints every narrow match with the proxy's verdict beside it, so the rate can be labelled by a reader rather than regexed (TODO 6.20d, one reader's labels: 5 of 64 usable as a constraint, 39 carry no obligation). `tools/constraint-slice-report-check.ts` pins the shape verdicts, the list and the tight-budget case where marking a rule fact takes it out of the foundations slice and it leaves the summary |
| `dev/hyvcc-demo.ts` | synthesize a compaction summary in two arms over one real session file and one real bank, with no model call: hy's own cut and `renderMemory` with and without a deterministic block carved out of the same summary cap, the block compiled by pi-vcc's own `compileRanked` over the identical prefix. Reports the parts in tokens, the block's section composition, its compile time, and what pi-vcc's merge does to a memory block handed to it as `previousSummary` (how many fact ids come back) and to a skeleton merged with itself (how many lines survive, and how much the block grows). Redacts home paths, project directory names and credentials on the way out. `--snapshot` freezes both inputs into a named copy (`--fixture`, default `out/hyvcc-fixture/`) whose manifest records bytes, entry count and a content digest for each leg, so the two arms and every published figure measure the same bytes; without it the harness says on its first line that it is reading live files. The worked example in `DESIGN_HYVCC.md` is its output |
