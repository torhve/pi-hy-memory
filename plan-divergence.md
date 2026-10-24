# Plan — Divergence: measure each difference from the upstream harness, or park it on the record

## Goal

`DESIGN.md` § *Where we diverge, and how settled each divergence is* lists eight differences
between this extension and the upstream Hy-Memory coding harness (read at `main`
`6b0bd866798049940c752c402512bb0e16c98a2b`, 2026-10-23). Four are marked **open**, one is
**measured now**, one is **decided with a dissent on the record**, two are **deliberate**.

This plan gives every *open* divergence either a measurement that could change our mind, or an
explicit parked state with the artifact it is waiting for and the trigger that un-parks it.

**What this plan is not.** It is not a port of upstream's design. No item says "adopt their
schema". Each item ends in a number, and the decision comes after the number. Nothing here
overrides the standing rule that `src/` moves only when a measurement justifies it, and nothing is
pushed without explicit approval (AGENTS.md).

Branch: `experiment/hy-flush` (continues from `78a2c6f`, which carries `dev/merge-report.ts` and
its fixture check). Tiers 1, 2 and 4's fixture are offline work over artifacts already on disk.

Code is cited by **function name**, not line number, because line numbers go stale: `sameSubject()`
and its `UPDATE`→`ADD` downgrade in `src/pipeline.ts`; `textOfParts()` (tool call arguments) and
`clip()` with `maxEntryChars` (default 3000) in `src/entries.ts`; the chunk-id prefix
`hy-<sessionId8>-` in `src/chunks.ts`.

## The eight, and what this plan does with each

| divergence (as written in DESIGN.md) | this plan |
|---|---|
| one layer of atomic claims vs their session-fact-plus-experiences | **parked**, tier 6 — with a re-entry trigger, because it invalidates every published baseline |
| our `{"drafts":[]}` vs their mandate of at least one record | **tier 5**, only behind a deterministic support contract |
| no verbatim payload field, no summary/verbatim split | **tier 1**, first, because TODO 7.18 hangs on it |
| actor-frame statements, budget-reallocation wording, evidence fidelity | **tier 3**, blocked until the corpus carries the two labels 7.17 named |
| tool args clipped at 240 chars; tool results clipped by characters | **tier 4**, plus a correction: the doc row is wrong about the marker |
| destructive authority scoped to one session | **tier 6a**, a synthetic bank scenario instead of a full park |
| `subject-guard` on (ours) vs off (theirs) — decided, dissent on record | **tier 2**, priced by offline replay, including the option 7.18 never listed: off |
| `keys` / `refs`, and extract-never-sees-the-bank | **no test** — deliberate, and one was already confirmed twice |

---

## Tier 1 — Verbatim recoverability (offline, no model call, no `src/` change)

**The claim being tested.** TODO 7.18's structural option says values disappear because the model
had to re-say them. Upstream's answer is a `details` field: text copied from uncompressed messages
*by code*, never by model transcription, deliberately not embedded and not injected on read.

**Method.** For every corpus-declared value that a merge destroyed in the six runs — nine of them,
as reported by `dev/merge-report.ts` — look for that value in the verbatim source text of the chunk
that authored it (`text` in `dev/corpus-restraint*.json`; for organic runs, the captured entry text).

**Matching rules, written before the run so they cannot be softened afterwards.** Only three
normalisations are allowed first: collapse whitespace, unify typographic dashes with ASCII hyphens,
and strip markdown emphasis. A value counts as **recoverable** only when it appears under
`carries()`'s own token-boundary rule — the rule `dev/restraint-report.ts` already uses — so
`4096` inside `14096` is not a hit and `--dry-run` inside `--dry-run-all` is not a hit. A value that
appears only as a paraphrase, a re-united unit, or a shortened path is **not** recoverable and is
reported in its own column; the paraphrase column is where a verbatim surface would earn nothing and
should be read as a cost of the design rather than a success.

**Precision sample.** Every reported recoverable hit is printed with the source chunk text quoted
around it, and every one is read by hand before the rate is published: the number of false hits found
by hand is part of the result, not a footnote. `carries()` is a mitigation, not proof.

**Also measured in the same pass, because recoverability alone is not a decision:** (a) how many
*surviving* declared values are currently carried by a model restatement rather than by an entry that
still quotes its source — the dependency a verbatim surface would remove; and (b) the token cost of
the verbatim text that would have to be stored for the nine values and their hosts, using
`estimateTokens()` on the source chunks, so the structural option is priced in tokens and not only in
survival.

**What tier 1 decides.** Only whether a verbatim copy would have preserved the values the corpus
says must survive. **It does not decide** how such a field attaches to drafts or ops, whether it is
searchable, whether it is ever fed back to the writer, how much it costs in tokens and payload, or
whether substring matching is the right test for a value that was legitimately reworded. Those stay
open in 7.18 even if tier 1 comes back strongly positive.

**Stop rule.** If fewer than two thirds of the nine are recoverable verbatim, the structural option
loses its main argument and tier 2 becomes the only priced fix.

## Tier 2 — The subject guard, priced including "off" (offline replay, then a small labeled arm)

