# TODO — Restraint: the axis no corpus in this repo measures

## Goal

Measure whether the writer *abstains* and *attributes correctly*, not only whether it recalls.
Every corpus this repo owns is an organic coding session where almost everything is worth
recording, so the standing conclusion — "coverage, not precision is the failure mode"
(`EXPERIMENTS.md`, baseline verdict) — has never been tested against a chunk whose correct output
is an empty list. An external benchmark on the same writer model reported 52/52 recall with
**0/44 empty-output cases** and 76 unwanted proposals; this repo separately measured that the
`SKIP` op is used **zero times at temperature 0** in any arm. Both say the same thing and neither
is measured here on our own prompts.

Slice 1 is **diagnostic only**: a corpus, a scorer, one baseline run. No prompt variant, no
`src/` change, no code-side policy filter. Those become separate plans if the baseline says so.

Branch: `experiment/restraint-pairs`.

## What is already true in the artifacts (verified, not assumed)

`out/<run>/ledger.jsonl` carries everything the scorer needs, so no new pipeline plumbing is
required:

- `hy.extract` → `drafts[]` with `task`, `statement`, `keys`, `refs`, `fromUser`,
  `sourceEntryIds`, plus `rejectedCount` and `repaired[]`.
- `hy.ops` → `ops[]` with `action` (`ADD` / `UPDATE` / `DELETE` / `SKIP`) and `rejectedOps` /
  `downgradedOps`.
- `foldLedger()` → the final bank with `status` and `tokenCount`.

`fromUser` is computed from the *role of the line*, not from who said the claim. A sentence the
user quotes from a colleague arrives as `fromUser: true`. That is the exact mechanism this
benchmark is aimed at, and it is worth stating up front: the pipeline already has a signal that
looks like speaker attribution and is not one.

## 1. Corpus: `dev/corpus-restraint.json`

Authored, inline `text`, same rendered form a capture carries
(`[n] [User @ HH:MM]:` / `[n] [Assistant @ HH:MM]:` / `[n] [Tool result for bash @ HH:MM]:`),
same invented domain as `dev/corpus-enumerables.json` (the `tctl` config CLI). No hostnames, no
absolute paths under a home directory, no credential-shaped strings (AGENTS.md).

Two classes in slice 1:

| class | pairs | chunks | the variable that flips |
|---|---|---|---|
| `attribution` | 8 | 16 | the claim is identical; only the **frame** differs — user-stated vs quoted from a named third party |
| `empty` | — | 10 | nothing durable: greetings, transient command mechanics, tool noise, a plan not yet settled |

26 chunks, **mean 140 estimated tokens** (79–216), 3 645 in total: a whole arm costs a few thousand
input tokens, not the 15–20 minutes an organic corpus takes. Small chunks are the writer-friendly
case, which is the right way round for this test — if abstention fails on a 100-token window it will
not improve when the window grows.

Each chunk carries scoring metadata:

```jsonc
{
  "chunkId": "hy-resp-attr-03b",
  "class": "attribution",
  "pair": "attr-03",
  "side": "quote",
  "probes": ["TCTL_LOCK=off"],
  "forbidden": ["TCTL_LOCK=off"],
  "attributionMarker": "Mara"
}
```

