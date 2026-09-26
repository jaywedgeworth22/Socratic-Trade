// Broker-truth convergence for fills and proposals — the half of reconciliation the current-session
// order listing cannot do on its own.
//
// Why this exists (2026-09-25, board 687a5fb4 lane G1): Tradier's order listing covers only the
// CURRENT market session (plus still-working orders).  A receipt that did not reconcile the same day
// — the account was halted, a tick was missed, or the stored id was a bracket CONTAINER the
// flattened listing never matched — could never match again.  In the Tradier Sandbox account that
// left 40 proposals stuck at "placed", 17 receipts at pending_reconciliation (17
// fill_reconciliation_stalled audits), and every broker-held bracket exit unbooked, so realized
// P&L and closed lots read zero while roughly $64K of buys and $20.8K of exits traded.
//
// Three sweeps, all idempotent and all keyed by broker order id so a re-run never books twice:
//  1. Per-order lookup (BrokerGateway.getEquityOrder) for a pending receipt whose order is absent
//     from the listing — wired into reconcilePendingFills (strategy-execution.ts).
//  2. Bracket exit legs: a booked opening fill placed as a broker-native bracket has contingent exit
//     legs that no app lane books; look the container up and book each executed exit leg.
//  3. Listing ingestion (BrokerGateway.listRecentExecutions): executed owner orders and bracket legs
//     that no lane owns are booked as broker-originated fills so P&L is complete.
// Plus proposal convergence: a "placed" proposal whose receipt is final flips to its final status,
// a proposal executed through the app's own cancel-and-replace is linked to the replacement fill,
// and a "placed" proposal with no receipt at all is backfilled from the broker's order.
//
// Money path.  Every booking requires a broker-REPORTED execution quantity AND average price on a
// terminal order (never a proposal or reference price), and runs its dedupe check and insert inside
// one IMMEDIATE transaction.

import { hasBrokerReportedPricedFill, isLiveOrderState, isRejectedOrCanceledState } from "./broker-side";
import { auditDeduped } from "./audit-dedupe";
import { audit, getDb } from "./db";
import { getConnectedAccount } from "./db-api-keys";
import {
  findFillEventByBrokerOrderId,
  insertFillEvent,
  listBracketOpeningFillsAwaitingLegs,
  listFillEventsByProposalId,
  updateFillEvent
} from "./db-fills";
import { resolveBrokerVerificationNotifications } from "./db-notifications";
import { updateProposalStatus } from "./db-proposals";
import { fillSourceForExecutionMode } from "./execution-mode";
import { normalizeSymbol } from "./money";
import type {
  BrokerExecution,
  BrokerGateway,
  BrokerOrderLookup,
  EquityOrder,
  ExecutionMode,
  FillEvent,
  TradeProposal
} from "./types";

/** Per-order broker lookups allowed in one reconcile pass (scheduler tick).  Old stuck rows drain a
 *  few per tick instead of bursting the broker's rate limit on the first pass after a deploy. */
export const DEFAULT_ORDER_LOOKUP_BUDGET = 12;
/** A pending receipt whose order IS in the listing but still reads as working is re-checked by id
 *  only after this age — a bracket container's listing row can show the container's state while
 *  the entry leg has already filled. */
export const LIVE_MATCH_RECHECK_AGE_MS = 5 * 60_000;
const RECHECK_AFTER_FOUND_MS = 10 * 60_000;
const RECHECK_AFTER_NOT_FOUND_MS = 30 * 60_000;
const RECHECK_AFTER_ERROR_MS = 5 * 60_000;
const BRACKET_RECHECK_MS = 15 * 60_000;
const LISTING_INGEST_INTERVAL_MS = 5 * 60_000;
/** An execution this fresh is left for the next pass: every app lane books its own order
 *  synchronously right after the broker responds, so waiting out this window guarantees the lane's
 *  receipt (and its broker order id) exists before the listing ingest dedupes against it. */
export const LISTING_INGEST_SETTLE_MS = 2 * 60_000;
const PROPOSAL_CONVERGE_INTERVAL_MS = 10 * 60_000;
/** A bracket container the broker reports as not found this many times is settled (stop asking). */
const BRACKET_NOT_FOUND_SETTLE_COUNT = 3;
const THROTTLE_MAP_CAP = 5_000;

