# 2026-09-09 — FTS mirror never converged, pinning the event loop into a public 503

## 1. Context & Objective

Socratic-Trade served a public 503 window on 2026-09-09: the container healthcheck
(`curl /api/live`, 5s timeout, 3 retries) kept timing out, Docker marked a **healthy**
container `unhealthy` (`FailingStreak: 5`), and Traefik pulled it out of rotation.  The
objective was to find and remove the actual cause of the periodic ~8s event-loop stalls,
not to widen a timeout — the timeout mitigation shipped separately in PR #3201.

## 2. Changes Made

### High-level

The bounded FTS mirror resumed from `countDocumentChunkFts()` — a `COUNT(*)` of
`document_chunks_fts_index` — and used that count as a **positional offset into the chunk
array**.  Those numbers are equal only when every chunk in a document has a distinct
`content_hash`.  The side-index PK is `(content_hash, symbol, source, accession)`, so
byte-identical chunks inside one filing (repeated table headers, boilerplate, empty
sections) collapse onto **one** row.  From the first duplicate the count trails the position
permanently, the offset can never advance, and the same slice is re-mirrored on every ingest
tick forever.  `better-sqlite3` is fully synchronous, so every pass holds the serving loop.

The mirror now resumes on **content**: the offset is the first row whose `content_hash` is
not yet mirrored for that occurrence.  Progress is provably monotonic — mirroring a row
indexes its hash, so the next resume is strictly greater — therefore the loop always
terminates.  A side-index key alone is **not** accepted as proof of mirroring: each key is
JOINed to its live FTS row and kept only when `fts_rowid` still owns all four identity
columns, so a stale key cannot mask absent content.

A second defect on the same path: `countDocumentChunkFts` filters on
`(symbol, source, accession)` while the only index leads with `content_hash`, so the
occurrence lookup could not seek and ran a full covering-index `SCAN`.

### Files touched

