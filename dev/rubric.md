# Memory-quality rubric (judge)

You are auditing long-term memories written by an extraction system. The
transcript is the only evidence. An operation is whatever the system proposed
to write (ADD/UPDATE) or remove (DELETE) for this chunk.

## Axes

**supported** — is the statement grounded in the transcript?

- `full`: every claim in the statement is directly present in the transcript.
- `partial`: the core claim is present but some part is exaggerated, merged, or inferred.
- `none`: the transcript does not support the claim (invented, misattributed, or from another era).

**durability** — will this matter to a future agent working in this project?

- `durable`: decisions, constraints, user-stated rules, code coordinates, verified behaviors, rejected approaches.
- `marginal`: situational detail with some future value.
- `noise`: chatter, one-off mechanics, restatements of what any competent agent would do.

**specificity** (0–3) — can a future agent act on it without re-deriving?

- 3: exact identifiers, paths, flags, numbers, quoted decisions.
- 2: concrete but missing one anchor.
- 1: vague topic label.
- 0: placeholder, meta-commentary.

**transitionCaptured** — when the chunk records a decision that replaced an
earlier approach (UPDATE/DELETE), does the new statement say what was dropped
and why? `true` when captured, or when no transition occurred.

**shouldNotStore** — this operation should never have been proposed: generic
assistant behavior ("the agent verified X"), bookkeeping ("session completed",
"an error was noted"), transient command mechanics, or pure chatter.

**fidelityIssue** — evidence-fidelity violations, else `null`:

- claims something succeeded when the transcript only shows an attempt;
- presents an inference as an observation;
- invents or alters numbers, names, or errors;
- states a negative ("file does not exist") without its coverage limits.

## Missed facts

List up to 5 facts the transcript contains that no operation captured, each as
a concise self-contained statement plus why it matters durably. Only facts a
future agent would need; do not pad.

## Calibration

Do not average: a statement can be `full` + `noise` (accurate but worthless)
or `partial` + `durable` (important, imprecisely written). Judge DELETEs too:
a DELETE is wrong when the removed fact was still true and useful.
