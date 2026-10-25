# TODO — baseline, Tier-1 fixes, and measured improvement experiments

## Goal

Establish a measurable baseline of the current pipeline on fresh dev-captured chunks, ship the
confirmed Tier-1 protocol fixes (per-draft candidate coverage, SKIP), then improve the writer
prompts one variable at a time against that baseline, adopting only variants that pass a numeric
gate.

## Tasks

### 1. Baseline infrastructure (no `src/` changes)

- [x] 1.1 Capture the corpus from material this live session already produces (no separate
      sandbox run): `dev/capture-session.ts` reconstructs each write's chunk from the extension's
      own state (`<sessionId>.ledger.jsonl` `hy.extract` coverage chain + sourceEntryIds) and the
      `PI_SESSION_FILE` entries, re-serializing with `src/serialize.ts` so each capture is the
      exact payload the writer saw; save to `captures-dev/` (gitignored). Cross-check one or two
      captures against the llama-swap UI request logs (manual step; hostnames never committed).
      Corpus must include: a dense implementation window, a chunk with user-stated rules and
      preferences, an idle/chatter-heavy window — this session already wrote 2 chunks and keeps
      producing; flag any missing category and take it from another recent session state dir.
      Done when ≥ 3 capture files validate.
- [x] 1.2 Write `dev/run.ts` (or extend `poc.ts`): corpus runner with named run ids, resumable
      per chunk, generous per-call timeout (600 s, the remote route is slow), writing
      `out/<runId>/{bank.json, ledger.jsonl, raw/, metrics.json}`. Done when a run survives a
      mid-run kill and resumes without re-paying finished chunks.
- [x] 1.3 Define the metrics contract in `dev/metrics.md` and emit it from 1.2:
      drafts accepted/rejected + reasons; per-draft candidate coverage (drafts with 0 shown
      candidates); ADD/UPDATE/DELETE counts; rejected + downgraded ops; active bank
      count/tokens; bank-growth ratio (Δ bank tokens ÷ estimated chunk tokens); confidence
      distribution; in/out tokens and wall seconds per call; endpoint used (primary/fallback).
      Done when `metrics.json` validates against the schema for a full corpus run.
- [x] 1.4 Write `dev/judge.ts` + `dev/rubric.md`: self-contained blind judge of a run's bank
      against the serialized chunk transcripts. Axes: supported/partial/unsupported,
      durable/marginal/noise/missed, plus four upstream-failure-surface axes:
      specificity (concrete anchors present), transition (settled *and* dropped version
      represented), should-not-store (chatter, generic assistant text, meta), evidence fidelity
      (attempted vs verified preserved). `JUDGE_ORIGIN/JUDGE_MODEL/JUDGE_KEY` env; randomized
      order + seed; never the writer model as judge. Done when the baseline bank scores
      reproducibly across two seeds (same verdicts, score delta < 5 %).
- [x] 1.5 Run `baseline-<date>` on `captures-dev/` with the current `src/prompts.ts` and
      current protocol; record aggregate numbers (no private text) in `EXPERIMENTS.md`.
- [x] 1.6 Optional speed/cost arm: rerun one chunk via the local llama-swap fallback route and
      record remote-vs-local wall and token cost for run planning.

### 2. Tier-1 protocol fixes (measured against the baseline)

- [x] 2.1 Per-draft candidate budget: shipped as `candidateRenderMode: "perDraft"` rather than a
      `candidatePerDraft` count — every draft with candidates sees its own best match before the
      global `candidateLimit` cap fills. Measured on the 12-chunk corpus: starved drafts 20.5 % →
      2.2 %, reconcile input −6.5 %, no judge-verified regression.
- [x] 2.2 `tools/candidate-coverage-check.ts` exists and runs under `npm run check`, asserting every
      draft's block carries its own candidates or an explicit no-candidates marker.
- [x] 2.3 SKIP op: `ReconcileOp` carries `{ action: "SKIP", draft, reason? }`, validated in
      `src/protocol.ts`, ignored by the bank, counted in the `hy.ops` audit record and in the
      reconcile vocabulary.
- [x] 2.4 Config, README table and DESIGN.md updated; `tools/config-docs-check.ts` and
      `npm run check` pass.
- [x] 2.5 Run on the extended corpus against the baseline: zero-candidate drafts 20.5 % → 2.2 %
      (≤ 10 % gate met), rejected and downgraded ops not increased, reconcile input 6.5 % *below*
      baseline, judge found no durable regression. Recorded in `RESULTS.md` and `DESIGN.md`
      (`EXPERIMENTS.md` was never created; results live in `RESULTS.md`).

### 3. Prompt experiments (one variable at a time; `src/prompts.ts` untouched until a gate passes)

- [ ] 3.1 Add `dev/experiment.ts --variant <name>`: variants live in `dev/variants/<name>/`
      overriding `EXTRACT_SYSTEM` / `reconcileSystem` without touching `src/`.
- [ ] 3.2 E1 confidence rubric — anchored to evidence origin (1.0 user-stated rule/constraint,
      0.7 tool-evidence inferred, 0.5 weakly inferred). Gate: share of confidence = 1.0 drops
      from baseline (> 95 %) to ≤ 80 %; durable score ≥ baseline; ranking tiers non-degenerate.
- [ ] 3.3 (deprioritised by 6.12–6.13: specificity on decision lines is already 100 % — see 6.15)
      E2 transition + specificity block — "settled on X; the interim Y was dropped",
      subject is code/decision not user/agent, statements name paths/branches/commands/error
      strings/versions. Gate: judge transition-axis score up; noise ≤ baseline; average tokens
      per fact +≤ 25 %.
- [ ] 3.4 E3 should-not-store traps — explicit exclusion of greetings, generic assistant
      suggestions, plans, system/harness boilerplate, meta-summaries (fixes the chunk-482
      meta-text finding). Gate: noise + unsupported down vs baseline; missed not up by more than
      one fact per chunk.
- [ ] 3.5 E4 query-shaped `task` — task phrased as a future retrieval query. Gate: drafts with
      ≥ 1 lexical candidate match up; no durable-score regression.
- [ ] 3.6 Record each experiment in `EXPERIMENTS.md` (variant, deltas per gate, verdict, seed,
      wall cost incl. first-chunk prompt-cache cost). Merge each winner into `src/prompts.ts`
      with its own commit; re-run 2.5-style gates after merges.

### 4. Observability and read path (after the Tier-1 gate)

- [ ] 4.1 Bank-growth audit: `hy.ops` records gain `bankGrowth { dBankTokens, chunkTokens }`
      (the ratio the upstream RL penalty taxes); surface worst recent ratio in `/hy` status;
      add a `tools/` check.
- [x] 4.2 `hy_recall` query mode: text query → lexical ranking, top-k ids and snippets, and `id`
      expansion with the exact source entries; covered by `tools/recall-check.ts` (named
      `recall-check`, not `recall-query-check`). **Remaining:** the `hy.recall { ids }` usage record,
      which 4.3 waits on — without it there is no recall telemetry to rank the pool from.
