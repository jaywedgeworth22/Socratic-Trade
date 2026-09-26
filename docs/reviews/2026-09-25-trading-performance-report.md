# Trading Performance Report

> Produced by CLAUDE's performance-analysis workflow from `GET /api/ops/performance?days=120` at 2026-09-25 19:21Z.

Data as of Fri, Sep 25, 2026 at 2:21 PM CT (`/api/ops/performance?days=120`), with the ops snapshot from Thu, Sep 24 at 4:29 PM CT.  Read-only analysis.  Paper and live are labeled on every row.

## Bottom Line

The data doesn't show that the strategy makes money, and it doesn't prove a losing edge either.  Only one account has a usable sample: Alpaca Paper (paper, 98 closed lots).  It has booked -$185.93 realized, with a profit factor of 0.78 and -$1.90 expectancy per lot.  A result that size would show up by chance about one time in four even with zero edge (t ≈ -1.2).  Its equity is -$129.78 since Jun 23, and it has given back every gain since the Aug 20 peak.  There's almost no evidence from live money: Roth IRA traded 44 lots for -$0.62 before owner withdrawals took it to $1.68, and the other live accounts are dormant or can't be observed.  The main problem is the plumbing, not the signal:
- 36 of the last 50 Alpaca Paper runs never completed.
- The app's own resting protective stops block discretionary exits.
- An accidental PG short stayed open for 78 days.
- A Tradier paper account moved about $64,300 of stock that the app never recorded.

## Per-Account Results

Realized P&L is lifetime.  Lot counts and win rates cover the 120-day window.  Win rate is per FIFO lot, not per round trip (perf-11), so a trimmed position counts several times.  Unrealized P&L isn't reported for any account because `pricesUnavailable` is hardcoded true, so the table shows the value held in positions (equity minus cash) instead.

| Account | Paper / Live | State (last run started) | Realized | Unrealized | Closed Lots | Win Rate (per lot) | Max Drawdown, Net of Withdrawals |
|---|---|---|---|---|---|---|---|
| Alpaca Paper | Paper | Halted, flapping with active (Sep 24) | -$185.93 | Not reported; $6,146.04 in positions | 98 | 48% | -$970.15 (-1.0%) sustained, Aug 20 → Sep 24.  The -$1,220.24 max on Aug 5 was a one-snapshot dip, recovered in 3 trading days. |
| Roth IRA | Live | Halted (Sep 18) | -$0.62 | Not reported; $1.56 in positions on Sep 17 | 44 | 43.2% | -$3.46 (-3.4%), Jul 28 → Aug 27, before withdrawals.  The "72% breach" is the owner withdrawal. |
| Agentic (Robinhood) | Live | Close-only (Jul 27) | $0.00 recorded | Not reported; $45.05 in positions on Jul 27 | 0 | n/a | Not measurable, because the curve is mostly deposits and withdrawals.  Position value fell $55.58 → $45.05, so the trading loss is at most about $10.53. |
| Sandbox (Tradier) | Paper | Halted (Aug 14) | $0.00 recorded; the app missed its fills | Not reported; $50,238.69 in positions | 0 recorded | n/a | -$3,163.54 (-3.1%), Aug 14 peak $102,423.17 → $99,259.63.  Net -$740.37 since Jul 21. |
| Alpaca Standard | Live | Halted (Jul 6) | $0.00 | Unknown | 0 | n/a | n/a.  Only one snapshot (Jul 6, $0), so current equity is unknown. |
| Tradier | Live | Close-only | $0.00 | Unknown | 0 | n/a | n/a.  No snapshots.  Being exit-only suggests it may still hold positions. |
| Public | Live | Unknown (halted in the Sep 24 snapshot) | $0.00 | Unknown | 0 | n/a | n/a.  No snapshots. |

Notes:
- **Alpaca Paper by month:** June -$63.97, July +$119.25, August +$311.75, September -$496.81.  Equity has been below its Jun 23 start since Sep 16.
- **Alpaca Paper vs. capital actually at risk:** the account sat 90%+ in cash.  Measured against average deployed capital (about $6,870), realized P&L is about -2.7% over 94 days.  From Aug 20 to Sep 24 the positions averaged only about $4,700, so the -$970.15 decline was large next to what was actually at risk.
- **Roth IRA:** the Sep 24 high-water-mark recompute reset the mark to $1.68 with `netTransfers: 0`.  So the withdrawal was never recorded as a transfer.  The recompute cleared the breach instead of logging it.  Between Sep 10 and Sep 17 there were 34 false drawdown alarms, and 16 strategy runs kept firing against the halted account.
- **Sandbox:** on Aug 5 it bought about $64,300 of stock.  The funnel shows 40 proposals stuck at "placed" and only 1 "filled".  About $20,800 of broker-side exits happened while it was halted, and the app recorded none of them.  This is the largest dollar swing in the fleet, and every scorecard misses it.
- **Live capital:** the only live balances actually observed are Roth IRA ($1.68) and Agentic ($45.05, last seen Jul 27).  Tradier, Public and Alpaca Standard are unknown, not zero.
- **"Never completed" isn't evidence:** `lastCompletedRunAt` is null by design for any account that isn't active.  Only `lastRunStartedAt` shows dormancy.

