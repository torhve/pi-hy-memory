# DESIGN_HYVCC — pi-hy-memory carrying pi-vcc's deterministic transcript layer

**Status: a proposal written so the go/no-go can be decided.** One part of it has been *synthesized*:
`dev/hyvcc-demo.ts` renders both arms over a real session file and
a real bank, so the shape has numbers and an example — one fixture, tagged as such throughout
(§ "A synthesized compaction, from a real session"). Retention is still unmeasured; that is what
the spike below is for. Every statement is tagged **[measured]** (a harness, a file, or a number
that exists today) or **[predicted]** (a claim about the shape below, with the one experiment
that settles it).
[`DESIGN.md`](DESIGN.md) is the record of what is settled; this file is a hypothesis.

One part is already in the working tree, and it is not the skeleton: the compaction split has been
extracted out of `boundaryFor` into `src/budget.ts` (`budgetSplit` `:82-114`, `dropRange` `:124-135`,
`estimateDigestTokens` `:160-167`, `resolveBudget` `:189-215`, `underprovisioned`), called at
`src/index.ts:1141-1154` — which is the two-pass digest reservation this document asks for, the priced
drop set, and the `lookupMissed` assertion, all built. `tools/budget-split-check.ts` now pins the
arithmetic — the window table, the floor that prices a digest, the order the parts are served in, the
probe loop, and the two caps staying separate so a budget trim always yields a reportable `trimmed`
range. The formulas are the settled committed ones: a tail-share variant was written, table-tested and
**reverted the same day** because it inverted what `DESIGN.md:631` records about which of the two gives
way. It is kept in § Tail and digest as an audit trail.

