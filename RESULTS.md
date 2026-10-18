# pi-hy-memory vs [pi-blackhole](https://github.com/k0valik/pi-blackhole) — pilot A/B

**Status: preliminary result, not a conclusion.** One task, one session model, n=1 per
configuration. What follows is what the collected evidence supports, and what it does not.

## How it was measured

| mechanism | file |
|---|---|
| Paired run (both extensions in one session, identical transcript) | `run-ab.sh <rundir>` (not included) |
| Solo run (exactly one extension per session, no GPU contention) | `run-solo.sh <rundir> <hy\|bh>` (not included) |
| Token meter for the incumbent (SSE `stream_options.include_usage` injected, per-route upstreams) | `meter-proxy.py` → `<rundir>/meter.jsonl` (not included) |
| Blind judge (external judge model, rubric, randomized candidate order) | `dev/ab-judge.py <rundir> [--only hy\|bh] [--seed N]` |

Task (a five-file Python project fixture, not included): two planted bugs; fix them with tests
shown, add `discount`, `tax_total`, a CLI and `margin_report`, **reverse the agreed flat-module
design into a package**, write CHANGELOG/README containing two secrets that must not be committed,
final report. Cadence aligned at `observeAfterTokens = 1500` for both arms. Session model:
`qwen-flash-next/qwen3.8-flash-next-iq3_xxs` (local llama.cpp).

## Judge-rubric scores per run

| run | arm | memories | supported | partial | durable | marginal | noise | missed |
|---|---|---|---|---|---|---|---|---|
| paired run6 | pi-hy-memory | 22 | 22 | 0 | 13 | 7 | 2 | 3 |
| paired run6 | pi-blackhole | 28 | 26 | 2 | 17 | 6 | 5 | 4 |
| paired run7 | pi-hy-memory | 20 | 18 | 2 | 10 | 9 | 1 | 3 |
| paired run7 | pi-blackhole | 33 | 30 | 3 | 19 | 14 | 0 | 3 |
| solo | pi-hy-memory | 18 | 17 | 1 | 7 | 8 | 3 | 6 |
| solo | pi-blackhole | 17 | 14 | 3 | 10 | 6 | 1 | 7 |
| **local tally** | **pi-hy-memory** | **60** | **57 (95 %)** | **3** | **30** | **24** | **6** | **12** |
| **local tally** | **pi-blackhole** | **78** | **70 (90 %)** | **8** | **46** | **26** | **6** | **14** |

The tally is my local aggregation of three judge passes, not an independently verified statistic.

## Cost (solo run, metered)

| | pi-hy-memory | pi-blackhole |
|---|---|---|
| Writer calls | 2 writes (extract + reconcile each) | 3 LLM calls (2 observer, 1 reflector) |
| Models actually used | `hy-memory-30b-a3b` | `qfn-coder-llamacpp` ×2, `swift-qwen3.8-27b-q6` ×1 |
| Input tokens | 8 740 | 18 275 |
| Output tokens | 2 720 | 3 768 |
| Input tokens per active memory | **486** | **1 075** |
| Active memories produced | 18 (24 entries, 6 superseded) | 17 (14 recorded, 0 dropped, 3 reflections) |

Wall time is **not** a usable comparison: my first write paid 117.7 s of llama-swap model load
(131.5 s total), and pi-blackhole does not log worker wall time at all.

## Reading of the pilot

* **Grounding favours pi-hy-memory**: 57/60 supported with 3 partials vs 70/78 with 8 partials.
  The incumbent's partials were invented details the transcript did not contain — e.g. *"explicit
  44.0/rate 0.10 not shown in chunk"*, *"C3 Doohickey name not visible in chunk"*, *"shared `_config`
  helper not evidenced in chunk"*.
* **Recall/durability favours pi-blackhole**: 46 durable vs 30. Its reflector distills standing
  constraints (*"stdlib unittest only"*, *"run tests after every change"*) that my writer records as
  task narration — the judge called this out directly.
* **Cost**: in the solo run the incumbent spent ~2.1× the input tokens for a similar memory count.
* **Secret handling is a separate axis from completeness.** pi-hy-memory stored
  `sk-…redacted…` / `wt_…redacted…`; pi-blackhole stored `sk-SECRET-12345` and
  `wt_live_9f1a07bd7a8e` verbatim in both an observation and a reflection. The judge rubric counts
  the redacted values as *missed critical facts*, which penalises redaction as if it were a recall
  failure. Redaction quality and factual completeness should be scored separately.

## Finding about your pi-blackhole setup

