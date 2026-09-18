# Public trading-liveness reports the CAUSE, not just the count (board 64413d84)

## Context & Objective

Board row `64413d84` ("Prod tradingLiveness degraded, oldest completed run age ~3 days") has been
open since 2026-08-23.  The original report — `degraded: 1` with
`oldestCompletedRunAgeSeconds` ~262000 and `marketOpen: false` — asked one question: is this a hung
strategy, a failing gather, or just weekend silence?

The session-calendar half is already fixed on `main`: staleness only degrades while the market is
open (`src/lib/trading-liveness.ts`, `marketOpen &&` guard).  FX's 2026-09-12 note on the row
identified the remaining gap precisely: the degradation that survives that guard is
`consecutive_failures`, but the PUBLIC `/api/health` aggregate omits `consecutiveFailedRuns` and
`degradedReasons`, so a JSON-path monitor can see THAT an account is degraded and never WHY.  That
is what this change closes.

## Changes Made

`PublicTradingLiveness` gains two identity-free cause fields, so an alert can route on the cause
instead of re-deriving it from the age number and the clock:

- `maxConsecutiveFailedRuns: number` — the worst streak across active-autonomy accounts.  The
  per-account value already existed internally; only the public projection dropped it.
- `degradedReasons: Array<"stale_last_completed_run" | "consecutive_failures">` — the distinct
  union of reasons from the accounts that are actually degraded.

Files:

- `src/lib/trading-liveness.ts` — both fields on the interface, the null-summary branch, and the
  real projection in `toPublicTradingLiveness`.
- `test/trading-liveness.test.ts` — the public-shape guard now expects the two new keys and
  asserts their types and the fixed reason vocabulary.

## Decisions & Trade-offs

- **A max, not a per-account list.**  The public object's existing contract is "counts + ages +
  market state, never user/account identity".  A per-account array would leak account cardinality
  and ordering, so the streak is collapsed to a single max.  The authed ops snapshot still carries
  per-account detail.
- **Reasons come only from degraded accounts.**  A healthy account contributes nothing, so an empty
  `degradedReasons` always means "nothing is degraded right now" and never "we did not look".
- **The existing privacy assertions were left alone.**  The shape test still asserts the exact key
  set and still greps the serialized object for `accountId` / `userId` / label.  Only the expected
  key set grew; no leakage assertion was weakened.
- Scope is the public projection only — no change to when an account becomes degraded, so no alert
  starts or stops firing because of this.

## Verification State

- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` — no errors in
  `src/lib/trading-liveness.ts` (remaining output in this worktree is missing `@types` from a
  borrowed `node_modules`; the hosted `verify` gate does a real install).
- `node node_modules/vitest/vitest.mjs run test/trading-liveness.test.ts --testTimeout=20000` —
  9/9 passed.

## Next Steps & Blockers

- After merge, confirm `/api/health` carries `tradingLiveness.maxConsecutiveFailedRuns` and
  `tradingLiveness.degradedReasons`, then point the liveness monitor at `degradedReasons` so a
  weekend-silence page and a failing-autopilot page stop looking identical.
- Live at the time of writing: `degraded: 1`, `oldestCompletedRunAgeSeconds` 234421 (~65h),
  `marketOpen: false` — exactly the ambiguous shape this change disambiguates.

## Zero-Code Findings

None beyond the above; the session-calendar fix FX described was verified present on `main` rather
than re-implemented.
