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
## What the writer was trained to do

The model has a paper: *Hy-Memory-30B-A3B: Attributed Reinforcement Learning for Long-Term
Memory Writing* (arXiv 2610.22196). It is worth reading as a specification, because it says
which prompts the model has actually seen and which failures it was rewarded on.

- **It is a writer inside harnesses.** Training puts the model behind the unmodified Mem0,
  MemOS and Hy-Memory (Chat / Working / Coding) write paths and rewards the *downstream
  answerability* of the bank it produces: on-policy distillation from a flagship teacher onto
  bank states the student itself wrote, then chunk-level GRPO over eight rollouts per window.
  The reader and judge are frozen, so the bank is the only thing that can improve.
- **A chunk is about ten turns.** OPD prompt budget 4 096 tokens; RL context 28 672 prompt +
  4 096 response. A chunk never crosses a session boundary, and a window is up to five
  chunks with the bank carried forward — the shape this extension already had.
- **The failure surfaces it was rewarded on** are omission, lost specificity, semantic
  inversion, stale-state confusion, secondary-fact loss and over-storage. Two are already
  our own rules: an UPDATE must restate everything still true (secondary-fact loss), and the
  op vocabulary is ADD / UPDATE / DELETE (+ SKIP) as in Mem0 (over-storage).
- **Selectivity is behavioural, not self-reported.** Trap probes (facts that must *not* enter
  the bank) plus a token-based bank-growth penalty teach it; the trained schema has no
  confidence field and no self-graded durability label.
- **Less context makes facts more specific.** Their annotation study, on identical chunks,
  found two-chunk context produced 25 % more proper nouns and 59 % more numbers per extracted
  fact than full history: with everything in view, attention spreads and facts go generic.
  This is the one axis where our defaults may sit outside the training distribution.

What follows for us: the two prompts are the entire model-facing surface, so they have to
resemble the harness prompts the writer was trained on and must not ask for fields it never
learned to emit. Both were wrong at some point; the measurements are recorded below.

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
| dropper agent (pool pressure → drop list) | `enforceBudget()`: rank by recency, supersede the tail. Deterministic, auditable, free. |
| coverage tiers (`none` / `partial` / `strong`) annotated per observation | not needed: the bank shown to the reconcile call *is* the coverage question. |
| tool schema + `record_observations` handshake | none. The model is never offered a tool it measurably refuses to call. |

## Architecture

```
turn_end
  ├─ due? raw source tokens since last hy.extract watermark ≥ observeAfterTokens
  ├─ serialize chunk      [Source entry id: 3334369c]  ->  [7]      (ids hidden from model)
  ├─ 1) extract           chunk -> drafts JSON          (temp 0, no_think, no tools)
  ├─ retrieve             per draft: best bank entries by lexical overlap; shown set is
  │                        every draft's best match first, then round-robin, cap 12; a draft
  │                        with no match is marked "bank consulted: no matching entries"
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

**Every draft gets its own candidates.** The reconcile call is shown at most
`candidateLimit` bank entries, and the original selection was the score-sorted union of every
draft's matches — so a draft whose matches fell outside the cap arrived blind and became an
unconditional ADD. Measured on a 12-chunk extended corpus: **38 of 185 drafts (20.5 %)
starved**. `candidateRenderMode: "perDraft"` (the default) shows each draft's best match
first, fills the remaining slots round-robin, and marks drafts with no match at all
explicitly. Starved drafts 20.5 % → **2.2 %**, reconcile input tokens −6.5 %, and the blind
judge found no regression (zero unsupported writes, noise inside seed variance). What was
left was pure cap arithmetic — chunk 016 had 27 candidate-bearing drafts for 12 slots — so
`candidateLimit` is now **24**: replaying that ledger at 24 starves none (16 → 1, 24 → 0 of
179) for ~770 more shown tokens per chunk (+24 % reconcile input), and a live 6-chunk A/B on
the same prompt moved UPDATEs 9 → 11 with the bank slightly smaller (77/5 979 → 75/5 869
tokens). `union` remains selectable. SKIP is in the vocabulary but dormant: the plumbing is
verified by `tools/skip-op-check.ts`, and the model used it **zero times** in any arm at
temperature 0.

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

**A failure backs off across turns.** `lastFailed` (src/chain.ts) stops a *chain* from
following a failure, but the trigger still fires once per `turn_end`: with a dead proxy and a
session producing turns every few seconds that was **508 attempts in 37 minutes** (measured
on `01a1510e`, 2026-10-19). `writeCooldownMs` waits `writeCooldownS` (30 s) after the first
failure, doubles per consecutive failure, caps at 10 minutes, and any success clears it —
`write_cooldown { waitS }` once per failure, `write_deferred` once per skipped episode. The
trigger checks the deadline before measuring the window, so a down writer costs a handful of
requests per outage instead of one per turn.

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
            "refs":[7,9]}]}
```