`probes` is what must appear on the `keep` side. `forbidden` is what must **not** appear
unattributed on the `quote` side. `attributionMarker` names the third party, so an attributed
restatement can be recognised as restraint rather than intrusion (see §3 — this is where our
contract deliberately differs from the external benchmark's).

Gate block, same discipline as 6.12 — a thin denominator fails loudly:

```jsonc
"gate": { "attribution_pair": 8, "empty_chunk": 10 }
```

## 2. Corpus check: `tools/restraint-corpus-check.ts`

Runs under `npm run test` / `npm run check`, so the benchmark itself is a checked artifact and
cannot rot into a corpus whose pairs differ in three variables.

- [ ] 2.1 Counts meet the `gate` block; every pair has exactly one `keep` side and one `quote`
      side; `chunkId`s are unique.
- [ ] 2.2 **Pair isolation**: for each pair, every `probes` string appears on both sides, and the
      `attributionMarker` appears only on the `quote` side. A pair whose sides differ in any other
      declared probe is a failed pair, not a pair.
- [ ] 2.3 **No leakage**: no `forbidden` string of any pair appears in the `empty` chunks, so an
      intrusion there cannot be a false positive from a neighbouring pair.
- [ ] 2.4 **Contamination guard**: no `probes` / `forbidden` / `attributionMarker` string occurs in
      `EXTRACT_SYSTEM` or `reconcileSystem`. The external benchmark caught a model inventing
      "I live in Belgrade" out of its own instructions; this repo's own measured version of that
      failure is 19/590 observations copying a rendered id label. A probe that exists in the prompt
      measures the prompt, not the model.
- [ ] 2.5 Privacy scan (same shape as `tools/ops-guard-check.ts`): no hostnames, no home-dir paths,
      no credential-shaped strings in the corpus.

Done when the check fails on a deliberately broken copy of the corpus (a pair whose sides differ in
two variables, a probe that appears in the extract prompt).

## 3. Scorer: `dev/restraint-report.ts`

Offline, no model calls, same shape as `dev/enumerable-coverage.ts`: reads
`out/<run>/ledger.jsonl`, folds the bank, prints a table per class and a gate line.

Matching is literal and whitespace-insensitive, reusing the `carried()` rule from
`dev/enumerable-coverage.ts`. No post-hoc repair of citations or statements: a draft that names the
wrong source line is scored as it stands.

**Three outcomes on an `empty` chunk, reported separately — they are not the same event:**

| outcome | condition | what it means |
|---|---|---|
| abstained | `drafts.length === 0` and `rejectedCount === 0` | the model withheld |
| code-suppressed | `drafts.length === 0` and `rejectedCount > 0` | the model proposed, `parseDrafts` refused — restraint the pipeline already buys |
| intruded | ≥ 1 accepted draft | restraint failed at the model |

**Two gates, because the two calls have different restraint opportunities.** `extract` never sees
the bank; `reconcile` is the only place a duplicate can be refused. Every metric is printed at both:

- **draft gate** — what `hy.extract` accepted
- **bank gate** — what `foldLedger` left active

A class that passes at the draft gate and fails at the bank gate is a `reconcile` failure. One that
fails at the draft gate is a prompt failure. That distinction is the diagnostic payload of this
experiment and it costs nothing extra.

**Attribution scoring.** The claim string is identical on both sides of a pair, so a string match
alone cannot tell restraint from intrusion. The quote side is correct when either:

- **(a) abstain** — no accepted draft carries the claim, or
- **(b) attribute** — a draft carries it *and* names `attributionMarker` in `task` or `statement`
  ("Mara (ops channel) runs tctl with `TCTL_LOCK=off`").

Report both scores:

- `strict` — (a) only. This is the external benchmark's contract and makes the numbers comparable
  to it.
- `attributed-ok` — (a) or (b). This is the contract this bank should actually be held to: a
  correctly attributed third-party fact is a usable memory for a coding agent, and a memory bank
  that silently drops "the ops owner runs the lock off" is not better than one that records it
  with its source.

The divergence is deliberate and must be stated in `EXPERIMENTS.md`, not smuggled into a better-
looking number.

**Headline metric: pair-correct.** A pair counts only when the `keep` side banked its probe **and**
the `quote` side stayed clean. Recall-only, restraint-only and pair-correct are printed side by side
so the tradeoff is visible in one row — which is the whole point of the contrast-pair design.

## 4. Run protocol

- [ ] 4.1 `restraint-base`: current `src/prompts.ts`, unchanged. Scored **before** any variant, the
      way 6.12 requires `trans-base` to score before a variant does.
- [ ] 4.2 Writer: local `hy-memory-30b-a3b` via `POC_MODEL` (no committed default id), temp 0,
      `chat_template_kwargs.reasoning_effort = "none"`, resumable, run as a background task.
- [ ] 4.3 `dev/run.ts --corpus dev/corpus-restraint.json --run restraint-base`, then
      `dev/restraint-report.ts --run restraint-base`.
- [ ] 4.4 Judge only for the soft axis, twice (seeds 7 and 11), never the writer model: on the
      `quote` and `empty` chunks, `shouldNotStore` and `supported: none` (whose definition already
      includes *misattributed*). The hard axis needs no model at all.
- [ ] 4.5 Organic control, secondary signal only: run the intrusion half of the scorer over
      `out/enum-base` and `out/baseline-extended-local` to get the base rate of proposals per chunk
      on content where nothing is forbidden. Synthetic pairs are not evidence about organic
      sessions; this row is a caveat, not a gate.

## 5. What each outcome decides

| baseline result | conclusion | next step (a separate plan, not this one) |
|---|---|---|
| abstention ≈ 0/10 | confirms the external 0/44 and the zero-SKIP finding on our own prompts: abstention is not a prompt property | a deterministic filter beside `SECRET_PATTERNS` in `src/protocol.ts` — proposed only after this is measured |
| abstention high, attribution intrusions high | the writer can withhold but cannot attribute | a speaker-attribution clause in `EXTRACT_SYSTEM`, run as a 3.1-style variant |
| both high | the failure is corpus-relative, not model-intrinsic | the benchmark becomes a regression guard in `npm run check` |

## 6. Deferred to slice 2 (gated on slice 1 shipping clean)

- [ ] 6.1 **Dedup class.** Not a clean intrusion test yet, and it must not be scored until the
      expected bank state is defined. Proposed rule: a restatement may produce a draft; it is an
      intrusion only if it leaves **two active facts covering the same subject** or fails to
      supersede the existing one. An `UPDATE` is never an intrusion unless it loses source refs or
      narrows a fact that stayed true. Uses the cumulative bank the sequential run already gives —
      no seeded-bank plumbing.
- [ ] 6.2 **Policy class** (title kept, salary excluded). Deferred because this repo already answers
      the easy half in code: `SECRET_PATTERNS` is a policy filter that works. The open question is
      where a *semantic* exclusion belongs, and that question only becomes well-posed once §5 has
      an answer for the empty class.
- [ ] 6.3 Record the run in `EXPERIMENTS.md` with corpus gate status, abstention rate, attribution
      failure rate at both gates, strict vs attributed-ok, judge disagreement, and the artifact
      assumptions §3 depends on.

## Built and verified (2026-10-23)

Instrument only. No writer has been run on this corpus yet, so there is no restraint number.

| artifact | state |
|---|---|
| `dev/corpus-restraint.json` | 26 chunks: 8 attribution pairs (`attr-01`…`attr-08`, anchors `TCTL_LOCK`, `tomllib`, `retries`, `O_EXCL`, `3.13`, `cron`, `schema`, `config.toml`; markers Mara, Devin, Priya, Ivo, Nadia, Samir, Hana, Theo) + 10 empty chunks, each carrying a `why` naming what makes it non-durable |
| `tools/restraint-corpus-check.ts` | in `npm run check`. Counts, pair isolation, verbatim claim on both sides, marker only on the quote side, no anchor or marker leaking into any unrelated chunk, no probe present in `EXTRACT_SYSTEM` / `reconcileSystem`, hostname / home-path / credential scan |
| `dev/restraint-report.ts` | `scoreRun` + `totals` exported; CLI prints the pair table, both gates, both contracts, the four empty outcomes, and the op totals |
| `tools/restraint-report-check.ts` | in `npm run check`. A fixture ledger whose score is known by construction: unattributed intrusion, attributed restatement, reconcile-refused draft intrusion, keep-side draft reconcile dropped, unrelated draft, and one of each empty outcome |

**The corpus check was shown to fail.** Six mutations of the committed corpus each exited 1 with the
intended reason: a pair whose sides differ in a second variable, an anchor that is a prompt word, a
marker named on the keep side, one empty chunk removed, an anchor leaked into an empty chunk, and an
absolute path. A check that has never failed is not yet a check.

**The scorer was shown to disagree with itself on purpose.** Pair `b` of the fixture (claim carried,
third party named) scores `pairStrict = false`, `pairAttributed = true`, and the check asserts that
disagreement. If a future edit ever makes the two contracts agree, the divergence has been erased and
the check says so.

Two things the fixture caught while being written:

- `hy.gap` records carry no `chunkId`, so the scorer must skip them before reading one.
- A failure line that says "unattributed" for a draft that *does* name the third party is how a
  benchmark gets misread. The note now distinguishes *naming Mara (strict counts it, attributed-ok
  does not)* from *unattributed, and `fromUser=true`*.

**The scorer's own blind spot is printed.** Anchor matching is lexical: a quote side that keeps the
claim and drops every anchor token scores as restraint. Fixture pair `f` is exactly that — keep side
"tctl reads its registry cache from `config.toml`", quote side "the registry cache is read from the main
config file" — and it scores `pairStrict = true`, `pairAttributed = true`. The scorer does not pretend
otherwise: it flags the pair as a **paraphrase suspect** when the quote side shares ≥ 3 content words
with the keep-side fact, in a column of its own, *reported and not scored*. Counting it as an intrusion
would punish a legitimate related fact; ignoring it would let a paraphrase pass as restraint. The
check asserts both the flag firing (pair `f`) and it not firing (pair `e`, an unrelated draft).

## Explicit non-goals for slice 1

No `src/prompts.ts` edit. No `src/protocol.ts` filter. No prompt variants — `dev/experiment.ts
--variant` (TODO 3.1) does not exist yet and this plan does not assume it. No dedup or policy
class. No claim about organic sessions.
