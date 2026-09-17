# Post-claim synthetic-stop fire writes after #3383 pin

## Context & Objective

#3383 is live (`2fc699c328`).  Serving-process `busy_timeout` is now `SQLITE_BUSY_PIN_MS` (100).  Async safety-lane writers keep the 60s lock budget only when they go through `sqliteYieldRetry`.  The fire path wrapped `claimSyntheticStop()` but left `recordSyntheticStopAttempt`, `insertFillEvent`, `upsertSyntheticStop` (post-place), and `revertSyntheticStopClaim` unwrapped.  `recordSyntheticStopAttempt` also sat outside the place try/catch.

Concrete trigger: Litestream or another writer holds the SQLite write lock while a stop actually fires.  `claim()` yield-retries and succeeds (`active` → `triggered`).  The next unwrapped UPDATE hits SQLITE_BUSY after 100ms and throws.  The monitor unwinds without revert.  The row stays `triggered` with `last_attempt_ref_id` NULL, so the fire loop skips it and the 15-min re-arm grace leaves the position naked.

## Changes Made

- `src/lib/synthetic-stops.ts` — move generation/refId/record inside the place try; wrap each post-claim sqlite write in its own `sqliteYieldRetry` (insertFillEvent is not idempotent).
- `test/synthetic-stops.test.ts` — SQLITE_BUSY on record retries and still places; a non-busy record throw reverts the claim.

## Decisions & Trade-offs

- Do not wrap `insertFillEvent` and `upsertSyntheticStop` in one retry envelope.  A successful insert plus a busy upsert would insert a second fill on retry.
- Revert-on-any-throw after a successful place+insert is existing behavior.  This PR only gives those writes the 60s yielded budget.
- Extra-ship no.  No Coolify Deploy.

## Verification State

- `node node_modules/vitest/vitest.mjs run test/synthetic-stops.test.ts --testTimeout=20000` — 77/77 passed.

## Next Steps & Blockers

- Hosted `verify` must go green before merge.
- Do not Coolify Deploy from this lane.
