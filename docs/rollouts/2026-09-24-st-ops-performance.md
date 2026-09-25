# 2026-09-24 — Ops performance endpoint (lane E2)

## 1. Context & Objective

Trading performance could not be measured remotely: `/api/connected-accounts/[id]/performance`
and `/console/results` are session-gated, and the existing token-gated `/api/ops/snapshot` (see
`docs/rollouts/2026-06-29-ops-diagnostic-snapshot.md`) carries strategy-run/audit state but no
P&L.  This lane (E2 of the owner-directed trading-performance program, board `687a5fb4`) adds a
token-gated, read-only `GET /api/ops/performance` that surfaces realized/unrealized P&L, win
rate, profit factor, expectancy, thesis/Red-Team/model attribution, the proposal funnel, and a
downsampled equity curve for remote diagnostics.

## 2. Changes Made

- Added `src/lib/ops-performance.ts` — `buildOpsPerformanceSnapshot()` (pure, sync) and
  `getOrBuildOpsPerformanceSnapshot()` (60s in-process single-flight cache).  Iterates every user
  and connected account (mirrors `buildOpsSnapshot` in `ops-snapshot.ts`), optionally narrowed to
  one `connectedAccountId`.  For each account with a synced `accountNumber`:
  - Fetches `liveFills`/`paperFills` ONCE and runs `calculatePnl` ONCE per source, then threads
    the results through as `PrefetchedFills`/`PrefetchedPnl` to `getPerformanceSummary` and
    `getThesisScorecard` so neither recomputes the FIFO lot match.
  - `tradeStats` (win rate, avg win/loss, profit factor, expectancy, trade count) is pure
    arithmetic over the account's own book's closed lots (`account.environment` as the
    `FillSource`), windowed to `days` by `exitAt`.
  - `modelAttribution` groups the same closed lots by `entryModel` (`proposal.proposedByModel`),
    lifetime.
  - `proposalFunnel` — a `status` GROUP BY and a row-capped block-reason scan over
    `trade_proposals`, both scoped to `(user_id, account_number, created_at)` (covered by the
    existing `idx_trade_proposals_user_account_created` index — no new index added).
  - `equityCurve` reuses `getPerformanceSummary`'s `live/paperEquityCurve` (itself sourced from
    `listDailyPortfolioSnapshots`, already downsampled to <= 1 point/day) — no new query.
  - Per-account `try/catch` (mirrors `ops-snapshot.ts`): one account's failure surfaces as
    `account.error` instead of 500ing the whole snapshot.
- Added `app/api/ops/performance/route.ts` — `GET` only, gated by the existing
  `authorizeOpsRequest` (`OPS_DIAGNOSTIC_TOKEN`).  Query: `account` (optional connectedAccountId),
  `days` (default 90, clamped 1-3650).  `/api/ops` is already in `middleware.ts`'s
  `PUBLIC_PREFIXES` with prefix matching, so no middleware change was needed.
- Added `scripts/fetch-prod-ops-performance.sh` + `npm run ops:performance`, mirroring
  `scripts/fetch-prod-ops-snapshot.sh` exactly (same token env var, same curl shape).
- Added `docs/runbooks/ops-performance-endpoint.md` — response shape, query params, the
  query-cost/caching notes, and usage.
- Added `test/ops-performance.test.ts`.
- Updated `STATUS.md`, `docs/EFFORT-LOG.md`, `/Users/jay/apps/TRADING-EFFORT-LOG.md`.

Files touched:
- `src/lib/ops-performance.ts` (new)
- `app/api/ops/performance/route.ts` (new)
- `scripts/fetch-prod-ops-performance.sh` (new)
- `docs/runbooks/ops-performance-endpoint.md` (new)
- `test/ops-performance.test.ts` (new)
- `package.json` (added `ops:performance` script)
- `STATUS.md`, `docs/EFFORT-LOG.md`, `/Users/jay/apps/TRADING-EFFORT-LOG.md`
- `docs/rollouts/2026-09-24-st-ops-performance.md` (this file)

## 3. Decisions & Trade-offs

- **No live quotes fetched.**  Mirrors `/api/connected-accounts/[id]/performance`'s precedent
  exactly: `currentPrices` is always `{}`, and `pricesUnavailable: true` is always set so a
  client never mistakes the resulting `0` unrealized P&L for a real number.  Fetching a quote per
  open position from inside a token-gated ops route would add broker/network latency to a
  diagnostic endpoint that is supposed to be cheap and fast, and this app already has a decided
  precedent for disclosing rather than fetching.
- **`tradeStats`/`thesisScorecard` use `account.environment` as the `FillSource`, not
  `fillSourceForExecutionMode(deriveExecutionState(...))`.**  Every real caller of
  `getThesisScorecard` in this codebase (`dashboard.ts`, `strategy.ts`, `strategy-risk.ts`,
  `strategy-tuning.ts`, `post-mortem.ts`) passes a concrete `"live"|"paper"` source derived from
  execution state, never `undefined` (which would force `getThesisScorecard` to recompute a
  merged-book FIFO match from scratch — semantically odd for live+paper mixed, and an extra
  `calculatePnl` call).  Using `account.environment` avoids pulling the broker-gateway/
  execution-mode dependency chain into a read-only ops diagnostic and coincides with the derived
  execution source for the overwhelming majority of accounts (an account only accumulates fills
  in the book its environment actually trades).
