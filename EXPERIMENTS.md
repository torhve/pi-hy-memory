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
  while the remote route's upstream queued, and even a plain curl probe hung past 120 s.
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

## Run: hi-fi compaction against the session model (2026-10-20)

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

### …and what fixed it (2026-10-20)

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

### The re-offer is the expensive part, and bounding it buys coverage (2026-10-20)

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

## Run: the writer route moved to strata-poly (2026-10-20)

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

## Finding: `no_think` is not a reasoning effort (2026-10-20)

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

Validated after the fix: the same chunk through strata-poly with `reasoning_effort: none` gave
7 drafts, 0 rejected ops, 108.6 s — inside the 92–106 s spread above. Across five strata runs
the draft counts are 6, 7, 7, 8, 7 (mean 7.0), which is the same mean llama.cpp produced.

## Run: a late `/hy on` discarded 450 694 tokens, then lost them (2026-10-20)

The footer of a long-running session read `hy ▕████████▏ 429k/6k`. Not a rendering fault: the
audit agrees, `pendingTokens` 428 612 → 407 108 across the last eight chunks. The window held
2 438 entries the writer had never read.

**What the session actually did.** `session_start` 08:14, `/hy off` 09:16 (with a write in
flight), then eight hours with the extension off. `/hy on` at 17:08 computed the discard
correctly — `skipped_while_off {entries: 2783, tokens: 450694}` — and eighteen minutes later
428 612 tokens were pending again. The session was replaced at 17:08 (`session_shutdown` →
`session_start` 17:09), and the gap did not survive it: `ledgerFromSession` recognised
`hy.extract` and `hy.ops` only, and `reset()` takes whichever ledger copy is longer — the
session's custom entries held 55 records against the mirror file's 46, so the copy that could
not express a gap won.

**Consequence, measured from the session file.** 3 483 entries, 12 compactions, and only two of
them (`compact` audit events at 09:04 and 09:18) were hy-memory's. Every compaction after the
re-enable — threshold at 17:50, manual at 17:51, the compaction itself at 17:53 — fell back to
pi's own summariser, because `compactionBoundary` would have dropped 395 492 unread tokens past
the 6 000-token bound. The defer rule was right; the state forcing it was not.

**Swap-side cross-check.** The llama-swap activity API for the same window shows 122 completed
requests on `hy-memory-30b-a3b` (llama.cpp, 40–122 s each) and **zero** on
`remote/hy-memory-30b-a3b`: after two `Stream ended without finish_reason` failovers the session
ran entirely on the fallback.

**Fix.** The gap is appended as a session entry as well as mirrored, and `ledgerFromSession`
reads `hy.gap` back. `tools/gap-reload-check.ts` replays off → on → reload with the session copy
ahead of the mirror: 0 tokens pending with the fix, 37 000 with the gap reading disabled, and a
catch-up write fires in the second case.

**Still open.** `append_failed` at 17:29 (chunk `hy-01a15860-011`): *"This extension ctx is
stale after session replacement or reload"* — the write path appends with a captured ctx, which
is also why the mirror file trails the session entries. And the drain rate: `MAX_CHAIN = 2` with
90–122 s per chunk shed 21 504 tokens in 21 minutes, about 1k/min against a 407k backlog.

## Experiment: ratification as a durability class (offline part done, 2026-10-22)

**Question.** Facts the user *settled* — an assistant proposal followed by a bare
"proceed" — should survive the bank's recency cut. Can that class be derived
without asking the writer for a field it was never trained to emit?

**Why it needs measuring.** On session `01a1510e` the bank is pinned at
**59 989 / 60 000 tokens** (825 active facts, 11 tokens of headroom) and
`enforceBudget()` ranks by `createdAt` alone: 220 facts are tombstoned
`supersedeReason: "bank budget"`, all on the far side of one boundary
(`2026-10-19T14:00:40Z`, the newest evicted and the oldest active are the same
stamp). Nothing else removes facts — 113 ops records contain `DELETE: 1`,
`stats.deleted: 0`, and there is no expiry. The existing durability notion covers
almost nothing: `fromUser` is set on **7 of 825** facts and on **0** of the 220
evicted ones, because `pipeline.ts:199` marks a draft only when a cited line has
role `user`.

**Harness.** `dev/ratification-analysis.ts` — offline, no model calls. It replays a
real transcript against the extension's ledger, rebuilds the chunk windows the
writer actually saw from each `hy.extract` record's `coversUpToId`, resolves all
8 000 draft source refs against the transcript, and asks three questions: what
roles drafts cite, whether an acceptance and the proposal it settles share a
chunk, and whether that proposal reads as a decision or a progress report.

Offline numbers (`01a1510e`: 12 425 message entries, 113 chunks, 1 355 drafts, 57 user turns):

| measurement | number |
|---|---|
| drafts citing a user line | **13 / 1 355** (1.0 %) |
| drafts citing assistant prose only | 907 |
| drafts citing tool output | 1 269 |
| acceptance-shaped user turns (≤ 24 chars: `proceed`, `ok`, `go`) | **23 = 40 %** of user turns |
| proposal in the **same** chunk as the acceptance | **15** |
| proposal in an **earlier** chunk | **0** |
| acceptance with no preceding assistant proposal (it follows tool output) | 8 |
| acceptance's chunk contains a draft citing the proposal line | 9 of 15 |
| gate on the ratified proposal: decisionish / status-report / neither | 6 / 2 / 7 |
| accepted drafts citing a ratified proposal | 23 of 1 321 (~1 888 tok, **2 %** of written tokens) |

Reading before any model spend:

- **Derivable without a new field.** `refs` are the trained provenance mechanism and
  role labels are known to the extension, not the model, so the class is a lookup.
  Asking for `source: user|ratified|observed` would be a self-graded durability
  label, which the paper's schema does not have and DESIGN forbids on the prompt.
- **Ratification never crosses a chunk boundary here** — 15 same-chunk, 0
  cross-chunk — so the extract call that writes the fact does see the acceptance.
  That was the load-bearing risk, and it is not a problem.
