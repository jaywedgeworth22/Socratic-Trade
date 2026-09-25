# 2026-09-24 — Detect IRA Withdrawals and Deposits So Drawdown Math Is Not Fooled (CLAUDE, lane F2)

Board `687a5fb4` (umbrella, claimed by CLAUDE).  Branch `claude/st-cashflow-detection`, worktree
`~/apps/trading-claude-st-cashflow-detection`.  Builds on PR #3700 (cash-flow-aware HWM, merged
2026-09-24; rollout `docs/rollouts/2026-09-17-cashflow-hwm.md`).

## 1. Context & Objective

The Roth IRA connected account `2931b94a-6d4a-49f5-882c-0219d9627d41` (Alpaca live) went from
~$98-100 (2026-08-03 → 09-08) to ~$28.35 (09-09 → 09-17) to $1.68 (09-24).  The owner confirms
the money was WITHDRAWN; recent fills are tiny fractional trades.  The drawdown breaker read it
as "Trailing drawdown 72.10% from HWM $101.62" and halted the account for two weeks (34
`policy_violation_drawdown` audits).  Tonight's `POST /api/ops/hwm/recompute` returned
`{oldHwm: 30, newHwm: 1.68, equity: 1.68, netTransfers: 0, transferCount: 0}` — no transfers
found at all, and the HWM only dropped because the recompute silently fell back to current
equity.  Objective: make the ledger read honest and complete, make the breaker and the recompute
understand contributions, distributions, and withholding, and give fleet agents a read-only way
to see exactly what Alpaca reports.

## 2. Changes Made

**Root cause of the zero-flow read (both defects fixed):**

- The ledger was requested with `activity_types=CSD,CSW,ACATS,JNLC,INT,DIV,DIVNRA,DIVTX,FEE`.
  `DIVTX` is **not an Alpaca activity type** — it appears in none of the published enums
  (Trading API account-activities doc, the Broker API `ActivityType` enum, alpaca-py's
  `ActivityType`, the official Go SDK); the real code is `DIVTXEX`.  The filter also could not
  name every IRA cash type (`ACATC` cash transfers, `WH` withholding, `JNL`, `OCT`, …).
- `fetchAlpacaAccountActivities` swallowed any non-2xx or transport failure as `[]`, so a
  rejected or failed read was indistinguishable from "this account never moved money".  The
  equity read in the same recompute succeeded with the same base URL and credentials, so the
  request did reach Alpaca authenticated — the empty set came from the activities read itself
  (either rejected and swallowed, or filtered to nothing).  Reproduced on origin/main: a 422 on
  the activities read yields exactly the prod response (`200`, `newHwm = equity`,
  `netTransfers: 0`, `transferCount: 0`).  The new diagnostic below shows which of the two it
  was in prod.

**Fixes:**

- `src/lib/alpaca-account-insights.ts` — `fetchAlpacaAccountActivitiesDetailed` returns
  `{ok, activities, pages, truncated, httpStatus, error, credentialMissing, query}` (error text
  is the HTTP status plus Alpaca's trimmed, secret-scrubbed reason; a failure on ANY page is
  `ok: false`).  `fetchAlpacaNonTradeActivities` reads `category=non_trade_activity` (verified
  Trading API parameter; mutually exclusive with `activity_types`) and falls back to a
  documented-types filter only if Alpaca rejects the category itself (400/422).
  `fetchAlpacaDailyEquityHistory` reads Alpaca's daily closes (`/v2/account/portfolio/history`,
  `timeframe=1D`, explicit `start`/`end`), keyed by New York calendar day.
  `alpacaTradingHostInfo` exposes the host (never a credential) and whether
  `ALPACA_TRADING_BASE_URL` overrides it.  The legacy list-returning
  `fetchAlpacaAccountActivities` is unchanged for non-money-path callers.
- `src/lib/broker-cash-flows.ts` — every published Alpaca type is classified: `capital`
  (CSD, CSW, TRANS, ACATC, ACATS, JNL, JNLC, JNLS, OCT, FOPT, WH), `income` (DIV family incl.
  DIVTXEX/DIVWH/DIVFT/DIVTW, CGD, INT family, PTR), `expense` (FEE, CFEE, DIVFEE, PTC),
  `position` (FILL, splits, mergers, option events, CIL), else `unclassified`.  Capital +
  income + expense are the counted flows (income/expense kept for continuity with the
  pre-existing list).  `status: "canceled"` rows are never counted.  New
  `summarizeNonTradeActivities` gives per-type counts/net, `capitalIn`/`capitalOut`, and the
  unclassified list.
