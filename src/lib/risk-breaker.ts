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

/**
 * An equity drop the recorder could not explain on the run it happened (no deposit/withdrawal
 * on the broker ledger, or the ledger unreadable).  The next run is the follow-up: if the
 * withdrawal has posted by then it is applied from `fromEquity` (the pre-drop equity), exactly
 * as if the ledger had been current.  `resolved` marks a follow-up that already ran, so one
 * baseline is never deferred twice.
 */
export interface PendingEquityDrop {
  fromEquity: number;
  at: string;
  resolved?: boolean;
}

export interface DrawdownHwmObservation {
  equity: number;
  at: string;
  appliedActivityIds?: string[];
  pendingDrop?: PendingEquityDrop;
}

/**
 * A run-over-run equity fall at least this large with NO external flow on the ledger is treated
 * as "not yet explained": the breaker still reports the breach, but an opted-in hard action
 * (close_only / halted) is held as advisory for ONE run so a withdrawal whose ledger row posts a
 * little after the balance moves cannot halt the account.  A real loss is enforced on the next
 * run.  Losses this fast between two consecutive runs are rare; external cash-outs are not.
 */
export const UNEXPLAINED_EQUITY_DROP_PCT = 20;

export interface UnexplainedEquityChange {
  fromEquity: number;
  toEquity: number;
  dropPct: number;
  /** When the prior (pre-drop) observation was taken. */
  since: string;
  /** True when the broker ledger could not be read this run (vs. read and empty). */
  flowsUnavailable: boolean;
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

export interface DailyEquityForHwm {
  day: string;
  equity: number;
}

export interface UnexplainedDailyEquityDrop {
  day: string;
  fromEquity: number;
  toEquity: number;
  dropPct: number;
}

/**
 * Rebuild the cash-flow-aware HWM by replaying Alpaca's own daily closes alongside the ledger.
 *
 * Why not the flow-only replay above: it scales a withdrawal against the RECONSTRUCTED book
 * (sum of flows), which ignores trading P&L.  For a near-total cash-out that residual dwarfs the
 * real one — the Roth IRA shape (deposit $101.62, trading drift to $98.00, withdrawals of $69.65
 * and $26.77, balance $1.68) replays to an HWM of ≈ $5.20, a phantom ≈ 68% drawdown.  Using the
 * actual prior close as `equityBeforeFlow` gives ≈ $1.74 (≈ 3.5%, the real trading drift).
 *
 * Per day, in order: apply that day's net flow against the previous close, then ratchet to the
 * day's close.  Alpaca dates a withdrawal on the day its close reflects it, so the pairing is
 * day-consistent.  Also reports each close-to-close fall ≥ UNEXPLAINED_EQUITY_DROP_PCT on a day
 * with no counted flow — the honest signal that a withdrawal is missing from the ledger (or that
 * the account really lost that much).
 */
export function replayHighWaterMarkFromDailyHistory(args: {
  flows: Array<{ day: string; amount: number }>;
  dailyEquity: DailyEquityForHwm[];
  currentEquity: number;
}): { highWaterMark: number; netTransfers: number; unexplainedDrops: UnexplainedDailyEquityDrop[] } {
  const flowByDay = new Map<string, number>();
  for (const flow of args.flows) {
    if (!flow.day || !Number.isFinite(flow.amount) || flow.amount === 0) continue;
    flowByDay.set(flow.day, round2((flowByDay.get(flow.day) ?? 0) + flow.amount));
  }
  const equityByDay = new Map<string, number>();
  for (const point of args.dailyEquity) {
    if (!point.day || !Number.isFinite(point.equity)) continue;
    equityByDay.set(point.day, point.equity);
  }
  const days = [...new Set([...flowByDay.keys(), ...equityByDay.keys()])].sort();

  let hwm = 0;
  let lastEquity = 0;
  let prevClose: number | undefined;
  let netTransfers = 0;
  const unexplainedDrops: UnexplainedDailyEquityDrop[] = [];
  for (const day of days) {
    const flow = flowByDay.get(day) ?? 0;
    if (flow !== 0) {
      netTransfers = round2(netTransfers + flow);
      hwm = adjustHighWaterMarkForExternalFlow({ highWaterMark: hwm, equityBeforeFlow: lastEquity, flow });
      lastEquity = round2(lastEquity + flow);
    }
    const close = equityByDay.get(day);
    if (close === undefined) continue;
    if (flow === 0 && prevClose !== undefined && prevClose > 0) {
      const dropPct = ((prevClose - close) / prevClose) * 100;
      if (dropPct >= UNEXPLAINED_EQUITY_DROP_PCT) {
        unexplainedDrops.push({ day, fromEquity: round2(prevClose), toEquity: round2(close), dropPct: round2(dropPct) });
      }
    }
    lastEquity = close;
    prevClose = close;
    if (close > hwm) hwm = close;
  }
  const current = Number.isFinite(args.currentEquity) ? args.currentEquity : 0;
  return { highWaterMark: round2(Math.max(hwm, current, 0)), netTransfers, unexplainedDrops };
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

export type DrawdownBreakerRecordResult = DrawdownBreakerResult & {
  highWaterMark: number;
  startOfDayEquity: number;
  /** Sum of external flows applied to the HWM this run (deposit +, withdrawal −). */
  appliedExternalFlowTotal: number;
  /** The broker ledger could not be read this run (fetch failed / timed out / no credential). */
  flowsUnavailable: boolean;
  /** Present when equity fell ≥ UNEXPLAINED_EQUITY_DROP_PCT since the last run with no ledger flow. */
  unexplainedEquityChange?: UnexplainedEquityChange;
  /**
   * True when a breach coincides with an unexplained drop: the caller should hold an opted-in
   * hard action (close_only / halted) as advisory for this one run.  Never true twice in a row
   * for the same baseline, so a real loss is enforced on the next run.
   */
  deferHardAction: boolean;
};

/**
 * Update the persisted high-water mark and day-start equity for (account, source), then evaluate
 * the breaker. The breaker only fires when the relevant riskRules limit is configured, so this is
 * a no-op for accounts that haven't opted into a circuit breaker.
 *
 * When `externalFlows` are supplied AND a prior observation exists, HWM is adjusted for those
 * flows before the equity ratchet. First observation after deploy records a cursor and does not
 * replay the historical ledger (use the ops recompute heal for a stuck mark).
 *
 * Honesty (2026-09-24): a run-over-run fall ≥ UNEXPLAINED_EQUITY_DROP_PCT with no ledger flow is
 * reported as `unexplainedEquityChange` and recorded as a pending drop.  On the follow-up run a
 * newly posted withdrawal that accounts for the drop is applied against the PRE-drop equity, so a
 * cash-out whose ledger row lagged the balance is still fully neutralized instead of being read
 * as a trading loss.
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
  /** The caller could not read the broker ledger this run (surfaced, never treated as "no flows"). */
  flowsUnavailable?: boolean;
}): DrawdownBreakerRecordResult {
  const { accountNumber, source, equity, riskRules, userId } = args;
  const now = args.now ?? new Date();
  const day = centralTradingDayKey(now);
  const advanceObservation = args.advanceObservation !== false;
  const flowsUnavailable = args.flowsUnavailable === true;
  const externalFlows = (args.externalFlows ?? []).filter((flow) => Number.isFinite(flow.amount) && flow.amount !== 0);
  const hasFlows = externalFlows.length > 0;
  // Only accounts with a broker cash-flow ledger (the caller passed flows, even an empty list, or
  // tried and failed to read them) can have a withdrawal "not posted yet".  Accounts with no
  // ledger at all (non-Alpaca brokers) keep the plain ratchet: deferring there resolves nothing.
  const ledgerTracked = args.externalFlows !== undefined || flowsUnavailable;

  const prevHwm = getInternalSetting<number>(hwmKey(userId, accountNumber, source));
  const prevObs = getInternalSetting<DrawdownHwmObservation>(hwmObsKey(userId, accountNumber, source));
  const pending = prevObs?.pendingDrop && !prevObs.pendingDrop.resolved ? prevObs.pendingDrop : undefined;
  let adjustedHwm = Number.isFinite(prevHwm) ? (prevHwm as number) : equity;
  let appliedExternalFlowTotal = 0;
  if (Number.isFinite(prevHwm) && prevObs && hasFlows) {
    const observedEquity = Number.isFinite(prevObs.equity) ? prevObs.equity : (prevHwm as number);
    let lastEquity = observedEquity;
    if (pending && Number.isFinite(pending.fromEquity)) {
      // A pending drop may be a withdrawal whose ledger row posted after the balance moved.  Apply
      // the flow against the PRE-drop equity only when that is the reading the numbers support
      // (pre-drop + flow ≈ the post-drop observation); a real loss followed by a later cash-out
      // keeps the observed base, so a loss is never laundered into a "withdrawal".
      const netFlow = externalFlows.reduce((sum, flow) => sum + flow.amount, 0);
      const missViaPending = Math.abs(pending.fromEquity + netFlow - observedEquity);
      const missViaObserved = Math.abs(observedEquity + netFlow - equity);
      if (missViaPending < missViaObserved) lastEquity = pending.fromEquity;
    }
    adjustedHwm = applyExternalFlowsToHighWaterMark({
      highWaterMark: prevHwm as number,
      equityBeforeFlows: lastEquity,
      flows: externalFlows.map((flow) => flow.amount)
    });
    appliedExternalFlowTotal = round2(externalFlows.reduce((sum, flow) => sum + flow.amount, 0));
  }
  const highWaterMark = round2(Math.max(adjustedHwm, equity));
  if (highWaterMark !== prevHwm) setInternalSetting(hwmKey(userId, accountNumber, source), highWaterMark);

  // Unexplained drop: equity fell hard since the last observation and the ledger shows nothing
  // (or could not be read).  Skipped while a pending drop is being followed up, and skipped when
  // this exact baseline was already deferred once (a stuck ledger must not defer forever).
  let unexplainedEquityChange: UnexplainedEquityChange | undefined;
  let nextPending: PendingEquityDrop | undefined;
  const baselineAlreadyDeferred = Boolean(prevObs?.pendingDrop && prevObs.pendingDrop.at === prevObs.at);
  if (
    ledgerTracked &&
    prevObs &&
    !hasFlows &&
    !pending &&
    !baselineAlreadyDeferred &&
    Number.isFinite(prevObs.equity) &&
    prevObs.equity > 0
  ) {
    const dropPct = ((prevObs.equity - equity) / prevObs.equity) * 100;
    if (dropPct >= UNEXPLAINED_EQUITY_DROP_PCT) {
      unexplainedEquityChange = {
        fromEquity: round2(prevObs.equity),
        toEquity: round2(equity),
        dropPct: round2(dropPct),
        since: prevObs.at,
        flowsUnavailable
      };
      nextPending = { fromEquity: prevObs.equity, at: prevObs.at };
    }
  }

  let startOfDayEquity = getInternalSetting<number>(sodKey(userId, accountNumber, source, day));
  if (!Number.isFinite(startOfDayEquity)) {
    startOfDayEquity = equity;
    setInternalSetting(sodKey(userId, accountNumber, source, day), startOfDayEquity);
  } else if (prevObs && hasFlows) {
    const todayNet = externalFlows.reduce((sum, flow) => {
      if (flow.day && flow.day !== day) return sum;
      return sum + flow.amount;
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
      appliedActivityIds: appliedActivityIds.slice(-500),
      ...(nextPending ? { pendingDrop: nextPending } : {})
    } satisfies DrawdownHwmObservation);
  } else if (prevObs && (nextPending || pending)) {
    // Keep the retry cursor (equity/at/applied ids) untouched, but record the new pending drop or
    // mark the followed-up one resolved so the same baseline is not deferred again.
    setInternalSetting(hwmObsKey(userId, accountNumber, source), {
      ...prevObs,
      pendingDrop: nextPending ?? { ...(pending as PendingEquityDrop), resolved: true }
    } satisfies DrawdownHwmObservation);
  }

  const result = evaluateDrawdownBreaker({
    equity,
    highWaterMark,
    startOfDayEquity: startOfDayEquity as number,
    maxDrawdownPct: riskRules.maxDrawdownPct,
    maxDailyLossNotional: riskRules.maxDailyLossNotional
  });

  const deferHardAction = result.breached && Boolean(unexplainedEquityChange);
  let reason = result.reason;
  if (result.breached && reason) {
    if (unexplainedEquityChange) {
      reason += ` Equity fell ${unexplainedEquityChange.dropPct.toFixed(2)}% since the last run with no deposit or withdrawal on the broker ledger${
        flowsUnavailable ? " (ledger unreadable this run)" : ""
      } — possibly a withdrawal that has not posted yet; any hard action is held as advisory for one run.`;
    } else if (flowsUnavailable) {
      reason += " The broker cash-flow ledger could not be read this run, so a recent deposit or withdrawal may not be reflected.";
    }
  }

  return {
    ...result,
    ...(reason !== undefined ? { reason } : {}),
    highWaterMark,
    startOfDayEquity: startOfDayEquity as number,
    appliedExternalFlowTotal,
    flowsUnavailable,
    ...(unexplainedEquityChange ? { unexplainedEquityChange } : {}),
    deferHardAction
  };
}
