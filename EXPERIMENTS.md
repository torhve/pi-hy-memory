# Experiments log

All runs use the committed harness (`dev/TODO.md` phases) against the captured
corpus (5 chunks from two real sessions: short planning, dense implementation
×2, many-draft, follow-up). Bank is cumulative and corpus order is sequential,
exactly like production. Raw transcripts and per-run outputs stay local
(`captures-dev/`, `out/` — gitignored); this file records only numbers.

## Run: `baseline-remote` (2026-10-19)

Writer `remote/hy-memory-30b-a3b`, temp 0, `no_think`, pool 12000, 600 s call
timeout. Current `src/prompts.ts`, current protocol (global 12-candidate
render, per-draft scoring cap 8).

| chunk | drafts | ADD/UPDATE/DELETE | starved / no-cand | bank (active) | growth | wall |
|---|---|---|---|---|---|---|
| 15629-001 | 7 | 7/0/0 | 0 / 0 | 0→7 | 0.172 | 137 s |
| 15629-002 | 10 | 9/1/0 | 0 / 5 | 7→16 | 0.082 | 193 s |
| 1510e-077 | 10 | 10/0/0 | 0 / 9 | 16→26 | 0.182 | 108 s |
| 1510e-016 | 28 | 28/0/0 | 0 / 11 | 26→54 | 0.137 | 406 s |
| 1510e-012 | 8 | 8/0/0 | 0 / 1 | 54→62 | 0.041 | 219 s |
| **total** | **63** | **62/1/0** | **0 / 25** | **62 active / 4835 tok** | mean 0.123 | 1063 s |

Baseline observations before judging:

- **No draft was starved by the 12-entry cap** in this corpus: the cap only
  bites at larger banks, so Tier-1's per-draft-budget fix must be gated on a
  larger-bank arm, not on this corpus alone.
- **25/63 drafts (40 %) found zero candidates** — retrieval scoring is the
  dominant behavior at this bank size. With no candidates shown, the model
  cannot dedup: every such draft becomes an unconditional ADD.
- **1 UPDATE and 0 DELETE across 5 chunks**: reconciliation never transitioned
  the bank. Judge verdicts decide whether the bank accumulated duplicates or
  the corpus simply held no supersessions.