- `src/lib/db-learning.ts` — new `ftsMirrorResumeOffset()` (content-derived, ownership-validated resume offset).
- `src/lib/db.ts` — migration **88**, `idx_document_chunks_fts_index_occurrence ON document_chunks_fts_index (symbol, source, accession)`.
- `src/lib/rag/mirror-fts-bounded.ts` — resume via `ftsMirrorResumeOffset` instead of `countDocumentChunkFts`.
- `src/lib/rag/sec-ingest-worker.ts` — same swap for the inline slice loop that emits `[worker] ftsMirrorSlice took …`.
- `test/fts-mirror-convergence.test.ts` — **new**, 6 tests (convergence + stale-key ownership).
- `test/persistence-hardening.test.ts` — schema-version pins bumped 87 → 88.
- `docs/rollouts/2026-09-09-fts-mirror-nonconvergence.md` — **new**, this note.
- `docs/designs/2026-08-16-proposer-corpus-storage.md` — item 11 completeness contract corrected.
- `docs/phase-9-web-sources.md` — records the durable FTS completion invariant.
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md` — handoff records.

### Production evidence

`[worker] ftsMirrorSlice took Nms for <doc> (<start>-><end>/<total>)`, six days of logs:

| Document | Chunks | Resume offset, **every** slice | Slices |
|---|---|---|---|
| `hsy-20260329.htm` | 508 | **400** (one pinned **36,511 ms**) | 29 |
| `hsy-20251231.htm` | 1291 | **732** | 6 |
| `abnb-20260630.htm` | 448 | **355** | 42 |
| `dash-20250630.htm` | — | **358** | 58 |

Read back read-only from production `app.db`, `countDocumentChunkFts` returns exactly `400`,
`732` and `355` for those occurrences — matching the log to the row.  Because
`mirror.complete` never became true, `insertIngestedAccession` never ran and the worker
re-queued the same filings indefinitely, which is also the source of the 3,128 `Ingestion
budget or capacity exceeded mid-task` lines.

| Day | Slices | Total pinned | Max pin |
|---|---|---|---|
| 09-04 | 21 | 121,246 ms | 32,791 ms |
| 09-05 | 35 | 202,002 ms | 22,518 ms |
| 09-06 | 43 | 338,843 ms | 32,695 ms |
| 09-07 | 56 | 239,114 ms | 36,511 ms |
| **09-08** | **198** | **1,317,546 ms (22 min)** | 32,196 ms |

## 3. Decisions & Trade-offs

- **Regression by accumulation, not by commit.**  No single PR introduced this.  Every
  document that hits a duplicate chunk joins a set retried forever and never leaves it, so
  the daily cost grows monotonically.  09-08 is where it crossed the 5s healthcheck budget
  often enough to trip `FailingStreak: 5`.  PR #3192 was investigated and cleared.
- **Ownership validation is paid for deliberately.**  Validating each side-index key against
  its live FTS row costs ~2.3 ms per document versus trusting the key blindly (3.04 ms vs
  0.74 ms at production scale).  That is accepted: a stale key is an explicitly supported
  state (`ftsRowidStillOwnsOccurrence`, `src/lib/db-learning.ts:1626-1629` — FTS5 reuses the
  max rowid after a DELETE, so an unpaired wipe of `document_chunks_fts` leaves keys pointing
  at nothing or at a later filing's chunk).  Trusting one would skip a chunk whose text is
  genuinely absent and still report `complete`, letting the caller ledger the accession with
  missing content — the same failure class this change exists to remove.  Raised as a P2 by
  `chatgpt-codex-connector` on PR #3202 and fixed rather than waved through.
- **No timeout widened.**  That mitigation is PR #3201's scope, deliberately kept separate.
- **No trading logic touched.**
- **Edge case deliberately left open:** a single oversized FTS5 row can still pin the loop
  for its own tokenisation cost.  The adaptive batch sizer already floors at one row, so this
  is irreducible inside a synchronous FTS insert.  See Next Steps.
- **Divergence from a design doc:** `docs/designs/2026-08-16-proposer-corpus-storage.md`
  item 11 required "FTS counts match `chunk_count` / `chunks.json`".  This change establishes
  that duplicate hashes make row counts legitimately diverge from positional chunk counts, so
  that contract is corrected in the same commit rather than left to misdirect later
  corpus-prune and completeness work.

## 4. Verification State

Commands actually run in this lane (`~/apps/trading-claude-eventloop`), with results:

```bash
npm run lint
#   -> exit 0.  809 problems (0 errors, 809 warnings).  The `verify` CI step fails on
#      errors only, and the warnings are pre-existing repo-wide `no-explicit-any`.

npx tsc --noEmit
#   -> exit 0.  0 errors.

node node_modules/vitest/vitest.mjs run \
  test/fts-mirror-convergence.test.ts test/sec-ingest-worker.test.ts \
  test/hydrate-accession.test.ts test/corpus-wide-lexical.test.ts \
  test/sec-filings.test.ts test/persistence-hardening.test.ts \
  test/db-migration-old-schema.test.ts test/db-migration-busy.test.ts
#   -> exit 0.  Test Files 8 passed (8).  Tests 134 passed (134).
```

Negative control — the new stale-key tests were re-run with the ownership JOIN temporarily
reverted to confirm they have teeth:

```
Tests  2 failed | 4 passed (6)
  × does not treat a stale index key as mirrored content ([A, A, B] case)
  × re-mirrors the orphaned content and only then reports complete