- [ ] 4.3 E5 (deferred until ≥ 30 `hy.recall` records exist across sessions): pool ranking from
      recall hits + recency instead of the saturated confidence tiers; run against corpus banks,
      gate on durable facts surviving compaction summaries.

### 5. Consolidation

- [ ] 5.1 Update `DESIGN.md`, `README.md`, `RESULTS.md` to match shipped behavior and record the
      experiment table; docs/code consistency checks and `npm run check` pass. Continuous, not a
      one-off: the flush, cadence and boundary results are recorded, and each behaviour change so
      far came with its README row and DESIGN paragraph in the same commit.
- [ ] 5.2 Write the Tier-4 follow-up plan (upstream two-layer fact + value-bar experiences
      output shape) as a separate `plan-two-layer.md` — explicitly not executed in this TODO.

### 6. Open after `hy_flush` (measured 2026-10-21, `experiment/hy-flush`)

- [x] 6.1 `hy_flush` shipped with `flushTool`, `flushListEntries`, `flushMinTokens`; pure rules in
      `tools/flush-check.ts`, wiring in `tools/flush-tool-check.ts`.
- [x] 6.2 Does a quantized session model use it? Yes, 3/3 unprompted two-step calls
      (`dev/live-flush.sh`), and it writes a turn earlier than the 1 200-token threshold does
      (`dev/live-cadence.sh`). The cooldown is what refuses a dead writer, verified live. **Corrected
      by 6.8:** with the shipped floor the early calls are refused, so that ordering belongs to a
      config where the floor was clearable, not to the shipped one.
- [x] 6.3 Does a finer boundary buy quality? No (`out/base-2026-10-21` against
      `out/halves-2026-10-21`, judged twice): specificity flat, durable share 60 % → 51 %, bank
      +53 %, 2× writes for +14 % prompt tokens. Predictions pre-registered in
      `notes/boundary-prediction.md`.
- [x] 6.4 Does earlier coverage survive a compaction? **No advantage measured** (3 runs per arm,
      `dev/live-reload.sh`, result in `RESULTS.md`). Both arms kept 7/8 settled specifics in the
      summary; treatment answers were 7/8, 6/8, 5/8 against the control's 7/8, 7/8, one unanswered.
      The render carries everything the bank holds; the bank is short one probe per run because
      extraction never proposed it, and post-cut `hy_recall` handed the answer two probes it dropped.
      Treatment cost: 22 540 writer tokens and 572 s over three runs. Not measured: a restart
      (`/compact` then a fresh process) rather than compaction inside one session.
- [ ] 6.5 Does `flushMinTokens` hold real sessions near threshold-sized chunks, or does it just
      refuse? Partly measured: at a 1 200-token threshold — below the 2 000-token floor, so the
      floor cannot be cleared by construction — 7 of 9 ranged calls refused and the two accepted
      chunks carried 2 291 and 2 680 tokens. **Remaining:** the same run at the shipped
      `observeAfterTokens: 6000`, where a 2 000-token flush can win the race.
- [ ] 6.6 Retrieval precision on a larger bank: the arm's 240-fact bank may answer more queries and
      crowd out the right fact. `hy_recall` ranking is lexical and there is no precision measurement
      for it yet.
- [ ] 6.7 Recall telemetry (`hy.recall` records, 4.2 remainder): without it the pool ranking in 4.3
      has no usage signal, and tonight's relevance-tier borrowing idea has nothing to rank on.

- [x] 6.10 Extraction coverage of short enumerables (from 6.4): three of six treatment runs lost a
      probe the writer never proposed — `exit code 3` in one, `TOR_TOOL_SETTINGS` in two. The render
      and the compaction are clean, so this is the only place a retention claim can be won. Measure on
      the existing captures (`dev/enumerable-coverage.ts`, offline). Answered on `dev/corpus-extended.json`:
      of 43 probes in decision lines, `trans-base` proposed 11 and banked 18 (42 %), `halves` proposed the
      same 11 and banked 23 (53 %). Numeric limits stated as decisions went 0/3 in the base arm. But the
      corpus holds one env var and zero exit codes in decision prose, so it cannot rank variants on those
      shapes — see 6.12. `trans-clause` moved nothing.
- [x] 6.12 A corpus where the rare shapes occur by construction (from 6.10): authored
      `dev/corpus-enumerables.json` (14 exit codes, 12 env names, 13 limits, 11 rejected alternatives in
      decision lines) and scored it: 58 of 58 proposed and banked. Dilution (`dev/corpus-enumerables-noisy.json`)
      55 of 55. Replaying the 6.4 session offline (`out/reload-replay`) carried 61 of 66 including
      `exit code 3`. Extraction is not the defect — see `RESULTS.md`.
- [ ] 6.14 A chunk lost to a truncated response stays lost: `out/reload-replay` chunk `hy-reload-006` failed
      twice with the same parse error at position 423 and was dropped. A fresh extract at temperature 0
      reproduces the same truncation, so the retry only re-pays the extract. Either raise the output budget
      on retry, or split the chunk, or record the loss as a gap so coverage says so.
- [ ] 6.15 Is one coarse write the reason 6.4 lost a probe? The live run wrote once over ~2 680 tokens
      (5 drafts, 13 facts); the same text replayed in 8 chunks of ~1 200 tokens proposed 61 of 66 probes,
      and organic halves retain 53 % where 12 chunks retain 42 %. Test a live arm with a smaller chunk
      budget before touching the writer prompt. ~30 decision statements
      carrying exit codes, env var names, numeric limits and rejected alternatives, written as session
      turns, committed as `dev/corpus-enumerables.json`. Without it the denominator for 6.10 is one env
      var and zero exit codes, so no writer-prompt variant can be ranked on the shapes that 6.4 lost.
      Gate: every category has ≥ 8 stated instances in decision prose, and `trans-base` scores on it
      before any variant does.
- [ ] 6.11 Does the session model use what `hy_recall` hands it? In 6.4 the post-cut recall results
      contained both probes the answer lost. Before ranking anything in 4.3 or 6.6, repeat that one
      question on a stronger session model: if the loss is the 4-bit model ignoring tool results,
      retrieval changes will not fix it.
- [ ] 6.16 Counterfactual reader eval for the durability tier (the gate 6.15's tier replay
      cannot pass on its own). `dev/ratification-tier.ts` shows which facts change side when
      a protected tier is placed first — 5 rescued, 6 displaced on the `01a1510e` fold — but
      not whether keeping them helps a reader. Build two banks per session (shipped recency
      cut vs union tier over the same ledger fold), take questions from *later* turns, and
      answer them blind from each bank. Label every fact that moves side: needed / already
      redundant / stale / harmful. Gate: rescued facts are needed by a later question at a
      rate the displaced facts do not match, and no protected fact is stale-but-used. Until
      that reads as a benefit, no `enforceBudget` or `DESIGN.md` change.