Code rejects a draft when: statement < 24 chars after sanitizing, no `refs` inside the
chunk's ref range, or the statement duplicates one already accepted. The schema is the
model's own: `task`, `statement`, `keys`, `refs`, nothing else. A `confidence` field and the
`relevance` tier derived from it used to sit here, and both are now gone — the writer was
never trained to emit either (see *Ranking*).

**2. Reconcile.** Only the retrieved candidates are shown, never the whole bank:

```json
{"ops":[{"action":"ADD","draft":0},
        {"action":"UPDATE","draft":3,"target":"4f2a9c1b7d33","reason":"model swapped from swift to qfn"},
        {"action":"DELETE","target":"9a01c4de22f7","reason":"endpoint deprecated in this chunk"}]}
```

Code rejects an op when: `draft` index out of range or already used, `target` not a valid
id **in the shown set**, or the action is unknown. A rejected op never corrupts the bank;
it is counted and logged.

**2b. Malformed output is repaired before it is allowed to fail.** Two shapes have been
measured in production, and both are nearly-valid JSON rather than a wrong answer:

- a regex copied verbatim into a statement — `"… /^[\s]*(\d+)[\s]*(?:px)?[\s]*$/ …"` —
  where `\s` and `\d` are not legal JSON escapes (chunk 003, `Bad escaped character …
  position 4825`, six of them in one extract);
- a stray quote closing a numeric field, `"draft":5"` (chunk 005, which then failed three
  times because the retry resumed the same persisted drafts and produced the same string).

`repairJson` runs **only after** a strict parse has failed, so valid output is never
rewritten; it fixes those two classes and nothing else, and the repair is logged on the
ledger record (`repaired`) and in the audit. If the output is still unparseable the stage is
re-asked **once**, with the parse error appended to the request (`retriedJson`), because a
blind retry reproduces a deterministic malformation. Anything else still fails the write.

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

`bankMaxTokens` caps the *active* bank, not the ledger. After every write
`enforceBudget()` sums the active entries' `tokenCount` and, if the total exceeds the
ceiling, ranks and trims:

1. **Rank by `createdAt`, newest first.** Not insertion order: a stable sort over insertion
   order dropped the *newest* facts — measured on session 01a14c10, four of them real
   implementation facts (`disconnect()` no longer clearing `attemptSeqByProfile`, the
   `settle(attempt)` helper, …). A memory that tracks current state must prefer the newer
   entry, and there is nothing else to rank by (see *Ranking*).
2. **Keep what fits** — a bin-packing walk, not a tail cut, so one long fact does not
   evict three short ones.
3. **Tombstone the rest**: `status: "superseded"`, `supersedeReason: "bank budget"`.

A budget-dropped fact is **hidden but not lost**: it stays in the bank file and in the
ledger, `hy_recall <id>` still returns it with its source evidence, but it is absent from
`renderMemory()` (so not in the compaction summary) and it is not a candidate for a later
UPDATE (only `active` entries are). It can only come back if a newer chunk re-states it,
which creates a new entry rather than reviving the old one. Each write now reports
`budgetDropped` (count and the first five ids) so eviction is visible in the audit
instead of silent.