`~/.pi/agent/pi-blackhole/pi-blackhole-config.json` selects `llama-swap/qfn-coder-llamacpp`
(observer) and `llama-swap/swift-qwen3.8-27b-q6` (reflector, dropper), but the `llama-swap` provider
in `~/.pi/agent/models.json` registers only 8 ids and neither of those is among them. In your
normal sessions — and in paired runs 6 and 7 — the debug log shows:

```
model.resolve_skip {"stage":"observer","reason":"not_found","model":"llama-swap/qfn-coder-llamacpp"}
model.failed_this_cycle {"stage":"observer","model":"qwen-flash-next/qwen3.8-flash-next-iq3_xxs"}
```

so the workers fall back to the same small flash model the session itself uses. llama-swap itself
serves both models (24 listed). Evidence that they *can* run: in the metered runs (`run9`,
`solo-bh`) there is no `resolve_skip`, and `meter.jsonl` records `requested_model`
`qfn-coder-llamacpp` / `swift-qwen3.8-27b-q6` with `status 200` and real usage.

I did **not** change your `llama-swap` provider. The experiment used mirror providers
`llama-swap-meter` and `qwen-flash-next-meter` (original saved as `models.json.bak-hy`). Fixing your
real setup means adding those two model ids under `llama-swap` in `~/.pi/agent/models.json`.

## Bugs found by running it as a real extension

1. **Stale-ctx crash (run 4).** A write finishing after pi closed the session made
   `pi.appendEntry()` throw, and the reporter threw while reporting it, killing pi
   (`ExtensionRunner.assertActive`, exit 1). Fixed: `agent_before_settle` and `session_shutdown`
   await the in-flight write; the mirror file is written before `appendEntry`; `appendEntry` is
   best-effort with an `append_failed` audit line; `warn()`/notify are wrapped.
2. **Ledger recovery.** `session_start` rehydrates from the per-session mirror when the session has
   no ledger records.
3. **Secret redaction gaps.** `sk-…` was covered, `wt_live_…` and `Bearer <token>` were not.
   `sanitizeStatement` now runs a `SECRET_PATTERNS` list; unit-checked to redact `sk-SECRET-12345`,
   `wt_live_9f1a07bd7a8e`, `Bearer abcdefghijklmnop`, a 28-char hex blob, while leaving
   `total_value`, `discount_lowers_price` and `inventory/store.py` untouched.
4. **Mis-targeted UPDATE erasing unrelated facts** (runs 6 and 7), e.g.
   `config.json contains currency: NOK, tax_rate: 0.25, warehouse: OSL-1` erased by
   *"config unit_cost 6, tax_rate 0.25"*. Root cause: `candidates()` scored each bank entry by the
   **max over all drafts**, so an entry shown for draft A was fair game for draft B. Fixed
   structurally: `candidatesPerDraft()` plus `parseOps(..., allowedTargets)` downgrades a
   cross-draft UPDATE to ADD and logs it as `downgraded`. In the solo run, 0 downgrades were needed.
5. **Five type errors** surfaced once `tsconfig.json` existed; `tsc -p .` is clean.

## Not proven

* Statistical reliability — n=1 per configuration, and the solo arms had **different transcripts**
  (73 vs 68 entries), so their scores are comparable in kind, not like-for-like.
* Task-level benefit: no test of either memory improving a *later* session's performance.
* Latency and throughput under load; arm B's wall time is unmeasured.
* Compaction/shutdown robustness as regression-tested behaviour (the fixes are reasoned, not
  covered by a test suite).
* Secret-handling safety beyond the handful of unit-checked patterns.
* Generalisation beyond this task, this session model, and this GPU setup.

## Reproduce

The A/B driver scripts (`run-ab.sh`, `run-solo.sh`, `meter-proxy.py`) are not part of this
repository. With `HARNESS` pointing at a checkout of them:

```bash
HARNESS/run-ab.sh    "$RUN6"                # paired: both extensions in one session
HARNESS/run-solo.sh  "$SOLO_HY" hy          # solo, this extension
HARNESS/run-solo.sh  "$SOLO_BH" bh          # solo, metered incumbent
JUDGE_DIR=… python3 dev/ab-judge.py "$RUN6"    --seed 7
JUDGE_DIR=… python3 dev/ab-judge.py "$SOLO_HY" --only hy --seed 5
JUDGE_DIR=… python3 dev/ab-judge.py "$SOLO_BH" --only bh --seed 5
```

Arm memory: `state/sessions/<sessionId>.{bank.json,summary.md,ledger.jsonl,stats.json}` for
pi-hy-memory; `om.observations.recorded` / `om.observations.dropped` / `om.reflections.recorded`
custom entries in the session for pi-blackhole.
