// On-demand fill reconciliation backfill for one connected account (ops-token route
// `/api/ops/fill-reconcile`).  The same convergence runs automatically every scheduler tick with a
// small lookup budget (reconcilePendingFills); this entry point runs one pass with a large budget and
// no throttles, and reports before/after counts, so an operator can drain a historical backlog (the
// Tradier Sandbox's 40 "placed" proposals) right after a deploy and see the result.
//
// Idempotent: every booking is deduped by broker order id inside an IMMEDIATE transaction, so a
// repeated call only books what is still missing.  Never places or cancels an order.

import { getDb } from "./db";
import { findConnectedAccountById } from "./db-api-keys";
import { getPolicy } from "./db-profiles";
import { getBrokerGateway } from "./broker";
import { reconcilePendingFills } from "./strategy-execution";
import type { FillReconcileSummary } from "./fill-reconciliation";

export const OPS_FILL_RECONCILE_DEFAULT_BUDGET = 100;
export const OPS_FILL_RECONCILE_MAX_BUDGET = 500;

export interface FillReconcileCounts {
  placedProposals: number;
  pendingReceipts: number;
  filledReceipts: number;
  brokerOriginatedFills: number;
  bracketFillsAwaitingLegs: number;
}

export function fillReconcileCounts(userId: string, accountNumber: string): FillReconcileCounts {
  const db = getDb();
  const one = (sql: string, ...args: unknown[]) => ((db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0);
  return {
    placedProposals: one("SELECT COUNT(*) AS n FROM trade_proposals WHERE user_id = ? AND account_number = ? AND status = 'placed'", userId, accountNumber),
    pendingReceipts: one(
      "SELECT COUNT(*) AS n FROM fill_events WHERE user_id = ? AND account_number = ? AND status IN ('pending_reconciliation', 'partially_filled')",
      userId,
      accountNumber
    ),
    filledReceipts: one("SELECT COUNT(*) AS n FROM fill_events WHERE user_id = ? AND account_number = ? AND status = 'filled'", userId, accountNumber),
    brokerOriginatedFills: one(
      "SELECT COUNT(*) AS n FROM fill_events WHERE user_id = ? AND account_number = ? AND json_extract(raw, '$.brokerOriginated') = 1",
      userId,
      accountNumber
    ),
    bracketFillsAwaitingLegs: one(
      `SELECT COUNT(*) AS n FROM fill_events
       WHERE user_id = ? AND account_number = ? AND status IN ('filled', 'partially_filled') AND side IN ('buy', 'short')
         AND (json_extract(raw, '$.proposal.bracketStopLoss') IS NOT NULL OR json_extract(raw, '$.proposal.bracketTakeProfit') IS NOT NULL)
         AND COALESCE(json_extract(raw, '$.bracketLegs.settled'), 0) = 0`,
      userId,
      accountNumber
    )
  };
}

export type OpsFillReconcileResult =
  | { ok: false; status: 400 | 404 | 409; error: string }
  | {
      ok: true;
      connectedAccountId: string;
      broker: string;
      environment: "paper" | "live";
      dryRun: boolean;
      lookupBudget: number;
      before: FillReconcileCounts;
      after?: FillReconcileCounts;
      summary?: FillReconcileSummary;
      supportsOrderLookup: boolean;
      supportsExecutionListing: boolean;
    };

export async function runOpsFillReconcile(input: {
  connectedAccountId: string;
  lookupBudget?: number;
  dryRun?: boolean;
}): Promise<OpsFillReconcileResult> {
  const account = findConnectedAccountById(input.connectedAccountId);
  if (!account) return { ok: false, status: 404, error: "Connected account not found." };
  if (!account.accountNumber) return { ok: false, status: 409, error: "Connected account has no account number yet." };
  const requested = input.lookupBudget ?? OPS_FILL_RECONCILE_DEFAULT_BUDGET;
  const lookupBudget = Math.max(0, Math.min(OPS_FILL_RECONCILE_MAX_BUDGET, Number.isFinite(requested) ? Math.floor(requested) : OPS_FILL_RECONCILE_DEFAULT_BUDGET));
  const before = fillReconcileCounts(account.userId, account.accountNumber);
  let gateway: ReturnType<typeof getBrokerGateway>;
  try {
    gateway = getBrokerGateway(getPolicy(account.userId, account.id), account.userId);
  } catch (error) {
    return { ok: false, status: 409, error: `Broker gateway unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const base = {
    ok: true as const,
    connectedAccountId: account.id,
    broker: account.broker,
    environment: account.environment,
    dryRun: input.dryRun === true,
    lookupBudget,
    before,
    supportsOrderLookup: typeof gateway.getEquityOrder === "function",
    supportsExecutionListing: typeof gateway.listRecentExecutions === "function"
  };
  if (input.dryRun) return base;
  const summary: FillReconcileSummary = {};
  await reconcilePendingFills(gateway, account.accountNumber, account.userId, account.id, {
    lookupBudget,
    ignoreThrottle: true,
    summary
  });
  return { ...base, after: fillReconcileCounts(account.userId, account.accountNumber), summary };
}
