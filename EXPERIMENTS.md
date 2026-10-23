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
