// Read-only ops diagnostic: what Alpaca's non-trade ledger actually reports for one connected
// account (deposits, withdrawals, IRA contributions/distributions, withholding, dividends, fees,
// journals), how each row is classified for the drawdown HWM, and the HWM state it feeds.
//
// Built for the 2026-09-24 Roth IRA incident (board 687a5fb4): the HWM recompute found zero
// transfers after ~$96 had left the account, and nobody could see whether Alpaca returned an
// error, returned nothing, or returned types the filter did not name.  This answers that from a
// fleet agent's curl without a session.  GET-only; never places, modifies, or cancels anything.
//
// Privacy: no account numbers, no activity ids, no credentials.  Descriptions are trimmed and any
// run of 5+ digits (account / routing / reference numbers) is masked.

import {
  alpacaTradingHostInfo,
  fetchAlpacaNonTradeActivities,
  type AlpacaAccountActivity
} from "./alpaca-account-insights";
import {
  activityDayKey,
  classifyAlpacaActivityType,
  normalizeActivityType,
  summarizeNonTradeActivities,
  type BrokerActivityClass,
  type NonTradeLedgerSummary
} from "./broker-cash-flows";
import { findConnectedAccountById, getInternalSetting } from "./db";
import { readDrawdownHwmObservation } from "./risk-breaker";
import type { FillSource } from "./types";

export const OPS_ACCOUNT_ACTIVITY_DEFAULT_DAYS = 365;
export const OPS_ACCOUNT_ACTIVITY_MAX_DAYS = 1825;
const DESCRIPTION_MAX_CHARS = 80;
const MAX_ROWS = 500;

export interface OpsAccountActivityRow {
  date: string | null;
  activityType: string;
  activitySubType?: string;
  classification: BrokerActivityClass;
  netAmount: number | null;
  status?: string;
  description?: string;
}

export interface OpsAccountActivityReport {
  ok: boolean;
  connectedAccountId: string;
  broker: string;
  environment: "paper" | "live";
  tradingHost: string;
  tradingBaseOverridden: boolean;
  window: { days: number; after: string };
  ledger: {
    ok: boolean;
    query: string;
    pages: number;
    truncated: boolean;
    httpStatus?: number;
    error?: string;
    fallbackFrom?: string;
  };
  rowCount: number;
  rowsTruncated: boolean;
  activities: OpsAccountActivityRow[];
  summary: NonTradeLedgerSummary;
  drawdownHwm: {
    highWaterMark: number | null;
    observationEquity: number | null;
    observationAt: string | null;
    appliedActivityCount: number;
    pendingDrop: { fromEquity: number; at: string; resolved: boolean } | null;
  };
}

export type OpsAccountActivityOutcome =
  | { ok: true; status: number; report: OpsAccountActivityReport }
  | { ok: false; status: number; error: string };

/** Trim, collapse whitespace, and mask long digit runs (account/routing/reference numbers). */
export function sanitizeActivityDescription(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.replace(/\s+/g, " ").trim().replace(/\d{5,}/g, "#####");
  if (!text) return undefined;
  return text.length > DESCRIPTION_MAX_CHARS ? `${text.slice(0, DESCRIPTION_MAX_CHARS - 1)}…` : text;
}

function toRow(row: AlpacaAccountActivity): OpsAccountActivityRow {
  const activityType = normalizeActivityType(row) || "UNKNOWN";
  const amount = Number(row.net_amount);
  const description = sanitizeActivityDescription(row.description);
  const subType = typeof row.activity_sub_type === "string" && row.activity_sub_type.trim() ? row.activity_sub_type.trim() : undefined;
  const status = typeof row.status === "string" && row.status.trim() ? row.status.trim() : undefined;
  return {
    date: activityDayKey(row),
    activityType,
    ...(subType ? { activitySubType: subType } : {}),
    classification: classifyAlpacaActivityType(activityType),
    netAmount: Number.isFinite(amount) ? amount : null,
    ...(status ? { status } : {}),
    ...(description ? { description } : {})
  };
}

export function clampActivityDays(raw: string | null | undefined): number {
  const parsed = Math.trunc(Number(raw));
  if (!Number.isFinite(parsed) || parsed <= 0) return OPS_ACCOUNT_ACTIVITY_DEFAULT_DAYS;
  return Math.min(OPS_ACCOUNT_ACTIVITY_MAX_DAYS, parsed);
}

export async function buildOpsAccountActivityReport(args: {
  connectedAccountId: string;
  days: number;
  now?: Date;
}): Promise<OpsAccountActivityOutcome> {
  const account = findConnectedAccountById(args.connectedAccountId);
  if (!account) return { ok: false, status: 404, error: "connectedAccountId not found" };
  if (account.broker !== "alpaca" && account.broker !== "alpaca-mcp") {
    return { ok: false, status: 400, error: "connected account is not Alpaca" };
  }
  if (!account.apiKey) {
    return { ok: false, status: 400, error: "connected account has no private Alpaca credentials" };
  }

  const environment: "paper" | "live" = account.environment === "live" ? "live" : "paper";
  const now = args.now ?? new Date();
  const after = new Date(now.getTime() - args.days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const ledger = await fetchAlpacaNonTradeActivities(account.userId, {
    connectedAccountId: account.id,
    after
  });
  const hostInfo = alpacaTradingHostInfo(environment);
  const summary = summarizeNonTradeActivities(ledger.activities);
  const rows = ledger.activities.map(toRow);
  // Newest first; stable, so same-day rows keep Alpaca's own (newest-first) order.
  rows.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  const source: FillSource = environment;
  const accountNumber = account.accountNumber?.trim();
  const hwmRaw = accountNumber ? getInternalSetting<number>(`risk:hwm:${account.userId}:${accountNumber}:${source}`) : undefined;
  const observation = accountNumber ? readDrawdownHwmObservation(account.userId, accountNumber, source) : undefined;

  const report: OpsAccountActivityReport = {
    ok: ledger.ok,
    connectedAccountId: account.id,
    broker: account.broker,
    environment,
    tradingHost: hostInfo.host,
    tradingBaseOverridden: hostInfo.overridden,
    window: { days: args.days, after },
    ledger: {
      ok: ledger.ok,
      query: ledger.query,
      pages: ledger.pages,
      truncated: ledger.truncated,
      ...(ledger.httpStatus !== undefined ? { httpStatus: ledger.httpStatus } : {}),
      ...(ledger.error ? { error: ledger.error } : {}),
      ...(ledger.fallbackFrom ? { fallbackFrom: ledger.fallbackFrom } : {})
    },
    rowCount: rows.length,
    rowsTruncated: rows.length > MAX_ROWS,
    activities: rows.slice(0, MAX_ROWS),
    summary,
    drawdownHwm: {
      highWaterMark: Number.isFinite(hwmRaw) ? (hwmRaw as number) : null,
      observationEquity: observation && Number.isFinite(observation.equity) ? observation.equity : null,
      observationAt: observation?.at ?? null,
      appliedActivityCount: observation?.appliedActivityIds?.length ?? 0,
      pendingDrop: observation?.pendingDrop
        ? {
            fromEquity: observation.pendingDrop.fromEquity,
            at: observation.pendingDrop.at,
            resolved: observation.pendingDrop.resolved === true
          }
        : null
    }
  };
  // A failed ledger read is reported in full, but with a non-2xx so scripts cannot mistake it
  // for "this account has no activity".
  return { ok: true, status: ledger.ok ? 200 : 502, report };
}
