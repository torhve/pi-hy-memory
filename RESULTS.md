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

## Does the session model use `hy_flush`? (2026-10-21, live)

**Question:** a tool the session model is never told about in its prompt is either used or it is
noise. `hy_flush` asks a quantized model to read a listing and then name a number. Does it?

| mechanism | file |
|---|---|
| Two arms, three runs each, pi headless in a scratch `HOME` with no packages loaded | `dev/live-flush.sh` |
| Writer aimed at a model id that does not resolve, so no bank is written and no writer slot is touched | `LIVE_WRITER`, default `test/writer` |

Session model `qwen3.8-flash-next-iq3_xxs` (local llama.cpp, IQ3 quantization), one prompt per run,
identical in both arms and never mentioning memory: *"You are deciding how a small CLI tool should
store its settings. Pick a file location, a format, and the behaviour when the file is missing.
Then state the decision and the reason for each choice."* `observeAfterTokens` was set to 200 000 so
the token threshold could not fire and every write in the experiment was model-initiated.

| arm | runs | `hy_recall` | `hy_flush {}` | `hy_flush {to}` | refused | what the ranged call named |
|---|---|---|---|---|---|---|
| flush on | 3 | 1–2 | 3 / 3 | 3 / 3 | 0 | `{to: 4}` every run → applied `[0]–[4]`, 5 entries, 253–917 chunk tokens |
| flush off | 3 | 2 | 0 | 0 | — | — |

* The two-step path was taken unprompted in every run: a bare call, then a ranged call naming the
  last ref it had been shown. No run invented a `from`, none called the tool more than once per
  step, and none was refused — the gate never had to protect a local writer from a storm.
* The control wrote nothing. With no tool the model read the bank twice and ended the turn, so
  whether that stretch survives rests on the threshold, which in this sandbox could not fire. The
  delta is real, but it is measured against a threshold configured never to trigger, not against
  the shipped 4 000.
* Cost of the surface, per run: two extra tool round trips (one listing, one queued write) plus
  ~200 estimated prompt tokens in every session, and one failed write attempt per run here because
  the writer id is deliberately unresolvable.

**Not proven by this:** bank quality (no write landed), a flush of an *earlier* stretch in a long
session — with one turn per run the model could only name the end of the window — and any model
other than this one, this prompt, this host, n=3.

## Who writes first: the model or the threshold? (2026-10-21, live)

The arm above isolated the tool by giving its control a threshold that could never fire. That left
the useful question unanswered: does a model-initiated write arrive *before* the shipped cadence
would have covered the same ground, and does the gate protect a dead writer from a model that keeps
asking? `dev/live-cadence.sh` runs one four-message conversation in four configurations, three runs
each, same session model, writer still a model id that does not resolve.

| arm | `hy_flush` calls | write attempts | first write after message | refused |
|---|---|---|---|---|
| flush-only (threshold 200 000) | 9 / 4 / 2 | 5 / 2 / 1 | 9 / 9 / 9 | 0 |
| threshold-only (no tool) | 0 | 2 / 2 / 2 | 10 / 10 / 10 | 0 |
| both (the shipped combination, threshold 1200) | 4 / 2 / 4 | 7 / 5 / 7 | 9 / 7 / 9 | 0 |
| both, `writeCooldownS: 30` | 7 | 2 | 7 | **3, reason `write cooling down`** |

* A model-initiated write lands a turn earlier than the threshold's first: after message 7–9 versus
  after message 10. In a session that runs to completion both arms end covered, so the gain exists
  only against a reload or a compaction inside that gap. **Corrected by the arm below:** with
  `flushMinTokens: 2000` the early calls are refused rather than written, so this ordering belongs
  to a config where the floor was clearable, not to the shipped one.
* The model asks more often than the threshold fires. Flush calls per run varied 2–9, and with both
  mechanisms enabled a session paid 7 write attempts where the threshold alone paid 2.
  `MAX_PENDING_FLUSH = 2` bounds the queue, not the number of calls across a session.
* Refusals appeared in exactly one arm, and only there. With `writeCooldownS: 0` — which the other
  three arms used — a failed writer is *not* a veto by design, so every call was accepted and the
  gate never spoke. With the shipped 30-second cooldown, the failed write made the next three calls
  refuse with `write cooling down`, and the calls before and after the window still went through.
  The earlier reading of "zero refusals" was therefore my config switching the guard off, not the
  guard working.
* **The written-token totals are not a cost comparison.** Because the writer never answered, the
  watermark never advanced and each flush re-carried the whole window: one run's chunks were
  1 156 → 1 444 → 1 820 → 2 283 → 3 128 tokens over the same entries. With a writer that answers,
  the watermark moves and the next flush covers only what is new.

**Not proven by this:** bank quality, and whether earlier coverage actually survives a reload —
which needs a reload inside the gap, not a writer that fails.

## What a model-initiated write costs (2026-10-21, live, writer answering)

The arm above left the cost question open because its writer never answered: with no watermark
advancing, every flush re-carried the same window, so the token totals measured the stub. Repeated
with a writer that resolves (`hy-memory-30b-a3b`), same three arms, same four-message conversation,
three runs each, `observeAfterTokens: 1200` for the threshold arms, `flushMinTokens` at its shipped
2 000. Means over three runs:

| arm | writes | writer tokens | writer wall | facts landed | session messages |
|---|---|---|---|---|---|
| flush-only (threshold 200 000) | 2 | 3 318 | 41 s | 18 | 21.3 |
| threshold-only (no tool) | 3 | 3 629 | 47 s | 23 | 12.7 |
| both (the shipped combination) | 4 | 4 658 | 61 s | 22 (+4 updates) | 17.3 |

* **Offering the tool costs about +28 % writer tokens and +13 s per session.** Per run: 3 341 /
  7 421 / 3 213 against threshold-only's 3 737 / 3 413 / 3 737. The expensive run is the one where
  the session grew to a second write (messages 8 and 17).
* **The extra write was not a flush.** Nine ranged `hy_flush` calls happened across the two arms
  that had the tool; two were accepted, seven refused at the floor, and none of them produced a
  write that the threshold would not have produced. What `both` paid extra was a *second
  threshold-triggered* write, because the tool round adds messages to the window.
* **The floor is what makes asking cheap.** Seven refusals cost nothing: no writer call, one line
  naming the number (`pendingTokens` 689–1 541 against a floor of 2 000). The earlier "7 write
  attempts where the threshold paid 2" was the stub failing to advance the watermark, not eagerness.
* **`flush-only` is not a policy.** One of its three sessions wrote nothing at all: 17 messages,
  every ranged call under the floor, zero facts durable. Coverage is the threshold's job; the tool
  is only a second trigger on top of it.
* **A 1 200-token threshold cannot be beaten by a 2 000-token floor.** The two accepted flushes
  landed after messages 20 and 21; the threshold wrote after messages 8–12. The shipped pair is
  `observeAfterTokens: 6000` with the floor at 2 000, so the race is possible there, and the
  "a turn earlier" reading from the arm above holds only for that ratio. Demonstrating it needs a
  long conversation with a decision that settles far from the threshold — and a reload inside the
  gap, which is the whole point and still unmeasured.

**Not proven by this:** that earlier coverage survives a reload, and whether the extra write buys
anything a later threshold write would not have covered anyway.

## Does a finer chunk boundary buy quality? (2026-10-21, corpus, pre-registered)

`hy_flush` rests on the claim that a boundary chosen where work settled beats a boundary where an
estimate landed. Tested directly: the same 12 captures, once written whole (control, 12 writes) and
once cut at entry boundaries into 24 pieces (arm, 24 writes), same writer (`hy-memory-30b-a3b`), same
retrieval mode, same judge (`qwen3.8-flash-next-iq3_xxs`, rubric `dev/rubric.md`) at two seeds. The
arm's pieces were re-emitted through the same split the run used and cross-checked against its own
entry counts, so the judge saw what the writer saw. Predictions and the noise floor were written
before the arm's verdicts existed (`notes/boundary-prediction.md`).

| | control, 12 writes | arm, 24 writes |
|---|---|---|
| entries in | 1 243 | 1 243 |
| ADD / UPDATE / DELETE | 157 / 26 / 0 | 241 / 52 / 1 |
| active facts / bank tokens | 157 / 11 814 | 240 / 16 775 |
| mean statement tokens | 76 | 70 |
| specificity (seed 7 / 11) | 2.519 / 2.563 | 2.459 / 2.473 |
| durable share | 60.1 % / 56.8 % | 50.7 % / 50.7 % |
| noise share | 15.3 % / 16.4 % | 19.4 % / 20.1 % |
| unsupported | 0 / 1 | 4 / 0 |
| missed per write | 7.6 / 7.2 | 5.8 / 5.8 |
| prompt tokens | 305 039 | 347 781 |
| wall | 5 226 s | 4 336 s |

Read against the pre-registered rule (a specificity gap under 0.1 is no difference):

* **Specificity did not rise.** It is flat-to-slightly-lower at both seeds. The prediction that less
  context produces more specific statements — the paper's effect, and the direction the earlier
  5-chunk run suggested — did not reproduce at this size.
* **The bank got 53 % bigger and less durable**: 240 facts against 157, durable share 60 → 51 %,
  noise share 15 → 19 %. Missed fell per write (7.6 → 5.8), which is the one quality column that
  improved.
* **Not duplication.** Near-duplicate pairs per active entry went *down* (0.032 → 0.025), so the
  extra facts are finer granularity, not restatement.
* **Cost**: 2× the writes for +14 % prompt tokens and −17 % wall — smaller writes are cheaper each,
  and there are simply more of them.

**Scope of that reading.** One writer model, 12 captures, two judge seeds, no model-variation
control. The load-bearing columns are the durable share and the bank size, which move by more than
the judge's spread; specificity itself moved by less than it, so it is reported as no difference
rather than as a decline.

**What this changes.** A finer boundary is not a quality win, so `hy_flush` is justified only by
*timing* — a settled fact reaches the bank a turn earlier, which matters solely against a reload or
compaction in that gap. `flushMinTokens` (default 2000) now refuses a write whose named range carries less than that, and
the refusal states the amount it would have carried, so the model cannot fragment the bank one
settled turn at a time.
That is a behaviour change: the live cadence run showed a listing plus a flush on nearly every
settled turn, which is exactly the cadence this floor stops.

**Still unproven:** whether earlier coverage survives a reload; retrieval precision on a larger bank
(more facts may help recall and hurt precision); and whether the floor keeps real sessions near
threshold-sized chunks rather than merely refusing the thin ones.