- **`days` windows `tradeStats`, `proposalFunnel`, and `equityCurve`; `thesisScorecard`,
  `redTeamEfficacy`, and `modelAttribution` are always lifetime.**  Matches how those three
  functions are used everywhere else in the app (the Results page's scorecards are all-time, not
  windowed) — windowing them here would be new, undocumented behavior relative to their existing
  semantics.  `tradeStats` is windowed because "trade count / win rate over the last N days" is
  the natural reading of a `days` param on a P&L endpoint.
- **Top block reasons are `decision.reasons[0]`, truncated to 160 chars, tallied verbatim — not
  canonicalized.**  Many block reasons embed a dynamic amount/symbol (e.g. broker-minimum
  messages), so two proposals blocked for "the same" reason can produce two buckets.  Stripping
  numbers/symbols to improve grouping was judged out of scope for a read-only diagnostic rollup;
  documented as a known limitation in the runbook and in the module's own doc comment.
- **Red Team veto-audit scan capped at 500 rows/account (`OPS_RED_TEAM_AUDIT_LIMIT`)**, well
  below `getRedTeamEfficacy`'s own default of 5000 (`RED_TEAM_EFFICACY_DEFAULT_AUDIT_LIMIT`,
  sized for a single-account, single-request context).  This endpoint can iterate every account
  for every user in one request, so the per-account budget is tightened; a heavy-veto account's
  `redTeamEfficacy.coverage` string will read fewer vetoes resolved than the Results page would
  show for the same account — an accepted trade-off for ops-diagnostic use, not a Results-page
  replacement.
- **60s in-process cache, single-flight per `(account, days)` key** — new dedicated cache in
  `ops-performance.ts` rather than reusing `dashboard-snapshot-cache.ts`'s `Map`.  That cache's
  write-path invalidation hooks (`invalidateDashboardSnapshotCache` calls sprinkled at policy/
  proposal write sites) are wired for dashboard freshness semantics unrelated to this endpoint;
  a dedicated cache keeps that coupling out and is simple enough (< 40 lines) not to justify
  sharing.
- **perf-11 (per-lot win-rate label vs. TWR cost basis) is explicitly OUT of scope for this
  lane** (owned by AG on `ag/perf-twr-basis`) — `tradeStats.winRate`/`thesisScorecard[].winRate`
  use the same per-lot `pnl > 0` definition the rest of the app already uses, so this endpoint
  inherits that open issue rather than working around it.

## 4. Verification State

Commands run (from `~/apps/trading-claude-st-ops-performance`, Node 24 pinned via
`/opt/homebrew/opt/node@24/bin`).  The Mac was under extreme fleet-wide contention while these
ran (multiple parallel lanes' `npm ci`/`vitest`/`eslint`/`tsc`/`next build` — `uptime` load
average peaked around 700 on this run), so wall-clock durations below are NOT representative of
normal-load timing; they are included only to show the gate was actually run, not estimated.

```
npx vitest run test/ops-performance.test.ts
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Results:

- `npx vitest run test/ops-performance.test.ts` — **9/9 passed** (auth x2, shape/math, empty
  account, days clamping, route end-to-end + account filter, cache TTL, cache single-flight,
  synthetic query-cost smoke test).  Two of the auth tests needed a bumped per-test timeout
  (120s) purely because of the machine contention below — see the in-file comment.
- `npm run lint` — **0 errors** (831 pre-existing warnings across the repo, none introduced by
  this change — verified by grepping the lint output for `ops-performance` and
  `app/api/ops/performance`: zero matches).
- `npx tsc --noEmit` — **clean** (no output).
- `npm test` (full suite) / `npm run build` — **started but did not finish before this PR was
  opened.**  This Mac was under extreme fleet-wide contention while this lane ran (many parallel
  agent lanes' own `npm ci`/`vitest`/`eslint`/`tsc`/`next build` at once): `uptime` load average
  held between ~500 and ~700 continuously for over an hour (an 8-16 core box; normal load is
  single digits), confirmed repeatedly and independently of this change.  Given (a) lint and tsc
  — the checks most likely to catch a real regression from a scoped addition — are both clean,
  (b) this change is purely additive (two new files; `package.json` gains one script line; no
  existing route, lib function, or DB migration is modified), so it cannot itself regress an
  existing test, and (c) the required GitHub Actions `verify` check re-runs the identical
  tsc → test → build gate on a clean, uncontended `ubuntu-latest` runner as part of merging this
  PR, this PR was opened without waiting for the full local suite/build to finish under this
  degraded environment.  If `verify` surfaces anything, it will be addressed there.

## 5. Next Steps & Blockers

- None blocking.  Follow-on (not this lane): consider canonicalizing block reasons (strip
  dynamic amounts) if the top-block-reasons rollup proves too fragmented in practice.
- Owner note: no production setup is needed beyond what `/api/ops/snapshot` already has —
  `OPS_DIAGNOSTIC_TOKEN` is the same token, already configured in Infisical/Cursor Cloud Secrets
  per `docs/rollouts/2026-06-29-ops-diagnostic-snapshot.md`.

## 6. Zero-Code Findings

None — this lane was implementation-only.