Sizing, measured on this writer: a fact costs ~72 tokens (`tokenCount`), so the cap is
roughly `summaryMaxTokens / 72` facts — 6 000 ≈ 83, 8 000 ≈ 110. Two real sessions
reached 4 968 and 4 985 tokens, i.e. both were evicting facts at the default, which is
why the shipped config raises it. The cost of a larger pool is prompt size only: the
compaction summary is `renderMemory(bank, summaryMaxTokens)`, a string build with no model
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
and reloading restored all 22 facts that had been evicted as `bank budget` in session
`01a14c10` (69 → 91 active). Eviction therefore behaves as pressure, not deletion — it is
re-applied at the next write against whatever cap is current, and the ledger stays a pure
history of what the writer decided. `loadState` therefore re-applies `enforceBudget`
straight after folding and audits `budget_reapplied`, so a reload cannot leave the bank,
the footer bar or the summary above the current cap (`tools/reload-budget-check.ts`).

**The summary budget adds the real prefixes to the pool.** `enforceBudget` counts fact text (`tokenCount`);
a rendered line adds `[id] (task) `, measured at +14.2 tokens per fact on a 91-fact
session (7 953 rendered / 6 659 counted = 1.19x). Rendering a full pool at the pool number
drops facts for overhead the pool never counted. A constant multiplier
would break again as soon as task labels run long, so `summaryBudget(summaryMaxTokens, bank)`
sums the actual `[id] (task) ` prefixes for this bank (+630 tokens for 60 facts in
`tools/reload-budget-check.ts`), and `renderMemory` reports what it omitted instead of
truncating silently. Measured on the real banks: 12 000 tokens of bank ≈ 161 facts ≈
14 300 summary tokens ≈ 8.5 % of a 168 000 window.

**When it cannot be faithful, compaction goes back to pi.** Our summary replaces pi's
model call, and the boundary can only *hold back* a bounded backlog (`maxChunkTokens`).
Past that bound the old code accepted pi's cut and recorded a `hy.gap`, which was the wrong
trade: the entries were gone from the live context and no chunk had ever read them. Measured
on `01a1510e` (2026-10-19), a 36-minute writer outage (502 from the proxy) left 477 unread
entries, the boundary took pi's cut, and **53 459 tokens of history were dropped unread**.
The hook now returns `undefined` in that case, so pi summarises the prefix with its own
model — information compressed into prose rather than lost, exactly as it would be without
the extension — and audits `compact_deferred { entries, tokens }`. A free summary is worth
having only while it is faithful; when it is not, one model call is the cheaper mistake.
`hy.gap` remains for the `/hy off` switch, where discarding the off window is the point.

**Admission order decides which facts survive the summary.** Facts are admitted
newest-first: the newest fact that fits wins, and the oldest are the ones omitted — the same
rule `enforceBudget` uses. Chronological admission did the opposite, so the *first* N facts
were kept and the newest were dropped; on session `01a1510e` (2026-10-19) the single omitted
fact was the newest in the bank, from the final write, while the summary header tells the
model that the later of two conflicting lines is the current state. Lines are printed
chronologically afterwards, so the newest fact is the last line read. Omission is a
bin-packing skip (a fact too large for the remaining budget is passed over, not fatal), and
what was omitted is counted in the tail and reachable through `hy_recall`.

### The bank is a store; the summary is a selection

One number, `poolMaxTokens`, has been doing three jobs at once: the size of the compaction
summary, the set of entries a later write may UPDATE, and the eviction threshold. Welding them
together makes "the summary only fits 84 facts" mean "the bank may only *have* 84 facts", and
on a long session the memory degrades into a tail. Measured on the longest production session
(32 chunks, 408 facts written):

| quantity | value |
|---|---|
| active bank at the end | 408 facts / 29 357 tokens |
| summary budget (old `poolMaxTokens`) | 6 000 tokens ≈ 84 facts |
| age of the oldest fact that summary keeps | **7 chunks** (84 facts) |
| the same 6 000-token cap, stratified selection (below) | oldest kept: **20 chunks** (122 facts) |
| the shipped 8 000-token cap, stratified | oldest kept: 12 chunks (142 facts) — a larger budget spends more of itself on current state, by design |

29 k of facts is nothing for a 168 k window: the summary is small, not the bank. So the two
are separated:

- **`bankMaxTokens`** (default **60 000**) is the store's ceiling, and the only thing
  `enforceBudget` trims to. Most sessions never reach it: the 32-chunk session above ended at
  half of it.
- **`summaryMaxTokens`** (default **8 000**) is what `renderMemory` fills at compaction time.
  The summary is a *selection over the bank*, not a copy of its tail.
- **Candidate retrieval** keeps using the whole active bank, bounded per call by
  `candidateLimit`, so reconcile cost does not move.

Cost: a larger bank file and a longer fold, both linear (29 k tokens of facts ≈ 120 KB of
text here), and nothing per write. The price is that lexical retrieval now has more entries to
choose between — and it already misses (93 of 109 removal-bearing drafts failed to retrieve
the entry they contradict). A bigger store raises the value of fixing retrieval; that is why
key-exact scoring is in the same plan rather than "later".

### What the summary prints when it cannot print everything

Recency is a poor summary rank on a long session: it prints the last few hours of churn and
drops the decisions the session is built on. A model judgement cannot fix that (measured
twice, see *Ranking*), so the selection is stratified in code. Three slices, filled in this
order, each newest-first, never duplicated:

1. **Constraints** — facts whose source entries were user turns (`summaryConstraintShare`,
   10 %). Cheap (2 of 408 here) and the class the judge values most.
2. **Foundations** — active facts older than `foundationAfterChunks` (default 8) that were
   never superseded (35 %). Old survivors are not proof of durability, but they are the best
   deterministic proxy available: 303 of the 408 were never superseded, so this slice is
   about *age*, not about survival alone.
3. **Current state** — everything else, newest first (the rest).

Shares are budgets, and unused budget spills forward, so a session with no user-stated facts
still fills the summary. Admission is a bin-packing walk inside each slice (one long fact does
not block three short ones), and the omission tail still reports the total.

The *display* is a different split from the selection: facts are printed under `## Current
state` (younger than `foundationAfterChunks`) and then `## Earlier`, chronological inside each,
so the reader gets live state before history. A compaction also appends pi's deterministic
`<read-files>` / `<modified-files>` block, computed from `read` / `write` / `edit` tool calls
(bounded to 40 paths per list) out of the same budget.

The measurement that justifies it is the one above: same 6 000-token cap, reach 7 → 20 chunks,
122 facts instead of 84. Whether that is *better* is a judge question, not a count, and that
gate has not run yet: the blind judge needs the LAN endpoint, which was down for this pass.
Until it does, the count is the whole evidence.

One caveat about the constraint slice: `fromUser` is recorded on the draft at write time, so
ledgers written before the split have it as `false` and the slice is inert for them. New
writes fill it; a re-folded old bank keeps working with the other two slices.

### When the store itself is full

`bankMaxTokens` is a ceiling, not a target, so "full" is rare — but at ~900 tokens of facts
per chunk a 200-chunk session carries ~180 k and will hit it. In order of preference:

1. **Demote.** A fact past the summary budget stays active and retrievable; it is simply not
   printed. This is already what the omission tail promises, and it costs nothing.
2. **Consolidate.** When the store passes its ceiling, one extra call merges the oldest
   fragments into fewer, denser facts. It is close to the writer's trained task (bank
   updates), but it aims straight at its worst failure surface — lost specificity — so it is
   an experiment with a judge gate, not an assumption.
3. **Evict.** Today's rule, kept as the last resort: deterministic, visible in the audit, and
   the fact stays recallable. When it does fire, it should record `hy.evict` so a reload
   cannot change what the reader saw.

### Plan

| step | change | gate | status |
|---|---|---|---|
| 1 | split `bankMaxTokens` / `summaryMaxTokens`; the summary becomes a selection | oldest kept moves 7 → 20+ chunks on the 32-chunk ledger; no regression on current state | shipped |
| 2 | stratify the selection: constraints / foundations / current | reach 7 → 20 chunks at the same cap; blind judge still pending | shipped |
| 3 | key-exact retrieval ranking | fewer misses on removal drafts than 93/109 | rejected (measured 725 → 730 subject matches, 7 gained / 2 lost) |
| 4 | durable `hy.evict` when the ceiling bites | a reload cannot change the rendered summary | planned |
| 5 | consolidation pass at the ceiling | judge specificity does not fall | later |

