// Broker-authoritative external cash flows (Alpaca account activities) with inference fallback.
//
// Alpaca /v2/account/activities exposes real CSD/CSW/ACATC/JNLC transfer rows. When present,
// these replace the fragile equity-curve inference that misread directional trades as deposits.
//
// Classification (2026-09-24, board 687a5fb4).  Every Alpaca activity type is sorted into a
// class so a caller can tell "this moved external capital" from "this is trading P&L" from
// "we do not know what this is".  Type codes are the published Alpaca enums (Trading API
// account-activities doc, the Broker API ActivityType enum, and alpaca-py's `ActivityType`) —
// NOT guesses.  The old transfer list carried "DIVTX", which is not an Alpaca type at all (the
// real code is DIVTXEX); sending it as an `activity_types` filter is what this module's callers
// no longer do: they read `category=non_trade_activity` and classify here, so a type the list
// never anticipated (an IRA distribution's withholding row, a cash ACAT) is surfaced instead of
// being filtered away server-side.
//
// RULE: keep this module free of runtime imports from the db/server graph (type-only imports
// from alpaca-account-insights are erased at compile time).

import type { AlpacaAccountActivity } from "./alpaca-account-insights";
import { inferExternalCashFlows, round2 } from "./cash-flows";
import { centralTradingDayKey } from "./trading-day";
import type { EquityCurvePoint, FillEvent } from "./types";

/**
 * External capital: money entering or leaving the account (contributions, distributions,
 * transfers, journals, and tax withheld from a distribution).  Sign comes from `net_amount`.
 */
export const BROKER_CAPITAL_ACTIVITY_TYPE_LIST = [
  "CSD", // cash deposit (+) — IRA contributions arrive as deposits
  "CSW", // cash withdrawal (−) — IRA distributions are processed as withdrawals
  "TRANS", // Alpaca's umbrella for CSD + CSW (accepted defensively if a row ever carries it)
  "ACATC", // ACATS in/out (cash) — e.g. a cash IRA transfer/rollover
  "ACATS", // ACATS in/out (securities)
  "JNL", // journal entry
  "JNLC", // journal entry (cash)
  "JNLS", // journal entry (stock)
  "OCT", // on-chain (crypto) deposit/withdrawal
  "FOPT", // free-of-payment transfer
  "WH" // tax withholding (e.g. federal/state withholding on an IRA distribution) — alpaca-py enum
] as const;

/**
 * Account income that is not a fill.  Kept as an HWM/benchmark flow for continuity with the
 * pre-2026-09-24 list (DIV/DIVNRA/INT were already flows); the withholding-adjusted variants
 * belong to the same family.
 */
export const BROKER_INCOME_ACTIVITY_TYPE_LIST = [
  "DIV",
  "DIVCGL",
  "DIVCGS",
  "DIVFT",
  "DIVNRA",
  "DIVROC",
  "DIVTW",
  "DIVTXEX",
  "DIVWH",
  "CGD",
  "INT",
  "INTNRA",
  "INTTW",
  "PTR"
] as const;

/** Account-level charges that are not fills.  Kept as flows for the same continuity reason. */
export const BROKER_EXPENSE_ACTIVITY_TYPE_LIST = ["FEE", "CFEE", "DIVFEE", "PTC"] as const;

/** Trades and position/corporate events: their cash effect IS trading P&L, never an external flow. */
export const BROKER_POSITION_ACTIVITY_TYPE_LIST = [
  "FILL",
  "MA",
  "NC",
  "SC",
  "SSO",
  "SSP",
  "SPIN",
  "SPLIT",
  "REORG",
  "REO",
  "OPASN",
  "OPEXP",
  "OPXRC",
  "OPEXC",
  "OPCA",
  "OPCSH",
  "OPTRD",
  "CIL"
] as const;

/** Activity types that move external capital or account income/expense, not trade fills. */
export const BROKER_TRANSFER_ACTIVITY_TYPE_LIST = [
  ...BROKER_CAPITAL_ACTIVITY_TYPE_LIST,
  ...BROKER_INCOME_ACTIVITY_TYPE_LIST,
  ...BROKER_EXPENSE_ACTIVITY_TYPE_LIST
] as const;

