// Account-level circuit breaker (drawdown + daily-loss kill-switch).
//
// The per-trade/per-symbol policy gate bounds the size of any ONE mistake; it does not bound
// the account's total bleed. This module adds that missing brake: a trailing-drawdown and a
// daily-loss limit that, when breached, halt NEW entries (the caller flips systemState to
// "close_only", which still allows risk-reducing exits) and fire a kill-switch notification.
//
// `evaluateDrawdownBreaker` is pure (unit-tested in isolation). `recordAndEvaluateDrawdownBreaker`
// is the stateful wrapper: it maintains the per-account/source equity high-water mark and the
// day's starting equity in the quiet internal settings KV (no audit spam), then evaluates.

import { round2 } from "./cash-flows";
import { getInternalSetting, setInternalSetting } from "./db";
import { centralTradingDayKey } from "./trading-day";
import type { FillSource, Portfolio, RiskRules } from "./types";

export interface DrawdownBreakerInputs {
  /** Current account equity (net liquidation value). */
  equity: number;
  /** Highest equity observed since tracking began (peak). */
  highWaterMark: number;
  /** Account equity at the start of the current trading day. */
  startOfDayEquity: number;
  maxDrawdownPct?: number;
  maxDailyLossNotional?: number;
}

export interface DrawdownBreakerResult {
  breached: boolean;
  reason?: string;
}

/** Net liquidation value. Prefer the composed cash + market value; fall back to totalMarketValue. */
export function accountEquity(portfolio: Pick<Portfolio, "cash" | "equityMarketValue" | "optionMarketValue" | "totalMarketValue">): number {
  const composed = (portfolio.cash ?? 0) + (portfolio.equityMarketValue ?? 0) + (portfolio.optionMarketValue ?? 0);
  if (Number.isFinite(composed) && composed > 0) return composed;
  return portfolio.totalMarketValue ?? 0;
}

/** Pure breaker evaluation. Returns the first breach found (drawdown takes priority). */
export function evaluateDrawdownBreaker(input: DrawdownBreakerInputs): DrawdownBreakerResult {
  const { equity, highWaterMark, startOfDayEquity, maxDrawdownPct, maxDailyLossNotional } = input;

  if (maxDrawdownPct && maxDrawdownPct > 0 && highWaterMark > 0) {
    const drawdownPct = ((highWaterMark - equity) / highWaterMark) * 100;
    if (drawdownPct >= maxDrawdownPct) {
      return {
        breached: true,
        reason: `Trailing drawdown ${drawdownPct.toFixed(2)}% from the equity high-water mark $${highWaterMark.toFixed(2)} breached the ${maxDrawdownPct}% limit.`
      };
    }
  }

  if (maxDailyLossNotional && maxDailyLossNotional > 0 && startOfDayEquity > 0) {
    const dailyLoss = startOfDayEquity - equity;
    if (dailyLoss >= maxDailyLossNotional) {
      return {
        breached: true,
        reason: `Today's loss $${dailyLoss.toFixed(2)} (from start-of-day equity $${startOfDayEquity.toFixed(2)}) breached the $${maxDailyLossNotional} daily-loss limit.`
      };
    }
  }

  return { breached: false };
}

const hwmKey = (userId: string, accountNumber: string, source: FillSource) => `risk:hwm:${userId}:${accountNumber}:${source}`;
const hwmObsKey = (userId: string, accountNumber: string, source: FillSource) => `risk:hwm-obs:${userId}:${accountNumber}:${source}`;
const sodKey = (userId: string, accountNumber: string, source: FillSource, day: string) => `risk:sod:${userId}:${accountNumber}:${source}:${day}`;

export interface ExternalCashFlowForHwm {
  /** Signed dollars: deposit +, withdrawal −. */
  amount: number;
  /** Central trading-day key; used to adjust start-of-day equity for same-day transfers. */
  day?: string;
}

export interface DrawdownHwmObservation {
  equity: number;
  at: string;
  appliedActivityIds?: string[];
}

