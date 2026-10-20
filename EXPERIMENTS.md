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