- [ ] 6.17 Tombstone discipline if the tier ships: a protected fact must remain an UPDATE
      candidate, and a later statement must supersede it rather than compete with it. Measure
      on the fold how many protected facts are contradicted by later chunks — the class mixes
      constraints with work state (an E2E exit code, a blocked spec), so without this the tier
      accumulates stale facts. Requires 6.16 first.
- [x] 6.8 What does offering the tool cost? Measured against a writer that answers
      (`out` of `dev/live-cadence.sh`, 3 runs × 3 arms): +28 % writer tokens and +13 s per session
      over `threshold-only`, and the extra write was threshold-triggered, not a flush — the tool
      round grows the window past the threshold again. Seven of nine ranged calls refused at the
      floor for zero writer cost, and `flush-only` left one session of three with no write at all,
      so the threshold is what guarantees coverage (`RESULTS.md`).
- [x] 6.18 Can a fact the pool dropped still be read? No — fixed 2026-10-24. The `hy_recall`
      query scored only `status === "active"`, so on a real session that reached `bankMaxTokens`
      (159 writes; 631 facts retired by the ceiling, 1 405 specific values carried only by
      retired facts, oldest fact still current from write 116) the ceiling removed most of the
      session from the only read path, while `src/bank.ts`
      and DESIGN.md both claimed a superseded fact "stays recallable". The query now scores the
      whole bank (`recallHits`, `renderRecallHit` in `src/render.ts`): live facts fill the result
      first, a retired fact is added only when it matches better than the weakest live one and
      never more than three of them, every retired row says what dropped it, and a merge-retired
      row names what replaced it. Pinned by `tools/recall-reach-check.ts` and by the tool itself
      in `tools/recall-check.ts`, including that the tool cannot grow an active-only slice again.
      First organic probe (2026-10-24, `EXPERIMENTS.md`): asked about a value two budget-retired
      facts carry and nothing current does, the session said "both retired from the active bank",
      cited both ids, and wrote them in the past tense. So the marker was read on one probe — with
      its own history to corroborate it. Not measured: a fresh session with no history of the fact,
      and whether the model will *act* on a retired value without checking for a current carrier
      — that is 6.11's question with a new class of row in it. Read again with
      `dev/live-bank-report.ts --snapshot out/live-snapshot --session <id>` (pinned by
      `tools/live-bank-report-check.ts`): the numbers below were read 2026-10-24 from a frozen
      copy of a session that was still writing, ledger digest `a44ac4ebb1c3`.
- [x] 6.19 What a fold cannot reproduce — measured, and smaller than it looked, on a frozen copy
      of the session (`--snapshot`, ledger digest `a44ac4ebb1c3`): retirement is never written to
      the ledger, so folding that session yields 1 451 active facts / 104 736 tokens where the
      store held 820 / 59 980. Re-applying the ceiling — which `src/index.ts` does on reload —
      lands on 821 facts, one more than the session had and not the same ids: reproducible to
      within the write that landed between the last budget pass and the copy. A folding
      instrument therefore reports a bank 631 facts larger than the writer saw when it never
      applies the pool, and reproduces it to within one fact when it does
      (`tools/live-bank-report-check.ts` pins that trimming never adds facts back). What is still
      missing is record, not reproducibility: an audit cannot say which fact the ceiling dropped
      and when, and `hy.evict` stays proposed in DESIGN for that.
- [ ] 6.20 `fromUser` on a real session: 3 of 820 current facts are user-grounded. The summary
      reserves `summaryConstraintShare` (0.1) for facts the user stated and refills the slice
      with whatever fits, so in organic use that slice is close to vacuous. Establish whether
      chunks rarely contain a user turn or whether `draft.refs` → `chunk.roles`
      (`src/pipeline.ts:240`) misses them, before changing the share or the claim in DESIGN's
      selection section.
- [ ] 6.21 Retrieval refusals scale with the bank: 378 downgrades in the snapshotted session —
      170 "target not retrieved for this draft", 160 "does not restate its subject", 48
      "already superseded in this batch" (`dev/live-bank-report.ts` prints the mix). The writer
      names merge targets a `candidateLimit: 24` view never showed it. This is 6.6's precision
      question arriving from the writer side, and it grows with the bank.
- [ ] 6.22 `stats.json` counts the process, not the session: that session's ledger holds 159
      write records and its stats say `writes: 14`, because the counters reset at `session_start`.
      The status line reads as a session total. Either restore counters or say what they count.
### 7. Restraint: the axis no corpus here measures (plan: `plan-restraint.md`)

- [x] 7.1 `dev/corpus-restraint.json`: 8 authored `attribution` pairs (identical claim, only the
      frame flips — user-stated vs quoted from a named third party) plus 10 `empty` chunks whose
      correct output is `{"drafts":[]}`. `gate` block requires 8 pairs and 10 empty chunks, so a
      thin denominator fails loudly the way 6.12's does. Built: 26 chunks, mean 140 est tokens
      (79–216), 3 645 total — the writer-friendly window size, which is the right way round for a
      restraint test.
- [x] 7.2 `tools/restraint-corpus-check.ts` under `npm run check`: pair isolation (a pair differs in
      exactly one declared variable), no forbidden string leaking into the empty chunks, no probe
      string present in `EXTRACT_SYSTEM` or `reconcileSystem` (a probe that exists in the prompt
      measures the prompt), privacy scan. In `npm run check`, and shown to fail: six mutations of the
      committed corpus each exited 1 with the intended reason (second variable in a pair, anchor that
      is a prompt word, marker named on the keep side, gate short by one, anchor leaked into an empty
      chunk, absolute path).
- [x] 7.3 `dev/restraint-report.ts`: offline, no model calls. Scores at **two gates** — what
      `hy.extract` accepted and what `foldLedger` left active — because `extract` never sees the
      bank and only `reconcile` can refuse a duplicate. On empty chunks it separates *abstained*
      (0 drafts, 0 rejects) from *code-suppressed* (0 drafts, `rejectedCount > 0`) from *intruded*.
      Headline metric is **pair-correct**: keep side banked *and* quote side clean.
- [x] 7.4 Two scoring contracts, both reported: `strict` (quote side must produce no draft — the
      external benchmark's contract, so the numbers stay comparable) and `attributed-ok` (a draft
      that names the third party counts as restraint). The divergence is deliberate and gets written
      down, not folded into a better-looking number.
      Built, with `tools/restraint-report-check.ts` in `npm run check`: a fixture ledger whose score is
      known by construction, asserting the cases a table reader gets wrong — unattributed intrusion,
      attributed restatement (which *must* score `pairStrict=false` / `pairAttributed=true`), a
      draft-gate intrusion reconcile refused, a keep-side draft reconcile dropped, and one of each
      empty outcome, plus a paraphrase that drops the anchor token (scored as restraint, flagged as a
      suspect). `hy.gap` records carry no `chunkId` and must be skipped. **Decision on 7.4**: the
      headline is `attributed-ok`, with `strict` printed beside it so the external number stays
      comparable.