- **The lexical gate is weak.** 6 decisions, 2 status reports, 7 neither: "proceed"
  ratifies in-progress prose ("Now the refactor itself. Reading the eight blocks
  precisely:") as often as a settled rule. Protecting everything an acceptance
  follows protects noise with it.
- **The class is small — ~2 % of written tokens.** A tier this size cannot justify a
  generous reservation; it needs a hard bound and a precise marker.

Cross-session corroboration, same harness, two more real sessions:

| session | user turns | acceptances | same-chunk / cross-chunk | gate decisionish / status / neither | accepted drafts citing a ratified proposal |
|---|---|---|---|---|---|
| `01a1510e` (dense, 113 chunks) | 57 | 23 (40 %) | 15 / 0 | 6 / 2 / 7 | 23 (~2 % of accepted tokens) |
| `01a15b90` (this session, 44 chunks) | 31 | 3 (10 %) | 3 / 0 | 3 / 0 / 0 | 16 (~3 %) |
| `01a15629` (planning, 12 chunks) | 19 | 2 (11 %) | 2 / 0 | 2 / 0 / 0 | 8 (~6 %) |

The zero-cross-chunk result holds on all three, and user-line citation is 1–2 % of
drafts in every one (13/1 355, 11/498, 5/139). Acceptance *frequency* is what varies
with session style — 10 % where the user writes sentences, 40 % where they type
`proceed` — so the tier's population is a property of how the user works, not a
constant. The gate is clean on the two shorter sessions and muddy on the dense one.

**Live arm, gate written before the run** (`dev/ratification-arm.ts`: extract-only,
like `dev/split-chunk.ts`, no bank, no reconcile; same route, temp 0,
`reasoning_effort: none`; base prompt vs base plus one clause — *"a short user turn
that only accepts what the assistant just proposed settles that proposal: store the
proposal as a constraint, and cite the line where the proposal was made"*):

- clause arm cites the ratified proposal line in **≥ 80 %** of chunks (production
  baseline was 9 of 15);
- facts and anchors/fact within **−10 %** of base — the paper's finding that more
  prompt surface makes facts generic is the tax to watch;
- **zero** unparsable JSON in either arm.

Smoke pass (2 chunks, same route, to validate the harness before the full arm): base
15 facts / proposal-cites 2 / acceptance-cites 1 / anchors 5.67; clause 12 facts /
proposal-cites 2 / acceptance-cites 3 / anchors 7.42; zero rejected drafts in either
arm, so the clause does not break the JSON path. Two things it showed: the clause
moves citations onto the *acceptance* line rather than the proposal line, and fact
count moved −20 % on n=2 — which this writer's temp-0 spread (6–8 drafts on identical
input) cannot resolve. Route wall time varied 45–397 s per call, so wall is not an arm
effect here.

Full arm (8 acceptance chunks, same route, temp 0, `reasoning_effort: none`, 16 extract
calls; two calls died on route aborts — `base/061` and `clause/080` — so the paired
comparison is 7 chunks per arm on *different* subsets):

| arm | chunks | facts | proposal-cites | acceptance-cites | anchors/fact | numbers/fact | dupes | rejected | in tok | out tok | wall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| base | 8 (7 ok) | 56 | 17 | 3 | 6.51 | 1.69 | 0 | 0 | 18 109 | 6 694 | 619 s |
| clause | 8 (7 ok) | 51 | 20 | 6 | 6.24 | 1.79 | 0 | 0 | 18 047 | 5 591 | 755 s |

Chunks where at least one draft cites the proposal line: base **4 of 7** (57 %), clause
**5 of 7** (71 %). Per-chunk citation counts are identical in the chunks where the
proposal is a decision — `078` 6/6, `079` 1/1, `091` 5/5, `126` 5→6 — and both arms are
zero in `014` and `096`, whose proposals are in-progress prose ("let me check a
real-browser assumption first", "Parity established and mutation-tested. Now sharing
the rule:").

Gate:

- **≥ 80 % of chunks citing the proposal: FAIL** (71 %). The clause does not convert the
  chunks that fail; they are exactly the ones the offline gate labelled status/neither.
- **Facts and anchors within −10 %: PASS** — −9 % overall, but that is the aborted
  clause call on `080` (5 facts). On comparable chunks it is 51 vs 51, anchors −4 %,
  numbers +6 %. No coverage or specificity tax.
- **Zero unparsable JSON: PASS** (0 rejected drafts in either arm), with two route
  aborts that are transport, not format.

The clause's one genuinely new behaviour is not a citation: on `014` it emitted a fact
the base arm did not — *"User approved proceed on B6 characterization"* — an approval
record. That is the signal the tier wants, and the arm shows the writer will state it
when prompted. It also shows the citation-based marker is the wrong key: base already
cites proposal lines in 17 drafts, and the chunks that matter most are the ones where
no draft cites the proposal at all.

**Verdict: do not change the prompt.** The durability class is derivable in code from
what the writer already emits — `sourceEntryIds` ∩ a ratified proposal line, which the
offline analysis computes (23 accepted drafts on `01a1510e`, 16 on `01a15b90`, 8 on
`01a15629`). The clause buys +3 citations and one approval fact for a schema change on
the model-facing surface that DESIGN says not to make, and it still misses the muddy
chunks. Next measurement, offline and free: replay `enforceBudget` over the real
`01a1510e` bank with a bounded ratified/user tier and check which facts survive the cut
that recency alone deletes — that is where the claim is either won or lost.


Tier replay (`dev/ratification-tier.ts`, offline and deterministic). The bank file is
already trimmed, so the cut is a no-op there; `--fold` replays the ledger instead, which
is the only state genuinely over the cap, because budget eviction is never written to
the ledger.

`01a1510e` ledger fold: **1 205 active facts / 85 708 tokens against a 60 000 cap**, 21
facts marked ratified (1 710 tokens), 8 `fromUser`.

| rule | kept | dropped | of which ratified | tier spend |
|---|---|---|---|---|
| recency only (shipped) | 841 | 364 | 4 | — |
| ratified + user tier first, 15 % bound | 840 | 365 | 0 | 2 192 |

Rescued 5, pushed out 6. What came back:

- *"User requires commit messages standalone, no plan reference (§, stage, S-number) in git history"* — a user constraint, and the clearest case for the tier
- *"Storage guard (C7) asked 'does storage exist' (localStorage only) but every replaced site checked wi…"*, *"storageAvailable() restored to check typeof window … AND typeof localStorage"*
- *"§5 dialog header: D3 blocked (no spec covers dialog scrolling …)"*, *"Run G full E2E unpiped: PLAYWRIGHT_EXIT=0; serial project 348 passed, 18 skipped"*

What went out instead: `S4: §5 D1–D4 dialogs and buttons; ~160 lines; low risk`, a test-file rename, `passwordError sources and banner`, `detectError … only names cause`. That is the intended trade — bookkeeping for settled decisions.

Reading:

- **The bound never binds.** The class costs 2 192 tokens, so any share from 10 % to 15 %
  gives the identical result. The protection is cheap: ~3.6 % of the cap for five facts
  that recency alone deletes.
- **Net capacity is not free**: 840 kept vs 841. Six facts lose their place so five
  keep theirs.
- **The class is "decisions the user accepted", not "constraints".** Two of the five
  rescued facts are work state (a run's exit code, a blocked spec), which the tier would
  keep indefinitely. Measured separately: user-stated facts alone rescue **3** facts for
  **538 tokens** (the commit-message rule, `enableQuickKeys` default, TopBar label
  unpinned in E2E); ratified facts alone rescue **5** for **1 710 tokens**. Both are
  cheap. The scope question is not capacity but what should be immortal — so protect
  both, and require UPDATE to tombstone a superseded protected fact rather than letting
  the tier accumulate stale work state.

Re-running the three modes with `--explain`, because "rescues: both 5, user-only 3,
ratified-only 5" is not coherent for a union rule. It isn't, and the reason is the
metric, not the rule.

Protected candidates in the fold: **28** (8 `fromUser` + 21 ratified, one overlapping).

| mode | protected placed | tier spend | kept | rescued | notes |
|---|---|---|---|---|---|
| both (union) | all 28 kept, none evicted | 2 192 | 840 | 5 | every candidate survives, including the commit-message rule |
| user only | 8 placed; 4 ratified facts evicted | 538 | 841 | 3 | only **1** of the 3 is protected — `Commit message plan exclusion`; `enableQuickKeys default` (12 tok) and `TopBar label not pinned in E2E` (67 tok) are **not** in the candidate set |
| ratified only | 21 placed; `Commit message plan exclusion` evicted | 1 710 | 840 | 5 | the one fact the tier exists for falls out |

So the two counts in the earlier table were packing luck, not protection.
`enforceBudget`'s walk keeps a fact only if it still fits and otherwise *continues*
scanning, so changing the fill order shifts which small facts land in the leftover
space — a 12-token fact can appear "rescued" in a mode that never protected it. Any
tier metric has to separate **protected and rescued** from **rescued by packing**, or it
will read as a benefit the rule did not provide.

Union is the right rule on this evidence: it is the only mode that keeps all 28
candidates, and ratified-only actively evicts the user constraint it is supposed to
protect. The bound is still not what limits anything — 2 192 tokens of a 60 000 cap.

## Finding: the enumerable probe matcher over-counted retention in two ways (2026-10-23)

`dev/enumerable-coverage.ts` asks whether a draft or a bank fact carried a probe like `exit code 3`.
Two bugs made it answer yes when the writer had not kept the fact.

1. **A template literal is not a regex literal.** The exit-code relaxation was written
   ``new RegExp(`\\b${num}\s*(?:=|:)?`)``. In a template literal `\s` evaluates to a bare `s`, so the
   pattern actually tested was `\b3s*(?:=|:)?`. Biome's autofix rewrote the source to `s*` — what it
   already evaluated to — which is how the bug surfaced. The whitespace tolerance never existed.
2. **Substring matching on numbers.** The literal path ran first, and `exit code 3` is a substring of
   `exit code 313`: a code the writer never kept was counted as kept. Same shape for `max 12` inside
   `max 12000`, and `HY-123` inside `HY-1234`.

The fix splits the two jobs. Exit codes are matched by the **number as a standalone token** on a line
that is about exit codes, or by the glossed form the writer actually produces (`130 = interrupted
rename`). Every other category matches literally but refuses a match that cuts the inside of a longer
number (`squashContains`).

The one looseness left is asserted rather than hidden: `12 = max tokens` reads as exit code 12. Losing
every `N = meaning` retention to avoid that collision is the worse trade, so the fixture states it as a
choice instead of leaving it to be rediscovered.

**Historical numbers are unchanged.** `enum-base` (58/58), `enum-noisy` (55/55) and `reload-replay`
(66 stated, 61 proposed, 92%) produce byte-identical reports before and after the fix — none of those
corpora contain a colliding pair, which is why the bug survived every number ever printed from it. The
new behaviour is proven by a self-test that runs whenever the tool runs: nine cases, five of them
negatives, including the known looseness.

## Experiment: restraint baseline — abstention and attribution (2026-10-23)

The enumerable probe asks whether the writer **keeps** what matters. This one asks the other half of
the job: does it **refuse** what does not matter, and when a fact arrives as a quotation, does the bank
record who said it? Diagnostic only — no prompt variant, no code-side policy filter, `src/prompts.ts`
unchanged.

**Corpus** `dev/corpus-restraint.json`, 26 authored chunks, mean 140 est tokens:

- **8 attribution pairs.** Same claim, same tool output, one declared variable flipped: the keep side
  states it as the user's own, the quote side delivers it as a named third party relayed through the
  user (`Mara`, `Devin`, `Priya`, `Ivo`, `Nadia`, `Samir`, `Hana`, `Theo`).
- **10 nothing-durable chunks.** Aborted probes, greetings and logistics, a directory listing and a log
  tail, a plan explicitly not settled, an abandoned failure, step-by-step restatement, log counts with
  no conclusion. The correct output is `{"drafts":[]}`.

`tools/restraint-corpus-check.ts` runs in `npm run check` and enforces the design: the two sides of a
pair differ in exactly one declared variable, no anchor from a pair leaks into an empty chunk, no probe
word appears in either writer prompt, no privacy-shaped string. Six deliberate mutations of the corpus
each exit 1.

**Two contracts, both reported.** The external benchmark this idea came from counts only an empty list
as correct (`strict`). For a coding-agent bank that is too strict: *Mara (ops channel) runs tctl with
`TCTL_LOCK=off`* is usable memory. The headline here is **attributed-ok** — a draft may carry the claim
if it names the third party — with strict kept beside it so the external number stays comparable.

**Two gates.** Extract never sees the bank, so withholding can only happen at reconcile. Scoring at both
separates a prompt failure from a reconcile failure.

**Run** `restraint-base`: local writer `hy-memory-30b-a3b`, temperature 0, `reasoning_effort: none`, pool
12 000, per-draft candidate rendering, limit 12. 26 chunks, 74 drafts, 0 rejected, 7 drafts shown no
candidate, 43 active facts.

### The instrument was wrong before the run taught it

The first report printed **recall 1/8**. It was not the writer: `keepBanked` asked for an active fact
whose own `chunkId` is the keep chunk. An `UPDATE` writes a *new* entry whose `chunkId` is the newer
chunk and whose `supersedes` points back at what it replaced, so every pair whose quote side merged
into the keep-side fact was scored as a lost claim. Following the supersede chain, recall is **8/8** —
every claim in this corpus survived.

The fixture in `tools/restraint-report-check.ts` had no merge case, which is why it passed while the
real scorer was wrong. Pair `g` now exists for exactly that shape: quote side restates, reconcile
`UPDATE`s the keep-side fact, and the check asserts merged 1 / added 0 / one fact for the subject.

### What the writer actually did

| measure | strict | attributed-ok |
| --- | --- | --- |
| recall (keep side in bank) | 8/8 | 8/8 |
| quote side withheld — draft gate | 0/8 | — |
| quote side added nothing new — bank gate | 7/8 | — |
| pair-correct (keep banked **and** quote clean) | 0/8 | 5/8 |

What each column means, because these totals only mean something with the definitions attached:

- **recall** — an active bank fact carries the pair's anchor token *and* its `supersedes` chain reaches
  the keep chunk. The chain, not the entry: an `UPDATE` writes a new entry whose own `chunkId` is the
  newer chunk. A fact superseded by a statement that no longer carries the anchor is a loss, not a
  recall (fixture pair `i`).
- **quote side withheld (draft gate)** — no accepted `hy.extract` draft on the quote chunk carries the
  anchor. Strict counts any such draft; attributed-ok accepts one that names the third party.
- **added nothing new (bank gate)** — no active anchor-carrying fact whose own `chunkId` is the quote
  chunk, *except* one whose chain reaches the keep chunk. Merging a restatement into a fact the bank
  already holds is reconcile doing its job; standing beside it as a second fact is the failure.
- **facts** — active anchor-carrying facts across the whole pair: 1 is one memory, 2+ is the bank
  holding the subject twice.
- **pair-correct** — recall **and** the quote gate clean, under each contract.

- **The writer restates.** All 8 quote sides drafted a claim the bank already held. At the draft gate
  restraint is 0/8, which is the number comparable to the external benchmark.
- **Reconcile merges instead of duplicating.** All 8 pairs have at least one quote-side fact merged into
  the keep-side fact; 1 pair (`attr-06`) also added a second active fact; 2 pairs end with the subject
  held twice (`attr-06` two facts, `attr-05` three). These are per-pair flags, not a partition —
  `attr-06` appears in all three. `SKIP` was used once in the whole run. Withholding in this pipeline
  happens as *merge*, not as refusal.
- **Attribution works more often than not.** Six of eight quote-side facts name the third party —
  `(per Mara)`, `(per Devin)`, `Priya stated to keep it at 5`, `stated by Samir`, `Hana stated`,
  `Nadia stated`. Two dropped the speaker entirely (`attr-04`, `attr-08`).
- **One paraphrase suspect** (`attr-04`): the quote side was clean by anchor yet shared three content
  words with the keep-side fact. Reported, not scored — anchor matching cannot see a paraphrase.

### The empty-chunk axis is where abstention genuinely fails

0/10 abstained, 0 code-suppressed, 21 facts banked from chunks labelled nothing-durable. Reading the 21
rather than counting them: about fifteen are chatter or transient state the bank has no business
keeping —

- `User found doctor subcommand in README, no longer needs assistant confirmation`
- `git status --short shows modified file: src/lock.rs`
- `doctor.log contains 7 warn lines and 41 info lines`
- `Assistant plans to move to the next file after reading src/config.rs line 112`

and about six are defensible memories the corpus label was too strict to admit — a CLI capability
(`tctl supports doctor: usage is tctl <doctor|list|apply>`), two facts read out of the manual
(`--show-pending prints queued changes without writing them`, `pending entries expire after 300 s`),
where a constant lives, and the user's presentation constraints (`keep answers short, reading on a
phone`, `do not paste whole files back`). For a bank meant to serve a coding agent those are not noise.

**The corpus labels were not changed for this report.** 0/10 abstained is the number the corpus as
committed produces, and relabeling `hy-resp-empty-03`, `-08` and `-10` after seeing it would move the
goalposts rather than measure anything. The label disagreement is recorded here as an audit finding, and
the judge below is what tests it: an independent model with the standing rubric agrees with the labels
on about half of those chunks and disagrees on the rest. No corrected-label re-score is included in this
report; a later label audit could re-score the same ledger under corrected labels while keeping these
numbers, but that has not been done here.

The sharpest single line in the run is the writer stating its own disqualifier and storing anyway:
`User suggested splitting doctor into two commands but decided not to decide on it today; idea parked,
not a decision.` It knew, and it wrote it down.

### Soft axis: the judge, independent of the corpus labels

Judge `qwen3.8-flash-next-iq3_xxs`, temperature 0, reasoning suppressed, seeds 7 and 11, never the writer.
73 ops judged per seed (`SKIP` excluded — a deliberate non-write is not a write to grade), 0
verdict-less. `shouldNotStore`:

| class | seed 7 | seed 11 |
| --- | --- | --- |
| chunks labelled nothing-durable | 12/23 | 14/23 |
| attribution pairs, keep side | 9/26 | 8/26 |
| attribution pairs, quote side | 7/24 | 5/24 |

- **The two seeds agree on 68 of 73 ops** — 25 noise both times, 43 keepable both times, 5 split. The
  splits are the interesting ones and they are all borderline transient state.
- Durability across both seeds: 50 durable, 43 marginal, 53 noise. Unsupported 1/73 and 0/73; missed
  durable facts 4 and 3.
- The label does separate — 52–61 % noise on the nothing-durable chunks against 21–35 % on the
  attribution chunks — but not as the corpus assumes. **Nine to eleven of the 23 facts banked from
  "nothing durable" chunks were judged worth keeping**, including all four the manual read flagged as
  defensible and three it called intrusions (`idea parked, not a decision`, the abandoned
  `--check-rename` failure, `User questioned why doctor output has twelve keys`). The corpus's empty
  class is about half what an independent judge concludes — which is evidence that the label is ambiguous
  on a substantial subset, not proof that the labels are wrong, and not a correction of the 0/10.
- One fidelity flag named rather than counted: the judge called the `tctl list` update on
  `hy-resp-empty-10` a hallucination because the fact it *replaced* described a dry-run with 3 pending
  keys, which is absent from that chunk. The writer did not invent it — that fact came from
  `attr-06`, and an `UPDATE` reached across chunks. A judge shown a chunk and not the bank will read
  every cross-chunk merge as invented context, so judge numbers on `UPDATE` carry that bias and it is
  stated here rather than left to be rediscovered.

**What this rules out.** A prompt clause telling the writer to abstain is not the obvious next move: on
the pair axis the bank is already nearly clean once a merge is scored as a merge, and the failure that
remains is the draft gate — the writer proposes a restatement it cannot know is redundant, because
extract never sees the bank. The empty-chunk failure is the opposite shape: nothing to merge with, and
still no refusal. Those are two different problems and the baseline says which one is bigger.
*Corrected the same day:* the causal half of that sentence was tested by showing extract the bank, and it
did not hold — the restatement still arrived 8/8. See the bank-aware draft gate at the end of this file.

### Label audit: what the nothing-durable label actually separated (2026-10-23)

Findings only. The corpus labels, the `empty_chunk: 10` gate and the 0/10 abstention above are unchanged
by this section — relabeling three chunks would drop the empty class to 7 and fail
`tools/restraint-corpus-check.ts`, and re-scoring under new labels after seeing the first score is the
thing this repo is supposed to do once, honestly, instead of quietly.

Method: the same `out/restraint-base/ledger.jsonl`, no new model run. For each op, do both judge seeds
call it `shouldNotStore`. An op both seeds keep is the interesting one.

| chunk | ops | kept by both seeds | verdict on the label |
| --- | --- | --- | --- |
| `hy-resp-empty-03` | 3 | 2 | too strict |
| `hy-resp-empty-10` | 3 | 2 | too strict |
| `hy-resp-empty-01` | 2 | 1 | split |
| `hy-resp-empty-02` | 3 | 1 | split |
| `hy-resp-empty-06` | 2 | 1 | split |
| `hy-resp-empty-07` | 2 | 1 | split |
| `hy-resp-empty-08` | 2 | 1 | split |
| `hy-resp-empty-04` | 2 | 0 | holds |
| `hy-resp-empty-05` | 2 | 0 | holds |
| `hy-resp-empty-09` | 2 | 0 | holds |

9 of 23 banked facts survive both seeds. The pattern is not durable versus transient:

- **Every op both seeds kept says something about the tool or the source** — `tctl supports doctor:
  usage is tctl <doctor|list|apply>`, `--show-pending prints queued changes without writing them`,
  `pending entries expire after 300 s`, `src/doctor.rs:14 collect_keys` and `:19 keys.extend(self.defaults())`,
  `settings.toml` defined at `src/config.rs:112`, the abandoned `--check-rename` failure, and the two
  presentation constraints.
- **Every op both seeds rejected says something about what the participants did** — `User found doctor in
  README`, `User instructed to hold that thought`, `Assistant plans to move to the next file`, `User will
  be back in twenty minutes`, file sizes, log line counts.

So the label conflates two different claims. `hy-resp-empty-03` is labelled *transient working state:
what is open right now* and `hy-resp-empty-10` *a preference about how the conversation runs* — both true
about the **conversation**, and both chunks carry tool results that are durable facts about **tctl**. The
writer stored the tool facts and the label counted them as intrusions.

**What follows for slice 2, without touching v1.** The empty class should be two classes: *nothing
durable about the work* (04, 05, 09 — the writer is plainly wrong to store any of it) and *nothing the
user decided, but tool output present* (03, 08, and the aborted probes) where storing the tool fact is a
defensible call and abstaining is a judgment, not a rule. That is a corpus-design change for a new
corpus with its own gate, not a relabeling of these ten.

## Run: restraint, second cut — three classes instead of one (2026-10-23)

`dev/corpus-restraint2.json`, run `restraint2-base`. v1 (`dev/corpus-restraint.json`,
`restraint-base`) is untouched and re-scores byte-identical; this is a new corpus with its own gate,
not a relabeling, exactly as the audit above said it should be.

The empty class is split into the two things the audit found inside it:

- **`nothing_work`** — nothing durable is said about the work *and* the tool output says nothing
  durable either. Storing anything here is plainly wrong, with no defensible fact to hide behind.
- **`tool_output`** — nobody decided anything, but a tool result states a durable fact. Keeping the
  fact is the defensible call; keeping the chatter around it is the failure v1 could not see.

The attribution pairs are new too: new anchors (`TCTL_WRITE_MODE`, `--no-follow`, `pending.db`,
`MAX_PENDING`, `check-order`, `0o660`, `tctl plan`, `--trace`), new claims, new markers (Lena … Bram),
so nothing from v1 leaks into v2 or back.

### Corpus and gate

28 authored chunks, mean 94 estimated tokens. Gate: 8 attribution pairs, 6 `nothing_work`, 6
`tool_output`. `tools/restraint-corpus-check.ts` now enforces per-class rules — a `nothing_work`
chunk must say *why* nothing is durable and carries no anchor; a `tool_output` chunk must declare
both the tool fact it is tested for (`probes`) and the chatter that must not be banked
(`transient`); probes must appear in their own chunk and nowhere else; a probe that is also a word in
the writer's own prompt is refused, because that measures the prompt and not the model.
`tools/restraint-corpus-mutation-check.ts` proves that check can fail: it copies the corpus to a temp
file, breaks one rule at a time, and requires the rejection to name the rule it broke — 13 mutations,
all rejected. A rule that stops being enforced shows up there as a mutation that suddenly passes. The
privacy rules are the one thing it does not mutation-test: a fixture that tripped them would put a
hostname, a home-directory path or a credential into the diff, which AGENTS.md forbids.

### Run

Same writer, same route, same config as `restraint-base` (`hy-memory-30b-a3b`, temperature 0,
reasoning off, pool 12 000, per-draft candidates, limit 12). 28 chunks, 45 active facts,
ops ADD 45 / UPDATE 14 / SKIP 1.

| axis | result |
| --- | --- |
| recall — keep side reaches the bank | 8/8 |
| restraint, strict (quote side withheld at the draft gate) | 0/8 |
| quote-side drafts naming the third party | 8/8 |
| quote side clean at the bank gate | 5/8 |
| quote-side bank facts naming the third party | 1/8 |
| pair-correct, strict | 0/8 |
| pair-correct, attributed-ok | 1/8 |
| pair-correct, attributed-ok ignoring the pair's own tool output — diagnostic, not a gate | 6/8 |
| what the bank did with the pair | 8 merged into the keep-side fact, 3 pairs gained a second active fact, 7 pairs hold the subject twice |
| `nothing_work` chunks abstained | 0/6 — 12 facts banked |
| `tool_output` chunks keeping the declared tool fact | 6/6 — 0 declared chatter banked, 11 facts banked |
| `tool_output` chunks keeping the fact *and nothing else* | 3/6 |

### Soft axis: the same judge, seeds 7 and 11

59 ops per seed, 0 verdict-less, 0 unsupported, missed durable facts 0 and 1, specificity mean 2.153
and 2.169. The two seeds agree on **54 of 59 ops** (26 noise both times, 28 keepable both times,
5 split). `shouldNotStore`, per seed:

| class | seed 7 | seed 11 | durable / marginal, both seeds |
| --- | --- | --- | --- |
| `nothing_work` | 11/13 | 12/13 | 0 durable, 3 marginal |
| `tool_output` | 5/11 | 6/11 | 6 durable, 5 marginal |
| attribution, keep side | 4/17 | 5/17 | 16 durable, 9 marginal |
| attribution, quote side | 8/18 | 6/18 | 16 durable, 10 marginal |

**The class split is confirmed by an independent judge, not just by the labels.** On `nothing_work`
the judge found **zero durable facts in either seed** and rejected 11 and 12 of the 13 writes; the two
it let through were a cache file's size and timestamp and "user parked the idea of splitting apply
without deciding". On `tool_output` the judge graded the pair of writes in each chunk separately and
got the pattern the corpus predicted: the tool fact durable or marginal, the narration next to it noise
in five of six chunks — "This is a restatement of the assistant's action ('opened the writer module')
and the result already captured in op 0. It adds no new durable…" (`hy-r2-to-03`), "pure
bookkeeping/chatter confirming the end of a trivial query" (`hy-r2-to-05`). v1's ambiguous
"9–11 of 23 worth keeping" is gone: with the defensible facts moved to their own class, the writer's
behaviour on the two classes is 0/6 abstain and 6/6 keep.

### The instrument found a new blind spot, and it is printed

Every contrast pair shows the same tool output on both sides — that is what keeps the speaker frame the
only variable — and the tool output carries the anchor too. So a bank fact that repeats the anchor is
not automatically a restatement of the relayed claim:

```
hy-r2-r2e-q: … merged into the keep-side fact unattributed and restating this chunk's own tool output:
  "Running 'tctl doctor check-order' returned 'check-order: ok'."
hy-r2-r2c-q: … unattributed and restating this chunk's own tool output:
  "The file pending.db exists in var/state with size 2048 bytes, last modified at 10:31."
```

**9 such facts across 6 of the 8 pairs.** The bank gate and the bank attributed-ok count them as
quote-side facts about the relayed claim, which they are not: nobody relayed a grep result, and a fact
about the user's own evidence needs no attribution. That is the whole distance between draft
attributed-ok 8/8 and bank attributed-ok 1/8 — every pair did produce a fact naming its marker
("Wren stated that tctl keeps its queue of unapplied changes in a file named pending.db"). The scorer
now labels these facts in the notes and reports the count without scoring them, and the fixture
(`tools/restraint-report-check.ts`) pins the classification: pair `b` carries one claim fact and one
grep-output fact and they must not be classified the same way. The published 1/8 stands as measured;
what changed is that the number now says what it counted.

The diagnostic printed beside it, never instead of it: **pair-correct attributed-ok ignoring those facts
is 6/8, against the published 1/8.** The same scorer on v1 prints 7/8 against its published 5/8, with 2
such facts across 2 pairs; v1's published numbers are unchanged. The fixture adds a pair (`j`) whose only
anchor-carrying quote-side fact repeats its own `doctor.log` line — both published contracts fail it, the
diagnostic passes it, and the aggregate assertion records both totals so the diagnostic cannot be quietly
promoted into the headline. Which of the two is the right contract is an open decision (TODO 7.11), not a
number to pick after seeing the first score.

The judge reaches the same place from the other side: it called most of those evidence facts noise on
their own merits — "transient command result", "bookkeeping of a one-off lookup", "the mode value is
already captured in the durable memory (op 1)".

### What this rules out, and what it does not

- Restraint is not a blanket refusal in this writer, and never was: it keeps a tool fact 6/6 and keeps
  conversation 6/6. The failure is specific — it cannot tell the two apart, and nothing in the pipeline
  asks it to.
- The draft gate is unchanged across two corpora: 0/8 withheld both times, 0/8 both times for strict
  pair-correct. The reading offered here at the time — extract never sees the bank, so a restatement is
  proposed before anything knows it is redundant — was tested against a bank-aware arm the same day and
  **did not hold**: with the bank's own task line in front of it, the writer still restated the claim 8/8
  (see the bank-aware draft gate below).
- Attribution at the draft gate improved to 8/8 from 6/8, which is a property of the v2 claims always
  carrying an explicit speaker frame, not a change in the pipeline.

**Limitations.** 8 pairs, 6 + 6 class chunks, authored rather than transcribed. The `tool_output`
probes are distinctive tokens, so "kept the declared tool fact" is the easy half; the honest version of
that column is 3/6, because the writer banks narration the corpus never declared as chatter
("Assistant opened the writer module…", "User instructed to leave the tctl apply for now") and a
one-phrase `transient` list cannot name what the writer chose to write. Judge numbers on `UPDATE`
still carry the cross-chunk bias named in the v1 section.

## Experiment: bank-aware draft gate — falsified at the gate it aimed at (2026-10-23)

Both baselines put the failure in one place: the draft gate, 0/8 withheld twice. The reading was causal —
extract sees only a chunk, so a restatement is proposed before anything knows it is redundant, and
reconcile then merges it (8 merges in both runs). This arm tests that reading rather than restating it:
`writeChunk` gained `bankIndex`, which prepends the bank's active task lines plus one clause to the extract
call's user content, and `dev/run.ts --bank-index` turns it on. Off by default, never set by the
extension, so every published baseline is the flagless path. `tools/bank-index-check.ts` pins the shape of
what arrives — background rather than transcript, no bank ids, no line that reads as a source ref, whole
entries dropped when the cap bites, and the flagless request byte-identical to the one the baselines ran on.

The clause keeps the exception the blunt version would have cost: *do draft when this chunk updates,
corrects, cancels or adds durable detail*. "Never restate what is listed" would have taught the writer to
withhold the update a bank entry most needs, and that is the failure mode the arm was most likely to invent.

### It saw the fact, and wrote it anyway

The run's own `inTokens` says the block arrived — extract input went from 423 to 913 tokens per chunk. That
proves a block was sent, not that it named the right subject, so the ledger was replayed chunk by chunk
through the same renderer: at every one of the eight quote-side chunks the pair's anchor was inside the
index extract was shown, and the cap dropped nothing (bank 3–17 entries against a 600-token cap).

| | v2 base | v2 + index | v1 base | v1 + index |
| --- | --- | --- | --- | --- |
| recall (keep side in bank) | 8/8 | 8/8 | 8/8 | 8/8 |
| **restraint, strict (draft gate)** | **0/8** | **0/8** | **0/8** | **0/8** |
| quote side clean — bank gate | 5/8 | 7/8 | 7/8 | 8/8 |
| pair-correct, attributed-ok | 1/8 | 1/8 | 5/8 | 4/8 |
| active facts | 45 | 40 | 43 | 45 |
| quote side added a second fact | 3 | 1 | 1 | 0 |
| explicit SKIP ops | 1 | 0 | 1 | 0 |
| tool: kept the fact and nothing else | 3/6 | 5/6 | — | — |
| extract input / chunk | 423 | 913 | 485 | 1036 |
| total input tokens | 33 022 | 44 708 | 33 478 | 48 000 |

The gate it was built for did not move: the writer is shown the fact it is about to duplicate and
duplicates it 8/8, on both corpora. Everything else moved by one or two pairs out of eight, and in
opposite directions on the two corpora (v2 bank gate 5→7, v1 7→8; pair-correct 1→1 and 5→4). There is no
noise floor for these gates, so the honest reading is **directionally mixed, within the uncertainty of
eight pairs: no robust effect**, not "noise" and not an improvement. Nothing the scorer can see was lost:
recall held at 8/8, and the quote-side drafts still carry the chunk's own lines rather than the bank's
wording, so the copying risk the clause was written against did not appear here.

Two secondary reads worth keeping. The reconcile `SKIP` disappeared in both arms (1 → 0): fewer drafts
arrive, which is not the same as more drafts being refused, and a drop in SKIP must not be reported as
restraint. And the bank got smaller on v2 (45 → 40 facts) while getting larger on v1 (43 → 45) — a bank
size that moves in both directions under one change is a bank size with no signal in it yet.

### What this rules out, and where it stops

Extract's blindness is not why the draft gate fails, **at this bank size**. The boundary matters: the index
never truncated in either arm, because these corpora bank 45 facts or fewer against a 600-token cap. In a
real session the bank is hundreds of facts — the 32-chunk session measured elsewhere in this file held 408
active facts — so a cap that shows a fraction of the bank is exactly the case where redundancy can be
genuinely invisible. This arm does not speak to that case, and does not falsify bank visibility as an
idea; it falsifies the cheap version of it as an explanation for 0/8.

Not measured yet: the independent judge on the two arms. The judge endpoint went unreachable partway
through the run — empty completions, then connection failures — and the re-ask loop spent its three
attempts on each of the first four chunks, keeping each discarded reply as `out/restraint2-bidx/judge-raw-*.txt`
(`out/` is gitignored, so those files are a local post-mortem, not evidence in the repository). Switching
judge model would break the comparison against the seeds-7-and-11 baselines, so the soft axis stays open.
What this arm can therefore claim is only what the scorer can see: no claim was lost, recall held at 8/8,
and no draft borrowed the bank's wording. Whether the arm also reduced what an independent judge calls
noise is unmeasured, and is not implied by a bank that got five facts smaller on one corpus.

Cost is measured and is real: ~2.2× the extract input, +35 % total input tokens, for no movement in either
published gate. Wall time is unusable in these two runs — the endpoint was contended, and several calls
took 90–180 s against ~3 s in the baselines.

## Run: the tool_output class at width, and the instrument that could not see the failure (2026-10-23)

**Question.** The second cut measured narration on 6 `tool_output` chunks: 6/6 kept the declared tool
fact, 3/6 kept it and nothing else. Six chunks is not enough to say what the failure is. The plan was
to widen the class — 12 chunks, more narration shapes — and measure the baseline before writing any rule.

**Corpus.** `dev/corpus-restraint3.json`: 22 chunks — 12 `tool_output`, 4 attribution pairs (to catch a
suppression rule collateral-damaging them), 2 `nothing_work`. No empty chunks; the class split of the
previous cut is kept. `tools/restraint-corpus-mutation-check.ts` now runs over all three corpora — 21
mutations, each rejected by the rule it breaks, including r3-specific ones (a declared value leaked into
an unrelated chunk, declared chatter removed, an undeclared phrase treated as chatter). One mutation the
corpus checker caught while authoring: a probe that is also a word in the writer's own prompt
(`durable`) measures the prompt, not the model.

**Run.** `restraint3-base`, writer `hy-memory-30b-a3b`, temperature 0, pool 12 000, per-draft candidates,
limit 12 — the shipped config. 22 chunks, 34 active facts.

| measure | result |
|---|---|
| chunks where the declared value reached the bank | 12/12 (10 kept-fact + 2 kept-both) |
| declared value banked more than once from the same chunk | 8/12 chunks, 8 repeat facts |
| chunks where every banked fact carries a declared value | 8/12 |
| chunks that banked exactly one authored fact, carrying the value and no chatter | 2/12 |
| declared chatter banked alongside the value | 2/12 |
| chatter instead of the value | 0/12 |
| authored facts carrying neither the value nor the declared chatter | 1 |
| banked facts credited to a chunk that did not author them | 2 |
| drafted but not banked / withheld | 0/12, 0/12 |
| attribution pairs reach the bank | 4/4 |
| `nothing_work` drafts | 2/2 drafted, 0 skipped — unchanged from the previous cuts |

**Read these as one run, not a rate.** One run, one model, temperature 0, no repeat runs, no judge verdicts.
Temperature 0 makes the run reproducible, not the finding general: "12/12 got the value into the bank and
8/12 banked it twice" is what this corpus did on this day, 12 chunks is a small class, and the repeats and
carried-in facts are properties of this run's writes as much as of the writer.

In this one run, at twelve chunks, the class does not look like the v1 story. Every chunk got its declared
value into the bank, nobody banked chatter *instead of* a value (chatter-only 0/12, "something the corpus
declared neither" 0/12), and only two chunks banked the declared chatter alongside the value. That reading is
weaker than it looks: every `tool_output` chunk in this corpus declares a durable value, so 0/12 says the
writer does not swap the value out for chatter when a value is present. It does not say narration is never
banked, and the corpus as authored cannot test that case — a tool chunk with chatter and no value is not in
it. Narration banked *beside* a value shows at fact level: of 22 facts the tool chunks authored, 1 carries
neither a declared value nor declared chatter ("User instructed to leave the drain lock for now; Assistant
confirmed leaving it"). Two more facts that look like that were not authored by the chunk they appear under
at all: the audit-file-mode fact was written by an attribution chunk, and a user-confirmation fact by a
`nothing_work` chunk — both reached a tool chunk's listing only because a later merge superseded a fact that
chunk had authored.

**The instrument was blind to the bigger failure.** Counting facts that carry a declared value, `--purge-age`
is banked twice from one chunk and the staging name `queue.tmp` twice from another. The second copy is
usually a confirmation in an actor frame ("User confirmed the flag drops entries older than n seconds"),
which carries the value, so `probe` matches it and every existing column calls the chunk clean — including
the stricter "every fact carries the declared value" reading. Eight of twelve chunks banked one value more
than once, eight repeat facts. The narrowest reading — one authored fact, carrying the value, carrying no
chatter — is 2/12.

What "repeat" means, stated plainly: two facts *authored by one authored chunk* whose declared value both
match. It is a structural signal that needs the corpus's probe list, not a semantic duplicate detector: it
does not run on unlabelled real conversations, would not catch a paraphrase that drops the value, and it
ignores a value banked once per chunk across several chunks, which `bankDuplicated` already counts. The
authored/carried-in split exists because the supersede chain reaches a chunk when a fact authored there is
absorbed into a fact written elsewhere, and a chain-only count credits that chunk with a fact it never
banked.

**Fix, as reported columns rather than gates.** `dev/restraint-report.ts` now marks the second copy of a
declared value `repeat`, tags each banked fact `tool fact` / `repeat` / `chatter` / `neither` / `carried-in`
in the per-chunk listing, splits each chunk's facts into the ones it authored and the ones a later merge
carried in, and totals three things beside the existing ones: `same declared value banked more than once`
(chunks and repeat facts), `banked exactly one fact, and it carried the value` — the narrowest reading, which
also excludes a fact carrying the value and the chatter in one sentence — and the authored/carried-in split.
All three are deliberately outside `toolFactsOnly`: folding them in would silently redefine the published
numbers of the two earlier cuts. `tools/restraint-report-check.ts` adds a seventh tool chunk whose two facts
carry the same value and asserts that it still scores as a clean fact-only keep while the repeat column alone
sees it, and an eighth and ninth where the cap banked at one chunk is superseded by a merge authored at
another: the outcome column still credits the first chunk, the authored column does not. Both blind spots are
pinned, not just described.

| run | value reached the bank | every fact carries a declared value | value banked twice | exactly one clean authored fact | facts (authored / carried in) |
|---|---|---|---|---|---|
| `restraint-base` (v1) | no tool chunks | — | — | — | — |
| `restraint2-base` | 6/6 | 3/6 | 2/6 chunks, 2 facts | 1/6 | 11 / 0 |
| `restraint2-bidx` | 6/6 | 5/6 | 5/6 chunks, 5 facts | 0/6 | 12 / 0 |
| `restraint3-base` | 12/12 | 8/12 | 8/12 chunks, 8 facts | 2/12 | 22 / 2 |

Reproduce the run: `POC_MODEL=hy-memory-30b-a3b npx tsx dev/run.ts --run restraint3-base --corpus
dev/corpus-restraint3.json --pool 12000 --candidate-render-mode perDraft --candidate-limit 12`. Reproduce the
numbers: `npx tsx dev/restraint-report.ts --run restraint3-base --corpus dev/corpus-restraint3.json`, and the
same with `--run restraint2-base` / `--run restraint2-bidx` against `dev/corpus-restraint2.json`. Every number
in the tables above comes out of those commands; no scratch script is involved.

**It also corrects a cross-arm claim.** The bank-aware arm's tool axis was reported as better than the v2
baseline on "every fact carries the value" (5/6 vs 3/6). Counting the facts behind that rate: the baseline
banks 11 across 6 chunks and the arm 12; the arm repeats a value in 5 of 6 chunks where the baseline repeats
in 2; its narration facts fall from 3 to 1; and chunks that banked exactly one clean fact go from 1/6 to 0/6.
The arm banked less narration and more restatement, so the higher rate was partly duplication, and by the
narrowest reading the arm is the worse of the two. The soft axis is unmeasured for these runs: the judge
endpoint went away mid-day, so `restraint3-base` has no judge verdicts and no claim rests on one.
**What this corpus cannot test.** Every `tool_output` chunk here declares a durable value, so the class has no
control for the case the v1 label actually hid — a tool exchange with chatter and nothing worth keeping. The
narration defect in its original form is measured only indirectly: one authored narration fact banked beside
a value, and two facts credited to a chunk that did not author them.

**Next.** The failure this class shows at width is a value banked twice, which reconcile is supposed to SKIP,
and a suppression guard aimed at narration would not have touched it. Measure first whether reconcile merges
two drafts that carry the same declared value, and add the missing control — tool chunks whose chatter is
declared and whose durable content is none — before writing any rule for the class.

## Run: the actor-frame extract prompt, scored against the published baseline (2026-10-23)

`restraint3-actor` differs from `restraint3-base` in one thing. Same 22-chunk corpus, same pool
(12 000), same per-draft candidate rendering at limit 12, same temperature 0, same writer route: the
extract call goes through `dev/prompts-actorframe.ts`, which is the shipped prompt plus the three clauses
upstream Hy-Memory puts at the top of its own coding extract prompt — a statement's subject is the code,
the command, the config or the decision and never a person or the agent; restraint as spending the same
budget on what was actually executed rather than abstaining; and evidence fidelity (executed commands
only, customary flags never invented). The arm is pinned additive and extract-only by
`tools/extract-prompt-check.ts`; `src/index.ts` never sets it.

**The arm is not free.** Its prompt is 1 784 characters longer, and the price is exactly that: 389
tokens on every single extract call, measured per chunk and identical across all 22. The baseline spent
about 391 input tokens per extract, so the arm's call is more than twice the size — 8 598 tokens against
17 156 across the 22 chunks — while extract output barely moved, 2 690 → 2 822.
Reconcile input *fell* (14 425 → 13 320) because the bank it reads is smaller. Wall time is not
comparable: 84 s against 47 s, and 42 s of the baseline's total is the first call after the route went cold.

### The two runs, side by side

Same scorer, same gate, `dev/restraint-report.ts`. Counts are the number; percentages are orientation.

| the 12 `tool_output` chunks | shipped prompt | actor-frame arm |
|---|---|---|
| the declared value reached the bank | 10/12 | 12/12 |
| …and nothing else reached it | 8/12 | 5/12 |
| declared chatter banked beside the value | 2 | 0 |
| declared values survived, counted per value | 24/24 | 23/24 |
| chunks that lost a declared value | 0/12 | 1/12 |
| one value banked twice from one chunk | 8 chunks, 8 repeat facts | 5 chunks, 6 repeat facts |
| exactly one authored fact, carrying the value | 2/12 | 4/12 |
| facts authored here / carried in by a later merge | 22 / 2 | 21 / 4 |
| facts carrying neither declared half | 1 | 3 |
| statements opening with a person or the agent | 10 of 22 authored here, 15 of 37 in the bank | 4 of 21 authored here, 5 of 35 in the bank |
| bank at the end | 37 active facts, 773 tokens | 35 active facts, 726 tokens |
| ops | ADD 37 UPDATE 7 SKIP 0 | ADD 35 UPDATE 9 SKIP 2 |

The arm's headline is the last two rows and the wording row: the bank it leaves is smaller and its
sentences are about things. Restraint on the attribution pairs is **unchanged** — recall 4/4, restraint
strict 0/4 withheld, attributed-ok 4/4, bank gate 3/4, paraphrase suspects 1/4, facts across the four
pairs 7 in both runs — so the borrowed clauses neither damaged the relayed-claim handling nor improved
it. The `nothing-durable` axis is unchanged too: 0/2 abstained in both runs, 4 facts banked from those
chunks against 3.

### What the arm changed, sentence by sentence

The clauses target wording, and wording is what moved. Shipped prompt, then arm:

- `hy-r3-to-11`: "Ran tail -n 2 audit.log; last line showed 'info: pass complete in 6.2 s' meaning last
  pass finished normally in 6.2 seconds." → "tail -n 2 audit.log shows 'info: pass complete in 6.2 s';
  last pass finished normally in 6.2 s".
- `hy-r3-to-12`: "The help text for the preview flag states: --dry-run prints the diff and writes
  nothing." → "tctl apply --help shows --dry-run prints the diff and writes nothing."
- `hy-r3-to-07`: "The state/ folder contains audit.db, which is 32768 bytes and stamped 14:02." →
  "ls -l state/ returned audit.db (32768 bytes, stamped 14:02)."
- `hy-r3-to-04`, the case 7.13 could only report as noise: "User instructed to leave the drain lock
  (pid 4412) for now; Assistant confirmed leaving it." → "Drain lock (pid 4412) to be left for now;
  releasing it is out of scope for now." The constraint survives as the constraint, which is exactly what
  upstream prescribes, and it is the one of the arm's three neither-half facts that is not a defect.
- `hy-r3-to-08`, a fact a later merge carried in: "Audit file mode should be 0750, keeping it
  group-readable (left at 0750)." → "Audit file must stay group-readable per Marn from infra; mode 0750
  matches this requirement." The constraint now travels with the person who stated it, which is the
  opposite of what the attribution cut found happening to relayed claims.

Naming a source and making a person the subject are different acts, and the run separates them: across
the whole bank, statements opening with a person or the agent's own voice fall 15/37 → 5/35, while every
named-source fact survives (4/4 recall, attributed-ok 4/4). The arm writes "Jori on ops channel stated
purge only touches the queue directory; …" and "Snapshots are taken every 300 seconds per Ilse from the
platform channel; HY_SNAPSHOT_INTERVAL=300 configured matches." where the shipped prompt wrote "User
confirmed setting HY_SNAPSHOT_INTERVAL to 300 and keeping it at 300." Actor frame and attribution are not
in conflict, and this is the first measurement that shows it rather than assumes it.

**SKIP was reached for, twice, both times at the bank gate.** `hy-r3-to-06`: `SKIP draft 0, reason
"restates only release line request, not durable"` — the shipped prompt banked that request as a fact.
`hy-r3-nw-02`: `SKIP draft 1, reason "recap only no change"`, and the same chunk had two ops rejected for
reusing one draft. The baseline run never used SKIP, and neither run withheld at the draft gate: 0/4
restraint pairs withheld, 0/2 nothing-durable chunks abstained, in both. The withhold vocabulary appears
in the second call, not the first — which is where the protocol already has the authority for it.

### What it cost, and where the instrument had to change to see it

`hy-r3-to-01` is the run's worst result, and the outcome column cannot see it: the row reads
`kept-fact` because *a* declared value is present. The arm did not write a worse fact here — it wrote the
best one in the corpus, and the bank gate then destroyed it.

| | shipped prompt | actor-frame arm |
|---|---|---|
| what chunk 1 drafted and banked | "The --purge-age flag drops queue entries older than n seconds, found on line 63 of manual.txt via grep for 'age'." — and a second copy of the same value banked alongside it | "--purge-age <n> drops queue entries older than n seconds (line 63 in manual.txt)" — thing as subject, flag behaviour and coordinate intact, with the chatter half banked beside it |
| what the bank holds two chunks later | both copies still active | that entry superseded, and its replacement superseded again at chunk 10 by a draft about a different command's exit code |
| the surviving record of the age flag | the flag, its behaviour, and line 63 | "User read manual for a few minutes to find the age flag (--purge-age)." |

The deletion is an op the model asked for: at chunk 2, `UPDATE` on draft 1 targeted chunk 1's flag entry,
with the writer's own reason "confirm 420s expiration unless pinned, aligns with purge-age docs". An UPDATE
replaces the entry whole, so the flag name, what it does and the line it was found on left the bank in one
op. `line 63` is this run's only lost declared value.

What the reason string shows is the mechanism: the draft shared a *subject* with the entry it merged into —
queue entries — and that was taken as identity of *value*. The subject guard ran on this op and passed it:
4 of the target's 10 subject tokens matched (`queue`, `entries`, `seconds`, `line`). The six it did not
share were the ones that made the entry about the flag at all — `purge-age`, `flag`, `documentation`,
`drops`, `older`, `manual.txt`. The guard fires often, and it fires in both directions: the baseline
recorded 6 attempted UPDATEs it downgraded to ADD for exactly this reason, while in the arm only 1 of its
2 downgrades was the subject test and the other was a target never retrieved for that draft.
The baseline banked the flag twice and lost nothing in the same chunk, which is the other half of one
defect: reconcile is safe when it refuses to merge, and it is the merge that costs. This is the
secondary-fact loss the protocol already names as the reason an UPDATE must restate everything still true,
caught in a bank for the first time — and it chained: the replacement entry was itself superseded two
chunks later by a draft about a different command's exit code.

Two instrument changes followed, both reported columns and neither a gate, each pinned by a fixture in
`tools/restraint-report-check.ts`:

- **declared values counted per value.** A chunk can keep one declared value and lose another, and the
  outcome column cannot tell. The fixture chunk now declares `--dry-run` *and* `4096`, banks a fact
  carrying only the first, and asserts `kept=[--dry-run] lost=[4096]` — alongside the four fixture
  chunks whose outcome already says nothing carrying a value arrived, so the column agrees with them
  instead of contradicting them. This is what turns "`line 63` is gone" from something I noticed by
  reading into something the report prints.
- **which statements open with a person or the agent.** A pattern over the opening of a statement:
  `User confirmed …`, `Ran tail -n 2 …`, `Opened the writer module …` count; `--dry-run prints the diff
  and writes nothing` and `Snapshots are taken every 300 seconds per Ilse from the platform channel` do
  not, because naming the source of a constraint is attribution and not actor frame. The fixture pins
  both halves of `hy-x-tool-07`, where the same value is banked once about the flag and once about a user
  confirming the flag, and only the second is flagged.

The pattern is a floor, not a measurement: it reads the opening of a sentence, so a person-framed clause
buried mid-sentence passes it. It is usable for comparing two prompts over one corpus precisely because
every fact it names is one a reader would flag, and not because it finds them all.

### What this comparison does not settle

- **The narration column and the actor-frame column are not the same column.** Facts carrying neither
  declared half went 1 → 3, and one of the three is the drain-lock constraint surviving in thing frame.
  A correctly reworded constraint reads as a new failure to the scorer because the corpus declares
  nothing durable in that chunk. That is a named gap in the `tool_output` label: the class has no label
  for "a constraint the user stated that should survive", which is the shape upstream's prompt is trying
  to produce, so counts on that column are not yet counts of anything.
- **Chatter matching is literal, and the arm paraphrases.** `hy-r3-to-01`'s declared transient is
  "reading the manual for a few minutes"; the arm banked "User read manual for a few minutes…", which the
  anchor does not match, so the run reports `fact and chatter 0` for that chunk. The improvement from 2 to
  0 on that column is real only for `hy-r3-to-06`, where the chatter half was actually skipped, and partly
  an artefact for `hy-r3-to-01`.
- **Retrieval is not held constant.** The two runs bank different facts, and candidates are retrieved
  from what is already banked: the arm's drafts were shown 61 candidates against the baseline's 92, and 11
  of its 46 drafts retrieved nothing against 6 of 44. Bank-shape differences are partly a consequence of
  wording differences, not a second independent effect.
- One run per arm, one model, temperature 0, no repeat runs, no judge verdicts (the judge endpoint was
  unreachable all day). Reproducible, not general.

**Decision: the shipped prompt does not move.** The arm is kept as a dev-only option because the axis it
improves is real and measured, and the axis it damages is now visible rather than inferred: a smaller bank
(37 facts / 773 tokens → 35 / 726), fewer repeats (8 chunks → 5), sentences about things (15/37 → 5/35),
SKIP used for the first time — against one chunk where the value's meaning and its coordinate left the
bank, three banked facts carrying neither declared half, and an extract call that costs twice the tokens.
The gate for promotion is not "the wording looks better": it is a corpus that labels the two things this
run showed we cannot yet tell apart — a user-stated constraint worth keeping, and chatter with nothing
under it — measured on the same scorer.

## What the subject guard lets through, measured on every UPDATE in six runs (2026-10-23)

**Question.** Every published restraint run reports the subject guard's *refusals* — 29 attempted
UPDATEs recorded as ADD across the six runs. What has never been audited is the other side: of the
merges the guard *allowed*, how many narrowed what their target said? `hy-r3-to-01` raised this by
hand — the actor arm's best fact in the corpus (flag, behaviour, line coordinate) was merged away
one chunk later on a verdict of "4 of 10 subject tokens shared", and the four tokens it matched were
not the ones that made the entry about the flag.

**Measurement.** `dev/merge-report.ts` reads every UPDATE out of every ledger under `out/` and
rebuilds the bank as it stood at each chunk. No model call, no corpus assumption: for each merge it
names the tokens that hold a value rather than wording (numbers, flags, dotted file names, paths,
underscored identifiers) and lists which left; where the corpus declares which values a chunk's tool
output must keep (`dev/corpus-restraint2.json`, `dev/corpus-restraint3.json`), the same question is
asked against the corpus's own label; and each merge is credited to the clause in `sameSubject` that
actually let it through — the strict one (the draft restates half the target's vocabulary) or the
relaxation (≥3 shared tokens and a sixth of the wording). `tools/merge-report-check.ts` pins the
instrument on a five-chunk fixture with known answers, including the case this report exists for: a
merge `sameSubject` approves that drops a declared value.

**Result 1 — a quarter of the accepted merges narrowed something.** Across 107 executed UPDATEs, 30
(28%) dropped at least one value their target carried — 54 value tokens, 9 of them values the corpus
declares must survive. In the newest corpus the rate is worse, because a small bank means merges
concentrate on tool facts: `restraint3-actor` 4 of 9 (44%), `restraint3-base` 3 of 7 (43%).

**Result 2 — every declared loss came through the relaxation, none through the strict clause.**

| which clause let the merge through | merges | dropped a value | corpus-declared values lost |
| --- | --- | --- | --- |
| restated half the target's wording | 84 | 16 (19%) | **0** |
| shared 3+ tokens, under half the wording | 23 | 14 (61%) | **9** |

A merge that restates half the target's vocabulary can still reword a value away (`cache/index.bin`
becoming `index.bin`) but never loses one the corpus says must survive. A merge admitted on three
shared tokens loses one 61% of the time, and all nine declared losses in this body of runs are in
that column. The guard is good at what it was built for — unrelated rewrites — and blind to the
related-but-narrowing ones, which is the class the corpus actually contains.

**Result 3 — tightening is not free.** Recomputed on the same ledgers, a stricter relaxation (4
shared tokens *and* a quarter of the target's wording) would have refused 14 of the 107: 9 of them
merges that would have dropped a value, 5 that dropped nothing. Nine destroyed facts saved for five
duplicate facts kept, where over-storage is the failure upstream names and this project already
measures. The refusals are not free either: 6 refused a target carrying a declared value and 4 of
those left two or more active facts covering it — the guard's safe default is itself a producer of
duplicates.

**Result 4 — 7.14's mechanism, answered, and it is not a merge problem.** In 39 places several drafts
in one chunk carried the same declared value. Reconcile merged them down to a single fact **0 times**:
36 pairs of ADDs and 3 ADD-plus-UPDATE chains, every one ending with two or three active facts
covering the same value. The duplicate is created at the draft gate and passes the bank gate untouched,
so dedup is code's job and no prompt instruction will produce it.

**Result 5 — the duplicates are what absorbed the damage.** In the actor arm three merges dropped six
declared values, yet only one value is gone from the final bank: the others were carried by copies
another draft of the same chunk had left behind. The chain that reads worst in the ledger is not the
one that ends worst. `hy-r3-to-01`'s flag entry was superseded at 4/10 shared, the entry that
replaced it was superseded again at 3/13, and the flag name survived anyway because a second draft of
that chunk had banked it. So cleaning up repeats cannot be decided before the guard question is
settled: on these numbers the repeats are the redundancy that survives destructive merges.

**Instrument limits.** "Dropped a value" is measured by token shape and by the corpus's own labels.
The corpus says which values a tool output states; it does not say which values a later chunk may
legitimately retire, and a reworded value that a reader would call preserved (a path shortened, a
number re-united with its unit) is counted as dropped. These are reported columns, not gates, and the
fixture check pins the classifications rather than asserting they are the right ones.

**Decision: two candidate moves, both now priced.** Tightening the relaxation buys 9 preserved facts
for 5 duplicates. Carrying values in a verbatim surface — upstream's `details`, copied from
uncompressed messages by code and never re-spoken by the model — removes the threshold from the
problem entirely: a merge would no longer have to restate a value for the value to survive. The
second is upstream's existing structure, and on these numbers it is the cheaper of the two, because
it does not trade destruction against duplication. Neither is applied. Nothing in `src/` changed for
this measurement.

## Tier 1: were the destroyed values recoverable at all? (offline, 2026-10-23)

The structural option in plan-divergence.md — carry a verbatim copy of the source chunk behind each
fact, upstream's `details`, copied by code and never re-spoken — was priced against a tightening of
the subject guard. Pricing it needs one fact first: **would a verbatim copy have preserved what the
merge destroyed, or would it have copied bytes that never held the value?**

`dev/verbatim-report.ts` answers that offline. No model call, no route, no endpoint, no temperature:
it reads the merge audit's rows over six ledgers, takes each corpus-declared value an accepted merge
destroyed, and searches the **verbatim text of the chunk that authored the destroyed entry** — the
text the pipeline already had in hand at that moment. Matching rules were fixed before any number was
read: whitespace runs collapsed, typographic dashes and quotes unified with their ASCII forms,
markdown emphasis and code-span markers stripped, underscores inside identifiers left intact, and the
token-boundary rule from the probe matcher. No fuzzy matching. `false-hit` is a reported category:
where a naive substring search says the value is present and the boundary rule refuses.

Measured over six runs:

| | |
|---|---|
| declared values an accepted merge destroyed | 9 |
| recoverable verbatim from that chunk | **9** |
| false hit (substring present, boundary refuses) | 0 |
| absent (the characters are not in the source at all) | 0 |
| of those 9, value sits in a **tool output** line | 5 |
| of those 9, value sits only in a **spoken** line | 4 |
| declared values that survived the merge | 92 |
| …and still carry ≥ 4 consecutive words of their source chunk | 72 |
| …surviving only as model restatement | 20 |

The tier's stop rule was set before measuring: if fewer than two-thirds of the destroyed values were
findable in the source text, the verbatim option would be dropped. It is not dropped: **9 of 9**.

What this rules out is the strong objection — that a copy would preserve nothing because the value was
never in any text the writer held. What it does not show is that verbatim storage is the right move.
The 4 values found only in a spoken line were recoverable from an *earlier wording*, not from the tool
output that produced them, and a copy that recovers a value from the wrong line is a copy of the wrong
thing.

**Price, two ways** (`estimateTokens`, no model): a verbatim surface holding only the chunks behind
this run's lost values costs **374 tokens**; a surface holding one verbatim block behind **every**
stored entry costs **12,475 tokens**. The active bank across these six runs is 5,770 tokens. The
narrow form is cheap enough to be a real option; the whole-surface form is larger than the memory it
protects.

`tools/verbatim-report-check.ts` pins the matching rules against a chunk with known answers: `4096`
inside `14096` must be a false hit, `--dry-run` inside `--dry-run-all` a false hit, `0640` inside
`*0640*` recoverable from the tool output, a value that appears only in an assistant line recoverable
but flagged `spoken line`, `9999` absent, one active entry classified as quoting its source and one as
restating it, and the narrow surface priced below the whole-surface one.

## Tier 2: the same bank re-folded under three subject guards (offline, 2026-10-23)

`dev/guard-fold-report.ts` re-runs the fold on the same ledgers under three settings, changing only
`sameSubject`'s relaxation: **as shipped**, **tightened** (the loose clause needs ≥ 4 shared tokens *and*
≥ 25% of the target's wording; the "restated half" clause untouched), and **off** (every UPDATE the
reconciler proposed is applied).

Two things had to be true before any comparison meant anything.

**The fold has to be the shipped fold.** Each arm rebuilds one batch's proposal stream from the ledger
and calls shipped `src/bank.ts` `applyOps`, with the guard re-derived from shipped `src/protocol.ts`.
Recorded `UPDATE`s are proposals; refusals the pipeline downgraded to `ADD` are put back as the UPDATEs
they were — but only the ones the **subject test** refused (22). The retrieval test and the batch test
also downgrade proposals (7), they are not tier-2 variables, and they stay as recorded. Self-check: the
as-shipped re-fold reproduces the recorded bank, entry for entry, in **6 of 6 runs**.

**The rule has to be re-derived, not trusted.** The shipped arm runs the shipped clause over the
restored proposals and refused 22 of 22. `tools/guard-fold-check.ts` pins the opposite case — a
recorded refusal that the re-derived rule would let through — and the fixture names it.

Measured over six runs, 129 merge proposals:

| setting | accepted | refused | target gone | values dropped at merges | declared lost at merges | **gone by the end** | dup values | facts | tokens |
|---|---|---|---|---|---|---|---|---|---|
| as shipped | 107 | 22 | 0 | 58 | 9 | **1** | 31 | 245 | 5770 |
| tightened | 92 | 35 | 2 | 39 | 4 | **1** | 36 | 258 | 6100 |
| guard off | 122 | 0 | 7 | 95 | 15 | **5** | 29 | 223 | 5264 |

`accepted + refused + target gone = proposed` in every arm, asserted in the instrument rather than
assumed by the reader; a target that a previous choice in the same fold never wrote is a cascade, not a
refusal, and it is counted in its own column.

**Two measurements, and only one of them is about the bank.** "Declared lost at merges" counts values a
merge dropped. "Gone by the end" counts values the bank held at some point in that fold and no longer
holds at all. They differ because a second draft in the same chunk so often restates the value: under the
shipped guard, 9 declared values were dropped at merges and exactly **1** left the bank for good. A
destructive merge is not a lost value unless nothing else says it.

That single change reorders the two candidate moves:

- **Tightening the loose clause is not supported here.** It refused 13 more merges and cut merge-level
  losses from 9 to 4, and the final bank lost the same **1** value either way — for 5 more duplicated
  facts, 330 more tokens, and 2 cascades that the shipped setting did not have.
- **Switching the guard off is measurably worse**, not cleaner: 15 declared values dropped, 5 gone by
  the end, and 7 targets destroyed by cascade. Whatever the loose clause is doing, it is not nothing.
- **The verbatim option now has the stronger support.** Tier 1 says all 9 destroyed values were already
  in the chunk text the pipeline held; tier 2 says tightening the threshold recovers five of them at the
  merge and none of them at the bank. A copy does not need the threshold to be right.

**The instrument that under-counted, and the second time two of mine disagreed.** The fold first
reported 6 declared losses where the merge audit reported 9. The fold had enumerated the target's
*specific tokens* and then asked whether each was declared; multi-word probes — `line 63`, `line 77`,
`pass complete in 6.2 s` — are declared values and not specific tokens, so the fold could not see them.
The enumeration is now the target's own tokens plus every probe its authoring chunk declares, and both
instruments read 9 on the shipped arm. The cheaper instrument was wrong again, and it was wrong in the
direction that flattered the guard.

**Boundaries on this section.** The model's drafts are exactly the ones the run recorded; a live run
under a tightened guard would have been shown a different bank and would have drafted differently, so
these are bounds on the rule, not simulations of runs under it. The ledgers were read, not rewritten.
Nothing in `src/` changed for either tier, and both tiers are reported rather than gated.

## Tier 4, offline half: how often the writer's view is cut, and by which rule (2026-10-23)

Two clip rules live in `src/entries.ts` and they are not the same rule. Message and tool-result bodies
go through `clip(text, maxEntryChars)` at 3000 and keep a trailing `…`. Tool call arguments go through
`JSON.stringify(…).slice(0, 240)` and keep nothing. Upstream raised its own argument window from 80 to
600 because 80 was cutting real flags, and keeps a regression test for that case; ours is 240 and silent.

`dev/clip-report.ts` measures how often the silent one fires, on the chunk texts real sessions were
actually shown (51 captures, 3,715 rendered lines). A call whose arguments stop being parseable JSON is a
call the window cut, so the instrument uses a bracket scanner with matched closers rather than a parser —
a parser throws on the first truncated call and cannot count truncated calls at all.

| measure | value |
|---|---|
| tool calls the writer was shown | 1,955 |
| arguments cut at 240 with no marker | **589 (30.1%)** |
| of those, the cut falls inside a quoted string | 555 (94.2%) |
| captures holding at least one cut call | 50 of 51 (98%) |
| cut calls whose own result the writer saw on the next line | 584 |
| …of those, a result carrying a flag the visible arguments did not | 20 |
| longest arguments the writer saw whole | 240 chars |
| whole calls within 40 chars of the window | 152 |
| lines carrying `clip()`'s visible `…` at 3,000 | 168 |

The instrument guards its own method: a whole call measured longer than the window is printed as a FAIL,
because it means the scan ran past a cut call. It fired twice while this instrument was being built — once
as 500 characters of "whole" arguments (the scan had walked into the next call's JSON) and once as 241 (a
depth-only counter closed the object on the `]` that closes `[called …]` rather than the arguments). Both
were instrument bugs, not properties of the sessions, and the guard is what caught them.

**The corpora never exercised this at all.** `dev/corpus-restraint.json`, `corpus-restraint2.json` and
`corpus-restraint3.json` contain zero `[called …]` lines between them: the `tool_output` class models tool
*results*, not tool *calls*. Every merge and guard number in this file was measured on text where the 240
window cannot fire. That is a hole in the corpus design, not in the measurement, and it is the reason the
fourth corpus needs tool-call chunks with the decision-relevant part late in the arguments.

**The fixture pins the failure mode** (`tools/clip-check.ts`, no model). A 363-character argument list
whose `--purge-age=90d` sits at offset 265 reaches the writer as exactly 240 characters, ending mid-token
at `"purge`, with the flag absent and no marker anywhere in the line. The same call rendered with a
600-character window keeps the flag, which locates the loss in the window rather than in the content. A
tool-result body over `maxEntryChars` is cut at 3,000 and the `…` is the last thing the writer reads, and
a body inside the window carries no marker. The two clip paths differ exactly as DESIGN.md now says they
do.

**What is not claimed.** The 20-flag figure bounds the writer's other route, not the loss: a flag readable
in a result line says the writer had a way to learn that flag, not that the removed tail held it. Whether
the silent cut costs a fact in a real run, whether 600 would be better than 240, and whether a visible
marker tempts the writer to invent the missing tail are model questions, and they are the run arm this
tier has not spent yet. Nothing in `src/` changed for this tier.

## Tier 6a: can one session destroy another's fact? (2026-10-23, offline)

Upstream fences writes by ownership. Its store takes `session_id` on every mutation, its scope carries
`agent_id` / `session_id` / `workspace`, and a candidate outside that scope is dropped before the model
sees it. Here the fences are different and narrower: `candidatesPerDraft(bank, drafts, limit)` takes a bank
and drafts and has no session to scope by, and an UPDATE is accepted only if the target was retrieved for
*that* draft and passes `sameSubject`, which reads `{task, statement}` from each side and nothing else.

**The real-data count** (`dev/session-scope-report.ts`, no model, no network):

| measure | value |
|---|---|
| run directories under `out/` | 34, of which 28 have a `ledger.jsonl` |
| ledgers whose chunk ids carry a session (`hy-<sessionId8>-`) | 19 |
| ledgers with no session in any chunk id (authored corpora, `hy-r3-to-01` style) | 9 — excluded, not counted as single-session evidence |
| ledgers demonstrably spanning more than one session | **1** (`baseline-kitx`), one of the 19 above rather than a fourth category |
| destructive ops read (UPDATE + DELETE) | 383 |
| of those, crossing a session boundary | **0** |
| how the 383 split | 217 aimed at an entry of the acting session, 0 crossing a boundary, 166 in ledgers with no session id, 0 aimed at an entry that was no longer active |

`baseline-kitx` runs `hy-01a15629-001/002` then `hy-01a1510e-077/016/012`. Its one destructive op
(`hy-01a15629-002` UPDATE) targets an entry written by `hy-01a15629-001` — its own session. So the tier's
direct evidence is one observed opportunity, not taken.

These counts describe this working tree's `out/` as of this commit, not a permanent property of the repo:
a run directory only counts if it has a `ledger.jsonl`, and 6 of the 34 directories do not.

The fold is rebuilt before each chunk rather than once per ledger, and `analyseLedger` throws if a run's
destructive ops do not split cleanly across the four classes. `foldLedger` builds a fresh bank out of
fresh entries and only reads the records it is given, so re-folding a prefix cannot inherit another
fold's mutations; each prefix is taken by record index rather than by object identity. An entry's `chunkId` is the only session
marker the bank keeps, and a superseding write replaces it via `entryFromDraft`, so folding the whole ledger
first would report a cross-session write as a same-session one.

**The synthetic half carries the finding** (`tools/session-scope-check.ts`, deterministic, now in the gate).
It shows what the rule *permits*; it is not evidence about how often the permission is used:

- Session B's draft is shown session A's entry: it appears among the 2 candidates `candidatesPerDraft`
  returned, alongside a same-session entry, so the unscoped candidate set is making a choice and still
  reaching across sessions.
- The guard is blind to ownership. The identical pair scored **3/8** whether the target sat in the other
  session's chunk or in the acting session's own chunk, and in both cases the accepting clause was the loose
  one — the same clause that owns every declared loss in the merge audit.
- The cross-session UPDATE applied. Session A's entry went `superseded`; the replacement carries
  `hy-bbbbbbbb-001`, so after the merge the only session marker left in the bank belongs to the session that
  destroyed the fact. The values only the destroyed fact carried (`--purge-target`, `var/state/queue`) left
  the active bank entirely, and no field on any `BankEntry` names a session.
- A cross-session DELETE needed nothing beyond the id.
- The contrast holds: a draft sharing no wording was refused. Wording is the fence; ownership is not.

**What this does not say.** Zero recorded cross-session ops is a fact about how runs were captured, not a
record of safety: a run with one session prefix cannot contain one. In production the bank is one store
shared by every session that touches the state directory, so cross-session targeting is the ordinary case.
The synthetic pair is authored by hand and shows what the rule *permits*, not how often the permission is
used or how much it costs when it is. No `src/` change was made for this tier; fencing destructive authority
by session remains a decision, not a measurement.

## Tier 3, offline half: the fourth corpus, and three labels the scorer did not have (2026-10-24)

Tier 3's live half needs two writer-route runs and the route has been unreachable for a week. Its offline
half does not, and it is the part that has to exist before either arm can be judged: the labels 7.17 named,
in a corpus, with an instrument able to count them. Corpus 3 stays untouched so its published numbers stay
comparable.

**`dev/corpus-restraint4.json`, 22 chunks, two authored sessions.** 12 `tool_output` chunks, 4 `nothing_work`
chunks with tool output under them, 3 attribution pairs, and four labels the earlier corpora do not carry:

- **4 chunks hold a tool call whose arguments run past the 240-character window** the shipped renderer cuts
  arguments at, measured by rendering the call through `renderEntry` and comparing against the authored full
  argument string rather than against a number written in a plan. 2 of them hide a value past the cut that
  argument string rather than against a number written in a plan. 2 of them hide a value past the cut whose
  wording appears in no chunk's visible text in either session (`--retention-days 45`, `--fail-on-missing`).
  A hidden value has to keep at least one token that no chunk shows at all, and the check names the ones it
  cannot stand on: `45` is printed twice as a timestamp minute (`@ 10:45`, `@ 13:45`), so only
  `--retention-days` can carry a supplied-not-read reading in this corpus.
- **4 chunks declare a user rule** stated beside tool output — `render.toml stays owned by canvas-builder`,
  that the cleanup job must never prune `tiles.cache` and that `tiles.cache` keeps its `0640` mode, that the
  night render does not rebalance — which has to survive as a rule and not be banked as a defect.
- **4 `nothing_work` chunks carry tool output and nothing durable**: the control the class lacked, now with
  the tool output present so abstention is a judgment rather than an absence.
- **1 cross-session pair** across the two authored sessions, which is what tier 6a's zero recorded crossings
  could not test.

`tools/restraint-corpus-check.ts` enforces each label against the shipped renderer and against privacy rules
(no hostname-shaped token, no absolute path under a home or system directory, no credential-shaped string),
and prints the gate for all four corpora: corpus 4 reports 12 tool_output chunks, 4 constraint chunks, 4 cut
calls, 2 hidden values, 4 tool-bearing nothing-durable chunks, 1 cross-session pair over 2 sessions, ~2285
estimated tokens. `tools/restraint-corpus-mutation-check.ts` breaks each rule deliberately, one at a time, and
requires the check to reject each break by name: **37 breakings across the four committed corpora, each
rejected**. The older corpora fail nothing, and the check also says what they lack: corpora 1 and 2 hold no cut
call, no hidden value and no declared rule, and corpus 2's six `nothing_work` chunks all carry tool output —
the class boundary 7.17 names as missing, visible in the corpora rather than fixed in them.
The corpus is derivable rather than asserted: `dev/gen-corpus-restraint4.mjs` pads each long command with
flags real commands carry until the value it must hide falls outside the window, slices the arguments the way
`src/entries.ts` slices them, and re-running it rewrites the committed file byte for byte (`diff` against the
committed corpus is empty). The check does not read the generator: it re-derives the same window by rendering
the call through `renderEntry`.

**Three new columns, reported rather than gated.** In `dev/restraint-report.ts`:

- **declared rule text** beside tool output — kept verbatim in a bank fact, present only as a rearrangement of
  the rule's content words (`rewords`: every content word of the phrase present, any order, any framing around
  them), or reaching no bank fact at all. Counted per rule, because one chunk can declare two rules and keep
  one. A keep here means the rule's wording sits in a banked fact, not that the rule was obeyed. A banked fact
  whose only tie to the chunk is such a rule is counted apart, since the outcome column can only read that as
  `kept-other`.
- **the hidden-value carry** — `hiddenSignatures` splits a hidden value into its flag names and numbers and
  drops every token any chunk in the corpus shows, so neither a chunk that prints `45` in plain sight nor a
  session that prints `45` as a timestamp minute two chunks away can be cited as evidence that a bank fact
  carrying `45` invented it. A fact from that chunk carrying what stays unread is reported as supplied rather
  than read, and the corpus check rejects a hidden value whose every token is visible somewhere.
- **possible chatter paraphrase** — a fact carrying no declared value, no constraint and no quoted chatter, but
  holding a declared chatter phrase's content words. This is the hole the 2026-10-22 label audit found and
  literal anchor matching could not see, and it is reported beside the literal count, never instead of it. It
  is word matching and not understanding: a synonym substitution slips past it, and a shared technical noun can
  over-count it.

`tools/restraint-report-check.ts` now pins all three on a fixture whose answers are known by construction: a
rule carried inside the same fact that carries the tool fact; a chunk that banked three facts and lost its
rule; a rule quoted with no tool fact attached; a rule present only as its content words rearranged; a fact
carrying `--retention-days` out of a chunk that never shows it; the same probe over a chunk whose hidden value
reached nothing, reporting nothing; a chunk hiding `--lock-wait 900` where another chunk prints `900` in a tool
result and a banked fact carries it, which is counted as reading and not inventing; and chatter reworded into a
bank fact. The false-positive guards are asserted too: `hiddenSignatures("--retention-days 45", "the sweep
keeps 45 keys")` and `hiddenSignatures("--lock-wait 900", "lock wait budget 900 ms")` each keep only the flag,
and `rewords` needs two content words, so a bare number is never a rule.

**What the new columns say about the frozen corpus-3 runs.** Re-running both published arms leaves every
number already in this file where it was — 37 and 35 active facts, `kept the declared tool fact` 10/12 and
12/12, repeats 8/12 and 5/12, declared values 24/24 and 23/24 — and adds one reading the literal column could
not produce:

- shipped prompt: **0** banked chatter paraphrases;
- the actor arm: **1**, and it is named — `hy-r3-to-03`, declared chatter "I pulled up the queue module",
  banked statement "Assistant pulled up queue module to see where a write lands (src/queue.rs)", carrying
  neither declared probe (`queue.tmp`, `src/queue.rs:52`).

That turns 7.17's "part measurement and part artefact" claim into one case read by hand rather than an
inference: under the actor arm that chunk's own chatter sentence reached the bank reworded, so the column
reading `fact and chatter 0` for it was not describing absence. It does **not** settle whether the arm's
`chatter banked 2 → 0` was restraint or rewording overall — one case is not a rate, and the loose reading is
word-matching, so a synonym substitution still slips past it. Corpus 4's declared chatter is what that
measurement needs, and it needs two runs on a writer route.

**Limits of this half.** Corpus 4 has never been run: every number above is either a corpus property checked
against the renderer, a fixture with constructed answers, or a re-scoring of ledgers that already existed. No
`src/` file changed, no published number changed, and no rule was written for the `tool_output` class from
these labels — the class still has no shipped behaviour, which is what 7.13 measured and 8.3 is still open on.
