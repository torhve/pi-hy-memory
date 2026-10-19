# Experiment metrics contract

Every runner (`dev/run.ts`) writes `out/<runId>/metrics.json`: one object per
run, one row per chunk. All experiment gates in `TODO.md` are computed from
this file so two runs are comparable word-for-word.

```jsonc
{
  "runId": "baseline-2026-10-19",
  "model": "remote/hy-memory-30b-a3b",
  "pool": 12000,
  "chunks": [
    {
      "chunkId": "hy-01a1510e-012",
      "category": "dense implementation, max budget",
      "resumed": false,                 // extract was reused from a prior attempt
      "entryCount": 93,                 // entries the writer saw
      "drafts": 10,                     // drafts accepted by parseDrafts
      "rejectedDrafts": ["statement too short"],   // reasons, parse-time rejects
      "candidateCoverage": {
        // recomputed with src/protocol.candidatesPerDraft at onExtract time,
        // i.e. against the pre-apply bank and the pipeline's own defaults
        "zeroCandidateDrafts": 1,       // drafts WITH candidates that the shown cap dropped — the coverage failure Tier-1 fixes
        "noCandidateDrafts": 5,         // drafts whose scoring found no bank entry at all (nothing to show; not a failure)
        "shownUnion": 12                // bank entries actually rendered to reconcile
      },
      "ops": { "ADD": 8, "UPDATE": 1, "DELETE": 0 },
      "rejectedOps": [],                // reasons for schema/target rejects
      "downgradedOps": [],              // UPDATE->ADD sameSubject downgrades
      "omittedDrafts": 1,               // drafts the model gave no op at all
      "budgetDropped": 0,               // pool-budget tombstones this chunk
      "bankBefore": { "active": 48, "tokens": 3450 },
      "bankAfter":  { "active": 56, "tokens": 4020 },
      "bankGrowthRatio": 0.028,         // (Δ bank tokens) / chunk tokens; the quantity the
                                        // upstream RL reward taxes (w_pen 0.3 against growth)
      "confidence": [1.0, 1.0, 0.7],    // per accepted draft, pre-bank
      "usage": {
        "extract":   { "inTokens": 20113, "outTokens": 1420, "wallS": 231.5 },
        "reconcile": { "inTokens": 2400,  "outTokens": 210,  "wallS": 17.3 },
        "wallTotalS": 249.1
      }
    }
  ]
}
```

Ledger-only rows for chunks completed before a restart carry
`"reconstructedFromLedger": true` and only the fields the ledger holds
(drafts, ops counts, rejectedOps count).

## Aggregates used by the gates

| aggregate | definition | gate use |
|---|---|---|
| starved-draft share | Σ zeroCandidateDrafts ÷ Σ drafts | Tier-1 fix (≤ 10 %) |
| op hygiene | Σ rejectedOps + downgradedOps + omittedDrafts ÷ drafts | Tier-1 must not regress |
| confidence spread | share of drafts at exactly 1.0 | E1 (from > 95 % to ≤ 80 %) |
| bank growth | mean bankGrowthRatio per chunk | E2 bloat guard, 4.1 |
| cost | Σ extract.inTokens, Σ wall | cost model, remote vs local |
| durable yield | judge output (1.4), joined by chunkId | every quality gate |

## Rules

- The corpus is ordered and the bank is cumulative: a run is one sequential
  write path over the corpus, exactly like production, never per-chunk isolation.
- `out/` and `captures-dev/` are gitignored; `EXPERIMENTS.md` may cite run ids,
  chunk ids and numbers, never endpoints, hosts or transcript text.
- A resumed chunk keeps its original extract usage and adds `resumed: true`;
  gates compare like-for-like runs, so a run with resumes must re-run cleanly
  before its numbers are cited.
