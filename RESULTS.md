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

**Answered since:** whether earlier coverage survives a compaction — no advantage, in the section
below, and the verdict on the offer closes the thread. **Still unproven:** retrieval precision on a
larger bank (more facts may help recall and hurt precision); and whether the floor keeps real sessions
near threshold-sized chunks rather than merely refusing the thin ones.

## Does a flushed fact survive compaction better than pi's summary? (2026-10-21, live, negative)

The claim `hy_flush` rests on: a decision folded into the bank before a compaction is still available
after it, where pi's prose summary would have lost it. Tested with `dev/live-reload.sh`: one session
that settles eight checkable specifics in its first five turns (path, file mode, rejected format, a
ticket reference, two exit codes, an env override and its precedence), then three turns about an
unrelated service carrying the bulk, then a closing handover question phrased without the probe
strings. `observeAfterTokens` is out of range in both arms, so the threshold cannot write — in the
treatment arm a flush is the only way anything becomes durable. Session model
`qwen3.8-flash-next-iq3_xxs`, writer `hy-memory-30b-a3b`, window 16 000 with a 6 000 reserve (threshold
10 000), `keepRecentTokens` 1 500, `flushMinTokens` 2 000, thinking off, three runs per arm.

| arm | summary keeps | answer keeps | writer cost |
|---|---|---|---|
| flush-off (control) | 7/8, 7/8, 7/8 | 7/8, 7/8, none | 0 |
| flush-on (treatment) | 7/8, 7/8, 7/8 | 7/8, 6/8, 5/8 | 22 540 tok / 572 s over 3 runs |

**No retention advantage.** The bank-rendered summary keeps exactly what pi's generated summary keeps:
seven of eight specifics, in every run of both arms. Treatment answers came in at 7/8, 6/8 and 5/8
against the control's 7/8 and 7/8, so on this instrument the extra trigger bought nothing — the
~28 % writer tax measured earlier is not paid back. Per treatment run: 9 / 9 / 8 `hy_flush` calls,
2 / 1 / 1 writes, 12 699 / 5 108 / 4 733 writer tokens, 12 / 7 / 11 facts.

What the six runs say about *why*, which is more useful than the tie:

* **The cut really discards, in both arms.** `settled 8/8` and zero probes verbatim in the visible tail
  in all six runs, with the cut landing at `tokensBefore` 7 982–11 542 — inside the unrelated stretch,
  after every decision. Nothing here is scored on content that was never thrown away.
* **The render is faithful; the bank is not.** Each run's rendered summary carried precisely the
  probes its bank held and dropped none of them. The bank itself held 7/8 — run 1 never had
  `exit code 3`, runs 2 and 3 never had `TOR_TOOL_SETTINGS`. Extraction did not propose them; a short
  enumerable is exactly what the writer skips.
* **Retrieval handed over what the answer then dropped.** In run 2 the post-cut `hy_recall` results
  contained `exit code 3` and `0o600` and the answer still lost both; run 1's recall carried seven
  probes and the answer took six, skipping `exit code 3` that was sitting in the tool result. The
  loss is the session model not integrating what it asked for, not retrieval missing the fact.
