# 2026-09-17 — Cash-flow-aware drawdown high-water mark (Grok)

## Context & Objective

`recordAndEvaluateDrawdownBreaker` ratcheted HWM with `Math.max(prevHwm, equity)` and ignored
external deposits/withdrawals.  Roth IRA account `2931b94a-6d4a-49f5-882c-0219d9627d41`
(`294709855`) stuck at HWM ~$101.62 while equity ~$28 after contributions/withdrawals, so the
15% policy fired a ~72% false drawdown in ops audit.  Results/TWR already neutralize the same
Alpaca CSD/CSW (and related) rows via `broker-cash-flows.ts`.  This change makes the breaker
use that ledger, and adds an ops-only recompute heal.  Extra-ship no.  PR only — do not merge
or Coolify deploy.

## Changes Made

- Drawdown HWM is cash-flow aware: deposits raise HWM by the flow dollars; withdrawals scale
  HWM by remaining/prior equity (at the peak that equals a dollar reduction, so a cash-out is
  0% drawdown).  Same-day transfers also dollar-adjust start-of-day equity so a withdrawal is
  not a daily-loss breach.
- Live recorder persists `risk:hwm:${userId}:${accountNumber}:${source}` and a cursor at
  `risk:hwm-obs:...` (last equity, timestamp, applied activity ids).  The first observation
  after deploy records the cursor and does **not** replay the historical ledger (that would
  double-count deposits already baked into the old HWM).  Incremental runs apply only unseen
  transfer ids.
- Ops `POST /api/ops/hwm/recompute` (OPS_DIAGNOSTIC_TOKEN / `authorizeOpsRequest`) rebuilds
  HWM from the Alpaca transfer ledger + current equity for a `connectedAccountId` and writes
  the setting.  JSON: `oldHwm`, `newHwm`, `equity`, `netTransfers`, `transferCount`,
  `impliedDrawdownPct`.  Never returns secrets/keys.

Touched files:

- `src/lib/risk-breaker.ts`
- `src/lib/risk-hwm.ts` (new)
- `src/lib/broker-cash-flows.ts`
- `src/lib/alpaca-account-insights.ts`
- `src/lib/db-api-keys.ts` (`findConnectedAccountById`)
- `src/lib/db.ts` (deletion registry `risk:hwm-obs:`)
- `src/lib/strategy.ts`
- `src/lib/dashboard.ts`
- `app/api/ops/hwm/recompute/route.ts` (new)
- `test/risk-breaker.test.ts`
- `test/broker-cash-flows.test.ts`
- `test/ops-hwm-recompute.test.ts` (new)
- `test/account-deletion.test.ts`
- `docs/stop-loss-and-exit-strategies.md`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- Reuse `BROKER_TRANSFER_ACTIVITY_TYPE_LIST` (CSD/CSW/ACATS/JNLC/INT/DIV/DIVNRA/DIVTX/FEE)
  rather than inventing a narrower HWM-only set, so Results and the breaker neutralize the
  same activity types.
- Ledger replay from $0 + current equity does **not** reconstruct intra-period trading peaks
  that were later withdrawn.  That is acceptable for the ops heal (unstick the Roth false
  mark).  Going-forward peaks still ratchet on the live recorder.
- Fetch failure on a strategy run does not advance the observation cursor, so the next run
  can retry the same window.  One extra advisory is possible that tick.
- Same-day SOD adjustment is dollar (daily-loss is notional), not proportional.

## Verification State

Commands:

```bash
npx vitest run test/risk-breaker.test.ts test/broker-cash-flows.test.ts test/ops-hwm-recompute.test.ts
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Receipts recorded in STATUS after the gate runs.

## Next Steps & Blockers

- After merge/deploy (not this lane): heal Roth with

```bash
curl -sS -X POST https://socratictrade.com/api/ops/hwm/recompute \
  -H "content-type: application/json" \
  -H "x-ops-token: $OPS_DIAGNOSTIC_TOKEN" \
  -d '{"connectedAccountId":"2931b94a-6d4a-49f5-882c-0219d9627d41"}'
```

- Extra-ship no.  Do not merge from this lane.  No Coolify Deploy.  No `--force-ship`.

## Zero-Code Findings

None — code change.