## What Works and What Does Not

All thesis and model figures below are lifetime closed lots on Alpaca Paper (paper) unless marked otherwise.

**The loss is concentrated.**  4 lots account for -$130.53, which is 70% of the account's -$185.93: Sector-Relative-Strength (3 lots, -$78.79) and Analyst-Revision (1 lot, -$51.74).  How large the losing positions were matters more than how often trades win.

**Theses**

| Thesis | Lots | Win Rate | Avg Return / Lot | Total | Read |
|---|---|---|---|---|---|
| Insider-Accumulation | 40 | 63% | +0.14% | -$6.99 | Positive in percent terms, slightly negative in dollars because the losers were bigger positions.  That points to sizing, not stops.  Keep it. |
| Value-Quality | 25 | 40% | -0.56% | -$79.18 | The most consistent negative thesis in the data (shrunk -0.47%).  Worth shrinking. |
| Defensive-Rotation | 16 | 44% | -0.09% | -$6.79 | Flat. |
| Momentum-Breakout | 11 | 27% | -0.34% | -$27.46 | Negative on a small sample.  Watch it. |
| Sector-Relative-Strength | 3 | 33% | -1.90% | -$78.79 | Too few lots to judge. |
| Analyst-Revision | 1 | 0% | -2.38% | -$51.74 | Too few lots to judge. |
| Earnings-Catalyst | 1 | 100% | +2.70% | +$66.54 | Too few lots to judge. |
| Short-Squeeze-Risk | 1 | 0% | -0.07% | -$1.52 | Too few lots to judge. |

Roth IRA (live) has one real thesis sample, Sector-Relative-Strength: 32 lots, +1.69% per lot, but only +$0.03 in dollars.  Its biggest percent wins came on the smallest fractional positions.  The account as a whole averaged +1.11% per lot and still lost $0.62.  Percent means on this account come from fractional sizing, not edge.

**Models (proposers)**

| Model | Lots | Win Rate | Total |
|---|---|---|---|
| gpt-5.4-nano | 8 | 12.5% | -$209.31 |
| gpt-5.5 | 19 | 21.1% | -$173.70 |
| claude-opus-latest | 3 | 0% | -$123.29 |
| grok-build-0.1 | 13 | 76.9% | +$145.71 |
| No model stamped | 20 | n/a | +$184.54 |

On its own, gpt-5.5 vs grok-build-0.1 (4 of 19 wins vs 10 of 13) looks significant: roughly 3 in 1,000 by chance.  It's still not a clean comparison, for four reasons:
- Model rotation changed from fixed to round-robin on Jul 8, then to weighted random on Aug 6, so each model's results are tied to a calendar period.
- Lots are clustered partial fills of the same positions.
- 16 models are being compared at once.
- A fifth of the lots have no model stamped, and those were collectively the profitable ones.

Every Roth IRA model bucket has 5 lots or fewer, so there's no model conclusion there.

**Red Team**

- **Alpaca Paper (paper):** 79 vetoes, of which 28 have matured and 24 are unique scenarios.  The headline average return of +1.16% on vetoed trades comes from one vetoed PYPL buy at +27.4%.  Without it the average is +0.19% and the median +0.23%.  The split is 13 losses avoided vs 15 winners missed, which is a coin flip.  The vetoed ideas actually did slightly better than the trades it approved (-0.19% per lot).
- **Roth IRA (live):** 59 vetoes, 25 matured, 15 unique scenarios.  Vetoed ideas returned +0.13%, vs +1.11% per lot for the trades it approved, so it's mildly helpful here.
- **By reviewer:** gemini-flash-latest avoided a loss on 5 of 6 vetoes, the best on Alpaca Paper.  gpt-5.6-luna (8 vetoes) and gpt-5.6-terra (5) blocked winners 75-80% of the time.  All of these samples are thin.
- **Verdict:** the two accounts point in opposite directions, so there's no fleet-wide "helpful" or "harmful" call yet.  Counterfactual returns use a 5-trading-day horizon, while actual holds ran about 3-12 days.

**Guards that worked**

