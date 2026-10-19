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
      per chunk, generous per-call timeout (600 s, remote is slow), writing
      `out/<runId>/{bank.json, ledger.jsonl, raw/, metrics.json}`. Done when a run survives a
      mid-run kill and resumes without re-paying finished chunks.
- [ ] 1.3 Define the metrics contract in `dev/metrics.md` and emit it from 1.2:
      drafts accepted/rejected + reasons; per-draft candidate coverage (drafts with 0 shown
      candidates); ADD/UPDATE/DELETE counts; rejected + downgraded ops; active bank
      count/tokens; bank-growth ratio (Δ bank tokens ÷ estimated chunk tokens); confidence
      distribution; in/out tokens and wall seconds per call; endpoint used (primary/fallback).
      Done when `metrics.json` validates against the schema for a full corpus run.
- [ ] 1.4 Write `dev/judge.ts` + `dev/rubric.md`: self-contained blind judge of a run's bank
      against the serialized chunk transcripts. Axes: supported/partial/unsupported,
      durable/marginal/noise/missed, plus four upstream-failure-surface axes:
      specificity (concrete anchors present), transition (settled *and* dropped version
      represented), should-not-store (chatter, generic assistant text, meta), evidence fidelity
      (attempted vs verified preserved). `JUDGE_ORIGIN/JUDGE_MODEL/JUDGE_KEY` env; randomized
      order + seed; never the writer model as judge. Done when the baseline bank scores
      reproducibly across two seeds (same verdicts, score delta < 5 %).
- [ ] 1.5 Run `baseline-<date>` on `captures-dev/` with the current `src/prompts.ts` and
      current protocol; record aggregate numbers (no private text) in `EXPERIMENTS.md`.
- [ ] 1.6 Optional speed/cost arm: rerun one chunk via the local llama-swap fallback route and
      record remote-vs-local wall and token cost for run planning.

### 2. Tier-1 protocol fixes (measured against the baseline)

- [ ] 2.1 Per-draft candidate budget: replace the global `seen.slice(0, candidateLimit)` union
      in `src/pipeline.ts` with per-draft top-`candidatePerDraft` (new config key, default 3)
      under a global `candidateLimit` cap; render candidates grouped upstream-style
      (`for draft[i]: …`, explicit `(no candidates)`); `allowedTargets` = exactly the shown set.
- [ ] 2.2 Add `tools/candidate-coverage-check.ts`: synthetic 20-draft × 200-entry bank scenario
      asserting every draft's block carries its own candidates or an explicit no-candidates
      marker; wire into `npm run check`.
- [ ] 2.3 SKIP op: add `{ action: "SKIP", draft, reason? }` to `ReconcileOp`
      (`src/protocol.ts` parse/validate, `src/bank.ts` ignores it for the bank), count it in the
      `hy.ops` audit record, and add SKIP to the reconcile system prompt vocabulary.
- [ ] 2.4 Update `src/config.ts` + README config table + DESIGN.md for `candidatePerDraft` and
      SKIP; `tools/config-docs-check.ts` and `npm run check` pass.
- [ ] 2.5 Run `tier1-<date>` on the same corpus; gate vs baseline: per-draft zero-candidate
      drafts reduced to ≤ 10 % of drafts; rejected + downgraded ops not increased; reconcile
      input tokens ≤ baseline + 20 %; judge durable score not below baseline. Record verdict in
      `EXPERIMENTS.md`.

### 3. Prompt experiments (one variable at a time; `src/prompts.ts` untouched until a gate passes)

- [ ] 3.1 Add `dev/experiment.ts --variant <name>`: variants live in `dev/variants/<name>/`
      overriding `EXTRACT_SYSTEM` / `reconcileSystem` without touching `src/`.
- [ ] 3.2 E1 confidence rubric — anchored to evidence origin (1.0 user-stated rule/constraint,
      0.7 tool-evidence inferred, 0.5 weakly inferred). Gate: share of confidence = 1.0 drops
      from baseline (> 95 %) to ≤ 80 %; durable score ≥ baseline; ranking tiers non-degenerate.
- [ ] 3.3 E2 transition + specificity block — "settled on X; the interim Y was dropped",
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
- [ ] 4.2 `hy_recall` query mode: text query → lexical ranking over task/statement/keys,
      returns top-k ids + snippets + source entries; append a `hy.recall { ids }` ledger record
      as usage telemetry; `tools/recall-query-check.ts`; token cost per call bounded and
      documented.
- [ ] 4.3 E5 (deferred until ≥ 30 `hy.recall` records exist across sessions): pool ranking from
      recall hits + recency instead of the saturated confidence tiers; run against corpus banks,
      gate on durable facts surviving compaction summaries.

### 5. Consolidation

- [ ] 5.1 Update `DESIGN.md`, `README.md`, `RESULTS.md` to match shipped behavior and record the
      experiment table; docs/code consistency checks and `npm run check` pass.
- [ ] 5.2 Write the Tier-4 follow-up plan (upstream two-layer fact + value-bar experiences
      output shape) as a separate `plan-two-layer.md` — explicitly not executed in this TODO.

## Notes

- Writer route: primary `remote/hy-memory-30b-a3b`, measured in this session on a 10.9 k-token
  chunk: extract ≈ 232 s, reconcile ≈ 17 s. All runners therefore use 600 s timeouts, resumable
  chunk-level progress, and record per-stage wall time; a corpus run is ~15–20 min, so plan runs
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
