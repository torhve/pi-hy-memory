# Changelog

Pi reads this file after a package update and shows every version section newer than the version it
last recorded, under "Extension Updates". It matches `## ` followed by three dot-separated numbers, so
keep the heading form `## X.Y.Z — YYYY-MM-DD` and put the newest section first. `## Unreleased` is not
an entry: it is staging for the next release. See `AGENTS.md` for the rules.

## Unreleased
- Fixed a malformed writer completion ending a session's memory writes. A fact that quotes code — a
  regex copied into a statement — reaches the parser as JSON it refuses, and 25 of those writes across
  12 sessions were recorded as endpoint failures: a 30-second cooldown doubling to 60, the writes that
  would have followed skipped, and no corrective re-ask of the stage. A repair no longer damages a
  valid escaped backslash (`\\s`) while fixing an illegal one, a parse failure is now classified as the
  model's output so its stage gets the one re-ask with the parse error attached, and a write that
  survives the repair still fails says which of the two parse attempts blocked it. The audit gains
  `parse_failure`, carrying the repairs attempted and a masked 400-character window of the completion
  around the position the parser stopped at.

- Fixed the token counts of a write that was re-asked. A stage whose completion could not be parsed
  is asked once more, and its record kept only the first call's tokens: the ledger record, the
  `/hy` footer's `… in / … out tok`, and the write timing all understated a retried write, and a
  replay cannot recover a number the record never held. A retried stage now sums both of its calls.
  Ledgers written before this keep the smaller figure.

- A completion that answered the contract with no array now fails the write. `{"drafts":{}}`,
  `{"ops":"none"}` and a reply that carries neither key parsed as an empty list, so the chunk's
  drafts were discarded, the ledger recorded a clean write, and neither the writer nor the audit was
  told. The stage now gets its one corrective re-ask, the audit records an output failure that names
  the key, and a smaller chunk follows. `{"drafts":[]}` still means "nothing durable here" and stays
  a clean write. No captured run had hit this: all 1,934 completions stored under the measurement
  directories answered with a non-empty array.
- Internal: the package takes `Type` from `typebox` instead of from `@earendil-works/pi-ai`, declares
  `typebox` as a host-provided peer dependency, and now builds against the 1.5 host packages. pi-ai 1.5 no
  longer re-exports TypeBox, so the old import type-checked only against the 1.3 packages it was pinned to.
- Removed `hy_flush`, the tool that let the session model name the range the writer reads, and with it
  the settings `flushTool`, `flushListEntries` and `flushMinTokens`. Three arms measured no benefit:
  specificity stayed flat at a 53 % larger bank, both arms of the compaction pilot kept the same 7 of
  8 specifics, and offering the tool cost +28 % writer tokens. A config that still sets those keys is
  named at startup and ignored, so remove them. `RESULTS.md` keeps the measurements and
  `dev/boundary-arms.ts` stays, so the corpus arm can be re-run.

## 0.2.0 — 2026-11-02

163 commits since 0.1.0. This section lists what changed for a session, not the measurements behind it.
`DESIGN.md` and `RESULTS.md` hold the measurements.

### Bank and summary

- The bank is a store and a compaction summary is a selection out of it. `poolMaxTokens` is now
  `bankMaxTokens` (60 000) and the summary has its own ceiling, `summaryMaxTokens` (12 000). A config
  that still sets `poolMaxTokens` is read as `bankMaxTokens` and named as a legacy key.
- A bank that reaches `bankMaxTokens` retires its oldest facts and writes an `hy.evict` record naming
  every id it took. A retired fact stays in `hy_recall` results, marked with what dropped it.
- The selection keeps a share for facts whose evidence was a user turn (`summaryConstraintShare`, 0.1)
  and a share for old facts that were never superseded (`summaryFoundationShare`, 0.35, with
  `foundationAfterChunks`, 8). A fact this many chunks old and never superseded counts as a foundation.
- A rendered summary now shows two age sections, "Current state" and "Earlier", and carries the
  read and modified file lists the extension computes from the session.
- Removed the confidence score and the relevance tier it fed. Nothing ranked with it anymore.

### Writes

- `maxChunkTokens` now defaults to 6 000, was 24 000. Five ~4 500-token windows found 120 facts where
  three wide windows found 41, for 5 % more input tokens and half the wall time.