export type BrokerActivityClass = "capital" | "income" | "expense" | "position" | "unclassified";

const CLASS_BY_TYPE = new Map<string, BrokerActivityClass>([
  ...BROKER_CAPITAL_ACTIVITY_TYPE_LIST.map((t) => [t, "capital"] as const),
  ...BROKER_INCOME_ACTIVITY_TYPE_LIST.map((t) => [t, "income"] as const),
  ...BROKER_EXPENSE_ACTIVITY_TYPE_LIST.map((t) => [t, "expense"] as const),
  ...BROKER_POSITION_ACTIVITY_TYPE_LIST.map((t) => [t, "position"] as const)
]);

const BROKER_TRANSFER_ACTIVITY_TYPES = new Set<string>(BROKER_TRANSFER_ACTIVITY_TYPE_LIST);

export function normalizeActivityType(row: Pick<AlpacaAccountActivity, "activity_type">): string {
  return String(row.activity_type ?? "").trim().toUpperCase();
}

/** Class for an Alpaca activity type.  Anything not in a published list is "unclassified". */
export function classifyAlpacaActivityType(activityType: string): BrokerActivityClass {
  return CLASS_BY_TYPE.get(activityType.trim().toUpperCase()) ?? "unclassified";
}

/** Alpaca marks an activity that was recorded and then reversed as status "canceled". */
export function isCanceledActivity(row: Pick<AlpacaAccountActivity, "status">): boolean {
  return String(row.status ?? "").trim().toLowerCase() === "canceled";
}

function signedAmount(row: AlpacaAccountActivity): number | null {
  const amount = Number(row.net_amount);
  if (!Number.isFinite(amount) || amount === 0) return null;
  return amount;
}

/** True for a non-canceled row of a type the HWM and benchmark count as an external flow. */
export function isBrokerTransferActivity(row: AlpacaAccountActivity): boolean {
  if (isCanceledActivity(row)) return false;
  return BROKER_TRANSFER_ACTIVITY_TYPES.has(normalizeActivityType(row));
}

const isCountedTransfer = isBrokerTransferActivity;

export interface BrokerTransferFlow {
  id: string;
  activityType: string;
  amount: number;
  day: string;
  at: string;
}

export type ExternalCashFlowSource = "broker" | "inferred";

export interface ResolvedExternalCashFlows {
  flows: Map<string, number>;
  source: ExternalCashFlowSource;
}

export function activityDayKey(row: AlpacaAccountActivity): string | null {
  const raw = row.date ?? row.transaction_time ?? row.created_at;
  if (!raw) return null;
  // Alpaca `date` is already a calendar day in the account's reporting TZ — do not re-parse as UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return centralTradingDayKey(raw);
}

/** Map Alpaca activity rows to per Central-trading-day net external flow (deposit +, withdrawal −). */
export function flowsFromAlpacaActivities(activities: AlpacaAccountActivity[]): Map<string, number> {
  const flows = new Map<string, number>();
  for (const row of activities) {
    if (!isCountedTransfer(row)) continue;
    const amount = signedAmount(row);
    if (amount === null) continue;
    const day = activityDayKey(row);
    if (!day) continue;
    flows.set(day, round2((flows.get(day) ?? 0) + amount));
  }
  return flows;
}

/** Prefer broker ledger when non-empty; otherwise infer from equity curve + fills (labeled). */
export function resolveExternalCashFlows(args: {
  equityCurve: EquityCurvePoint[];
  fills?: FillEvent[];
  brokerActivities?: AlpacaAccountActivity[];
}): ResolvedExternalCashFlows {
  const broker = args.brokerActivities?.length ? flowsFromAlpacaActivities(args.brokerActivities) : new Map<string, number>();
  if (broker.size > 0) return { flows: broker, source: "broker" };
  return {
    flows: inferExternalCashFlows(args.equityCurve, args.fills ?? []),
    source: "inferred"
  };
}

