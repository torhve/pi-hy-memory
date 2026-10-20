# TODO — `hy_flush`: the session model names the range

## Goal

Give the session model a tool that folds *settled* conversation entries into the fact bank on
demand, so a chunk boundary is a semantic one instead of "6 000 estimated tokens happened to land
here", while the token threshold stays the floor.

Branch: `experiment/hy-flush`. Decisions from the user: explicit ids the model lists, queued
(return immediately), on by default for all models, description written for local quantized models.

## The id problem, settled up front

pi shows the model message content only — never entry ids. `DESIGN.md` also measured that this
writer copies rendered id labels into fact text (19 of 590 observations), which is why
`src/serialize.ts` hides real ids behind positional `[n]` refs.

So "explicit ids" is implemented as **the tool's own positional refs, returned by the tool itself**:
`hy_flush` with no arguments lists the unwritten entries as `[3] user: …` lines, and
`hy_flush({from, to})` writes that range. Refs are 0-based and mean the same thing as the refs in
the chunk the writer receives. No `context` handler, no tags injected into messages, and nothing
ACP can clobber.

## Tasks

### 1. Pure range logic (`src/flush.ts`)

- [ ] 1.1 `unwrittenRange(pending, from?, to?)` returning `{ start, end, clampedFrom?, clampedTo? }`,
      where `start` is **always clamped down to 0**: coverage is monotone in the branch
      (`coverageWindow`, `src/entries.ts:1210`), so a flush that skipped front entries would create a
      hole the ledger could never record as covered. `end` clamps to `pending.length - 1`.
      Done when `from > to`, negative, fractional, past the window, and an empty window all resolve
      to a valid range or an explicit "nothing to write".
- [ ] 1.2 `renderUnwritten(pending, limit)` renders `limit` lines as `[i] <role>: <preview ≤120 chars>`
      in chronological order, with a tail line naming how many entries were not shown and the
      highest valid ref. Budget-bounded: `limit` default 24 lines.
- [ ] 1.3 `flushInstructions(pending)` — one line telling the model the exact call shape that works,
      naming the valid `to` value. Written so a quantized model can copy it verbatim.

### 2. Gate for a model-initiated write (`src/chain.ts`)

- [ ] 2.1 `shouldFlushWrite({ sessionActive, inFlight, pendingExtract, primaryDown, coolingDown,
      entryCount })` — a decision with a reason string per rejection, mirroring `shouldChainWrite`
      (`src/chain.ts:47`) but **without** the trigger threshold: the model asked, so a window under
      `observeAfterTokens` is still worth writing. `/hy off` refuses.
- [ ] 2.2 Keep the cooldown and the in-flight guard: a dead writer must not be poked once per tool
      call. `failures` is not a veto — `idle-drain-check` already established that a failed writer
      gets probed, not vetoed.

### 3. Wire the tool (`src/index.ts`)

- [ ] 3.1 Register `hy_flush` next to `hy_recall` (`src/index.ts:1185`), skipped when
      `config.flushTool === false`.
- [ ] 3.2 No-argument path: read the branch, `coverageWindow`, `renderUnwritten`, return the list.
      Writes nothing and spends nothing.
- [ ] 3.3 Range path: gate via 2.1, `serializeEntries(pending.slice(0, end + 1), { maxTokens:
      chunkBudget(), maxEntryChars: config.maxEntryChars })`, `nextChunkId`, `chained = 0`,
      `lastAttemptFailed = false`, then `startWrite` — the queued path, tool returns immediately
      with `queued: <n> entries, ~<tokens> tokens, chunk <id>`. Reuses the idle-drain pattern at
      `src/index.ts:820-830`.
- [ ] 3.4 `markActivity(ctx)` on the call so a flush does not look like an idle session to the drain
      timer.
- [ ] 3.5 Audit line `hy_flush { sessionId, chunkId, requested: {from,to}, applied: {start,end},
      clamped, entries, tokens }`. A clamped request must be visible in the audit, not silently
      widened.

### 4. The model-facing surface (this is the part that decides whether it gets used)

- [ ] 4.1 `description` — three sentences max, no markdown, no schema echo, and it must carry: what
      it does, the *when* (a settled stretch whose facts must survive a compaction or reload), the
      two-step call shape, and one *when-not* (`hy_recall` is for reading facts). Drafted in § Draft
      below; length capped at 320 characters and pinned by the check.
- [ ] 4.2 `promptSnippet` — one line, ≤ 90 characters.
- [ ] 4.3 `promptGuidelines` — at most two lines, ≤ 160 characters each. No examples with JSON in
      them: a quantized model copies a JSON example into prose instead of calling the tool (ACP
      ships a `lean` pack for exactly this, measured 5 422 → 1 312 bytes).