- The oversell guard blocked 7 attempts to sell PG while the account was already short 12 shares, so the short never doubled.
- The small-account sizing guards on Agentic and Roth correctly refused orders below broker minimums.

**The PG short didn't drive the P&L.**  It opened at $149.76 on Jul 8 and was covered at $148.98 on Sep 24, worth +$9.36 at most.  #3759's rollout traced the cause: stale-order cleanup cancelled a held take-profit leg and replaced it with a standalone market sell, and the parent buy never filled.  Its real cost was operational (see the next section).

## Where Trades Die

943 proposals were made across the 4 active accounts in 120 days:

| Outcome | Count | Share |
|---|---|---|
| Reached the broker (placed + filled) | 336 | 35.6% |
| Blocked before placement | 174 | 18.5% |
| Vetoed by the Red Team | 165 | 17.5% |
| Rejected by the broker | 95 | 10.1% |
| Placement failed | 60 | 6.4% |
| Withdrawn | 58 | 6.2% |
| Expired | 47 | 5.0% |
| Other (placing, proposed, manual reject) | 8 | 0.8% |

"Placed" is not a final status.  Sandbox has 40 placed but only 1 filled, even though about $64,300 actually traded.  So "reached the broker" doesn't mean "executed and recorded".

**Bugs vs guardrails (approximate)**

- **Guardrails doing their job, about 201 (21%):**
  - 165 Red Team vetoes, whose value isn't proven.
  - 14 small-account sizing blocks on Agentic and Roth.
  - 5 T oversell blocks.
  - 17 "ALLOW_LIVE_TRADING" blocks.  Their wording matches the opt-in gate retired on Jul 7, so they're most likely older rows still inside the window.  I couldn't confirm the dates.
- **Bugs, design gaps and execution failures, about 140 (15%):**
  - About 62 Alpaca Paper exits were blocked because the app's own resting protective stops already reserve the full position.  On Sep 24 those stops were BAC 24 shares, KO 14, PYPL 30 and BRK-B 2.  This is how the order logic is built to work, not a reliability symptom, so fixing run reliability won't shrink it.  In practice many positions can only exit through the stop.
  - 18 proposals went down the PG failure path: 7 blocked, plus 11 broker rejections for "bracket orders must be entry orders" and "market orders require no stop or limit price".  One more placement failure is counted with the 60 below.
  - 60 placement failures, 22 of them on Agentic.  That's 26.8% of Agentic's proposals, 5-6x the rate on any other account.  The cause is unknown.
- **Not explained by this endpoint, about 258 (27%):**
  - 84 broker rejections outside PG, with no reason breakdown.
  - 58 withdrawn.
  - 47 expired.
  - 69 blocks outside the top-10 reason list.

**Run level (Alpaca Paper, Sep 22 8:39 AM CT to Sep 24 2:20 PM CT, 50 runs):**
- 23 were skipped because the broker looked unhealthy.
- 11 were killed by process restarts.
- 2 failed for other reasons.
- 14 completed.  Those 14 evaluated 25 proposals: 18 blocked, 3 placed, and 4 left "Awaiting approval" even though the account is on Autopilot.

Completing more runs helps, but blocked exits cap output too.  Over its 94 days, Alpaca Paper reached the broker about 14.6 times per week.

## Improvement Plan

Gating rule: don't add live capital until Alpaca Paper shows positive expectancy measured on round trips, over an uninterrupted sample taken after #3752 and #3759 are live.

### Already In Flight or Landed (Reliability and Correctness)

| Item | Status | Expected Effect | Size | Depends On |
|---|---|---|---|---|
| #3752 run resilience (stops the halt/active flap on health-probe timeouts and recovers runs killed by restarts) | Open | Turns some of the 34 skipped or killed runs out of 50 into completed runs.  On its own it won't add many orders, since completed runs were mostly blocked. | M | None |
| #3759 order correctness (position check before every order, covers without bracket legs, market orders without a limit price, exits capped at the held quantity) | Merged to main (5059028a0).  Confirm it is live with `scripts/verify-deploy-sha.sh`. | Removes the PG failure class (19 proposals) and the Sep 21 VZ 403.  Verify through the `order_position_invariant_refused` and `order_position_invariant_reshaped` audit rows. | M | None |
| #3753 withdrawal and deposit detection | Open | Withdrawals stop reading as drawdown breaches (Roth's 34 false alarms), and Roth and Agentic drawdowns become computable net of transfers. | M | None |
| #3756 stall profiler | Open | Identifies the code path behind the recurring event-loop stalls.  No direct P&L effect, but it's what lets the stall itself be fixed. | S | None |
| #3754 ops account control | Open | Remote halt, resume and park, which the dormant-account decision below needs. | S | None |
| #3761 model-rotation failover on OpenRouter 403s, plus exit de-risking on by default | Merged | Fewer runs lost to 403s.  Exit behavior changes from the deploy on, so lots after it are a new regime and shouldn't be pooled with earlier ones. | Done | None |
| #3750 / #3751 performance endpoint and event-loop yield | Merged | The data source for this report. | Done | None |

