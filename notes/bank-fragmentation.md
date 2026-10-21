# Fragmentation vs duplication in the two banks (offline, no model calls)

Same conversation, two boundary granularities, final banks measured by lexical overlap
(Jaccard over lowercase word sets, pairs above 0.55):

| bank | active facts | near-duplicate pairs | pairs per entry |
|---|---|---|---|
| control (12 whole captures) | 157 | 5 | 0.032 |
| halves (24 pieces) | 240 | 6 | 0.025 |

So the halves arm's +45 % ADD is **not** restatement of the same fact: duplication per entry went
*down*. Finer boundaries produce more, smaller, distinct facts — fragmentation, not repetition.
Mean statement length also fell (76 → 70 estimated tokens), which fits.

The pairs that do exist are mostly legitimate near-neighbours: two different test files with the
same import edit (0.68), two different modals with the same handler (0.67).

One genuine cross-chunk duplicate surfaced only in the halves bank: two statements about
`normalizeImageUrl from #lib/utils/mediaExtensions.ts` carrying different path labels, at
**0.92** overlap. Candidate retrieval hands the writer the nearest bank entries, so the writer saw
the earlier fact and still chose ADD over UPDATE. Per-draft candidate lists are not persisted, so
"the writer saw it" is inference from a 0.92 overlap under `perDraft` retrieval, not a recorded
fact; what is recorded is that the two statements coexist in the final bank.

- Suggests ADD is preferred over UPDATE when the wording differs in a detail like a path label.
- The apply-stage near-dedup catches duplicates inside a write, not against an active entry whose
  wording drifted.
- A guard would have to be strict enough to keep the 0.68 and 0.67 pairs, which are different facts,
  so it only helps at the very top of the overlap range — a narrow win, and it risks turning a real
  distinction into a merge. Recorded as a candidate, not adopted.

Retrieval precision on the two banks is still unmeasured: more facts may help recall and hurt
precision, and nothing here decides that.
