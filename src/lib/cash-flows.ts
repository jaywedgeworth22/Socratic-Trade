import { centralTradingDayKey } from "./trading-day";

// External deposit/withdrawal inference — PURE, and deliberately dependency-free.
//
// Why this is its own module rather than living in `benchmark.ts` where it started:
// `app/console/lib/derive.ts` needs `inferExternalCashFlows` to compute a cash-flow-adjusted
// day P&L, and derive.ts is imported by ~a dozen "use client" components (the console chrome,
// the dashboard, the mobile PWA client, …). Importing it through benchmark.ts dragged the whole
// server graph into the browser bundle:
//
//   derive.ts → benchmark.ts → history.ts → db.ts (barrel: migrations, api-key crypto, …)
//
// which is how a client chunk ended up carrying the SQLite/migration/ENCRYPTION_KEY code and
// warning about a missing `ENCRYPTION_KEY` in the browser console. The flow math itself never
// needed any of that — it is arithmetic over an equity curve and a fill list.
//
// RULE: this file must stay free of runtime imports. Type-only imports are fine (they are erased
// at compile time); a value import from `./db`, `./history`, or anything that reaches them will
// silently re-attach the server graph to every console page. `history.ts` and the `db` barrel are
// marked `server-only`, so a regression fails the build instead of shipping quietly.
//
// Sign convention (everywhere):
//   deposit / paper top-up / ACH in  → positive
//   withdrawal / ACH out / paper cash-out → negative
// Account return math: V_end - V_start - sum(flows) is market P&L in dollars.

import type { EquityCurvePoint, FillEvent } from "./types";

/** Shared with benchmark.ts, which does the same date-collapsing and 2-dp rounding. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Normalize any timestamp (ms epoch | ISO datetime | YYYY-MM-DD) to a Central trading-day key. */
export function isoDate(ts: string | number | undefined): string | null {
  if (ts == null) return null;
  if (typeof ts === "number") {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : centralTradingDayKey(d);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(ts)) return ts;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : centralTradingDayKey(d);
}

/** A flow is only "external" when it clears both floors — below that, cash drift is
 *  indistinguishable from dividends/fees/rounding and must NOT be treated as a transfer. */
export const FLOW_MATERIALITY_PCT_OF_EQUITY = 0.5; // % of prior equity
export const FLOW_MATERIALITY_MIN_USD = 0.50;

/** Sanity bound for an inferred flow vs its own sub-period's equity move (issue #2557). */
export const FLOW_SANITY_EQUITY_DELTA_MULT = 5;
export const FLOW_SANITY_PCT_OF_EQUITY = 2; // % of sub-period start equity

/**
 * A real external transfer moves account equity by roughly its own size (± the market move in
 * the same gap). An inferred flow whose magnitude exceeds BOTH 5× the sub-period's |Δequity|
 * AND 2% of the start equity cannot be reconciled against the equity it supposedly moved —
 * the live failure was a phantom "withdrawal $36,501.38" inferred on a sub-period whose
 * equity moved only −$837, which then inflated TWR to +56%. Such a flow is UNVERIFIED:
 * show it to the owner, but exclude it from TWR neutralization and day-P&L adjustment.
 * The 2%-of-equity floor keeps genuine small transfers verified even on flat-equity days
 * (e.g. a $500 deposit offset by a same-day market dip on a $100k book). Pure.
 */
export function isInferredFlowUnverified(flow: number, startEquity: number, endEquity: number): boolean {
  if (!Number.isFinite(flow) || flow === 0) return false;
  if (!Number.isFinite(startEquity) || !Number.isFinite(endEquity)) return true;
  const deltaEquity = endEquity - startEquity;
  const bound = Math.max(
    FLOW_SANITY_EQUITY_DELTA_MULT * Math.abs(deltaEquity),
    (FLOW_SANITY_PCT_OF_EQUITY / 100) * Math.max(startEquity, 0)
  );
  return Math.abs(flow) > bound;
}

type CurvePoint = {
  equity: number;
  cash?: number;
  positionsValue?: number;
  timestampMs: number;
};

function materialityThreshold(priorEquity: number): number {
  return Math.max((FLOW_MATERIALITY_PCT_OF_EQUITY / 100) * Math.max(priorEquity, 0), FLOW_MATERIALITY_MIN_USD);
}