* **One difference in the treatment's favour, and it is about robustness.** The control lost a run to
  pi's own recovery: `Context overflow recovery failed: Summarization failed: generation hit the token
  cap and the summary is incomplete`, and that run answered nothing at all. In the treatment arm the
  extension claimed every cut (`fromHook=true`) and no run lost its answer that way — its summary is
  rendered, not generated, so it cannot run out of output budget.

**Instrument history, because three earlier pairs of this measured nothing.** The model's own answers
after the cut restated every decision; the extension's `custom` entries, which never reach the request,
were counted as surviving context; the scored answer itself was counted as surviving context; and the
threshold fired mid-design, so nothing had been discarded at all. All four are fixed in the harness
(`e7dc215`, `9b84a8f`, `83fa998`, `7cc36c4`, `7c016fc`) and the fix is visible per run: `settled 8/8`,
`verbatim in kept tail 0`, and a named cause when a run produces no answer.

**What this changes.** `flushTool` should not be presented as a retention win, and its default should
stay off until something shows it buying durability. The two levers that could change the result are
upstream of the flush and measurable without it: extraction coverage of short enumerables (exit codes,
env var names), and whether a session model uses what `hy_recall` hands it.

**Not proven by this:** a stronger session model, where the answer metric stops being dominated by a
4-bit 4B model dropping facts it was given; sessions long enough that pi's prose has more specifics to
lose than two; and reload survival (`/compact` then a fresh process), which this harness measures as
compaction within one process rather than a restart.

## Verdict on the offer (2026-10-27, closing the `hy_flush` thread)

Three arms measured the same claim from three sides, and they agree.

| what was claimed | arm | what came back |
|---|---|---|
| a boundary where work settled writes a better bank | 12 whole writes vs 24 settled writes | specificity flat, durable share 60 % → 51 %, bank +53 % — finer granularity, not better memory |
| a fact folded in before a compaction survives it | reload pilot, 3 runs per arm | both arms kept 7/8 in the summary; answers 7/8, 6/8, 5/8 against the control's 7/8, 7/8 |
| offering the tool is cheap | cadence, 3 runs × 3 arms | +28 % writer tokens and +13 s per session, and the extra write was threshold-triggered, not a flush |

The call profile decides it. Seven of nine ranged calls were refused at the 2 000-token floor, and
the flush-only arm left one session of three with **no write at all**: coverage is guaranteed by the
threshold, and the tool cannot replace it. So the honest reading is not that `hy_flush` hurt retention
— it is **no measured benefit, measurable overhead, and a call profile that mostly refuses** at the
floor that exists to stop fragmentation.

It ships `flushTool: false`, and that is the answer to "should it exist": as an opt-in seam, off, with
its cost written down where anyone turning it on will read it. What the experiment left behind is not
the tool but the machinery it forced into being — monotone coverage, a floor on a model-initiated
write, a queue that drains, refusal copy that says whether to ask again — and the threshold path uses
all of it. The one real win found here belongs to the *rendered* summary, not to the tool: the control
lost a run to pi's generated summary hitting its output cap, and a render cannot.

**Re-entry trigger.** The class this instrument could not reach is `/compact` followed by a **fresh
process**, where whatever landed before the restart is all a new process can read. That is a coverage
question, and the lever for it is `observeAfterTokens`, not a tool. If it is ever measured as a real
gap, `flushTool: true` is already the switch and the surface is pinned by `tools/flush-check.ts`,
`tools/flush-tool-check.ts` and `tools/flush-write-check.ts` — the choice then is whether the measured
gap repays the writer tax, not whether the code still works.

## Does the writer propose short enumerables at all? (2026-10-22, offline, item 6.10)

**Question.** The compaction-survival pilot lost facts that were stated plainly and never proposed:
`exit code 3` in one treatment run, `TOR_TOOL_SETTINGS` in two. Those are short dense shapes — a code,
an environment variable, a limit, a path, a ticket id, a rejected alternative. The claim to test is
that the writer drops them in favour of the sentence around them.

**Method.** `dev/enumerable-coverage.ts`, no model calls. It reads the chunk text the writer actually
read (`captures-dev/<session>/hy-*.json`), pulls every probe of seven categories out of it, and asks
two separate questions: did any draft proposed *for that chunk* carry the probe, and did the probe
reach the final active bank. Roles are attributed per line, and the counts are reported twice — over
all user/assistant prose, and over only the lines that read as a decision (`settled`, `chose`,
`instead`, `default`, `dropped`, …), which is the class the bank exists for. A text is claimed by the
first category that matches it, so a path is not also counted as an identifier. Runs measured against
`dev/corpus-extended.json` (12 chunks, session `01a1510e`): `trans-base` (12 chunks, 150 active facts),
`trans-clause` (the Tier-3 transition-clause variant, 148), and `halves-2026-10-21` (the same content
in 24 chunks, 240 facts).

**Decision-line scope.** Same denominator in all three, 43 probes:

| category | stated | proposed (base) | in bank (base) | proposed (halves) | in bank (halves) |
|---|---|---|---|---|---|
| exit codes and statuses | 0 | — | — | — | — |
| environment variables | 1 | 1 | 1 | 1 | 1 |
| numeric limits | 3 | 0 | 0 | 1 | 1 |
| file paths | 32 | 8 | 13 | 7 | 17 |
| identifiers | 1 | 0 | 0 | 0 | 0 |
| rejected alternatives | 6 | 2 | 4 | 3 | 4 |
| commands and flags | 0 | — | — | — | — |
| **total** | **43** | **11 (26%)** | **18 (42%)** | **11 (26%)** | **23 (53%)** |

Over all prose the totals are 451 probes stated, 73 proposed (16%), 129 in bank (29%) for `trans-base`;
`halves` proposed 98 (22%) and banked 163 (36%). Tool output carries another 1871 probes, mostly file
listings and commit hashes, and is excluded from the claim.

**Reading.** Three things, and the second one is the useful result.

1. The writer does not systematically carry limits stated as decisions: 3 numeric limits in decision
   lines, 0 proposed and 0 banked in `trans-base`, 1 of each in `halves`. Rejected alternatives fare
   better (2 of 6 proposed), paths land at a quarter, and flags and identifiers essentially never do —
   which is arguably correct, not a defect.
2. **The capture corpus cannot answer the question that was asked.** Across 12 chunks there is exactly
   one environment variable and zero exit codes in decision prose. `exit code 3` and
   `TOR_TOOL_SETTINGS` are shapes the reload conversation had to be *written* to contain. Any coverage
   number measured on organic captures is a denominator of one or three, so it cannot rank writer-prompt
   variants. This is the same limit that made item 6.8 pre-register its own corpus: a claim about a rare
   shape needs a corpus where the shape occurs by construction.
3. The finer boundary moved retention without moving proposals: `halves` proposed the same 11 decision
   probes as `trans-base` and banked 23 of 43 where `trans-base` banked 18 — 42% to 53%. Cutting the
   same content into 24 pieces instead of 12 did not make the writer notice more; it made more of what
   it noticed survive the fold to the final bank. That matches item 6.8's "53% more facts, flat
   specificity" from the other side.

**Also measured:** `trans-clause` is identical to `trans-base` on every category except chunk 001's
draft list, and identical on both scope totals. The Tier-3 transition-clause block bought zero probe
coverage.

**Next, and it is not a prompt edit.** A corpus of ~30 decision statements that carry exit codes,
environment-variable names, numeric limits and rejected alternatives by construction (item 6.12), so
3.3 has a denominator. Until that exists, "the writer misses short enumerables" is a claim measured on
three instances.

## Can the writer carry short enumerables? (2026-10-22, authored corpus, replay, items 6.12–6.13)

**Question.** Item 6.10 measured 26 % proposal coverage on organic captures, but its decision-line
denominator was 43 probes of which 32 were file paths mentioned in passing, and it held one environment
variable and zero exit codes. That cannot rank anything. So the shapes 6.4 lost were authored into a
corpus (`dev/corpus-enumerables.json`, eight chunks of an invented config CLI: 14 exit codes, 12 env-var
names, 13 numeric limits, 11 rejected alternatives, all inside decision lines), and `dev/enumerable-coverage.ts`
prints the corpus's own gate so a thin denominator fails loudly instead of quietly producing a percentage.

**Four arms, same writer (`hy-memory-30b-a3b`), decision-line scope.**

| arm | chunks | stated | proposed | in bank |
|---|---|---|---|---|
| organic captures, `trans-base` (12 chunks, 150 facts) | 12 | 43 | 11 (26 %) | 18 (42 %) |
| organic captures, `halves-2026-10-21` (24 chunks, 240 facts) | 24 | 43 | 11 (26 %) | 23 (53 %) |
| authored decisions, clean prose (`enum-base`) | 8 | 58 | 58 (100 %) | 58 (100 %) |
| authored decisions inside ~670 tokens of tool noise each (`enum-noisy`) | 8 | 55 | 55 (100 %) | 55 (100 %) |
| the 6.4 session itself, replayed offline (`reload-replay`) | 8 | 66 | 61 (92 %) | 61 (92 %) |

**The reading, which is different from what I said after 6.4.** Extraction is not blind to short
enumerables and dilution does not break them. On decision-dense prose the writer carries everything; wrap
the same decisions in tool output, warnings, test runs and unrelated chatter and it still carries
everything. Replaying the exact reload conversation from item 6.4 — the run whose bank never proposed
`exit code 3` — carries 61 of 66 probes offline, including `exit code 3` and `TOR_TOOL_SETTINGS`. The
organic 26 % is mostly the writer declining incidental mentions, which is the intended behaviour.

**What is left, and it is a granularity story.** That live treatment run made exactly one write
(`write_start` once, two flushes refused at the 2000-token floor) over a ~2 680-token window, and produced
5 drafts and 13 facts from it. The same text replayed as eight chunks of ~1 200 tokens proposed nearly
everything. Finer boundaries also retained more on organic content: same 43 probes, 18 in bank at 12
chunks against 23 at 24 — 42 % to 53 %. So the suspect is one coarse write over a long window, not the
prompt. That also re-ranks item 3.3: a specificity block has no measured target, because specificity on
decision lines is already at 100 %.

**A defect the replay found.** Chunk `hy-reload-006` failed twice with the identical parse error —
`Expected ',' or ']' after array element in JSON at position 423 (line 3 column 408)` — and the chunk was
dropped. "Retrying with a fresh extract" at temperature 0 reproduces the same truncated output at the same
position, so the retry cannot recover a truncated response; a chunk lost this way never proposes anything.
Filed as 6.14.

**Three matcher fixes this measurement forced, all in `dev/enumerable-coverage.ts`.** Retention was
literal, so `exit code 65` was scored lost when the bank held `65 = partial write`; `carried()` is now
whitespace-insensitive and, for exit codes, checks per statement rather than per phrase. Unlabeled
continuation lines of a multi-line tool result were attributed to the assistant, and now inherit the
labelled entry above them. And `rejected alternatives` was matching prose (`not just`, `not bring`), so its
stop-word list is now real; before the fix that category reported 50 % coverage in the replay and 92 %
after, and the 50 % was measuring English.

**Not proven by this:** that granularity is what lost the probe live — that is a hypothesis from one
session and a consistent organic contrast, and it needs a live arm with a smaller chunk budget to confirm;
and whether the parse-failure chunk cost a probe in the live run, which the audit does not say.
