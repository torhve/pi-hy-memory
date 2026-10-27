# Notes — what `billion-context-pi` (ACP) offers `pi-hy-memory`, and which system wins

Untracked scratch file. Read 2026-10-21 against this repo at HEAD `d943b3b`.
Sources:

- ACP README — <https://github.com/ranxianglei/billion-context-pi>
- ACP config reference — <https://github.com/ranxianglei/billion-context-pi/blob/master/CONFIGURATION.md>
- ACP sidecar contract — <https://github.com/ranxianglei/billion-context-pi/blob/master/schema/bcp-block-v1.json>
- pi extension API — `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
- pi-ai usage type — `node_modules/@earendil-works/pi-ai/dist/types.d.ts:279`
- this repo — `README.md`, `DESIGN.md`, the local task list (`TODO.md`, untracked scratch), `src/index.ts`, `src/chain.ts`, `src/serialize.ts`

## The one fact that dominates the comparison

ACP **cancels pi's built-in auto-compaction** and becomes the sole context manager
(`enabled: false` restores pi's behaviour). pi-hy-memory's only channel into the model's
context is `session_before_compact` (`src/index.ts:953`). Installed together, that hook never
fires: the bank keeps being written (two paid calls per chunk) and never gets read, except by
`hy_recall` if the model happens to think of it. `keepRecentTokens`, the watermark clamp and
`compact_deferred` all become dead code.

Counter-fact worth keeping: ACP never modifies persisted history — compression is a request-time
view over the log. So our coverage watermark keeps walking the transcript, and the defect class
"compaction dropped entries the writer never read" (measured 53 459 tokens, 2026-10-19) cannot
occur under ACP.

`src/index.ts` registers `session_start`, `turn_end`, `agent_before_settle`,
`session_before_compact`, `session_shutdown` — **no `context` handler**. ACP documents the
`context` event as a pipeline where the last handler has final say and load order is
nondeterministic, so "never intercept `context`" is an invariant this extension should pin with a
check rather than keep by accident.

## Borrowable, ranked

### 1. Behavioural survival counts → the relevance tier we deleted

ACP tracks per compressed block: `survivedCount`, `generation: "young" | "old"`, `tier` 1–3.
`DESIGN.md` § *Ranking* records why we have no ranking field at all: `confidence` saturated
(965 of 996 facts `high`, one session 163/166 at exactly `1.0`), the replacement `stability` field
came back `detail` on 60 of 65 drafts, and the writer was never trained to grade its own output.
The conclusion there is the same one ACP reached from the other side: a discriminating signal must
come from **cross-fact evidence** — "which facts the agent reads back through `hy_recall`, or
which ones keep being restated and retrieved as reconcile candidates" — and that is *not
implemented*, so `enforceBudget()` and `renderMemory()` sort by `createdAt`.

Import: three counters per `BankEntry`, maintained by code with no model call —
`survivedSelections` (kept by a render or a hifi checkpoint), `retrievals` (`hy_recall` hits),
`candidateHits` (surfaced by `candidatesPerDraft()`). Rank the summary and the eviction order on
them.
Gate: the number `DESIGN.md` already owns — oldest kept stays ≥ 20 chunks at the same
`summaryMaxTokens` on the 32-chunk / 408-fact ledger — and blind-judge specificity must not fall.

### 2. Prompt packs for the writer prompts

ACP bundles the model-facing surface as named JSON (`~/.pi/acp/packs/N.json`, project → user →
built-in, `models > providers > global` cascade, inline overrides win per field, an invalid pack
falls back instead of crashing) and gates replacement of the four load-bearing rule strings behind
`acknowledgePromptsRisk`.

Our two prompts are frozen in `src/prompts.ts` and they have to resemble the Mem0/MemOS/Hy-Memory
harness prompts the writer was trained on, so every A/B arm in the local task list currently means editing
`src/` and re-capturing. Packs make an arm a config change:
`~/.pi/agent/pi-hy-memory/prompts/<name>.json`, selected by `writerPromptPack`, default = the
built-in bytes, loud warning when a pack overrides the extract prompt (that prompt is what keeps
us inside the training distribution).

### 3. Window-relative budget resolution

ACP resolves `compress.*` live per turn from `ctx.model.contextWindow`, cascading
`model > provider > global`, and documents the trap of shrinking `modelContextLimit` to express a
cost target (it moves every percentage threshold, so lossy truncation fires mid-task).

`README.md` already concedes the equivalent wart for `summaryMaxTokens` ("sized for the *smallest*
window you actually run, or split per project"), but `observeAfterTokens`, `maxChunkTokens` and
`keepRecentTokens` are absolute: a 40 960-token session and a 1 048 576-token session get identical
write cadence. Resolve those against the live window, keep an explicit override, and keep pi's
`compaction.modelOverrides` as the source of truth for *when* to compact (we deliberately own no
threshold knob — `DESIGN.md` § "Why this extension has no threshold knob").

### 4. The model decides *what*, code decides *when* — a `hy_flush` tool

ACP's whole thesis, and it is importable without touching `context`: register one model-facing
tool the **session** model calls when it has finished with material ("fold what you've consumed"),
name the range, start a write over exactly that range, keep the token threshold as a floor.

Why it is a real improvement rather than a novelty: `DESIGN.md` "Not yet proven" #4 is that
narrower chunks may cost updates because each write sees a smaller slice of a transition — our
boundary is chosen by "6 000 estimated tokens happened to land here". A range the session model
just declared expendable is a semantic boundary. And the call is made by the session model, never
offered to the writer, which measurably refuses to call tools at all
(chunk 482: 0 observations, `tool_calls: null`).

The tool description is the whole feature: see `plan-hy-flush.md` for the drafting plan.

### 5. A repetition guard on writer output

ACP fingerprints each call as `sha1(toolName + canonical-JSON(args))` and escalates
warn at 3 / block at 5 consecutive identical calls. `DESIGN.md` measured **510 of 585 proposals as
exact-hash duplicates** and states the rule "never ask it to 'continue'; it repeats. Dedup is
code's job" — yet `src/chain.ts:47-57` gates only on enabled / session / in-flight / pending
extract / lastFailed / failures / MAX_CHAIN / renderable / trigger. There is no "the write that
just finished accepted zero ops" rule, so a chained write can pay ~20 000 tokens to add nothing.

Import: a fingerprint + no-op gate in `shouldChainWrite()`, audited as its own reason string.

### 6. Tool-output economics in the chunk

ACP encodes what is re-derivable: `read` / `bash` results are the largest reclaimable mass and are
deliberately excluded from the soft recent zone (`neverPreserveRecentTools`, whose kernel default
is `["decompress", "search_context", "read", "bash"]`); `protectedLatestTools` keeps only the newest
call+result pair for cumulative-snapshot tools.

Import as serialization policy in `src/serialize.ts` rather than blunt `maxEntryChars: 3000`
head-truncation: newest read per path wins, older reads of the same path drop, error text and user
turns stay verbatim. The Hy-Memory paper's annotation study is the lever — identical chunks at
two-chunk context produced **25 % more proper nouns and 59 % more numbers per fact** than full
history, so shrinking the chunk is what improves specificity.
Tension: the blind judge's misses concentrate on *constraints and metrics stated inside tool
output*, so this is a judge-gated arm, not a default.

### 7. Cache accounting

`Usage` carries `cacheRead`, `cacheWrite`, `cacheWrite1h`, `reasoning`
(`pi-ai/dist/types.d.ts:279`) and we record none of them (`grep` finds no cache accounting in
`src/`). ACP ships `acp_cache` — grand ledger of input/cached/hit rate, per-request miss
attribution, per-fold economics — because compression decisions are cache decisions. We need the
same fields before any per-turn injection can be justified: the system prompt precedes every
message, so refreshing a bank section per write means a full prefix-cache miss every ~6 000 tokens
of new content, i.e. caching stops working. An appended entry does not.

### 8. A grep-able ops log

ACP writes `~/.pi/acp.log` always-on (debug level optional), one physical line per event,
`<ISO> [level] [scope] k=v k=v`, escaped so multi-line values stay single-line, rotated at 10 MB.
Our ledger entries are better for provenance but there is no cross-session operational log, and
"508 attempts in 37 minutes during a 502 storm" needed one. Small rotated file, one line per
write / compact / failure / cooldown / failover.

### Not worth importing

- **The agent loop for the writer.** Measured here at temp 0: tool protocol 18 records with 90
  duplicates and 350 436 in-tokens / 240 s vs bank protocol 10 writes, 28 778 in-tokens / 31.6 s;
  `closed_by_complete = false` in 12 of 12 runs; turn-cap exhaustion 12–296 turns. A subagent adds
  a spawn, a system prompt the writer never saw in training, and a tool loop it does not use. If
  the child is single-shot and toolless, it is strictly worse than `registry.complete()`.
- **Rewriting the `context` chain.** Ours must stay a non-interceptor.
- **State outside the session log.** ACP's replay-the-transcript fallback restores only what the
  transcript records and re-derives token snapshots; `export` drops `parentSession`, so forks lose
  compression state. Our ledger-in-the-log + coverage watermark + `gap-reload-check` is the
  stronger truth model.
- **Tiers of lossy summaries (T1→T2→T3).** A supersede chain plus recall-by-id with exact source
  text beats summaries-of-summaries. ACP's own weakness follows from it: nothing in a block is
  verifiable.

## Subagents — where they belong

- **Not** the writer (above).
- **Orientation on resume**: one clean-context child at `session_start` of a resumed session reads
  bank + repo + (if present) ACP blocks and returns a short "here is where this stands" brief.
  Once per session, multi-turn read/grep work, never on the hot path.
- **A verify arm** for the measured miss (~6 durable facts per chunk, concentrated in tool output):
  re-read the artifact the clipped chunk referenced and restate it. Never the writer grading
  itself — `dev/rubric.md` forbids the writer as judge.
- **A background write worker**: `waitForWriteOnSettle: true` blocks turn end up to `timeoutMs`
  (480 000) and `busyRetries` sleeps inside the extension. Process isolation, not reasoning.
- If ACP is installed, register **no competing model-facing delegation tool**: ACP auto-stands-down
  `acp_delegate` for a project-scope `pi-subagents` install because two fleets "make the model's
  choice noisier". Extension-internal children avoid that entirely.

## Which system

Split honestly: **pi-hy-memory has the better architecture, ACP has the better machinery.**
Ledger-in-the-log, bit-exact fold, coverage watermark, every fact evidence-backed, compaction
summary costs zero model calls. Items 1–7 are how that foundation gets the decision-making ACP has.

Which to *run* depends on the model class:

- **Hosted 200 K+ model that can drive a tool loop → ACP.** No extra model calls, working set near
  150 K, and evidence at production scale (4.5 months, 174 327 calls, 18.76 B cumulative input
  tokens, zero window violations on 204 800-token models, sessions of 8 584–12 049 calls).
- **This machine — local llama-swap, dedicated writer, quantized reasoning models → pi-hy-memory,
  alone.** ACP assumes an orchestrator-grade model (it ships a `lean` pack because small models
  copy tool schemas into their answers), and Hy-Memory-30B-A3B is the worst orchestrator ever put
  through this harness while being the best writer.

If only one extension may exist: this one — but only after item 1 gives the bank a ranking that
isn't recency and item 5 stops it paying for writes that add nothing.

## Coexistence contract, if both ever run

1. Never register `context` / `context_with_system` — pin with a check that greps `src/index.ts`.
2. Never write `*.acp.json`. Read-only, `schemaVersion` gate, additive fields ignored
   (`additionalProperties: true`), atomic rename means readers never see torn writes.
3. `hifiCompaction` + ACP = dead path; say so in the config table rather than leaving it
   discoverable.
4. Do not claim `ctrl+alt+d` / `ctrl+alt+f`; `/hy` stays clear of `/acp`.
5. New keys go in the README config table — `tools/config-docs-check.ts` enforces it.
