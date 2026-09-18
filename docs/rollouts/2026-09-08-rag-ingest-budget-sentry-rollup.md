# 2026-09-08 - rag-ingest-budget-sentry-rollup

## Context & Objective

Board `c630ceed` (F04, fleet-infra P1 discovery). Sentry cluster: `SOCRATIC-TRADE-27`
(9,502 events, first seen 2026-08-18, last seen 2026-09-07) and `SOCRATIC-TRADE-2E` (34
events, first seen 2026-09-07, assigned to Jay, still `new`). Discovery's brief was written
from the Sentry event-count API, not from reading `vector-db.ts` — it described the "fires on
every throttled batch" condition as still-open. It is not: PR #3187 (merged 2026-09-07)
already added `shouldEmitRagIngestBudgetSentry`, a cooldown gate on the exact `captureMessage`
call, plus a stable `rag-ingest-budget` fingerprint lane (the reason `-2E` exists as a
*separate* group from `-27` — the fingerprint changed, not the underlying condition). `-27`'s
last event is 2026-09-07, i.e. it went quiet the moment the fix landed. `-2E` is the same
condition continuing under the new, already-throttled code path.

Two real gaps remained, both closed here:

1. The cooldown was 30 minutes, not "once per budget window." `RAG_INGEST_MAX_TEXTS_PER_DAY`
   is a rolling-24h cap; a 30-minute gate still pages up to ~48x/day for as long as a backfill
   keeps the budget pinned at zero (matches `-2E`'s 34 events over ~30h). The sibling Pinecone
   write-unit budget warning in the same file (`shouldEmitPineconeWuBudgetSentry`) already uses
   a 6h cooldown, as does the generic `usage-limit-alerts.ts` default — this raises the ingest
   one to match, for one convention across the RAG lane's budget/quota warnings.
2. The only test that landed with PR #3187
   (`test/rag-ingest-budget-sentry-cooldown.test.ts`) covers just the fail-soft
   cooldown-persistence-error edge case. Nothing asserted the rollup behavior itself: repeat
   suppression inside the window, the count/remaining-budget fields riding on the one event
   that does escape, the per-batch structured audit line staying unthrottled, or resumption
   once the window elapses.

`RAG_INGEST_MAX_TEXTS_PER_DAY` itself (default 20,000) is untouched. `.env.example:434-436`
already documents it as an operator-tunable pacing/cost knob ("Safe backup/default is
20000... Raised to 200000 in Infisical during active 1k-stock backfill; shift back to 20k
post-backfill") — this is a deliberate cost guard with a documented raise/lower procedure, not
an arbitrary number, so per the task brief it is left alone. If `-2E` keeps recurring at the
new (lower) rate, that is a signal an active backfill's Infisical override was not raised per
that existing procedure — an ops action, not a code defect.

## Changes Made

- `src/lib/vector-db.ts`: `RAG_INGEST_BUDGET_ALERT_COOLDOWN_MS` raised from 30 minutes to 6
  hours (`6 * 60 * 60 * 1000`), matching `PINECONE_WU_BUDGET_SENTRY_COOLDOWN_MS` in the same
  file. Comments on both the constant and `shouldEmitRagIngestBudgetSentry` updated to record
  why (consistency + `-2E`'s continued volume under the old 30-minute value) and to point at
  the unconditional `audit("vector_ingest_budget", ...)` call in `storeContextsImpl` as the
  per-batch structured-log line that this cooldown does not gate.
- `test/rag-ingest-budget-sentry-rollup.test.ts` (new): four tests exercising the rollup
  behavior the existing cooldown test does not cover — repeat-call suppression inside the
  window, the skip-count/remaining-budget fields on the one Sentry event that fires, the
  per-batch audit row staying unthrottled (checked directly against `audit_events` in the
  test's temp SQLite DB) alongside the throttled Sentry capture, and resumption once the
  cooldown marker is rewound past the window.

No change to `RAG_INGEST_MAX_TEXTS_PER_DAY`, `RAG_INGEST_BUDGET_ENABLED`, or any trading logic.

## Decisions & Trade-offs

- Chose to raise the existing cooldown constant rather than introduce a new
  `RAG_INGEST_BUDGET_ALERT_COOLDOWN_MS` env override. The sibling Pinecone budget cooldown is
  also a hardcoded constant, not env-configurable — matching that precedent keeps one pattern
  for this class of warning instead of two.
- New tests use `userId: "local"` throughout (not a random per-test id), matching the actual
  production condition (`rag.key_source: "operator"` in the Sentry payload). A non-`"local"`
  userId routes `storeContexts` through the private-scope / per-user-write-claim path
  (`effectiveStoreScope`), a materially different code path this bug does not live on.
  Cross-test isolation instead comes from a fresh temp SQLite file per test (`beforeEach` sets
  a unique `DATABASE_URL` before each dynamic import), so the rolling-24h usage counter and the
  cooldown marker never leak between tests.
- The "resumes after the window elapses" test rewinds the persisted cooldown marker
  (`setInternalSetting("vectorStore:ingestBudgetAlert:local", <7h-ago ISO>)`) instead of using
  fake timers, since `shouldEmitRagIngestBudgetSentry` takes `Date.now()` internally at the
  call site (no injectable clock) and better-sqlite3's synchronous calls make fake-timer
  interaction with the rest of `storeContexts` (Voyage/Pinecone mocks, internal delays) riskier
  to get right than simulating the effect directly.

## Verification State

- `npx tsc --noEmit`: <fill in after run>
- `npm run lint`: <fill in after run>
- `npm test`: <fill in after run>
- `npm run build`: <fill in after run>

## Next Steps & Blockers

- None outstanding for this change. Once merged, `SOCRATIC-TRADE-27` and `SOCRATIC-TRADE-2E`
  can be resolved in Sentry as the same fixed condition (`-27` already stopped on its own after
  #3187; `-2E` should drop to at most ~4 events/day under the new 6h cooldown for as long as an
  active backfill keeps the daily budget pinned at zero, and stop entirely once it isn't).
- If `-2E` (or its successor fingerprint) keeps firing at a materially higher-than-expected
  rate after this lands, check whether an active backfill's `RAG_INGEST_MAX_TEXTS_PER_DAY`
  Infisical override was raised to 200k per the existing `.env.example` procedure and left
  raised for the backfill's duration — that is the documented lever, not a further code change
  here.
