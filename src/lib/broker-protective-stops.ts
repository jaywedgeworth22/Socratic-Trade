// True broker-held protective stops — two kinds, one reconciler:
//
//  - FIXED (Robinhood, opt-in `robinhoodBrokerStops`): Robinhood's MCP cannot hold a native OCO
//    bracket (unlike Alpaca), so a held position is otherwise protected only by the app's synthetic
//    scheduler-tick monitor — a single point of failure if the app is offline. This lane places a
//    resting broker-side stop-market SELL (GTC) at stopLossPct below entry for each open Robinhood
//    LIVE long, and cancels it when the position closes or a synthetic exit fires (so an orphaned
//    stop can't sell shares we no longer hold).
//
//  - TRAILING (`brokerTrailingStops`, default on; inert until riskRules.trailingStopPct > 0):
//     * Alpaca REST (paper or live): a TRUE native `trailing_stop` order (trail_percent) — the
//       broker trails the high-water mark itself, so the trail keeps moving even while the app is
//       down.
//     * Alpaca MCP: the ratcheted emulation below, through the account's own MCP transport — an
//       MCP-endpoint-only account has no REST keys for the native lane.
//     * Robinhood (live, additionally gated on `robinhoodBrokerStops` — the "resting stops at RH
//       are live-verified" opt-in): the RH MCP exposes no verified native trailing parameter, so
//       this lane places a resting GTC stop-market at trailingStopPct below the high-water mark and
//       RATCHETS it upward (cancel-replace) each tick as the price rises. Between ticks the broker
//       holds a real fixed stop — protection survives app downtime; the trail catches up on the
//       app's cadence.
//    Trailing takes precedence over fixed when both lanes apply: shares can only back ONE resting
//    sell order at the broker, so a position carries either the trailing or the fixed broker stop,
//    never both (the synthetic monitor still layers the other rule on its tick, as always).
//
// Reconciliation runs from the synthetic-stop monitor each tick: it CANCELS stops for closed
// positions every time (risk-reducing, always safe) and PLACES missing stops only when the system is
// running. This self-heals — a restart re-places any missing stops for still-open positions. The
// enabling flags gate only PLACEMENT: when no lane is enabled any more, reconcile still CANCELS
// every stop the feature previously placed for the account, so disabling tears its resting stops
// down instead of orphaning them. Placement is coverage-aware when the caller supplies its order
// list: a position whose shares are already backed by another live exit-side order (an Alpaca OCO
// bracket stop leg, a manual GTC sell) is skipped/right-sized instead of provoking a broker
// rejection. The always-on synthetic monitor remains the fallback, so this is purely additive
// protection.
//
// A pending_cancel row whose cancel call keeps failing (e.g. "order not found" after an earlier
// attempt actually landed broker-side) would otherwise retry forever and permanently block
// re-placement for that symbol. The caller's freshly fetched order list (`orders`, optional) lets
// section 1 recover: if the order shows up there already done resting (filled/rejected/canceled/
// expired), the row is deleted instead of retried again. Absent-from-list or still-live stays
// ambiguous and keeps retrying — never assume terminal without positive evidence. A rejected/
// canceled/expired recovery never moved the position, so section 4 may re-place in the SAME call;
// a FILLED recovery did move it, and the caller fetches `positions` before `orders`, so that one
// case defers re-placement to the next call rather than risk sizing off a stale pre-fill quantity.

import {
  audit,
  deleteBrokerProtectiveStop,
  insertFillEvent,
  listBrokerProtectiveStops,
  upsertBrokerProtectiveStop,
  getDb,
  getStopPlans,
  persistedOrFallbackStopPct,
  type BrokerProtectiveStop,
  listPendingBracketTeardowns,
  removePendingBracketTeardown,
  bumpPendingBracketTeardownAttempts,
  getBrokerStopPlacementIntent,
  upsertBrokerStopPlacementIntent,
  deleteBrokerStopPlacementIntent,
  type BrokerStopPlacementIntent
} from "./db";
import { auditDeduped } from "./audit-dedupe";
import {
  clearOwnerCancelledProtectiveStop,
  hasOwnerCancelledProtectiveStop,
  listOwnerCancelledProtectiveStopSymbols
} from "./order-provenance";
import { isRejectedOrCanceledState, liveExitOrderCoverage } from "./broker-side";

// Steady-state skip reasons fire once per tick per position (~14k identical
// events/day in prod — see src/lib/audit-dedupe.ts). Log the first occurrence
// and then at most once per 6h per (symbol, kind, note) signature.
function auditStopSkipped(
  payload: { symbol?: unknown; kind?: unknown; note?: unknown } & Record<string, unknown>,
  userId: string,
  connectedAccountId?: string,
): void {
  auditDeduped(
    "broker_protective_stop_skipped",
    payload,
    [payload.symbol as string, payload.kind as string, String(payload.note ?? "")],
    { userId, connectedAccountId },
  );
}
import { normalizeSymbol } from "./money";
import { livePreflightBlocks } from "./preflight-live-guard";
import {
  canArmProtectiveTrail,
  clampHaltedReplacementStop,
  fixedProtectiveStopPrice,
  impliedTrailExtreme,
  positionMarkPrice,
  protectiveExitSide,
  protectiveSideOf,
  trailRatchetTighter,
  trailingTriggerFromExtreme,
  type ProtectiveSide
} from "./protective-stop-math";
import type { BrokerGateway, EquityOrder, EquityPosition, ExecutionMode, FillSource, StopPlanStyle, TradingPolicy } from "./types";

/**
 * True when a broker order is done resting for reasons other than an app-issued cancel actually
 * landing — either the broker declined/terminated it (rejected/canceled/expired/failed, both
 * spellings) or it already FILLED. Both are terminal from a "should we keep retrying the cancel"
 * standpoint: a filled stop can never be cancelled (the broker will just keep erroring), and a
 * declined/expired one never rested to begin with. Deliberately narrower than "not live" — an
 * UNRECOGNIZED state must NOT count as terminal here, or a still-resting order in an unfamiliar
 * state would get its local row deleted while the broker-side stop keeps resting, letting a later
 * tick place a second stop over it (two resting sell stops, one invisible — the same failure mode
 * the section-4 placement guard exists to avoid).
 */