### Ranking

There is no relevance tier. There used to be one, derived from a `confidence` field the
extract prompt asked for, and it was removed after two measurements and one paper:

- **Confidence saturates, so the tier did too.** `relevanceOf(confidence ≥ 0.8)` → `high`,
  and the prompt asked for explicitness ("how sure you are that the fact is explicitly
  established") after already telling the model to extract only what the chunk explicitly
  establishes. Result: 965 of 996 facts `high`, one session 163 of 166 at exactly `1.0`. The
  one session with `medium` facts (`01a14a46`, 31 at `0.5`) shows the model *can* grade; it
  is simply not being asked to grade importance. So the rank collapsed to `createdAt` in
  practice and the pool already behaved as "the newest `summaryMaxTokens / 72` facts".
- **A second judgement was tried and rejected.** The obvious repair is a property orthogonal
  to confidence — how long the fact stays true, `decision → high` / `state → medium` /
  `detail → low`, where "detail" means the repository could tell you the same thing.
  Measured on three real chunks (an implementation window, an audit report, a session tail),
  two wordings, temperature 0, `llama-swap/hy-memory-30b-a3b`: 65 drafts, the field present
  on **every** draft, and **60 of 65 labelled `detail`** (92 %). Both wordings agreed on
  every chunk (18/19 vs 15/16 on the audit chunk), so the variation tracks the content, not
  the phrasing.
- **The writer was never trained to grade its own output.** The paper's reward is
  behavioural: trap probes for facts that must not be stored, and a token-growth penalty for
  storing too much. Selectivity is a property of *what it chooses to write*, not a number it
  can attach to a draft it already decided to write.

The reason is structural rather than a prompt bug: the extractor emits durable technical facts
by construction, so any property meaning "this is a technical fact" applies to nearly all of
them. A discriminating signal has to come from *cross-fact* evidence — which facts the agent
reads back through `hy_recall`, or which ones keep being restated and retrieved as reconcile
candidates — not from asking the writer to classify each fact in isolation. That is not
implemented, so `BankEntry` has no ranking field at all: `enforceBudget` and `renderMemory`
sort by `createdAt`, and recency is the policy until something like it exists.

### Retention

Per-session state is pruned on `session_start` (`pruneAfterDays`, default 30, `0` disables).
The pruner is age-based on file mtime, keys sessions by their `<sessionId>.<kind>` names, and
always keeps the running session plus the 10 newest — so a quiet week never deletes the bank a
session is about to resume from. Measured motivation: 92 sessions, 1.2 MB, no cleanup, because
the bank must be kept per session to stay a fold of the ledger.

## What pi's own compaction does

Worth reading before claiming to replace it (`pi-coding-agent/dist/core/compaction/`). It is
not "summarise the history"; it is a checkpoint protocol.

| part | pi |
|---|---|
| trigger | `contextTokens > contextWindow − reserveTokens` (reserve 16 384) |
| cut | keep `keepRecentTokens` (20 000), walking back from the end and snapping to a turn boundary; a mid-turn cut summarises the turn prefix separately and appends it as `**Turn Context (split turn):**` |
| call | one `completeSimple`, `maxTokens = min(0.8 × reserve, model max)` ≈ 13 107. System prompt: "You are a context summarization assistant … Do NOT continue the conversation." |
| shape | seven fixed sections: **Goal, Constraints & Preferences, Progress (Done / In Progress / Blocked), Key Decisions, Next Steps, Critical Context**, with "preserve exact file paths, function names, and error messages" |
| incrementality | with a previous summary present the call receives `<previous-summary>` plus only the new messages, under an update prompt: "PRESERVE all existing information … move In Progress → Done … if something is no longer relevant, you may remove it" |
| deterministic extras | `<read-files>` / `<modified-files>` extracted from `read` / `write` / `edit` tool calls — no model involved |
| input hygiene | conversation serialised to text, tool results truncated to 2 000 chars, **thinking omitted**, so the request cannot exceed the context it summarises |
| failure policy | `finish_reason=length` is an error — a truncated summary is never persisted; a tool call in the answer is an error; retries via `retryAssistantCall`, `cacheRetention: "none"` |

**Where pi is ahead, and we adopted it.** *Orientation*: Goal / In Progress / Next Steps /
Blocked is what a continuation actually needs, and a list of facts does not say what the
session is doing. So the render now labels age groups — `## Current state` then `## Earlier`,
newest first, chronological inside each — and carries the same `<read-files>` /
`<modified-files>` block, computed from the same tool calls, out of the summary budget rather
than added on top of it. `fileOperations()` in `src/entries.ts` is a straight re-implementation
because pi's extractor is internal to its compaction module.

**Where we are ahead, and pi cannot follow without giving up its design.** *Fidelity*: every
line carries a 12-hex id and a `hy_recall` path, so a summary claim is attributable and
auditable; pi's prose is neither. *Conflict handling*: our bank supersedes (UPDATE / DELETE
chains), so "when two lines conflict the later wins" is a structural fact; pi's "PRESERVE all
existing information" is precisely how a summary accretes stale claims — the stale-state
confusion failure we measure. *Cost*: no call at all, so a compaction can never fail, block, or
bill. *Input*: pi re-reads the cut history (up to ~150 k tokens); we read the bank (29 k in the
longest measured session).

