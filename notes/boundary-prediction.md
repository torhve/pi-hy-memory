# Prediction, written before the halves arm finished (2026-10-21 ~04:10)

Control `out/base-2026-10-21` (writer `hy-memory-30b-a3b`, 12 whole captures, perDraft/24),
judged by `qwen3.8-flash-next-iq3_xxs` seed 7:

Final control figures, after the judge harness was fixed to re-ask a block that answered short
(`15858c6`): an entire chunk had been backfilled with `unknown` verdicts at `specificity: -1`, which
pulled a blindly computed mean from 2.544 to 2.273. Re-judged with `JUDGE_ATTEMPTS=3`, seed 7:

- ops judged 183 (ADD 157, UPDATE 26, DELETE 0), verdict-less **0**, judged ops 183
- supported: full 161, partial 22 — unsupported **0**
- durability: durable 110, marginal 45, noise 28 (file aggregate `noise` 33, counting `shouldNotStore`)
- `specificityMean` **2.519 / 3**
- missed **91** statements the judge says should have been written
- bank after: 157 active, 11 814 tokens (pool cap 60 000 — nowhere near binding)

The figures this note was first written against were 2.273 / noise 23 / missed 84, and they are kept
here as the corrected-away numbers rather than quietly replaced.

For contrast, the earlier 5-chunk run `out/baseline-kitx` on the same writer, judged with the same
judge and rubric: mean specificity **2.73 / 3**, noise 7/63, unsupported 0.

Prediction for `out/halves-2026-10-21` (same content, each capture cut into two pieces at an entry
boundary, so 24 writes instead of 12):

1. **Mean specificity rises.** The paper's effect is that less context produces more specific
   statements, and the two runs above already line up in that direction (2.519 on dense captures,
   2.73 on smaller ones — a smaller gap than the first figures suggested). Expect roughly 2.6-3.0
   for the halves arm.
2. **Unsupported stays 0 or near 0**, because a smaller window is easier to ground.
3. **Noise and missed rise.** Each write sees half a transition, so facts that only become true
   across the cut are stated early (noise) or never re-stated (missed). Expect missed > 91.
4. **UPDATE count rises** (more boundaries, more superseding), ADD rises slightly, DELETE likely
   still 0.
5. **Cost rises near 2× in writes**, while statements-per-entry should stay flat or fall, since
   overlapping context produces restatements.

What would falsify the case for `hy_flush`: mean specificity flat or lower *and* missed higher —
that would mean a finer boundary buys nothing and the session model should not be offered the tool
on quality grounds. What would support it: specificity clearly higher with missed no higher, at a
cost the cooldown/queue bounds.

Reading rule fixed now: compare statement text through each run's ledger with
`dev/boundary-arms.ts --compare`, same judge, same seed, and report the cost columns beside the
quality columns rather than a verdict on quality alone.

## Noise floor, measured before the comparison (second seed on the same control)

The same control judged twice, `qwen3.8-flash-next-iq3_xxs`, `JUDGE_ATTEMPTS=3`:

| seed | specificity | noise | unsupported | missed |
|---|---|---|---|---|
| 7 | 2.519 | 33 | 0 | 91 |
| 11 | 2.563 | 34 | 1 | 86 |

So the judge's own spread on identical writes is about **±0.05 specificity, ±1 noise, ±5 missed**.
Reading rule for control vs halves, fixed here before the halves verdicts exist: a specificity gap
under 0.1 and a missed gap under 8 are treated as no difference, not as a trend.