/** Net external flow on a single Central trading day from broker activities (0 when none). */
export function brokerFlowOnDay(activities: AlpacaAccountActivity[], dayKey: string): number {
  return flowsFromAlpacaActivities(activities).get(dayKey) ?? 0;
}

function activityAt(row: AlpacaAccountActivity, day: string): string {
  return row.transaction_time ?? row.date ?? day;
}

/** Individual signed transfer rows in chronological order (deposit +, withdrawal −). */
export function listAlpacaTransferFlows(activities: AlpacaAccountActivity[]): BrokerTransferFlow[] {
  const flows: BrokerTransferFlow[] = [];
  for (const row of activities) {
    if (!isCountedTransfer(row)) continue;
    const amount = signedAmount(row);
    if (amount === null) continue;
    const day = activityDayKey(row);
    if (!day) continue;
    flows.push({
      id: String(row.id ?? ""),
      activityType: normalizeActivityType(row),
      amount: round2(amount),
      day,
      at: activityAt(row, day)
    });
  }
  flows.sort((a, b) => {
    const ta = Date.parse(a.at);
    const tb = Date.parse(b.at);
    const sa = Number.isFinite(ta) ? ta : 0;
    const sb = Number.isFinite(tb) ? tb : 0;
    if (sa !== sb) return sa - sb;
    return a.id.localeCompare(b.id);
  });
  return flows;
}

export interface ActivityTypeSummary {
  activityType: string;
  classification: BrokerActivityClass;
  count: number;
  /** Sum of signed net_amount over non-canceled rows. */
  netAmount: number;
  canceledCount: number;
  firstDay: string | null;
  lastDay: string | null;
}

export interface NonTradeLedgerSummary {
  byType: ActivityTypeSummary[];
  /** Sum of positive capital rows (contributions / deposits / transfers in). */
  capitalIn: number;
  /** Sum of negative capital rows (distributions / withdrawals / withholding / transfers out). */
  capitalOut: number;
  /** Net of every row that the drawdown HWM and the benchmark treat as an external flow. */
  netCountedFlows: number;
  countedFlowRows: number;
  /** Types we do not recognize.  Their dollars are NOT applied anywhere — they are surfaced. */
  unclassified: ActivityTypeSummary[];
}

/** Per-type roll-up of a non-trade ledger, used by the ops diagnostic and the HWM recompute. */
export function summarizeNonTradeActivities(activities: AlpacaAccountActivity[]): NonTradeLedgerSummary {
  const byType = new Map<string, ActivityTypeSummary>();
  let capitalIn = 0;
  let capitalOut = 0;
  let netCountedFlows = 0;
  let countedFlowRows = 0;
  for (const row of activities) {
    const activityType = normalizeActivityType(row) || "UNKNOWN";
    const classification = classifyAlpacaActivityType(activityType);
    const entry =
      byType.get(activityType) ??
      ({ activityType, classification, count: 0, netAmount: 0, canceledCount: 0, firstDay: null, lastDay: null } satisfies ActivityTypeSummary);
    byType.set(activityType, entry);
    const day = activityDayKey(row);
    if (day) {
      if (!entry.firstDay || day < entry.firstDay) entry.firstDay = day;
      if (!entry.lastDay || day > entry.lastDay) entry.lastDay = day;
    }
    if (isCanceledActivity(row)) {
      entry.canceledCount += 1;
      continue;
    }
    entry.count += 1;
    const amount = signedAmount(row);
    if (amount === null) continue;
    entry.netAmount = round2(entry.netAmount + amount);
    if (classification === "capital") {
      if (amount > 0) capitalIn = round2(capitalIn + amount);
      else capitalOut = round2(capitalOut + amount);
    }
    if (BROKER_TRANSFER_ACTIVITY_TYPES.has(activityType)) {
      netCountedFlows = round2(netCountedFlows + amount);
      countedFlowRows += 1;
    }
  }
  const sorted = [...byType.values()].sort((a, b) => a.activityType.localeCompare(b.activityType));
  return {
    byType: sorted,
    capitalIn,
    capitalOut,
    netCountedFlows,
    countedFlowRows,
    unclassified: sorted.filter((entry) => entry.classification === "unclassified")
  };
}