export interface OrderLookupBudget {
  remaining: number;
}

/** Counters for the ops backfill route and tests. */
export type FillReconcileSummary = Record<string, number>;

export interface BrokerTruthContext {
  gateway: BrokerGateway;
  accountNumber: string;
  userId: string;
  connectedAccountId?: string;
  budget: OrderLookupBudget;
  /** Ops backfill: ignore per-order and per-account throttles (budget still applies). */
  ignoreThrottle?: boolean;
  summary?: FillReconcileSummary;
}

export function bump(summary: FillReconcileSummary | undefined, key: string, by = 1): void {
  if (!summary) return;
  summary[key] = (summary[key] ?? 0) + by;
}

// In-memory throttles.  Losing them on restart only costs one extra lookup per row.
const nextOrderLookupAt = new Map<string, number>();
const lastAccountSweepAt = new Map<string, number>();

export function resetFillReconciliationStateForTests(): void {
  nextOrderLookupAt.clear();
  lastAccountSweepAt.clear();
}

function capMap(map: Map<string, number>): void {
  if (map.size > THROTTLE_MAP_CAP) map.clear();
}

function sweepDue(key: string, intervalMs: number, ignoreThrottle: boolean | undefined): boolean {
  const now = Date.now();
  const last = lastAccountSweepAt.get(key);
  if (!ignoreThrottle && last !== undefined && now - last < intervalMs) return false;
  capMap(lastAccountSweepAt);
  lastAccountSweepAt.set(key, now);
  return true;
}

export type OrderLookupResult =
  | { kind: "found"; lookup: BrokerOrderLookup }
  | { kind: "not_found" }
  | { kind: "error"; error: string }
  | { kind: "skipped"; reason: "unsupported" | "throttled" | "budget" };

