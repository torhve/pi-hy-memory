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

## Configuration

`~/.pi/agent/pi-hy-memory.json` (all keys optional; defaults in `src/index.ts`):

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | turn the extension off without unloading it |
| `dryRun` | `false` | run the pipeline, append nothing to the session |
| `observeAfterTokens` | `6000` | pending window that triggers a write (the *first* footer bar) |
| `maxChunkTokens` | `24000` | chunk budget per write. Note: estimated at chars/4, and code-heavy chunks tokenise at ~1.4–1.5× that, so a 20 000 budget is ~30 000 real prompt tokens |
| `maxEntryChars` | `3000` | per-entry truncation inside a chunk, so one huge tool output cannot consume the whole budget |
| `poolMaxTokens` | `6000` | cap on the *active* bank (the *second* footer bar); see DESIGN.md § "What happens when the bank fills". ~72 tokens per fact, and the rendered summary is ~1.2× the cap |
| `keepRecentTokens` | `6000` | raw entries kept verbatim by a compaction, clamped so nothing the writer has not seen is dropped |
| `candidateLimit` | `12` | bank entries shown to the reconcile call |
| `model` | `hy-memory-30b-a3b` | writer model from **your pi model list**: `provider/modelId`, or a bare id |
| `maxTokens` | `8000` | output cap per call |
| `timeoutMs` | `480000` | total wall-clock cap per call; raise it for a CPU-offloaded writer |
| `chatTemplateKwargs` | `false` | llama.cpp only: e.g. `{reasoning_effort:no_think}`. Omitted by default because other providers reject unknown fields |
| `extraBody` | `{}` | extra request fields, merged last (`samplingParams` in pi-ai terms) |
| `fallback` | `false` | `{model, maxTokens?, timeoutMs?}` — a second model id, used when the primary is unavailable |
| `fallbackCooldownS` | `300` | stay on the fallback this long after a failover (cleared only by a **primary** answer) |
| `busyRetries` / `busyBackoffMs` | `3` / `4000` | 429 handling: llama-swap rejects a concurrent request to a single-slot model *instantly* instead of queueing |
| `pruneAfterDays` | `30` | delete per-session state older than this; `0` disables. The 10 newest sessions and the running one are always kept |
| `waitForWriteOnSettle` | `true` | block the end of a turn on an in-flight write |
| `shutdownWaitMs` | `5000` | cap on how long `session_shutdown` waits for a write |
| `statusBar` | `true` | footer bar: window fill, bank fill, spinner, `✓ +N ~M` |

## Compaction: who decides when

**pi decides.** The extension never triggers a compaction — it only supplies the summary
through `session_before_compact` (`renderMemory(bank, poolMaxTokens)`), sets
`firstKeptEntryId` itself (so this extension's `keepRecentTokens` wins over pi's
`compaction.keepRecentTokens`), and logs the event. If the bank is empty it returns
nothing and pi summarises with its own model.

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

Our summary is bounded by the bank (12 k), not by history, so we do not inherit the
"summarising 1 M tokens is expensive and lossy" problem that motivates pi-blackhole's
shrinking curve. On a very large window, compacting *late* is cheaper for us, which is
what pi's default already does.

### `poolMaxTokens` is window-relative

The bank cap is only meaningful next to the session model's window:

| session window | 12 000-token bank is | comfortable range |
|---|---|---|
| 40 960 | 29 % — too big | 3 000–4 000 |
| 168 000 | 7 % — about right | 10 000–14 000 |
| 262 144 | 4.6 % | 16 000–20 000 |
| 1 048 576 | 1.2 % | 25 000–30 000 |

The cap is per session, not per model, so a config used across models should be sized
for the *smallest* window you actually run, or split per project.
## Footer

```
hy ▕███░░░░░▏ 6.2k/15k   ▕██░░░░░░▏ 1.4k/5k   ⠼ extract 8 entries
```

First bar is the window that triggers the next write, second is the bank against
`poolMaxTokens`. While a write runs the braille spinner names the stage — `extract`,
`reconcile`, or `wait busy 15s` when backing off a 429 — and a finished write flashes
`✓ +6 ~2` for five seconds. `✗ <reason>` replaces it on failure. Derived from
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
| `failover-state-check` | the cooldown is cleared only by a **primary** answer |
| `write-resume-check` | coverage contiguity, and not re-extracting after a failed reconcile |
| `compaction-window-check` | compaction never drops entries the writer has not covered |
| `ops-guard-check`, `subject-guard-check` | wrong-target and wrong-subject UPDATEs |
| `redact-check` | credential redaction without damaging identifiers |
| `budget-check`, `reload-budget-check` | pool eviction order, reload semantics, summary budget |
| `render-check` | compaction summary budget and omission reporting |
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