- `src/lib/risk-breaker.ts` — the recorder now reports `flowsUnavailable`,
  `appliedExternalFlowTotal`, and `unexplainedEquityChange` (≥ 20% run-over-run fall with no
  ledger flow on a ledger-tracked account).  On such a fall it records a pending drop and sets
  `deferHardAction`; the follow-up run applies a newly posted withdrawal against the PRE-drop
  equity when the numbers show the drop was that withdrawal (a real loss followed by a later
  cash-out keeps the observed base).  One baseline is never deferred twice, so a real loss is
  enforced on the next run.  New pure `replayHighWaterMarkFromDailyHistory` for the recompute.
- `src/lib/risk-hwm.ts` — the live loader reads the full non-trade ledger (2-day overlap before
  the cursor, applied-id dedupe), returns `flowsUnavailable` + `flowsError` on failure, and
  audits unrecognized types once per account/day (`risk_hwm_unclassified_activity`).  The
  recompute never persists on an unreadable ledger (502 `flowsUnavailable`), replays Alpaca
  daily closes against the ledger (`method: "daily-history"`), and returns 409
  `unexplainedEquityChange` (with the proposed HWM) instead of guessing when equity fell with no
  ledger flow or a funded account shows no contribution.  Explicit operator opt-ins:
  `acceptUnexplained: true` (keep the replayed HWM, treat falls as losses) or
  `acceptEquityReset: true` (reset to current equity, treat falls as cash-outs).
- `app/api/ops/hwm/recompute/route.ts` — passes the opt-ins; returns `persisted`, `method`,
  `capitalIn`/`capitalOut`, `ledger`, `unclassified`, `unexplainedEquityChanges`, `warnings`.
- `app/api/ops/account-activity/route.ts` + `src/lib/ops-account-activity.ts` (new) —
  `GET /api/ops/account-activity?connectedAccountId=&days=` (ops-token gated like
  `/api/ops/snapshot`).  Returns non-trade rows `{date, activityType, activitySubType,
  classification, netAmount, status, description}` newest first, a per-type summary, the
  ledger read outcome (query, pages, truncated, HTTP status, trimmed error), the trading host,
  and the persisted HWM/observation.  No account numbers, no activity ids, no credentials;
  descriptions trimmed to 80 chars with 5+-digit runs masked.  502 when the ledger read fails.
- `src/lib/strategy.ts` (shared with lanes C/D — minimal diff) — when `deferHardAction` is set,
  an opted-in `close_only`/`halted` action is held as advisory for that one run; the drawdown
  audit carries `deferredHardAction`, `unexplainedEquityChange`, `flowsUnavailable`.
- `src/lib/dashboard.ts` — the benchmark/day-P&L ledger read uses `category=non_trade_activity`
  (it had the same `DIVTX` filter).
- Untracked the accidentally committed `node_modules` symlink from #3452.

Exact files:

- `src/lib/alpaca-account-insights.ts`
- `src/lib/broker-cash-flows.ts`
- `src/lib/risk-breaker.ts`
- `src/lib/risk-hwm.ts`
- `src/lib/ops-account-activity.ts` (new)
- `src/lib/strategy.ts`
- `src/lib/dashboard.ts`
- `app/api/ops/hwm/recompute/route.ts`
- `app/api/ops/account-activity/route.ts` (new)
- `test/alpaca-activity-ledger.test.ts` (new)
- `test/ops-account-activity.test.ts` (new)
- `test/broker-cash-flows.test.ts`
- `test/risk-breaker.test.ts`
- `test/ops-hwm-recompute.test.ts`
- `node_modules` (tracked symlink removed from the index)
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note

## 3. Decisions & Trade-offs

- **Category read + client-side classification** instead of a better filter list: a filter can
  only ever name what we anticipated; the category read returns everything non-trade, and the
  unknown remainder is surfaced (audited, listed in the recompute and diagnostic) instead of
  dropped.  Cost: slightly more rows per read (dividends etc.), paged at 100/page.
- **`WH` counted as capital out.**  `WH` is in alpaca-py's `ActivityType` enum; Alpaca's IRA
  docs say distribution withholding is deducted from the requested withdrawal and remitted to
  the IRS.  Whether it shows as its own row or is netted into the CSW, both are handled.
- **Income/expense stay counted flows** (DIV/INT/FEE were already in the list) so the benchmark
  and HWM semantics do not shift in this PR; only the invalid `DIVTX` was replaced and the
  same-family variants added.
- **Daily-history replay** replaces the flow-only replay for the recompute: the flow-only math
  scales a withdrawal against the reconstructed book (sum of flows), which ignores trading P&L;
  on a near-total cash-out that leaves a phantom drawdown (the Roth shape replays to ≈ $5.20,
  ≈ 68%).  Alpaca's daily close and its activity `date` come from the same books, so the
  pairing is day-consistent; local `portfolio_snapshots` were not used because they are taken
  at arbitrary run times and can sit on either side of a transfer.  If history is unavailable
  the recompute falls back to ledger-only and says so in `warnings`.