- [ ] 4.4 Param descriptions short enough that a small model reads them as constraints, not as a
      template to restate.

### 5. Config and docs

- [ ] 5.1 `src/config.ts`: `flushTool` (default `true`), `flushListEntries` (default `24`).
- [ ] 5.2 README config table rows for both keys — `tools/config-docs-check.ts` fails otherwise.
- [ ] 5.3 README `## Commands` section: what `hy_flush` is, and that the footer/`/hy` reports the
      queued write like any other.
- [ ] 5.4 `DESIGN.md` section "Who decides what: the session model may name the range", recording
      the reason (Not-yet-proven #4: narrower chunks may cost updates because each write sees a
      smaller slice of a transition) and the monotone-coverage clamp.

### 6. Checks

- [ ] 6.1 `tools/flush-check.ts` (auto-picked up by `npm test`'s `tools/*check.ts` glob): range
      clamping table from 1.1, hole prevention, empty window, a range larger than `maxChunkTokens`
      (must serialise oldest-first and report `droppedEntries`, not drop the middle), the gate table
      from 2.1 including `/hy off` and cooldown, and the surface caps from 4.1–4.3 asserted against
      the strings exported from `src/flush.ts`.
- [ ] 6.2 `npm run check` green (Biome + all checks + `tsc --noEmit`).
- [ ] 6.3 Manual live step (recorded in `EXPERIMENTS.md`, no private text): one real session with
      `PI_HY_MEMORY_STATE` pointed at a scratch dir — call `hy_flush` bare, call it with a range,
      confirm the audit lines, the footer spinner, and that the bank grew. Which model called it and
      whether it needed the listing at all.

## Draft — the tool description to review

```
name        hy_flush
label       Hy flush
description Fold settled conversation entries into the durable fact bank now, instead of waiting
            for the token threshold. Call it once a stretch of work is finished and its facts must
            survive a compaction or a reload: a decision taken, a root cause found, a constraint
            the user stated. With no arguments it lists the entries not yet written; then call it
            with from and to. Use hy_recall to read facts, not this tool.
snippet     Fold settled entries into the fact bank; no arguments lists what is unwritten.
guidelines  - Call hy_flush after a settled stretch whose facts must survive a reload: decisions,
              root causes, user-stated constraints.
            - Call hy_flush with no arguments first, then flush a from/to range. Do not call it to
              re-read a file or to undo work.
params      from  "First entry to write, as listed by hy_flush with no arguments."
            to    "Last entry to write, as listed by hy_flush with no arguments."
```

## Notes

- **Nothing here touches the `context` chain.** That is an invariant, not an accident
  (`notes/acp-borrowings.md`: pi's `context` handlers are a pipeline whose last handler wins, and
  load order is nondeterministic).
- Queued, not synchronous: extract runs 28–52 s per chunk on the local writer route, and
  `timeoutMs` is 480 000 — a synchronous tool would stall a turn for that long.
- On by default is a deliberate departure from `hifiCompaction`'s opt-in. The cost is prompt tokens
  in every session (~250 characters + 2 guideline lines); the payoff is measured in 6.3.
- Failure mode to watch: a model that flushes after every small edit pays ~25 s and 9 000 tokens per
  call. The audit carries the requested range, so the cadence is measurable after the fact, and
  `flushTool: false` is the kill switch.
- Out of scope: bank delivery, prompt packs, survival ranking, cache accounting
  (`notes/acp-borrowings.md` items 1–3, 7).

## Deviations found while implementing

- **`from` is gone.** The coverage clamp forces the start to the front of the unwritten window, so a
  `from` argument would always be ignored. A knob the model cannot use is worse than no knob: the
  tool takes `to` only, and a bare call lists.
- **Refs number renderable rows, not entries.** `renderEntry()` returns nothing for system rows, this
  extension's own records and pi bookkeeping, so `unwrittenRange()` takes `FlushRow[]` and maps a ref
  back to an entry position (`entryIndex`). `rangeEntries()` hands over the whole span between the
  first and last selected entry, gaps included.
- **`MAX_PENDING_FLUSH = 2`.** The plan bounded the cadence by cooldown only; cooldown gates the next
  *attempt*, not the queueing, so a chatty model could stack writes.
- **`tools/recall-check.ts` kept one tool.** The faux `registerTool` stored a single definition, so
  adding a second tool silently replaced `hy_recall` and every recall assertion failed. It now keys
  tools by name and asserts both are registered.
- **The corpus cannot measure the gain.** Every capture in `dev/corpus-extended.json` arrived with its
  boundary already fixed by the observer's threshold, so an arm over those files measures the writer,
  not the boundary choice. Recorded as DESIGN.md § *Not yet proven* #6: the gain needs a
  session-level replay with a real session model.