/** True when the snapshot is essentially all cash (no meaningful open positions). */
function isAllCash(p: CurvePoint): boolean {
  const threshold = materialityThreshold(p.equity);
  // Prefer cash ≈ equity. positionsValue has been wrong/double-counted in the past; when cash
  // says the book is fully liquid, treat it as all-cash even if positionsValue is noisy.
  if (typeof p.cash === "number" && Number.isFinite(p.cash)) {
    return Math.abs(p.cash - p.equity) <= Math.max(FLOW_MATERIALITY_MIN_USD, 0.01 * p.equity);
  }
  if (typeof p.positionsValue === "number" && Number.isFinite(p.positionsValue)) {
    return Math.abs(p.positionsValue) < threshold;
  }
  return false;
}

function hasCash(p: CurvePoint): p is CurvePoint & { cash: number } {
  return typeof p.cash === "number" && Number.isFinite(p.cash);
}

function hasPositions(p: CurvePoint): p is CurvePoint & { positionsValue: number } {
  return typeof p.positionsValue === "number" && Number.isFinite(p.positionsValue);
}

/**
 * Infer external deposits/withdrawals per calendar date from the equity curve and recorded fills.
 *
 * Every material external dollar move should appear here (deposits AND withdrawals, paper resets,
 * ACH). Market P&L and trade-driven cash↔stock conversions must NOT.
 *
 * Priority:
 *  1. All-cash → all-cash: equity delta IS the transfer (paper reset, full-cash ACH).
 *  2. Cash present: flow = Δcash − tradeCash (buy notional reduces cash, sell/cover increases it).
 *     Guards zero out cash↔stock conversions when fills are missing.
 *  3. Cash+positions both present and equity ≈ cash+positions: cross-check with
 *     flow ≈ Δequity − Δpositions − tradeCash (same identity when the balance sheet holds).
 *  4. Missing cash: only invent a transfer when both sides look flat and there was no trading.
 *
 * Returns a map keyed by the PERIOD-END snapshot date. Sign: deposit +, withdrawal −.
 * Pure — exported for direct unit testing.
 */
