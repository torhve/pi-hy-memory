# pi-hy-memory — a memory extension shaped around the writer model

Design + proof of concept. Reference architecture:
[`pi-observational-memory`](https://github.com/elpapi42/pi-observational-memory) V3
(sibling: [`pi-blackhole`](https://github.com/k0valik/pi-blackhole)). Model: `hy-memory-30b-a3b` on the local
llama-swap (hybrid Q4_K_M, 131 072 ctx, `reasoning_effort=no_think`, `temp 0.0`).

## Thesis

`pi-observational-memory` treats its memory model as an **agent**: it gives it a tool,
lets it run a multi-turn loop, asks it to close the loop with `complete=true`, and then
hires three such agents (observer, reflector, dropper) to do extraction, distillation and
pruning.

Hy-Memory-30B-A3B is not an agent model. It is a **memory bank writer**, RL-trained inside
Mem0 / MemOS / Hy-Memory to answer one question per chunk: *given this new evidence and
the bank I already have, what should the bank look like now?* Measured on this machine, it
is the most accurate writer ever put through the harness and the worst orchestrator.

So this design keeps everything `pi-observational-memory` gets right — the append-only
ledger, coverage watermarks, the model-free compaction fold, the recall tool — and replaces
its three-model pipeline with **two single-shot JSON calls** plus deterministic code.

## What was measured, and what it forces

All numbers from a private judge harness (four real observer chunks 482/484/486/503,
replayed against the captured production payloads).

| measured | value | design consequence |
|---|---|---|
| `closed_by_complete=false` | **12 of 12 runs** | no tool loop, no completion handshake. One request, one answer. |
| turn cap exhaustion | 12 turns on 484/486/503, 296–350 k input tokens | no multi-turn iteration at all. |
| `--max-turns 2` at `temp 0` | identical recorded memory, 47.6s vs 248.0s, 49 450 vs 296 700 in-tokens | everything it will say, it says in the first answer. Ask once. |
| duplicate proposals at `temp 0` | **510 of 585** proposals were exact-hash duplicates | never ask it to "continue"; it repeats. Dedup is code's job. |
| chunk 482 at both temperatures | **0 observations**, `tool_calls: null`, a valid `{"observations":[…]}` object in `content` | accept the JSON body as the primary protocol, not a fallback. |
| grounding verdicts | 651/665 supported, **0 unsupported, 0 invented `sourceEntryIds`** | trust the model's fact extraction; keep validation cheap. |
| `grounding: broken` | 19/590 observations copied `[Source entry id: …]` labels into memory text | never show the model an id it could echo. Cite positionally. |
| over-recording | 102–189 observations per dense chunk, only 22–76 durable | the model must decide *bank updates*, not just emit lists; pruning is code. |
| secrets | on 482 it wrote an `apiKey` into a statement | redaction belongs in the writer path. |

## Kept from pi-observational-memory V3

| V3 component | here | why |
|---|---|---|
| append-only ledger as source of truth (`om.observations.recorded` …) | `hy.extract`, `hy.ops` records | crash-safe, replayable, no live object to corrupt. |
| `coversUpToId` progress watermark | same field on both record types, plus `hy.gap` when a compaction cut past it | decouples "what has been seen" from "what is provenance", and keeps a lost range visible instead of silently covered. |
| deterministic compaction fold + render, no model call | identical | this is V3's best idea: compaction becomes a string build. |
| `recall` tool keyed by 12-hex id | identical | memory stays evidence-backed. |
| supersede/tombstone semantics (drops never delete history) | `status: active \| superseded` + `supersedes` / `supersededBy` | the model's DELETE/UPDATE needs a non-destructive home. |

## Removed

| V3 component | replaced by |
|---|---|
| observer agent (multi-turn tool loop, `complete=true`) | **extract call**: chunk → `{"drafts":[…]}` in assistant content |
| reflector agent (observations → reflections) | **reconcile call**: drafts + retrieved bank → `ADD` / `UPDATE` / `DELETE` ops. Distillation *is* the model's trained task; a second agent is redundant. |
| dropper agent (pool pressure → drop list) | `enforceBudget()`: rank by relevance + confidence, supersede the tail. Deterministic, auditable, free. |
| coverage tiers (`none` / `partial` / `strong`) annotated per observation | not needed: the bank shown to the reconcile call *is* the coverage question. |
| tool schema + `record_observations` handshake | none. The model is never offered a tool it measurably refuses to call. |

## Architecture

```
turn_end
  ├─ due? raw source tokens since last hy.extract watermark ≥ observeAfterTokens
  ├─ serialize chunk      [Source entry id: 3334369c]  ->  [7]      (ids hidden from model)
  ├─ 1) extract           chunk -> drafts JSON          (temp 0, no_think, no tools)
  ├─ retrieve             drafts vs active bank -> <=12 candidate entries (lexical overlap)
  ├─ 2) reconcile         bank + drafts -> ops JSON
  ├─ validate + sanitize  schema, ids, source refs, secret redaction, near-dedup
  ├─ apply ops            ADD / UPDATE(supersede) / DELETE(tombstone)
  ├─ enforceBudget        pool token cap, supersede the weakest
  └─ append ledger        hy.extract + hy.ops

write completes
  └─ window still ≥ observeAfterTokens? -> follow-up write (≤2 per turn, only while
     failures == 0 and no persisted extract)                        (src/chain.ts)

session_before_compact     (pi decides when; this only answers)
  └─ fold ledger -> render facts -> { summary, firstKeptEntryId, details }   (no model call)

session_start
  └─ fold ledger -> enforce pool cap -> prune state older than pruneAfterDays

recall tool
  └─ id -> entry -> sourceEntryIds -> exact source text from the session ledger
```

Two model calls per chunk. No turn budget, no completion signal, no third agent.

**A completed write may chain one more.** The trigger runs on `turn_end` and returns
early while a write is in flight, so a chunk that landed mid-turn left its backlog waiting
for the next turn — measured on session `01a1510e`, ten minutes with the footer pinned at
29k/15k after a failed write at 13:45 and no write until 13:55. The completion path now
re-evaluates under a narrow policy (`src/chain.ts`): follow up only while `failures == 0`
and never after the attempt that just failed, never for a persisted extract (that window
belongs to its retry path), and at most `MAX_CHAIN = 2` per turn, so an idle session drains
a backlog without turning a failing writer into a retry loop. The "last attempt failed" gate
is separate from `failures` on purpose: an endpoint failure resets the budget shrink but still
means the writer is struggling — measured 2026-10-19, chunk 069 failed and 070 started one
second later, another full 20 000-token request.

**Coverage is a position, not an id.** The watermark is stored as an entry id, and pi can move
the leaf: a rewind, a resumed checkpoint, or a compaction that re-parents the branch leaves
that id in the session file but off the current chain. Two failures followed from treating the
newest record's id as the coverage point:

1. The id vanished, `tokensSince` fell back to index 0, and the entire session became
   "pending" — measured on `01a1510e` at **431 329 tokens across 3 617 entries**, so writes
   began re-extracting history the bank already held.
2. The records written after the rewind advanced the watermark *backwards* (chunk 065 →
   index 93, 066 → index 232) while chunk 062 had already covered index 3423.

Coverage is monotone along the branch, so the window starts after the furthest position any
ledger record still reaches (`coverageWindow`), which fixes both at once: on the real session
it turned a 353 507-token window into **19 406 tokens / 193 entries**, audited as
`coverage_drift { from, to }`. When no record lands in the branch, the newest writer record
is the proxy, then the last compaction entry — never index 0, which is what made the whole
history pending.

**A session can be switched off, and the switch is durable.** Not every session earns its
keep: one that ends before the next compaction never uses the facts its writes paid for, and
each write is two model calls. `/hy off` therefore sets `state.enabled = false` and writes
`state/sessions/<sessionId>.off`, which `reset()` reads, so a reload or a resumed session
stays off and `session_start` audits `disabled: true` and says so once — a switch that
silently flips back is worse than no switch.

While off, only the expensive half stops: `sessionActive()` gates the `turn_end` trigger and
the chain policy, and nothing else. The compaction hook still answers with the bank when one
exists, because that summary is a free string build and dropping it would make an off session
strictly worse; with no bank it already returns `undefined` and pi summarises with its own
model. `hy_recall` keeps working. The footer renders `hy off` and drops the pending bar,
because a bar that can never drain reads as a stall.

`/hy on` **discards** what accumulated: it moves the watermark to the newest branch entry and
writes a `hy.gap { reason: "disabled" }` — the same record compaction uses for a cut it could
not avoid — so the ledger still says which entries were never read, and no catch-up burst is
paid on re-enable. The config's `enabled: false` stays the global kill switch and wins.

**Failures are classified before they shrink the chunk.** `failures` halves the next
chunk, which is right when the request is the problem and wrong when the endpoint is.
`src/failures.ts` sorts a failure into `chunk` (timeout/abort, 413, context-length
rejection), `output` (unparseable or empty completion) and `endpoint` (transport, 5xx, 429,
auth); only the first two increment `failures`, and an endpoint failure resets it. Measured:
write 059 failed with `extract …: terminated`, a dropped stream, and halving the budget made
the next chunk leave 133 entries behind instead of 43.

**The writer is a model, not an endpoint.** `src/llm.ts` resolves `provider/modelId` from pi's
model registry and calls `registry.complete()`; provider registration, base URLs, credentials
and request shapes stay pi's business, including for models a provider registers dynamically at
runtime. The extension therefore contains no HTTP client. The shell harnesses in `dev/` have no
session and so no registry, and they use `dev/raw-writer.ts` for that reason alone.

## Protocol contracts

**1. Extract.** System prompt is fixed (so llama.cpp's prompt cache hits on every chunk).
Chunk is serialized with positional refs. Response is assistant content:

```json
{"drafts":[{"task":"llama-swap model capabilities",
            "statement":"llama-swap serves the observer models at llama-endpoint with an API key.",
            "keys":["llama-swap","api key"],
            "confidence":1.0,
            "refs":[7,9]}]}
```

Code rejects a draft when: statement < 24 chars after sanitizing, no `refs` inside the
chunk's ref range, `confidence` not a number, or the statement duplicates one already
accepted. `relevance` is derived in code from `confidence` (≥0.8 high, ≥0.5 medium, else
low) rather than asked for — the model's own relevance labels correlated with durable
value in the harness but were not consistent enough to budget a pool with.

**2. Reconcile.** Only the retrieved candidates are shown, never the whole bank:

```json
{"ops":[{"action":"ADD","draft":0},
        {"action":"UPDATE","draft":3,"target":"4f2a9c1b7d33","reason":"model swapped from swift to qfn"},
        {"action":"DELETE","target":"9a01c4de22f7","reason":"endpoint deprecated in this chunk"}]}
```

Code rejects an op when: `draft` index out of range or already used, `target` not a valid
id **in the shown set**, or the action is unknown. A rejected op never corrupts the bank;
it is counted and logged.

**3. Sanitize.** Every statement gets: `[Source entry id: …]` labels removed, any id that
was actually present in the chunk removed by exact match, bracketed numeric refs removed,
`sk-…`/`token…`/`Bearer …` secrets masked, whitespace collapsed, 420-char cap.

## Why each measured failure is designed out

| failure mode in the current pipeline | here |
|---|---|
| model answers with JSON instead of calling the tool → `emptyReason: tool_not_called` → cursor advances `"empty"` → chunk permanently skipped | that answer **is** the protocol. There is no tool to refuse. |
| run never closes → 12 turns of re-sent chunk | there is no run to close. |
| model repeats the same batch | one call per chunk; repeats cannot happen. |
| internal ids leak into memory text | the model never sees an id. |
| 100+ observations per chunk flood the pool | reconcile is asked to *merge*, and `enforceBudget` caps the pool deterministically. |
| chain-of-thought dumped into visible content | the writer asks pi's registry for the model and passes `samplingParams.chat_template_kwargs = {reasoning_effort: no_think}`, which pi-ai merges into the request body after the provider's own fields. No dependency on how a provider marks the model. |

## What happens when the bank fills

`poolMaxTokens` caps the *active* bank, not the ledger. After every write
`enforceBudget()` sums the active entries' `tokenCount` and, if the total exceeds the
cap, ranks and trims:

1. **Rank** = `relevance × 1000 + confidence × 100` (high 3 > medium 2 > low 1).
2. **Tie-break** = `createdAt`, newest first. This matters: with a bank of 69 facts that
   are all `relevance=high, confidence=1.0` the ranking collapses to a tie, and a stable
   sort over insertion order dropped the *newest* facts — measured on session 01a14c10,
   four of them real implementation facts (`disconnect()` no longer clearing
   `attemptSeqByProfile`, the `settle(attempt)` helper, …). A memory that tracks current
   state must prefer the newer entry when everything else is equal.
3. **Keep what fits** — a bin-packing walk, not a tail cut, so one long fact does not
   evict three short ones.
4. **Tombstone the rest**: `status: "superseded"`, `supersedeReason: "pool budget"`.

A budget-dropped fact is **hidden but not lost**: it stays in the bank file and in the
ledger, `hy_recall <id>` still returns it with its source evidence, but it is absent from
`renderMemory()` (so not in the compaction summary) and it is not a candidate for a later
UPDATE (only `active` entries are). It can only come back if a newer chunk re-states it,
which creates a new entry rather than reviving the old one. Each write now reports
`budgetDropped` (count and the first five ids) so eviction is visible in the audit
instead of silent.

Sizing, measured on this writer: a fact costs ~72 tokens (`tokenCount`), so the cap is
roughly `poolMaxTokens / 72` facts — 5 000 ≈ 70 facts, 12 000 ≈ 165. Two real sessions
reached 4 968 and 4 985 tokens, i.e. both were evicting facts at the default, which is
why the shipped config raises it. The cost of a larger pool is prompt size only: the
compaction summary is `renderMemory(bank, poolMaxTokens)`, a string build with no model
call, and the reconcile prompt shows at most `candidateLimit` retrieved entries
regardless of how large the bank is.

**Our token estimate measures stored text, not the request.** pi stubs old tool output
before sending (the branch carries `context_edit` entries for it), so a whole-branch figure
is not comparable to pi's own count. Measured on session `01a1510e` at the 09:56 compaction:
the branch held 2 925 entries, 1 009 of them `toolResult`, our estimate was 364 669 and
`preparation.tokensBefore` was 152 409. Excluding tool results ours was 56 381, so pi
includes roughly a third of that output and stubs the rest. This does not move the
*trigger*: the pending window is fresh text that has not been stubbed, and for fresh text
chars/4 lands within the documented ~1.4x tokeniser factor. It does mean a compaction's
`tokensBeforeEstimate` is a stored-text figure — which is why the audit records it next to
pi's real `tokensBefore` instead of replacing it.

Two things about this cap that measurement forced:

**Eviction is not durable, and that is deliberate.** `enforceBudget` mutates the in-memory
bank and logs `budgetDropped`; it does not append ledger records. On `session_start` the
bank is re-folded from the ledger (`foldLedger`), so a budget eviction disappears on
reload and the facts come back. Observed directly: raising the pool from 5 000 to 12 000
and reloading restored all 22 facts that had been evicted as `pool budget` in session
`01a14c10` (69 → 91 active). Eviction therefore behaves as pressure, not deletion — it is
re-applied at the next write against whatever cap is current, and the ledger stays a pure
history of what the writer decided. `loadState` therefore re-applies `enforceBudget`
straight after folding and audits `budget_reapplied`, so a reload cannot leave the bank,
the footer bar or the summary above the current cap (`tools/reload-budget-check.ts`).

**The summary budget adds the real prefixes to the pool.** `enforceBudget` counts fact text (`tokenCount`);
a rendered line adds `[id] (task) `, measured at +14.2 tokens per fact on a 91-fact
session (7 953 rendered / 6 659 counted = 1.19x). Rendering a full pool at the pool number
drops facts for overhead the pool never counted. A constant multiplier
would break again as soon as task labels run long, so `summaryBudget(poolMaxTokens, bank)`
sums the actual `[id] (task) ` prefixes for this bank (+630 tokens for 60 facts in
`tools/reload-budget-check.ts`), and `renderMemory` reports what it omitted instead of
truncating silently. Measured on the real banks: 12 000 tokens of bank ≈ 161 facts ≈
14 300 summary tokens ≈ 8.5 % of a 168 000 window.

**Admission order decides which facts survive the summary.** Facts are admitted
newest-first: a higher-relevance fact displaces a lower one, and at equal relevance the
newer one wins — the same rule `enforceBudget` uses. Chronological admission did the
opposite, because equal ranks never displace each other, so the *first* N facts were kept
and the newest were dropped; on session `01a1510e` (2026-10-19) the single omitted fact was
the newest in the bank, from the final write, while the summary header tells the model that
the later of two conflicting lines is the current state. Lines are printed chronologically
afterwards, so the newest fact is the last line read. Omission is still a bin-packing skip
(a fact too large for the remaining budget is passed over, not fatal), and what was omitted
is counted in the tail and reachable through `hy_recall`.

**Relevance is derived, and it saturates.** `relevanceOf(confidence, refs)` maps
`confidence ≥ 0.8` to `high`, so the tiers are only as informative as the confidence the
extract prompt asks for. It asks for explicitness ("how sure you are that the fact is
explicitly established"), having already told the model to extract only what the chunk
explicitly establishes, so the answer is almost always `1.0`: 965 of 996 facts across the
sessions measured here are `high`, and this session is 163 of 166 at `1.0`, with 3 at
`0.9`. The one session with `medium` facts (`01a14a46`, 31 at `0.5`) shows the model can
grade, it is simply not asked to grade importance. Consequence: the ranking collapses to
`createdAt`, so the pool behaves as "the newest `poolMaxTokens / 72` facts" and the
`medium`/`low` tiers are dead weight.

**A second judgement was tried and rejected.** The obvious repair is to ask the extract for
a property orthogonal to confidence — how long the fact stays true rather than how sure we
are of it — and derive relevance from that: `decision → high`, `state → medium`,
`detail → low`, where "detail" means the repository could tell you the same thing. Measured
on three real chunks (an implementation window, an audit report, and a session tail), two
wordings of the definitions, temperature 0, `llama-swap/hy-memory-30b-a3b`: 65 drafts, the
field present on **every** draft in both wordings, and **60 of 65 labelled `detail`**
(92 %). The two wordings agreed with each other on every chunk — 18/19 vs 15/16 `detail` on
the audit chunk, 14/15 vs 13/15 on the implementation chunk — so the variation tracks the
*content*, not the phrasing. Nothing to rank with: a bank where 92 % of facts are `detail`
evicts in recency order anyway, one layer of indirection later.

The reason is structural rather than a prompt bug: the extractor emits durable technical
facts by construction, so any property meaning "this is a technical fact" applies to nearly
all of them. A discriminating signal has to come from *cross-fact* evidence — which facts
the agent actually reads back through `hy_recall`, or which ones keep being restated and
retrieved as reconcile candidates — not from asking the writer to classify each fact in
isolation. That is not implemented; recency is the policy until something like it is.

### Retention

Per-session state is pruned on `session_start` (`pruneAfterDays`, default 30, `0` disables).
The pruner is age-based on file mtime, keys sessions by their `<sessionId>.<kind>` names, and
always keeps the running session plus the 10 newest — so a quiet week never deletes the bank a
session is about to resume from. Measured motivation: 92 sessions, 1.2 MB, no cleanup, because
the bank must be kept per session to stay a fold of the ledger.

## Compaction threshold — what the incumbents do

Both incumbents own the compaction decision and call `ctx.compact()` themselves, so their
threshold fires *before* pi's `contextWindow − reserveTokens` rule ever gets a chance.
They also both measure `rawTokensSinceLastCompaction(entries)` — an estimate over the
entries after the previous compaction's `firstKeptEntryId` — rather than pi's live
`contextTokens`.

**pi-observational-memory 3.1.4** (`src/config.ts`, `src/hooks/compaction-trigger.ts`):

| knob | default | meaning |
|---|---|---|
| `compactAfterTokens` | 81 000 | flat threshold |
| `compactAfterTokensMode` | `"calibrated"` | `"calibrated"` = the flat cap; `"ratio"` = fraction of the window |
| `compactAfterTokensRatio` | 0.68 | used only in `"ratio"` mode |

81 000 is the *package* default in `src/config.ts` (`DEFAULTS.compactAfterTokens`), and
`"calibrated"` is the default mode, so an install that never touches these settings still
compacts at a flat 81 000. The same number is what an extension writes into a user's
`settings.json` block, which makes it look like a local choice; the knob most users actually
change is the mode. Upstream states the trade-off in the same terms: the calibrated default
"preserves the pre-PR #40 compaction metric for typical ~128K–200K context models" and
"wastes most of the window" on a large-context one.

```js
resolveCompactAfterTokens(cfg, window) =
  cfg.mode === "ratio" && window ? max(1, floor(window * cfg.ratio)) : cfg.compactAfterTokens
```

It fires on `agent_settled` inside `setTimeout(0)`, re-checking `isIdle()` and the
threshold before calling `ctx.compact()`, guarded by `compactInFlight` and `passive`.

**pi-blackhole 0.5.x** (`src/om/model-budget.ts`) replaced both knobs with a four-tier
precedence — first valid tier wins:

1. `compactAfterTokens` — flat pin, always wins.
2. `compactAfterRatio` — `floor(window × ratio)`.
3. `compactReserveTokens` — `window − reserve`.
4. `compactAfterPreset` (default `"default"`) — a piecewise-linear curve over anchors
   `32 768 → 0.90`, `131 072 → 0.80`, `262 144 → 0.70`, `1 048 576 → 0.40`, constant
   extrapolation outside; user presets via `compactAfterPresets`.

The legacy `compactAfterTokensMode` / `compactAfterTokensRatio` keys are gone there — a
one-shot 0.5.2 migration notice nudges users off the flat pin, and the loader strips a
literal `81000` as scaffold residue.

### What the numbers say

| window | pi (`w − 16 384`) | OM flat 81 000 | OM ratio 0.68 | blackhole curve |
|---|---|---|---|---|
| 40 960 | 24 576 | 81 000 — **197 % of the window, can never fire** | 27 852 | 36 522 (0.892) |
| 128 000 | 111 616 | 81 000 | 87 040 | 102 800 (0.803) |
| 168 000 | 151 616 | 81 000 | 114 240 | 129 666 (0.772) |
| 262 144 | 245 760 | 81 000 | 178 257 | 183 500 (0.700) |
| 1 048 576 | 1 032 192 | 81 000 — **7.7 % of the window** | 713 031 | 419 430 (0.400) |

A flat cap is window-blind in both directions: the same 81 000 is a silent no-op on a
40 k model and a ~12×-per-window thrash on a 1 M model. A fixed ratio is window-blind in
the other direction — 0.68 of 1 M means summarising 713 k tokens, which is where LLM
summaries lose the middle. pi-blackhole's shrinking curve is the only one that treats a
big window as headroom rather than as a target.

### Why this extension has no threshold knob

We answer `session_before_compact` and never call `ctx.compact()`. Two reasons:

1. **The summary is bank-bounded, not history-bounded.** `renderMemory(bank,
   poolMaxTokens)` costs the same whether it replaces 40 k or 900 k of history, and it
   is model-free. The cost model that justifies a shrinking ratio for a
   model-summarising extension does not apply. Late compaction is cheaper for us, which
   is what pi's default already does.
2. **A ratio knob would be a second source of truth.** pi expresses any ratio per model
   as `compaction.modelOverrides[...].reserveTokens = (1 − r) × window`. A separate
   trigger means two thresholds that can disagree, producing either a double compaction
   or a summary rendered against a boundary the other party chose.

A ratio trigger is only worth adding for two things pi cannot express: a hard ceiling
(`min(r × window, N)`) and "never compact while a write is in flight". Neither is
justified until a session actually runs on a window where the ceiling matters.

### `poolMaxTokens` is window-relative

12 000 tokens of bank is 29 % of a 40 960 window, 7 % of 168 000, 4.6 % of 262 144 and
1.2 % of 1 048 576. The cap is per session, so a shared config should be sized for the
smallest window in use — or split per project.

## Cost model

Per dense chunk (484/486/503 scale), from the harness:

| | current observer (qfn, 1 turn) | Hy-Memory in a tool loop | this design (2 calls) |
|---|---|---|---|
| model calls | 1 | 12 | 2 |
| input tokens | 27–33 k | 296–350 k | extract ≈ chunk (13–33 k) + reconcile ≈ 1–3 k |
| wall | 28–127 s | 240–889 s | measured in the PoC run below |
| compaction | model call or fold | fold | fold (unchanged) |

The extract call is the cost, and it is unavoidable for any writer model. The reconcile
call is small because retrieval keeps the shown bank at ≤12 entries.

## Status

`src/` is the full extension: the write path above, wired into pi in `src/index.ts`
(`turn_end` trigger, `agent_before_settle` write wait, `session_before_compact` fold,
`session_shutdown`, `pi.appendEntry`, the `hy_recall` tool, the `/hy` command, the
footer bar). The harnesses in `dev/` replay the four real captured observer chunks
through the same `writeChunk` path the extension uses. Run from the repository root:

```bash
npx tsx dev/poc.ts && npx tsx dev/export-judge.ts
```

Measured on the four captures, four sequential chunks building one bank:

| chunk | chunk entries | drafts | bank shown | ADD | UPDATE | DELETE | rejected ops | in tok | out tok | wall | active |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 482 | 17 | 14 | 0 | 14 | 0 | 0 | 0 | 12 613 | 2 622 | 32.4 s | 14 |
| 484 | 33 | 10 | 12 | 10 | 0 | 0 | 0 | 28 778 | 1 552 | 31.6 s | 24 |
| 486 | 52 | 10 | 12 | 6 | 4 | 0 | 0 | 24 133 | 1 601 | 28.4 s | 30 |
| 503 | 60 | 21 | 12 | 18 | 3 | 0 | 0 | 26 577 | 3 326 | 51.8 s | 48 |

Bank after four chunks: 55 entries, **48 active, 3 330 tokens, 0 ungrounded**, and re-folding
the ledger reproduces exactly those 48. The reconcile call is the cheap one the design
predicted: 2.2–5.2 s and 1–3 k input tokens per chunk, against 25–48 s for the extract call.

Against the same model under the tool protocol at `temp 0`:

| chunk | tool protocol | bank protocol |
|---|---|---|
| 482 | 0 observations, 20 s | 14 facts, 32.4 s |
| 484 | 18 recorded, 90 duplicates, 350 436 in tok, 240 s | 10 bank writes, 28 778 in tok, 31.6 s |
| 486 | 18 recorded, 80 duplicates, 296 700 in tok, 248 s | 10 bank writes, 24 133 in tok, 28.4 s |
| 503 | 39 recorded, 340 duplicates, 315 264 in tok, 889 s | 21 bank writes, 26 577 in tok, 51.8 s |

## Findings the first run produced

1. **The model copies rendered labels, not ids.** Its first UPDATE targets were
   `"target": "[9f1a07bd7a8e] (llama-swap local instance API endpoints)"` — the whole
   rendered bank line. Four drafts were lost. Bank entries are now rendered
   `<id>9f1a07bd7a8e</id> (task) statement`, the prompt says *id only*, and `extractId()`
   recovers the id from either form. Second run: **0 rejected ops, 0 omitted drafts**.
2. **UPDATE is the interesting operation.** On 486 and 503 the model superseded older
   entries with better ones — e.g. it replaced "llama-swap supports qwen35-9b-summar…" with
   the entry that says reasoning is off by default because thinking burns the token budget,
   and replaced a stale observer-config fact with the current model + fallback + timeout
   configuration. That is the trained behaviour, and it is what a memory bank needs.
3. **Secrets get written.** The model recorded `apiKey sk-...` from tool output.
   Sanitizing now masks `sk-…`/`token…`/`Bearer …` before the fact reaches the bank.
4. **Chunks contain meta-text.** Chunk 482 includes the *previous observer's own system
   prompt*, and the model dutifully recorded it as a fact about pi-blackhole. A production
   serializer should drop system/developer text from the source chunk.
5. **Statements are long.** The model writes dense, comma-packed facts (up to the 420-char
   cap). Good for durability, worse for the token budget than the incumbent's one-liners —
   3 330 tokens for 48 facts. The pool cap and `enforceBudget` are what keep that bounded.

Results and judge verdicts are in `RESULTS.md`.

## Not yet proven

1. **Bank quality vs the incumbent's memory.** The PoC produces a bank; whether those
   facts beat `qfn-coder-llamacpp`'s observations after 20 chunks needs the same judge
   treatment the harness already applies.
2. **UPDATE/DELETE behaviour at scale.** With 12 candidates shown, does the model still
   pick the right target once the bank has hundreds of entries? Retrieval quality becomes
   the limiting factor, not the model.
3. **Retrieval is lexical.** `candidatesPerDraft()` uses token overlap. A real embedding index
   (the upstream Hy-Memory harness uses one) would retrieve better; lexical is the honest
   starting point for a local-first extension.
4. **Compaction takeover at scale.** `dev/compact-test.py` exercises
   `session_before_compact` in a real RPC session, but at n=1; sessions that compact
   repeatedly with a live bank are not yet measured.
