// Cash-flow-aware drawdown HWM: broker fetch + ops recompute orchestration.
// Pure adjustment math lives in risk-breaker.ts so unit tests do not need Alpaca.
//
// 2026-09-24 (board 687a5fb4): the Roth IRA recompute reported netTransfers 0 / transferCount 0
// after at least ~$96 had been withdrawn.  Two defects made that possible and both are fixed here:
//  1. The ledger was requested with an `activity_types` filter that carried "DIVTX" (not an
//     Alpaca type) and could not name every IRA cash type; any non-2xx was swallowed as `[]`.
//     Reads now use `category=non_trade_activity` (classified client-side in broker-cash-flows)
//     and a failed read is `flowsUnavailable`, never "no flows".
//  2. With no flows the recompute silently reset the HWM to current equity.  It now replays
//     Alpaca's own daily closes against the ledger, reports unexplained drops, and refuses to
//     "heal" from a ledger that cannot explain the account's equity unless the operator says so.

import { audit, findConnectedAccountById, getInternalSetting, setInternalSetting } from "./db";
import {
  fetchAlpacaAccountEquity,
  fetchAlpacaDailyEquityHistory,
  fetchAlpacaNonTradeActivities
} from "./alpaca-account-insights";
import {
  listAlpacaTransferFlows,
  summarizeNonTradeActivities,
  type ActivityTypeSummary
} from "./broker-cash-flows";
import { withDeadline } from "./inflight-deadline";
import {
  HWM_LEDGER_VERSION,
  impliedDrawdownPct,
  persistDrawdownHighWaterMark,
  readDrawdownHwmObservation,
  recomputeHighWaterMarkFromTransferFlows,
  replayHighWaterMarkFromDailyHistory,
  type ExternalCashFlowForHwm,
  type UnexplainedDailyEquityDrop
} from "./risk-breaker";
import { centralTradingDayKey } from "./trading-day";
import type { FillSource } from "./types";

const HWM_KEY = (userId: string, accountNumber: string, source: FillSource) =>
  `risk:hwm:${userId}:${accountNumber}:${source}`;

/** Re-read this many days before the cursor; applied-id dedupe makes the overlap safe. */
const INCREMENTAL_LEDGER_OVERLAP_DAYS = 2;
const RECOMPUTE_LEDGER_MAX_PAGES = 50;
const RECOMPUTE_HISTORY_FALLBACK_YEARS = 5;

export interface DrawdownCashFlowLoad {
  externalFlows: ExternalCashFlowForHwm[];
  appliedActivityIds: string[];
  advanceObservation: boolean;
  /** The ledger could not be read (HTTP/transport error, timeout).  Never means "no flows". */
  flowsUnavailable?: boolean;
  /** Short, secret-free reason when `flowsUnavailable`. */
  flowsError?: string;
  /** Non-trade activity types in the fetched window that we do not recognize (surfaced, not applied). */
  unclassifiedActivityTypes?: string[];
  /** Set on a successful ledger read; the recorder stamps it on the observation it writes. */
  ledgerVersion?: number;
}

function fillSourceForAccountEnvironment(environment: "paper" | "live" | string | undefined): FillSource {
  return environment === "live" ? "live" : "paper";
}