function isDoneRestingState(state: string | undefined | null): boolean {
  return isRejectedOrCanceledState(state) || String(state ?? "").trim().toLowerCase() === "filled";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function brokerProtectiveStopsEnabled(policy: TradingPolicy, executionMode: ExecutionMode): boolean {
  if ((policy.riskRules?.stopLossPct ?? 0) <= 0) return false;
  
  if (policy.activeBroker === "alpaca" || policy.activeBroker === "alpaca-mcp") {
    return (executionMode === "broker/live" || executionMode === "broker/paper") && policy.brokerBracketsEnabled !== false;
  }
  
  if (policy.activeBroker === "robinhood") {
    return executionMode === "broker/live" && policy.robinhoodBrokerStops === true;
  }
  
  return false;
}

/**
 * True when broker-held TRAILING stops should be maintained. Requires a configured trailing % and
 * the `brokerTrailingStops` preference (default on — `false` opts out). Alpaca supports native
 * trailing_stop orders in both environments; Robinhood only gets the ratcheted emulation on LIVE,
 * and only under the existing `robinhoodBrokerStops` opt-in (the flag that says "resting stops at
 * Robinhood have been live-verified").
 */
export function brokerTrailingStopsEnabled(policy: TradingPolicy, executionMode: ExecutionMode): boolean {
  if ((policy.riskRules?.trailingStopPct ?? 0) <= 0) return false;
  if (policy.brokerTrailingStops === false) return false;
  if (policy.activeBroker === "alpaca" || policy.activeBroker === "alpaca-mcp") return true;
  if (policy.activeBroker === "robinhood") {
    return executionMode === "broker/live" && policy.robinhoodBrokerStops === true;
  }
  return false;
}

/**
 * Which kind of broker-held protective stop this account should carry per open long. Trailing wins
 * when both lanes apply — a position's shares can only back one resting sell order at the broker.
 */
export function desiredBrokerStopKind(policy: TradingPolicy, executionMode: ExecutionMode): "fixed" | "trailing" | null {
  if (brokerTrailingStopsEnabled(policy, executionMode)) return "trailing";
  if (brokerProtectiveStopsEnabled(policy, executionMode)) return "fixed";
  return null;
}

/**
 * Broker-held buy-stops for shorts.  Default ON when on Alpaca.
 * Live shorts stay Alpaca-only — Robinhood MCP cannot short, and unofficial
 * Webull is never a placement venue.
 */
export function brokerStopsForShortsEnabled(policy: TradingPolicy): boolean {
  if (policy.brokerStopsForShorts === false) return false;
  return policy.activeBroker === "alpaca" || policy.activeBroker === "alpaca-mcp";
}

/**
 * Cancel + forget the resting protective stop(s) for one symbol (best-effort). Safe to call
 * unconditionally — used when a synthetic exit fires so the resting stop can't double-sell.
 */
export async function cancelBrokerProtectiveStop(
  userId: string,
  accountNumber: string,
  symbol: string,
  gateway: BrokerGateway,
  connectedAccountId?: string
): Promise<void> {
  const sym = normalizeSymbol(symbol);
  const rows = listBrokerProtectiveStops(accountNumber, userId).filter((r) => normalizeSymbol(r.symbol) === sym);
  if (rows.length === 0) return;
  // A `pending_replace` marker may carry the REAL client ref of an uncertain halted placement (the
  // broker may have accepted it). Fetch the live order list once so such a marker can be reconciled
  // rather than blindly dropped — dropping it would leave the accepted stop live and able to
  // double-sell after this synthetic exit (Codex review, PR #1738). Best-effort: if the fetch fails we
  // can't reconcile, so we KEEP any real-ref marker for the reconcile loop instead of losing it.
  const hasRealRefMarker = rows.some((r) => r.status === "pending_replace" && !!r.brokerOrderId && !r.brokerOrderId.startsWith("pending-replace-"));
  let liveOrders: EquityOrder[] = [];
  let ordersListed = false;
  if (hasRealRefMarker) {
    try {
      liveOrders = await gateway.getEquityOrders(accountNumber);
      ordersListed = true;
    } catch (err) {
      audit("broker_protective_stop_cancel_error", { symbol: sym, error: errMsg(err), context: "orders_fetch_for_marker_reconcile" }, userId, connectedAccountId);
    }
  }
  for (const row of rows) {
    if (row.status === "pending_replace") {
      const ref = row.brokerOrderId;
      const isRealRef = !!ref && !ref.startsWith("pending-replace-");
      if (!isRealRef) {
        // Synthetic placeholder — no live broker order behind it; drop it (cancelling the fake id would
        // 404 and re-persist a stuck pending_cancel).
        deleteBrokerProtectiveStop(row.id, userId);
        continue;
      }
      const matched = ordersListed ? liveOrders.find((o) => o.clientOrderId === ref) : undefined;
      if (matched && matched.id && !isDoneRestingState(matched.state)) {
        // The accepted order IS live — cancel it by its real id so it can't double-sell after this exit.
        try {
          await gateway.cancelEquityOrder(accountNumber, matched.id);
          deleteBrokerProtectiveStop(row.id, userId);
        } catch (err) {
          audit("broker_protective_stop_cancel_error", { symbol: sym, brokerOrderId: matched.id, error: errMsg(err) }, userId, connectedAccountId);
          upsertBrokerProtectiveStop({ ...row, brokerOrderId: matched.id, status: "pending_cancel" });
        }
        continue;
      }
      if (matched && isDoneRestingState(matched.state)) {
        // Already terminal — nothing to cancel; drop the marker.
        deleteBrokerProtectiveStop(row.id, userId);
        continue;
      }
      // Not visible (or the list fetch failed): KEEP the marker so the reconcile loop can catch and
      // cancel the accepted order once it appears, rather than losing the only handle to it.
      continue;
    }
    try {
      await gateway.cancelEquityOrder(accountNumber, row.brokerOrderId);
      deleteBrokerProtectiveStop(row.id, userId);
    } catch (err) {
      audit("broker_protective_stop_cancel_error", { symbol: sym, brokerOrderId: row.brokerOrderId, error: errMsg(err) }, userId, connectedAccountId);
      // Mark as pending_cancel in DB instead of deleting immediately, to retry later
      upsertBrokerProtectiveStop({ ...row, status: "pending_cancel" });
    }
  }
}

export interface ReconcileResult {
  placed: number;
  cancelled: number;
  /**
   * Broker order ids this reconcile successfully cancelled (one per `cancelled` count). The caller
   * fetched its order list BEFORE reconcile ran, so these orders still look live in that list —
   * it must drop them before deciding whether a symbol is already protected, or a just-torn-down
   * stop suppresses synthetic registration and leaves the position with neither protection.
   */
  cancelledOrderIds: string[];
  /**
   * Normalized symbols this reconcile successfully PLACED a resting broker stop for (one per
   * `placed` count) — the mirror image of `cancelledOrderIds` for the same pre-reconcile-fetch
   * staleness: the caller's order list CANNOT contain these just-placed orders, so quantity-aware
   * coverage would undercount them. On a mismatch cancel/REPLACE tick that undercount is what let
   * the synthetic monitor register + fire against the pruned pre-replace coverage and then cancel
   * the fresh full-size replacement. The caller must treat these symbols as broker-covered for
   * THIS tick — both synthetic REGISTRATION and the FIRE path of already-registered rows (a fire
   * would sell shares the just-placed full-size stop covers, then cancel that stop after booking
   * the fill); the next tick's fresh order fetch sees the real resting order. ONLY full-position
   * placements are listed here — a PARTIAL placement goes in `partiallyPlacedStopSymbols` instead,
   * so suppressing registration can never leave the uncovered remainder stop-less for a tick.
   */
  placedStopSymbols: string[];
  /**
   * Symbols this reconcile placed a broker stop for covering only PART of the position (a
   * fractional remainder the native trailing lane floored away, or shares partially covered by
   * another live exit order). The caller's stale (pre-reconcile) order/coverage list can't see this
   * fresh order, so it must add `partiallyPlacedStopQuantities[symbol]` as KNOWN additional coverage
   * — never simply skip the synthetic fire path outright, or the uncovered remainder (e.g. the
   * fractional share a whole-share-only native trail floored away) is left completely unprotected
   * for the rest of this tick if a fresh quote already breaches the trail (Codex review, PR #1331).
   */
  partiallyPlacedStopSymbols: string[];
  /**
   * The exact quantity `reconcileBrokerProtectiveStops` just placed a resting stop for, keyed by
   * symbol, for every entry in `partiallyPlacedStopSymbols` — lets the caller treat that quantity as
   * known coverage THIS tick (on top of whatever `liveExitOrderCoverage` sees from the stale order
   * list) instead of blindly skipping the fire path for the whole position.
   */
  partiallyPlacedStopQuantities: Record<string, number>;
  /**
   * Symbols whose broker-held protective stop row was recovered THIS call specifically because the
   * tracked order was found already FILLED (not merely rejected/canceled/expired) — a fill that
   * actually reduced the position. The caller's `positions` snapshot was captured BEFORE `orders`
   * (synthetic-stops.ts fetches positions first), so it can still reflect the pre-fill quantity on
   * THIS same call. The caller must treat these symbols the same as `placedStopSymbols` — skip BOTH
   * synthetic registration and the fire path this tick — rather than auto-registering or firing a
   * market exit against a stale, larger-than-actual position (Codex review, PR #1331).
   */
  filledRecoverySymbols: string[];
}

/**
 * Reconcile broker-held protective stops against current positions. Cancels stops whose position has
 * closed (always), then — only when `running` — places a resting stop for each open long that lacks
 * one, of the kind `desiredBrokerStopKind` resolves for this account. No-op unless a lane is enabled.
 */
export async function reconcileBrokerProtectiveStops(args: {
  userId: string;
  policy: TradingPolicy;
  accountNumber: string;
  gateway: BrokerGateway;
  positions: EquityPosition[];
  executionMode: ExecutionMode;
  running: boolean;
  /**
   * The caller's freshly fetched broker order list (e.g. the synthetic-stop monitor's
   * `gateway.getEquityOrders` call earlier in the same tick). Two uses:
   *  - Section-1 pending_cancel recovery: a row whose cancel call keeps failing is cleared when
   *    the order shows up here already done resting (filled/rejected/canceled/expired) — "order
   *    not found" after an earlier cancel actually landed would otherwise retry forever and block
   *    re-placement. Absent-from-list or still-live stays ambiguous and keeps retrying.
   *  - Placement coverage: a position whose shares are already backed by another live exit-side
   *    order (an Alpaca OCO bracket stop leg, a manual GTC sell) gets its broker stop skipped or
   *    right-sized to the uncovered remainder — a second full-size sell for the same shares is at
   *    best a broker rejection and at worst a double-sell. Orders cancelled by THIS reconcile are
   *    pruned before the coverage check, so a just-replaced stop can't suppress its own
   *    replacement.
   * Optional and defaults to empty — a caller that omits it keeps the conservative behavior: rows
   * keep retrying, and placement sizes to the full position (protection over dedup — no coverage
   * info was ever meant to be available from this caller).
   */
  orders?: EquityOrder[];
  /**
   * Whether `orders` reflects a call to `gateway.getEquityOrders` that actually SUCCEEDED this
   * tick, as opposed to a caller that tried and failed (passing `orders: []` because the fetch
   * threw, not because the account genuinely has no open orders). Defaults to `true` so a caller
   * that never fetched at all (and so never had real coverage info to begin with) keeps the
   * original protection-over-dedup behavior. Set to `false` ONLY when a real fetch attempt failed
   * THIS tick: a failed fetch is not evidence of "nothing is resting" — full-size bracket legs or
   * another exit order could easily be live and simply invisible this tick. Placing (or resizing)
   * a broker-held stop against that blind spot risks stacking a second sell on shares another
   * order already commits, so coverage-dependent sizing (`uncoveredQuantity`) returns `null`
   * ("unknown, don't touch") instead of assuming full coverage-free, and BOTH section 3 (mismatch/
   * cancel) and section 4 (new placement) skip a symbol entirely rather than act on a guess
   * (Codex review, PR #1331).
   */
  ordersListed?: boolean;
  /**
   * The synthetic monitor's own already-tracked high-water mark per symbol (its
   * `synthetic_trailing_stops.extreme_price`), fetched by the caller BEFORE this reconcile. The
   * ratchet lane's trigger and the native lane's already-breached guard both anchor to
   * `max(mark, entry)` when this is absent — but if price rallied and pulled back, the app's own
   * trail already tracked the TRUE (higher, tighter) extreme, and reconstructing only from the
   * CURRENT mark silently arms a broker-held trail LOOSER than the one already protecting the
   * position (Codex review, PR #1331: avg 100, synthetic extreme 130, mark 120, 5% trail — the
   * app trigger is 123.50, but recomputing from max(120,100) would arm a broker stop around 114).
   * Optional; a symbol with no row yet (freshly registering) falls back to `max(mark, entry)`.
   */
  extremePriceBySymbol?: Record<string, number>;
  /**
   * Per-position stop PLANS (LLM-chosen stop TYPE, persisted at fill time), keyed by symbol —
   * fetched by the caller (synthetic-stops.ts, which already self-loads them). A plan can only
   * NARROW which of the account's own enabled lane(s) apply to that one symbol — it never invents
   * a broker capability the account doesn't otherwise have: "trailing" excludes the fixed lane for
   * that symbol; "fixed"/"atr" exclude the trailing lane; "none" excludes both (any existing
   * resting row for that symbol is torn down, mirroring the account-wide disabled teardown, so a
   * broker-held stop can never keep resting in silent contradiction of an owner/LLM "no stop"
   * choice). A symbol excluded from every kind the account has falls back to the always-on
   * synthetic monitor, which separately honors "trailing"/"none" unconditionally. Absent/"default"
   * → the account's own precedence for that symbol, unchanged from before this param existed.
   */
  stopPlanBySymbol?: Record<string, StopPlanStyle>;
  /**
   * Protect-while-halted mode: the account is Stopped but still protecting open positions
   * (`policy.systemState === "halted"` with the monitor's fire loop running). The rule is: a halt must
   * not initiate NEW or LOOSER protection, but risk-REDUCING corrections to EXISTING protection are
   * allowed. Concretely it suppresses section 4 placement for a position that has NO stop (that is new
   * activity) and the section-3 mismatch cancel-THEN-replace for non-shrink drift
   * (kind/price/trail/ratchet/quantity-GROWTH — those either loosen or don't reduce exposure). But when
   * an EXISTING stop is OVERSIZED (its quantity exceeds the current position after an out-of-band
   * partial exit — resting or pending_cancel), it is RIGHT-SIZED even while halted: the oversized order
   * is cancelled AND section 4 places a correctly-sized replacement for that symbol the same tick, so
   * the position is never left over-selling (the oversized order firing) NOR unprotected (a broker-
   * covered position has no synthetic row, and the synthetic monitor does not register new stops while
   * halted — Codex review, PR #1738). Pass `running: true` alongside this (the halt gates protection
   * INITIATION, not the whole reconcile) — sections 1/2/2b (pure cancels) already run regardless of
   * `running`. Defaults to false.
   */
  haltedProtectOnly?: boolean;
}): Promise<ReconcileResult> {
  const { userId, policy, accountNumber, gateway, positions, executionMode, running, orders = [], ordersListed = true, extremePriceBySymbol = {}, stopPlanBySymbol = {}, haltedProtectOnly = false } = args;
  const out: ReconcileResult = { placed: 0, cancelled: 0, cancelledOrderIds: [], placedStopSymbols: [], partiallyPlacedStopSymbols: [], partiallyPlacedStopQuantities: {}, filledRecoverySymbols: [] };
  // Symbols whose OVERSIZED existing stop was cancelled THIS tick while halted (resting shrink or
  // pending_cancel). Section 4 places a right-sized replacement for exactly these while halted — the
  // only placement a halt allows (a risk-reducing correction of existing protection, never new
  // protection for an unprotected position). Codex review, PR #1738.
  const haltedRightsizeSymbols = new Set<string>();
  // Per-symbol tighter-trigger FLOOR captured when a halted right-size cancels an existing stop: the
  // same-tick replacement must not be LOOSER than the stop it replaced (a halt allows only
  // risk-reducing corrections). Keyed by the cancelled stop's own trigger; section 4 clamps a fixed
  // replacement up to it so a widened stopLossPct can't quietly loosen protection during the halt
  // (Codex review, PR #1738). Trailing is already arm-gated (canArmTrailingNow) against loosening.
  const haltedRightsizeFloor = new Map<string, number>();

  const kind = desiredBrokerStopKind(policy, executionMode);
  const source: FillSource = executionMode === "broker/live" ? "live" : "paper";
  const shortsEnabled = brokerStopsForShortsEnabled(policy);
  const livePositions = new Map<string, EquityPosition>();
  for (const p of positions) {
    if (p.quantity > 0.000001) livePositions.set(normalizeSymbol(p.symbol), p);
    else if (shortsEnabled && p.quantity < -0.000001) livePositions.set(normalizeSymbol(p.symbol), p);
  }
  // Retire owner-cancel tombstones whose position is gone.  The tombstone
  // (order-provenance.ts) means "the owner un-protected THIS position, do not re-place its
  // stop"; it is written permanently with no expiry, and before this sweep nothing ever
  // removed it.  So one manual stop cancel on a symbol used to suppress section 4's placement
  // for that symbol FOREVER — including for a brand-new position opened long after the one the
  // owner actually un-protected, which the owner never declined protection on and which would
  // then sit naked with only an audit line to say why.
  //
  // "Absent from `positions`" is positive evidence of flat, not a failed read: the only caller
  // (synthetic-stops.ts:250-255) returns early when `getEquityPositions` throws, so reaching
  // here means this snapshot came back successfully.  Flatness is read off the raw `positions`
  // array rather than `livePositions` because `livePositions` omits shorts when the account has
  // `brokerStopsForShortsEnabled` off — an open short would otherwise look flat and lose its
  // tombstone.
  const heldSymbols = new Set(
    positions.filter((p) => Math.abs(p.quantity) > 0.000001).map((p) => normalizeSymbol(p.symbol))
  );
  for (const tombstonedSymbol of listOwnerCancelledProtectiveStopSymbols(userId, accountNumber)) {
    if (heldSymbols.has(tombstonedSymbol)) continue;
    clearOwnerCancelledProtectiveStop(userId, accountNumber, tombstonedSymbol);
    audit(
      "owner_cancelled_protective_stop_cleared",
      {
        accountNumber,
        symbol: tombstonedSymbol,
        reason: "position closed — the do-not-replace tombstone does not carry over to a new position"
      },
      userId,
      policy.connectedAccountId
    );
  }
  let stopContracts: Record<string, ReturnType<typeof getStopPlans>[string]> = {};
  try {
    stopContracts = getStopPlans(accountNumber, userId);
  } catch {
    stopContracts = {};
  }
  const longStopPct = policy.riskRules?.stopLossPct ?? 0;
  const shortStopPct = policy.riskRules?.shortStopLossPct ?? longStopPct;
  const sideOf = (pos: EquityPosition): ProtectiveSide => protectiveSideOf(pos);
  const stopPctFor = (pos: EquityPosition, sym: string): number => {
    const fallback = sideOf(pos) === "short" ? shortStopPct : longStopPct;
    return persistedOrFallbackStopPct(stopContracts[sym], fallback);
  };
  const fillSideFor = (symbol: string, order?: EquityOrder): "sell" | "cover" => {
    const pos = livePositions.get(normalizeSymbol(symbol));
    if (pos) return protectiveExitSide(sideOf(pos));
    const raw = String(order?.side ?? "").trim().toLowerCase();
    return raw === "buy" || raw === "cover" ? "cover" : "sell";
  };
  // Narrow the account-wide kind for one symbol per its own stop plan (never widen/invent beyond
  // what the account already has enabled — see the stopPlanBySymbol param doc above). An "atr" plan
  // maps to the fixed lane ONLY when the Exit Contract persisted a stop price or resolved % at fill;
  // otherwise we still refuse a mispriced flat-% broker stop (Codex review, PR #1371).
  const kindForSymbol = (sym: string): "fixed" | "trailing" | null => {
    const plan = stopPlanBySymbol[sym] ?? "default";
    if (plan === "none") return null;
    // `kind` picks TRAILING first when an account has both lanes enabled (desiredBrokerStopKind's
    // own precedence) — so `kind === "trailing"` already correctly reflects trailing-lane
    // availability regardless of whether fixed is ALSO enabled. But that same precedence means an
    // account with BOTH lanes on reports `kind === "trailing"`, which would wrongly make a "fixed"
    // plan's `kind === "fixed"` check fail even though the fixed lane is independently enabled and
    // available — check that lane's own enablement directly instead of going through the
    // precedence-resolved `kind` (Codex review, PR #1371).
    if (plan === "trailing") return kind === "trailing" ? "trailing" : null;
    if (plan === "fixed") return brokerProtectiveStopsEnabled(policy, executionMode) ? "fixed" : null;
    if (plan === "atr") {
      const contract = stopContracts[sym];
      const hasContract =
        (typeof contract?.stopPrice === "number" && contract.stopPrice > 0) ||
        (typeof contract?.resolvedStopPct === "number" && contract.resolvedStopPct > 0);
      return hasContract && brokerProtectiveStopsEnabled(policy, executionMode) ? "fixed" : null;
    }
    return kind;
  };

  // A broker-held protective stop's tracked order was found FILLED at the broker (native trail or
  // ratcheted stop-market closing the position) before our own reconciliation ever saw it as a
  // pending exit — book the fill now, from the row's own recorded terms, so realized P&L/learning/
  // activity see this exit at all. Without this the row was simply deleted and the fill vanished
  // (Codex review, PR #1331).
  const bookBrokerHeldStopFill = (row: BrokerProtectiveStop, order: EquityOrder): void => {
    const qty = order.filledQuantity ?? row.quantity;
    const price = order.averagePrice ?? row.stopPrice;
    insertFillEvent({
      userId,
      accountNumber,
      source,
      executionMode,
      symbol: normalizeSymbol(row.symbol),
      side: fillSideFor(row.symbol, order),
      quantity: qty,
      price,
      notional: qty * price,
      status: "filled",
      brokerOrderId: row.brokerOrderId,
      raw: { brokerHeldProtectiveStop: true, kind: row.kind }
    });
  };
  // Every recovery path below used to delete the tracking row THEN book the fill as two separate
  // statements — a crash (process killed, machine reboot) between them left the row gone with the
  // fill never booked, silently losing it forever (nothing remains to signal a retry is owed). Wrap
  // both writes in one transaction so they always land together or not at all; a re-run after a crash
  // before this fix finds the row exactly as it was and can safely retry (Item 6, 2026-07-18).
  // insertFillEvent's own broker-held-stop-recovery unique index additionally makes a genuine double-invocation of
  // this same pair (same row, same order) an idempotent no-op rather than a duplicate fill.
  const deleteAndBookBrokerStopFill = getDb().transaction((row: BrokerProtectiveStop, order: EquityOrder): void => {
    deleteBrokerProtectiveStop(row.id, userId);
    bookBrokerHeldStopFill(row, order);
  });
  // Same atomic pair for the placement-INTENT lane (Item 5): an intent whose accepted order is found
  // already TERMINAL with executed quantity has no broker_protective_stops row to delete — the intent
  // row IS the tracking. Delete it and book the executed fill in one transaction, with the same
  // `brokerHeldProtectiveStop` marker so the recovery unique index makes a replay idempotent. The
  // fill is keyed by the REAL broker order id (stable across replays — the same order matches the
  // intent's client ref every time).
  const deleteIntentAndBookStopFill = getDb().transaction((intent: BrokerStopPlacementIntent, order: EquityOrder): void => {
    deleteBrokerStopPlacementIntent(intent.accountNumber, intent.symbol, userId);
    const qty = order.filledQuantity ?? intent.quantity;
    const price = order.averagePrice ?? intent.stopPrice;
    insertFillEvent({
      userId,
      accountNumber,
      source,
      executionMode,
      symbol: normalizeSymbol(intent.symbol),
      side: fillSideFor(intent.symbol, order),
      quantity: qty,
      price,
      notional: qty * price,
      status: "filled",
      brokerOrderId: order.id,
      raw: { brokerHeldProtectiveStop: true, kind: intent.kind }
    });
  });
  // A terminal order can still carry a positive filledQuantity even when its OVERALL state is
  // "canceled"/"expired"/"rejected", not literally "filled" — a stop that partially executes and
  // then dies (e.g. a canceled remainder) DID move some shares. Book on EITHER signal: the literal
  // "filled" state (kept for a mapper/mock that reports a full fill without ever populating
  // filledQuantity) OR a positive filledQuantity regardless of state — either alone missing the
  // other must still book, or an unbooked fill vanishes from P&L/learning/activity (Codex review,
  // PR #1331).
  const hadExecutedFill = (order: EquityOrder): boolean =>
    String(order.state ?? "").trim().toLowerCase() === "filled" || (order.filledQuantity ?? 0) > 0;

  // Symbols whose pending_cancel row section 1 just recovered THIS call specifically because the
  // order was found FILLED (not merely rejected/canceled/expired). A fill actually reduces the
  // position, but `positions` was captured by the caller (synthetic-stops.ts fetches it BEFORE
  // `orders`) — so if the fill lands broker-side in the gap between those two reads, `positions`
  // can still show the pre-fill quantity on THIS same call. Letting section 4 re-place immediately
  // would then use that stale quantity, resting a fresh sell stop sized for shares that are already
  // gone. Rejected/canceled/expired recoveries don't have this problem (the position never moved),
  // so only "filled" recoveries defer — placement resumes next call once a fresh position read is
  // in hand (the synthetic monitor still protects the position in the meantime).
  const filledRecoverySymbols = new Set<string>();

  // The flags gate only PLACEMENT of new stops — never CANCELLATION. When no lane is enabled any
  // more (flags off / not the applicable broker/environment / no configured %), any stop previously
  // placed is still resting live at the broker. Turning the feature off must TEAR THOSE DOWN, not
  // strand them: an orphaned GTC stop-market SELL would rest forever with no app-side cleanup and
  // could later sell shares the user no longer intends to protect this way. This teardown is pure
  // risk reduction (it never places a replacement), so the `liveReplaceBlocked` "never leave a
  // position unprotected" guard — which only matters when we cancel WITH intent to re-place — does
  // not apply here. If no rows exist, this is a true no-op (the common disabled/default case).
  if (kind === null) {
    for (const row of listBrokerProtectiveStops(accountNumber, userId)) {
      // A 'pending_replace' row is a halted right-size retry MARKER (synthetic brokerOrderId), not a
      // live order. The plan now wants NO stop, so drop the marker — there is nothing to cancel at
      // the broker and no replacement is owed (cancelling the fake id would 404 -> stuck pending_cancel).
      if (row.status === "pending_replace") {
        deleteBrokerProtectiveStop(row.id, userId);
        continue;
      }
      try {
        await gateway.cancelEquityOrder(accountNumber, row.brokerOrderId);
        // A successful cancel doesn't mean nothing filled first — a GTC stop can partially execute
        // before the cancel reaches the broker, and the broker still accepts the cancel for the
        // remainder. The caller's pre-reconcile order snapshot (`orders`) can still show that
        // partial fill; book it ATOMICALLY with deleting this row's tracking (a crash between the two
        // must not silently drop an executed fill — Item 6, 2026-07-18), or the executed shares never
        // reach fill_events/P&L/learning, and the caller isn't told the position may be stale (Codex
        // review, PR #1331, round 10).
        const preCancelOrder = orders.find((o) => o.id === row.brokerOrderId);
        if (preCancelOrder && hadExecutedFill(preCancelOrder)) {
          deleteAndBookBrokerStopFill(row, preCancelOrder);
          out.filledRecoverySymbols.push(normalizeSymbol(row.symbol));
        } else {
          deleteBrokerProtectiveStop(row.id, userId);
        }
        out.cancelled++;
        out.cancelledOrderIds.push(row.brokerOrderId);
      } catch (err) {
        // The cancel failed — but that doesn't necessarily mean the order is still resting
        // broker-side. Mirror section 1's recovery: if the caller's freshly fetched order list shows
        // this order already done resting (most commonly FILLED — the stop did its job before our
        // own cancel attempt reached the broker), the row is stale bookkeeping, not a stuck cancel.
        // Without this check, a filled broker-held stop while the feature stays disabled would retry
        // its cancel FOREVER (kind stays null every tick) and its fill would never reach
        // fill_events/P&L/learning at all (Codex review, PR #1331).
        const found = orders.find((o) => o.id === row.brokerOrderId);
        if (found && isDoneRestingState(found.state)) {
          if (hadExecutedFill(found)) {
            // Signal this recovery to the caller the same way section 1/3 do: `positions` was
            // captured before `orders` this tick, so a fill discovered only here can still leave
            // the caller holding a stale (pre-fill) position snapshot for the rest of THIS tick —
            // it must skip synthetic registration/fire for the symbol, same as a live-lane fill
            // recovery (Codex review, PR #1331, round 10 — this branch previously booked the fill
            // but never told the caller). Atomic with the delete (Item 6, 2026-07-18).
            deleteAndBookBrokerStopFill(row, found);
            out.filledRecoverySymbols.push(normalizeSymbol(row.symbol));
          } else {
            deleteBrokerProtectiveStop(row.id, userId);
          }
          audit("broker_protective_stop_cancel_recovered", { symbol: row.symbol, brokerOrderId: row.brokerOrderId, brokerState: found.state, error: errMsg(err), context: "disabled_teardown" }, userId, policy.connectedAccountId);
        } else {
          audit("broker_protective_stop_cancel_error", { symbol: row.symbol, brokerOrderId: row.brokerOrderId, error: errMsg(err), context: "disabled_teardown" }, userId, policy.connectedAccountId);
          // Keep it as pending_cancel so a later tick retries the cancel rather than orphaning the
          // resting broker stop (listBrokerProtectiveStops returns pending_cancel rows, so the next
          // disabled reconcile re-attempts it).
          upsertBrokerProtectiveStop({ ...row, status: "pending_cancel" });
        }
      }
    }
    return out;
  }

  const trailPct = policy.riskRules?.trailingStopPct ?? 0;
  // Native trailing_stop orders exist only on the Alpaca REST lane. An `alpaca-mcp` account can be
  // configured with ONLY an MCP endpoint (no REST keys), and the gateway's trailing branch goes
  // REST-direct — so alpaca-mcp deliberately takes the ratcheted stop-market emulation through its
  // own MCP transport instead of failing placement every tick (Codex review, PR #1331).
  const nativeTrailing = policy.activeBroker === "alpaca";

  // Coverage-aware target quantity for a symbol's broker stop: the shares NOT already covered by
  // some OTHER live exit order (a bracket leg, a manual GTC sell, a resting take-profit trim).
  // Placing a stop for already-covered shares stacks more exit quantity than the account holds —
  // if both orders fill, the position is over-sold. Mirrors the synthetic fire path's
  // uncovered-remainder rule. `excludeOrderId` drops our OWN resting stop (the order a mismatch
  // replacement is about to cancel) from the count; orders this reconcile already cancelled are
  // dropped too. An unknowable order quantity counts as full coverage (failing toward
  // no-duplicate-sell). Without a caller-supplied order list, the full position quantity is used
  // (pre-coverage behavior — protection over dedup). Returns `null` — coverage genuinely UNKNOWN,
  // not "known to be zero" — when the caller attempted a real fetch this tick and it failed
  // (`ordersListed: false`): callers must treat `null` as "don't touch this symbol's broker-held
  // sizing at all", never as 0 or as full.
  const uncoveredQuantity = (pos: EquityPosition, sym: string, excludeOrderId?: string): number | null => {
    const full = Math.abs(pos.quantity);
    if (orders.length === 0) return ordersListed ? full : null;
    const cancelled = new Set(out.cancelledOrderIds);
    const cov = liveExitOrderCoverage(
      orders.filter((o) => !cancelled.has(o.id) && o.id !== excludeOrderId),
      sym,
      sideOf(pos)
    );
    if (cov.unknownQty) return 0;
    return Math.max(full - cov.coveredQty, 0);
  };

  // Any Alpaca-family broker (REST native trailing_stop, or MCP's ratcheted stop_market emulation) —
  // both submit real Alpaca orders at gtc time-in-force. Alpaca's own fractional-trading docs require
  // time_in_force=day for a fractional stop/stop-limit order; this reconciler always sends gtc, so a
  // fractional quantity risks a broker rejection that would leave even the whole-share portion with
  // no broker-held protection (Codex review, PR #1331/#1371). Flooring to whole shares on EITHER
  // Alpaca transport — not just the native REST lane — sidesteps that entirely; the fractional
  // remainder still gets synthetic monitor coverage, same as the native lane already relied on.
  const isAlpacaFamily = policy.activeBroker === "alpaca" || policy.activeBroker === "alpaca-mcp";

  // The share quantity a broker-held stop of this kind should cover: the uncovered remainder,
  // floored to whole shares on any Alpaca trailing lane — the synthetic monitor's quantity-aware
  // coverage picks up any remainder. `null` propagates from uncoveredQuantity unchanged — "coverage
  // unknown this tick", not "zero".
  const desiredStopQuantity = (pos: EquityPosition, sym: string, forKind: "fixed" | "trailing", excludeOrderId?: string): number | null => {
    const qty = uncoveredQuantity(pos, sym, excludeOrderId);
    if (qty === null) return null;
    return isAlpacaFamily ? Math.floor(qty) : qty;
  };

  // Trailing trigger for the ratcheted (non-native) lane: trailingStopPct below the high-water
  // mark. The observable extreme is max(current mark, entry, the synthetic monitor's OWN
  // already-tracked extreme for this symbol) — falling back to max(mark, entry) only when no
  // synthetic row exists yet. Using the real tracked extreme (not reconstructing from the current
  // mark alone) means enabling broker-held trailing can never arm a LOOSER trigger than the trail
  // already protecting the position after a rally-then-pullback. Only ever ratchets UP (section 3).
  const trailingTriggerPrice = (pos: EquityPosition, sym: string): number => {
    return trailingTriggerFromExtreme(
      positionMarkPrice(pos),
      pos.averageCost,
      extremePriceBySymbol[sym] ?? 0,
      trailPct,
      sideOf(pos)
    );
  };

  const canArmTrailingNow = (pos: EquityPosition, sym: string, stopPrice: number): boolean => {
    return canArmProtectiveTrail({
      mark: positionMarkPrice(pos),
      avgCost: pos.averageCost,
      trackedExtreme: extremePriceBySymbol[sym] ?? 0,
      stopPrice,
      nativeTrailing,
      side: sideOf(pos)
    });
  };

  const fixedStopPrice = (pos: EquityPosition, sym: string): number => {
    const contract = stopContracts[sym];
    if (typeof contract?.stopPrice === "number" && contract.stopPrice > 0) return round2(contract.stopPrice);
    return fixedProtectiveStopPrice(pos.averageCost, stopPctFor(pos, sym), sideOf(pos));
  };

  // Would section 4 actually be able to PLACE a right-sized replacement for this symbol THIS tick?
  // Every HALTED risk-reducing cancel is conditioned on this: while halted the synthetic monitor won't
  // register a fallback, so cancelling an oversized stop when the replacement can't be placed would
  // leave the position with NO protection. `null` uncovered qty (order-list fetch failed) or a trailing
  // trigger that can't arm (mark below the tracked extreme after a rally-then-pullback) both mean
  // "can't place — keep the existing stop". `qty <= 0` means other live exit orders already cover the
  // position, so cancelling needs no replacement (safe). Codex review, PR #1738.
  const replacementPlaceable = (pos: EquityPosition, sym: string, forKind: "fixed" | "trailing", excludeOrderId?: string): boolean => {
    if (!(pos.averageCost > 0)) return false;
    const q = desiredStopQuantity(pos, sym, forKind, excludeOrderId);
    if (q === null) return false;
    if (q <= 0) return true;
    if (forKind === "fixed") return true;
    const trigger = trailingTriggerPrice(pos, sym);
    return trigger > 0 && canArmTrailingNow(pos, sym, trigger);
  };

  // Open positions this lane will protect. Longs always; shorts only when
  // brokerStopsForShortsEnabled (Alpaca + short selling on). Computed UP FRONT
  // so cancel/teardown guards know which positions are still open.
  // Would a live REPLACEMENT stop be blocked (broker/live without ALLOW_LIVE_TRADING)? If so, we must
  // not cancel an OPEN position's only stop with no replacement — that would leave it unprotected.
  // Cancels for CLOSED positions stay risk-reducing and are never blocked.
  const liveReplaceBlocked = livePreflightBlocks({ mode: executionMode });

  // 1. Retry pending cancellations first — but for a STILL-OPEN position, skip the retry when a
  //    replacement can't be placed (keep its existing stop rather than orphaning the position).
  //    EXCEPT when the symbol's CURRENT plan excludes every lane the account has (kindForSymbol
  //    returns null, e.g. "none", or a scale-in that switched lanes) — that row was never going to
  //    be replaced regardless of liveReplaceBlocked (section 2b tears it down unconditionally), so
  //    blocking its retry here just leaves a plan-contradicting stop resting indefinitely while live
  //    placement happens to be disabled (Codex review, PR #1371).
  for (const row of listBrokerProtectiveStops(accountNumber, userId)) {
    if (row.status === "pending_replace") {
      // A prior halted right-size cancel succeeded but its replacement placement failed/was rejected;
      // this durable marker records the owed retry.
      const rowSym = normalizeSymbol(row.symbol);
      const markerRef = row.brokerOrderId;
      const markerHasRealRef = !!markerRef && !markerRef.startsWith("pending-replace-");
      if (markerHasRealRef) {
        // The marker carries the CLIENT REF of an uncertain placement (it threw AFTER the broker may
        // have accepted it). Reconcile that ref against the fetched order list here — the single place
        // that owns marker resolution — BEFORE any keep/drop decision, so an accepted broker stop is
        // never orphaned (untracked, uncancellable) nor double-sold (Codex review, PR #1738).
        const matched = orders.find((o) => o.clientOrderId === markerRef);
        if (matched && matched.id && !isDoneRestingState(matched.state)) {
          // The order IS live at the broker — adopt it (track by its real id) so it is managed like any
          // resting stop. The upsert reuses the same row id, turning the marker into a resting row.
          upsertBrokerProtectiveStop({
            id: `protstop-${userId}-${accountNumber}-${rowSym}`,
            userId,
            accountNumber,
            symbol: rowSym,
            brokerOrderId: matched.id,
            quantity: matched.quantity && matched.quantity > 0 ? matched.quantity : row.quantity,
            stopPrice: matched.stopPrice && matched.stopPrice > 0 ? matched.stopPrice : row.stopPrice,
            status: "resting",
            kind: row.kind,
            trailPercent: row.trailPercent,
          });
          audit("broker_protective_stop_adopted", { symbol: rowSym, brokerOrderId: matched.id, clientOrderId: markerRef, note: "adopted the accepted order from a prior uncertain halted placement (section 1)" }, userId, policy.connectedAccountId);
          continue;
        }
        if (matched && isDoneRestingState(matched.state)) {
          // The accepted order already terminated. Book any executed fill so it reaches P&L/learning,
          // and drop the marker (nothing left to track) — ATOMICALLY, so a crash between the two
          // can't lose the fill (Item 6, 2026-07-18).
          if (hadExecutedFill(matched)) {
            deleteAndBookBrokerStopFill(row, matched);
            filledRecoverySymbols.add(rowSym);
            out.filledRecoverySymbols.push(rowSym);
          } else {
            deleteBrokerProtectiveStop(row.id, userId);
          }
          continue;
        }
        // No order carrying this ref is visible this tick (accepted-but-not-yet-visible, or never
        // accepted). KEEP the marker so a later tick can reconcile it — dropping it would lose the only
        // handle to a possibly-live broker stop (double-sell/orphan risk). If still halted+live, also
        // re-queue so section 4 reuses the ref (broker idempotency then rejects a duplicate placement).
        if (haltedProtectOnly && livePositions.has(rowSym) && kindForSymbol(rowSym) !== null) haltedRightsizeSymbols.add(rowSym);
        continue;
      }
      // Synthetic placeholder marker (no real order behind it). KEEP it until section 4 actually places
      // the replacement — deleting it before placement is proven would lose the "this symbol owes a
      // right-size" signal whenever section 4 then SKIPS (order-list fetch failed, native trail can't
      // arm yet, sub-share qty), leaving the position unprotected until unhalted while halted synthetic
      // registration stays disabled (Codex review, PR #1738). Section 4 excludes pending_replace rows
      // from its `existing` guard so the kept marker still places; a successful placement upserts the
      // same row id to `resting`, a failed one re-persists the marker.
      if (haltedProtectOnly && livePositions.has(rowSym) && kindForSymbol(rowSym) !== null) {
        haltedRightsizeSymbols.add(rowSym);
        continue; // keep the marker — section 4 owns resolving it this tick
      }
      // Not halted, or the position closed, or the plan now excludes every lane: the placeholder marker
      // is moot. Drop it — no live broker order backs it. When not halted, section 4 runs ungated and
      // re-establishes protection via its normal place-if-missing path.
      deleteBrokerProtectiveStop(row.id, userId);
      continue;
    }
    if (row.status === "pending_cancel") {
      const rowSym = normalizeSymbol(row.symbol);
      // Skip the pending_cancel retry for a STILL-OPEN position that still wants a stop when a
      // replacement can't be placed this tick — either the live-preflight escape hatch
      // (`liveReplaceBlocked`) OR a halt (`haltedProtectOnly`). The row may track a still-live broker
      // order (its cancel keeps failing); succeeding here would remove the position's only broker-held
      // stop and then section 4 would refuse the replacement, stranding it — exactly what the
      // section-3 non-shrink mismatch guard prevents. Keep it pending_cancel and retry on a later
      // non-halted/allowed tick; the old stop keeps protecting until then. A symbol whose plan now
      // excludes every lane (`kindForSymbol === null`) is a risk-reducing teardown and still retries.
      //
      // EXCEPTION while halted (not the liveReplaceBlocked escape hatch): if the pending row is
      // OVERSIZED (its quantity exceeds the current position after an out-of-band partial exit) it
      // would over-sell/open a short if it fires, so the risk-reducing cancel must run — and section 4
      // right-sizes the symbol the same tick (`haltedRightsizeSymbols`), so protection is kept, not
      // stranded. Section 3 only examines `status === "resting"` stops, so this pending_cancel path is
      // the ONLY place that can clear such an oversized order (Codex review, PR #1738).
      // Set true only on the halted+oversized fall-through below (after the placeability guard),
      // so the durable right-size retry marker is authorized ONLY when a live cancel is about to run
      // for an oversized stop while halted — never on the escape-hatch path or a non-halted cancel.
      let markRightsizeOnCancel = false;
      if ((liveReplaceBlocked || haltedProtectOnly) && livePositions.has(rowSym) && kindForSymbol(rowSym) !== null) {
        const rowPos = livePositions.get(rowSym);
        const rowKind = kindForSymbol(rowSym);
        // "Oversized" is judged against the UNCOVERED remainder (`desiredStopQuantity`), NOT the whole
        // position — another live exit order (a bracket leg, a manual sell) may already cover part of
        // the position, so a pending stop can STACK on top of it and over-sell even when the position
        // itself never shrank (Codex review, PR #1738). `null` uncovered (order-list fetch failed) ->
        // not treated as oversized (can't size a replacement anyway; `replacementPlaceable` also fails),
        // so the still-live stop is kept and the resize deferred to a coverage-known tick.
        const uncoveredForRow = rowPos && rowKind ? desiredStopQuantity(rowPos, rowSym, rowKind, row.brokerOrderId) : null;
        const oversized = uncoveredForRow != null && row.quantity > uncoveredForRow + 0.000001;
        // Backfill this symbol's tracked extreme from the row's OWN recorded terms BEFORE the
        // placeability check below — the section-3 backfill loop runs LATER, so without this
        // `replacementPlaceable` -> `canArmTrailingNow` would see `trackedExtreme=0` and wrongly deem a
        // native trail armable from the depressed mark (looser than the broker's ratcheted peak),
        // cancelling the ratcheted stop into a looser replacement during a halt (Codex review, PR #1738).
        // Idempotent (guarded per-symbol); section 3's loop then leaves it as-is.
        if (rowKind === "trailing" && row.trailPercent && row.trailPercent > 0 && !extremePriceBySymbol[rowSym]) {
          const side = rowPos ? sideOf(rowPos) : "long";
          let e = impliedTrailExtreme(row.stopPrice, row.trailPercent, side);
          const lo = orders.find((o) => o.id === row.brokerOrderId);
          if (lo && typeof lo.stopPrice === "number" && lo.stopPrice > 0) {
            const oe = impliedTrailExtreme(lo.stopPrice, row.trailPercent, side);
            if (oe > 0) e = side === "short" ? (e > 0 ? Math.min(e, oe) : oe) : Math.max(e, oe);
          }
          if (e > 0) extremePriceBySymbol[rowSym] = e;
        }
        // Halted + oversized: retry the cancel ONLY if a right-sized replacement can actually be placed
        // this tick (else cancelling would strand the position — no synthetic fallback registers while
        // halted). Not placeable (fetch failed / trailing can't arm) -> keep the still-live stop; the
        // over-sell risk of an oversized stop is bounded, being unprotected is not. liveReplaceBlocked
        // (escape hatch) never touches the broker regardless (Codex review, PR #1738).
        if (liveReplaceBlocked || !oversized || !(rowPos && rowKind && replacementPlaceable(rowPos, rowSym, rowKind, row.brokerOrderId))) continue;
        // Reached only when halted + oversized + a right-sized replacement is placeable this tick.
        markRightsizeOnCancel = haltedProtectOnly;
      }
      try {
        await gateway.cancelEquityOrder(accountNumber, row.brokerOrderId);
        deleteBrokerProtectiveStop(row.id, userId);
        // Mark only after the broker confirms the live cancel. A thrown cancel
        // or terminal no-fill recovery must not authorize new protection while
        // halted. Record the cancelled stop's trigger as the floor so the same-tick
        // replacement can't be looser than what it replaced.
        if (markRightsizeOnCancel) {
          haltedRightsizeSymbols.add(rowSym);
          if (row.stopPrice > 0) haltedRightsizeFloor.set(rowSym, row.stopPrice);
        }
        out.cancelled++;
        out.cancelledOrderIds.push(row.brokerOrderId);
      } catch (err) {
        // The cancel call itself failed — but that doesn't necessarily mean the order is still
        // resting broker-side (e.g. a prior cancel attempt actually landed and this one is just
        // "order not found", or the stop simply filled before the cancel reached the broker).
        // Check the caller's freshly fetched order list: if the order shows up there in a state
        // that's done resting (filled/rejected/canceled/expired), the row is stale bookkeeping —
        // delete it so section 4 can re-place for the symbol. A rejected/canceled/expired order
        // never moved the position, so that re-place resumes in THIS SAME call; a filled order DID
        // move the position, so filledRecoverySymbols below makes section 4 defer that one case to
        // the next call instead (see its comment). If the order is ABSENT from the list or still
        // live, stay conservative and keep retrying next tick
        // (an absent order is ambiguous, not confirmed dead — see broker-protective-stops.ts's
        // module doc and the section-4 "never orphan a possibly-still-live stop" guard).
        const found = orders.find((o) => o.id === row.brokerOrderId);
        if (found && isDoneRestingState(found.state)) {
          // A partial fill DID move shares even when the order's overall terminal state is
          // canceled/expired/rejected (not literally "filled") — book it ATOMICALLY with deleting
          // this row (Item 6, 2026-07-18), and defer section 4's replacement sizing to the next call
          // the same way a full fill does (Codex review, PR #1331).
          if (hadExecutedFill(found)) {
            deleteAndBookBrokerStopFill(row, found);
            const s = normalizeSymbol(row.symbol);
            filledRecoverySymbols.add(s);
            out.filledRecoverySymbols.push(s);
          } else {
            deleteBrokerProtectiveStop(row.id, userId);
          }
          audit(
            "broker_protective_stop_cancel_recovered",
            { symbol: row.symbol, brokerOrderId: row.brokerOrderId, brokerState: found.state, error: errMsg(err) },
            userId,
            policy.connectedAccountId
          );
        } else {
          // Keep it in DB as pending_cancel to retry on the next tick
          console.error(`[protective-stops] retry cancel failed for ${row.symbol} order ${row.brokerOrderId}:`, err);
        }
      }
    }
  }

  // 2. Cancel-on-close (runs regardless of `running` — cancelling is always risk-reducing).
  for (const row of listBrokerProtectiveStops(accountNumber, userId)) {
    if (row.status === "pending_cancel") continue; // already handled
    // A pending_replace marker is an owed right-size retry with no live broker order — never call
    // cancelEquityOrder on its synthetic ref (that would 404 and re-persist a stuck pending_cancel).
    // Section 1 already dropped any marker whose position closed; a surviving one is live, so this
    // cancel-on-close section leaves it for section 4 (Codex review, PR #1738).
    if (row.status === "pending_replace") continue;
    if (!livePositions.has(normalizeSymbol(row.symbol))) {
      try {
        await gateway.cancelEquityOrder(accountNumber, row.brokerOrderId);
        deleteBrokerProtectiveStop(row.id, userId);
        out.cancelled++;
        out.cancelledOrderIds.push(row.brokerOrderId);
      } catch (err) {
        audit("broker_protective_stop_cancel_error", { symbol: row.symbol, brokerOrderId: row.brokerOrderId, error: errMsg(err) }, userId, policy.connectedAccountId);
        // Mark as pending_cancel to retry later
        upsertBrokerProtectiveStop({ ...row, status: "pending_cancel" });
      }
    }
  }

  // 2b. Per-symbol plan-excluded teardown (still cancel-only — runs regardless of `running` or
  // `liveReplaceBlocked`, same as section 2). Sections 3/4 below are gated behind `running` because
  // they PLACE/replace orders, but a position whose plan now excludes every lane the account has
  // enabled — via `kindForSymbol` returning null, e.g. "none", or a scale-in switching a resting
  // Robinhood fixed stop to "trailing"/"atr" — must not keep that old broker-held stop resting while
  // the system is Stopped or live placement is disabled. That contradicts the newly selected plan
  // regardless of whether the app happens to be running this tick (Codex review, PR #1371 — this
  // originally only checked literal "none"; broadened to match section 3's `symKind === null` gate).
  for (const row of listBrokerProtectiveStops(accountNumber, userId)) {
    if (row.status === "pending_cancel") continue; // already handled
    // A pending_replace marker has no live broker order — never cancel its synthetic ref here (Codex
    // review, PR #1738). Section 1 already dropped markers for closed/plan-excluded symbols, so any
    // that survive are live right-size retries section 4 will place.
    if (row.status === "pending_replace") continue;
    const sym = normalizeSymbol(row.symbol);
    if (!livePositions.has(sym)) continue; // already torn down above (position closed)
    if (kindForSymbol(sym) !== null) continue;
    try {
      await gateway.cancelEquityOrder(accountNumber, row.brokerOrderId);
      // A successful cancel doesn't mean nothing filled first — mirror every other cancel path in
      // this reconciler: check the caller's pre-reconcile order snapshot for an executed fill before
      // this row disappears, ATOMICALLY with the delete (Codex review, PR #1371; atomicity Item 6,
      // 2026-07-18).
      const preCancelOrder = orders.find((o) => o.id === row.brokerOrderId);
      if (preCancelOrder && hadExecutedFill(preCancelOrder)) {
        deleteAndBookBrokerStopFill(row, preCancelOrder);
        filledRecoverySymbols.add(sym);
        out.filledRecoverySymbols.push(sym);
      } else {
        deleteBrokerProtectiveStop(row.id, userId);
      }
      out.cancelled++;
      out.cancelledOrderIds.push(row.brokerOrderId);
    } catch (err) {
      // The cancel failed — check whether the broker already terminated the order (most likely it
      // FILLED before our cancel reached the broker), same recovery as every other cancel path here.
      const found = orders.find((o) => o.id === row.brokerOrderId);
      if (found && isDoneRestingState(found.state)) {
        if (hadExecutedFill(found)) {
          deleteAndBookBrokerStopFill(row, found);
          filledRecoverySymbols.add(sym);
          out.filledRecoverySymbols.push(sym);
        } else {
          deleteBrokerProtectiveStop(row.id, userId);
        }
        audit("broker_protective_stop_cancel_recovered", { symbol: row.symbol, brokerOrderId: row.brokerOrderId, brokerState: found.state, error: errMsg(err), context: "plan_excluded_teardown" }, userId, policy.connectedAccountId);
      } else {
        audit("broker_protective_stop_cancel_error", { symbol: row.symbol, brokerOrderId: row.brokerOrderId, error: errMsg(err), context: "plan_excluded_teardown" }, userId, policy.connectedAccountId);
        upsertBrokerProtectiveStop({ ...row, status: "pending_cancel" });
      }
    }
  }

  if (!running) return out;

  // Live placement explicitly disabled (ALLOW_LIVE_TRADING=false escape hatch): sections 3 and 4
  // both exist to (re)place broker orders, which the preflight guard would refuse — mismatch
  // replacement already no-ops via `liveReplaceBlocked`, and NEW placements must not slip through
  // either (the default-on Alpaca trailing lane made this reachable; Codex review, PR #1331).
  // Sections 1–2 above are pure risk-reducing cancels and deliberately still ran.
  if (liveReplaceBlocked) return out;

  // 3. Mismatch detection: if the stop's KIND no longer matches the account's desired kind, or its
  // quantity / price / trail has drifted, cancel the existing stop. On the same pass, section 4
  // re-places it with correct values. This is a cancel-THEN-place: if the re-place would be blocked
  // (`liveReplaceBlocked`, computed above), skip the cancel so we KEEP the existing
  // (slightly-mismatched) protective stop rather than orphaning the position.
  //
  // Kind-specific drift rules:
  //  - fixed: entry-anchored target stop price (as before).
  //  - trailing, native (Alpaca): the broker moves the trigger itself — only a changed trail % or
  //    quantity forces a replace; never reprice from here.
  //  - trailing, ratcheted (Robinhood): recompute the trigger from the current mark each tick and
  //    replace only when it moved UP meaningfully (≥ $0.02 and ≥ 0.1% of the resting trigger — a
  //    churn guard, so a flat tape doesn't cancel-replace every tick). A falling mark never lowers
  //    the trigger: that is the ratchet.
  const existingStops = listBrokerProtectiveStops(accountNumber, userId);
  // Backfill a missing tracked extreme from the resting stop's OWN recorded terms, for any symbol
  // the synthetic monitor never independently tracked. This is the common case for a NATIVE trailing
  // stop that covers the WHOLE position: full broker coverage suppresses synthetic registration
  // entirely (by design — the position is already protected), so `extremePriceBySymbol[sym]` is
  // simply absent, not genuinely zero. Without this, a later mismatch (trail % or quantity change)
  // would seed a REPLACEMENT trail from today's current mark — potentially far looser than the
  // broker's own already-ratcheted-up trigger if price rallied and pulled back since the original
  // placement (e.g. entry 100, rallied to 130, pulled back to 126, trail 5% — canArmTrailingNow with
  // trackedExtreme=0 wrongly allows a reseed at 126 instead of keeping the 123.50 the broker's real
  // peak implies). `stopPrice` records the trigger the trail STARTED (or last ratcheted) from, which
  // only ever moves UP — inverting `stopPrice = startPeak * (1 - trailPercent/100)` yields a
  // mathematically sound LOWER BOUND on the broker's true current high-water mark (Codex review, PR
  // #1331). A synthetic row's OWN tracked extreme, when present, is trusted as-is (it's independently
  // observed, not derived).
  for (const stop of existingStops) {
    if (stop.kind !== "trailing" || !(stop.trailPercent && stop.trailPercent > 0)) continue;
    const sym = normalizeSymbol(stop.symbol);
    if (extremePriceBySymbol[sym]) continue;
    const livePos = livePositions.get(sym);
    const side = livePos ? sideOf(livePos) : "long";
    let impliedExtreme = impliedTrailExtreme(stop.stopPrice, stop.trailPercent, side);
    // The DB row's `stopPrice` is written ONCE at placement for a NATIVE trailing stop (it records
    // the trigger the trail STARTED from) and is never repriced while the broker silently ratchets
    // its own trigger upward — so a stop placed at entry and then left alone through a rally pins
    // this reconstruction at ~entry while the broker's real high-water mark has climbed far above.
    // The caller's freshly fetched order list carries the broker's CURRENT reported trigger for the
    // still-resting order (`EquityOrder.stopPrice` — "Stop trigger price as the broker reports it",
    // Alpaca `stop_price`); invert THAT the same way and take the max, so the reconstructed extreme
    // reflects the broker's true, continuously-updated peak instead of only the placement-time mark.
    // Max-only: it can only make canArmTrailingNow MORE restrictive (keep the tighter stop), never
    // loosen protection; it falls back cleanly to the row-derived bound when the order is absent
    // (e.g. a failed fetch left `orders` empty). Codex review, PR #1331.
    const liveOrder = orders.find((o) => o.id === stop.brokerOrderId);
    if (liveOrder && typeof liveOrder.stopPrice === "number" && liveOrder.stopPrice > 0) {
      const orderImpliedExtreme = impliedTrailExtreme(liveOrder.stopPrice, stop.trailPercent, side);
      if (orderImpliedExtreme > 0) {
        impliedExtreme = side === "short"
          ? (impliedExtreme > 0 ? Math.min(impliedExtreme, orderImpliedExtreme) : orderImpliedExtreme)
          : Math.max(impliedExtreme, orderImpliedExtreme);
      }
    }
    if (Number.isFinite(impliedExtreme) && impliedExtreme > 0) extremePriceBySymbol[sym] = impliedExtreme;
  }
  for (const [sym, pos] of livePositions) {
    const existingStop = existingStops.find((r) => normalizeSymbol(r.symbol) === sym);
    const symKind = kindForSymbol(sym);
    if (symKind === null) {
      // This symbol's own stop plan excludes every lane the account currently has enabled (a
      // "none" plan, or a plan — e.g. "trailing" — that doesn't match the account's only active
      // lane). Any existing resting row for it is torn down unconditionally, the same as the
      // account-wide disabled teardown: it must never keep resting in silent contradiction of the
      // owner/LLM's own choice for this position. The always-on synthetic monitor (which honors
      // "trailing"/"none" per-symbol directly) remains this position's actual protection.
      if (existingStop && existingStop.status === "resting") {
        try {
          await gateway.cancelEquityOrder(accountNumber, existingStop.brokerOrderId);
          // A successful cancel doesn't mean nothing filled first — mirror the account-wide disabled
          // teardown's handling: check the caller's pre-reconcile order snapshot for an executed fill
          // before this row disappears, ATOMICALLY with the delete (Codex review, PR #1371; atomicity
          // Item 6, 2026-07-18), or the executed shares never reach fill_events/P&L/learning, and the
          // caller isn't told the position snapshot may be stale.
          const preCancelOrder = orders.find((o) => o.id === existingStop.brokerOrderId);
          if (preCancelOrder && hadExecutedFill(preCancelOrder)) {
            deleteAndBookBrokerStopFill(existingStop, preCancelOrder);
            filledRecoverySymbols.add(sym);
            out.filledRecoverySymbols.push(sym);
          } else {
            deleteBrokerProtectiveStop(existingStop.id, userId);
          }
          out.cancelled++;
          out.cancelledOrderIds.push(existingStop.brokerOrderId);
          audit("broker_protective_stop_mismatch", { symbol: sym, note: "per-position stop plan excludes this account's enabled broker-held lane(s)", kind: null }, userId, policy.connectedAccountId);
        } catch (err) {
          // The cancel failed — check whether the broker already terminated the order (most likely
          // it FILLED before our cancel reached the broker), same recovery as every other cancel path
          // in this reconciler (Codex review, PR #1371).
          const found = orders.find((o) => o.id === existingStop.brokerOrderId);
          if (found && isDoneRestingState(found.state)) {
            if (hadExecutedFill(found)) {
              deleteAndBookBrokerStopFill(existingStop, found);
              filledRecoverySymbols.add(sym);
              out.filledRecoverySymbols.push(sym);
            } else {
              deleteBrokerProtectiveStop(existingStop.id, userId);
            }
            audit("broker_protective_stop_cancel_recovered", { symbol: sym, brokerOrderId: existingStop.brokerOrderId, brokerState: found.state, error: errMsg(err), context: "per_symbol_plan_teardown" }, userId, policy.connectedAccountId);
          } else {
            audit("broker_protective_stop_cancel_error", { symbol: sym, brokerOrderId: existingStop.brokerOrderId, error: errMsg(err), context: "per_symbol_plan_teardown" }, userId, policy.connectedAccountId);
            upsertBrokerProtectiveStop({ ...existingStop, status: "pending_cancel" });
          }
        }
      }
      continue;
    }
    if (existingStop && existingStop.status === "resting") {
      // The broker order this row tracks may already be done resting (filled naturally, or
      // rejected/canceled/expired outside our own cancel path) without the row ever going through
      // section 1's cancel-recovery — e.g. a partial stop that FILLS on its own while the position
      // stays open. Treating a "resting" row as still live when the tracked order is actually gone
      // means a coincidental non-mismatch (recomputed qty/price happen to still match the stale
      // row) never gets caught, and the ghost row then blocks section 4 from placing a real
      // replacement for the (now differently-covered) remaining shares (Codex review, PR #1331).
      // Only ACT on positive evidence from a real fetch — an order absent from the list, or
      // `orders` empty from a failed fetch, stays ambiguous and falls through to the mismatch
      // checks below unchanged.
      const trackedOrder = orders.find((o) => o.id === existingStop.brokerOrderId);
      if (trackedOrder && isDoneRestingState(trackedOrder.state)) {
        // A partial fill DID move shares even when the tracked order's overall terminal state is
        // canceled/expired/rejected, not literally "filled" (Codex review, PR #1331). Atomic with the
        // delete (Item 6, 2026-07-18).
        if (hadExecutedFill(trackedOrder)) {
          deleteAndBookBrokerStopFill(existingStop, trackedOrder);
          filledRecoverySymbols.add(sym);
          out.filledRecoverySymbols.push(sym);
        } else {
          deleteBrokerProtectiveStop(existingStop.id, userId);
        }
        audit(
          "broker_protective_stop_recovered",
          { symbol: sym, brokerOrderId: existingStop.brokerOrderId, brokerState: trackedOrder.state, context: "stale_resting_row" },
          userId,
          policy.connectedAccountId
        );
        continue;
      }
      // The tracked order is actively EXECUTING at the broker right now (partial fill in
      // progress) — never cancel it into a quantity-drift "replacement": the broker may refuse
      // the cancel outright (order already filling), or accept it and abort the remainder of an
      // exit that was already correctly working, leaving those shares covered only by whatever
      // the (possibly stale) synthetic monitor can see until conditions recover (Codex review, PR
      // #1331). The row is left exactly as-is; once the fill settles to a terminal state this
      // same check on a later tick either recovers it (isDoneRestingState, above) or the drift
      // check runs cleanly against the final position size.
      if (trackedOrder && String(trackedOrder.state ?? "").trim().toLowerCase() === "partially_filled") {
        auditStopSkipped({
          symbol: sym, kind: symKind, note: "tracked order is partially filled and actively executing at the broker — leaving it resting rather than cancelling into an uncertain in-flight state"
        }, userId, policy.connectedAccountId);
        continue;
      }
      const qty = desiredStopQuantity(pos, sym, symKind, existingStop.brokerOrderId);
      // Coverage from OTHER live exit orders is unknown this tick (a real order-list fetch
      // failed) — do not treat that as evidence of drift on its own. But whether the row's OWN
      // recorded quantity now exceeds the CURRENT position size needs no order-list data at all:
      // if the position has shrunk (e.g. a partial exit filled elsewhere) below the resting stop's
      // quantity, firing it could sell more shares than the account holds (or open an unintended
      // short) — a risk that doesn't wait for the next successful order fetch to resolve. Cancel
      // that oversized row now (letting the always-on synthetic monitor cover the gap until a
      // later tick can size a proper replacement); only a resize that would depend on OTHER
      // orders' coverage stays deferred (Codex review, PR #1331).
      if (qty === null) {
        const posQty = Math.abs(pos.quantity);
        // While halted, coverage is unknown (order fetch failed) so no right-sized replacement can be
        // computed — cancelling here would strand the position (no synthetic fallback registers while
        // halted). Keep the oversized stop and defer the resize to a non-halted / order-list-available
        // tick; a bounded over-sell risk beats no protection at all (Codex review, PR #1738).
        if (existingStop.quantity > posQty + 0.000001 && !liveReplaceBlocked && !haltedProtectOnly) {
          try {
            await gateway.cancelEquityOrder(accountNumber, existingStop.brokerOrderId);
            deleteBrokerProtectiveStop(existingStop.id, userId);
            out.cancelled++;
            out.cancelledOrderIds.push(existingStop.brokerOrderId);
            audit("broker_protective_stop_mismatch", {
              symbol: sym,
              note: "existing stop quantity exceeds current position size (other-order coverage unknown this tick)",
              kind: symKind,
              oldQty: existingStop.quantity,
              newQty: posQty
            }, userId, policy.connectedAccountId);
          } catch (err) {
            audit("broker_protective_stop_cancel_error", { symbol: sym, brokerOrderId: existingStop.brokerOrderId, error: errMsg(err) }, userId, policy.connectedAccountId);
            upsertBrokerProtectiveStop({ ...existingStop, status: "pending_cancel" });
          }
        } else {
          auditStopSkipped({ symbol: sym, kind: symKind, note: "order list unavailable this tick — leaving the existing broker-held stop untouched rather than resizing on unknown coverage" }, userId, policy.connectedAccountId);
        }
        continue;
      }
      // Where section 4 would place this stop's trigger today (informational for native trailing —
      // the broker moves that trigger itself).
      const newStopPrice = symKind === "fixed" ? fixedStopPrice(pos, sym) : trailingTriggerPrice(pos, sym);

      let mismatchNote: string | undefined;
      if (existingStop.kind !== symKind) {
        mismatchNote = `stop kind ${existingStop.kind} -> ${symKind}`;
      } else if (Math.abs(existingStop.quantity - qty) > 0.000001) {
        mismatchNote = "quantity drift";
      } else if (symKind === "fixed") {
        if (Math.abs(existingStop.stopPrice - newStopPrice) > 0.02) mismatchNote = "stop price drift";
      } else if (Math.abs((existingStop.trailPercent ?? 0) - trailPct) > 0.0001) {
        mismatchNote = `trail % ${existingStop.trailPercent ?? 0} -> ${trailPct}`;
      } else if (!nativeTrailing && trailRatchetTighter(existingStop.stopPrice, newStopPrice, sideOf(pos))) {
        mismatchNote = `trail ratchet ${existingStop.stopPrice} -> ${newStopPrice}`;
      }

      // A trailing mismatch must not be cancelled unless section 4 would actually be able to
      // replace it THIS pass — otherwise the cancel succeeds, the replacement guard then refuses
      // (mark below entry/tracked extreme, or already breached), and the position is left with NO
      // broker-held stop until conditions recover (Codex review, PR #1331). Keep the
      // slightly-mismatched stop resting instead; it's still real protection. EXCEPT a pure
      // quantity SHRINK: the row is oversized relative to what's actually still uncovered (e.g.
      // another known live exit order now covers part of the position), so the old full-size stop
      // is not just non-ideal but actively stacks on top of that other order — if both can fill,
      // the account gets over-sold. Cancelling never needs to "arm" anything (it only removes
      // exposure), so this case bypasses the arm-gate and cancels below regardless; section 4's own
      // canArmTrailingNow gate still decides, independently, whether a resize replacement can be
      // placed this same tick (Codex review, PR #1331).
      // "Oversized" is judged by the actual quantities, NOT the mismatch LABEL: when the row also needs
      // a kind change, `mismatchNote` is "stop kind …" (set first in the chain above) even though the
      // row is also over-sized, so keying off the label would miss it and keep an over-selling stop
      // resting (Codex review, PR #1738). Any `qty < existingStop.quantity` is risk-reducing to cancel.
      const isQuantityShrink = qty < existingStop.quantity;
      // A trailing mismatch is arm-gated: don't cancel into a replacement section 4 would refuse
      // (mark below entry/tracked extreme). A pure quantity SHRINK normally BYPASSES this gate because
      // cancelling the oversized stop is risk-reducing and the always-on synthetic monitor covers the
      // gap — BUT that fallback does NOT register while halted, so a halted trailing shrink must ALSO
      // respect the arm-gate WHEN a replacement is actually needed (`qty > 0`): if it can't arm this
      // tick, keep the oversized stop rather than strand the position. When `qty <= 0` another live exit
      // order already covers the position, so no replacement is needed and cancelling the redundant
      // (stacking) oversized stop is strictly safe — don't arm-gate that (Codex review, PR #1738).
      if (mismatchNote && symKind === "trailing" && (!isQuantityShrink || (haltedProtectOnly && qty > 0)) && !canArmTrailingNow(pos, sym, newStopPrice)) {
        auditStopSkipped({
          symbol: sym, kind: symKind, note: `mismatch (${mismatchNote}) detected but the replacement would be refused this tick${haltedProtectOnly ? " (halted — no synthetic fallback)" : ""} — keeping the existing stop rather than cancelling into no protection`
        }, userId, policy.connectedAccountId);
        mismatchNote = undefined;
      }

      // While halted (protect-only), a mismatch that would cancel-THEN-replace with LOOSER/EQUAL
      // protection must be kept — cancelling a non-shrink drift would strand the position with no
      // stop. A pure quantity SHRINK is the exception: the row is oversized relative to the current
      // position and could over-sell/short if it fires, so that risk-reducing cancel still runs — and
      // the symbol is marked (`haltedRightsizeSymbols`) so section 4 places a correctly-sized
      // replacement the SAME tick, keeping the position protected rather than relying on a synthetic
      // row that a broker-covered position doesn't have and the monitor won't register while halted
      // (Codex review, PR #1738 — corrects the round-2 "synthetic covers it" assumption).
      if (mismatchNote && haltedProtectOnly && !isQuantityShrink) {
        auditStopSkipped({
          symbol: sym, kind: symKind, note: `mismatch (${mismatchNote}) detected but system is halted — keeping the existing stop rather than cancelling into a replacement that can't be placed while halted`
        }, userId, policy.connectedAccountId);
        mismatchNote = undefined;
      }

      if (mismatchNote && !liveReplaceBlocked) {
        audit("broker_protective_stop_mismatch", {
          symbol: sym,
          note: mismatchNote,
          kind: symKind,
          oldQty: existingStop.quantity,
          newQty: qty,
          oldStopPrice: existingStop.stopPrice,
          newStopPrice
        }, userId, policy.connectedAccountId);

        try {
          await gateway.cancelEquityOrder(accountNumber, existingStop.brokerOrderId);
          deleteBrokerProtectiveStop(existingStop.id, userId);
          out.cancelled++;
          out.cancelledOrderIds.push(existingStop.brokerOrderId);
          // Halted shrink cancel just removed the (oversized) only broker stop — let section 4 place
          // the right-sized replacement this same tick so the position isn't left unprotected, and
          // record the cancelled stop's trigger as the floor so the replacement can't be looser.
          if (haltedProtectOnly && isQuantityShrink) {
            haltedRightsizeSymbols.add(sym);
            if (existingStop.stopPrice > 0) haltedRightsizeFloor.set(sym, existingStop.stopPrice);
          }
        } catch (err) {
          audit("broker_protective_stop_cancel_error", { symbol: sym, brokerOrderId: existingStop.brokerOrderId, error: errMsg(err) }, userId, policy.connectedAccountId);
          upsertBrokerProtectiveStop({ ...existingStop, status: "pending_cancel" });
        }
      }
    }
  }

  // While halted (protect-only), section 4 places ONLY for `haltedRightsizeSymbols` — positions whose
  // OVERSIZED existing stop a risk-reducing cancel above (section-1 pending_cancel or section-3 shrink)
  // just removed. That replacement is the smaller half of a right-size, so it keeps protection without
  // initiating NEW protection for an unprotected position (the per-symbol gate inside the loop below
  // enforces this). If nothing was right-sized this tick, skip the whole section. Codex review, PR
  // #1738.
  if (haltedProtectOnly && haltedRightsizeSymbols.size === 0) return out;

  // 4. Place-if-missing for each open long without a stop row. A pending_cancel row BLOCKS
  // placement for its symbol: its broker order may still be live (the cancel keeps failing), and
  // placing a replacement would upsert a new broker_order_id over the row (UNIQUE
  // user/account/symbol), orphaning the old still-live full-size GTC stop with no tracking and no
  // retry — two resting sell stops, one invisible. The section-1 retry keeps re-attempting the
  // cancel; placement resumes on the tick after it succeeds (and until then the old stop itself is
  // still protecting the position).
  const currentStops = listBrokerProtectiveStops(accountNumber, userId);
  // Exclude pending_replace markers: they are owed right-size retries with NO live broker order, so a
  // kept marker must not suppress this section's placement for its own symbol (Codex review, PR #1738).
  const existing = new Set(
    currentStops.filter((r) => r.status !== "pending_replace").map((r) => normalizeSymbol(r.symbol))
  );
  // A prior uncertain placement (threw/timed out AFTER the broker may have accepted it) records the
  // submitted client ref on its marker. Before re-placing, adopt any now-visible live order carrying
  // that ref instead of submitting a duplicate, and reuse the ref on retry so the broker's
  // client-order-id idempotency also guards the not-yet-visible case (Codex review, PR #1738).
  const haltedRetryMarkerBySymbol = new Map<string, BrokerProtectiveStop>();
  for (const r of currentStops) {
    if (r.status === "pending_replace") haltedRetryMarkerBySymbol.set(normalizeSymbol(r.symbol), r);
  }
  // The stored client ref, only when it is a REAL submitted ref (not the "never matches" placeholder a
  // pre-place skip writes).
  const haltedRetryRefFor = (sym: string): string | undefined => {
    const ref = haltedRetryMarkerBySymbol.get(sym)?.brokerOrderId;
    return ref && !ref.startsWith("pending-replace-") ? ref : undefined;
  };

  const persistHaltedRightSizeRetry = (
    sym: string,
    pos: EquityPosition,
    kind: "fixed" | "trailing",
    qty: number,
    stopPrice: number,
    submittedRef?: string,
  ): void => {
    if (!haltedProtectOnly || !haltedRightsizeSymbols.has(sym)) return;
    upsertBrokerProtectiveStop({
      id: `protstop-${userId}-${accountNumber}-${sym}`,
      userId,
      accountNumber,
      // When the placement THREW (the broker may have accepted it before the reply was lost), record
      // the client ref we submitted so the next tick can adopt the now-visible order (or reuse the ref
      // so the broker's idempotency rejects a duplicate) instead of orphaning/duplicating it. When we
      // never reached submission (a pre-place skip re-persisting the marker) there is no ref, so fall
      // back to a synthetic placeholder that deliberately matches no live order (Codex review, PR #1738).
      brokerOrderId: submittedRef ?? `pending-replace-${Date.now()}-${sym}`,
      symbol: sym,
      quantity: qty,
      stopPrice,
      status: "pending_replace",
      kind,
      trailPercent: kind === "trailing" ? trailPct : undefined,
    });
    audit("broker_protective_stop_retry_queued", {
      symbol: sym,
      kind,
      quantity: qty,
      stopPrice,
      positionQuantity: Math.abs(pos.quantity),
      note: "halted right-size replacement will retry on the next tick",
    }, userId, policy.connectedAccountId);
  };

  for (const [sym, pos] of livePositions) {
    if (existing.has(sym)) continue;
    if (hasOwnerCancelledProtectiveStop(userId, accountNumber, sym)) {
      auditStopSkipped({
        symbol: sym,
        kind: kindForSymbol(sym),
        note: "owner manually cancelled the app-managed protective stop — not re-placing until policy changes"
      }, userId, policy.connectedAccountId);
      continue;
    }
    // While halted, place ONLY for a symbol whose oversized stop was just cancelled for right-sizing.
    // Any other open long here has no stop (a pending_cancel row keeps it in `existing`, so it was
    // already filtered out above) — placing for it would be initiating NEW protection during a halt.
    if (haltedProtectOnly && !haltedRightsizeSymbols.has(sym)) continue;
    const symKind = kindForSymbol(sym);
    // This symbol's own stop plan excludes every lane the account currently has enabled (a "none"
    // plan, or a plan that doesn't match the account's only active lane) — never place a
    // broker-held stop for it; the synthetic monitor is this position's actual protection.
    if (symKind === null) continue;
    // Section 1 just recovered this symbol's row THIS call via a FILLED order — `positions` may not
    // yet reflect that fill (see the filledRecoverySymbols comment above). Defer to the next call's
    // fresh position read rather than risk sizing a replacement off a stale (pre-fill) quantity.
    if (filledRecoverySymbols.has(sym)) continue;
    if (!(pos.averageCost > 0)) continue;
    // ITEM 5 (2026-07-18): a prior tick may have persisted a durable placement intent for this
    // symbol and then crashed/thrown before learning the broker's response — reconcile it against
    // the caller's freshly fetched order list BEFORE computing coverage/qty or submitting anything
    // new this tick (a live order this reconciler doesn't yet track would otherwise be miscounted as
    // "other" coverage below and short-circuit the qty check before ever reaching this adoption
    // logic). A live order carrying the intent's client_order_id means the earlier submission WAS
    // accepted; adopt it instead of risking a duplicate. Clear the intent only on POSITIVE evidence:
    // either a visible terminal zero-fill order, or absence from an order list that is explicitly
    // authoritative for recently-terminal orders. A live-only/non-authoritative list (Robinhood) is
    // still ambiguous: absence can mean "accepted, filled, and aged out", so a fresh stop could
    // double-sell.
    const priorRef = haltedRetryRefFor(sym);
    const priorIntent = getBrokerStopPlacementIntent(accountNumber, sym, userId);
    if (priorIntent) {
      const acceptedOrder = orders.find((o) => o.clientOrderId === priorIntent.clientOrderId);
      if (acceptedOrder && acceptedOrder.id && !isDoneRestingState(acceptedOrder.state)) {
        const adoptQty = acceptedOrder.quantity && acceptedOrder.quantity > 0 ? acceptedOrder.quantity : priorIntent.quantity;
        const adoptStop = acceptedOrder.stopPrice && acceptedOrder.stopPrice > 0 ? acceptedOrder.stopPrice : priorIntent.stopPrice;
        upsertBrokerProtectiveStop({
          id: `protstop-${userId}-${accountNumber}-${sym}`,
          userId,
          accountNumber,
          symbol: sym,
          brokerOrderId: acceptedOrder.id,
          quantity: adoptQty,
          stopPrice: adoptStop,
          status: "resting",
          kind: priorIntent.kind,
          trailPercent: priorIntent.kind === "trailing" ? priorIntent.trailPercent : undefined
        });
        deleteBrokerStopPlacementIntent(accountNumber, sym, userId);
        out.placed++;
        if (adoptQty >= Math.abs(pos.quantity) - 0.000001) out.placedStopSymbols.push(sym);
        else {
          out.partiallyPlacedStopSymbols.push(sym);
          out.partiallyPlacedStopQuantities[sym] = adoptQty;
        }
        audit("broker_protective_stop_adopted", {
          symbol: sym, kind: priorIntent.kind, brokerOrderId: acceptedOrder.id, clientOrderId: priorIntent.clientOrderId,
          quantity: adoptQty, stopPrice: adoptStop,
          note: "adopted a live order from a prior placement whose broker reply was lost, instead of risking a duplicate"
        }, userId, policy.connectedAccountId);
        continue;
      }
      if (acceptedOrder && isDoneRestingState(acceptedOrder.state)) {
        // The accepted order is visible but already TERMINAL — the stop was accepted after the crash
        // and ran to completion before this tick (entirely plausible: stops placed into a falling
        // market are exactly the ones that fill fast). If it EXECUTED, book the fill (atomically with
        // clearing the intent) and DEFER placement this tick via filledRecoverySymbols — the caller's
        // position snapshot predates the fill, so sizing a fresh full-size stop off it would rest a
        // sell for shares that are already gone (over-sell / accidental short). Mirrors the section-1
        // marker lane's book-if-filled handling. Only a terminal order with ZERO executed quantity is
        // confirmed dead and falls through to a fresh placement (2026-07-18 adversarial finding).
        if (hadExecutedFill(acceptedOrder)) {
          deleteIntentAndBookStopFill(priorIntent, acceptedOrder);
          filledRecoverySymbols.add(sym);
          out.filledRecoverySymbols.push(sym);
          audit("broker_protective_stop_recovered", {
            symbol: sym, brokerOrderId: acceptedOrder.id, clientOrderId: priorIntent.clientOrderId,
            brokerState: acceptedOrder.state, context: "placement_intent_filled",
            note: "a prior placement whose reply was lost was accepted and already executed — booked the fill; placement deferred to a fresh position read"
          }, userId, policy.connectedAccountId);
          continue;
        }
        deleteBrokerStopPlacementIntent(accountNumber, sym, userId);
      } else if (ordersListed && gateway.ordersListIncludesTerminal === true) {
        // An AUTHORITATIVE fetch succeeded and shows no order for this client_order_id — the earlier
        // submission is confirmed dead (rejected or never reached the broker). Clear it; the
        // placement below runs fresh with a new id.
        deleteBrokerStopPlacementIntent(accountNumber, sym, userId);
      } else {
        if (priorRef === priorIntent.clientOrderId) {
          // Halted right-size retries keep a pending_replace marker with the same submitted client
          // ref. Let section 4 reuse that ref, so broker idempotency can reject/adopt the ambiguous
          // first placement without generating a NEW client id.
          audit("broker_protective_stop_retrying", {
            symbol: sym,
            kind: priorIntent.kind,
            note: "prior halted right-size placement is unresolved — retrying with the same client ref for broker idempotency when placement remains otherwise safe"
          }, userId, policy.connectedAccountId);
        } else {
          // Order list unavailable OR non-authoritative this tick — genuinely unknown whether the
          // earlier request landed. Skip this symbol entirely rather than guess: a fresh placement here
          // could double up on an order that WAS accepted but simply isn't visible this tick.
          auditStopSkipped({
            symbol: sym, kind: priorIntent.kind,
            note: ordersListed
              ? "a prior placement's outcome is still unresolved and the broker order list is not authoritative for terminal orders — waiting rather than risking a duplicate"
              : "a prior placement's outcome is still unresolved and the order list is unavailable this tick — waiting rather than risking a duplicate"
          }, userId, policy.connectedAccountId);
          continue;
        }
      }
    }
    // A prior uncertain HALTED-right-size placement's client ref (its pending_replace marker held it
    // after a throw) is reconciled up front in section 1 (adopt-if-live / book-if-filled /
    // drop-if-dead / keep-if-invisible), so by here any live accepted order has already become a
    // resting row (and `existing` skips its symbol). What remains for a still-invisible ref is to
    // REUSE it as this placement's client id below, so the broker's client-order-id idempotency
    // rejects a duplicate if that order was accepted but not yet visible (Codex review, PR #1738).
    // Complementary to the placement-intent lane above: markers cover the halted right-size retry,
    // intents cover ordinary placement — both survive the 2026-07-18 merge by design.
    // The uncovered remainder (coverage-aware — never stack exit quantity on top of a live bracket
    // leg / manual sell; the just-cancelled replacement's own order is pruned inside), floored to
    // whole shares on the native trailing lane. `null` means a real order-list fetch failed this
    // tick — coverage is UNKNOWN, not zero; placing here could double up on shares another,
    // invisible-this-tick order already commits, so skip entirely and let the synthetic monitor
    // (which is quantity-aware against whatever it CAN see, and fails safe otherwise) cover the
    // tick (Codex review, PR #1331). Zero (list fetched fine, just fully covered/sub-share) is a
    // normal, confident skip.
    const qty = desiredStopQuantity(pos, sym, symKind);
    if (qty === null) {
      auditStopSkipped({ symbol: sym, kind: symKind, note: "order list unavailable this tick — coverage unknown, deferring placement to the synthetic monitor rather than guessing" }, userId, policy.connectedAccountId);
      continue;
    }
    if (!(qty > 0)) {
      auditStopSkipped({
        symbol: sym,
        kind: symKind,
        note: "no uncovered whole shares — other live exit orders (or sub-share size) cover this position; the synthetic monitor covers any remainder"
      }, userId, policy.connectedAccountId);
      continue;
    }
    let stopPrice = symKind === "fixed" ? fixedStopPrice(pos, sym) : trailingTriggerPrice(pos, sym);
    if (symKind === "fixed" && haltedProtectOnly) {
      stopPrice = clampHaltedReplacementStop(stopPrice, haltedRightsizeFloor.get(sym), sideOf(pos));
    }
    if (!(stopPrice > 0)) continue;
    // Never arm a broker trail that would be LOOSER than the app-defined one (Codex review, PR
    // #1331, three rounds — see canArmTrailingNow's doc comment for the native-vs-ratcheted logic).
    if (symKind === "trailing" && !canArmTrailingNow(pos, sym, stopPrice)) {
      const mark = positionMarkPrice(pos);
      auditStopSkipped({
        symbol: sym,
        kind: symKind,
        stopPrice,
        mark,
        trackedExtreme: extremePriceBySymbol[sym],
        note: nativeTrailing
          ? "mark below entry or the app's tracked high-water mark — a native broker trail would seed from the depressed market and be looser than the app's own trail; the synthetic monitor keeps covering until the mark recovers"
          : "trail already breached at placement — leaving the exit to the synthetic monitor instead of arming a fresh, lower broker trail"
      }, userId, policy.connectedAccountId);
      continue;
    }
    // Reuse the prior submitted ref when one exists (a previous attempt THREW): the broker's
    // client-order-id idempotency then rejects a duplicate if that earlier order was accepted but not
    // yet visible in the order list. A fresh ref otherwise (Codex review, PR #1738).
    const refId = priorRef ?? `protstop-${userId}-${accountNumber}-${sym}-${Date.now()}`;
    // Persist a durable pre-network intent BEFORE calling the broker: if the broker accepts the
    // order but the reply is lost (crash/timeout), this row is the only evidence a request was ever
    // sent, and the check above reconciles it on a later tick instead of guessing. Deleted on every
    // definite outcome below (rejected/no-id/success); left in place only when the placement call
    // itself throws (Item 5, 2026-07-18 — this call previously had no persisted state before the
    // network call at all, so an accepted request whose reply was lost could be retried into a
    // duplicate full-size stop). Stores the possibly-REUSED ref, so the intent lane and the
    // marker lane reconcile against the same client id.
    upsertBrokerStopPlacementIntent({
      userId, accountNumber, symbol: sym, clientOrderId: refId, quantity: qty, stopPrice, kind: symKind,
      trailPercent: symKind === "trailing" ? trailPct : undefined
    });
    try {
      const exec = await gateway.placeEquityOrder({
        accountNumber,
        symbol: sym,
        side: protectiveExitSide(sideOf(pos)),
        type: "stop_market",
        quantity: qty,
        // Native trailing (Alpaca): the gateway translates trailPercent to a trailing_stop order
        // and the broker computes/moves the trigger itself — sending a stopPrice would be rejected.
        // Ratcheted trailing (Robinhood) and fixed stops rest at an explicit trigger.
        stopPrice: symKind === "trailing" && nativeTrailing ? undefined : stopPrice,
        trailPercent: symKind === "trailing" && nativeTrailing ? trailPct : undefined,
        timeInForce: "gtc",
        marketHours: "regular_hours",
        refId
      });
      if (isRejectedOrCanceledState(exec.state)) {
        // A non-throwing placement can still be a synchronous rejection/cancellation (same trap as
        // the synthetic exit path in synthetic-stops.ts). No stop is resting at the broker: don't
        // record a row (a dead "resting" row would block re-placement here on every later tick —
        // section 3 sees no qty/price mismatch on it, and `existing` above blocks section 4) and
        // don't advertise the symbol via placedStopSymbols (that would suppress this tick's
        // synthetic registration for protection that doesn't exist).
        audit("broker_protective_stop_error", { symbol: sym, stopPrice, orderId: exec.orderId, error: `broker declined the protective stop (state: ${exec.state})` }, userId, policy.connectedAccountId);
        // Definite outcome: clear the placement intent; the halted right-size marker (no ref — a
        // rejected client-order-id must not be reused) still re-queues the owed retry.
        deleteBrokerStopPlacementIntent(accountNumber, sym, userId);
        persistHaltedRightSizeRetry(sym, pos, symKind, qty, stopPrice);
        continue;
      }
      if (!exec.orderId) {
        // No broker order id means we couldn't later cancel it — don't record an untrackable stop.
        audit("broker_protective_stop_error", { symbol: sym, stopPrice, error: "broker returned no order id" }, userId, policy.connectedAccountId);
        // Definite outcome: clear the placement intent; the halted right-size marker (no ref) still
        // re-queues the owed retry.
        deleteBrokerStopPlacementIntent(accountNumber, sym, userId);
        persistHaltedRightSizeRetry(sym, pos, symKind, qty, stopPrice);
        continue;
      }
      upsertBrokerProtectiveStop({
        id: `protstop-${userId}-${accountNumber}-${sym}`,
        userId,
        accountNumber,
        symbol: sym,
        brokerOrderId: exec.orderId,
        quantity: qty,
        // For native trailing this records the trigger the trail STARTED from (the broker moves the
        // real one); for fixed/ratcheted stops it is the actual resting trigger.
        stopPrice,
        status: "resting",
        kind: symKind,
        trailPercent: symKind === "trailing" ? trailPct : undefined
      });
      deleteBrokerStopPlacementIntent(accountNumber, sym, userId);
      out.placed++;
      if (qty >= Math.abs(pos.quantity) - 0.000001) out.placedStopSymbols.push(sym);
      else {
        out.partiallyPlacedStopSymbols.push(sym);
        out.partiallyPlacedStopQuantities[sym] = qty;
      }
      audit("broker_protective_stop_placed", { symbol: sym, kind: symKind, stopPrice, trailPercent: symKind === "trailing" ? trailPct : undefined, quantity: qty, positionQuantity: Math.abs(pos.quantity), brokerOrderId: exec.orderId }, userId, policy.connectedAccountId);
    } catch (err) {
      // The placement THREW — the broker may already have accepted the order before the reply was
      // lost. The intent row (persisted above, before the call) is deliberately LEFT in place so the
      // check at the top of this symbol's next tick reconciles it via clientOrderId instead of
      // guessing; the halted right-size marker additionally records the submitted `refId` so its lane
      // can adopt the now-visible order (or reuse the ref to trip broker idempotency). The reject/
      // no-id paths above pass NO ref: those orders are definitively not resting, and reusing a
      // broker-rejected client-order-id could get the retry itself rejected as a duplicate.
      audit("broker_protective_stop_error", { symbol: sym, stopPrice, error: errMsg(err) }, userId, policy.connectedAccountId);
      persistHaltedRightSizeRetry(sym, pos, symKind, qty, stopPrice, refId);
    }
  }
  return out;
}

// A pending teardown row survives at most this many failed attempts before being dropped — mirrors
// the "stale placing intents" sweep's own bounded-retry philosophy (db-proposals.ts): a bracket
// whose sibling legs can't be found/cancelled after repeated tries is most likely already resolved
// (filled, manually cancelled, or the account/broker no longer has it) rather than something an
// unbounded retry loop would ever fix.
const MAX_BRACKET_TEARDOWN_ATTEMPTS = 10;

/**
 * Sweeps `pending_bracket_teardowns` (enqueued by recordStopPlan/clearStopPlans in db-api-keys.ts
 * whenever a "fixed"/"atr" plan with a tracked broker-native bracket changes away from that style)
 * and asks the broker gateway to identify + cancel that bracket's still-resting sibling legs — the
 * long-deferred "OCO sibling-identity pairing" gap (PR #1331/#1371): `enrichOpeningProposal` only
 * strips bracket fields from the NEW order being placed, with no reach into an EARLIER opening's
 * already-resting bracket. Cancellation is broker-gateway-optional (`cancelBracketSiblingLegs` is
 * undefined on an adapter with no bracket support, e.g. Robinhood) — a row on such an account is
 * simply dropped immediately, since no bracket could have been placed there to begin with. A row is
 * removed once cancellation is attempted (successfully or not) unless the broker call itself threw,
 * in which case attempts is bumped and the row is retried next tick up to MAX_BRACKET_TEARDOWN_ATTEMPTS.
 */
export async function reconcilePendingBracketTeardowns(
  gateway: BrokerGateway,
  accountNumber: string,
  userId: string = "local",
  connectedAccountId?: string
): Promise<void> {
  let pending: ReturnType<typeof listPendingBracketTeardowns>;
  try {
    pending = listPendingBracketTeardowns(accountNumber, userId);
  } catch {
    return;
  }
  if (pending.length === 0) return;

  if (!gateway.cancelBracketSiblingLegs) {
    // No bracket-cancellation capability on this broker adapter — nothing to reconcile against; a
    // row here would only exist from a stale plan recorded before a broker switch, so just drop it.
    for (const row of pending) removePendingBracketTeardown(row.id);
    return;
  }

  for (const row of pending) {
    try {
      const { cancelledOrderIds } = await gateway.cancelBracketSiblingLegs(accountNumber, row.orderId);
      audit("bracket_sibling_legs_torn_down", { symbol: row.symbol, orderId: row.orderId, cancelledOrderIds }, userId, connectedAccountId);
      removePendingBracketTeardown(row.id);
    } catch (err) {
      if (row.attempts + 1 >= MAX_BRACKET_TEARDOWN_ATTEMPTS) {
        audit("bracket_sibling_teardown_abandoned", { symbol: row.symbol, orderId: row.orderId, attempts: row.attempts + 1, error: errMsg(err) }, userId, connectedAccountId);
        removePendingBracketTeardown(row.id);
      } else {
        bumpPendingBracketTeardownAttempts(row.id);
      }
    }
  }
}