- Only a chunk-shaped failure shrinks the next chunk: a timeout, a 413, a context-length rejection or
  unparseable output. A transport error, a 5xx, a 429 or an auth failure resets the shrink instead,
  because a smaller chunk would not have helped.
- A failure now starts a cooldown (`writeCooldownS`, 30 s), doubling while failures continue and capped
  at 10 minutes. Any success clears it. During a 502 storm a down writer cost 508 attempts in 37
  minutes because nothing backed off between turns.
- A finished write chains another when the pending window is still over the trigger, and the 429 backoff
  is bounded so a busy writer cannot spend the whole write budget.
- An idle session pays down its own backlog (`idleDrainAfterMs`, 180 s, and at least four times the
  trigger still unread). A failed write no longer parks a session that has nothing else running.
- Coverage resumes from the furthest position any ledger record still reaches, so a rewind, a resumed
  checkpoint or a re-parenting compaction no longer makes the whole history pending. Measured once at
  431 329 tokens across 3 617 entries. When no record lands in the branch the reset is recorded as
  `coverage_drift`.
- `candidateLimit` now defaults to 24, was 12. `candidateRenderMode` defaults to `perDraft`, so each
  draft gets its own best bank candidate before the cap fills.
- The audit names which model answered each write, on success as well as after a failover.
- Malformed writer output is repaired and re-asked once instead of failing the write.

### Compaction

- The extension never triggers a compaction. pi decides when to compact, and the extension supplies the
  summary.
- The extension now waits for an in-flight write before handing compaction back
  (`waitForWriterBeforeCompact`, on). The wait is bounded by `compactWaitMs` (60 s) and never applies to
  an overflow compaction. Two deferrals once covered a write that finished 39 s after the first.
- The tail and the note now share one room. The tail asks for `keepRecentShare` (0.4) of it and is held
  above a floor while the room can pay one; the note takes what is left, up to `summaryMaxTokens`.
  `keepRecentTokens` is now a ceiling (20 000, was 6 000), and `underprovisioned` reports the split that
  went under its floor.
- When the kept tail must be cut to fit the model's window, the entries the writer never read are folded
  into a bounded digest (`overflowDigestTokens`, 1 500) instead of disappearing. Set it to 0 to drop them.
- Optional model-written checkpoint behind `hifiCompaction` (off). `hifiMaxTokens` 4 000,
  `hifiThinkingLevel` "off", `hifiTailTokens` 6 000, `hifiDeltaTokens` 6 000, `hifiRetryLimit` 3,
  `hifiTimeoutMs` 120 000. It is off by default because it puts a model call at the slowest moment in a
  session, and a model that thinks at a checkpoint spends the output budget without answering.

### Session control

- `/hy` reports the session switch, bank size, cost so far and how far behind the writer is.
  `/hy summary` shows the facts a compaction would render. `/hy off` stops memory work for one session
  and is remembered across reloads; `/hy on` discards the window that accumulated while off and records
  an `hy.gap`.
- `hy_recall` reads the bank. A query returns current facts first and adds a retired fact when it matches
  better, marked with what retired it. An entry id returns the fact plus the exact source entries it was
  written from.
- `hy_flush` lets the session model name the chunk boundary. It is off by default (`flushTool: false`)
  because the pilot measured no compaction-survival advantage while the extra writes cost 28 % more
  writer tokens. `flushMinTokens` (2 000) keeps a flush near threshold size, and `flushListEntries` (24)
  bounds the listing.
- `mergeValueGate` (off) refuses an UPDATE whose draft drops a value its target carries — a number, a
  flag, a file name, a path, an identifier — even when the subject guard calls the two one subject.
- The footer counters count the session, not the process, and are recovered from the session's own
  ledger when it loads.

## 0.1.0 — 2026-10-18

First release.

- Writes a session's facts with two calls per chunk — an extract call and a reconcile call — around
  deterministic bank maintenance. No tool-calling writer, no agent loop.
- The writer is any model already in pi's model list, named as `provider/modelId`. A missing model fails
  with the closest matches listed. An optional second model takes over when the primary is unavailable
  and returns to the primary after `fallbackCooldownS`.
- Compaction summaries are rendered from the bank without a model call. Facts are superseded, retired or
  kept as foundations under a subject guard.
- `/hy` and `hy_recall`. Footer bar for pending window and bank fill. Per-session state under
  `state/sessions/`, pruned after `pruneAfterDays`.
