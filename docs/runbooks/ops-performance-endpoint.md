# Runbook — `GET /api/ops/performance` (remote realized-performance diagnostics)

## Why this exists

Trading performance could not be measured remotely.  `/api/connected-accounts/[id]/performance`
and `/console/results` are session-gated (no OAuth path for a remote agent, curl, or an uptime
monitor), and `/api/ops/snapshot` (the existing token-gated ops endpoint — see
`docs/rollouts/2026-06-29-ops-diagnostic-snapshot.md`) carries strategy-run and audit state but
no P&L.  This endpoint fills that gap.

## What it returns

Token-gated (same gate as `/api/ops/snapshot`), read-only, GET only.  For every connected account
the ops snapshot covers (or one, via `?account=`):

- `label`, `broker`, `environment`, `systemState`, `accountNumber`
- `liveRealizedPnl` / `paperRealizedPnl` / `liveUnrealizedPnl` / `paperUnrealizedPnl` — from
  `getPerformanceSummary`.  `pricesUnavailable` is always `true`: this endpoint never fetches a
  live quote, so unrealized figures read `0` from an empty `currentPrices` map — same disclosed
  limitation as `/api/connected-accounts/[id]/performance`.
- `tradeStats` — win rate, avg win/loss (USD), profit factor, expectancy (USD/trade), trade
  count.  Computed over the account's own book (`environment`'s closed lots from `calculatePnl`),
  windowed to `days` by `exitAt`.
- `thesisScorecard` — `getThesisScorecard` for the account's own book, lifetime (not windowed —
  matches how the app's own scorecards work elsewhere).
- `redTeamEfficacy` — `getRedTeamEfficacy`, lifetime, capped at 500 scanned veto-audit rows per
  account (the app's own default of 5000 is sized for a single-account request; this endpoint can
  iterate every account for every user).
- `modelAttribution` — closed lots grouped by `proposal.proposedByModel` (win rate + total P&L
  per model), lifetime.
- `proposalFunnel` — `trade_proposals.status` counts in the window (`proposed` / `blocked` /
  `rejected_by_broker` / `placed` / `placing_failed` / `withdrawn` / whatever else appears) plus
  the top 10 first-block-reasons (from `decision.reasons[0]`, truncated to 160 chars — reasons
  that embed a dynamic amount/symbol will not merge into one bucket; this is a diagnostic rollup,
  not a canonicalized taxonomy).
- `equityCurve` — `date`/`equity`/`cash`, one point per calendar day (reuses
  `getPerformanceSummary`'s `live/paperEquityCurve`, itself sourced from
  `listDailyPortfolioSnapshots` — no new query), windowed to `days`.

## Query params

| Param | Default | Notes |
| --- | --- | --- |
| `account` | (all) | One `connectedAccountId`, across every user — mirrors `/api/ops/snapshot`'s all-users iteration. |
| `days` | 90 | Clamped 1-3650.  Windows `tradeStats`, `proposalFunnel`, and `equityCurve`.  `thesisScorecard`/`redTeamEfficacy`/`modelAttribution` are always lifetime. |

## Query cost / caching

This runs inside the SAME production web process whose event loop is already known to stall
under load.  Every query this endpoint adds is bounded:

- The proposal-status GROUP BY and the block-reason scan are both scoped to
  `(user_id, account_number, created_at)` — covered by the existing
  `idx_trade_proposals_user_account_created` index (no new index added).
- Block-reason rows are capped at 1000 per account (`MAX_BLOCK_REASON_ROWS` in
  `src/lib/ops-performance.ts`); `proposalFunnel.blockReasonRowsCapped` says so when that bound
  was hit.
- Red Team veto-audit scan is capped at 500 rows per account (`OPS_RED_TEAM_AUDIT_LIMIT`).
- `liveFills`/`paperFills` are fetched ONCE per account and `calculatePnl` (the FIFO lot match)
  runs ONCE per source — the results are threaded through as `PrefetchedFills`/`PrefetchedPnl` so
  `getPerformanceSummary` and `getThesisScorecard` never repeat that O(fills) work for the same
  account.  The fill fetch itself is unbounded (FIFO replay needs the complete ledger — existing,
  documented constraint in `db-fills.ts`'s `listFillEvents` doc comment, not new here) — **`days`
  does NOT shrink this fetch or the FIFO walk**, only the in-memory windowing of `tradeStats`/
  `proposalFunnel`/`equityCurve` afterward, so a single account's cost is driven by that
  account's total ledger size regardless of the requested window.
- **Unfiltered requests (no `account` param — the endpoint's own documented default; see Usage
  below) repeat that per-account cost once per connected account across every user, in one
  request.**  `buildOpsPerformanceSnapshot` is `async` and calls `yieldEventLoop()`
  (`src/lib/slow-sync-guard.ts` — this codebase's established fix for the event-loop-stall
  incident class linked above, already used by the SEC ingest worker and the RAG FTS mirror)
  once per account processed, so this cannot hold the event loop in one unbroken synchronous
  stretch no matter how many accounts or how large their ledgers — it does not reduce the total
  work, only keeps `/api/health` and other requests servable while it runs.  Covered by
  `test/ops-performance.test.ts`'s "unfiltered, multi-account path" test (4 synthetic accounts x
  500 fills, asserts `yieldEventLoop` is called at least once per account).
- The whole snapshot is cached in-process for 60s, single-flight per `(account, days)` key
  (`src/lib/ops-performance.ts`), so a burst of identical probe requests (an uptime monitor, a
  retried curl) does not multiply the DB work.
- Measured against a synthetic DB in two `test/ops-performance.test.ts` tests: (1) 300 closed
  round trips / 500 proposals / 200 portfolio snapshots on ONE account, filtered by `account`;
  (2) 4 accounts x 250 closed round trips (500 fills each), UNFILTERED — the endpoint's own
  documented default and the more expensive path in practice.  See those tests' console output /
  this rollout's Verification section for the measured durations on the seed hardware.  Both ran
  on a Mac under heavy fleet-wide contention at various points, so a measured duration is not a
  normal-load baseline; each test's own bound is generous specifically to stay a smoke check
  under those conditions rather than a strict benchmark.

## Usage

```bash
export OPS_DIAGNOSTIC_TOKEN=...   # same token /api/ops/snapshot uses
bash scripts/fetch-prod-ops-performance.sh
# or: npm run ops:performance

# narrow to one account, 30-day window:
OPS_PERFORMANCE_ACCOUNT=<connectedAccountId> OPS_PERFORMANCE_DAYS=30 npm run ops:performance
```

Direct curl:

```bash
curl -sS -H "x-ops-token: $OPS_DIAGNOSTIC_TOKEN" \
  "https://socratictrade.com/api/ops/performance?days=30" | jq .
```

## Known open item

`perf-11` (per-lot win-rate label vs. TWR basis) is open and owned by AG on
`ag/perf-twr-basis` — this endpoint's `tradeStats.winRate` and `thesisScorecard[].winRate` use
the SAME per-lot definition the rest of the app already uses (`pnl > 0`), so it inherits that
open issue rather than fixing or working around it here.