/**
 * Adjust a trailing equity high-water mark for one external cash flow.
 *
 * Deposits raise HWM by the dollars added (new capital is not a trading peak, but it must
 * not erase an existing drawdown). Withdrawals scale HWM by remaining/prior equity so a
 * cash-out at the peak stays 0% drawdown and a cash-out in a hole keeps the same percentage.
 * Matches Results/TWR neutralization: V_end − V_start − flow is market P&L.
 */
export function adjustHighWaterMarkForExternalFlow(args: {
  highWaterMark: number;
  equityBeforeFlow: number;
  flow: number;
}): number {
  const hwm = args.highWaterMark;
  const equityBefore = args.equityBeforeFlow;
  const flow = args.flow;
  if (!Number.isFinite(flow) || flow === 0) return Number.isFinite(hwm) ? hwm : 0;
  if (flow > 0) {
    const base = Number.isFinite(hwm) && hwm > 0 ? hwm : Math.max(0, Number.isFinite(equityBefore) ? equityBefore : 0);
    return round2(base + flow);
  }
  if (Number.isFinite(equityBefore) && equityBefore > 0) {
    const remaining = equityBefore + flow;
    if (remaining <= 0) return 0;
    const base = Number.isFinite(hwm) && hwm > 0 ? hwm : equityBefore;
    return round2(base * (remaining / equityBefore));
  }
  const base = Number.isFinite(hwm) ? hwm : 0;
  return round2(Math.max(0, base + flow));
}

/** Apply signed flows in order, updating a synthetic book so later flows see prior transfers. */
export function applyExternalFlowsToHighWaterMark(args: {
  highWaterMark: number;
  equityBeforeFlows: number;
  flows: number[];
}): number {
  let hwm = args.highWaterMark;
  let equity = args.equityBeforeFlows;
  for (const flow of args.flows) {
    if (!Number.isFinite(flow) || flow === 0) continue;
    hwm = adjustHighWaterMarkForExternalFlow({ highWaterMark: hwm, equityBeforeFlow: equity, flow });
    equity = round2(equity + flow);
  }
  return hwm;
}

/**
 * Rebuild a cash-flow-aware HWM from a chronological transfer ledger plus current equity.
 * Starts at $0 invested, applies each signed flow, then ratchets to current equity so leftover
 * trading P&L is a peak (gain) or a drawdown (loss). Does not reconstruct intra-period trading
 * peaks that were later withdrawn — that needs the live recorder, not a ledger replay.
 */
export function recomputeHighWaterMarkFromTransferFlows(args: {
  flows: number[];
  currentEquity: number;
}): { highWaterMark: number; netTransfers: number; reconstructedEquity: number } {
  let equity = 0;
  let hwm = 0;
  let netTransfers = 0;
  for (const flow of args.flows) {
    if (!Number.isFinite(flow) || flow === 0) continue;
    netTransfers = round2(netTransfers + flow);
    hwm = adjustHighWaterMarkForExternalFlow({ highWaterMark: hwm, equityBeforeFlow: equity, flow });
    equity = round2(equity + flow);
    if (equity > hwm) hwm = equity;
  }
  const current = Number.isFinite(args.currentEquity) ? args.currentEquity : 0;
  const highWaterMark = round2(Math.max(hwm, current, 0));
  return { highWaterMark, netTransfers, reconstructedEquity: equity };
}

export function impliedDrawdownPct(equity: number, highWaterMark: number): number {
  if (!(highWaterMark > 0) || !Number.isFinite(equity)) return 0;
  return round2(((highWaterMark - equity) / highWaterMark) * 100);
}

export function readDrawdownHwmObservation(
  userId: string,
  accountNumber: string,
  source: FillSource
): DrawdownHwmObservation | undefined {
  return getInternalSetting<DrawdownHwmObservation>(hwmObsKey(userId, accountNumber, source));
}

export function persistDrawdownHighWaterMark(args: {
  userId: string;
  accountNumber: string;
  source: FillSource;
  highWaterMark: number;
  observation?: DrawdownHwmObservation;
}): void {
  setInternalSetting(hwmKey(args.userId, args.accountNumber, args.source), args.highWaterMark);
  if (args.observation) {
    setInternalSetting(hwmObsKey(args.userId, args.accountNumber, args.source), args.observation);
  }
}

