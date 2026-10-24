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

**Built (2026-10-24, no model call).** `dev/corpus-restraint4.json` exists with all four labels and
nothing measured on it yet: 22 chunks across two authored sessions — 12 `tool_output`, 4 `nothing_work`
carrying tool output under them, 3 attribution pairs — of which 4 hold a call whose arguments run past the
240-character window and 2 hide a value that appears in no chunk's visible text in either session, 4
declare a user rule, and 1 restates a subject the other session established. `tools/restraint-corpus-check.ts`
enforces each label against the shipped renderer — the argument window is measured by rendering the call
with `renderEntry`, not by trusting the number written in this plan — and
`tools/restraint-corpus-mutation-check.ts` breaks every rule on purpose across all four committed corpora
(37 breakings, each rejected by the rule it names). The same check reports, for the corpora that predate
the distinction, that corpus 2's six `nothing_work` chunks all carry tool output: the class boundary 7.17
says is missing is visible in the older corpora rather than fixed in them.

The scorer carries the labels. A declared rule is counted as kept verbatim in a bank fact, kept only as a
rearrangement of its content words, or reaching no bank fact — a keep means the wording sits in a banked fact,
not that the rule was obeyed. A banked fact carrying a token of a hidden value that no chunk in the corpus
shows is the hidden-value carry's positive case, and every token any chunk does show is dropped from it, so
neither a chunk printing 45 nor a timestamp minute `10:45` two chunks away counts as evidence that a bank fact
carrying 45 invented it; the corpus check rejects a hidden value whose every token is visible somewhere. Banked
chatter that arrived reworded is counted apart from chatter quoted.
The loose reading is reported beside the
literal one and never instead of it, and the fixture pins a case where the two disagree.

Re-running the two frozen corpus-3 ledgers through the extended scorer leaves every published number where
it was — 37 and 35 active facts, 10/12 and 12/12 tool facts kept — and adds the one reading the literal
column could not produce: 0 banked chatter paraphrases under the shipped prompt, 1 under the actor arm.
The case is `hy-r3-to-03`, declared chatter "I pulled up the queue module", banked statement "Assistant
pulled up queue module to see where a write lands (src/queue.rs)", carrying neither declared probe
(`queue.tmp`, `src/queue.rs:52`). That measures 7.17's "part artefact" claim as one named case, not as a
rate, and it does not by itself say whether the arm's "chatter banked 2 → 0" was a gain or a rewording:
corpus 4 is what that measurement needs.

Both arms then ran against corpus 4 through the same scorer with `dev/merge-report.ts` and
`dev/session-scope-report.ts` on top: `restraint4-base` and `restraint4-actor`, 22 of 22 chunks each, 340.6 s
and 358.1 s of per-chunk model wall, which replaces the ~15–20 min figure with a measurement.

**Gate before any promotion decision:** the arm must keep its wording gain (statements opening with
a person or the agent's own voice, 15/37 → 5/35) **and** stop losing a declared value, on the labeled
class. If it keeps the wording gain and still costs a value, the arm stays dev-only permanently.

**The gate's outcome on corpus 4.** The wording gain did not follow the arm into the labeled corpus — both
arms kept the declared tool fact 8 times out of 12, against 10/12 and 12/12 on corpus 3 — and the arm still
cost a value: one executed UPDATE dropped `night.toml` where the shipped arm's four dropped nothing, and it
duplicated more (6/12 chunks and 7 facts against 5/12 and 5). By the gate's own terms the arm is not
promoted on this evidence — one run per arm against 22 authored chunks, with several label changes landing
at once, so a settled rejection would need a replicate or an ablation.
What did move is the wording axis alone: bank-wide statements opening with a person or with the agent's own
voice fell from 16 of 48 to 12 of 47. The numbers and their reading are in `EXPERIMENTS.md`.

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

**Measured offline (2026-10-23).** `dev/clip-report.ts` over 51 captured chunk texts: 589 of 1,955
rendered tool calls were cut at 240 with no marker (30.1%), 94.2% of those cuts land inside a quoted
string, 50 of 51 captures hold at least one. It counts with a matched-closer bracket scanner because a
JSON parser throws on the first truncated call and so cannot count truncated calls at all. The three
restraint corpora contain no `[called …]` lines between them — the `tool_output` class models results,
not calls — so no merge or guard number measured so far ever exercised this path, and the fourth corpus
needs tool-call chunks with the decision-relevant part late in the arguments. `tools/clip-check.ts` pins
the failure mode against the shipped renderer. The run arm below has not been spent.

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

**Measured offline (2026-10-23).** Session identity reaches a ledger only through the chunk-id prefix
`hy-<sessionId8>-` from `nextChunkId()` in `src/chunks.ts`, and only organic captures get it. Across
the 28 ledgers under `out/`: 19 carry such a prefix, 9 are authored corpora that carry no session at
all, and **1** demonstrably spans two sessions (`baseline-kitx`). Of its destructive ops, **0 of 383**
read across all 28 ledgers crossed a session boundary, and the spanning ledger's single destructive op
aimed at an entry its own session wrote. That is one opportunity observed, not a safety record, so the
synthetic scenario carries the tier: `tools/session-scope-check.ts` shows retrieval is unscoped, the
guard scores an identical pair the same across sessions as within one (3/8, loose clause), a
cross-session UPDATE overwrites the bank's only session marker with the destroying session's, and a
cross-session DELETE needs nothing but the id.

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
| 3 the two missing labels | new corpus chunks | ran: ~1 h authoring + two runs, 340.6 s and 358.1 s of model wall | the actor-frame promotion decision (7.16/7.17), answered against promoting |
| 4 clipping survival | fixture, then one small run | ~30 min offline + one short run | whether our 240-char silent cut costs values, and a DESIGN.md fix |
| 5 mandated extraction | support contract first | blocked until the contract is written | whether our permissiveness is actually the safer bet |
| 6a session scope | synthetic bank scenario, plus a classifier over every ledger | ~30 min offline, ran | whether destructive authority needs fencing at all — there is no fence, and 5 refused cross-session proposals show the request being made |
| 6b memory unit | — | parked | re-entry trigger recorded |

Tiers 1, 2, 4's fixture and 6a touch no `src/`. Tier 3 and tier 4's run cost model calls on the
existing writer route (extract ≈ 232 s was measured on a 10.9 k-token chunk; corpus 4's two arms measured
340.6 s and 358.1 s of per-chunk model wall over 22 small chunks, run as background tasks) and should run as
background tasks. No corpus contains hostnames, absolute home-directory paths, or credential-shaped strings;
`out/` and `captures-dev/` stay gitignored.

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