**Why no model call is needed first.** The guard is a code-side verdict: `src/pipeline.ts:332`
computes `sameSubject(draft, target)` and downgrades an `UPDATE` to an `ADD` when it fails, and
`hy.ops` records every downgrade with its draft, target and reason. Accepting those recorded
downgrades as merges is a re-fold of `foldLedger()` over ledgers that already exist.

**Three guard settings, one pass, six ledgers:** as-shipped (3 shared tokens / sixth of wording),
tightened (4 shared tokens / quarter of wording — already recomputed in `dev/merge-report.ts`), and
**off** (every proposed `UPDATE` accepted).

Report for each setting, per run and in aggregate — not just counts of refusals:

- accepted merges whose draft and target share **no** subject at all (the failure "off" would add);
- accepted merges that dropped a value, and dropped a **corpus-declared** value;
- active facts covering the same declared value, after the chunk (the duplicate pressure refusals
  create, and the duplicate supply that merges remove);
- facts that ended up superseded twice or more in one chain, and whether the value survived to the
  end of the run (the `hy-r3-to-01` shape: retired at 4/10, its replacement retired at 3/13, value
  survived anyway through a parallel draft of the same chunk).

**Stop rule for a tie.** The replay only exercises the loss shapes the existing ledgers already
produced; "off" can create kinds of damage those ledgers never had. So if the three settings do not
order themselves clearly, **as-shipped is not the default**: the result is recorded as
under-specified and the labeled corpus runs.

That corpus is small and labeled rather than full-size — same subject and should merge; different
subjects and must not; same value from two sources and should stay duplicate; a destructive merge that
must be blocked. 8–12 chunks, so one arm is minutes rather than 15–20.

**What tier 2 decides.** Whether the guard's loose clause, its strict clause, or no guard is the
cheapest producer of surviving facts on this corpus family. It cannot tell us how the guard behaves
under a prompt that changes what drafts arrive; it does not need to, for 7.18.

## Tier 3 — The two labels the `tool_output` class is missing (corpus work, then re-run both arms)

This is 7.17, and it is the prerequisite that makes the actor-frame arm promotable or killable:
banked facts carrying neither declared half went 1 → 3 under the arm, and one of the three is a
user-stated constraint surviving as a constraint — filed by the scorer as narration because the chunk
declares nothing durable there. And the arm paraphrases declared chatter, which a literal anchor
misses, so "chatter banked 2 → 0" is part measurement and part artefact.

**Decided here, so comparability survives the fix:** `dev/corpus-restraint3.json` is **frozen** — the
published restraint3 numbers stay comparable — and the new labels go into a fourth corpus,
`dev/corpus-restraint4.json`, carrying only the classes below plus enough attribution pairs to keep the
gate meaningful. Both arms are then re-measured as a fresh pair on corpus 4, and the published corpus-3
comparison is left standing as what it was: a measurement of corpus 3.

- `tool_output` chunks where the **user states a constraint that must survive as a constraint**, with
  no tool value declared; the scorer needs a label that is not `probes` and not `transient`.
- `tool_output` chunks with declared chatter and **no durable content at all** — the control 7.13 said
  the class lacks and 7.16 made uninterpretable.
- a paraphrase-tolerant label for chatter, so "read manual for a few minutes" against the declared
  "reading the manual for a few minutes" is not silently counted as a disappearance.

Then re-measure both arms against corpus 4 with the existing scorer, and `dev/merge-report.ts` on top:
`restraint4-base` and `restraint4-actor`. Estimated ~15–20 min each on the current writer route —
**provisional**, taken from corpus-3 runs, and to be replaced by the measured wall time once the first
arm finishes. Run them as background tasks.