/**
 * Update the persisted high-water mark and day-start equity for (account, source), then evaluate
 * the breaker. The breaker only fires when the relevant riskRules limit is configured, so this is
 * a no-op for accounts that haven't opted into a circuit breaker.
 *
 * When `externalFlows` are supplied AND a prior observation exists, HWM is adjusted for those
 * flows before the equity ratchet. First observation after deploy records a cursor and does not
 * replay the historical ledger (use the ops recompute heal for a stuck mark).
 */
export function recordAndEvaluateDrawdownBreaker(args: {
  accountNumber: string;
  source: FillSource;
  equity: number;
  riskRules: RiskRules;
  userId: string;
  now?: Date;
  externalFlows?: ExternalCashFlowForHwm[];
  appliedActivityIds?: string[];
  /** When false, persist HWM but leave the observation cursor so a failed broker fetch can retry. */
  advanceObservation?: boolean;
}): DrawdownBreakerResult & { highWaterMark: number; startOfDayEquity: number } {
  const { accountNumber, source, equity, riskRules, userId } = args;
  const now = args.now ?? new Date();
  const day = centralTradingDayKey(now);
  const advanceObservation = args.advanceObservation !== false;

  const prevHwm = getInternalSetting<number>(hwmKey(userId, accountNumber, source));
  const prevObs = getInternalSetting<DrawdownHwmObservation>(hwmObsKey(userId, accountNumber, source));
  let adjustedHwm = Number.isFinite(prevHwm) ? (prevHwm as number) : equity;
  if (
    Number.isFinite(prevHwm) &&
    prevObs &&
    args.externalFlows &&
    args.externalFlows.length > 0
  ) {
    const lastEquity = Number.isFinite(prevObs.equity) ? prevObs.equity : (prevHwm as number);
    adjustedHwm = applyExternalFlowsToHighWaterMark({
      highWaterMark: prevHwm as number,
      equityBeforeFlows: lastEquity,
      flows: args.externalFlows.map((flow) => flow.amount)
    });
  }
  const highWaterMark = round2(Math.max(adjustedHwm, equity));
  if (highWaterMark !== prevHwm) setInternalSetting(hwmKey(userId, accountNumber, source), highWaterMark);

  let startOfDayEquity = getInternalSetting<number>(sodKey(userId, accountNumber, source, day));
  if (!Number.isFinite(startOfDayEquity)) {
    startOfDayEquity = equity;
    setInternalSetting(sodKey(userId, accountNumber, source, day), startOfDayEquity);
  } else if (prevObs && args.externalFlows && args.externalFlows.length > 0) {
    const todayNet = args.externalFlows.reduce((sum, flow) => {
      if (flow.day && flow.day !== day) return sum;
      return sum + (Number.isFinite(flow.amount) ? flow.amount : 0);
    }, 0);
    if (todayNet !== 0) {
      startOfDayEquity = round2(Math.max(0, (startOfDayEquity as number) + todayNet));
      setInternalSetting(sodKey(userId, accountNumber, source, day), startOfDayEquity);
    }
  }

  if (advanceObservation) {
    const appliedActivityIds = args.appliedActivityIds ?? prevObs?.appliedActivityIds ?? [];
    setInternalSetting(hwmObsKey(userId, accountNumber, source), {
      equity,
      at: now.toISOString(),
      appliedActivityIds: appliedActivityIds.slice(-500)
    } satisfies DrawdownHwmObservation);
  }

  const result = evaluateDrawdownBreaker({
    equity,
    highWaterMark,
    startOfDayEquity: startOfDayEquity as number,
    maxDrawdownPct: riskRules.maxDrawdownPct,
    maxDailyLossNotional: riskRules.maxDailyLossNotional
  });

  return { ...result, highWaterMark, startOfDayEquity: startOfDayEquity as number };
}