### New Strategy and Data Work (Ranked)

| Rank | Action | Expected Effect | Size | Depends On |
|---|---|---|---|---|
| 1 | Fix Tradier fill reconciliation, so a "placed" order becomes "filled" and closed lots get recorded (Sandbox). | Puts the fleet's largest dollar swing (-$3,163.54 from peak) into realized P&L and the scorecards.  Needed before the live Tradier account trades again. | M | None |
| 2 | When a discretionary exit is approved, cancel or shrink the resting protective stop and then sell, instead of blocking the exit. | Unblocks about 62 of Alpaca Paper's 115 blocks (54%).  May narrow the gap between the $16.91 average loss and the $14.04 average win (not proven). | M | #3759, which touches the same order-replacement code.  Confirm it didn't already change this. |
| 3 | Grade trades on round trips (`aggregateRoundTrip`).  Add an "unattributed" row to model attribution, break the funnel out per proposing model, and itemize broker-rejection reasons. | Makes win rate, expectancy and the model comparison good enough to decide on.  Exposes the 20 unattributed lots (+$184.54). | S | None |
| 4 | Cap dollar risk per position (equal-risk sizing), and find out why the losing positions were the biggest ones. | The largest P&L lever visible in the data: 4 lots made up 70% of the loss, and Insider-Accumulation is positive in percent but negative in dollars. | M | 3 |
| 5 | Shrink Value-Quality position sizes and watch Momentum-Breakout. | Removes the most consistent negative thesis (25 lots, -$79.18).  Easy to reverse. | S | None.  Re-check once 3 lands. |
| 6 | Run a controlled model test: fix the rotation weights for a set period, or split models by account.  A reversible down-weight of gpt-5.5 and gpt-5.4-nano is cheap now, but not proven. | Answers whether gpt-5.5 and gpt-5.4-nano are worse, or just unlucky in their calendar period. | S | #3752 and 3 |
| 7 | Re-score the Red Team: vetoed vs approved trades at a matched horizon, duplicates removed, medians instead of means.  Decide once each account has at least 50 unique matured vetoes. | Settles whether the 17.5% veto share is worth it. | S | 3 |
| 8 | Decide what to do with the dormant accounts:<br>• Alpaca Standard: last run Jul 6.<br>• Tradier live: exit-only with no snapshots; check for open positions.<br>• Public: no snapshots.<br>• Agentic: last run Jul 27, 26.8% placement failures.<br>For each: park it, re-arm it, or investigate.  Start taking equity snapshots for Tradier and Public. | Removes the unexplained zeros and unknown balances from every report. | S | #3754 |
| 9 | Refresh the SPY benchmark series (perf-17). | Makes returns vs the market measurable again. | S | None |
| 10 | Find out why Autopilot runs left 4 proposals "Awaiting approval" (Sep 23, 11:32 AM and 12:33 PM CT). | Closes a quiet gap between completed runs and placed orders. | S | None |

## Data Gaps

- Realized P&L and the thesis, model and Red Team tables are lifetime figures.  Only lot counts, the funnel and the equity curve are limited to the 120-day window.
- `pricesUnavailable` is true for every account, so unrealized P&L is not reported anywhere.  Open exposure here is inferred from equity minus cash.
- Win rates are per FIFO lot, not per round trip (perf-11).
- The SPY benchmark has been stale since Jul 24 (perf-17), and no thesis row carries alpha.  There is no market-relative result.
- Broker rejections have no reason breakdown.  Block reasons are capped at the top 10 per account, and block rows carry no timestamps, so the ALLOW_LIVE_TRADING blocks can't be dated.
- The funnel isn't broken out per proposing model.
- Roth IRA's curve in this data ends Sep 17 ($28.35).  The $1.68 figure comes from a separate Sep 24 audit row.
- Tradier live and Public have no equity snapshots.  Alpaca Standard has one, from Jul 6.
- Sandbox's fills were never recorded, so its trade count and realized P&L read zero.
- Red Team counterfactuals use a 5-trading-day horizon against 3-12 day actual holds, and the matured records include repeated scenarios.
- The two source files are 22 hours apart, and Alpaca Paper flapped between halted and active in between.
- This was read-only: nothing was re-derived from the production database or broker.