- [x] 7.3a The first real run found the scorer wrong rather than the writer. `keepBanked` read only an
      entry's own `chunkId`, and an `UPDATE` writes a *new* entry whose `chunkId` is the newer chunk, so
      every pair whose quote side merged into the keep-side fact scored as a lost claim: recall printed
      1/8 on a corpus where every claim survived. Recall now follows the `supersedes` chain (8/8), and
      the bank gate separates **merged into the keep-side fact** from **added a second active fact** —
      the first is reconcile doing its job, the second is the duplication restraint is about. Fixture
      pair `g` is that merge shape, which the original fixture had no case for.
- [x] 7.5 `restraint-base` run on current `src/prompts.ts`, unchanged, scored before any variant.
      Local writer, temp 0, `reasoning_effort: none`, background task. Judge twice (seeds 7, 11,
      never the writer) for the soft axis only: `shouldNotStore` and `supported: none` on the quote
      and empty chunks.
      Measured (`out/restraint-base`: 26 chunks, 74 drafts, 0 rejected, 43 active facts): recall 8/8;
      quote side withheld at the draft gate 0/8; added nothing new at the bank gate 7/8; pair-correct
      0/8 strict, 5/8 attributed-ok; 8 pairs merged into the keep-side fact, 1 added a new fact, 2 end
      with the subject held twice; `SKIP` used once in the whole run. Empty chunks: 0/10 abstained, 21
      facts banked — about 15 chatter, about 6 defensible memories the corpus label was too strict to
      admit. Written up in `EXPERIMENTS.md`.
- [ ] 7.6 Decide from the baseline, not from the prediction: abstention ≈ 0 means abstention is not
      a prompt property and opens a separate plan for a deterministic filter beside `SECRET_PATTERNS`
      in `src/protocol.ts`; abstention high with attribution intrusions high opens a speaker-clause
      variant; both high makes this corpus a regression guard.
      Reading from the baseline, for the decision rather than against the prediction: draft-gate
      abstention is 0/8, which is the branch that says "abstention is not a prompt property". But the
      same run shows the bank gate nearly clean (7/8 added nothing new, 8 merges, 1 new fact) and the
      judge keeping 9–11 of the 23 facts banked from nothing-durable chunks. A deterministic filter
      beside `SECRET_PATTERNS` would suppress facts an independent judge calls keepable, which is not
      the trade 7.6 anticipated. Decision left open.
- [ ] 7.7 Deferred to slice 2, gated on 7.3 being stable: the dedup class (intrusion only when two
      active facts cover one subject or the existing one is not superseded — an `UPDATE` is not an
      intrusion unless it loses source refs or narrows a fact that stayed true) and the policy class
      (title kept, salary excluded), which is really a question about where a semantic exclusion
      belongs now that `SECRET_PATTERNS` already answers the syntactic half.
- [x] 7.8 Label audit, findings only (`EXPERIMENTS.md`, 2026-10-23). Same ledger, no new model run,
      per-op agreement across the two judge seeds: 9 of 23 banked facts survive both. The split is not
      durable versus transient — every op both seeds kept says something about tctl or the source, every
      op both seeds rejected says something about what the participants did. Labels, the `empty_chunk: 10`
      gate and the published 0/10 are unchanged; relabeling three chunks would drop the class to 7 and
      fail the corpus check, which is the reason the audit is findings and not a re-score.
- [x] 7.9 Slice 2 corpus work the audit implied (`EXPERIMENTS.md`, 2026-10-23). `dev/corpus-restraint2.json`
      with its own gate — 8 new attribution pairs, 6 `nothing_work`, 6 `tool_output` — a new corpus rather
      than a relabeling of the ten. `restraint2-base`: `nothing_work` 0/6 abstained, 12 facts banked, the
      judge finding **0 durable in either seed**; `tool_output` 6/6 keep the declared tool fact and 0
      declared chatter, but only 3/6 keep the fact and nothing else; draft gate 0/8 withheld again, same as
      v1. `tools/restraint-corpus-mutation-check.ts` now proves the corpus check rejects 13 different ways
      of breaking the corpus, each by the rule it broke.
- [x] 7.10 The bank-aware draft-gate experiment, run and **falsified at the gate it aimed at**
      (`EXPERIMENTS.md`, 2026-10-23). `writeChunk` gained `bankIndex` and `dev/run.ts --bank-index` arms it,
      off by default; `tools/bank-index-check.ts` pins that the index arrives as background rather than
      transcript, carries no bank ids, drops whole entries when the cap bites, and leaves the flagless
      request byte-identical. Replaying each arm's ledger through the same renderer: the pair's anchor was
      in the index at **8/8** quote chunks and the cap dropped nothing, and the writer restated the claim
      anyway — draft gate 0/8 in both arms, on both corpora, recall 8/8. Everything else moved ±1–2 pairs
      of 8 in opposite directions on the two corpora (v2 bank gate 5→7, v1 7→8; pair-correct 1→1 and 5→4),
      for ~2.2× extract input and +35 % total input. SKIP fell 1→0 in both arms: fewer drafts arriving, not
      more refusals, so a SKIP drop must not be read as restraint.
- [ ] 7.11 Named by the v2 run rather than planned: a contrast pair's tool output carries the pair anchor on
      both sides, so the bank gate and bank attributed-ok count the user's own evidence as a quote-side
      restatement (9 facts across 6 of 8 pairs; v1 has 2 across 2). The scorer now labels those facts and
      prints a diagnostic beside the published gate — attributed-ok 6/8 against the published 1/8 on v2,
      7/8 against 5/8 on v1 — and the fixture pins both so the diagnostic cannot be promoted by accident.
      The open decision is which contract is the real one: the corpus declares which anchor-carrying lines
      are shared evidence, or the bank gate scores only facts carrying the claim's wording. No re-scoring
      of published numbers until that is decided.
- [ ] 7.12 Two things 7.10 left open rather than answered. **The case where the cap bites**: neither arm's
      bank ever reached the 600-token index (3–17 entries, 45 facts max), so the run says nothing about a
      real session, where the bank is hundreds of facts and most of it is necessarily invisible — that is
      precisely where redundancy could genuinely be unseen, and testing it needs a corpus that banks past
      the cap. **The soft axis on the two arms**: the judge endpoint went unreachable mid-run (empty
      completions, then connection failures; raw outputs kept as `out/restraint2-bidx/judge-raw-*.txt`), so
      noise, unsupported and missed on `restraint-bidx` / `restraint2-bidx` are still unmeasured against the
      seeds-7-and-11 baselines. Not answered by 7.11.