- Confidence inputs: 100 % at exactly 1.0 pre-bank (E1's baseline number).

## Transport findings (harness-affecting, possibly production-affecting)


- Kitx saturation incident (extended arm): after 2 successful chunks, all 30
  remaining attempts died in ~7 s each with AbortError - HTTP/2 streams reset
  while remote's upstream queued, and even a plain curl probe hung past 120 s.
  Route health is a measured variable, not a constant. The Tier-1 arm trio
  therefore runs on the local llama-swap writer (`baseline-extended-local`,
  `tier1-perdraft-local`, judged against each other); remote remains the later
  confirmation route for whatever wins. Partial remote data retained: chunks
  001-002 gave 15/36 drafts (42 %) with zero bank candidates at a 36-entry
  bank and 36/36 unconditional ADDs - the Tier-1 target failure signature
  reproduced before the transport died.
- Wedged-writer root cause (the saturation above, now traced): a documented
  chain, not random. (1) llama-server does not cancel generation when the
  client disconnects - orphaned generations hold slots until context exhausts,
  non-streaming included (llama.cpp #24496; PR #26242 addresses drop-stop).
  Our own first remote baseline seeded exactly this: three 300 s client aborts
  of 400 s extracts (the hidden headers cap, since raised) left orphans
  holding 131 k-context slots. (2) On AMD/RDNA-class backends a client abort
  while another request is in flight deadlocks the whole server: everything
  hangs, /health dies too, SIGTERM ignored - only SIGKILL works (llama.cpp
  #27604). That matches the incident ending: manual `kill -9`. (3) Queued
  clients disconnecting can also cancel the *active* decode - cancel cascade
  (ik_llama.cpp #1929, ungated `llama_decode_stop` call sites). Meanwhile
  llama-swap's defenses are startup-only: `healthCheckTimeout` never watches a
  ready model, and `timeouts.responseHeader` defaults to 0 = hold forever on a
  wedged upstream. Hardening stack (priority order): fix our client-side
  abort sources (production's hidden 300 s cap first); per-model
  `timeouts.responseHeader` > 0, small `concurrencyLimit` (fast 429 instead of
  deep queues full of disconnecting connections), `filters.setParams`
  `max_tokens?` cap, `cmdStop: kill -9 ${PID}` (wedged builds ignore SIGTERM),
  optional idle `ttl` to reload clean; if the served build lacks `--watchdog`
  (present in forks/older servers, absent from current upstream README - check
  `llama-server --help`), a systemd probe on llama-server's own port (health
  + tiny completion, bypassing the proxy queue) SIGKILLs the wedged process -
  llama-swap restarts it on the next request. Forensics for the next incident:
  `logToStdout: proxy,http,upstream` + `logTimeFormat: rfc3339`.
  Sources: github.com/ggml-org/llama.cpp/issues/24496, /issues/27604,
  github.com/ikawrakow/ik_llama.cpp/issues/1929, llama-swap docs/config.example.yaml.
- Non-streaming llama.cpp completions emit response headers only when
  generation completes. Node's bundled undici aborts HTTP/2 waits with
  `headersTimeout: 300000`, which silently killed every remote extract whose
  total generation exceeded 300 s (`chunk 016` failed 3× before the fix,
  succeeded in 387 s after raising the dispatcher cap).
- After a client-side abort, llama-swap keeps processing the abandoned
  request; an immediate retry collides with it (`429 concurrency_limit`).
  The runner now backs off 45 s between attempts.
- **Open production question**: pi's own completions path
  (OpenAI-completions provider) rides the same Node fetch stack; a production
  remote extract > 300 s may hit the same cap despite the 600 s configured
  timeout. Verification planned via the registry path; if confirmed, a fix is
  its own measured change.

## Cost model (measured)

Same chunk `15629-001` (10.9 k-tokens window, 5.5 k-token extract call):

| route | extract+reconcile wall | extract in/out tokens |
|---|---|---|
| local `hy-memory-30b-a3b` (warm) | 30.3 s | 5522 / 1365 |
| `remote/hy-memory-30b-a3b` | 137 s | same payload |

remote ≈ 4–5× slower wall on identical payloads; token counts identical.
Corpus run ≈ 18 min remote vs ≈ 4 min local (local also avoids per-call cost).

## Judge

`dev/judge.ts` + `dev/rubric.md`, blind per-op judging, op order shuffled per
seed, judge model local `qwen3.8-27b-q6` (never the writer model; the 35B MoE
judges tried first crashed llama-swap's upstream), temp 0.

Judge transport: judging must never evict the writer model from the shared
llama-swap (a shared-instance judge run was killed for exactly that). The
standing judge route is now a separate machine's llama.cpp endpoint
(`qwen3.8-flash-next-iq3_xxs`, reasoning suppressed with `no_think`, 168k ctx)
via `JUDGE_ORIGIN` / `JUDGE_KEY` / `JUDGE_MODEL`, taken from pi's own
`models.json` at runtime. Judges and writer arms therefore run concurrently.
Standing judge model now: local `qwen35-9b-summar` (non-reasoning). Current
standing pair for baseline-remote (`judge-seed7.json`, `judge-seed11.json`):
supported 59-60/63 full, 0-4 partial, 0 unsupported; durable 53-58, marginal
1-8, noise 1-2; mean specificity 2.25-2.75; missed 29 per run. Same story as
the 27B-judge pass below.
- seed 7: 63 ops (1 unparsable), full 62 / none 0, durable 61, mean specificity 2.47, noise 0, missed 30.
- seed 11: 63 ops (3 unparsable), full 60 / none 0, durable 58, mean specificity 2.42, noise 1, missed 29.
- **Reproducibility (done-when): supported+durability agreement 96.6 % across seeds; mean-
  specificity delta 2.1 %; missed delta 3.3 %. PASS.**
- Baseline verdict: the writer's adds are grounded, specific and near-noise-free, but the
  bank **misses ~6 durable facts per chunk** — coverage, not precision, is the failure mode.
  Judge misses concentrate on embedded constraints and metrics stated inside tool output
  rather than user turns.


## Extended-arm A/B and the Tier-1 merge (2026-10-20)

Arms, local writer, temp 0, 12-chunk extended corpus (`dev/corpus-extended.json`):
`baseline-extended-local` (union shown-set) vs `tier1-perdraft-local`
(perDraft shown-set + zero-candidate markers).

Coverage (offline replay, `dev/coverage-report.ts`, no model calls):
starved drafts 38/185 = 20.5 % → 4/179 = 2.2 %; the residual is pure cap
arithmetic on chunk 016 (27 candidate-having drafts, 12 slots). Reconcile
input tokens 35,527 → 33,201 (−6.5 %).

Blind judge (remote `qwen3.8-flash-next-iq3_xxs`, seeds 7 and 11):

| axis | baseline s7 / s11 | perDraft s7 / s11 |
| --- | --- | --- |
| ops | 182 / 182 | 177 / 177 |
| supported full / partial / unsupported | 138/44/0 · 124/48/0 | 133/44/0 · 130/47/0 |
| durable / marginal / noise | 119/36/27 · 109/33/30 | 112/27/38 · 119/30/28 |
| mean specificity | 2.79 / 2.61 | 2.81 / 2.76 |
| missed durable facts | 102 / 100 | 100 / 93 |

Zero unsupported writes in every pass. The seed-7 noise bump (+11) was
disproven by seed 11 (−2): noise ranges overlap and seed variance on this
axis (±10) dominates the arm difference. Noise anatomy is shared by both
arms and concentrates in chunk 006, the big refactor chunk: the extract
writes granular diff/test-edit bookkeeping about *intermediate* states
(removed test lines, line numbers, renames) and never records that the
artifact itself was deleted later in the same chunk — the exact target class
of E2 (transitions) and E3 (should-not-store traps).

SKIP: zero uses in both arms. The plumbing is verified end-to-end
(`tools/skip-op-check.ts`), but the model does not reach for the vocabulary
at temp 0; its fate belongs to E3, not to Tier-1.

Gate verdicts:
- starved drafts ≤ 10 %: **PASS** (2.2 %).
- reconcile tokens ≤ baseline + 20 %: **PASS** (−6.5 %).
- no rejection/noise regression: **PASS** (unsupported zero, noise within
  seed variance, missed slightly improved).

**Merged**: `candidateRenderMode` defaults to `perDraft` in production
(`src/config.ts`); `union` remains selectable for experiments. SKIP stays
in the op vocabulary, dormant.

## Run: chunk size (`split-chunk`, 2026-10-20)

Motivation, from the paper (arXiv 2610.22196): the writer is trained on chunks of
"about ten turns" with a 4 096-token OPD prompt budget, and its annotation study found
less context produces *more specific* facts (two-chunk context: +25 % proper nouns,
+59 % numbers per fact versus full history). Our captures carry ~10 turns but 18–24 k
prompt tokens, i.e. 13–24 k stored tokens.

Extract-only arm (`dev/split-chunk.ts`): the same capture extracted once whole, then
split at entry boundaries into ~4 500-token windows. Route: whichever endpoint
`resolveRoute("hy-memory-30b-a3b")` picks — the remote one, because both LAN writer hosts
were down for this run; temp 0, `no_think`, current `src/prompts.ts` (post-`confidence`),
per-window `maxTokens` 8 000. Both arms share the route, so the comparison holds; the
absolute wall times are that route's, not the local instance's ~30 s/chunk. Reconcile is
deliberately out of scope: this compares what the writer *saw*.

| capture | entries | tokens | full facts | split facts | anchors/fact full→split | numbers/fact full→split | in tok full→split | wall full→split | full facts re-found |
|---|---|---|---|---|---|---|---|---|---|
| 012 | 93 | 20 052 | 10 | 41 | 5.80 → 6.29 | 2.20 → 1.98 | 23 534 → 24 702 | 194 s → 57 s | 8/10 |
| 006 | 166 | 17 857 | 15 | 33 | 6.60 → 6.24 | 3.27 → 2.55 | 21 860 → 23 028 | 77 s → 46 s | 12/15 |
| 007 | 127 | 18 444 | 16 | 46 | 6.94 → 5.41 | 3.06 → 2.22 | 21 184 → 22 352 | 87 s → 55 s | 13/16 |
| **total** | | | **41** | **120 (2.9×)** | 6.45 → 5.98 | 2.84 → 2.25 (120 → 267 total) | 66 578 → 70 082 (+5 %) | 359 s → 158 s (−56 %) | **33/41 (80 %)** |

Out tokens 5 062 → 13 990; generic facts 3 % → 2 %; exact duplicates 0 in both arms;
mean statement length 221–350 (full) vs 248–295 (split) chars, i.e. shorter facts, not
vaguer ones.

Reading:

- **Coverage is what splitting buys**, and it is what the judge says we lack (~6 durable
  facts missed per chunk): 2.9× the facts for a flat input bill.
- **Per-fact density drops slightly** (anchors −7 %, numbers −21 %) — the opposite
  direction from the paper's annotation result — but total specific content rises
  2.2–2.7×, and the remaining generic share is lower.
- **It is not a superset.** One fifth of the wide-window facts (cross-window decisions,
  mostly) are not re-found, so the arms read the same history differently. Narrower
  windows cost the "why" that spans a boundary.
- **Wall time halves serially**, five small prefills against one 20 k prefill.

Gate: facts ≥ 1.5× (PASS, 2.9×), input tokens ≤ +20 % (PASS, +5 %), specificity not
materially worse per fact (PASS, −7 % anchors; numbers −21 % but 2.2× the total), wall not
worse (PASS, −56 %).

**Shipped**: `maxChunkTokens` 24 000 → **6 000** (the size the split arm tested). A larger
pending window is written as consecutive chunks, oldest entries first, drained by the
existing chain (≤2 per turn) — no new mechanism. Not yet run end-to-end at 6 000 with
reconcile, which is where narrower chunks could cost updates.

## Run: candidate limit 12 vs 24 (`limit12` / `limit24`, 2026-10-20)

Six-chunk subset of the extended corpus (`dev/corpus-limit.json`: 001, 011, 014, 016, 017,
018 — the chunks with the largest banks, 016 being the 27-candidate case), same prompt
(post-`confidence`), same route, temp 0, `no_think`, per-draft render, pool 12 000. Only
`--candidate-limit` differs. No judge: the question is op mix and cost, both ledger facts.

| axis | limit 12 | limit 24 |
|---|---|---|
| drafts | 86 | 86 |
| ADD / UPDATE / DELETE / SKIP | 77 / 9 / 0 / 0 | 75 / 11 / 0 / 0 |
| drafts with no candidate at all | 20 | 20 |
| starved (candidates, none shown) | 0 | 0 |
| rejected / downgraded ops | 0 / 6 | 0 / 7 |
| reconcile input tokens | 16 777 | 20 766 (+24 %) |
| extract input tokens | 108 765 | 108 765 |
| wall, both calls | 206 s | 209 s |
| bank after | 77 active / 5 979 tok | 75 active / 5 869 tok |

Offline replay of the *full* 12-chunk ledger, which is where the cap actually binds (this
subset starts from an empty bank, so 016 sees 30 entries instead of 109):

| limit | perDraft starved | shown tokens/chunk |
|---|---|---|
| 12 | 4 (2.2 %) | 982 |
| 16 | 1 (0.6 %) | 1 288 |
| 24 | **0** | 1 746 |
| 32 | 0 | 2 085 |

Reading: the live arm shows the direction without the magnitude — +2 UPDATEs (9 → 11), a
slightly smaller bank, and no wall-clock cost — because this subset never has enough
candidates on screen for the cap to bite. The replay is what justifies 24: it removes the
last starved drafts for ~770 extra shown tokens per chunk. `no-candidate` drafts do not move
at any limit, because that is lexical retrieval finding nothing, not the cap.

**Shipped**: `candidateLimit` 12 → **24**.

## Run: the bank split into store + summary (2026-10-20)

Offline, deterministic: fold the longest production ledger (32 chunks, 446 entries, 408
active, 29 357 tokens of facts) and compare the compaction summary under the old and new
rules. No model calls, so nothing here is a quality judgement — it measures what the reader
*would be shown*.

| rule | cap | facts shown | omitted | oldest fact (chunks back) | median age | chunks represented |
|---|---|---|---|---|---|---|
| newest-first over a bank trimmed to the cap | 6 000 | 84 | 0 | **7** | 4 | 8 |
| stratified over the whole bank | 6 000 | 122 | 286 | **20** | 5 | 13 |
| stratified, shipped default | 8 000 | 142 | 266 | 12 | 6 | 13 |

Reading:

- The old path is two losses stacked: `enforceBudget` cut 408 facts to 84 *before*
  `renderMemory` ran, and then admitted them newest-first. The new path keeps all 408 in the
  bank and spends the same cap choosing better.
- At the same 6 000-token cap the stratified rule reaches 20 chunks back instead of 7 and
  shows 45 % more facts, because the foundation slice spends budget on facts the recency
  walk never surfaced.
- The larger shipped cap reaches *less* far back (12 chunks) than 6 000 does: with 35 % of a
  bigger budget reserved for foundations and the rest newest-first, growth goes to current
  state. That is the intended trade, not a regression — but it means `summaryMaxTokens` is a
  real knob, not a size to maximise.

Caveats: the constraint slice is inert on this ledger, because `fromUser` is recorded at
write time and this session predates the split (0 of 408 facts). The blind judge pass (does
the older reach actually help the reader?) is pending — the judge endpoint was down.

Gate as written: oldest kept moves 7 → 20+ chunks at an equal cap. PASS.

## Diagnosis: why transitions misfire (2026-10-20)

Offline over the 44 production session ledgers (1 588 drafts, 131 ops records). No model
calls: every number here is a replay of what the writer actually did.

**Q1 — is retrieval the bottleneck?** No. The key-exact scoring experiment (any draft key
equal to an entry key → 1.0; a key appearing in the entry text → 0.75; ties to the newer
entry) moved "a subject-matching candidate was shown" from 725/1 588 (45.7 %) to 730
(46.0 %): 7 drafts gained a match, 2 lost one, 838 shown sets changed. Reverted — 100 % of
drafts already carry model-emitted keys, and the old flat 0.5 lift was already enough. The
real retrieval gap is lexical blindness: **28.5 % of drafts retrieve nothing at all**, which
key scoring cannot fix.

**Q2 — are our guards rejecting legitimate updates?** No, mostly. 133 updates were
downgraded to ADD: 79 by the per-draft target guard ("target not retrieved for this draft")
and 54 by `sameSubject`. Of the 54 auditable per-draft rejections, only **7 (13 %)** would
have passed `sameSubject` — the other 47 were wrong-subject targets the model reached for
while looking at a flat candidate list. The guards are doing their job. The exception is
`sameSubject` itself: 8 of its 54 rejections hit a removal draft, which is the one class
where "restate every part that is still true" cannot apply.

**Q3 — so where do removal drafts end up?** 109 drafts mention a removal or obsolescence:

| outcome | count |
|---|---|
| ADD, with a subject-matching candidate on screen | 59 |
| downgraded UPDATE→ADD (8 sameSubject, 18 per-draft guard) | 26 |
| UPDATE | 13 |
| nothing retrieved | 9 |
| omitted | 2 |

The plumbing works; the model simply prefers ADD, and our own "the draft must restate every
part of the candidate that is still true" rule gives it a reason to: a removal draft
restates nothing. That is the hypothesis the prompt A/B below tests.

## Run: transitions prompt clause (2026-10-20) — rejected

Hypothesis from the diagnosis: removal drafts become ADDs because our own "when you
UPDATE, the draft must restate every part of the candidate that is still true" rule gives
the writer a reason to avoid UPDATE — a removal restates nothing. So one clause was added
to the reconcile prompt: *"a draft saying the candidate's subject was removed, deleted,
renamed, replaced, cancelled or is no longer used IS the update; nothing needs restating."*

12-chunk extended corpus, same model/route/limits, only that clause differs, both arms on
the fixed JSON path (`repairJson` + one re-ask), 0 failed chunks in either arm:

| | trans-base | trans-clause |
|---|---|---|
| drafts | 181 | 179 |
| ADD / UPDATE / DELETE / SKIP | 150 / 28 / 0 / 0 | 148 / 27 / 0 / 0 |
| downgraded UPDATE→ADD | 38 | 36 |
| removal drafts | 24 | 24 |
| — of those: ADD / UPDATE / omitted | 18 / 5 / 1 | 18 / 5 / 1 |
| reconciled share | 21 % | 21 % |
| bank after | 150 facts / 11 157 tok | 148 facts / 11 166 tok |

**No effect.** The model still attempts an UPDATE on roughly two thirds of removal drafts
(5 accepted + 11 downgraded on both arms), and those attempts are then rejected by
`sameSubject`, which is behaving correctly: a removal draft does not restate what remains
true, so replacing the target would lose the facts that are still valid — the
secondary-fact-loss failure the guard exists for. Adding pressure on the reconcile side
cannot fix a draft that is not a full replacement, and the extract side is what writes the
draft.

Reverted; the prompt is unchanged.

What this leaves for the transition problem: the fix has to make the *draft* a full
replacement ("X was removed; Y and Z remain"), which is an extract-side instruction, or give
the writer a non-atomic op it does not have (a partial supersede). Both are open. The one
thing measured here is that prompting the reconcile call harder is not it.

## Run: prune signal from the executor model (2026-10-20)

The proposal: the session's own model knows which threads it has finished, so before a
compaction it could mark bank facts whose work is over, and those could be dropped. After the
first compaction the bank is already in its context, so the review is cheap in *input*.

Three calls (`dev/prune-signal.ts`, one 32-chunk bank, 408 active facts). Gate: a model that
says "keep" for nearly everything gives nothing to rank with — `confidence` (965/996 at 1.0)
and `stability` (60/65 `detail`) both died that way.

| run | model | facts | format | closed | keep | invalid ids | in/out tok | wall |
|---|---|---|---|---|---|---|---|---|
| 1 | `deepseek-v4-pro` (reference only) | 408 | id + reason | 165 (40.4 %) | 59.6 % | 0 | 40 484 / 24 773 | 258 s |
| 2 | `qwen3.8-flash-next-iq3_xxs` | 408 | ids only | **408 (100 %)** | 0.2 % | 1 | 42 302 / 4 774 | 101 s |
| 3 | `qwen3.8-flash-next-iq3_xxs` | 60 (even sample) | id + reason | **26 (43.3 %)** | 56.7 % | 0 | 6 336 / 841 | 59 s |

Run 4 (same model, 408 facts, id + reason) failed with `unbalanced JSON object` — the output
overran and the object never closed. So the executor's format limit is the number of verdicts
it can emit in one answer, not its ability to judge.

Reading:

- **The signal is real at batch size.** 43.3 % closed out of 60, 0 invalid ids, and the reasons
  are exactly the intended class: "audit subagents completed; findings integrated", "script
  error fixed and rerun", "dead code identified … later resolved". That is not a model grading
  its own importance; it is reporting closure of work it can see.
- **It does not scale in one call.** `ids only` invites enumeration (100 % closed), and
  `id + reason` overruns the output budget at ~400 facts. A real integration must batch
  (~60–100 facts per call), which means 4–7 calls for this bank.
- **Where pruning would land** (60-fact sample): 3 of the 26 closed facts are in the summary,
  23 are retrieved-only, 0 are invisible. So batching buys retrieval-noise reduction far more
  than summary space — consistent with the bank census above (35 % shown / 64 % retrieved-only
  / 1 % invisible).
- **Cost**: 59 s and 7.2 k tokens for 60 facts. Six batches ≈ 6 min and ~43 k tokens for this
  bank — affordable occasionally, not per compaction.

Verdict: viable as a **batched, opt-in review**, and the evidence does *not* support making it
an automatic deletion path — nothing here measures whether the closed set is safe to forget.
Cheaper and safer first use: feed the verdicts to the summary selection (rank, not delete), and
only tombstone behind an explicit command.

## Run: hi-fi compaction against the session model (2026-10-21)

The proposal: at a compaction, ask the session's own model to *write* the checkpoint — pi's
six sections — from the bank delta plus the kept tail, instead of rendering the bank. The
question was whether a quantised local model can do that at all.

One real session (`01a1510e`, 5 895 branch entries, 408 active facts, 11 842–12 075 input
tokens per request, 64–70 facts offered, 43 tail lines):

| arm | reasoning | max tokens | output | text blocks | verdict |
|---|---|---|---|---|---|
| 1 | `"none"` (not a pi level) | 2 000 | 2 000, stop `length` | 0 | rejected |
| 2 | `off` | 2 000 (server default; the flag was swallowed) | 2 000, stop `length` | 0 | rejected |
| 3 | `medium` | 6 000 (flag swallowed again — zsh does not word-split) | 2 000, stop `length` | 0 | rejected |

Three identical failures, and the mechanism is in pi-ai's own source
(`api/openai-completions.js`):

> Reasoning and the answer share `max_tokens` here, so an uncapped reasoning phase can
> consume the whole response and leave no answer and no tool call.

and, one block earlier: when no reasoning is requested, pi sends a reasoning field **only if
the model declares `thinkingLevelMap.off`** and `compat.supportsReasoningEffort`. A local
reasoning model with neither gets *no* reasoning field, so the server applies its own default
— which for a thinking model is "think". The probe confirms it: the payload carried no
`reasoning_effort`, no `chat_template_kwargs`, no `enable_thinking`, and `usage.reasoning`
reported 0 while 2 000 output tokens vanished.

So the failure is not the model being unable to summarise. It is the request never telling
that particular server to stop thinking, and the answer budget being shared with the thinking.
The endpoint had already told us its vocabulary when an earlier call sent `no_think`:
*"unknown reasoning effort 'no_think': use none, low, medium or high"* — pi's levels are
`off, minimal, low, medium, high, xhigh, max`, and `off` is not a value that server accepts.

### …and what fixed it (2026-10-21)

Same session, same model. Two changes, in order, each measured separately.

| arm | what the request said | stop | output tok | verdict | ids cited | sections |
|---|---|---|---|---|---|---|
| 4 | `enable_thinking: false` top level (`thinkingFormat: qwen`) | `length` | 2 000 | rejected | 0/64 | 0/6 |
| 5 | `reasoning_effort: "none"` (`thinkingLevelMap.off`) | `length` | 2 000 | truncated | 34/64 | 5/6 |
| 6 | `chat_template_kwargs.enable_thinking: false` (`qwen-chat-template`) | `length` | 2 000 | truncated | 38/64 | 6/6 |
| 7 | arm 6 with 4 000 tokens | `length` | 4 000 | truncated | 49/64 | 6/6 |
| 8 | arm 7 **plus the budget named in the prompt** | **`stop`** | **1 847** | **accepted** | 34/64 | 6/6 |
| 9 | arm 8 at a 2 500-token cap | `stop` | 1 848 | accepted | 22/64 | 6/6 |

Arm 4 is the interesting negative: `enable_thinking` is the *obvious* Qwen switch and this
server ignored it. The two that worked speak two different dialects — an OpenAI-style
`reasoning_effort` and a chat-template kwarg — and only one of them is what pi auto-detects.

Arm 7 → 8 is the one that mattered. Raising the cap from 2 000 to 4 000 did not help: the model
wrote 12 333 characters and stopped mid-line anyway, because nothing told it there was a limit.
Naming the limit in the prompt — *"the whole checkpoint must fit inside about 4 000 tokens, and
it must finish"* — made it stop by itself at 1 847 tokens, **less than half the cap**, with the
same section coverage and no invented ids. Arm 9 shows the cap is a ceiling and not a target: at
2 500 the answer was the same length.

The accepted checkpoint (5 783 characters) is not a summary of a transcript. It carries the
commit hashes, the mutation-test results ("mutation A → 6 fail"), the reason a refactor was
skipped ("~8–9 props to remove 30–40 lines increases review surface"), and unfinished work
marked blocked for a specific reason. That is the thing the render cannot write.

Estimator note: 4 000 server output tokens corresponded to 1 441–3 078 tokens by `estimateTokens`
(`chars / 4`) depending on arm. For markdown dense with hex ids and code identifiers the estimate
under-counts by roughly 30 %, which matters for `hifiDeltaTokens` and `hifiTailTokens` too.

### The re-offer is the expensive part, and bounding it buys coverage (2026-10-21)

The second real boundary was accepted (1 955 output tokens, 6/6 sections, no invented ids) but
cited only **11 of the 71 facts it was offered**. The self-healing rule — re-offer anything the
last checkpoint dropped — therefore never stops firing, and the delta budget is where it lands.

Composition of the delta on the 408-fact bank, 6 000-token delta budget:

| boundary covers | new facts offered | repeats offered | repeat share of budget |
|---|---|---|---|
| last 2 chunks | 16 (1 767 tok) | 52 (4 206 tok) | 70 % |
| last 4 chunks | 40 (3 602 tok) | 27 (2 387 tok) | 40 % |
| last 8 chunks | 45 (3 879 tok) | 22 (2 110 tok) | 35 % |

A bound was the obvious fix, and the first measurement said it did nothing: with `retryLimit` 3
versus unbounded, each boundary still offered ~64–79 facts and still spent the whole 6 000
tokens. Because 408 active facts cannot fit in 6 000 tokens, the delta is *always* saturated by
facts the checkpoint has not cited — bounding one set just lets another set in.

So the metric is not cost, it is **how many distinct facts the model ever sees**. Four simulated
boundaries on the real bank, same budget, citation behaviour emulated at the measured rate
(~35 of what is shown kept):

| retry limit | distinct facts shown over 4 boundaries |
|---|---|
| unbounded | 103 of 408 |
| 3 | **166 of 408** |

Same tokens, 61 % more of the bank actually offered to the model. Without a bound the same old
facts keep winning — they are exactly the "old, never-superseded" class the stratified selection
reserves a share for — and 305 facts are never shown at all. `hifiRetryLimit: 3` retires a fact
after three attempts, and the fact remains in the bank and recallable.

Caveat kept honest: the four-boundary table is a simulation over the real bank with the model's
measured citation rate substituted for the model. The single-boundary numbers above are live.

## Run: the writer route moved to strata-poly (2026-10-21)

`remote/hy-memory-30b-a3b` now serves PolyStrata's `strata-poly` engine; the llama.cpp profile
is still on the same box as `hy-memory-30b-a3b-llamacpp`. Replayed the baseline chunk
`hy-01a15629-001` (10 entries, 5 480-token extract call, temp 0, `no_think`, 8 000-token cap)
through `dev/run.ts`: four runs on strata-poly, two on llama.cpp, against the 2026-10-19
baseline for the same chunk.

| route | runs | drafts | extract out tok | extract wall | chunk wall |
|---|---|---|---|---|---|
| strata-poly, via proxy | 4 | 6, 7, 7, 8 | 1 243 / 1 336 / 1 291 / 1 488 | 84.3 / 88.0 / 86.7 / 97.2 s | 92.0 / 96.7 / 95.1 / 106.4 s |
| llama.cpp, same box | 2 | 7, 7 | 1 361 / 1 366 | 183.5 / 117.7 s | 193.8 / 128.1 s |
| llama.cpp, 2026-10-19 baseline | 1 | 7 | 1 475 | 126.0 s | 137.1 s |

**The engine is faster and the write path is unaffected.** ~1.4× on the chunk (92–106 s against
128–194 s today and 137 s in the baseline), and the proxy adds nothing measurable — the spread
between two runs of the same engine is explained by output length, not the hop. Zero rejected or
unparsable ops on any run. The llama.cpp first run (183.5 s) carries the model-swap penalty; its
second run is the fair number.

**It is not deterministic at temperature 0.** The extract prompt was identical by construction
across all six runs — 5 480 input tokens every time — and strata-poly answered with 6, 7, 7 and
8 drafts, 1 243 to 1 488 output tokens. llama.cpp answered 7 and 7, output counts 5 tokens apart.
Consequence: one run per arm no longer separates writer settings on the strata route, and
several earlier arms in this file were measured that way. Repeats are required now. The 96.6 %
agreement gate measures the judge, not the writer.

Failover is unchanged and still real: primary `remote/hy-memory-30b-a3b` (strata-poly) and
fallback `hy-memory-30b-a3b` (llama.cpp hybrid) are different engines on different hardware.

## Finding: `no_think` is not a reasoning effort (2026-10-21)

`chatTemplateKwargs: {reasoning_effort: "no_think"}` was the value in the shipped config, the
README and the dev harness. Probed against both profiles on the same box:

| engine | `reasoning_effort: "no_think"` | `reasoning_effort: "none"` |
|---|---|---|
| strata-poly | **HTTP 400** — `unknown reasoning effort 'no_think': use none, low, medium or high` | 200 |
| llama.cpp `b11583` | 200, **ignored** | 200 |

`no_think` is a Qwen prompt directive, not a member of the `none / low / medium / high` enum. So
it never did anything on llama.cpp — the writer's chat template has no `reasoning_effort`
variable, and llama.cpp discards kwargs it does not know — and it is a hard client error on the
Strata engine.

That matters more than a wrong log line, for two reasons:

- `isFailoverError` deliberately does **not** fail over on 400: a client-shaped rejection means
  the request is wrong, not the model. A 400 writer call therefore fails, leaves the watermark
  where it is, and retries the same broken request forever.
- `dev/raw-writer.ts` has retried every 400 without `chat_template_kwargs` since 0.1.0. So every
  dev measurement in this file ran with the kwarg dropped, and none of them ever measured the
  reasoning suppression they thought they were measuring. Harmless for a non-reasoning writer,
  but the harness hid a live failure.

Fixed to `none` in the config, README, DESIGN, `src/llm.ts` and the dev harness. Left as a
historical label only in `dev/export-judge.ts`, which describes what the captured payloads were
sent with.