**What "better" would have to mean.** Not "more prose": the three arms have to be judged at a
real boundary — pi's summary, our render, and a hi-fi summary — on the axes that fail first in
long sessions: constraints from the first third, current state, and transitions. Expect pi to
win orientation and lose transitions; anything we ship has to beat it on both.

### Hi-fi compaction (built, off by default)

`src/hifi.ts`, `hifiCompaction: false`. The shape is pi's checkpoint protocol; the material is
ours:

- **Sections from pi, material from the bank.** Goal / Constraints & preferences / Progress /
  Key decisions / Next steps / Critical context. Constraints are not re-derived from the
  transcript: every user-stated fact is re-offered at every boundary however old it is,
  because a constraint that drops out of a checkpoint is a constraint the model breaks later.
- **Input is a delta, not the history.** The previous checkpoint, the facts newer than it, the
  kept tail (the *newest* entries that fit `hifiTailTokens` — `selectTail`, because a tail is
  read for orientation and `serializeEntries` deliberately keeps the oldest for coverage
  contiguity), and the file lists. Measured on a 6 110-entry session: a request of a few
  thousand tokens against a branch of ~150 k.
- **Self-healing delta.** A fact is sent if it is new, or user-stated, or *absent from the
  previous checkpoint*. That third condition is what stops a weak summary from silently
  deleting a fact for the rest of the session: the next boundary offers it again.
- **Attribution survives.** The prompt requires an id on every line that came from a fact and
  forbids inventing ids; `checkHifi` counts the ids that survived, and an answer that cites
  none is rejected.
- **pi's failure rules, then our fallback.** `stopReason: "length"`, a provider error, an empty
  answer, a missing section, or no surviving id is a *failure*, not a shorter summary — the
  audit records which (`hifi_ok` / `hifi_rejected` / `hifi_failed`) and the deterministic
  render is used instead. `summaryKind` in the `compact` audit says which path produced the
  persisted summary, so the two paths stay comparable in the same log.
- **Never the writer model.** `ctx.model` — the executor's own model. The writer is forbidden
  from grading its own output, and a summary is grading.

- **Reasoning is off for the checkpoint, and the model entry must say how.** Reasoning and the
  answer share one output budget. Measured on a quantised Qwen build: inheriting the session's
  thinking level produced 2 000 output tokens, one `thinking` block and no answer — repeatedly,
  and again at 6 000. `hifiThinkingLevel` defaults to `off`, but pi only sends a reasoning field
  when the model entry names the switch *that server* understands:
  `compat.thinkingFormat: "qwen-chat-template"` (→ `chat_template_kwargs.enable_thinking: false`)
  and `thinkingLevelMap: { off: "none" }` (→ `reasoning_effort: "none"`) both produced real
  checkpoints; a top-level `enable_thinking: false` was ignored. `hifiMaxTokens` is 4 000 because
  2 000 truncated a good 1 508-token answer.