- [x] 7.13 The `tool_output` class at width, measured before any rule. `dev/corpus-restraint3.json` — 12
      `tool_output` chunks, 4 attribution pairs, 2 `nothing_work` — run as `restraint3-base` on the shipped
      config. In this one run the narration story the v1 label implied does not appear in its original form:
      the declared value reached the bank in 12/12 chunks, the declared chatter was never banked *instead of*
      a value (0/12), and only 2/12 banked it alongside. What it does instead is bank the same value twice —
      8/12 chunks, 8 repeat facts, usually a confirmation in an actor frame — and the scorer could not see
      that, because a repeat carries the value and every existing column calls the chunk clean. A second blind
      spot surfaced with it: the supersede chain reaches a chunk when a fact authored there is absorbed into a
      fact written elsewhere, so 2 of the facts listed under a tool chunk were not authored by it, and one of
      them is why "the pair's audit-mode fact" looks like narration from a tool chunk. The report now marks
      the second copy `repeat`, tags facts `tool fact`/`repeat`/`chatter`/`neither`/`carried-in`, splits each
      chunk's facts into authored and carried-in, and totals the repeat and narrowest-reading columns beside
      the existing ones rather than inside them, so the published numbers of the earlier cuts stay what they
      are; `tools/restraint-report-check.ts` pins both blind spots. It also corrects 7.10: the bank-aware
      arm's higher "every fact carries the value" rate (5/6 vs 3/6) comes with more duplication, not less
      noise — 5/6 chunks repeat a value against the baseline's 2/6, its authored narration facts fall from 3
      to 1, and chunks with exactly one clean authored fact go from 1/6 to 0/6. Sample size: one run,
      temperature 0, no repeat runs, no judge verdicts, so 12/12 and 8/12 describe what this corpus did, not
      a general rate.
- [x] 7.14 **Named by 7.13, measured on every UPDATE in six runs** (done 2026-10-23). The failure this class actually shows is a declared value
      banked twice, which reconcile is supposed to SKIP. Measure whether reconcile merges two drafts that
      carry the same declared value before writing any narration rule — the suppression guard the previous
      slice planned would not have touched it. Second gap 7.13 named: every `tool_output` chunk in all three
      corpora declares a durable value, so none of them test the case the v1 label hid — chatter with nothing
      worth keeping — that gap is now 7.17. Both mechanisms were then measured offline over the six runs'
      ledgers by `dev/merge-report.ts` (107 executed UPDATEs, 29 refusals, no model call), pinned by
      `tools/merge-report-check.ts` against a fixture whose answers are known by construction.

      **Does reconcile merge two drafts carrying the same declared value?** No, and that is the surprise.
      39 such cases across the six runs, merged down to a single active fact 0 times: 36 ADD/ADD pairs and
      3 ADD/UPDATE chains, every one leaving two or three active facts covering the same value. The
      duplicate is created at the draft gate and passes the bank gate untouched, so dedup is code's job and
      no prompt instruction produces it.

      **What does a refusal cost, and is accepting more better?** Neither side is free, and the item's
      assumption — that refusing merges is the safe side — does not survive the measurement. 6 refusals
      refused a target carrying a declared value and 4 of those left two or more active facts covering it,
      so the guard's cautious default manufactures the very duplicates this item is about. Meanwhile 30 of
      the 107 accepted merges (28%) dropped a value their target carried, and all 9 corpus-declared losses
      came through one clause: the one admitting a merge on 3 shared tokens and under half the wording
      drops a value 61% of the time, against 19% for the clause that requires a real restatement and 0
      declared losses. Tightening it to 4 shared tokens and a quarter of the wording would refuse 14 of the
      107 — 9 destructive merges prevented for 5 harmless ones refused. `hy-r3-to-01`'s chain, which was
      read by hand in 7.16, is what this instrument was written to read without a human: the merge that
      retired it passed at 4/10 shared, its replacement was retired again at 3/13, and the flag name
      survived only because a second draft of the same chunk had banked it.

      The soft axis for `restraint3-base` is still unmeasured (the judge endpoint was unreachable); no claim
      rests on it.
- [x] 7.15 **Read the harness instead of inferring it from the paper** (done 2026-10-23). The
      coding module of the upstream repo was read at file level at `main`
      `6b0bd866798049940c752c402512bb0e16c98a2b` — `extractor.py`, `preproc.py`, `writer_coding.py`,
      `reconciler_coding.py`, `fact_reconciler_coding.py`, `store.py`, `types.py`, the module's own
      tests, `docs/scene-coding.md` — and DESIGN.md now carries a dated *The harness as shipped*
      section plus a divergence table. Four things this session had left blind, answered:
      **extraction rate** — upstream's coding prompt *mandates* at least one experience ("MANDATORY:
      You MUST output at least ONE experience. Do NOT return an empty list.") while its working
      prompt was softened to "DEFAULT TO EXTRACTING" plus one named exception, because the
      unconditional mandate had been "the direct cause of fabricated experiences" and a stall
      distilled into an experience reproduces itself; our prompt sits on the permissive side and
      measures 0/8 withheld, so the disagreement is now on the record rather than assumed.
      **actor frame** — upstream's coding prompt opens with a hard constraint that the grammatical
      subject of a statement is the code or the decision, never the user and never the agent, with
      no bookkeeping closers, and frames restraint as *budget reallocation* rather than abstention;
      that is the exact class our `tool_output` numbers count. **over-storage** — their durability
      bar lives in the schema, not the answer: exactly one session fact per write with no
      threshold, 0–N experiences that must pass a value threshold; their fact reconciler offers only
      INSERT and SUPERSEDE and says storing the fact "is not your decision". **quote-side truth** —
      they keep a summary surface (`subject: statement`, embedded) and a verbatim surface (`details`,
      copied from uncompressed messages by code, never by model transcription, deliberately not
      embedded and not injected on read), which is the structural answer to the problem our repeats
      circle: in a bank with a verbatim surface, restating a value is not how the value survives.
      Also on the record: their tool-args window is 600 chars and was raised from 80 because 80 cut
      real flags, with a regression test asserting a late `-Depth 3` survives the prompt — ours is
      240 chars with no omission marker. Three DESIGN.md claims were wrong and are corrected in
      place: the schema is ours and not the model's (no upstream `keys`, no upstream positional
      `refs`); the confidence field exists in their experience layer and not their fact layer; the
      ADD/UPDATE/DELETE vocabulary is their experience reconciler's, not the fact layer's. Caveat
      carried in the doc: shipped `main` is not the training distribution, and `main` moved twice in
      the fortnight before the read, so every name in that section is as-read on that date.