export function inferExternalCashFlows(
  equityCurve: EquityCurvePoint[],
  fills: FillEvent[] = []
): Map<string, number> {
  const flows = new Map<string, number>();
  // Collapse to one (last) point per calendar date, mirroring normalizeAgainstBenchmark.
  const byDate = new Map<string, CurvePoint>();
  for (const p of equityCurve) {
    const d = isoDate(p.timestamp);
    const t = new Date(p.timestamp).getTime();
    if (!d || !Number.isFinite(t)) continue;
    if (!Number.isFinite(p.equity) || p.equity <= 0) continue;
    const point: CurvePoint = { equity: p.equity, timestampMs: t };
    if (typeof p.cash === "number" && Number.isFinite(p.cash)) point.cash = p.cash;
    if (typeof p.positionsValue === "number" && Number.isFinite(p.positionsValue)) {
      point.positionsValue = p.positionsValue;
    }
    byDate.set(d, point);
  }
  const dates = [...byDate.keys()].sort();
  if (dates.length < 2) return flows;

  const sortedFills = fills
    .map((f) => ({ t: new Date(f.filledAt).getTime(), side: f.side, notional: f.notional }))
    .filter((f) => Number.isFinite(f.t) && Number.isFinite(f.notional))
    .sort((a, b) => a.t - b.t);

  for (let i = 1; i < dates.length; i++) {
    const prev = byDate.get(dates[i - 1])!;
    const cur = byDate.get(dates[i])!;
    const threshold = materialityThreshold(prev.equity);
    const deltaEquity = cur.equity - prev.equity;

    // Trade cash in the gap: buys/shorts reduce cash (negative), sells/covers increase it.
    let tradeNotionalAbs = 0;
    let tradeCash = 0;
    for (const f of sortedFills) {
      if (f.t <= prev.timestampMs) continue;
      if (f.t > cur.timestampMs) break;
      tradeNotionalAbs += Math.abs(f.notional);
      // Short sale credits cash (+); cover and buy debit cash (−). Sell credits (+).
      tradeCash += f.side === "sell" || f.side === "short" ? f.notional : -f.notional;
    }

    // ── 1. All-cash books: any equity move is a transfer (deposit or withdrawal / reset). ──
    if (isAllCash(prev) && isAllCash(cur)) {
      if (Math.abs(deltaEquity) >= threshold) flows.set(dates[i], round2(deltaEquity));
      continue;
    }

    // ── 2. Cash present: primary identity flow = Δcash − tradeCash. ──
    // Deposits: Δcash > 0 (and usually Δequity > 0). Withdrawals: Δcash < 0 (and usually Δequity < 0).
    // Trade-driven cash↔stock is removed via tradeCash or the missing-fill guards below.
    if (hasCash(prev) && hasCash(cur)) {
      const deltaCash = cur.cash - prev.cash;
      let flow = deltaCash - tradeCash;

      // Missing-fill guards: without trade receipts, a cash→stock conversion looks like a withdrawal.
      if (Math.abs(tradeCash) < 1e-9) {
        const deltaPos =
          hasPositions(prev) && hasPositions(cur) ? cur.positionsValue - prev.positionsValue : null;

        if (Math.abs(deltaCash) >= threshold && Math.abs(deltaEquity) < threshold) {
          // Cash moved, equity didn't — bought/sold positions, not a transfer.
          flow = 0;
        } else if (
          deltaPos != null &&
          ((deltaCash < -threshold && deltaPos > threshold) || (deltaCash > threshold && deltaPos < -threshold))
        ) {
          // Cash and positions moved in opposite directions — usually a trade (cash↔stock).
          // Without fills we cannot see the trade notional, so a pure conversion would look
          // like a withdrawal (cash down) or deposit (cash up). Default: flow = 0.
          //
          // Exceptions — concurrent EXTERNAL capital with trading in the same sparse gap
          // (common on paper accounts: deposit then invest between rare snapshots):
          //   1. Large cash+equity drop while positions only absorb a fraction of the cash
          //      (withdraw most, leave/invest a remainder) → flow ≈ Δequity (withdrawal).
          //   2. Material residual equity change vs the cash↔stock swap size → transfer
          //      dominates (deposit then buy, or sell then withdraw). Pure trade + modest
          //      mark-to-market keeps |Δequity| small vs the swap, so flow stays 0.
          const swapped = Math.min(Math.abs(deltaCash), Math.abs(deltaPos));
          const residualIsTransfer =
            Math.abs(deltaEquity) >= Math.max(threshold, 0.25 * swapped);
          if (
            deltaCash < -threshold &&
            deltaEquity < -threshold &&
            deltaPos >= -threshold &&
            Math.abs(deltaCash) > Math.abs(deltaPos) * 2
          ) {
            flow = deltaEquity;
          } else if (residualIsTransfer) {
            // Deposit+invest (Δequity ≈ deposit) or sell+withdraw: neutralize the external $
            // so TWR does not report e.g. 66k→99k as +50% alpha vs SPY.
            flow = deltaEquity;
          } else {
            flow = 0;
          }
        } else if (Math.abs(deltaCash - deltaEquity) < threshold) {
          // Cash and equity moved together (same direction & size) — pure deposit/withdrawal.
          // Covers: withdraw cash (both down), deposit cash (both up), with or without open stock.
          flow = deltaEquity;
        }
      }

      if (Math.abs(flow) >= threshold) flows.set(dates[i], round2(flow));
      continue;
    }

    // ── 4. Missing cash metadata: only invent a transfer when both sides look flat and no trades. ──
    // (Otherwise mark-to-market would be misread as ACH.)
    const prevFlat = hasPositions(prev) ? Math.abs(prev.positionsValue) < threshold : true;
    const curFlat = hasPositions(cur) ? Math.abs(cur.positionsValue) < threshold : true;
    if (prevFlat && curFlat && tradeNotionalAbs < threshold && Math.abs(deltaEquity) >= threshold) {
      flows.set(dates[i], round2(deltaEquity));
    }
  }
  return flows;
}

/**
 * Capital-adjusted account return over a window (%):
 *   (V_end − V_start − netExternalFlows) / V_start × 100
 *
 * Deposits (+) and withdrawals (−) in `netExternalFlows` are stripped so only market P&L remains.
 * This is the intuitive "I started with $100k, took out $10k, have $88k → lost $2k = −2%" figure.
 * Distinct from multi-period TWR (which chains sub-period returns). Pure.
 */
export function capitalAdjustedReturnPct(
  startEquity: number,
  endEquity: number,
  netExternalFlows: number
): number | null {
  if (!(startEquity > 0) || !Number.isFinite(startEquity) || !Number.isFinite(endEquity)) return null;
  if (!Number.isFinite(netExternalFlows)) netExternalFlows = 0;
  return round2(((endEquity - startEquity - netExternalFlows) / startEquity) * 100);
}