- **One-run deferral, not suppression.**  A ≥ 20% run-over-run fall with no ledger flow is far
  more often a cash-out than a loss between two consecutive runs, but it could be a crash.  The
  breach is still reported and audited; only an opted-in hard action waits one run, and a
  baseline is never deferred twice (a persistently unreadable ledger cannot defer forever).
  Accounts with no cash-flow ledger (non-Alpaca) keep the plain ratchet — nothing would post.
- **409 instead of silently resetting.**  The recompute refuses to guess when the ledger cannot
  explain the equity path; the operator chooses with an explicit flag, and the audit row
  records which.
- **Not changed:** `ALPACA_TRADING_BASE_URL` overrides the host for BOTH environments.  It is
  not the cause here (the equity read on the same base succeeded), but the diagnostic now shows
  `tradingHost` + `tradingBaseOverridden` so a mis-pointed override is visible.

## 4. Verification State

Node 24 (`/opt/homebrew/opt/node@24/bin`).

- Regression proof on origin/main (throwaway detached worktree, new recompute tests copied in):
  5 of 8 fail, including `expected 200 to be 502` — the old code turns a rejected activities
  read into a 200 that resets the HWM to equity with zero transfers (the prod response).
- Targeted suites (this branch): `npx vitest run test/broker-cash-flows.test.ts
  test/alpaca-activity-ledger.test.ts test/risk-breaker.test.ts test/ops-hwm-recompute.test.ts
  test/ops-account-activity.test.ts test/alpaca-account-insights.test.ts
  test/strategy-moneypath-drawdown-flip.test.ts test/guard-enablement.test.ts
test/drawdown-breaker-action-api.test.ts` — all pass.
- Full gate, run in order on this branch (machine load average ~250-300 from parallel lanes):
  - `npm run lint` — 0 errors, 830 warnings (grandfathered backlog; the only warnings in touched
    files are pre-existing ones in `src/lib/strategy.ts`).
  - `npx tsc --noEmit` — clean.
  - `VITEST_MAX_THREADS=4 npm test -- --run` — 756 files passed, 1 skipped; 8306 tests passed,
    51 skipped, 0 failed.
  - `npm run build` — success; `/api/ops/account-activity` listed as a dynamic route.  The
    `@sentry/nextjs` "Attempted import error" lines are pre-existing on origin/main.

## 5. Next Steps & Blockers

After this merges and deploys (runtime paths changed, so the RTH latch applies on weekdays),
run the diagnostic first, then the recompute, for the Roth IRA.  Both need `OPS_DIAGNOSTIC_TOKEN`
already in the environment (the same one `scripts/fetch-prod-ops-snapshot.sh` uses; never echo it):

```bash
# 1. What does Alpaca report?  (read-only)
curl -fsS -H "x-ops-token: ${OPS_DIAGNOSTIC_TOKEN}" \
  "https://socratictrade.com/api/ops/account-activity?connectedAccountId=2931b94a-6d4a-49f5-882c-0219d9627d41&days=120" | jq .

# 2. Rebuild the HWM from the ledger + Alpaca daily closes.
curl -sS -X POST -H "x-ops-token: ${OPS_DIAGNOSTIC_TOKEN}" -H "content-type: application/json" \
  -d '{"connectedAccountId":"2931b94a-6d4a-49f5-882c-0219d9627d41"}' \
  https://socratictrade.com/api/ops/hwm/recompute | jq .
```

Read the outcome:

- Diagnostic `ledger.ok: false` → the broker read itself fails (look at `ledger.httpStatus` /
  `ledger.error`); nothing downstream can be trusted until that is fixed.
- Diagnostic shows CSW/WH/ACATC rows around 2026-09-09 and 2026-09-18 → the recompute should
  return 200 `method: "daily-history"` with an implied drawdown of a few percent.
- Recompute 409 `unexplainedEquityChange` → Alpaca reports no transfer for a fall.  If the owner
  confirms it was a withdrawal, re-run with `"acceptEquityReset": true`; if it was a real loss,
  `"acceptUnexplained": true`.
- Any `summary.unclassified` / `unclassified` entries → classify them in
  `src/lib/broker-cash-flows.ts` (follow-up PR) once their meaning is confirmed.

The Roth account's `systemState` is not changed by any of this; re-arming it (if it is still
halted) remains the owner's call on the console.

## 6. Zero-Code Findings

- Alpaca's Trading API supports `category=trade_activity|non_trade_activity` on
  `/v2/account/activities` (Broker API reference and the official Go SDK
  `GetAccountActivitiesRequest.Category` both send it).  Alpaca documents no error behavior for
  an unknown `activity_types` value; the diagnostic's `ledger.error` will show whether it was a
  4xx in prod.
- Alpaca IRA distributions are processed through the ordinary withdrawal endpoint with
  federal/state withholding deducted from the requested amount; contributions arrive as
  deposits (IRA accounts overview doc).
- Portfolio history supports `cashflow_types` (per-window cash-flow totals by activity type);
  not used here, but it is a candidate cross-check for the ledger in a follow-up.