Audited sources: [`sting8k/pi-vcc`](https://github.com/sting8k/pi-vcc) `a78ed77` (v0.11.1,
5 471 lines, MIT) and [`k0valik/pi-blackhole`](https://github.com/k0valik/pi-blackhole)
`92f7ba1` (0.5.16, 47 827 lines, MIT) — the latter is a **file-copied** merge of pi-vcc and
[`pi-observational-memory`](https://github.com/elpapi42/pi-observational-memory), with no
runtime dependencies and upstream tracking in `.pi/skills/lockstep/`.

A bare filename below is a **pi-vcc** path (`src/core/…` unless another directory is stated). Both
repos carry same-named files at different line numbers, so a citation that only holds in
[`pi-blackhole`](https://github.com/k0valik/pi-blackhole) says so on purpose: `stripOMContent`,
`BRIEF_MAX_LINES`, the recall LRU cache, and `inline-compaction.ts` exist only there.

## The claim in one line

pi-hy-memory today produces a compaction summary that is **only durable facts**. A
deterministic transcript skeleton underneath them — the session's opening asks, the newest
user lines verbatim, commits, command families, file paths, and a ranked one-line-per-turn
transcript of everything between the last summary and the kept tail — is the part pi-vcc does
well and hy does not do at all. Adding it, plus pi-vcc's raw-session recall, closes the two
holes hy has: **content the writer never read is unrecoverable**, and **content the writer
read but did not bank is unrecoverable too. Neither arrives as a default: the recovery corpus is a
second corpus of the same `hy_recall` tool, switched off until it is measured, and the skeleton is
one slice carved out of the summary cap hy already has.

What we are *not* proposing is pi-blackhole. Blackhole's memory half is what pi-hy-memory
already is, deliberately and with better economics ([`DESIGN.md:207-211`](DESIGN.md):
observer agent → one extract call, reflector agent → one reconcile call, dropper agent →
deterministic `enforceBudget()`). Re-importing `src/om/**` would undo a measured decision and
add three agent loops per window where hy pays two single-shot calls.

## What each half is actually for

| layer | answers | written by | cost | hy today |
|---|---|---|---|---|
| bank facts (`renderMemory`, or a hi-fi checkpoint) | *what is true now, what the user required, what was decided* | Hy-Memory writer, continuously | 2 calls per chunk | yes |
| verbatim kept tail | *what we were doing a moment ago* | pi keeps the entries | 0 | yes, `keepRecentTokens 6000` (shipped default; the live config here runs 5 000) |
| transcript skeleton | *what was asked at the start, what was run, what was touched, what the turns were* | code, at compaction | ~0 ms, no call | **no** |
| recovery over the raw session | *what the summary dropped* | `hy_recall`'s transcript corpus, on demand | one tool call | **no** (`hy_recall` searches the bank only) |

The four are orthogonal. hy has two of four.

## Where hy is blind today

- **A fact the writer never saw is gone.** `hy.gap` records the range
  (`src/index.ts:1389-1397`, reasons `overflow-trim` and `disabled`) and the overflow digest
  carries clipped raw lines into the summary (`src/index.ts:1373-1388`), but nothing is searchable:
  once pi drops those entries, neither the bank nor `hy_recall` can reach them.
- **A fact the writer saw but did not bank is gone too.** The bank is a selection the writer
  made; `hy_recall` only searches what survived that selection.
- **`bashExecution` entries are invisible to everything.** Pi's `!`-shell messages carry
  `command`/`output`/`exitCode` and no `content` field
  (`pi-coding-agent/dist/core/messages.d.ts:16-27`), so `textOfParts` returns `""`
  (`src/entries.ts:38-56`), `renderEntry` returns `undefined` (`src/entries.ts:66-89`), and `entryTokens` reports **0**
  — the command never reaches the writer *and* never counts toward `observeAfterTokens`.
  pi-vcc normalizes them as a first-class block (`normalize.ts:22-27`). **[measured]**
- **Skill bodies arrive as user turns and get budgeted as user constraints.** pi injects
  `<skill name=…>` inside a user message (`pi-coding-agent/dist/core/agent-session.js:1739`);
  across this machine's 1 180 session files there are **65 such blocks, 855 456 characters,
  largest 86 980, and 58 of 65 are `role:"user"`** (census re-run 2026-10-26; the session dir grows).
  `maxEntryChars: 3000` bounds the damage to
  a chunk slot, but the provenance is still `user`, so they compete for
  `summaryConstraintShare` as if the user wrote them. `SKILL_BLOCK_RE → [skill: name]`
  (`src/core/skill-collapse.ts:4-5` upstream — hy has no such file) is the whole fix. **[measured]** And `DESIGN.md:1146` finding #4
  ("the model dutifully recorded it as a fact about pi-blackhole") is this exact failure class.
- **Exact commands and commit hashes are not in the summary.** The argument window is 600
  characters and still cuts 16 % of calls (`src/entries.ts:30-37`, `dev/arg-window-cost.ts`);
  the summary carries `<read-files>` / `<modified-files>` only (`src/render.ts:162-171`).
  pi-vcc keeps commits with hash↔subject pairing (`commits.ts`) and a bounded per-family
  command ledger (`tracked-commands.ts`).
- **Retrieval is weak and that is already documented.** `DESIGN.md` "Not yet proven" #3:
  lexical retrieval failed to retrieve the contradicting bank entry for **93 of 109**
  removal-bearing drafts. `recallHits` counts substring token overlap with no IDF
  (`src/render.ts:203-222`). pi-vcc scores with BM25 (`search-entries.ts:193-232`, `k1=1.2`,
  `b=0.75`, one-pass IDF, terms compiled once per search).
- **`hy_flush` refs are window-relative.** `[n]` is an index into the *pending* list
  (`src/flush.ts:79-88`, where a ref is a position among *renderable* rows), so a write that lands between the listing and
  `hy_flush({to})` shifts every number. pi-vcc owns a session-global id→`#N` space that is
  fail-closed on duplicate ids (`global-indices.ts:28-52`). **[measured]**
- **Compaction accounting claims credit it may not have.** Pi runs *every*
  `session_before_compact` handler and keeps the **last non-undefined** result, `{cancel: true}`
  short-circuiting (`pi-coding-agent/dist/core/extensions/runner.js:813-838`, consumed at
  `agent-session.js:2253-2293` for `/compact` and `:2542-2586` for the automatic path hy rides, and
  persists the winner's `details` into the compaction entry (`:2297`, `:2586`). hy stamps
  `details: { hyMemory: true }` (`src/index.ts:1587`) but never reads it back: `stats.compactions++`
  (`src/index.ts:1564`) and the `compact` audit
  fire whenever hy *returned* a summary. pi-vcc reads the truth from the persisted entry
  (`pi-vcc/src/hooks/before-compact.ts:907-931`, "read the truth from the persisted entry instead of lifecycle
  state"). **[measured]**

## How it would work

### Pipeline — the cut and the wait are unchanged

```
session_before_compact(event, ctx)
  boundary = boundaryFor(branch)            # watermark-clamped cut, unchanged
  wait for the in-flight write (ETA-gated)  # unchanged
  facts   = renderMemory(bank, summaryBudget - briefBudget) | hifiCheckpoint(...)
  brief   = compileSkeleton(prefixBetweenLastSummaryAndTail)      # NEW, pure, ~0 ms
  files   = renderFileOperations(fileOps)   # unchanged; widening it needs extractPaths (upstream tool-args.ts:1-17),
                                            # which hy does not have: fileOperations (src/entries.ts:102-133) reads only args.path
  digest  = overflow digest of unread range # unchanged, or replaced by a skeleton (gate G4)
  summary = facts + "\n\n" + brief + "\n\n" + files + digest
  return { compaction: { summary, firstKeptEntryId, tokensBefore, details:{hyMemory:true,…} } }

session_compact(event)                       # NEW
  if (event.compactionEntry?.details?.hyMemory !== true) → record "not owner", do not
     advance coverage, do not count a compaction
```

The memory block **leads** and the deterministic block sits under it. That is a deliberate
departure from blackhole, which appends its memory last (`pi-blackhole/src/hooks/before-compact.ts:896`,
final assembly `:1078-1091`) because in *that* combination the brief is the primary artifact. In hy's combination
the bank is the primary artifact: it is the only block whose lines carry ids with evidence behind
them, and it is the block a reader acts on. What must come from blackhole unchanged is not the
order but three rules: the block is **never substituted** — its absence is reported as "the memory
bank is empty for this branch", which is true information; the emptiness test is *content*, not the
rendered string (blackhole `:885`, because its renderer always emits a footer); and memory is stripped out of
the **stored previous summary** before merging, so the block cannot compound
(`pi-blackhole/src/core/summarize.ts:407-424`, `:451`, `stripOMContent`; pi-vcc has no such function).

The cut is **not** blackhole's. `tailBehavior: "minimal"` keeps only the last user message;
hy's contract is that the cut never passes the write watermark past `maxChunkTokens`, so the
tail stays `keepRecentTokens` and the skeleton is built over the range pi is dropping.

### Budget: the skeleton is carved out of the existing summary cap, not out of the window

hy already splits the retry request three ways in `src/budget.ts` (`budgetSplit`, `:82-114`), reached from
`boundaryFor` at `src/index.ts:1108-1163`, its split call at `:1141-1154`: kept tail, summary, overflow digest, against
`available = window − reserve − measuredOverhead − COMPACT_SLACK_TOKENS(1500)`. The digest is reserved
first at `min(overflowDigestTokens, ⌊available / 4⌋)` and then priced down to what a boundary probe
found; the summary takes `max(COMPACT_SUMMARY_MIN_TOKENS(500), min(summaryMaxTokens,
available − digest − COMPACT_KEEP_MIN_TOKENS(1000)))`; the tail is what remains, bounded by
`keepRecentTokens`. So the note sheds its own configured maximum before the tail sheds an entry, and the
tail is owed 1 000 tokens whenever the room can pay it — which is what `DESIGN.md:631` records and what
`tools/budget-split-check.ts` now pins. `summaryTokenBudget` is capped by
`summaryMaxTokens = 8000`, so the skeleton needs **no new window arithmetic** — it takes a
slice of that cap:

| part | default | rule |
|---|---|---|
| facts | the residual above a floor | `selectForSummary` shares apply to the **remainder**, not the whole cap |
| section block | `min(skeletonMaxTokens 1 200, ⌊0.25 × summaryTokenBudget⌋)` (release 1) | measured 254 tokens in the last window, 1 033–1 166 in early ones; derived, because absolute caps go negative on a 32 k window (§ Tail and digest) |
| ranked brief | `min(briefMaxTokens 1 500, ⌊0.20 × summary⌋, clamp(prefixTokens × 0.08, 300, 1 500))` (release 2, with the transcript corpus) | narration sized by what was actually dropped; hy-enforced — pi-vcc's own `1100 / 2000 / 15` per block (`before-compact.ts:834-836`) is a target the compile overshoots (fixture: 1 588–2 043 against 1 100). Two caps, not one, because the two halves trade places as the session ages |
| `<read-files>` / `<modified-files>` | unchanged | already subtracted before the fact budget |
| overflow digest | `overflowDigestTokens: 1500` | a **ceiling**, not a charge: reserved only when a trim happens, priced at the drop set, never above `⌊available / 4⌋` (`src/budget.ts:96-99`) |
| hi-fi checkpoint | `hifiMin(hifiMaxTokens, summaryTokenBudget)` | unchanged, and it competes with the skeleton for the same slice |

**[predicted]** the constraint and foundation slices survive if the shares are computed on the
remainder and the remainder has a floor. The arithmetic below says the floor is only reachable at
`summaryTokenBudget = 8 000` — the `≥ 5 000` claim holds on a ~36 k-and-up window, not on a 32 k one,
where the summary itself is 2 387 tokens. That is what spike B exists to test, because
`DESIGN.md:693` established these shares *after* recency ranking failed twice.

A 168 000-token window with pi's default `reserveTokens: 16 384` means the skeleton changes
nothing about what the tail may hold; it only reallocates inside the 8 000-token summary.
Measured on a real window (`dev/hyvcc-demo.ts`, below): 1 500 tokens out, **19 fact lines** gone
from a 240-active bank (16 from a 172-active one), 1 268 tokens back in. Release 1's section block
alone is 328 tokens in that window — two fact lines — and 1 032–1 167 in the session's early windows.

### Tail and digest: what the budget arithmetic actually delivers

`keepRecentTokens: 6000` is an **upper bound, not a delivered size**. The shipped split is
`available = window − reserve − measuredOverhead − 1500`, digest first, summary at its cap, tail getting
whatever was left, now living in `src/budget.ts` (`:92-106`) instead of inline in `boundaryFor`
(`HEAD:src/index.ts:1158-1175`). The table below is recomputed from `budgetSplit` itself by
`tools/budget-split-check.ts`, which reproduces every row at pi's default `reserveTokens: 16 384` and
pins that its tail column is the *delivered* tail — the room the split leaves, capped by
`keepRecentTokens`. Computed from those formulas — arithmetic, not a measurement:

| window | overhead | available | tail delivered | summary | digest |
|---|---|---|---|---|---|
| 16 000 | 2 000 | 0 | 0 (newest entry only) | 500 | 0 |
| 24 000 | 2 000 | 4 116 | 1 000 | 2 087 | 1 029 |
| 32 000 | 2 000 | 12 116 | 2 616 | 8 000 | 1 500 |
| 32 000 | 9 600 (30 % cap) | 4 516 | 1 000 | 2 387 | 1 129 |
| 36 000 | 2 000 | 16 116 | **6 000** | 8 000 | 1 500 |
| 168 000 | 2 016 | 148 100 | 6 000 | 8 000 | 1 500 |

- Under those committed formulas the tail reaches its configured 6 000 only at `available ≥ 15 500` — a ~36 k window with a small
  prompt, or ~48 k once overhead runs to the 30 % cap. Below `available 10 500` it is exactly
  1 000. `trimKeptTail` always keeps the newest entry (`src/entries.ts:243-247`), so a tail never
  goes empty — but a single 100 k-token tool result is a tail the window cannot hold, which the
  code reports as the larger-context case rather than fixing.
- The shipped code keeps the comment "the summary gives up its configured maximum before the tail gives
  up its entries" (`src/budget.ts:100-101`), and the arithmetic agrees with it above `available 10 500`:
  the summary clamps at its 8 000 cap there and the tail absorbs the shortfall, while below
  `available 10 500` the summary is what shrinks and the tail sits at exactly 1 000. A variant was
  written during this session that inverted it — the note hoarding a 500-token minimum while the tail
  asked for `COMPACT_TAIL_SHARE = 0.35` of the room — and **reverted the same day**, on the measured
  difference between the two. They agree wherever the room is too small to pay both and wherever it is
  large enough to pay both with the note at its cap. They differ in the middle: at `available 12 116`
  the shipped split gives note 8 000 and tail 2 616, the variant gave note 6 900 and tail 3 716 —
  **1 100 tokens, 14 % of the note, moved from the memory to verbatim conversation the session never
  asked for**. The fixture's sessions wanted tails of 10 120–39 922 estimated tokens at a lagging
  writer's watermark, far above either number, and what actually fixed that thrash was the
  `maxKeepTokens` request cap (`src/entries.ts`), not a tail share. The lesson for the skeleton is the
  ordering itself: a block that competes in the 10 500–15 500 band must take its share from the note's
  maximum, not from the tail's entries.
- Absolute caps do not survive the arithmetic. On a 32 k window with overhead at the cap, the
  summary is 2 387 tokens, so `skeleton 1 200 + brief 1 500` is 2 700 — **the facts go negative**.
  Caps must be derived from `summaryTokenBudget`, not declared: `skeleton = min(1 200,
  ⌊0.25 × summary⌋)`, `brief = min(1 500, ⌊0.20 × summary⌋)`, facts the residual above a floor;
  drop the brief first, then **whole sections in a stated order** — never truncate the compiled
  string, because a truncation that cuts a `#N` ref leaves a pointer that resolves nowhere. Net the
  caps against `src/render.ts:95-106`, which already charges the header and omission tail inside the
  summary budget, or ~40 tokens are counted twice.

- **The note costs more than the split reserves for it.** `summaryBudget` is
  `summaryMaxTokens + Σ "[id] (task) "` (`src/render.ts:38-43`): the cap prices the statements, not the
  message. A note rendered at the 8 000 cap arrives at **11 050** tokens on the fixture's 240-active
  bank, and `budgetSplit` reserves `summaryTokenBudget ≤ 8 000` against the window, so the label prefix
  (~2 400–3 050 tokens here) is charged to nobody. A skeleton slice carved out of that cap is carved out
  of the statements, and spike D has to assert the *rendered* length rather than the reserved one.

The digest's defects, independent of the skeleton — two since fixed in the tree, one still open:

- **It used to be paid for before it was known — now probed.** The committed code subtracted
  `digestBudget` from `available` inside `boundaryFor` (`HEAD:src/index.ts:1158`) for a trim only
  discovered later (`HEAD:src/index.ts:1400`), surrendering up to 1 129 tokens and throttling
  `maxKeepTokens` for a receipt that usually prints nothing. `src/budget.ts` implements the re-derivation
  asked for here: probe with `digestTokens: 0`, price the drop set at `DIGEST_ENTRY_CHARS / 4`
  (`estimateDigestTokens`, `:144-148`), re-split, and iterate to a fixed point over at most three passes
  (`resolveBudget`, `:169-194`), the reservation capped by
  `min(overflowDigestTokens, available / 4, priced)` (`:101-104`). A probe that does not settle reports
  `converged: false` rather than iterating forever, and the post-wait recompute
  (`src/index.ts:1281-1285`) is the same shape. And the test the module promised now exists:
  `tools/budget-split-check.ts` pins the window table, the rounding direction, the order the parts are
  served in, the digest never charged for a trim no probe found, monotonicity across windows, and the
  probe loop reporting `converged: false` rather than iterating.
- **It mixes a receipt with an excerpt.** Keep the receipt mandatory and tiny in the trim case
  (~50 tokens: range ids, entry count, estimated tokens, "never written to the fact bank") and make
  the clipped excerpt optional, sized by whatever the receipt and the blocks leave. `serializeEntries`
  already returns `droppedEntries` (`src/entries.ts:188`) and the digest *uses* it (`src/index.ts:1384-1387`,
  rendering "N not shown", because saying "N entries" over a shorter list is "the one lie this digest
  exists to prevent"). That mismatch is fixed; the receipt/excerpt split is the open part. The durable
  record already exists — `hy.gap` with reason `overflow-trim` (`src/index.ts:1395`) or `disabled`
  (`src/index.ts:1741`); `"compaction"` sits in the type (`src/types.ts:126`) and is counted by
  `src/stats.ts:85`, but nothing writes it, so the ledger-seeded counter stays 0. What is missing is surfacing it as "this session lost N
  entries at compaction #k" in status or recall, which is worth more than 1 500 tokens of clipped text.
- **The range lookup was sliced, now asserted.** The committed code's `entries.findIndex((e) => e.id ===
  choice.trimmed?.fromId)` (`HEAD:src/index.ts:1401`) returned -1 when the id was gone, and
  `Math.max(-1, watermark + 1)` then started the "unread" range at 0 — the conservative answer, reached
  by accident. `dropRange` (`src/budget.ts:124-135`) reports `lookupMissed` as its own field and the
  audit carries it (`src/index.ts:1421`), so a re-parented compaction after a rewind can still widen the
  never-written range, but it can no longer do it without saying it did.

That collapses **G4**: with no trim, the skeleton block is purely additive and competes with nothing;
the digest question only exists in the trim case, where it is a priority order inside a leftover
budget. Much smaller decision than "replace the digest or not".

One more thing the arithmetic shows, and it is a behaviour question rather than a budget one: when
`available` is near zero, hy still emits a 500-token summary that cannot bring the request under pi's
threshold — the same re-fire loop the watermark clamp was built for (`src/entries.ts:263-272`: six
compactions in 37 s, the same 47 KB summary each time), reached by another route. The split now *names*
that case — `underprovisioned` when the room cannot hold a usable tail and a usable note
(`src/budget.ts:112`), recorded in the probe audit (`src/index.ts:1422`) — but it still emits
the summary. The flag is built; the decision (decline and record why, or report the shortfall and let pi
try again) is still gate G7.

### Anatomy of the compacted message: what the model actually sees

After a compaction pi sends three things: the summary block, the kept tail verbatim, then live
context. hy owns the first block, and nothing in it is model-written unless the checkpoint path is
switched on. With the proposal it has five parts, in a fixed order. From the copy above (21 333
entries, a 173-message window):

```
┌ summary                        10 981 tokens as measured — see the note below
│  1  memory block               INTRO + "## Current state" / "## Earlier"
│       [id] (task) statement    12-hex ids, source evidence one hy_recall call away
│                                (19 fact lines give up their room to the skeleton)
│  2  deterministic skeleton     ≤ briefMaxTokens, capped by hy, never by the compiler
│       [Early Session Requests]    [Files And Changes]    [Commits]
│       [Tracked Commands]          [User Messages]
│       ranked brief              one line per turn, each carrying a (#N) ref   ← release 2 only
│  3  pi's file lists            <read-files> / <modified-files>           131 tokens ← overlaps 2
│  4  overflow digest            only when the kept tail had to be trimmed 1 500 tokens
│  5  recall note                one line naming hy_recall                   31 tokens
└
   kept tail                     32 entries / ~5 301 tokens, verbatim, never rewritten by hy
```

The 10 981 is the *fixture's* number, not the shipped one: the harness renders the memory arm at
hy's full cap and then *adds* the skeleton, which is what prices the skeleton honestly. The shipped
shape subtracts the skeleton from `summaryTokenBudget` first — but that cap prices the fact
statements, because `summaryBudget` re-adds the `[id] (task) ` labels (`src/render.ts:38-43`). The same
window still lands near 11 000 tokens: ~6 500 of statements, ~3 000 of labels, the skeleton, the file
lists. No shipped shape lands at 8 000 — which is also why the cap must be enforced on the compiled
string, the way spike D pins it, and not on the reservation.

Three rules belong to that shape, and they are what makes it a shape rather than a template:

- **A part appears only when it has something to say.** In the last window both user-ask sections
  were absent (that window held zero user messages) and `## Earlier` was absent (one age group in
  the bank); in the session's first window the user-ask sections had 80 user turns to draw on. The
  shape reports what is missing instead of printing a header over nothing, and which parts are
  present is a function of window position — see the stratified table below.
- **Order is fixed so a reader learns where to look**: decisions with ids, then what happened, then
  files, then the pointer to what was dropped. pi-vcc's README carries the same section for its own
  summary; when this is built, `README.md` gains the equivalent beside the settings table.
- **Nothing above the kept tail is a paraphrase**, except the opt-in checkpoint — and that path is
  off by default for the reason hy already states: a model call at the slowest moment in the
  session. The skeleton shares the render's property: it cannot fail, and it arrives instantly.

### Which sections to take, and which to refuse

pi-vcc's ranked brief selects prose by score, and the score table is **English-and-CLI shaped**:
`TEST_COMMAND_RE` matches `bun|npm|pnpm|yarn|node|pytest|cargo|go|mvn|gradle` with
`test|spec|check|lint|build|tsc`, `NOISE_STRINGS` are host boilerplate, and the trivial-bash
penalty is a list of shell verbs (`rank.ts:45-76`, `filter-noise.ts:3-31`). hy's bank is
language-agnostic on purpose ("none of the sections depend on wording"). So take the
**wording-free** sections:

| section | source | cap | why it is safe in any language |
|---|---|---|---|
| opening asks | first 3 user messages, verbatim | 300 chars each, `Intl.Segmenter` | position, not pattern |
| recent user asks | newest 15 later user messages, verbatim, `injected` skipped | 300 chars | position, not pattern |
| files | `extractPaths` (single `path`, `file_path`, `filePath`, `file`, or a `paths[]` array) | 10 per category, trimmed to a common root | tool shape |
| commits | bash command parsing incl. `-m "$(cat <<…)"` and `-F -` heredocs, hash taken only from a result line whose subject matches | 8 newest | command shape |
| command families | opt-in list like pi-vcc's `trackCommands`; 10 newest per name | quote-aware tokenizer, `sudo/env/nohup` prefix kept, `ssh` remote unwrapped | command shape |
| transcript | one line per turn over the dropped range, tool calls collapsed with `(#N)` refs | ~120 lines, token-budgeted | structure, not content |

Refuse the ranked-prose selector, the `[Outstanding Context]` / `[User Preferences]`
regex extractors, and `[Tracked Commands]` **on by default**. A regex that decides what is a
preference is exactly the class of thing hy's measurements killed once already
(`DESIGN.md:779` *Ranking*).

### Release 1 is the section block; the brief ships with the corpus it points into

**A summary must not print a pointer the recall tool cannot resolve.** Every `(#N)` in the measured
skeletons is in the ranked brief (9 / 25 / 26 / 15, none in the section block), and `#N` resolves
only in the transcript corpus — which ships switched off until it is measured. So the brief and the
corpus are **one feature**, released together or not at all. Shipping the brief without the corpus
is the actual half-feature: a block of truncated paraphrases with dead links, which breaks the
anatomy's own rule that nothing above the kept tail is a paraphrase.

Release 1 is therefore:

- the five wording-free sections — opening asks, recent user asks, files, commits, command
  families — 0 refs;
- BM25 scoring over the bank, no session file;
- recompute-only merge, no stored skeleton state.

What it costs, from the stratified table: **254 tokens (1 fact line)** in the last window,
**1 033–1 166 tokens (8–9 fact lines)** in the early ones — against the 19 fact lines the full block
asks for. What it does not buy, stated plainly: the narrative of the dropped range, i.e. the second
blind hole stays open until the corpus ships. That is what release 2 is for, and it is a clean v2
rather than a trimmed v1:

```
release 1   sections (no refs) + BM25 bank scoring          cap: skeletonMaxTokens 1 200
release 2   ranked brief + the #N space + transcript corpus  cap: briefMaxTokens    1 500
```

Two caps, because the measured halves trade places as the session ages (74 % / 19 % early-to-late);
one cap over both lets one half eat the other at the end of a long session. Both are enforced by hy
over the compiled string, never trusted from the compiler — the fixture ran 1 588–2 043 tokens
against a 1 100-token instruction.

The vendoring follows the same boundary: release 1 ports `normalize` (77 lines), `user-messages` (66),
`tracked-commands` (232), `commits` (147) — **522 lines**, all pure and wording-free (blackhole's copies
run longer: its `normalize` is 120, its `commits` 384). The
brief format and selection (~430 lines), which is the piece most likely to drift from upstream and
the least portable, waits for release 2. If spike A shows the section block is not worth its tokens,
the port shrinks to a ~300-line reimplementation and this document becomes a record of a no-go.

### Merging across repeated compactions: choose one, not blackhole's

pi-vcc merges sections into the previous summary and re-caps them (`summarize.ts:77-205`):
opening asks pinned by the first summary, `- Category: a, b, c` unions with `stripCapMarker`,
`touchOnDup` so a repeated item becomes "N most recently *used*", brief rolled forward by line
budget. That needs state hy does not keep, and hy's current virtue is that a compaction is a
**stateless re-render from the ledger**.

Two honest options:

1. **Recompute** each skeleton from the branch, every compaction, and keep only the opening
   asks (they are positional and cheap to recompute). Simpler, no compounding, but the opening
   asks of a 300-turn session are stale — pi-vcc's own README says so.
2. **Merge** as pi-vcc does, storing the skeleton in the ledger (a `hy.skeleton` custom entry,
   which the ledger fold already tolerates by skipping unknown `customType`s). Faithful, but
   it adds a persisted block that must be stripped from any summary text so it cannot compound.

Recommendation: (1) for the first arm, and only escalate to (2) if a corpus replay shows the
recomputed skeleton losing something the merge would have kept. **[predicted]** One fixture
observation already leans this way: handed hy's fact block as `previousSummary`, the merge
returned 60 of 131 fact ids — but that is a payload the merge was not written for, so F is the
measurement, not this.

### Recall: one tool, two corpora, one scoring port

- **`hy_recall` gains BM25 over the bank** (scoring only: IDF, `k1=1.2`, `b=0.75`, stopword
  filtering, terms compiled once, relative floor 0.2 gated on ≥2 distinct terms, result cap
  with honest truncation). This is aimed at the measured 93/109 retrieval miss, and it needs no
  session file at all.
- **One tool, two corpora — not a second tool.** pi-vcc's `vcc_recall` is one tool with six
  parameters and a description that runs from `tools/recall.ts:22` to `:40`, parameters `:45-73`; hy's `hy_recall` is three
  parameters and two lines (`src/index.ts:1631-1644`). Registering both would put ~20 lines of
  tool prose in every session and hand the model a choice between two tools whose queries look
  identical. So the raw arm lands inside `hy_recall`, and **the argument you pass picks the
  corpus**: `query` and `id` are the bank, `#N`, `range:[from,to]`, `expand:[N]` and
  `#N:path[:full|offset:limit]` are the transcript, `mode:"touched"` is the transcript's file
  list, and `page` / `scope:"lineage|all"` / `limit` are shared knobs. Nothing named
  `vcc_recall` is ever registered by hy — the engine is ported, the name is not.

  ```
  hy_recall({ query: "clamp font size" })              // the bank: ranked facts, ids included
  hy_recall({ id: "cb391d7a0bf1" })                   // a fact + the exact entries behind it
  hy_recall({ query: "#20007:e2e/appUrl.ts" })        // transcript: a file as entry #20007 touched it
  hy_recall({ range: [20130, 20160] })                // transcript entries in order, 20 per page
  hy_recall({ expand: [20052] })                      // one entry, untruncated
  hy_recall({ mode: "touched" })                      // files the session worked on, with #N
  ```

  The `(#20130)` a summary line prints is the number `range` and `expand` take — **one index space
  is the point of merging the tools**, and it is what makes a summary ref actionable a week later.
  The four transcript calls are rejected by name while `recall.raw` is off.
- **The corpus is chosen, never guessed.** `corpus` defaults to `bank`. A plain `query` scores the
  bank in memory and, on a miss, says so and names the flag that could reach further
  (`recall.raw`) — it does not open the session file. The transcript answers only when it is
  asked for: through a transcript-shaped argument (`#N`, `range`, `expand`, `#N:path`) or
  `corpus:"raw"`. Silent bank-miss→file fallback is a *later* opt-in, not the default: it would
  make every bank miss a potential file read over a 44 MB transcript, and "nothing found, and here
  is 500 lines of uncurated transcript" is a worse answer than "nothing found". A bank miss staying
  cheap is the economics of having a bank; the reason `scope:"raw"` on a corpus-blind tool would
  have been the wrong shape is the same.
- **Validation is discriminated, not permissive.** Transcript arguments with `corpus:"bank"`, or
  any transcript argument while `recall.raw` is off, is an actionable error rather than a silent
  ignore; a call mixing bank and transcript arguments fails with the reason. That would be pinned by a
  `tools/recall-schema-check.ts`, which does not exist yet, in the same style as the other checks: a wrong-corpus call is
  rejected by name, an off-corpus call is rejected, and a mixed call says which argument caused it.
- **The schema ships phased with the config.** While `recall.raw` is off, `hy_recall` is
  registered with its three bank parameters and its two-line description — the extra parameters
  and the paging/drill-down prose are not in the prompt at all. Enabling the transcript corpus
  grows the schema and the description together, so a session never pays for a capability it has
  switched off.
- **Every result says which corpus answered, and what its refs mean.** A bank line is
  `[12-hex] (task) statement`, expandable to the exact source entries behind it; a transcript line
  is `#N …` under a header that says *from the transcript, not the bank — verify before treating
  it as current*. This is hazard 5 of "What would be worse" (two index spaces) met with a label
  per line and a header per call rather than with a namespace the model has to remember.
- **Merging buys one self-exclusion surface.** pi-vcc excludes the recall tool's own invocation
  args *and* its own result text, because "without both exclusions a repeated query keeps
  matching its own prior invocation/output and the hit count grows on every search"
  (`search-entries.ts:282-296`). With two tools that is two surfaces to keep in sync forever;
  with one it is one. Either way it is mandatory: a raw arm that ever fed the writer would
  recreate `DESIGN.md:1146` finding #4, self-referential memory. The raw corpus stays read-only
  and is never part of a chunk. The echo loop is a test, not an assertion: running the same query
  three times must return the same hit count (E).
- **Co-installed with pi-vcc is a known state, not a collision.** Both tools would then exist
  over different corpora, and hy's `#N` must be counted by pi-vcc's rule — every
  `type === "message"` entry in file order, fail-closed on a duplicate id
  (`global-indices.ts:28-52`) — so a `(#12)` printed by one resolves in the other. A second,
  privately-counted `#N` space would be worse than two tools. `recall.raw: false` is the knob that
  turns hy's transcript arm off. Until E proves recovery **and** bounded reads — including cache
  invalidation against a session file that is still being written — **off is the default**, and the
  bank scoring ships alone with the bank-only schema.
- **`hy_flush` moves to the `#N` space** so a named range survives a write landing mid-call — and
  keeps `[n]` when `recall.raw` is off, since there is then no transcript index to agree with.

### Vendoring discipline, or don't vendor

pi-vcc publishes `main: "index.ts"`, `files: ["index.ts","src/"]`, **no `exports` map** — there
is no API surface to depend on, and loading it as a package registers a competing
`session_before_compact`. So the choice is file-copy or reimplement. Blackhole's file-copy
mechanism is: per-file `Upstream: <url> (path)` headers, a 60-entry bijection mapping
(`UNCHANGED 22 / MODIFIED 23 / MOVED 6 / ELIMINATED 5 / REWRITTEN 2 / MERGED 2`), committed SHA
markers (`.upstream-vcc-head = b4c9099c…`), and a read-only audit script.

**[measured]** — and it is stale: that pin is dated 2026-05-23 while pi-vcc's head is `a78ed77`
(2026-10-25), **190 commits** later with nearly every `src/core/*` file changed, and the map
marks `src/core/search-entries.ts` `UNCHANGED` while the copy blackhole ships of that same file
(`src/core/search-entries.ts:3-8`) carries an `Amended (#106)` header — pi-vcc's own copy has no header
comment at all. Copying blackhole's *mechanism* without its drift means nothing. If we copy,
we add `tools/vendored-drift-check.ts` to `npm run test`: pin the SHA, diff the copied files
against it, fail on unrecorded drift. And rename the collision surface before shipping:
`vcc_recall` is never registered — its engine lands in `hy_recall`; also rename `pi-vcc` / `pi-vcc-recall` commands, custom types
`pi-vcc-auto-continue` / `vcc-recall`, the `__pi_vcc__` marker, `pi-vcc-config.json`,
`/tmp/pi-vcc-debug.json`, `details.compactor`, and the `RECALL_NOTE` text — pi-vcc removes its
own note with a regex built from its own words (`summarize.ts:324-329`, stripped at `:336-337`), which is a self-match
hazard we must not inherit.

## A synthesized compaction, from a real session

Not a mock-up. `dev/hyvcc-demo.ts` runs both arms over the same real inputs: one captured
session file and the bank the real Hy-Memory writer wrote for that same session. The cut is hy's
own `compactionBoundary`, the facts are hy's own `renderMemory` with hy's own shares, and the
skeleton is pi-vcc's own `compileRanked` over the identical prefix. No model call anywhere in the
demo.

The inputs are a **copy with an identity**, not a live file. The session file the harness first
read was 44.5 MB and still being appended to by a running pi, which makes any figure taken from
it a reading of a moving target: the two arms would compare byte-identical work over a file that
had changed underneath them, and the numbers could not be re-run. So `--snapshot` freezes both
legs — the session copy, the bank copy, and a manifest naming both — and `--fixture` measures
that copy. The manifest records bytes, entry count and a content digest for each leg, because
naming only the session would leave the bank free to drift while the numbers looked pinned. The
line is the harness's own, with long byte counts grouped for reading as everywhere else in this
document:

```
copy identity  hyvcc-fixture taken 2026-10-27T07:43:09.107Z, session 01a1510e…9f8e6 44 543 004 bytes
/ 21 333 entries / sha 0fbcbdbe9a9e, bank 212 843 bytes / 293 facts (240 active, 3 user-stated)
/ sha 47ffef72e89b
```

The `session` label is that session file's uuid shortened to its first eight and last five hex
digits; nothing here is a path, a directory name or a hostname, and `tools/design-leak-check.ts`
scans every root `.md` for those shapes — byte counts, entry counts, digests and a timestamp *are*
quoted on purpose, because that is what makes a figure checkable against the copy, and they name a
copy of a private session without locating it.

Every number below is **[measured: fixture]** — that copy, that bank, and nothing else. The
harness prints this line before its first number, and prints `MOVED` if the copy it is reading no
longer matches what the manifest recorded, so a quoted figure cannot quietly outlive its input.
They describe that compaction; they are illustrative, not normative, and no claim in this document
stands on them alone. Where a claim generalizes from them, it is marked as the inference it is.
`tools/hyvcc-fixture-check.ts` pins the copy machinery against a synthetic session, so the
guarantee does not depend on this machine holding the fixture.

```
npx tsx dev/hyvcc-demo.ts --session <live file>.jsonl --bank out/halves-2026-10-21/bank.json --snapshot
npx tsx dev/hyvcc-demo.ts --fixture out/hyvcc-fixture            # repeatable; identical output every run

### The window pi would actually compact — measured

173 live messages after the session's last compaction; hy's cut keeps 32 entries / ~5 301 tokens,
so the summarized prefix is 141 entries / ~22 409 tokens. The skeleton took **11 ms**.

| part | today | proposed |
|---|---|---|
| bank facts (`renderMemory`, 8 000 cap) | 11 050 | 9 550 |
| deterministic skeleton | — | 1 268 |
| pi's `<read-files>` / `<modified-files>` | 131 | 131 |
| recall note | — | 31 |
| **summary total** | **11 182** | **10 981** |

The bank gave up **1 500 tokens = 19 fact lines** and the skeleton arrived at 1 268. With a
different bank — the one from the live lag run (`out/live-01a1510e/bank.json`: 446 facts, 172
active, taken earlier and not part of this copy) — the same trade was 10 095 → 10 076, giving up
16 lines. Its composition, and what the proposal got wrong about it:

```
[Files And Changes]            ~126 tokens     6 lines
[Commits]                       ~48 tokens     2 lines
[Tracked Commands]             ~148 tokens     7 lines
(ranked brief transcript)      ~939 tokens    47 lines   ← 74 % of the block
```

### Stratified: five windows of the same session, not just the last one

The last window is also the smallest one in the session, and one window is a weak basis for a shape.
The same harness against the *k*-th compaction in file order (`--window <k>`), same copy, same
bank. Skeletons at windows 30 and 45 ran past the 1 500-token budget, which the compiler does not
enforce — the harness reports it rather than hiding it:

| compaction | live msgs | user msgs in prefix | skeleton | section block | ranked brief | `(#N)` refs | compile |
|---|---|---|---|---|---|---|---|
| 1 | 13 363 | 80 | 1 424 | 1 167 | 257 | 7 | 184 ms |
| 15 | 11 280 | 71 | 1 366 | 1 108 | 257 | 7 | 157 ms |
| 30 | 6 385 | 38 | 1 514 | 1 046 | 467 | 15 | 102 ms |
| 45 | 2 881 | 15 | 1 765 | 1 032 | 732 | 24 | 60 ms |
| 60 (last) | 173 | 0 | 1 268 | 328 | 939 | 15 | 11 ms |

Three things follow, and they change the plan:

- **Finding 4 was position-dependent, not a property of compaction.** The user-ask sections carry
  real content early (80 user turns available in window 1) and nothing in the last window, because
  that window is small and its prefix sits inside an earlier summary. The sections are not "often
  empty"; they are empty exactly where the prefix is small — which is also where the block is
  cheapest.
- **The two halves trade places as the session ages.** The deterministic sections are 82 % of the
  block in window 1 (1 167 of 1 424) and 26 % in the last (328 of 1 268); the ranked brief is the
  mirror image. One cap over both means one of them silently eats the other at the end of a long
  session, so the cap has to be per half.
- **Every `(#N)` ref lives in the ranked brief** — 7, 7, 15, 24, 15 across the five windows, zero in
  the section block. The section block is therefore useful with no transcript corpus at all; the
  brief is a set of pointers to a corpus that would be switched off. That is the release boundary.

That is five windows. The harness was then run against **all 60 compactions of the copy**, one run
each, reports written to the gitignored `out/` and nothing stored in the repo. Four things hold
across the whole session rather than across a sample:

- The block runs past the 1 500-token budget in **21 of 60** compactions — window 30, windows 32
  through 48, and windows 50 through 52 — peaking at 1 979 tokens (window 44); 31 and 49 land just
  under. It is not an edge case in late windows only, and the compiler never enforces the number.
- The section block carries **no `(#N)` reference in any of the 60**. The release boundary
  (Release 1 needs no transcript corpus) is not a property of the last window; it holds everywhere.
- The brief's share of the block spans **18 % to 74 %**, first compaction to last.
- The kept tail is **identical at all 60** (32 entries / ~5 301 tokens) — and that is the sweep's
  construction, not a finding. Every window's scope ends at the same newest suffix of the session, so
  the sweep varied the prefix and left the tail fixed; a constant tail is what such a sweep must print.
  The one fact worth taking from it was checked directly against the copy rather than inferred from
  the reports: walking the newest entries backward stops at 5 301 because the next-older entry is
  1 160 tokens, which would put the tail at 6 461 against a 6 000 ceiling. The walk is greedy, not
  off-by-one, and a tail arrives in entry-sized steps — 6 000 delivered 5 301.

Two numbers that argue for the shipped shape rather than the harness's: the proposed arm came out
**larger** than today's in 22 of the 60 windows (10 763–12 804 tokens against 11 182–12 478),
because this harness renders the facts at the full cap and then *adds* the block. Subtracting the
block from the cap first is what makes the carve-out a carve-out, and spike D's remaining
rendered-string bound is the arm that measures it.

### What the proposed summary looks like

Excerpt from the demo's own output, `out/hyvcc-demo/proposed.md` — the run of `--fixture out/hyvcc-fixture`
(`out/` is gitignored, so regenerate it with the command above). Paths elided, pi-vcc's recall note replaced by hy's, and
the fact block cut short here exactly as it is cut short in the real thing:

```
These are the durable memories of this session, maintained continuously by the memory writer.

- Each line is one fact. Sections are ordered newest first; inside a section the later line is
  the more recent state.
- Work described as completed should not be redone unless the user asks to revisit it.
- [id] references are exact: use the recall tool with that id to read the source evidence behind a fact.

## Current state
[318edd0111fd] (isTypingTarget function) Created src-svelte/src/lib/domFocus.ts with
  isTypingTarget(el) returning true for INPUT, TEXTAREA, SELECT, or isContentEditable …
[4ef52d7af730] (clamp function) Created src-svelte/src/lib/num.ts with clamp(value, min, max) …
[0611d5c193cc] (FONT_SIZE constants SettingsModal) FONT_SIZE_MIN=6, FONT_SIZE_MAX=36,
  FONT_SIZE_DEFAULT=14; replaced Math.min(36, Math.max(6, parseInt(m ,10))) with clamp(…) …
128 more facts not shown (budget); use the recall tool to read them.

[Files And Changes]
- Modified: src-svelte/e2e/appUrl.ts
- Read: AGENTS.md, src-svelte/e2e/fixtures/auth.ts, src-svelte/e2e/helpers/appState.ts,
  src-svelte/e2e/playwright.config.ts, src-svelte/e2e/specs/Harness-connectionLifecycle.test.ts …

[Commits]
- fdc15b59: Fixture nick and channel membership become arranged state, not ambient state
- e059418b: A harness failure says whether the document was replaced, not just that it looks fresh

[Tracked Commands]
- git: git add AGENTS.md src-svelte/e2e/specs/ReadMarker-unreadBadge.test.ts … | git commit -q -F -
  <<'EOF' | git log --oneline -3 | git status --short
- npm: npm run check:e2e > /tmp/ce7.log 2>&1 | npm run lint > /tmp/lint10.log 2>&1 | …

---

[assistant]
62/62 green. Launching the full pass, and extending the AGENTS rule to cover channel
  *membership*: (#20007)
The Advisor's read is sharper than my plan: don't speculate about Vite, make the failure name
  itself. Its diagnostic matrix (document token vs. page identity vs. recorder state …) …

<read-files>
~/src/<project>/AGENTS.md
~/src/<project>/src-svelte/e2e/fixtures/auth.ts
…
</read-files>

<modified-files>
~/src/<project>/src-svelte/e2e/appUrl.ts
</modified-files>

Use `hy_recall` for a fact and the raw-session arm for anything the bank never held. Do not redo
work listed as completed.
```

Read it as the model would: the top block says what is *true*, the middle block says what was
*asked, run, committed and touched*, the bottom says what pi still holds verbatim. The commit
hashes and the `npm run check:e2e` runs are in the summary even though the 600-character
argument window never showed the writer the full commands — which is the whole point of the
proposal, and it arrived for ~11 ms and no call.

### Five things it changed

1. **A memory block is not a safe `previousSummary` for pi-vcc's merge.** Handing that merge
   hy's own 131-fact block returned **68 of 131 fact ids** in a ~7 535-token output; feeding it
   the session's real stored summary (17 803 tokens) returned **2 487 tokens**. That block is not the shape the merge was
   written for, so the honest reading is narrow: a mismatched payload is lossy. It does *not*
   show that pi-vcc cannot merge its own section-shaped skeleton across compactions — that is
   F, and spike F is the arm this document still owes. What it does justify is the cheap rule: never
   hand the merge the memory block, and keep rendering the facts from the ledger each time.
2. **The block's cost is not where the proposal guessed.** In that window the command ledger was
   148 tokens and the ranked brief transcript was **939 of 1 268** — 74 % of the block. The
   expensive part is the part whose scorer is English-and-CLI shaped (`rank.ts:45-76`), which is
   the argument for refusing the selector and building hy's own transcript from turn structure.
   Stratified over five windows of the copy, the brief's share of the block runs 18 % in
   the first compaction, 19 %, 31 %, 41 %, then **74 % in the last** — the expensive, English-and-CLI
   shaped half is exactly what a long session ends up paying for, and it is the half whose pointers
   need the transcript corpus.
3. **The compile is not capped by the number you pass it.** Asked for 1 100 tokens at the
   session's first window (13 331 prefix entries, 80 user messages), the same call emitted
   **1 424**; and against all 60 compactions of the copy the block ran past its 1 500-token budget
   in **21 of them** (window 30, windows 32–48, windows 50–52; peaking at 1 979 in window 44).
   The inference is that hy has to cap the block in tokens itself, in its own code,
   before appending it — pi-vcc's brief is line-capped and blackhole's is line-capped only.
4. **A window can have no user turns to pin — and it is position, not compaction.** The last two
   windows hold **0 user messages** in their prefix (59 and 60), so the opening-ask and recent-user
   sections were empty and their ~400 tokens went to nothing; the session's first window has 80 user
   turns available for the same sections. An empty section must hand its slice back to the facts
   rather than reserving it.
5. **A skeleton merged with itself grows rather than repeats.** Feed the compiled block back as
   `previousSummary` for a second compaction of the same content: every line reappears (55/55 in
   the realistic window) while the block swells from ~1 268 to ~2 174 tokens — 71 % growth with
   nothing new to say. An earlier reading, taken off a live session file before this copy existed,
   put it at 63 of 74 lines and ~1 593 → ~1 967, and is kept here only as the earlier number it
   replaced. Either way this is the compounding failure in "What would be worse" item 3, measured on
   the shape hy would actually store. It does not answer F, because real compactions carry different
   content, but it does say a stored skeleton needs a token cap the merge cannot ignore.

Scale and speed, for the record: replaying the copy's first window costs 184 ms over 13 331 prefix
entries; the realistic window 11 ms; no model call in either. Two things this fixture cannot tell you, and both are on
the spike: whether 19 fewer fact lines cost retention (B), and whether pi-vcc can merge its own
section-shaped skeleton across compactions without loss (F). The demo is the arm generator for
B and the starting point for F.

## What would be better

1. **Dropped ranges stop being unrecoverable.** [predicted] Today an `overflow-trim` range is
   recorded and gone. With the transcript corpus on, its entries are searchable by `#N`, path or
   keyword — when the model asks for that corpus; nothing is read silently, and the arm ships off
   until E says otherwise. So the honest form of the claim is "recoverable on request, off by
   default", not "recoverable today". Settled by: a gap-reach probe — plant facts in a range that a
   forced overflow cut trims, then measure how many the model recovers with and without the arm.
2. **Zero-cost orientation at the slowest moment.** **[measured: fixture]** The skeleton is a string
   build: ~11 ms on the copy's last window, ~184 ms replaying its first window (13 331 prefix
   entries), no model call (`dev/hyvcc-demo.ts`). hy deliberately keeps `hifiCompaction: false` because a checkpoint puts
   a call at compaction; the skeleton has the same "cannot fail" property the render has.
3. **Exact commands and commits survive the 600-char window.** [predicted] Command-family
   tracking and commit pairing preserve strings the argument clip drops today (16 % of calls).
   Settled by: extend `dev/arg-window-cost.ts` to count how many commands and commit subjects a
   skeleton carries that the chunk did not.
4. **The user's own words are in the summary even when the writer skipped them.** [predicted] 3
   opening asks + 15 recent user lines verbatim, and they are cheap (~150 tokens) next to
   ~72 tokens per bank fact. Settled by: the corpus judge, scored on constraint retention.
5. **Retrieval stops being substring overlap.** [predicted] BM25/IDF on the bank against the
   documented 93/109 miss. Settled by: replay that corpus with the new scorer; the target is a
   material drop in misses with no wrong-entry retrievals added.
6. **Named ranges stop going stale.** [measured hazard, predicted fix] `hy_flush({to})` against a
   session-global index that is fail-closed on ambiguity.
7. **The writer stops learning from boilerplate.** [measured hazard] Skill bodies fold to
   `[skill: name]`, `bashExecution` becomes a first-class line, `injected` messages stop
   counting as user-stated constraints. Settled by: replay a capture containing a skill load and
   count user-provenance facts about the skill.
8. **Compaction accounting tells the truth about who compacted.** [measured hazard] Co-installed
   compactors silently discard one another by load order; hy would count and advance coverage
   only on an entry carrying its own marker.

## What would be worse

1. **Bank facts lose a slice of the summary.** **[measured: fixture]** 1 500 tokens is 19 fact lines on a
   240-active bank, 16 on a 172-active one (`dev/hyvcc-demo.ts`). Whether that costs retention is
   B and is still open. If
   the shares are computed on the full cap by accident, constraints and foundations get
   displaced by transcript lines — the exact failure `DESIGN.md:693` exists to prevent. This is
   the highest-risk item in the proposal.
2. **Retention is model-dependent and the upstream numbers are not ours.** pi-vcc's README claims
   97.6 % median size reduction and 1 ms median, which is a *size* claim, not a retention claim.
   The independent comparison published with transparent-compact measured pi-vcc at **98 %
   weighted-fact recall on Qwen3.8-27B and 46 % on GPT-6 Luna**, with failures "mostly confident",
   while transparent-compact held 93-98 % on both
   ([arxiv.org/abs/2610.20116](https://arxiv.org/abs/2610.20116), v1, 14 Oct 2026). Two cautions travel
   with those numbers: that paper benchmarked **`@monotykamary/pi-vcc` 0.8.12**, not the `@sting8k` fork
   audited at the top of this file — its Appendix A says the two differ mainly in retrieval and that the
   results differ by version — and its author wrote transparent-compact (§5.4), with blind scoring and a
   published replication package as the counterweight.
   A deterministic brief can state a dropped thing confidently. hy's facts have ids and evidence;
   the skeleton has neither, so it must never be the only carrier of a constraint.
3. **Duplicate content and cross-compaction growth.** The brief transcript covers the dropped
   range, and the merge rolls ~120 lines of the *previous* brief forward. hy's current summary
   never repeats itself. Expect growth across compactions unless the roll-forward is capped by
   tokens, as pi-vcc's own brief is line-capped and blackhole's is **line-capped only** — no
   token bound at all (pi-blackhole `format.ts:10`, `BRIEF_MAX_LINES = 120`), which hy's window arithmetic cannot accept.
   **[measured: fixture]** The same merge, run on that session, collapsed its 17 803-token
   stored summary to 2 397 tokens and returned 60 of hy's 131 fact ids — a payload the merge was
   not written for, but enough to say the risk is loss as well as growth — and merging a skeleton
   with itself over identical content grew it 78 % (§ "A synthesized compaction", item 5).
4. **New persisted state, new failure surface.** Option (2) above adds a skeleton block to the
   ledger; a malformed or stale one changes every later summary. Today a bad compaction is
   unfixable-but-simple; with merge state it becomes stateful.
5. **Two index spaces.** `#N` message indices, hy's positional `[n]` chunk refs, and 12-hex fact
   ids. Blackhole needed a whole module (`reverse-recall.ts`) to bridge them. Every ref hy prints
   must say which space it is in.
6. **Synchronous file IO inside a tool call.** Writes are async and off the turn path; recall is
   not. Reading a large session file per call is why blackhole added LRU caches (64 MiB per
   entry, 128 MiB total, blackhole `load-messages.ts:24-43`). hy would need the same, and it is a new
   memory ceiling for an extension that currently keeps only per-session JSON state.
7. **Prompt surface grows, and one tool is how that stays small.** `hy_recall`'s description is
   two lines today (`src/index.ts:1634-1635`); a two-corpus surface with paging and drill-down
   costs roughly eight, against pi-vcc's `vcc_recall` (`tools/recall.ts:22-40` of description, `:45-73` of parameters) plus
   hy's own snippet if the tools were separate. hy already contributes a `promptSnippet` to every
   session, so this is a permanent, per-session cost either way — and it is why
   `recall.raw` ships off by default: a session that never needs the transcript arm should not pay
   for its description.
8. **Vendoring debt is real and permanent.** 190 upstream commits in five months, on a map that
   already lies about drift. A port of four small pure modules is cheaper to own than a subtree.
9. **The measurements so far are about shape, not memory.** `dev/hyvcc-demo.ts` sizes both arms
   and shows what each carries; it cannot say whether a model *answers* better with the skeleton
   on top of the facts. hy's rule is that a knob ships with a number, and the number that matters
   here is still missing.

## What we would not take

- pi-blackhole's `src/om/**`: three agent loops per cycle (`agentMaxTurns 16`, ≤10 attempts per
  stage, per-model cooldowns default 1 h), `consolidation.ts` (3 136 lines), and a
  `AgentSession.prototype` patch for mid-run compaction (`pi-blackhole/src/om/inline-compaction.ts:753-757`) that
  changes host behavior for every other extension. Plus `Symbol.for` registries and 21 event
  registrations.
- `{cancel: true}` as a deferral device — it short-circuits the runner and would swallow a
  co-installed extension's result. hy hands work back with `undefined`.
- `src/pi-base/**` (~10 k lines of settings modal) and the changelog viewer.
- Cross-session corpus + markdown export (`src/project-recall/*`, dedup by Levenshtein and
  Sørensen-Dice). Worth revisiting later for hy's bank mirror; not part of this.
- `[Outstanding Context]` / `[User Preferences]` regex extractors, and pi-vcc's `smartKeepTail`
  (5 000 → 25 000 tokens by user-turn count), which is a substitute for memory, not an addition
  to it.

## The spikes: what decides release 1, in the order that decides it

Every pass condition is stated in the units the harness already prints, and is fixed before the run
is executed. A tolerance someone can re-read after the fact is not a gate.

| # | question | harness | pass condition | gates release 1 |
|---|---|---|---|---|
| A | is the section block worth its tokens, at each position in a long session? | `--window <k>` over the fixture session's 60 compactions; per window, count skeleton lines whose content is absent from (i) the kept tail below it and (ii) the fact lines the carve-out displaced | net-new content above a stated threshold in at least half the windows, and worst-case size inside `skeletonMaxTokens` **after hy's own cap**, at branch scale | yes |
| B | what does the carve-out cost in fact retention, in the units the claim is made in? | corpus A/B on the existing judge (`dev/judge.ts`, `dev/rubric.md`) with the two arms from `dev/hyvcc-demo.ts`, plus `tools/budget-check.ts`, `dev/constraint-slice-report.ts`; metric fixed first: score-weighted mass of the active bank that survives, judged answer quality on the same corpus | judged quality within a stated margin — **the margin itself is still unnamed**, and naming it is this spike's first job — constraint slice keeps its share of the remainder. Note the fixture's own line-count cost — 19 of 240 active lines (**7.9 %**) for 1 500 tokens, 8–9 for release 1 — so a "≤ 2 %" claim is only coherent as a *mass* claim, and must say so | yes |
| C | is the retrieval miss real, and does BM25 beat what hy has? | re-run the 109-draft removal corpus against `tools/recall-reach-check.ts` **before porting anything**; then a gold query set over the real 293-fact bank, recall@k against the current substring scorer | the documented 93/109 reproduces on hy's bank — if it does not, this spike's premise is gone — then misses fall materially with zero new wrong-target retrievals | yes |
| D | is the budget split honest, and is recompute-only stable across a real session? | **built, except the rendered-string bound**: the `boundaryFor` arithmetic now lives in `src/budget.ts` (`budgetSplit`, `dropRange`, `estimateDigestTokens`, `resolveBudget`) and `tools/budget-split-check.ts` table-tests it — windows {16k, 24k, 32k, 48k, 64k, 168k} × overhead {2 000, 0.3 × window}, the `underprovisioned` boundary at rooms 1 499 / 1 500 / 1 501, the degenerate rows (overhead ≥ window, no window reported), and the probe loop settling. The fixture sweep is done: the harness ran against all 60 compactions of the copy (reports under the gitignored `out/hyvcc-sweep/all/<k>`, nothing stored in the repo), and three things came out of it — the block passed its 1 500-token budget in **21 of 60** windows (30, 32–48, 50–52), the section block carried **zero `(#N)` refs in every one of the 60**, and the kept tail came out *identical* at all 60 (32 entries / ~5 301 tokens) — the sweep's construction rather than a finding, since every window's scope ends at the same newest suffix | asserts hold at every combination: `digest + summary + tail ≤ available` with `digest ≤ min(overflowDigestTokens, ⌊available / 4⌋, priced)`, `facts ≥ floor`, no negative budget anywhere, the tail held at `COMPACT_KEEP_MIN_TOKENS` in every room that can pay it and the note never below 500 or above `summaryMaxTokens`; summary bounded at every compaction *measured on the rendered string, label prefix included* — see the note-cost bullet above; no monotone growth, section presence stable. The tail's floor is `COMPACT_KEEP_MIN_TOKENS` and is pinned, and the sweep ran across all 60 compactions of the copy, so what is left of this spike is the rendered-string bound, plus one assertion to write when the shipped subtraction exists: tail maximality — tail tokens ≤ `keepRecentTokens` and adding the next-older entry would exceed it, which catches an off-by-one in the walk, unlike the constant tail the sweep prints | yes |
| E | is the transcript corpus bounded? | three separate probes, not one gate: gap-reach with an IO counter; cache invalidation against a session file being appended to; the repeated-query echo test | each named condition passes on its own: ≥ 80 % recovery of planted facts in a trimmed range, zero file reads for a bank-answerable query, same hit count on three identical queries | **no** — release 2 |
| F | can pi-vcc's merge carry a skeleton across compactions? | the existing self-merge arm of `dev/hyvcc-demo.ts`, plus a previous-summary replay | neither grows past the cap nor drops lines the previous window earned; otherwise recompute wins by measurement | **no** — deferred past release 1 |
| I | what do the ingest fixes change in the bank? | replay a capture containing a skill load and `!`-shell runs | no user-provenance facts about skill text; commands appear; pending-window accounting stops undercounting | independent of the summary shape |

The spike letters are non-contiguous on purpose and there is no spike G or H. They also have nothing to
do with the `G1`-`G7` decision gates below, which reuse the letter for a different thing: reading a gate
as the result of a spike of the same name is a mistake this table invites.

If A or B fails, release 1 is off by default and the proposal collapses to the ingest fixes plus
bank scoring — both independently worth it, both independent of the summary shape. The 93/109 figure
is a premise inherited from `DESIGN.md`, not a measurement made here; C is what turns it into one.

## Decision gates

- **G1** Do the ownership fix now, independent of everything else? (Smallest, protects every
  later measurement.)
- **G2** Do the ingest fixes as their own change, without touching the summary shape?
- **G3** Recall scope: bank scoring alone (ships first, with the bank-only schema), or the
  transcript corpus too? The tool *shape* is decided in this document — one `hy_recall`, corpus
  chosen by the argument you pass, `corpus` defaulting to `bank`, no silent file read on a bank
  miss, every line labelled with its namespace — so G3 is only whether E earns the file-reading
  half, which brings the LRU cache, its invalidation, and the self-exclusion discipline with it.
- **G4** Skeleton: release 1 as specified (section block, no refs), or the full block including the
  ranked brief, or replace the overflow digest with it, or not at all? The ranked brief on its own
  is not an option — it prints `#N` refs into a corpus that would be off.
- **G5** Vendoring: file-copy the pure modules with headers and a drift check, or port them by hand
  — release 1 needs `normalize`, `user-messages`, `tracked-commands`, `commits` plus hy's own
  `skill-collapse`, `sanitize` and the BM25 scorer (~540 upstream lines); release 2 adds the brief
  format and its ranked selection (~430 more, the drift-prone part).
- **G6** Merge state: recompute-only arm first (recommended, with F as the measurement that
  could make the merge arm worth its added state), or ledger-persisted skeleton?
- **G7** Compactions that cannot work: when `available` leaves a 500-token summary that still misses
  pi's threshold, does hy decline and record the reason, or emit it anyway as today? Independent of
  the skeleton, and it is the only place in the tail path where hy has an option rather than an
  arithmetic.

## If this is built, the doc-side obligations

`README.md`'s settings table gains `skeletonMaxTokens`, `briefMaxTokens` and `recall.raw` (whatever
called) — `tools/config-docs-check.ts` fails on a key or a default that disagrees, so both must be
in the table the moment they exist in `SETTING_DEFAULTS` — and the `hy_recall` row of the Commands
section has to describe both corpora and carry the call examples above once the transcript corpus is
on. The Layout table gains any new `src/` files — `src/budget.ts` is listed there now, and the checks table gained `budget-split-check`. No settings row was needed: the reverted variant added no key, and nothing in the shipped split is one. The near miss is worth recording anyway — the split briefly shipped with an input no default defined, which is the one thing `tools/config-docs-check.ts` cannot see; the
intro doc list gains this file with its status; `DESIGN.md` gains a pointer from
"Compaction: who decides when" to whatever survives the spike. No private infrastructure in the
diff, per [`AGENTS.md`](AGENTS.md).