/** Budgeted, throttled `getEquityOrder`.  Never throws. */
export async function lookupBrokerOrder(
  ctx: BrokerTruthContext,
  orderId: string,
  opts: { recheckAfterFoundMs?: number } = {}
): Promise<OrderLookupResult> {
  const getEquityOrder = ctx.gateway.getEquityOrder;
  if (typeof getEquityOrder !== "function") return { kind: "skipped", reason: "unsupported" };
  const key = `${ctx.userId}|${ctx.accountNumber}|${orderId}`;
  const now = Date.now();
  const nextAt = nextOrderLookupAt.get(key);
  if (!ctx.ignoreThrottle && nextAt !== undefined && now < nextAt) return { kind: "skipped", reason: "throttled" };
  if (ctx.budget.remaining <= 0) {
    bump(ctx.summary, "lookupsDeferredByBudget");
    return { kind: "skipped", reason: "budget" };
  }
  ctx.budget.remaining -= 1;
  bump(ctx.summary, "lookups");
  capMap(nextOrderLookupAt);
  try {
    const lookup = await getEquityOrder.call(ctx.gateway, ctx.accountNumber, orderId);
    if (!lookup) {
      nextOrderLookupAt.set(key, now + RECHECK_AFTER_NOT_FOUND_MS);
      bump(ctx.summary, "lookupNotFound");
      return { kind: "not_found" };
    }
    nextOrderLookupAt.set(key, now + (opts.recheckAfterFoundMs ?? RECHECK_AFTER_FOUND_MS));
    return { kind: "found", lookup };
  } catch (error) {
    nextOrderLookupAt.set(key, now + RECHECK_AFTER_ERROR_MS);
    bump(ctx.summary, "lookupErrors");
    return { kind: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Execution mode for broker-originated rows in this account: the connected account's environment,
 *  else the most recent broker fill's mode.  Undefined means "cannot classify" and callers skip. */
export function resolveAccountExecutionMode(userId: string, accountNumber: string, connectedAccountId?: string): ExecutionMode | undefined {
  if (connectedAccountId) {
    try {
      const account = getConnectedAccount(connectedAccountId, userId);
      if (account && (!account.accountNumber || account.accountNumber === accountNumber)) {
        return account.environment === "live" ? "broker/live" : "broker/paper";
      }
    } catch {
      // fall through to the fill-history fallback
    }
  }
  const row = getDb()
    .prepare(
      `SELECT execution_mode FROM fill_events
       WHERE user_id = ? AND account_number = ? AND execution_mode IN ('broker/paper', 'broker/live')
       ORDER BY filled_at DESC LIMIT 1`
    )
    .get(userId, accountNumber) as { execution_mode: ExecutionMode } | undefined;
  return row?.execution_mode;
}

function executionTimestamp(order: EquityOrder): string {
  for (const candidate of [order.updatedAt, order.createdAt]) {
    const ms = candidate ? Date.parse(candidate) : NaN;
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

/** A terminal order with a broker-reported priced execution — the only shape that may be booked. */
export function isFinalPricedExecution(order: EquityOrder): boolean {
  const state = String(order.state ?? "").trim().toLowerCase();
  return hasBrokerReportedPricedFill(order) && (state === "filled" || isRejectedOrCanceledState(state));
}

/**
 * Book one broker-originated execution (no proposal) — a bracket exit leg, an owner order, or any
 * order no app lane owns.  Returns the new fill, or undefined when it is not a final priced
 * execution or ANY fill in this account already carries its broker order id.  The dedupe check and
 * the insert share one IMMEDIATE transaction, so concurrent passes cannot both book it.
 */
export function bookBrokerOriginatedExecution(p: {
  userId: string;
  accountNumber: string;
  connectedAccountId?: string;
  executionMode: ExecutionMode;
  order: EquityOrder;
  role: BrokerExecution["role"];
  via: "bracket_lookup" | "listing";
  parentOrderId?: string;
  summary?: FillReconcileSummary;
}): FillEvent | undefined {
  const { order } = p;
  if (!order.id || !isFinalPricedExecution(order)) return undefined;
  const quantity = order.filledQuantity!;
  const price = order.averagePrice!;
  const booked = getDb().transaction((): FillEvent | undefined => {
    if (findFillEventByBrokerOrderId(p.accountNumber, order.id, p.userId)) return undefined;
    return insertFillEvent({
      userId: p.userId,
      accountNumber: p.accountNumber,
      source: fillSourceForExecutionMode(p.executionMode),
      executionMode: p.executionMode,
      symbol: normalizeSymbol(order.symbol),
      side: order.side,
      quantity,
      price,
      notional: Math.abs(quantity * price),
      status: "filled",
      brokerOrderId: order.id,
      filledAt: executionTimestamp(order),
      raw: {
        brokerOriginated: true,
        via: p.via,
        role: p.role,
        ...(p.parentOrderId ? { parentOrderId: p.parentOrderId } : {}),
        order
      }
    });
  }).immediate();
  if (booked) {
    bump(p.summary, "brokerOriginatedBooked");
    audit(
      "fill_broker_originated_booked",
      {
        fillId: booked.id,
        brokerOrderId: order.id,
        symbol: booked.symbol,
        side: booked.side,
        quantity,
        price,
        role: p.role,
        via: p.via,
        parentOrderId: p.parentOrderId ?? null,
        brokerState: order.state
      },
      p.userId,
      p.connectedAccountId
    );
  }
  return booked;
}

/** Book every executed exit leg of a looked-up bracket.  Returns whether every exit leg is final. */
export function bookBracketExitLegs(
  ctx: Pick<BrokerTruthContext, "userId" | "accountNumber" | "connectedAccountId" | "summary">,
  lookup: BrokerOrderLookup,
  executionMode: ExecutionMode | undefined
): { booked: number; allFinal: boolean } {
  const legs = lookup.exitLegs ?? [];
  let booked = 0;
  if (executionMode) {
    for (const leg of legs) {
      const fill = bookBrokerOriginatedExecution({
        userId: ctx.userId,
        accountNumber: ctx.accountNumber,
        connectedAccountId: ctx.connectedAccountId,
        executionMode,
        order: leg,
        role: "exit",
        via: "bracket_lookup",
        parentOrderId: lookup.order.id,
        summary: ctx.summary
      });
      if (fill) booked += 1;
    }
  }
  const allFinal = legs.every((leg) => {
    const state = String(leg.state ?? "").trim().toLowerCase();
    return !isLiveOrderState(state) && (state === "filled" || isRejectedOrCanceledState(state));
  });
  return { booked, allFinal };
}

/**
 * The app's own cancel-and-replace (order-replacement.ts) cancels a stale limit order and books the
 * market replacement as a proposal-less fill.  The ORIGINAL proposal therefore reads "canceled" at
 * the broker although its intent executed.  Find that replacement for any of `orderIds`, link its
 * fill to the proposal (proposal_id plus raw.proposal when absent, so attribution and stop-plan
 * commit see it), and report whether it has executed.
 */
export function linkReplacementExecution(p: {
  userId: string;
  accountNumber: string;
  proposalId: string;
  orderIds: Array<string | undefined>;
  proposal?: TradeProposal;
}): { status: "filled" | "pending"; notional?: number; replacementOrderId?: string } | undefined {
  const ids = [...new Set(p.orderIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return undefined;
  const db = getDb();
  const replacement = db
    .prepare(
      `SELECT replacement_ref_id, replacement_order_id FROM order_replacements
       WHERE user_id = ? AND account_number = ?
         AND original_order_id IN (${ids.map(() => "?").join(", ")})
         AND status IN ('replacement_confirmed', 'replacement_submitted')
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(p.userId, p.accountNumber, ...ids) as { replacement_ref_id: string; replacement_order_id: string | null } | undefined;
  if (!replacement) return undefined;
  const fillRow = db
    .prepare(
      `SELECT id, proposal_id, status, notional, raw FROM fill_events
       WHERE user_id = ? AND account_number = ? AND json_extract(raw, '$.replacementRefId') = ?
       ORDER BY filled_at DESC, rowid DESC LIMIT 1`
    )
    .get(p.userId, p.accountNumber, replacement.replacement_ref_id) as
    | { id: string; proposal_id: string | null; status: string; notional: number; raw: string | null }
    | undefined;
  const replacementOrderId = replacement.replacement_order_id ?? undefined;
  if (!fillRow) return { status: "pending", replacementOrderId };
  if (fillRow.proposal_id && fillRow.proposal_id !== p.proposalId) return undefined;
  if (!fillRow.proposal_id) {
    let raw: Record<string, unknown> = {};
    try {
      raw = fillRow.raw ? (JSON.parse(fillRow.raw) as Record<string, unknown>) : {};
    } catch {
      raw = {};
    }
    const merged = { ...raw, linkedProposalId: p.proposalId, ...(raw.proposal || !p.proposal ? {} : { proposal: p.proposal }) };
    try {
      db.prepare("UPDATE fill_events SET proposal_id = ?, raw = ? WHERE id = ? AND user_id = ? AND proposal_id IS NULL")
        .run(p.proposalId, JSON.stringify(merged), fillRow.id, p.userId);
    } catch {
      // The (proposal_id, broker_order_id) unique index already holds this pair — already linked.
    }
  }
  return {
    status: fillRow.status === "filled" ? "filled" : "pending",
    notional: fillRow.notional,
    replacementOrderId
  };
}

/** Sweep 2: book executed exit legs of booked bracket entries.  Needs getEquityOrder. */
export async function settleBracketExitLegs(ctx: BrokerTruthContext): Promise<void> {
  if (typeof ctx.gateway.getEquityOrder !== "function") return;
  const candidates = listBracketOpeningFillsAwaitingLegs(ctx.accountNumber, ctx.userId, 100)
    .filter((fill) => !(fill.raw as { brokerOriginated?: unknown } | undefined)?.brokerOriginated);
  for (const fill of candidates) {
    if (ctx.budget.remaining <= 0) break;
    const result = await lookupBrokerOrder(ctx, fill.brokerOrderId!, { recheckAfterFoundMs: BRACKET_RECHECK_MS });
    const raw = ((fill.raw ?? {}) as Record<string, unknown>);
    const prior = (raw.bracketLegs ?? {}) as { notFound?: number };
    const checkedAt = new Date().toISOString();
    if (result.kind === "found") {
      const executionMode = fill.executionMode ?? (fill.source === "live" ? "broker/live" : "broker/paper");
      const { allFinal } = bookBracketExitLegs(ctx, result.lookup, executionMode);
      if (allFinal) {
        updateFillEvent(fill.id, {
          raw: {
            ...raw,
            bracketLegs: {
              settled: true,
              checkedAt,
              exitLegIds: (result.lookup.exitLegs ?? []).map((leg) => leg.id)
            }
          }
        }, ctx.userId);
        bump(ctx.summary, "bracketFillsSettled");
      }
    } else if (result.kind === "not_found") {
      const notFound = (prior.notFound ?? 0) + 1;
      updateFillEvent(fill.id, {
        raw: {
          ...raw,
          bracketLegs: { ...prior, notFound, checkedAt, ...(notFound >= BRACKET_NOT_FOUND_SETTLE_COUNT ? { settled: true, reason: "order_not_found" } : {}) }
        }
      }, ctx.userId);
    }
  }
}

/**
 * Which lane owns an execution from the listing, if any.  App orders are always tagged with their
 * idempotency ref and are booked by their own lanes (placement, replacement, protective and
 * synthetic stops), so a tagged single or a tagged bracket's entry is never ingested here.  Bracket
 * EXIT legs are untagged broker-held orders no lane books, so they are ingested whoever placed the
 * bracket; the broker-order-id dedupe keeps that single-booked.
 */
export function listingExecutionOwner(
  execution: BrokerExecution,
  hasFillFor: (brokerOrderId: string) => boolean
): string | undefined {
  if (execution.role === "exit") return undefined;
  if (execution.order.clientOrderId || execution.parentClientOrderId) return "app_tagged";
  if (execution.role === "entry" && execution.parentOrderId && hasFillFor(execution.parentOrderId)) return "container_booked";
  return undefined;
}

/** Sweep 3: ingest executed orders from the listing that no app lane owns. */
export async function ingestListingExecutions(ctx: BrokerTruthContext): Promise<void> {
  const listRecentExecutions = ctx.gateway.listRecentExecutions;
  if (typeof listRecentExecutions !== "function") return;
  if (!sweepDue(`listing|${ctx.userId}|${ctx.accountNumber}`, LISTING_INGEST_INTERVAL_MS, ctx.ignoreThrottle)) return;
  const executionMode = resolveAccountExecutionMode(ctx.userId, ctx.accountNumber, ctx.connectedAccountId);
  if (!executionMode) return;
  const executions = await listRecentExecutions.call(ctx.gateway, ctx.accountNumber);
  const hasFillFor = (id: string) => Boolean(findFillEventByBrokerOrderId(ctx.accountNumber, id, ctx.userId));
  const settledBefore = Date.now() - LISTING_INGEST_SETTLE_MS;
  for (const execution of executions) {
    if (!isFinalPricedExecution(execution.order)) continue;
    const executedAtMs = Date.parse(execution.order.updatedAt ?? execution.order.createdAt ?? "");
    if (Number.isFinite(executedAtMs) && executedAtMs > settledBefore) {
      bump(ctx.summary, "listingExecutionsDeferredToSettle");
      continue;
    }
    if (listingExecutionOwner(execution, hasFillFor)) continue;
    bookBrokerOriginatedExecution({
      userId: ctx.userId,
      accountNumber: ctx.accountNumber,
      connectedAccountId: ctx.connectedAccountId,
      executionMode,
      order: execution.order,
      role: execution.role,
      via: "listing",
      parentOrderId: execution.parentOrderId,
      summary: ctx.summary
    });
  }
}

type PlacedProposalRow = {
  id: string;
  order_id: string | null;
  proposal: string;
  execution_mode: string | null;
};

function parseProposal(json: string): TradeProposal | undefined {
  try {
    return JSON.parse(json) as TradeProposal;
  } catch {
    return undefined;
  }
}

function convergeProposal(
  ctx: BrokerTruthContext,
  proposalId: string,
  to: "filled" | "rejected_by_broker",
  detail: Record<string, unknown>,
  notional?: number,
  errorMessage?: string
): void {
  updateProposalStatus(proposalId, to, undefined, undefined, notional, ctx.userId, undefined, errorMessage);
  audit("proposal_status_converged", { proposalId, from: "placed", to, ...detail }, ctx.userId, ctx.connectedAccountId);
  resolveBrokerVerificationNotifications(ctx.userId, { proposalId, resolution: to === "filled" ? "placed" : "recovered" });
  bump(ctx.summary, to === "filled" ? "proposalsConvergedFilled" : "proposalsConvergedDeclined");
}

/**
 * Proposal convergence: a proposal left at "placed" after its broker order reached a final state.
 *  - A final receipt already exists: flip to it (no broker call).
 *  - Every receipt was canceled by the app's own cancel-and-replace: link the replacement and flip
 *    to filled once it executed.
 *  - No receipt at all: look the order up and book the receipt from broker truth (or hand a still-
 *    working order to the normal pending-receipt path).
 */
export async function convergePlacedProposals(ctx: BrokerTruthContext): Promise<void> {
  if (!sweepDue(`proposals|${ctx.userId}|${ctx.accountNumber}`, PROPOSAL_CONVERGE_INTERVAL_MS, ctx.ignoreThrottle)) return;
  const rows = getDb()
    .prepare(
      `SELECT id, order_id, proposal, execution_mode FROM trade_proposals
       WHERE user_id = ? AND account_number = ? AND status = 'placed'
       ORDER BY created_at ASC LIMIT 200`
    )
    .all(ctx.userId, ctx.accountNumber) as PlacedProposalRow[];
  for (const row of rows) {
    try {
      await convergeOneProposal(ctx, row);
    } catch (error) {
      bump(ctx.summary, "proposalConvergeErrors");
      console.warn("[fill-reconciliation] proposal convergence failed:", row.id, error instanceof Error ? error.message : String(error));
    }
  }
}

async function convergeOneProposal(ctx: BrokerTruthContext, row: PlacedProposalRow): Promise<void> {
  const linked = listFillEventsByProposalId(row.id, ctx.userId).filter((fill) => fill.accountNumber === ctx.accountNumber);
  if (linked.some((fill) => fill.status === "pending_reconciliation" || fill.status === "partially_filled")) return;
  const filled = linked.filter((fill) => fill.status === "filled");
  if (filled.length > 0) {
    const notional = filled.reduce((sum, fill) => sum + Math.abs(fill.notional), 0);
    convergeProposal(ctx, row.id, "filled", { via: "linked_fill", fillIds: filled.map((fill) => fill.id) }, notional > 0 ? notional : undefined);
    return;
  }
  const proposal = parseProposal(row.proposal);
  if (linked.length > 0) {
    if (!linked.every((fill) => isRejectedOrCanceledState(fill.status))) return; // e.g. unreconcilable: leave for the owner
    const replacement = linkReplacementExecution({
      userId: ctx.userId,
      accountNumber: ctx.accountNumber,
      proposalId: row.id,
      orderIds: linked.map((fill) => fill.brokerOrderId),
      proposal
    });
    if (replacement?.status === "filled") {
      convergeProposal(ctx, row.id, "filled", { via: "replacement", replacementOrderId: replacement.replacementOrderId }, replacement.notional);
    } else if (!replacement) {
      const states = [...new Set(linked.map((fill) => fill.status))].join("/");
      convergeProposal(ctx, row.id, "rejected_by_broker", { via: "linked_fill", brokerState: states }, undefined, `Broker terminated the order without a fill (state: ${states}).`);
    }
    return;
  }

  // No receipt at all.
  const orderId = row.order_id?.trim();
  if (!orderId || orderId === "undefined") return;
  const existing = findFillEventByBrokerOrderId(ctx.accountNumber, orderId, ctx.userId);
  if (existing) {
    if (!existing.proposalId) {
      try {
        getDb().prepare("UPDATE fill_events SET proposal_id = ? WHERE id = ? AND user_id = ? AND proposal_id IS NULL").run(row.id, existing.id, ctx.userId);
      } catch {
        // unique (proposal_id, broker_order_id) pair already present
      }
    }
    if (existing.status === "filled" && (!existing.proposalId || existing.proposalId === row.id)) {
      convergeProposal(ctx, row.id, "filled", { via: "broker_order_id", fillId: existing.id }, Math.abs(existing.notional) || undefined);
    }
    return;
  }
  if (typeof ctx.gateway.getEquityOrder !== "function" || !proposal) return;
  const result = await lookupBrokerOrder(ctx, orderId);
  if (result.kind === "not_found") {
    auditDeduped(
      "proposal_order_not_found",
      { proposalId: row.id, orderId, symbol: proposal.symbol },
      [row.id, orderId],
      { userId: ctx.userId, connectedAccountId: ctx.connectedAccountId }
    );
    return;
  }
  if (result.kind !== "found") return;
  const { lookup } = result;
  const order = lookup.order;
  const executionMode = (row.execution_mode === "broker/live" || row.execution_mode === "broker/paper")
    ? (row.execution_mode as ExecutionMode)
    : resolveAccountExecutionMode(ctx.userId, ctx.accountNumber, ctx.connectedAccountId);
  if (!executionMode) return;
  bookBracketExitLegs(ctx, lookup, executionMode);
  const state = String(order.state ?? "").trim().toLowerCase();
  const symbol = normalizeSymbol(proposal.symbol || order.symbol);
  const baseRaw = { proposal, source: "proposal_backfill", reconciliation: order };

  if (isFinalPricedExecution(order)) {
    const quantity = order.filledQuantity!;
    const price = order.averagePrice!;
    const notional = Math.abs(quantity * price);
    const inserted = getDb().transaction((): FillEvent | undefined => {
      if (findFillEventByBrokerOrderId(ctx.accountNumber, orderId, ctx.userId)) return undefined;
      const fill = insertFillEvent({
        userId: ctx.userId,
        proposalId: row.id,
        accountNumber: ctx.accountNumber,
        source: fillSourceForExecutionMode(executionMode),
        executionMode,
        symbol,
        side: proposal.side,
        quantity,
        price,
        notional,
        status: "filled",
        brokerOrderId: orderId,
        filledAt: executionTimestamp(order),
        raw: { ...baseRaw, maxBrokerFilledQuantity: quantity }
      });
      updateProposalStatus(row.id, "filled", undefined, undefined, notional, ctx.userId);
      return fill;
    }).immediate();
    if (inserted) {
      bump(ctx.summary, "proposalReceiptsBackfilled");
      bump(ctx.summary, "proposalsConvergedFilled");
      audit("proposal_status_converged", { proposalId: row.id, from: "placed", to: "filled", via: "order_lookup", fillId: inserted.id, brokerState: order.state }, ctx.userId, ctx.connectedAccountId);
      resolveBrokerVerificationNotifications(ctx.userId, { proposalId: row.id, resolution: "placed" });
    }
    return;
  }
  if (isRejectedOrCanceledState(state) && !(order.filledQuantity && order.filledQuantity > 0)) {
    const replacement = linkReplacementExecution({
      userId: ctx.userId,
      accountNumber: ctx.accountNumber,
      proposalId: row.id,
      orderIds: [orderId, lookup.entryLegId],
      proposal
    });
    if (replacement?.status === "filled") {
      convergeProposal(ctx, row.id, "filled", { via: "replacement", replacementOrderId: replacement.replacementOrderId }, replacement.notional);
    } else if (!replacement) {
      convergeProposal(ctx, row.id, "rejected_by_broker", { via: "order_lookup", brokerState: order.state }, undefined, `Broker terminated the order without a fill (state: ${order.state}).`);
    }
    return;
  }
  // Still working, or executed without a usable price yet: give it a pending receipt so the normal
  // reconcilePendingFills path owns it from here on.
  const pendingReceipt = getDb().transaction((): FillEvent | undefined => {
    if (findFillEventByBrokerOrderId(ctx.accountNumber, orderId, ctx.userId)) return undefined;
    return insertFillEvent({
      userId: ctx.userId,
      proposalId: row.id,
      accountNumber: ctx.accountNumber,
      source: fillSourceForExecutionMode(executionMode),
      executionMode,
      symbol,
      side: proposal.side,
      quantity: order.quantity ?? proposal.quantity ?? 0,
      price: 0,
      notional: 0,
      status: "pending_reconciliation",
      brokerOrderId: orderId,
      raw: baseRaw
    });
  }).immediate();
  if (pendingReceipt) bump(ctx.summary, "proposalPendingReceiptsCreated");
}

/** Run sweeps 2 and 3 plus proposal convergence.  Each is isolated: one failing never stops the
 *  others, and none can break the pending-receipt reconciliation that ran before them. */
export async function runBrokerTruthSweeps(ctx: BrokerTruthContext): Promise<void> {
  for (const [name, sweep] of [
    ["bracket-exit-legs", settleBracketExitLegs],
    ["listing-ingest", ingestListingExecutions],
    ["proposal-converge", convergePlacedProposals]
  ] as const) {
    try {
      await sweep(ctx);
    } catch (error) {
      bump(ctx.summary, `${name}Errors`);
      console.warn(`[fill-reconciliation] ${name} sweep failed:`, error instanceof Error ? error.message : String(error));
    }
  }
}