```

**Current build status: `npm run build` was NOT run locally, and neither was the full
`npm test`.**  This is a real limitation, not an oversight.  `npm ci` never completed in this
lane; `node_modules` was reused by symlink from a lockfile-identical lane
(`~/apps/trading-claude-sentry-getjson-soft-failures`) purely so the focused suites and the
benchmark could run.  A Next.js build against cross-lane dependencies would not be a
trustworthy signal, so it was not attempted and no build claim is made here.  **The hosted
`verify-hosted` check on PR #3202 is the authoritative full gate** (lint, tsc, full vitest,
build); treat this note's local results as a subset, not as the gate.

`vitest` invoked directly via `node node_modules/vitest/vitest.mjs` rather than `npm test`
because the reused `node_modules` has no populated `.bin` directory.

### Measurement

Resume query at production scale (689,047 side-index rows + a matching FTS5 table),
reproducing the production query plan exactly:

| | Plan | Median | Max |
|---|---|---|---|
| Before | `SCAN document_chunks_fts_index USING COVERING INDEX` | 105.26 ms | 166.56 ms |
| After | `SEARCH … USING idx_document_chunks_fts_index_occurrence` + rowid JOIN | **3.04 ms** | 5.23 ms |

**34.6x** less blocked event loop per document per tick.  The "before" figure reproduces the
78-105 ms measured read-only against production.  Independently of that constant factor, the
non-convergent retry loop behind 198 slices and 22 minutes of pinning on 09-08 is eliminated
outright, which is the larger win.

## 5. Next Steps & Blockers

**Next steps**

1. **Confirm the fix in production after deploy.**  Re-run the 90-sample `/api/live` timing
   loop from the host and confirm no sample exceeds the 5s healthcheck budget.  A real
   before/after could not be taken pre-merge because merging is what deploys.
   Before (measured 2026-09-09 14:15-14:19 UTC): `14.35s, 30.00s, 22.35s, 30.00s, 16.63s`.
2. **Watch `[worker] ftsMirrorSlice took …` for convergence.**  The stuck documents
   (`hsy-20260329`, `hsy-20251231`, `abnb-20260630`, `dash-20250630`) must now advance past
   their pinned offsets and stop reappearing.  If a document still restarts at a fixed
   offset, the fix is incomplete.
3. **Expect `ingested_accessions` to gain the backlog.**  Filings that could never reach
   `mirror.complete` should now ledger, and the 3,128 `Ingestion budget or capacity exceeded
   mid-task` lines should fall.
4. **Follow-up, not in this PR:** move the FTS mirror onto a worker thread with its own
   SQLite connection.  A single oversized row can still pin the loop for its tokenisation
   cost; the batch sizer already floors at one row, so that residual is irreducible in-process.

**Blockers**

- None in the code.  PR #3202 gates on hosted `verify-hosted` plus review-thread resolution.
- Merging auto-deploys production, so step 1 cannot run until the merge lands.

## 6. Zero-Code Findings

Ruled out **with measurement**, so a later incident does not re-derive them:

- **`storeContexts` content-hash dedup** (`870/870 document(s) already indexed`) — the
  original leading suspect.  Refuted: `SELECT content_hash FROM document_chunks WHERE
  content_hash IN (870 placeholders)` resolves via `SEARCH … USING COVERING INDEX
  sqlite_autoindex_document_chunks_1` in **2-4 ms** on production.  The line marks that a
  call happened; it is not a cost.
- **PR #3192 (R2 cold snapshot, merged 09-08 12:03).**  `reportR2WeeklyFreshness()` is a
  single internal-setting read on an unchanged tick, and `VACUUM INTO` already runs in a
  child process.  The `r2-cold-snapshot` lane journals 13 ms average / 1,254 ms max.
- **A heavy `/api/health`.**  Re-measured live at **45 ms**; the 8.41s reading was the
  blocked loop, not the endpoint.
- **SQLite lock contention** (`database is locked`, 377 events over 5.4 days).  Refuted three
  ways: **zero** such events during the measured 14:03-14:19 stall burst; anti-correlated with
  the damage (09-07 had *more* lock events, 150 vs 105, while 09-08 had 5.5x the pinning); and
  SQLite's busy handler **sleeps**, so a lock wait shows low CPU — contradicting the measured
  107% CPU with host disk `%util 0.10`.  `src/lib/db.ts` also documents that the WAL
  snapshot-upgrade path returns an *instant* `SQLITE_BUSY` that `busy_timeout` never applies
  to, so these cost ~0 ms each rather than 60 s parks.  Real, but a separate ingest-retry issue.
- **Corroboration.**  The broker-timeout lane (PR #3203) independently confirmed this root
  cause: a `synthetic-stop-monitor` ran 196,840 ms and then **succeeded**, 182 s after its 15 s
  deadline had already blamed the broker — the broker answered, the loop could not process it.
  That PR adds stall attribution only; this PR is the remediation for both lanes.