Off by default for the reason the feature exists: it puts a model call at the slowest moment in
the session. It is the same cost class as vanilla pi, which makes exactly such a call, but it is
not free the way the render is. `/hy-memory hifi` toggles it per session so the comparison can
be made on real work rather than in the abstract.

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
   summaryMaxTokens)` costs the same whether it replaces 40 k or 900 k of history, and it
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

### `summaryMaxTokens` is window-relative

8 000 tokens of summary is 20 % of a 40 960 window, 4.8 % of 168 000, 3 % of 262 144 and
0.8 % of 1 048 576 — and it is a *selection* out of a bank that can be an order of magnitude
larger, so a shared config sized for the smallest window in use is still the right rule, just
against a smaller number than before. The store ceiling (`bankMaxTokens`) is not
window-relative at all: it costs nothing per call.

## Cost model

Per dense chunk (484/486/503 scale), from the harness:

| | current observer (qfn, 1 turn) | Hy-Memory in a tool loop | this design (2 calls) |
|---|---|---|---|
| model calls | 1 | 12 | 2 |
| input tokens | 27–33 k | 296–350 k | extract ≈ chunk (13–33 k) + reconcile ≈ 1–3 k |
| wall | 28–127 s | 240–889 s | measured in the PoC run below |
| compaction | model call or fold | fold | fold (unchanged) |

The extract call is the cost, and it is unavoidable for any writer model. The reconcile
call is small because retrieval keeps the shown bank at ≤12 entries. Measured on one chunk
(10.9 k-token window, 5.5 k-token extract call) the token counts are identical across routes
and only wall time differs: **local `hy-memory-30b-a3b` 30.3 s, `remote/hy-memory-30b-a3b`
137 s** — 4–5× on the same payload, so a 5-chunk corpus is ~4 min local and ~18 min through
the proxy.

### Chunk size

The paper's chunk is "about ten turns" with a 4 096-token OPD prompt budget, and its own
annotation study found *less* context produces more specific facts. Our captures carry the
same number of turns but **13–24 k tokens**, so `maxChunkTokens: 24000` was the one setting
outside the training distribution. Measured with `dev/split-chunk.ts` (extract-only arm, three
captures, the same prompt and route — the remote writer endpoint, both LAN instances being
down that day — one whole chunk versus the same text split at entry boundaries into
~4 500-token windows):

| | full chunk | split windows |
|---|---|---|
| captures | 006 / 007 / 012 (17.9–20.1 k tokens each) | 5 windows each |
| facts | 41 | **120 (2.9×)** |
| specific anchors per fact | 6.45 | 5.98 |
| numbers per fact | 2.84 | 2.25 |
| total numbers | 120 | **267** |
| generic facts | 3 % | 2 % |
| input tokens | 66 578 | 70 082 (+5 %) |
| output tokens | 5 062 | 13 990 |
| wall | 359 s | **158 s** |
| full-arm facts also stated by the split arm | — | 33 of 41 (80 %) |

Per-fact density drops slightly — that is the honest cost, and it is the opposite direction
from the paper's annotation result — but the *total* specific content rises 2.2–2.7×, the
input cost is flat, and the split arm is twice as real-time because five small prefills beat
one 20 k one. It is not a superset: a fifth of the wide-window facts (cross-window decisions,
mostly) are not re-found, so the two arms read the same history differently rather than
better and worse.

Since the judge's misses are coverage-flavoured (~6 durable facts per chunk), coverage wins:
`maxChunkTokens` is now **`6000`**, which makes the shipped chunk the size the split arm
tested. A window larger than that is written in consecutive chunks, oldest entries first, and
the chain drains the backlog (≤2 per turn) — the same mechanism that already bounded a
backlog, so no new state is needed.

### Transport is a measured variable

A writer that serves 20 k-token extracts over a proxy is a distributed system, and three of
its failures were ours to fix (all in `EXPERIMENTS.md` with sources):

- **Node's undici aborts a long HTTP/2 wait at 300 s** (`headersTimeout`), and a
  non-streaming llama.cpp response sends headers only when generation completes. That hidden
  cap — not our 600 s timeout — killed every remote extract over five minutes; chunk 016 failed
  three times before the cap was raised on the dispatcher. `dev/raw-writer.ts` now sets
  `headersTimeout`/`bodyTimeout` from the call timeout. **pi's own completions path rides the
  same fetch stack**, so a production extract over 300 s may hit it too; that is an open
  question, not a fixed one.
- **A wedged llama-server is permanent.** llama-server does not cancel generation when the
  client disconnects, so abandoned requests hold context slots until exhaustion, and on
  AMD/RDNA-class backends a client abort while another request is in flight deadlocks the
  whole server — `/health` dies too and SIGTERM is ignored. Only SIGKILL recovers it, and
  llama-swap's own defenses are startup-only. `ops/llama-watchdog` is a systemd timer that
  probes the server directly (health + tiny completion, bypassing the proxy queue) and
  SIGKILLs a wedged instance, busy-safe: a server answering through the proxy mid-decode is
  never killed.
- **A client-side abort leaves work behind.** llama-swap keeps processing the abandoned
  request, so an immediate retry collides with it (`429 concurrency_limit`); the runner backs
  off 45 s between attempts, and the production path classifies the failure before it shrinks
  anything (`src/failures.ts`).

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


## Measured arms

Two runs on the 12-chunk extended corpus, local writer, temp 0, judge blind and per-op
(`dev/judge.ts` + `dev/rubric.md`; seeds 7 and 11; the writer is never the judge):

| axis | baseline s7 / s11 | perDraft s7 / s11 |
|---|---|---|
| ops | 182 / 182 | 177 / 177 |
| supported full / partial / unsupported | 138/44/0 · 124/48/0 | 133/44/0 · 130/47/0 |
| durable / marginal / noise | 119/36/27 · 109/33/30 | 112/27/38 · 119/30/28 |
| mean specificity | 2.79 / 2.61 | 2.81 / 2.76 |
| missed durable facts | 102 / 100 | 100 / 93 |

Zero unsupported writes in every pass. The seed-7 noise bump (+11) was disproven by seed 11
(−2): noise seed variance on this axis (±10) dominates the arm difference. The row that
shapes what comes next is the last: **the bank misses ~6 durable facts per chunk**, and the
judge's misses concentrate on constraints and metrics stated inside tool output rather than in
user turns. Coverage, not precision, is the failure mode. The earlier 5-chunk `baseline-remote`
run agrees from the other side: 63 drafts produced **62 ADDs, 1 UPDATE, 0 DELETEs**, and 40 %
of drafts found zero candidates at a 26-entry bank — a bank that can only grow, on a corpus
that held few supersessions.

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

1. **Bank quality vs the incumbent's memory, end to end.** The arms above judge the bank the
   writer produced; whether the compaction summary built from it beats
   `qfn-coder-llamacpp`'s observations *in a real session* still needs the same judge
   treatment applied to what the reader model actually sees.
2. **DELETE never fires.** Across the 5-chunk baseline and both 12-chunk arms the model wrote
   exactly one UPDATE per run and zero DELETEs: reconciliation in practice means "ADD a newer
   statement", which the supersede chain absorbs. Whether that is the corpus (few
   supersessions in a coding session) or the writer's bias at temperature 0 is unresolved.
3. **Retrieval is lexical.** `candidatesPerDraft()` uses token overlap; a draft whose wording
   does not share tokens with the entry that should be superseded retrieves nothing and
   becomes an ADD. A real embedding index (the upstream Hy-Memory harness uses one) would
   retrieve better; lexical is the honest starting point for a local-first extension.
4. **The 6 000-token default is measured extract-only.** The split-window arm compares what
   the writer *saw*, not what the bank kept: a corpus run at `maxChunkTokens: 6000` (with its
   reconcile calls and backlog draining) is not yet done, and it is the run that would show
   whether narrower chunks cost updates — each write sees a smaller slice of a transition.
5. **Compaction takeover at scale.** `dev/compact-test.py` exercises
   `session_before_compact` in a real RPC session, but at n=1; sessions that compact
   repeatedly with a live bank are not yet measured.