**Gate before any promotion decision:** the arm must keep its wording gain (statements opening with
a person or the agent's own voice, 15/37 → 5/35) **and** stop losing a declared value, on the labeled
class. If it keeps the wording gain and still costs a value, the arm stays dev-only permanently.

## Tier 4 — Clipping: test survival to the final bank, and fix the doc row first

**Correction made with this plan** (`7ad9b5c`): the DESIGN.md row said tool results are clipped with
no omission marker. `clip()` in `src/entries.ts` appends `…` and is what renders tool results,
assistant, user and summary lines at `maxEntryChars` (default 3000), while **tool call arguments** in
`textOfParts()` are cut with `JSON.stringify(…).slice(0, 240)` and **no marker at all**. The divergence
is real; the row described the wrong half of it.

**Fixture (deterministic, no model):** an entry whose tool call carries the decision-relevant flag
late in long arguments — upstream's own analogue is a late `-Depth 3`, raised from 80 chars to 600
because 80 cut real flags, and they keep a regression test for it — asserted to reach a draft **and**
to still be in the final bank.

**Run arm:** the same authored chunks at 240 and at 600 chars, plus a variant where the clip leaves a
visible marker. Assert four things, not one: extraction survives; no merge drops it; the value is in
the final bank; and the marker does **not** induce the writer to invent the missing tail — the case a
silent truncation cannot produce and an honest one can be tested for.

## Tier 5 — Their mandate against our empty list, only if "fabrication" is defined first

We have only ever measured the permissive side: our prompt offers `{"drafts":[]}` and withholds
**0/8**. Upstream mandates at least one record and their own history says the mandate was "the direct
cause of fabricated experiences". Nobody here has measured the mandated side.

**Blocked until the support contract exists.** Score "fabricated" deterministically, not by taste:

- every value in a banked fact is present in the source chunk text (or in a `probes` label);
- every `sourceEntryId` a draft cites resolves to an entry whose chunk actually contains the claim;
- on chunks labeled not-durable, the expected count of supported claims is zero, so any supported
  claim there is over-production by definition.

With that contract, the arm is: same corpus, prompt variant mandating ≥1 draft, scored for
unsupported *values* and over-production on not-durable chunks. **Without it, this tier stays
blocked** — the semantic version needs the judge model, and the judge endpoint was unreachable across
the recent runs (raw outputs kept as `out/restraint2-bidx/judge-raw-*.txt`); do not re-open it on
hope. Prompt variants live in `dev/` and never in the shipped prompt, as with `prompts-actorframe.ts`
and `tools/extract-prompt-check.ts`.

## Tier 6 — Session scope, and the largest divergence

**6a. Session-scoped destructive authority (synthetic first, offline).** Authored conversations cannot
show cross-session damage, so the primary test is a bank state built by hand: an entry authored in
session A, session B proposing a `DELETE`/`UPDATE` against it, and a check of what candidate retrieval
allows. Retrieval is never scoped by session, so the expected finding is that B destroys A's record with
no friction.

**The count is a maybe, and it is checked before it is promised.** Session identity reaches a ledger
only through the chunk-id prefix `hy-<sessionId8>-` from `src/chunks.ts`, and only organic captures get
that prefix; authored corpora use names like `hy-r3-to-01` and carry no session at all. A scan of the
ledgers on disk found 1 session prefix in almost every run, 2 in `out/baseline-kitx`. So: count
cross-session destructive ops **only where a ledger demonstrably spans more than one session prefix**,
report how many such ledgers exist, and if fewer than two do, the synthetic scenario is the whole of
this tier and the count is recorded as unavailable rather than estimated.

**6b. Atomic claims vs one fact per session plus experiences — parked, on purpose.** Changing the
unit of memory invalidates every published baseline in this repo, and their compat path suggests they
did not expect models to stop emitting several facts. The evidence we have (39 cases of several drafts
carrying one declared value, merged down to a single fact **0** times; the guard's refusals leaving
2+ active facts covering the same value) shows our unit behaves differently. It does not show which
unit is better.

**Re-entry trigger (write it down, do not leave it implied):** any storage redesign, adoption of a
verbatim payload field, or a decision to move toward one-fact-per-session. Tier 1 and tier 2 both feed
that trigger.

---

## Order, cost, and what each unlocks

| tier | artifact needed | cost (provisional until measured) | unlocks |
|---|---|---|---|
| 1 verbatim recoverability | ledgers + corpora on disk | offline, minutes | 7.18's structural option, for or against |
| 2 guard priced incl. off | same ledgers; optional 8–12 chunk labeled arm | offline, minutes; +minutes if the arm runs | 7.18's tightening option, and the third option |
| 3 the two missing labels | new corpus chunks | ~1 h authoring + two 15–20 min runs | the actor-frame promotion decision (7.16/7.17) |
| 4 clipping survival | fixture, then one small run | ~30 min offline + one short run | whether our 240-char silent cut costs values, and a DESIGN.md fix |
| 5 mandated extraction | support contract first | blocked until the contract is written | whether our permissiveness is actually the safer bet |
| 6a session scope | synthetic bank scenario | ~30 min offline | whether destructive authority needs fencing at all |
| 6b memory unit | — | parked | re-entry trigger recorded |

Tiers 1, 2, 4's fixture and 6a touch no `src/`. Tier 3 and tier 4's run cost model calls on the
existing writer route (extract ≈ 232 s was measured on a 10.9 k-token chunk; these corpora are
small-chunk, so the 15–20 min figure per arm is an estimate carried over from corpus 3, to be replaced
by the first measured wall time) and should run as background tasks. No corpus contains hostnames, absolute
home-directory paths, or credential-shaped strings; `out/` and `captures-dev/` stay gitignored.

## Validation and stop rules

- Each tier reports into `EXPERIMENTS.md` as a dated section with the numbers and the limits of the
  instrument, in the style of *What the subject guard lets through* (2026-10-23).
- Any new instrument gets a fixture check in `tools/` with answers known by construction, and joins
  `npm run test`. `npm run check` (Biome, the tools, `tsc`) and `npm run test` must be exit 0 before a
  slice is called done, and `tools/config-docs-check.ts` plus the README layout table must still match
  the code.
- A tier that cannot be scored deterministically is recorded as blocked, not approximated.
- If a tier's number contradicts a published claim, the published claim is corrected in place — that
  has happened twice this cycle (DESIGN.md's schema-ownership claims, and the clipping row this plan
  opens with) and is treated as the plan working, not failing.