function isoDayMinus(isoOrDay: string, days: number): string | undefined {
  const parsed = Date.parse(isoOrDay.length === 10 ? `${isoOrDay}T12:00:00Z` : isoOrDay);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Once per (account, source, day): audit non-trade types we could not classify. */
function auditUnclassifiedOncePerDay(args: {
  userId: string;
  accountNumber: string;
  source: FillSource;
  connectedAccountId: string;
  unclassified: ActivityTypeSummary[];
}): void {
  if (args.unclassified.length === 0) return;
  try {
    const day = centralTradingDayKey(new Date());
    const key = `risk:hwm-unclassified-audited:${args.userId}:${args.accountNumber}:${args.source}:${day}`;
    if (getInternalSetting<string>(key)) return;
    audit(
      "risk_hwm_unclassified_activity",
      {
        accountNumber: args.accountNumber,
        source: args.source,
        note: "Non-trade Alpaca activity types the drawdown HWM does not recognize; their dollars were NOT applied as deposits or withdrawals.",
        types: args.unclassified.map((entry) => ({
          activityType: entry.activityType,
          count: entry.count,
          netAmount: entry.netAmount,
          lastDay: entry.lastDay
        }))
      },
      args.userId,
      args.connectedAccountId
    );
    setInternalSetting(key, new Date().toISOString());
  } catch (error) {
    console.warn("[risk-hwm] unclassified-activity audit failed (non-fatal):", error);
  }
}

/**
 * Incremental flows for the live recorder. First observation after deploy marks current
 * ledger ids as applied without adjusting HWM (ops recompute heals a stuck historical mark).
 * An observation without the current `ledgerVersion` counts as a first observation too: it was
 * written while the old typed-filter read was failing, so its applied-id list is empty and the
 * overlap window would otherwise re-apply rows the HWM ratchet already absorbed.
 * A broker fetch failure returns advanceObservation: false + flowsUnavailable so the cursor can
 * retry and the breaker can say the ledger was unreadable instead of assuming "no transfers".
 */
export async function loadCashFlowsForDrawdownBreaker(args: {
  userId: string;
  accountNumber: string;
  source: FillSource;
  connectedAccountId?: string;
}): Promise<DrawdownCashFlowLoad | undefined> {
  if (!args.connectedAccountId) return undefined;
  const account = findConnectedAccountById(args.connectedAccountId);
  if (!account || account.userId !== args.userId) return undefined;
  if (account.broker !== "alpaca" && account.broker !== "alpaca-mcp") return undefined;
  if (!account.apiKey) return undefined;

  try {
    const prevObs = readDrawdownHwmObservation(args.userId, args.accountNumber, args.source);
    // Read from the earlier of the last observation and an unresolved pending drop, minus a small
    // overlap: Alpaca's date-only `after` boundary is not documented as inclusive, and a flow on
    // the cursor's own day must not be skipped.
    const pendingAt = prevObs?.pendingDrop && !prevObs.pendingDrop.resolved ? prevObs.pendingDrop.at : undefined;
    const cursor = [prevObs?.at, pendingAt].filter((v): v is string => Boolean(v)).sort()[0];
    const after = cursor ? isoDayMinus(cursor, INCREMENTAL_LEDGER_OVERLAP_DAYS) : undefined;
    const ledger = await withDeadline(
      fetchAlpacaNonTradeActivities(args.userId, {
        connectedAccountId: args.connectedAccountId,
        ...(after ? { after } : {})
      }),
      8_000,
      "drawdown HWM cash-flow fetch timeout"
    );
    if (!ledger.ok) {
      return {
        externalFlows: [],
        appliedActivityIds: [],
        advanceObservation: false,
        flowsUnavailable: true,
        flowsError: ledger.error ?? "activity ledger read failed"
      };
    }
    const summary = summarizeNonTradeActivities(ledger.activities);
    auditUnclassifiedOncePerDay({
      userId: args.userId,
      accountNumber: args.accountNumber,
      source: args.source,
      connectedAccountId: args.connectedAccountId,
      unclassified: summary.unclassified
    });
    const unclassifiedActivityTypes = summary.unclassified.map((entry) => entry.activityType);
    const listed = listAlpacaTransferFlows(ledger.activities);
    if (!prevObs || prevObs.ledgerVersion !== HWM_LEDGER_VERSION) {
      return {
        externalFlows: [],
        appliedActivityIds: listed.map((flow) => flow.id).filter(Boolean).slice(-500),
        advanceObservation: true,
        ledgerVersion: HWM_LEDGER_VERSION,
        ...(unclassifiedActivityTypes.length > 0 ? { unclassifiedActivityTypes } : {})
      };
    }
    const applied = new Set(prevObs.appliedActivityIds ?? []);
    const fresh = listed.filter((flow) => flow.id && !applied.has(flow.id));
    const appliedActivityIds = [...applied, ...fresh.map((flow) => flow.id)].slice(-500);
    return {
      externalFlows: fresh.map((flow) => ({ amount: flow.amount, day: flow.day })),
      appliedActivityIds,
      advanceObservation: true,
      ledgerVersion: HWM_LEDGER_VERSION,
      ...(unclassifiedActivityTypes.length > 0 ? { unclassifiedActivityTypes } : {})
    };
  } catch (error) {
    return {
      externalFlows: [],
      appliedActivityIds: [],
      advanceObservation: false,
      flowsUnavailable: true,
      flowsError: error instanceof Error ? error.message.slice(0, 200) : "activity ledger read failed"
    };
  }
}

export type HwmRecomputeMethod = "daily-history" | "ledger-only";

export type HwmRecomputeResult =
  | {
      ok: true;
      connectedAccountId: string;
      accountNumber: string;
      source: FillSource;
      oldHwm: number | null;
      newHwm: number;
      equity: number;
      netTransfers: number;
      transferCount: number;
      impliedDrawdownPct: number;
      /** How the HWM was rebuilt: Alpaca daily closes + ledger (preferred) or the ledger alone. */
      method: HwmRecomputeMethod;
      /** Contributions / deposits / transfers in, and distributions / withdrawals / withholding out. */
      capitalIn: number;
      capitalOut: number;
      ledgerQuery: string;
      ledgerPages: number;
      ledgerTruncated: boolean;
      ledgerFallbackFrom?: string;
      /** Non-trade types we do not recognize.  Not applied — listed so a human can classify them. */
      unclassified: ActivityTypeSummary[];
      /** Close-to-close falls ≥ 20% on a day with no counted flow (daily-history method only). */
      unexplainedEquityChanges: UnexplainedDailyEquityDrop[];
      warnings: string[];
    }
  | {
      ok: false;
      error: string;
      status: number;
      /** The broker ledger could not be read; nothing was persisted. */
      flowsUnavailable?: boolean;
      /** The ledger read fine but cannot explain the account's equity; nothing was persisted. */
      unexplainedEquityChange?: {
        equity: number;
        capitalIn: number;
        reason: string;
        method: HwmRecomputeMethod;
        /** What would have been persisted with `acceptUnexplained: true`. */
        proposedHwm: number;
        proposedDrawdownPct: number;
        days: UnexplainedDailyEquityDrop[];
      };
      httpStatus?: number;
    };

export interface HwmRecomputeOptions {
  /**
   * Persist the replayed HWM even though some equity falls have no ledger flow (treats them as
   * real trading losses).
   */
  acceptUnexplained?: boolean;
  /**
   * Deliberately reset the HWM to current equity (treats every unexplained fall as an external
   * cash-out).  The explicit form of the pre-2026-09-24 silent fallback.
   */
  acceptEquityReset?: boolean;
  now?: Date;
}

export async function recomputeConnectedAccountHighWaterMark(
  connectedAccountId: string,
  opts: HwmRecomputeOptions = {}
): Promise<HwmRecomputeResult> {
  const account = findConnectedAccountById(connectedAccountId);
  if (!account) return { ok: false, error: "connectedAccountId not found", status: 404 };
  if (account.broker !== "alpaca" && account.broker !== "alpaca-mcp") {
    return { ok: false, error: "connected account is not Alpaca", status: 400 };
  }
  if (!account.apiKey) {
    return { ok: false, error: "connected account has no private Alpaca credentials", status: 400 };
  }
  const accountNumber = account.accountNumber?.trim();
  if (!accountNumber) {
    return { ok: false, error: "connected account has no accountNumber", status: 400 };
  }

  const now = opts.now ?? new Date();
  const source = fillSourceForAccountEnvironment(account.environment);
  const userId = account.userId;
  const snapshot = await fetchAlpacaAccountEquity(userId, { connectedAccountId: account.id });
  if (!snapshot || !Number.isFinite(snapshot.equity)) {
    return { ok: false, error: "failed to read Alpaca equity", status: 502 };
  }

  const ledger = await fetchAlpacaNonTradeActivities(userId, {
    connectedAccountId: account.id,
    maxPages: RECOMPUTE_LEDGER_MAX_PAGES
  });
  if (!ledger.ok) {
    // Honest failure: an unreadable ledger is NOT "no transfers", so do not touch the HWM.
    return {
      ok: false,
      status: 502,
      flowsUnavailable: true,
      error: `Alpaca activity ledger unavailable; HWM not changed (${ledger.error ?? "read failed"})`,
      ...(ledger.httpStatus !== undefined ? { httpStatus: ledger.httpStatus } : {})
    };
  }

  const summary = summarizeNonTradeActivities(ledger.activities);
  const flows = listAlpacaTransferFlows(ledger.activities);
  const warnings: string[] = [];
  if (ledger.truncated) {
    warnings.push(
      `Ledger paging stopped at ${ledger.pages} pages; older activities may be missing, so earlier deposits/withdrawals are not in this replay.`
    );
  }
  if (summary.unclassified.length > 0) {
    warnings.push(
      `Unrecognized non-trade activity types were NOT applied: ${summary.unclassified.map((entry) => entry.activityType).join(", ")}.`
    );
  }

  const earliestFlowDay = flows[0]?.day;
  const historyStartDay = earliestFlowDay
    ? isoDayMinus(earliestFlowDay, 3)
    : isoDayMinus(now.toISOString(), RECOMPUTE_HISTORY_FALLBACK_YEARS * 365);
  const history = historyStartDay
    ? await fetchAlpacaDailyEquityHistory(userId, {
        connectedAccountId: account.id,
        start: `${historyStartDay}T00:00:00Z`,
        end: now.toISOString()
      })
    : undefined;

  let method: HwmRecomputeMethod;
  let highWaterMark: number;
  let netTransfers: number;
  let unexplainedEquityChanges: UnexplainedDailyEquityDrop[] = [];
  let unexplainedReason: string | undefined;
  if (history && history.length > 0) {
    method = "daily-history";
    const replay = replayHighWaterMarkFromDailyHistory({
      flows: flows.map((flow) => ({ day: flow.day, amount: flow.amount })),
      dailyEquity: history,
      currentEquity: snapshot.equity
    });
    highWaterMark = replay.highWaterMark;
    netTransfers = replay.netTransfers;
    unexplainedEquityChanges = replay.unexplainedDrops;
    if (unexplainedEquityChanges.length > 0) {
      unexplainedReason = `${unexplainedEquityChanges.length} day(s) show a close-to-close fall of 20% or more with no deposit or withdrawal on the ledger: a real loss, or a cash-out Alpaca did not report as a transfer`;
    }
  } else {
    method = "ledger-only";
    warnings.push(
      "Alpaca daily equity history was unavailable; the HWM was rebuilt from the ledger alone, which ignores trading P&L between transfers (a near-total withdrawal can leave a phantom drawdown)."
    );
    const recomputed = recomputeHighWaterMarkFromTransferFlows({
      flows: flows.map((flow) => flow.amount),
      currentEquity: snapshot.equity
    });
    highWaterMark = recomputed.highWaterMark;
    netTransfers = recomputed.netTransfers;
    // A funded account whose ledger shows no contribution/deposit at all cannot be explained by
    // this ledger (this is exactly the 2026-09-24 Roth IRA read: equity > 0, zero transfers).
    if (summary.capitalIn <= 0 && snapshot.equity > 0) {
      unexplainedReason = "the account holds equity but the ledger shows no contribution or deposit";
    }
  }

  if (opts.acceptEquityReset) {
    warnings.push("acceptEquityReset: HWM deliberately reset to current equity by the operator.");
    highWaterMark = Math.max(0, Math.round(snapshot.equity * 100) / 100);
  } else if (unexplainedReason && !opts.acceptUnexplained) {
    // Do not guess.  Report what would have been written and let the operator choose.
    return {
      ok: false,
      status: 409,
      error: `HWM not changed: ${unexplainedReason}.  Inspect GET /api/ops/account-activity, then re-run with acceptUnexplained: true (keep the replayed HWM, treating the falls as losses) or acceptEquityReset: true (reset the HWM to current equity, treating them as cash-outs).`,
      unexplainedEquityChange: {
        equity: snapshot.equity,
        capitalIn: summary.capitalIn,
        reason: unexplainedReason,
        method,
        proposedHwm: highWaterMark,
        proposedDrawdownPct: impliedDrawdownPct(snapshot.equity, highWaterMark),
        days: unexplainedEquityChanges
      }
    };
  } else if (unexplainedReason) {
    warnings.push(`acceptUnexplained: ${unexplainedReason}; the replayed HWM was kept.`);
  }

  const oldHwmRaw = getInternalSetting<number>(HWM_KEY(userId, accountNumber, source));
  const oldHwm = Number.isFinite(oldHwmRaw) ? (oldHwmRaw as number) : null;
  persistDrawdownHighWaterMark({
    userId,
    accountNumber,
    source,
    highWaterMark,
    observation: {
      equity: snapshot.equity,
      at: now.toISOString(),
      appliedActivityIds: flows.map((flow) => flow.id).filter(Boolean).slice(-500),
      hwm: highWaterMark,
      ledgerVersion: HWM_LEDGER_VERSION
    }
  });
  audit(
    "risk_hwm_recompute",
    {
      connectedAccountId: account.id,
      accountNumber,
      source,
      oldHwm,
      newHwm: highWaterMark,
      equity: snapshot.equity,
      netTransfers,
      transferCount: flows.length,
      method,
      capitalIn: summary.capitalIn,
      capitalOut: summary.capitalOut,
      ledgerQuery: ledger.query,
      ledgerPages: ledger.pages,
      ledgerTruncated: ledger.truncated,
      ...(ledger.fallbackFrom ? { ledgerFallbackFrom: ledger.fallbackFrom } : {}),
      unclassifiedTypes: summary.unclassified.map((entry) => entry.activityType),
      unexplainedEquityChanges,
      ...(opts.acceptEquityReset ? { acceptEquityReset: true } : {}),
      ...(opts.acceptUnexplained ? { acceptUnexplained: true } : {})
    },
    userId,
    account.id
  );

  return {
    ok: true,
    connectedAccountId: account.id,
    accountNumber,
    source,
    oldHwm,
    newHwm: highWaterMark,
    equity: snapshot.equity,
    netTransfers,
    transferCount: flows.length,
    impliedDrawdownPct: impliedDrawdownPct(snapshot.equity, highWaterMark),
    method,
    capitalIn: summary.capitalIn,
    capitalOut: summary.capitalOut,
    ledgerQuery: ledger.query,
    ledgerPages: ledger.pages,
    ledgerTruncated: ledger.truncated,
    ...(ledger.fallbackFrom ? { ledgerFallbackFrom: ledger.fallbackFrom } : {}),
    unclassified: summary.unclassified,
    unexplainedEquityChanges,
    warnings
  };
}
