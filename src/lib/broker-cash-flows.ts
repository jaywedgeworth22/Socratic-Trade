// Broker-authoritative external cash flows (Alpaca account activities) with inference fallback.
//
// Alpaca /v2/account/activities exposes real CSD/CSW/ACATS transfer rows. When present, these
// replace the fragile equity-curve inference that misread directional trades as deposits.

import type { AlpacaAccountActivity } from "./alpaca-account-insights";
import { inferExternalCashFlows, round2 } from "./cash-flows";
import { centralTradingDayKey } from "./trading-day";
import type { EquityCurvePoint, FillEvent } from "./types";

/** Activity types that move external capital (deposit/withdrawal/journal), not trade fills. */
export const BROKER_TRANSFER_ACTIVITY_TYPE_LIST = [
  "CSD", // cash deposit (+)
  "CSW", // cash withdrawal (−)
  "ACATS",
  "JNLC", // journal between accounts
  "INT", // interest credit
  "DIV", // cash dividend (external to trading P&L neutralization)
  "DIVNRA",
  "DIVTX",
  "FEE"
] as const;

const BROKER_TRANSFER_ACTIVITY_TYPES = new Set<string>(BROKER_TRANSFER_ACTIVITY_TYPE_LIST);

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

function activityDayKey(row: AlpacaAccountActivity): string | null {
  const raw = row.date ?? row.transaction_time;
  if (!raw) return null;
  // Alpaca `date` is already a calendar day in the account's reporting TZ — do not re-parse as UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return centralTradingDayKey(raw);
}

/** Map Alpaca activity rows to per Central-trading-day net external flow (deposit +, withdrawal −). */
export function flowsFromAlpacaActivities(activities: AlpacaAccountActivity[]): Map<string, number> {
  const flows = new Map<string, number>();
  for (const row of activities) {
    const type = String(row.activity_type ?? "").toUpperCase();
    if (!BROKER_TRANSFER_ACTIVITY_TYPES.has(type)) continue;
    const amount = Number(row.net_amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
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
    const activityType = String(row.activity_type ?? "").toUpperCase();
    if (!BROKER_TRANSFER_ACTIVITY_TYPES.has(activityType)) continue;
    const amount = Number(row.net_amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const day = activityDayKey(row);
    if (!day) continue;
    flows.push({
      id: String(row.id ?? ""),
      activityType,
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