- [x] 7.16 **The arm 7.15 implies, scored** (done 2026-10-23). `restraint3-actor` is `restraint3-base`
      with `--extract-prompt actorframe` and nothing else changed. It moves wording and it costs a durable
      value. Statements opening with a person or with the agent's own voice fall 15/37 → 5/35 across the
      bank (10/22 → 4/21 among facts authored in the 12 `tool_output` chunks); declared chatter banked
      beside a value falls 2 → 0; one value banked twice falls 8 chunks → 5; the bank ends smaller
      (37 active facts / 773 tokens → 35 / 726); SKIP was reached for twice, both times on the
      not-durable half, and both at the bank gate — the first use of the withhold vocabulary in this
      corpus family, while neither run withheld at the draft gate (restraint strict 0/4) or abstained on a
      `nothing-durable` chunk (0/2). What it cost: `hy-r3-to-01` kept the flag name and lost what the flag
      does and the line it was found on, and the replacement sentence is itself actor-framed ("User read
      manual for a few minutes to find the age flag"). Attribution is untouched — 4/4 recall, 0/4 strict,
      4/4 attributed-ok, 3/4 bank gate, identical in both arms. Not shipped; the arm stays dev-only and
      the shipped prompt does not move. EXPERIMENTS.md carries the comparison, the sentence-by-sentence
      pairs, and the two instrument gaps the comparison exposed.
- [ ] 7.17 The two labels the `tool_output` class is missing, which 7.16 made impossible to score around.
      Banked facts carrying neither declared half went 1 → 3 under the arm, and one of the three is a
      user-stated constraint surviving as a constraint — the shape upstream's prompt aims at, filed by the
      scorer as narration because the chunk declares nothing durable there. And the arm paraphrases declared
      chatter ("read manual for a few minutes" against the declared "reading the manual for a few minutes"),
      which a literal anchor misses, so "chatter banked 2 → 0" is part measurement and part artefact. Both
      need to exist in the corpus before either arm can be promoted: tool chunks where the user states a
      constraint that should survive as a constraint, and tool chunks with declared chatter and no durable
      content at all — the control 7.13 says the class lacks. Then re-measure both arms against it.
      **Partly built (2026-10-24, offline, no model call).** All three labels now exist:
      `dev/corpus-restraint4.json` carries 4 chunks declaring a user rule and 4 `nothing_work` chunks holding
      tool output with nothing durable under it, and `dev/restraint-report.ts` counts a declared rule as kept
      verbatim in a bank fact / kept only as its content words rearranged / reaching no bank fact — a keep says
      the rule's wording sits in a banked fact, not that the rule was followed — counts possible chatter
      paraphrase beside the literal count, and counts banked facts carrying a token of a hidden value that no
      chunk in the corpus shows, dropping any token some chunk prints so a `45` sitting in a timestamp cannot
      count as a supplied value. Applied to the frozen corpus-3 ledgers the paraphrase column names the artefact
      7.17 predicted — 0 under the shipped prompt, 1 under the actor arm (`hy-r3-to-03`, chatter "I pulled up the
      queue module" banked as "Assistant pulled up queue module to see where a write lands") — and leaves every
      published number where it was. **Both arms then ran against corpus 4 (2026-10-24).** The arm's advantage
      did not follow it into the labeled corpus — 8/12 tool facts kept in each arm, against 10/12 and 12/12 on
      corpus 3 — and the paraphrase stopped being an artefact of the arm: 1 in each, both at the same chunk.
      Still open: a label for *survived as a rule* that is a judgement about the fact rather than a wording
      match.
      7.14's open mechanism question was answered the same day by `dev/merge-report.ts`: same-value drafts
      are never merged (39 cases, 0 merges), so the repeats are a code-side dedup question rather than a
      merge question, and the arm's two SKIPs were the bank gate dropping a draft, not deduplicating one.
      The labels this needs are written out as `plan-divergence.md` tier 3, carried here as 8.3.
- [ ] 7.18 The decision 7.14 produced, which is a choice and not another measurement. Three priced ways to
      stop merges from retiring facts the corpus says must survive, all of them measured on
      `dev/guard-fold-report.ts` over 10 ledgers (172 UPDATE proposals, self-check reproducing the recorded
      bank in 10 of 10). Numbers in `EXPERIMENTS.md`, "TODO 7.18: a third way to hold a value".
      **Tighten the loose clause** in `sameSubject` — 4 shared tokens and a quarter of the target's wording:
      109 accepted against shipped's 127, 4 declared values lost at merges against 9, 1 value still gone by
      the end, +366 bank tokens, +5 duplicate values. Weaker than the merge audit forecast (it predicted 14
      refusals of 107 with 9 dropping a value; the re-fold says 13 refusals and 5 saved) and it decides on a
      token count rather than on the value.
      **A code-side value gate**, priced 2026-10-24 as two arms and implemented the same day behind
      `mergeValueGate` (default `false`): accept an UPDATE only when every specific token the target
      carries is restated by the draft. `value-carry` (that test plus the shipped wording rule) accepts
      90, refuses 70; `value-only` (the test alone) accepts 98, refuses 61. Neither leaves a declared
      value lost at a judged merge or gone by the end, at +741 / +565 bank tokens and +7 duplicate
      values. The shipped gate is `value-carry`, in `src/values.ts` and `guardUpdateOps`, refused with
      the values it stopped named in the ledger reason; `value-only` stays an arm in the fold, because
      it merges a target carrying no value on any subject overlap. Two holes named in the report: the
      zero sits on a smaller denominator (12 and 13 proposals ended with no active target to judge,
      against 0 for shipped), and the extractor is a matcher — a value reworded into prose reads as a
      loss, and a declared phrase with no specific token (`line 63`) is invisible to it.
      **Or the verbatim surface**, upstream's structure rather than a threshold: 9 of 9 destroyed values were
      recoverable verbatim from the chunk that authored them, 0 absent, though 4 of the 9 sit only in a
      spoken line. It costs 374 tokens if the surface holds only the chunks behind lost values and 22 995 if
      every stored entry gets its source chunk, against an 11 024-token bank — and it is a storage and
      read-path change, not a gate.
      Live arms ran 2026-10-24 and neither settles the default. `restraint4-base-gate` (corpus 4, gate on)
      recorded zero refusals — the gate never ran. `restraint3-gate` (corpus 3, gate on) fired twice: it
      refused a recap-only chunk merging into the fact that `tctl flush --wait` exited `130`, which the
      wording rule passes, at +2 facts / +32 tokens (+4 %) and +3 repeat facts — and changed no value
      outcome, because that corpus banks every declared value twice and both refused merges left values
      still carried by another chunk's fact. Replaying the author's own session (159 writes, read from
      a frozen snapshot) through the same
      guard refuses 211 of 290 merges and holds 268 values nothing current carries, for about six facts
      displaced at the `bankMaxTokens` ceiling. Numbers in `EXPERIMENTS.md`.
      **What would settle it:** a corpus where a declared value has exactly one carrier, so refusing a
      merge prevents a loss rather than a duplicate (see 8.9). Until then the default stays `false` — the
      gate demonstrably catches the wrong-subject class the wording rule passes, but its blast radius on
      organic merges (73 % refused) is far wider than any corpus suggested. The repeat-facts cleanup stays
      behind all of this: duplicates absorbed five of the arm run's six declared-value losses, so removing
      them before the default is settled removes protection.
### 8. Divergence from the upstream harness: measure it or park it on the record (plan: `plan-divergence.md`)

Written 2026-10-23, after the merge audit (`78a2c6f`) made two things visible at once: the guard's
relaxed clause owns every corpus-declared value this repo has measured being lost, and the upstream
divergence table in DESIGN.md contains a row that describes the wrong half of its own claim. Neither
is a reason to adopt upstream's design; both are reasons to put a number on each difference before
choosing. Tiers are ordered by what can be measured with artifacts already on disk.

- [x] 8.1 **Done 2026-10-23.** Verbatim recoverability, tier 1. For each of the nine corpus-declared values a merge
      destroyed, check whether a verbatim copy of the chunk that authored it contains it — the claim
      7.18's structural option rests on, measured before any storage change. Also report how many
      *surviving* declared values currently depend on the model having re-said them. Offline, no
      model call. Decides recoverability only: attachment, searchability, read-side injection and token
      cost stay open in 7.18. Stop rule: under two thirds recoverable and the structural option loses
      its main argument. **Measured:** 9 of 9 recoverable verbatim from the chunk that authored the destroyed
      entry, 0 false hits, 0 absent — but 4 of the 9 sit only in a spoken line, so a copy can recover a value
      from the wrong wording. Of 92 surviving values, 72 still carry ≥ 4 consecutive words of their source and
      20 survive only as model restatement. The stop rule is met, so 7.18's structural option keeps its
      argument; what it does not settle is attachment, searchability, read-path injection and token cost.
- [x] 8.2 **Done 2026-10-23.** The subject guard priced including "off", tier 2. The guard is a code-side verdict
      (`src/pipeline.ts:332`) and every downgrade is recorded in `hy.ops`, so three settings —
      as-shipped, tightened, and guard off — are one re-fold over the six ledgers. Report accepted
      no-subject merges, accepted merges that dropped a value, active facts covering the same declared
      value after each chunk, and supersede chains of length ≥2 with whether the value survived. A
      small labeled authored corpus (8–12 chunks) runs only if the replay leaves a real tie. **Measured** over six
      ledgers, with the as-shipped re-fold reproducing the recorded bank entry for entry in 6 of 6 runs: accepted
      / refused / declared lost at merges / gone by the end is 107 / 22 / 9 / 1 as shipped, 92 / 35 / 4 / 1
      tightened, 122 / 0 / 15 / 5 off. Off is measurably worse, and tightening the loose clause is not supported
      on these numbers — it refused 13 more merges for 5 fewer declared values lost at merges and 5 duplicate
      facts kept. `dev/guard-fold-report.ts`, pinned by `tools/guard-fold-check.ts`.
- [ ] 8.3 The two labels the `tool_output` class is missing, tier 3 — this is 7.17. Decided: corpus 3
      stays frozen so its published numbers stay comparable, and the labels go into a new
      `dev/corpus-restraint4.json`, measured as a fresh `restraint4-base` / `restraint4-actor` pair. Add
      user-stated constraints that must survive as constraints, chatter with nothing durable under it,
      and a paraphrase-tolerant chatter label. Re-run both restraint3 arms. Promotion gate: the arm
      keeps its wording gain *and* stops costing a declared value.
      **Offline half done (2026-10-24).** Corpus 4 is written and contract-checked — 12 `tool_output`, 4
      constraint chunks, 4 calls past the argument window with 2 values hidden past the cut and nowhere
      else in either session, 4 tool-bearing nothing-durable chunks, 1 cross-session pair over 2 authored
      sessions — and `tools/restraint-corpus-mutation-check.ts` rejects 38 deliberate breakings across the four
      committed corpora. The scorer counts the three labels and `tools/restraint-report-check.ts` pins them,
      including the guard that a chunk printing `45` in plain sight is not evidence that a bank fact carrying
      `45` invented it. **Live half done the same day the writer route came back (2026-10-24):**
      `restraint4-base` and `restraint4-actor`, 22 of 22 chunks each, audited with `dev/merge-report.ts` and
      `dev/session-scope-report.ts` on top. The promotion gate below was answered against promoting: the arm
      kept no tool-fact gain on this corpus, 8/12 against 8/12, and its one loose-clause merge dropped
      `night.toml` where the shipped arm's four dropped nothing. Numbers in `EXPERIMENTS.md`.
- [x] 8.4 **Done 2026-10-24, both halves.** Clipping survival, tier 4. The DESIGN.md row was corrected
      first, by function name rather than line number, since it had described the wrong half of its own claim.
      **Marker shipped 2026-10-24**: tool call arguments in `textOfParts()` are cut at `ARGS_WINDOW`
      (600 since 2026-10-24, 240 before)
      and now carry clip()'s `…`, where they used to be cut with nothing; bodies and tool results still go
      through `clip()` at `maxEntryChars` (3000 default) *with* `…` — both in `src/entries.ts`, whose row in
      DESIGN.md is corrected by function name rather than line number. `tools/clip-check.ts` pins the failure
      mode as shipped (the window plus the marker, flag past the window, arguments still not closing as
      JSON), `dev/clip-report.ts` counts marker presence in the captures (0 of 589, because they were
      rendered before it), and `tools/restraint-corpus-check.ts` measures the window *and* whether the
      renderer marks a cut instead of assuming either. **Window arm run 2026-10-24**: `serializeEntries` takes
      `maxArgChars` (default `ARGS_WINDOW`, no shipped caller sets it — pinned), `dev/clip-window-report.ts`
      renders one 4-chunk spec at 240 and 600 with three values placed strictly between the windows and one
      control inside both, refusing a spec that is not a comparison, and `tools/clip-window-check.ts` pins the
      answers. Both arms ran on the writer route: the narrow bank kept 1 of 7 declared values and lost a value in
      3 of 4 chunks, the wide bank kept 7 of 7 in 0 of 4, and the control chunk was kept in both. No draft or
      fact in the narrow arm carried an unread token, so the cut lost values rather than inviting guesses.
      `dev/arg-window-cost.ts` prices the wider window on un-clipped session entries: 36% of ~105,500 calls are
      cut at 240, a 600 window adds 17% of the argument tokens already spent, shows 54% of those cut calls whole, and leaves 16% still cut — so a
      wider window shrinks the tail it removes instead of ending it. **Decided 2026-10-24: `ARGS_WINDOW` is
      600.** Consequences of moving it, all taken: `tools/clip-check.ts` re-pinned (a call past 600 is cut and
      marked, a call whose flag sits past 240 is now shown whole and at 240 was not), `dev/clip-window-report.ts`
      and `tools/clip-window-check.ts` re-rooted so the arm compares the window 600 replaced against the shipped
      one, corpus 4 regenerated with its hidden values now past 600, and both corpus-4 arms re-ran, 22 of 22 chunks each, so the
      published numbers are rendered by the window that ships. Re-entry trigger: a value that matters past 600.
- [ ] 8.5 Their mandate against our empty list, tier 5 — blocked, deliberately. Score fabrication only
      under a written support contract (values present in source text, resolvable `sourceEntryId`
      citations, zero supported claims expected on not-durable chunks). Semantic judging needs the
      judge endpoint, which was unreachable across the recent runs.
- [x] 8.6 **Decided 2026-10-24: no `src/` change — and the decision survived its own trigger firing the same day.** Session-scoped destructive authority, tier 6a. A
      synthetic bank scenario — entry authored in session A, `DELETE`/`UPDATE` proposed from session B — plus
      a count of how often that already
      happens across the existing ledgers — which is only possible where a ledger spans more than one
      `hy-<sessionId8>-` prefix, and a scan found that in three runs on disk. Re-counted over 30 ledgers on
      2026-10-24: 392 applied destructive ops cross no boundary, and the 329 destructive proposals the bank
      refused instead of applying — 152 refused by the subject guard, 92 where the candidate set never offered
      the target, 85 where the target had already been superseded earlier in the same batch — include 5 aimed at
      an entry another session wrote, all 5 in the two corpus-4 runs and all 5 subject-guard refusals. The
      classifier now reports applied ops and refused proposals apart, splits the refusals by the reason the bank
      recorded, and the fixture pins both splits, including that an unknown reason stops the report rather than
      landing in a leftover bucket. Counted where it exists, recorded as unavailable otherwise. The menu axis is
      measured on the same ledgers: the reconcile stage was offered 3075 merge candidates — 2054 written by the
      acting session, 125 by another session, 896 with no session marker — and 28 of the 125 pass `sameSubject`
      against some draft in the chunk that saw them, all 28 in the two corpus-4 runs and none in the one organic
      two-session run. A fence at the merge gate would have refused 0 of the 392 applied ops, so every bank on
      disk is identical under it; a fence at retrieval would remove 125 candidates and leave 9 of the 186
      session-carrying chunks with no candidate at all, one of them organic. Decided: scoping does not get a
      `src/` change, and `tools/session-scope-check.ts` pins the unscoped behaviour instead. Re-entry trigger: a
      ledger with an applied cross-session `UPDATE`/`DELETE`, or a run where cross-session candidates turn out
      merge-eligible outside a corpus authored to plant them.
      **Trigger fired the same day.** The corpus-4 arms re-run at the 600-character window produced two applied
      cross-session `UPDATE`s — `hy-4f0a0002-to-12` superseding an entry session `4f0a0001` wrote in
      `hy-4f0a0001-to-03`, in both `restraint4-base-600` and `restraint4-actor-600` — so the re-count is 403 applied
      destructive ops with 2 crossing a boundary, 342 refused proposals with 8 aimed at another session's entry, and
      47 of 234 cross-session candidates merge-eligible. A merge-gate fence would now refuse 2 applied ops, not 0;
      a retrieval fence would remove 234 candidates and leave 16 chunks with no candidate. What was destroyed is a
      transient and no corpus-declared value was dropped, so this is the trigger, not a demonstrated loss. Ratified
      the same day: hold, no fence. Bar for reconsidering: a crossing
      seen in an organic run — ideally one destroying a declared or user-visible fact — before a merge-gate fence
      ships. A retrieval fence is ruled out by measurement rather than taste: it removes 234 candidates and leaves
      16 chunks with no merge candidate at all, and the only organic two-session run showed five cross-session
      candidates none of which was merge-eligible. `dev/session-scope-report.ts` now prints the trigger itself
      rather than leaving it to be read off a table, so the next crossing surfaces on any run of the report.
- [ ] 8.7 Atomic claims vs one fact per session plus experiences, tier 6b — **parked**, recorded as
      parked. Re-entry trigger: any storage redesign, a verbatim payload field adopted, or a move
      toward one-fact-per-session. The 39 same-value cases never merged and the refusals leaving 2+
      facts per value show the units behave differently; they do not show which is better.
- [x] 8.8 No test proposed, on the record: `keys`/`refs` (deliberate) and extract-never-sees-the-bank
      (decided by measurement, then confirmed in upstream's code). A plan that tested these would be
      spending budget on a difference neither side considers open.
- [ ] 8.9 A corpus where a declared value has exactly one carrier, tier 7. **Corpus built 2026-10-24**
      (`dev/corpus-restraint5.json`, re-derived by `dev/gen-corpus-restraint5.mjs`, contract enforced by
      `tools/restraint-corpus-check.ts` and mutation-tested); the two arms are running. The rest of this
      item stands as written, with one clause now falsified: the shipped arm did destroy a
      single-carrier value at a merge (`store/audit.db`, `r5-off`), but the writer had banked that value
      twice from its own chunk, so both arms ended at 14/16 declared values and no value went dark. The
      value gate fired once, on a token the corpus does not declare. **Gate does not clear 2026-10-25;
      `mergeValueGate` stays `false`.** What is left is not another corpus but the dedup class of 7.14: a
      single-carrier corpus cannot price a gate while one chunk banks its value into two facts. See
      "TODO 8.9: a corpus where every declared value has exactly one carrier" in `EXPERIMENTS.md`.
      Corpora 3 and 4 bank every
      declared value in more than one chunk, so retiring one carrier is harmless and the value gate has
      nothing to prevent: its two live refusals on corpus 3 bought duplicates, not values. Author a corpus
      where each declared value is stated in exactly one chunk and printed nowhere else, and make a later
      chunk propose the merge that would retire that carrier. Gate: the corpus check refuses any declared
      value carried by more than one chunk; the shipped arm loses at least one declared value at a merge;
      the gate-on arm loses none and grows the bank by the refusals it makes. ~22 chunks, ~340 s of model
      wall per arm. This is the only arm that can decide `mergeValueGate`'s default.
## Notes

- Writer route: primary `remote/hy-memory-30b-a3b`, measured in this session on a 10.9 k-token
  chunk: extract ≈ 232 s, reconcile ≈ 17 s. All runners therefore use 600 s timeouts, resumable
  chunk-level progress, and record per-stage wall time; corpus 4's 22-chunk arms measured 340.6 s and 358.1 s
of per-chunk model wall over 22 chunks each, so plan runs
  as background tasks. The local llama-swap `hy-memory-30b-a3b` remains the fallback arm and the
  speed comparison for 1.6.
- Judge must never be the writer model (self-preference), and judge keys/endpoints stay in env
  vars — never in the repo.
- Corpus privacy: `captures-dev/`, `out/` stay gitignored (add `captures-dev/` to `.gitignore`);
  no transcripts, hostnames, keys, or home-dir paths in any commit (AGENTS.md).
- Changing `EXTRACT_SYSTEM` costs llama.cpp prompt-cache prefix hits on the first chunk per
  variant; experiments report first-chunk wall separately.
- No pushes without explicit approval (AGENTS.md).
- Baseline must be measured on current code *before* the Tier-1 merge so the Tier-1 gate has a
  real comparison arm.
