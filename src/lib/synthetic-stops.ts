import {
  advanceSyntheticStopGeneration,
  audit,
  claimSyntheticStop,
  dailyExecutionStats,
  deleteSyntheticStop,
  filterFullStopPlansByLiveBasis,
  filterStopPlansByLiveBasis,
  getConnectedAccount,
  getStopPlans,
  insertFillEvent,
  listBrokerProtectiveStops,
  listPendingBrokerReconciliationFills,
  listSyntheticStops,
  persistedOrFallbackStopPct,
  recordSyntheticStopAttempt,
  revertSyntheticStopClaim,
  upsertSyntheticStop,
  type SyntheticTrailingStop
} from "./db";
import { getBrokerGateway } from "./broker";
import { isLiveExitOrder, isLiveOrderState, isRejectedOrCanceledState, liveExitOrderCoverage } from "./broker-side";
import { applyPaperExitCost } from "./execution-cost";
import { cancelBrokerProtectiveStop, reconcileBrokerProtectiveStops, reconcilePendingBracketTeardowns } from "./broker-protective-stops";
import { resolveProtectiveExitRouting, protectiveExitMarketSession, type ProtectiveExitQuote } from "./protective-exit-routing";
import { deriveExecutionState } from "./execution-mode";
import { normalizeSymbol } from "./money";
import { evaluateTradeProposal } from "./policy";
import { STOP_PLAN_FALLBACK_STOP_PCT } from "./types";
import type { EquityOrder, EquityPosition, ExecutionMode, FillSource, StopPlanStyle, TradeProposal, TradingPolicy } from "./types";
import type { PositionStopPlan } from "./db-api-keys";
import { sendNotification } from "./notifications";
import { sqliteYieldRetry, yieldIfDue } from "./sqlite-event-loop";
import { yieldEventLoop } from "./slow-sync-guard";

const BAD_TICK_PCT = 0.1; // ignore a single print deviating >10% from the last good price

// A synthetic-stop refId doubles as the broker client-order-id (tag), and the secondary dedup below
// matches a resting broker order back to its stop by EXACT client-order-id equality. Some brokers
// restrict that field's charset — Tradier's order `tag` is letters/numbers/dash only and rewrites an
// underscore to a dash, so a raw refId carrying the `u_<hash>` non-primary userId would come back
// mangled and never match its stored refId, defeating the dedup. Keep the refId within the portable
// lowest-common-denominator charset [A-Za-z0-9-] at generation so it round-trips through ANY broker
// unchanged. This is collision-safe: userIds are "local" or `u_<24-hex>`, and `_`->`-` can't collide
// two distinct hashes; Alpaca/Robinhood (which accept underscores) store the same value verbatim.
export function brokerPortableRefId(refId: string): string {
  // Cap at 255 chars to match Tradier's sanitizeTag (src/lib/tradier.ts), which truncates the `tag`
  // field to 255. A (hypothetical) long refId must be truncated IDENTICALLY on both the stored copy
  // (this value, used as lastAttemptRefId) and the broker tag, or the two would diverge past char 255
  // and the client-order-id dedup that matches a resting broker order back to its stop by EXACT
  // equality would never match. Alpaca/Robinhood accept longer tags, so the cap is a harmless no-op
  // on every refId we actually generate today (all well under 255).
  return refId.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 255);
}

// isLiveExitOrder / liveExitOrderCoverage moved to broker-side.ts (2026-07-10) so the broker-held
// protective-stop reconciler can share the same quantity-aware coverage rules without an import
// cycle. Semantics unchanged — see their doc comments there.

// A 'triggered' stop may only re-arm after this long without any sign of its exit order — long
// enough that a slow in-flight placement (broker call spanning ticks) or a lagging position/order
// feed can't race a re-arm into a duplicate exit.
const REARM_CONFIRM_GRACE_MS = 15 * 60_000;

// Share-count tolerance for coverage comparisons (mirrors the position-size epsilon used below).
const QTY_EPSILON = 0.000001;


// P2.8: Per-(stopId, fingerprint) emission cooldown for synthetic-stop failures.
// Keep 60s placement retry; only coalesce audit/notify noise. Never touch fire_generation here.
const SYNTHETIC_ERROR_COOLDOWN_MS = 60 * 60_000;
type SyntheticErrorEmit = { lastEmittedAt: number; firstFailedAt: number };
const errorCooldownHost = globalThis as unknown as { __syntheticStopErrors?: Map<string, SyntheticErrorEmit> };
const recentlyEmittedSyntheticErrors: Map<string, SyntheticErrorEmit> =
  errorCooldownHost.__syntheticStopErrors ?? (errorCooldownHost.__syntheticStopErrors = new Map<string, SyntheticErrorEmit>());

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(16);
}

function auditSyntheticStopError(
  stopId: string,
  symbol: string,
  errorMsg: string,
  userId: string,
  policy: TradingPolicy,
  extra: Record<string, unknown> = {}
) {
  const fingerprint = hashString(errorMsg);
  const key = `${stopId}:${fingerprint}`;
  const now = Date.now();
  const prior = recentlyEmittedSyntheticErrors.get(key);

  // Prune expired entries to prevent unbounded growth
  for (const [k, entry] of recentlyEmittedSyntheticErrors) {
    if (now - entry.lastEmittedAt > SYNTHETIC_ERROR_COOLDOWN_MS) recentlyEmittedSyntheticErrors.delete(k);
  }

  if (prior != null && now - prior.lastEmittedAt < SYNTHETIC_ERROR_COOLDOWN_MS) {
    return; // Cooldown active, suppress duplicate emission
  }

  const firstFailedAt = prior?.firstFailedAt ?? now;
  recentlyEmittedSyntheticErrors.set(key, { lastEmittedAt: now, firstFailedAt });
  const sinceIso = new Date(firstFailedAt).toISOString();
  const connectedAccountId = policy.connectedAccountId;
  audit(
    "synthetic_stop_error",
    { symbol, error: errorMsg, fingerprint, firstFailedAt: sinceIso, ...extra },
    userId,
    connectedAccountId
  );

  // Persistent owner-facing alert (once per cooldown window per fingerprint).
  const sinceLabel = new Date(firstFailedAt).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
  void sendNotification(
    {
      type: "protective_exit_failing",
      title: `Protective exit failing for ${normalizeSymbol(symbol)}`,
      payload: {
        summary:
          `Protective exit for ${normalizeSymbol(symbol)} has been failing since ${sinceLabel} ET. ` +
          `Retry continues every ~60s; fire_generation is unchanged. Last error: ${errorMsg}`,
        symbol: normalizeSymbol(symbol),
        stopId,
        fingerprint,
        firstFailedAt: sinceIso,
        error: errorMsg,
        ...extra
      }
    },
    { policy, userId }
  ).catch(() => {
    /* notification is best-effort; audit already landed */
  });
}
export interface StopEvaluation {
  newExtreme: number;
  triggerPrice: number;
  triggered: boolean;
  badTick: boolean;
}

/**
 * Pure trailing-stop evaluation (R2 §2.5). Given a stop and a fresh price, returns the updated
 * extreme (high-watermark for a long, low for a short), the trail trigger price, whether it has
 * triggered, and whether the print looks like a bad tick (>10% off the last good price) — which is
 * ignored so a single spurious print can neither move the trail nor fire an exit.
 */
export function evaluateStop(
  stop: Pick<SyntheticTrailingStop, "side" | "extremePrice" | "trailPercent" | "trailAmount" | "lastPrice">,
  price: number
): StopEvaluation {
  const prev = stop.lastPrice;
  const badTick = prev != null && prev > 0 && Math.abs(price - prev) / prev > BAD_TICK_PCT;
  const newExtreme = badTick
    ? stop.extremePrice
    : stop.side === "long"
      ? Math.max(stop.extremePrice, price)
      : Math.min(stop.extremePrice, price);
  const triggerPrice =
    stop.side === "long"
      ? stop.trailPercent != null
        ? newExtreme * (1 - stop.trailPercent / 100)
        : newExtreme - (stop.trailAmount ?? 0)
      : stop.trailPercent != null
        ? newExtreme * (1 + stop.trailPercent / 100)
        : newExtreme + (stop.trailAmount ?? 0);
  const triggered = !badTick && price > 0 && (stop.side === "long" ? price <= triggerPrice : price >= triggerPrice);
  return { newExtreme, triggerPrice, triggered, badTick };
}

export interface MonitorResult {
  evaluated: number;
  triggered: number;
  exited: number;
  purged: number;
}

/**
 * Synthetic trailing-stop monitor (works for any broker, incl. Robinhood MCP). Detection — extreme
 * tracking, trigger computation, bad-tick filtering — is always safe. Placing the market EXIT only
 * happens when `running` is true (the system was deliberately Started or is in a protective state
 * such as close_only/liquidating). Purges stops for positions that have closed, and auto-registers
 * a stop for each open position when `policy.riskRules.trailingStopPct` is configured and none
 * exists yet.
 */
export async function runSyntheticStopMonitor(
  userId: string,
  policy: TradingPolicy,
  running: boolean,
  now = new Date(),
  /** §7 slice 3 mutation-lease fence (AccountMutationContext.assertOwned) — checked before the
   *  risk-CREATING exit placement. Cancels within the pass run unfenced (risk-reducing). */
  fence?: () => void
): Promise<MonitorResult> {
  const result: MonitorResult = { evaluated: 0, triggered: 0, exited: 0, purged: 0 };
  const callerAccountNumber = policy.accountNumber;
  // The scheduler monitors every connected account, not just whichever account the UI currently
  // marks active. Resolve the policy's explicit account target through the ownership-scoped lookup;
  // never fall back to the mutable UI-active pointer or one account can inherit another account's
  // live/paper execution mode while its protective exit is being processed.
  const targetAccount = policy.connectedAccountId
    ? getConnectedAccount(policy.connectedAccountId, userId)
    : undefined;
  // An account is an account: an absent, deleted, or foreign target cannot be protected through a
  // guessed account. Preserve the existing no-account behavior by returning without broker work.
  if (!targetAccount) return result;

  // Treat the owned account row as authoritative for every execution-routing field. A stale or
  // malformed caller policy must not combine Account A credentials with Account B's account number
  // or broker adapter. Rebinding the local policy also scopes every downstream policy evaluation,
  // audit receipt, and broker operation consistently without mutating the caller's object.
  policy = {
    ...policy,
    connectedAccountId: targetAccount.id,
    accountNumber: targetAccount.accountNumber,
    activeBroker: targetAccount.broker
  };
  const accountNumber = policy.accountNumber;
  if (!accountNumber) return result;

  // §7 slice 3: the caller's mutation-lease key was derived from the PRE-rebind accountNumber.
  // If the authoritative row disagrees (stale/spoofed caller policy — the rebind exists exactly
  // for that case), the caller's lease serializes the WRONG account. Protection must still run
  // (the rebind-and-protect property is deliberate and test-pinned), but we must not PRETEND the
  // wrong account's lease covers this pass: drop the fence, receipt the mismatch. Interleave
  // exposure in this corner equals the pre-lease world, now visible in the audit trail.
  if (callerAccountNumber && callerAccountNumber !== accountNumber) {
    audit(
      "synthetic_stop_monitor_account_rebind_mismatch",
      { callerAccountNumber, rowAccountNumber: accountNumber, connectedAccountId: targetAccount.id },
      userId,
      targetAccount.id
    );
    fence = undefined;
  }

  const executionState = deriveExecutionState(policy, targetAccount);
  if (!executionState.mode) return result;
  const executionMode: ExecutionMode = executionState.mode;
  const gateway = getBrokerGateway(policy, userId);
  const source: FillSource = executionMode === "broker/live" ? "live" : "paper";

  let positions: EquityPosition[];
  try {
    positions = await gateway.getEquityPositions(accountNumber);
  } catch {
    return result; // can't evaluate safely without positions
  }
  await yieldEventLoop();
  const liveSymbols = new Set(positions.filter((p) => Math.abs(p.quantity) > 0.000001).map((p) => normalizeSymbol(p.symbol)));
  const yieldClock = { ms: Date.now() };

  // Per-position stop PLANS (LLM-chosen stop TYPE, persisted at fill time): self-loaded here rather
  // than threaded through the scheduler, since this monitor already owns its own DB reads. A
  // "trailing" plan makes trailing protection genuinely available even when the account-wide
  // trailingStopPct is 0/off (using STOP_PLAN_FALLBACK_STOP_PCT as the trail % in that case); a
  // "none" plan is a real, owner-accepted no-stop choice that must be honored regardless of the
  // account-wide trailing config — never silently overridden. "fixed"/"atr" plans don't touch this
  // lane at all (they pin the distance generateProactiveRiskProposals uses, not the trailing
  // overlay), so they're absent from this map's effect here.
  // filterStopPlansByLiveBasis drops any plan whose recorded avgCost no longer matches the live
  // position's averageCost — reused here (not just on the strategy-run side) so a symbol closed and
  // re-bought before any run observed it flat can't have its stale plan govern the new lot in THIS
  // monitor either (Codex review, PR #1371: strategy.ts and this monitor load stop plans
  // independently, so the basis check must run on both sides).
  let stopPlanBySymbol: Record<string, StopPlanStyle> = {};
  let stopPlanFullBySymbol: Record<string, PositionStopPlan> = {};
  try {
    const raw = await sqliteYieldRetry(() => getStopPlans(accountNumber, userId));
    stopPlanFullBySymbol = filterFullStopPlansByLiveBasis(raw, positions);
    stopPlanBySymbol = filterStopPlansByLiveBasis(raw, positions);
  } catch {
    // best-effort — a lookup failure just means every symbol falls through to "default" (account-wide) behavior
  }

  // Live open orders for the account, feeding the coverage checks below. A broker-held stop
  // (Alpaca OCO bracket leg, Robinhood broker-held protective stop) is a live exit-side order, so
  // the quantity-aware liveExitOrderCoverage counts it as protection — keyed off ACTUAL resting
  // orders (not policy inference) so a position is never left unprotected. If listing orders fails,
  // coverage sees no orders and the synthetic still registers below (protection over dedup).
  let brokerOrders: EquityOrder[] = [];
  let brokerOrdersListed = false;
  try {
    brokerOrders = await gateway.getEquityOrders(accountNumber);
    brokerOrdersListed = true;
  } catch {
    // Can't list orders — fall back to registering synthetic stops (protection over dedup).
  }
  // The account's OWN recognized broker-held protective stop for a symbol (broker_protective_stops,
  // keyed by its actual brokerOrderId) — populated AFTER reconcileBrokerProtectiveStops runs below,
  // so it reflects this tick's placements/cancellations. Excluded from the quantity-BLIND sweep just
  // below: it is separately-tracked, independently-managed coverage (possibly for OTHER shares of
  // the same symbol, e.g. a native trail covering the floored whole-share portion while the
  // synthetic monitor covers a fractional remainder) — it must never be mistaken for "our own
  // synthetic exit attempt might still be alive" (Codex review, PR #1331).
  // Populated from the DB now (state left by the END of the PREVIOUS tick's reconcile) so the
  // re-arm pass below — which runs BEFORE this tick's reconcile call — already excludes it;
  // refreshed again after reconcile runs (below) to reflect any placement/cancellation THIS tick
  // made, for the fire pass later in this same call.
  let brokerHeldOrderIdBySymbol = new Map<string, string>(
    (await sqliteYieldRetry(() => listBrokerProtectiveStops(accountNumber, userId))).map((r) => [
      normalizeSymbol(r.symbol),
      r.brokerOrderId
    ])
  );
  // Quantity-BLIND presence check — used only by the confirmed-terminal gate, where ANY live exit
  // order OTHER than the account's own recognized broker-held stop (excluded above) must block a
  // generation advance: while anything unaccounted-for is still working for the symbol — including
  // our own synthetic attempt, if its order lacks a matchable client_order_id — we cannot positively
  // rule the prior attempt dead. Registration and firing use the quantity-AWARE liveExitOrderCoverage
  // instead, so a 10-of-100-share trim can't leave the other 90 shares unprotected forever.
  const hasAnyLiveExitOrder = (symbol: string, positionSide: "long" | "short"): boolean =>
    brokerOrders.some(
      (o) =>
        normalizeSymbol(o.symbol) === symbol &&
        isLiveExitOrder(o, positionSide) &&
        o.id !== brokerHeldOrderIdBySymbol.get(symbol)
    );
  const isLiveState = (state: string): boolean => isLiveOrderState(state);

  // Synthetic protective exits whose outcome hasn't been reconciled yet (booked pending at
  // placement, finalized by reconcilePendingFills from broker truth). While one is pending for a
  // symbol, that exit may still have executed — never treat the attempt as dead.
  const pendingExitSymbols = new Set(
    (await sqliteYieldRetry(() => listPendingBrokerReconciliationFills(accountNumber, userId)))
      .filter((f) => Boolean((f.raw as Record<string, unknown> | undefined)?.syntheticStop))
      .map((f) => normalizeSymbol(f.symbol))
  );

  /**
   * POSITIVE confirmation that the prior protective-exit attempt's order is dead — the ONLY state in
   * which fire_generation may advance (rolling the client_order_id forward is safe exactly when the
   * old id's order can no longer execute). Layered, and ambiguity always fails to `false`:
   *  - the broker's order list was successfully fetched THIS tick (a failed fetch proves nothing);
   *  - it shows no live exit order for the symbol OTHER than the account's own recognized
   *    broker-held stop (see `brokerHeldOrderIdBySymbol` above) — that ONE specific order is
   *    excluded because it's separately-tracked, independently-managed coverage, so a
   *    coverage-aware PARTIAL fire (the synthetic sells only the remainder a broker-held stop
   *    doesn't cover) can coexist with it without blocking re-arm of the remainder's own dead
   *    attempt forever. Anything else live — including our OWN synthetic exit order, if its
   *    client_order_id happens not to be matchable below — still blocks (Codex review, PR #1331,
   *    two rounds: neither a pure symbol-wide sweep nor a pure client_order_id match alone is
   *    correct; excluding only the one order we can independently identify by broker-tracked id is);
   *  - the recorded last_attempt_ref_id (if any) appears in no live-state order, matched by
   *    client_order_id directly — belt-and-suspenders on top of the exclusion above, in case the
   *    excluded broker-held row and our own last attempt were somehow the same order;
   *  - no synthetic-exit fill for the symbol is still pending reconciliation;
   *  - (re-arm pass only) the row is older than the 15-min grace, so a slow in-flight placement
   *    spanning ticks can't race a re-arm. The grace is keyed off updated_at, which for ACTIVE rows
   *    is refreshed by the per-tick extreme persistence — so the fire path must not require it, or a
   *    reverted-after-throw stop could never roll its id forward (the permanent-422 loop again).
   */
  const confirmedPriorExitDead = (stop: SyntheticTrailingStop, requireGrace: boolean): boolean => {
    if (!brokerOrdersListed) return false;
    const sym = normalizeSymbol(stop.symbol);
    if (hasAnyLiveExitOrder(sym, stop.side)) return false;
    if (stop.lastAttemptRefId && brokerOrders.some((o) => o.clientOrderId === stop.lastAttemptRefId && isLiveState(o.state))) return false;
    if (pendingExitSymbols.has(sym)) return false;
    if (requireGrace && Date.now() - Date.parse(stop.updatedAt) < REARM_CONFIRM_GRACE_MS) return false;
    return true;
  };

  // Purge stops whose position has closed (size hit 0) — including 'triggered' ones, whose exit
  // order has by then done its job. A lingering triggered row would otherwise block auto-registering
  // a fresh stop if the symbol is re-entered later.
  for (const stop of await sqliteYieldRetry(() => [
    ...listSyntheticStops(accountNumber, userId),
    ...listSyntheticStops(accountNumber, userId, "triggered")
  ])) {
    if (!liveSymbols.has(stop.symbol.toUpperCase())) {
      await sqliteYieldRetry(() => deleteSyntheticStop(stop.id, userId));
      result.purged++;
    }
    await yieldIfDue(yieldClock);
  }

  // Re-arm 'triggered' stops whose protective exit order is confirmed dead while the position is
  // still open (canceled/expired/rejected without closing it — or terminal after only a partial).
  // Confirmation is the strict layered check above (order list visible, no live exit order, the
  // recorded client_order_id in no live state, nothing pending reconciliation, 15-min grace).
  // Anything short of that leaves the stop 'triggered' — never re-fire on top of an exit that may
  // still execute. On confirmation the generation advances (this is the positive-confirmation
  // moment), so the next fire places under a fresh "-g<n>" client_order_id instead of 422-colliding
  // with the dead order's id forever.
  if (brokerOrdersListed) {
    for (const stop of await sqliteYieldRetry(() => listSyntheticStops(accountNumber, userId, "triggered"))) {
      if (!liveSymbols.has(normalizeSymbol(stop.symbol))) continue; // position closed — purged above
      if (!confirmedPriorExitDead(stop, true)) continue;
      // fire_generation += 1 is not idempotent — retry each statement on its own so a
      // SQLITE_BUSY on audit cannot advance generation twice.
      await sqliteYieldRetry(() => advanceSyntheticStopGeneration(stop.id, userId));
      await sqliteYieldRetry(() => revertSyntheticStopClaim(stop.id, userId));
      await sqliteYieldRetry(() =>
        audit("synthetic_stop_rearmed", {
          symbol: stop.symbol,
          side: stop.side,
          fireGeneration: stop.fireGeneration + 1,
          note: "protective exit order confirmed terminal with the position still open — trailing protection restored"
        }, userId, policy.connectedAccountId)
      );
      await yieldIfDue(yieldClock);
    }
  }

  // Broker-held protective stops: fixed resting stops for open longs (Robinhood, opt-in) and/or
  // broker-held TRAILING stops (native Alpaca trailing_stop; tick-ratcheted stop-market on live
  // Robinhood) when a trailing % is configured — cancelled on close. No-op unless a lane is enabled
  // (see desiredBrokerStopKind in broker-protective-stops.ts).
  // Orders it CANCELS (e.g. the disabled-teardown) are pruned from the list REGISTRATION coverage
  // uses: brokerOrders was fetched before this reconcile ran, so a just-torn-down stop would
  // otherwise still look live and leave the position with NEITHER protection until the next tick.
  // Symbols it PLACED stops for this tick are the mirror-image staleness: the fresh resting order
  // CANNOT appear in the pre-reconcile list, so BOTH synthetic registration AND the fire path of
  // already-registered rows treat them as broker-covered for this tick (see the two
  // justPlacedBrokerStopSymbols skips below) instead of acting on an undercount. For CANCELLED
  // orders the fire and confirmed-dead paths keep the UNpruned list on purpose — a cancel the
  // broker merely accepted can still fill, and there a stale skip costs one tick while a wrong fire
  // costs a duplicate market sell.
  let registrationOrders = brokerOrders;
  // Full-size placements suppress BOTH synthetic registration and fire this tick (the fresh order
  // can't appear in the stale pre-reconcile list). Partial placements (a floored fractional
  // remainder, or shares partially covered by another exit order) suppress registration (a row
  // already exists) but must NOT blanket-skip the fire path — the fresh partial quantity is added
  // as KNOWN coverage on top of the stale order list's own coverage, so the fire path can still sell
  // the uncovered remainder this same tick instead of leaving it naked until the next tick's fresh
  // order fetch (Codex review, PR #1331).
  const justPlacedBrokerStopSymbols = new Set<string>();
  const justPlacedPartialBrokerStopQty = new Map<string, number>();
  // The app's own already-tracked high-water mark per symbol (ACTIVE rows only — a purged/triggered
  // row's extreme isn't live protection). Passed into reconcile so a broker-held trail is never
  // seeded looser than the trail already protecting the position after a rally-then-pullback.
  const extremePriceBySymbol = Object.fromEntries(
    (await sqliteYieldRetry(() => listSyntheticStops(accountNumber, userId))).map((s) => [
      normalizeSymbol(s.symbol),
      s.extremePrice
    ])
  );
  try {
    // Best-effort, independent of everything else this monitor does — a bracket teardown never
    // needs the running/positions/orders context above, just the account + gateway, so this can't
    // be blocked by (or block) the broker-protective-stops reconciliation below.
    try {
      await reconcilePendingBracketTeardowns(gateway, accountNumber, userId, policy.connectedAccountId);
    } catch {
      // never let a bracket-teardown sweep failure block the rest of this monitor's tick
    }
    // Halted protection may FIRE existing synthetic/exit stops (the fire loop below still runs under
    // `running`), CANCEL risk (closed-position sweeps, plan-excluded teardown, oversized stops that
    // could over-sell), and RIGHT-SIZE an oversized stop (cancel + place the smaller replacement) —
    // but never INITIATE new/looser protection (place for an unprotected position, or a non-shrink
    // cancel-then-replace). `haltedProtectOnly` enforces exactly that split in
    // `reconcileBrokerProtectiveStops`. Pass the real `running` so its risk-reducing cancels aren't
    // short-circuited by the `if (!running) return` gate (Codex review, PR #1738).
    const haltedProtectOnly = running && policy.systemState === "halted";
    const reconciled = await reconcileBrokerProtectiveStops({ userId, policy, accountNumber, gateway, positions, executionMode, running, haltedProtectOnly, orders: brokerOrders, ordersListed: brokerOrdersListed, extremePriceBySymbol, stopPlanBySymbol });
    if (reconciled.cancelledOrderIds.length > 0) {
      const cancelledIds = new Set(reconciled.cancelledOrderIds);
      registrationOrders = brokerOrders.filter((o) => !cancelledIds.has(o.id));
    }
    for (const sym of reconciled.placedStopSymbols) justPlacedBrokerStopSymbols.add(normalizeSymbol(sym));
    for (const sym of reconciled.partiallyPlacedStopSymbols) {
      const s = normalizeSymbol(sym);
      justPlacedPartialBrokerStopQty.set(s, reconciled.partiallyPlacedStopQuantities[sym] ?? reconciled.partiallyPlacedStopQuantities[s] ?? 0);
    }
    // A broker-held stop that FILLED between this call's position fetch and reconcile's own order
    // read reduced the position, but `positions` above was captured before `orders` — it may still
    // show the stale pre-fill quantity THIS call. Treat these symbols exactly like a fresh full-size
    // placement: skip both registration and fire this tick, deferring to the next call's fresh
    // position read (Codex review, PR #1331) — otherwise the synthetic monitor could auto-register
    // or fire a market exit against shares the broker stop already sold.
    for (const sym of reconciled.filledRecoverySymbols) justPlacedBrokerStopSymbols.add(normalizeSymbol(sym));
  } catch (err) {
    audit("broker_protective_stop_reconcile_error", { error: err instanceof Error ? err.message : String(err) }, userId, policy.connectedAccountId);
  }
  // Refresh the account's own recognized broker-held stop per symbol AFTER reconcile ran, so
  // `hasAnyLiveExitOrder`'s exclusion (see its doc comment) reflects any placement/cancellation
  // reconcile just made this tick.
  brokerHeldOrderIdBySymbol = new Map(
    (await sqliteYieldRetry(() => listBrokerProtectiveStops(accountNumber, userId))).map((r) => [
      normalizeSymbol(r.symbol),
      r.brokerOrderId
    ])
  );
  await yieldEventLoop();

  // A "none" plan is a real, owner-accepted no-stop choice — purge any ACTIVE row regardless of
  // kind. A "fixed"/"atr" plan excludes the TRAILING lane specifically (its protection is the
  // static-trigger 'fixed'-kind row registered below, item 7) — purge only a 'trailing'-kind row
  // left over from a prior plan/config; a 'fixed'-kind row for the SAME plan stays (see the kind
  // branch below). Purging happens (or CHANGED, e.g. a scale-in add reconsidering protection from
  // "trailing" to "fixed") AFTER a stop was already registered is actually honored, not just
  // silently skipped by the registration guard below (which only ever prevents a FRESH
  // registration, not an existing one — Codex review, PR #1371). A 'triggered' row is left alone —
  // its protective exit may still be resting/executing at the broker. A RESET to "default" (an
  // explicit `stopPlan: {style: "default"}` fill clears the row, so the symbol is simply absent
  // from stopPlanBySymbol) is handled the same way when the account itself has no trailing %
  // configured — otherwise the old row (armed under the plan's own fallback distance) would keep
  // trailing at that stale distance even though the position was reset to an account default that
  // wants no trailing lane at all (Codex review, PR #1371). When the account DOES have its own
  // trailingStopPct > 0, leave the row alone — it already trails at a real, still-applicable
  // account distance.
  const accountTrailPctForReset = policy.riskRules?.trailingStopPct ?? 0;
  for (const stop of await sqliteYieldRetry(() => listSyntheticStops(accountNumber, userId))) {
    const plan = stopPlanBySymbol[normalizeSymbol(stop.symbol)];
    if (plan === "none") {
      // delete is idempotent; audit is not.  Separate envelopes so a BUSY on audit
      // cannot duplicate the delete's audit row.
      await sqliteYieldRetry(() => deleteSyntheticStop(stop.id, userId));
      await sqliteYieldRetry(() =>
        audit("synthetic_stop_purged_by_plan", { symbol: stop.symbol, plan: "none", note: "per-position stop plan is 'none' — protection removed" }, userId, policy.connectedAccountId)
      );
      await yieldIfDue(yieldClock);
      continue;
    }
    if ((stop.kind ?? "trailing") === "fixed") {
      // A static-trigger row (item 7): purge only when the plan no longer wants THIS lane — a
      // switch to "trailing"/"default" (handled by the trailing lane's own registration instead) or
      // a reset with no live plan on record. Coverage that appears LATER (a broker-held stop placed
      // after this row was registered) is deliberately left alone here — the fire loop's existing
      // quantity-aware double-exit guard already no-ops a redundant fire, so continuously
      // re-checking coverage at purge time would add complexity without a safety benefit.
      if (plan !== "fixed" && plan !== "atr") {
        await sqliteYieldRetry(() => deleteSyntheticStop(stop.id, userId));
        await sqliteYieldRetry(() =>
          audit("synthetic_stop_purged_by_plan", { symbol: stop.symbol, plan: plan ?? "default", kind: "fixed", note: `per-position stop plan is '${plan ?? "default"}' — fixed/ATR tick-level protection removed` }, userId, policy.connectedAccountId)
        );
      }
      await yieldIfDue(yieldClock);
      continue;
    }
    const isPlanExcluded = plan === "fixed" || plan === "atr";
    const isResetWithNoAccountTrail = (plan === undefined || plan === "default") && accountTrailPctForReset <= 0;
    if (isPlanExcluded || isResetWithNoAccountTrail) {
      await sqliteYieldRetry(() => deleteSyntheticStop(stop.id, userId));
      await sqliteYieldRetry(() =>
        audit("synthetic_stop_purged_by_plan", { symbol: stop.symbol, plan: plan ?? "default", note: isPlanExcluded ? `per-position stop plan is '${plan}' — trailing protection removed` : "per-position stop plan reset to account default with no account-wide trailing % configured — trailing protection removed" }, userId, policy.connectedAccountId)
      );
    }
    await yieldIfDue(yieldClock);
  }

  // Auto-register a trailing stop for each open position when a trail % is configured account-wide,
  // OR when a position's own per-position plan is explicitly "trailing" (universal availability —
  // that choice must work even on an account with no trailing % configured at all, so it falls back
  // to STOP_PLAN_FALLBACK_STOP_PCT in that case). Longs trail from a high-watermark and exit with a
  // sell; shorts (only when short selling is enabled) trail from a low-watermark and exit with a
  // cover. A "none" plan never registers (purged above, and skipped below too); "fixed"/"atr"
  // plans don't touch THIS (ratcheting) lane — they get their own static-trigger registration pass
  // right below instead (item 7), so both are covered rather than "fixed/atr don't get a row at all".
  if (policy.systemState !== "halted") {
    const trailPct = policy.riskRules?.trailingStopPct ?? 0;
    // Long/short parity: when account-wide trailing is off, still arm synthetic trails on shorts
    // from shortStopLossPct (or stopLossPct fallback) so short books are not left to strategy-cadence proactive covers only.
    const shortTrailFallback =
      policy.riskRules?.shortStopLossPct && policy.riskRules.shortStopLossPct > 0
        ? policy.riskRules.shortStopLossPct
        : (policy.riskRules?.stopLossPct ?? 0);
    const anyTrailingPlan = positions.some((p) => stopPlanBySymbol[normalizeSymbol(p.symbol)] === "trailing");
    const anyShorts =
      positions.some((p) => p.quantity < -0.000001) &&
      shortTrailFallback > 0;
    if (trailPct > 0 || anyTrailingPlan || anyShorts) {
      // "Already protected" includes TRIGGERED stops: a triggered stop's exit order may still be
      // resting at the broker (e.g. a market sell placed after hours). Re-registering over it flipped
      // the row back to 'active' and re-fired the same stop every tick all night (MU, 2026-07-08).
      const existing = new Set(
        (await sqliteYieldRetry(() => [
          ...listSyntheticStops(accountNumber, userId),
          ...listSyntheticStops(accountNumber, userId, "triggered")
        ])).map((s) => s.symbol.toUpperCase())
      );
      for (const pos of positions) {
        const sym = normalizeSymbol(pos.symbol);
        if (Math.abs(pos.quantity) <= 0.000001 || existing.has(sym)) continue;
        const planStyle: StopPlanStyle = stopPlanBySymbol[sym] ?? "default";
        // "none"/"fixed"/"atr" all explicitly exclude the trailing lane for this symbol (mirrors the
        // purge just above) — without this, an account-wide trailingStopPct > 0 would fall through to
        // effectiveTrailPct = trailPct for a "fixed"/"atr" plan and re-register a trailing row in the
        // SAME pass the purge just removed one from, contrary to the plan's pinned protection (Codex
        // review, PR #1371).
        if (planStyle === "none" || planStyle === "fixed" || planStyle === "atr") continue;
        const isShort = pos.quantity < 0;
        // Default trail: account trailing %; trailing plan fallback; shorts without trail use shortStopLossPct.
        let effectiveTrailPct =
          planStyle === "trailing" ? (trailPct > 0 ? trailPct : STOP_PLAN_FALLBACK_STOP_PCT) : trailPct;
        if (!(effectiveTrailPct > 0) && isShort && shortTrailFallback > 0) {
          effectiveTrailPct = shortTrailFallback;
        }
        if (!(effectiveTrailPct > 0)) continue;
        // Reconcile PLACED (or cancel/REPLACED) a broker-held protective stop for this symbol THIS
        // tick. That fresh full-size stop cannot appear in the pre-reconcile order list, so the
        // coverage check below would undercount — the synthetic would register against stale
        // coverage, and if the quote already breaches the trail it would fire the same tick, selling
        // shares the replacement already covers and then cancelling that replacement
        // (cancelBrokerProtectiveStop after the fill booking), leaving the remainder unprotected
        // until the re-arm grace. Treat the symbol as broker-covered for THIS tick; the next tick's
        // fresh order fetch sees the real resting order and normal quantity-aware coverage takes
        // over. The fire path of ALREADY-registered rows carries the same gate (see the fire loop
        // below): an active row armed on an earlier tick (e.g. one where placement threw, or before
        // the feature was enabled) would otherwise fire against the same undercount and then cancel
        // the fresh stop.
        if (justPlacedBrokerStopSymbols.has(sym)) continue;
        // Live open exit orders (market/limit/stop — a full-size broker-held stop leg included) are
        // protection — but only for the shares they actually cover. Skip registering ONLY when the
        // whole position is covered (or a live exit order's quantity is unknowable — then assume full
        // coverage, failing toward no-duplicate-sell). A partial exit (e.g. a 10-of-100-share GTC
        // take-profit trim, or an undersized broker stop) must NOT leave the remaining shares
        // trailing-stop-less through a crash: the stop registers, and the fire path below sells only
        // the uncovered remainder. Re-checked every tick.
        // A PARTIAL broker-held stop this SAME reconcile just placed (e.g. a fractional remainder a
        // whole-share-only native trail floored away) can't appear in `registrationOrders` — it was
        // fetched before reconcile ran — so its coverage must be folded in explicitly, exactly like
        // the fire path below does. Without this, a partial placement that happens to fully cover the
        // remainder (combined with what registrationOrders already sees) still looks uncovered here
        // and arms an unnecessary synthetic row that then fights the fresh broker stop on a later tick
        // (Codex review, PR #1331, round 10).
        const coverage = liveExitOrderCoverage(registrationOrders, sym, isShort ? "short" : "long");
        const justPlacedPartialQty = justPlacedPartialBrokerStopQty.get(sym) ?? 0;
        const effectiveCoveredQty = coverage.coveredQty + justPlacedPartialQty;
        if (coverage.unknownQty || effectiveCoveredQty >= Math.abs(pos.quantity) - QTY_EPSILON) continue;
        const mark = pos.marketValue / pos.quantity; // sign-correct for long (+/+) and short (-/-)
        await sqliteYieldRetry(() =>
          upsertSyntheticStop({
            id: `synstop-${userId}-${accountNumber}-${sym}`,
            userId,
            accountNumber,
            symbol: sym,
            side: isShort ? "short" : "long",
            quantity: Math.abs(pos.quantity),
            entryPrice: pos.averageCost,
            extremePrice: isShort ? Math.min(mark, pos.averageCost) : Math.max(mark, pos.averageCost),
            trailPercent: effectiveTrailPct,
            status: "active",
            kind: "trailing"
          })
        );
        await yieldIfDue(yieldClock);
      }
    }
  }

  // Item 7 (Codex review): fixed/ATR stop plans previously had NO tick-level enforcement at all —
  // their only protection was whatever entry bracket survived to the broker plus the hourly-cadence
  // generateProactiveRiskProposals() check in strategy.ts. Between runs, a fractional,
  // bracket-stripped, or unsupported-order-type position could cross its stop with nothing watching.
  // Close that gap with a STATIC-TRIGGER row in the SAME table/machinery the trailing lane above
  // already uses (claim/generation/refId dedup, coverage-aware fire, bad-tick handling) — the fire
  // loop below reuses evaluateStop verbatim; the only difference is a 'fixed'-kind row's extreme is
  // re-pinned to entryPrice every tick (never persists the ratchet), so the identical comparison
  // yields a fixed distance from entry instead of a trail. Registered ONLY when the position isn't
  // ALREADY covered by a live broker-held/other exit order — when native protection rests at the
  // broker, that IS the continuous coverage and a duplicate tick-level row would be redundant (the
  // proactive hourly check remains the run-cadence backstop either way, unchanged).
  if (policy.systemState !== "halted") {
    const existingFixed = new Set(
      (await sqliteYieldRetry(() => [
        ...listSyntheticStops(accountNumber, userId),
        ...listSyntheticStops(accountNumber, userId, "triggered")
      ])).map((s) => s.symbol.toUpperCase())
    );
    const baseStopPct = policy.riskRules?.stopLossPct ?? 0;
    const baseShortStopPct = policy.riskRules?.shortStopLossPct ?? 0;
    for (const pos of positions) {
      const sym = normalizeSymbol(pos.symbol);
      if (Math.abs(pos.quantity) <= 0.000001 || existingFixed.has(sym)) continue;
      const planStyle = stopPlanBySymbol[sym];
      if (planStyle !== "fixed" && planStyle !== "atr") continue;
      const isShort = pos.quantity < 0;
      // Mirrors strategy.ts's generateProactiveRiskProposals `effectiveStopPct` fixed/atr precedence
      // exactly: "fixed" uses the account's flat stop % (fallback when unset); "atr" would prefer a
      // live ATR-derived % but this tick monitor has no historical bars to compute one, so it
      // resolves to the SAME base-%/fallback the proactive layer itself falls back to whenever its
      // own atrStopPctBySymbol precompute has no entry for the symbol — not a divergent
      // approximation, the identical fallback branch. The hourly proactive run still applies the
      // real ATR-derived distance when it has bars; this static row is the honest interim value for
      // the interval between runs (docs/design/exit-strategy-intelligence.md Rec 2/3 phasing).
      // SHORT chain is three-tier, matching the proactive layer verbatim (adversarial review of
      // 003dd33e): `shortStopLossPct > 0 ? shortStopLossPct : stopLossPct`, and 8% ONLY when both
      // are unset. Skipping the stopLossPct middle tier armed a short's backstop at 8% when the
      // owner had configured 15 — a tighter distance than any layer the owner set, firing a real
      // cover the configuration says should not happen.
      const base = isShort ? (baseShortStopPct > 0 ? baseShortStopPct : baseStopPct) : baseStopPct;
      const computed = base > 0 ? base : STOP_PLAN_FALLBACK_STOP_PCT;
      // Phase B1/B2: prefer Exit Contract resolved_stop_pct when present (ATR plans especially).
      const stopPct = persistedOrFallbackStopPct(stopPlanFullBySymbol[sym], computed);
      // Same same-tick staleness guards the trailing registration pass above uses: a broker-held
      // stop this SAME reconcile just placed/replaced can't appear in the pre-reconcile order list.
      if (justPlacedBrokerStopSymbols.has(sym)) continue;
      const coverage = liveExitOrderCoverage(registrationOrders, sym, isShort ? "short" : "long");
      const justPlacedPartialQty = justPlacedPartialBrokerStopQty.get(sym) ?? 0;
      const effectiveCoveredQty = coverage.coveredQty + justPlacedPartialQty;
      if (coverage.unknownQty || effectiveCoveredQty >= Math.abs(pos.quantity) - QTY_EPSILON) continue;
      await sqliteYieldRetry(() => {
        upsertSyntheticStop({
          id: `synstop-${userId}-${accountNumber}-${sym}`,
          userId,
          accountNumber,
          symbol: sym,
          side: isShort ? "short" : "long",
          quantity: Math.abs(pos.quantity),
          entryPrice: pos.averageCost,
          extremePrice: pos.averageCost, // pinned — the fire loop below re-pins this every tick, never ratchets
          trailPercent: stopPct,
          status: "active",
          kind: "fixed"
        });
        audit("synthetic_stop_registered_fixed", {
          symbol: sym,
          side: isShort ? "short" : "long",
          plan: planStyle,
          stopPct,
          entryPrice: pos.averageCost,
          note: "fixed/ATR plan given a static-trigger tick-level backstop — no live broker-held protection currently covers this position"
        }, userId, policy.connectedAccountId);
      });
      await yieldIfDue(yieldClock);
    }
  }

  const stops = await sqliteYieldRetry(() => listSyntheticStops(accountNumber, userId));
  if (stops.length === 0) return result;

  let quotes: Record<string, { price?: number; bid?: number; ask?: number; syntheticBid?: boolean; syntheticAsk?: boolean; symbol?: string }> = {};
  try {
    quotes = await gateway.getEquityQuotes(accountNumber, stops.map((s) => normalizeSymbol(s.symbol)));
  } catch (err) {
    // API outage fallback: populate quotes with the last known price from database
    console.error("[synthetic-stops] gateway quotes fetch failed, using lastPrice database cache fallback:", err);
    for (const stop of stops) {
      if (stop.lastPrice && stop.lastPrice > 0) {
        quotes[normalizeSymbol(stop.symbol)] = { price: stop.lastPrice, symbol: stop.symbol };
      }
    }
  }
  const priceFor = (sym: string): number | undefined => {
    const q = quotes[sym] ?? quotes[normalizeSymbol(sym)];
    return q && typeof q.price === "number" && q.price > 0 ? q.price : undefined;
  };
  // Quote ref for pricing an extended-hours marketable-limit exit: a SELL anchors to the real BID, a
  // COVER to the real ASK (the composite `price` is ask-biased — Alpaca sets price = ask ?? bid, so a
  // SELL priced off it would rest above the bid and never be marketable). A synthesized
  // (price-derived) spread side never anchors (mirrors the entry marketable-limit guard); the DB
  // lastPrice fallback above carries `price` only, so it degrades to the composite anchor.
  const exitQuoteFor = (sym: string): ProtectiveExitQuote | undefined => {
    const q = quotes[sym] ?? quotes[normalizeSymbol(sym)];
    if (!q) return undefined;
    return { price: q.price, bid: q.syntheticBid ? undefined : q.bid, ask: q.syntheticAsk ? undefined : q.ask };
  };
  const currSession = protectiveExitMarketSession(now);
  for (const stop of stops) {
    const price = priceFor(stop.symbol);
    result.evaluated++;
    if (price == null) continue;

    const q = quotes[stop.symbol] ?? quotes[normalizeSymbol(stop.symbol)];

    // A1: session boundary reset at the regular-hours open
    const prevSession = stop.updatedAt ? protectiveExitMarketSession(new Date(stop.updatedAt)) : "closed";
    if (prevSession !== "regular" && currSession === "regular" && ((stop.suspectCount ?? 0) > 0 || stop.suspectPrice != null)) {
      stop.suspectPrice = undefined;
      stop.suspectCount = 0;
    }

    const prev = stop.lastPrice;
    const isOutOfBand = prev != null && prev > 0 && Math.abs(price - prev) / prev > BAD_TICK_PCT;

    // Item 7: a 'fixed'-kind row (fixed/ATR static-trigger backstop) never lets its extreme ratchet.
    // Re-pin extremePrice to entryPrice before every evaluateStop call below — since evaluateStop
    // computes newExtreme = max/min(extremePrice, price), feeding entryPrice fresh each tick (never
    // the persisted ratchet) makes the comparison self-referential (and thus never-triggered,
    // matching a true fixed stop) whenever price has moved favorably past entry, and exactly
    // entryPrice*(1±pct) whenever it hasn't — the SAME math as a trailing stop, just never allowed
    // to remember a favorable excursion. The persistence step further down discards evaln.newExtreme
    // for this kind and re-persists entryPrice so the pin can never leak into the next tick.
    const stopKind = stop.kind ?? "trailing";
    const evalBasis = stopKind === "fixed" ? { ...stop, extremePrice: stop.entryPrice } : stop;

    let evaln: StopEvaluation;
    let finalSuspectPrice = stop.suspectPrice;
    let finalSuspectCount = stop.suspectCount ?? 0;

    if (!isOutOfBand) {
      evaln = evaluateStop(evalBasis, price);
      finalSuspectPrice = undefined;
      finalSuspectCount = 0;
    } else {
      let corroborated = true;
      if (currSession === "pre" || currSession === "post") {
        const hasRealBid = q && q.bid != null && q.syntheticBid !== true;
        const hasRealAsk = q && q.ask != null && q.syntheticAsk !== true;
        corroborated = hasRealBid || hasRealAsk;
      }

      if (!corroborated) {
        evaln = evaluateStop(evalBasis, price);
      } else {
        const agrees = finalSuspectPrice != null && Math.abs(price - finalSuspectPrice) / finalSuspectPrice <= 0.015;
        if (agrees) {
          finalSuspectCount++;
          if (finalSuspectCount >= 3) {
            evaln = evaluateStop({ ...evalBasis, lastPrice: undefined }, price);
            finalSuspectPrice = undefined;
            finalSuspectCount = 0;
          } else {
            evaln = evaluateStop(evalBasis, price);
          }
        } else {
          finalSuspectPrice = price;
          finalSuspectCount = 1;
          evaln = evaluateStop(evalBasis, price);
        }
      }
    }

    // Persist the updated extreme + last good price (a bad tick keeps the previous lastPrice). A
    // 'fixed'-kind row NEVER persists the ratcheted newExtreme — always re-pinned to entryPrice, or
    // a favorable excursion this tick would leak into the next tick's evalBasis and start trailing.
    await sqliteYieldRetry(() =>
      upsertSyntheticStop({
        ...stop,
        extremePrice: stopKind === "fixed" ? stop.entryPrice : evaln.newExtreme,
        lastPrice: evaln.badTick ? stop.lastPrice : price,
        suspectPrice: finalSuspectPrice,
        suspectCount: finalSuspectCount
      })
    );
    await yieldIfDue(yieldClock);
    if (!evaln.triggered) continue;
    result.triggered++;

    if (!running) {
      audit("synthetic_stop_would_trigger", { symbol: stop.symbol, side: stop.side, price, triggerPrice: evaln.triggerPrice, note: "system not running — exit suppressed" }, userId, policy.connectedAccountId);
      continue;
    }

    // Gated execution: fire the protective market exit (sell a long / cover a short).
    const posQty = positions.find((p) => normalizeSymbol(p.symbol) === normalizeSymbol(stop.symbol))?.quantity ?? stop.quantity;
    const positionQty = Math.abs(posQty); // order/fill quantity is always a positive magnitude (cover qty for shorts)
    if (positionQty <= QTY_EPSILON) {
      await sqliteYieldRetry(() => deleteSyntheticStop(stop.id, userId));
      continue;
    }
    // Reconcile PLACED (or cancel/REPLACED) a broker-held protective stop for this symbol THIS
    // tick — the same pre-reconcile-list staleness the registration skip above guards against, but
    // for a row that was ALREADY active (e.g. registered on a tick where section-4 placement threw,
    // or armed before robinhoodBrokerStops was enabled). The coverage check below cannot see the
    // just-placed FULL-size stop, so firing here would sell shares that stop already covers and
    // then cancelBrokerProtectiveStop (after the fill booking) would cancel the fresh stop —
    // duplicate exit, then no protection. Skipping costs one tick of trail responsiveness with
    // full-size broker-held protection resting; the next tick's fresh order fetch restores real
    // quantity-aware coverage. A PARTIAL placement this tick (e.g. a whole-share-only native trail
    // flooring away a fractional remainder) does NOT get this blanket skip — its known quantity is
    // folded into the coverage calculation below instead, so the fire path can still protect the
    // uncovered remainder THIS tick rather than leaving it completely naked until the next tick's
    // fresh order fetch (Codex review, PR #1331).
    const stopSym = normalizeSymbol(stop.symbol);
    if (justPlacedBrokerStopSymbols.has(stopSym)) {
      audit("synthetic_stop_skipped_resting_exit", {
        symbol: stop.symbol,
        positionQty,
        note: "broker-held protective stop placed this tick — resting protection the stale coverage list can't see; deferring fire to next tick's fresh coverage"
      }, userId, policy.connectedAccountId);
      continue;
    }
    // Quantity-aware double-exit guard: shares already covered by live exit orders are broker-held —
    // selling them again is a duplicate exit. Fully covered (or any live exit order with unknowable
    // quantity — assume full coverage, failing toward no-duplicate-sell): skip firing entirely and
    // leave the stop armed — if that order fills the position closes and the stop purges; if it dies
    // the stop can fire on a later tick. Partially covered (e.g. a 10-of-100-share GTC trim, OR a
    // broker-held stop this SAME reconcile just placed for only part of the position): fire for ONLY
    // the uncovered remainder, so the rest of the position isn't left unprotected.
    const coverage = liveExitOrderCoverage(brokerOrders, stopSym, stop.side);
    const justPlacedPartialQty = justPlacedPartialBrokerStopQty.get(stopSym) ?? 0;
    const effectiveCoveredQty = coverage.coveredQty + justPlacedPartialQty;
    if (coverage.unknownQty || effectiveCoveredQty >= positionQty - QTY_EPSILON) {
      audit("synthetic_stop_skipped_resting_exit", {
        symbol: stop.symbol,
        positionQty,
        coveredQty: effectiveCoveredQty,
        unknownOrderQuantity: coverage.unknownQty,
        note: coverage.unknownQty
          ? "a live exit order with unknowable quantity rests for this symbol — treated as fully covering, not stacking another protective exit"
          : "live exit orders (incl. a broker-held stop just placed this tick) already cover the full position — not stacking another protective exit"
      }, userId, policy.connectedAccountId);
      continue;
    }
    const qty = Math.min(positionQty, Math.max(positionQty - effectiveCoveredQty, 0));
    const exitSide = stop.side === "long" ? "sell" : "cover";
    // Route the protective exit: a plain market order that queues to the regular open by default, or a
    // marketable-limit tagged extended_hours when "App stops in extended hours" is on AND we are in the
    // pre/post session (a market order with extended_hours=true is broker-rejected). The limit anchors
    // to the real bid (sell crosses down) / ask (cover crosses up) with the triggering quote as the
    // fallback anchor; a fractional `qty` keeps the market/queue-to-open routing (fractional orders
    // are regular-hours-only — an extended-hours fractional limit would be hard-blocked, not queued).
    const routing = resolveProtectiveExitRouting(policy, exitSide, exitQuoteFor(stop.symbol), undefined, qty);
    const exitProposal: TradeProposal = {
      symbol: normalizeSymbol(stop.symbol),
      side: exitSide,
      type: routing.type,
      quantity: qty,
      limitPrice: routing.limitPrice,
      timeInForce: "gfd",
      marketHours: routing.marketHours,
      rationale: stopKind === "fixed"
        ? "Fixed/ATR stop fired from the protective scheduler's tick-level backstop (item 7)."
        : "Synthetic trailing stop fired from the protective scheduler.",
      tradeThesisTag: "Synthetic Stop",
      entryMarketRegime: "Risk Exit"
    };
    const tradability = await gateway.getEquityTradability(accountNumber, [exitProposal.symbol]).catch((err) => {
      audit("synthetic_stop_blocked", { symbol: stop.symbol, reason: "tradability_check_failed", error: err instanceof Error ? err.message : String(err) }, userId, policy.connectedAccountId);
      return undefined;
    });
    if (!tradability?.[exitProposal.symbol]?.tradable) {
      audit("synthetic_stop_blocked", {
        symbol: stop.symbol,
        reason: tradability?.[exitProposal.symbol]?.reason ?? "Symbol is not tradable for the protective exit."
      }, userId, policy.connectedAccountId);
      continue;
    }
    const portfolio = await gateway.getPortfolio(accountNumber).catch((err) => {
      audit("synthetic_stop_blocked", { symbol: stop.symbol, reason: "portfolio_check_failed", error: err instanceof Error ? err.message : String(err) }, userId, policy.connectedAccountId);
      return undefined;
    });
    if (!portfolio) continue;
    const daily = await sqliteYieldRetry(() => dailyExecutionStats(accountNumber, new Date(), userId));
    const policyDecision = evaluateTradeProposal(exitProposal, {
      policy,
      portfolio,
      positions,
      dailyNotionalUsed: daily.notional,
      dailyOrderCount: daily.openingOrderCount,
      estimatedNotional: qty * price,
      isLiveExecution: executionMode === "broker/live"
    });
    if (!policyDecision.approved) {
      audit("synthetic_stop_blocked", { symbol: stop.symbol, reasons: policyDecision.reasons }, userId, policy.connectedAccountId);
      continue;
    }
    // Atomically claim this stop (active -> triggered) BEFORE placing. If a previous tick's
    // monitor is still mid-placement (slow broker call spanning the next 60s tick), it already
    // claimed the stop and this run skips it — so the same protective exit can't fire twice. The
    // claim also serializes the generation/refId bookkeeping below against concurrent monitor runs.
    if (!(await sqliteYieldRetry(() => claimSyntheticStop(stop.id, userId)))) {
      audit("synthetic_stop_skipped_inflight", { symbol: stop.symbol, note: "already claimed/triggered by a concurrent monitor run" }, userId, policy.connectedAccountId);
      continue;
    }
    // Deterministic ref id (stop id + trigger price + fire generation) so the broker's own
    // client_order_id dedupe stays the LAST-RESORT double-sell guard:
    //  - A row with NO last_attempt_ref_id has no possibly-live prior order; its id comes from the
    //    row's fire_generation ("-g<n>" appended only when > 0, so a first-generation fire keeps the
    //    original unsuffixed id format and dedupe semantics unchanged).
    //  - A row that still CARRIES last_attempt_ref_id was reverted after an uncertain placement
    //    (threw after the broker may have accepted — no fill was booked). Only on POSITIVE
    //    confirmation that that order is dead (the same layered check the re-arm pass uses; no
    //    time grace here — see confirmedPriorExitDead for why updated_at can't gate active rows)
    //    does the generation advance and a fresh id get computed. Anything ambiguous — order list
    //    fetch failed, the old id or any exit order still live, a fill still pending — reuses the
    //    recorded id VERBATIM, so if the prior order is alive at the broker the retry 422s instead
    //    of double-selling. Failing safe here is the whole point: a 422 costs a tick; a duplicate
    //    market sell costs money.
    // The id is persisted (recordSyntheticStopAttempt) BEFORE the broker call, so even a placement
    // that throws mid-flight leaves a durable record of the possibly-live order.
    //
    // These post-claim writes MUST stay inside the try and go through sqliteYieldRetry.
    // Serving busy_timeout is only SQLITE_BUSY_PIN_MS (100).  An unwrapped SQLITE_BUSY after
    // claim() leaves status=triggered with no last_attempt_ref_id, so the fire loop skips the
    // row and the 15-min re-arm grace leaves the position naked.  Wrap each statement on its
    // own — insertFillEvent is not idempotent, so it must not share a retry envelope with
    // upsertSyntheticStop.
    let generation = stop.fireGeneration;
    let refId: string | undefined;
    try {
      if (stop.lastAttemptRefId) {
        if (confirmedPriorExitDead(stop, false)) {
          await sqliteYieldRetry(() => advanceSyntheticStopGeneration(stop.id, userId));
          generation += 1;
        } else {
          refId = stop.lastAttemptRefId;
        }
      }
      // Generate within the broker-portable charset so the tag round-trips exactly for the secondary
      // client-order-id dedup (see brokerPortableRefId). A reused stop.lastAttemptRefId was itself
      // stored portable, so both branches stay consistent.
      const attemptRefId = refId ?? brokerPortableRefId(`sstop-${stop.id}-${Math.round(evaln.triggerPrice * 100)}${generation > 0 ? `-g${generation}` : ""}`);
      refId = attemptRefId;
      await sqliteYieldRetry(() => recordSyntheticStopAttempt(stop.id, attemptRefId, userId));
      // Mutation-lease fence: fail closed before the risk-CREATING exit placement if the
      // window's lease was lost (another sequence may already be mutating this account).
      fence?.();
      const exec = await gateway.placeEquityOrder({
        accountNumber,
        symbol: stop.symbol,
        side: exitSide,
        type: routing.type,
        quantity: qty,
        limitPrice: routing.limitPrice,
        timeInForce: "gfd",
        marketHours: routing.marketHours,
        refId: attemptRefId
      });
      // A non-throwing broker response can still be a synchronous rejection/cancellation (same
      // trap as the strategy placement paths). No order will ever execute — don't book a fill,
      // and re-arm the stop so the position isn't left unprotected behind a stuck 'triggered' row.
      if (isRejectedOrCanceledState(exec.state)) {
        await sqliteYieldRetry(() => revertSyntheticStopClaim(stop.id, userId));
        auditSyntheticStopError(stop.id, stop.symbol, `Broker declined the protective exit (state: ${exec.state}).`, userId, policy, { orderId: exec.orderId });
        continue;
      }
      // The fill is FINAL only when the broker confirms it filled synchronously (same rule as the
      // normal exit-placement paths in strategy.ts). Anything still resting — e.g. a market order
      // placed after hours that sits at the broker until the open — books as pending_reconciliation
      // at the provisional quote, and reconcilePendingFills finalizes the real price/qty/time from
      // the broker (brokerOrderId is the match key). Booking 'filled' at the placement-time quote
      // fabricated the realized P&L on the 2026-07-08 overnight MU exit.
      const filledNow = exec.state === "filled";
      // B8: a synchronously-filled paper/test protective exit is booked at the raw quote (no broker
      // reconciliation will follow), so debit the same execution-cost model the entry path uses —
      // otherwise the losing tail exits cost-free and overstates realized edge feeding the tuner/
      // sizer. Live sync fills prefer the broker's own average price; resting orders book the raw
      // quote provisionally and get the real fill price at reconciliation.
      const exitPrice = filledNow
        ? (source === "live" ? exec.averagePrice ?? price : applyPaperExitCost(price, exitSide, source))
        : price;
      await sqliteYieldRetry(() =>
        insertFillEvent({
          userId,
          accountNumber,
          source,
          executionMode,
          symbol: normalizeSymbol(stop.symbol),
          side: exitSide,
          quantity: qty,
          price: exitPrice,
          notional: qty * exitPrice,
          status: filledNow ? "filled" : "pending_reconciliation",
          brokerOrderId: exec.orderId,
          raw: { syntheticStop: true, triggerPrice: evaln.triggerPrice }
        })
      );
      // If a broker-held protective stop is resting for this symbol, cancel it — but ONLY when
      // this exit closes the WHOLE position (qty covers everything the broker stop didn't). A
      // PARTIAL synthetic fire (qty < positionQty) means a broker-held stop is already covering
      // the shares this exit did NOT sell (that's exactly why coverage sized this fire to the
      // uncovered remainder in the first place) — cancelling it here would strip the still-open
      // remainder of its broker-held protection for no reason, leaving it covered only by a
      // 'triggered' synthetic row that stays inert until the 15-min re-arm grace (Codex review, PR
      // #1331). Best-effort either way.
      if (qty >= positionQty - QTY_EPSILON) {
        await cancelBrokerProtectiveStop(userId, accountNumber, stop.symbol, gateway, policy.connectedAccountId).catch(() => {});
      }
      // Already 'triggered' via the claim; this just records the final lastPrice.
      await sqliteYieldRetry(() =>
        upsertSyntheticStop({ ...stop, status: "triggered", lastPrice: price, suspectPrice: finalSuspectPrice, suspectCount: finalSuspectCount })
      );
      result.exited++;
      audit("synthetic_stop_triggered", { symbol: stop.symbol, side: stop.side, exitSide, price, triggerPrice: evaln.triggerPrice, quantity: qty, orderId: exec.orderId, kind: stopKind }, userId, policy.connectedAccountId);
    } catch (err) {
      // Placement failed/uncertain — re-arm the stop so a later tick can retry rather than
      // leaving the position unprotected behind a stuck 'triggered' row. The revert deliberately
      // KEEPS last_attempt_ref_id (and never touches fire_generation): the broker may have accepted
      // this order before the call threw, and remembering its client_order_id is what lets the
      // retry reuse the same id (422-safe) until that order is positively confirmed dead.
      await sqliteYieldRetry(() => revertSyntheticStopClaim(stop.id, userId));
      auditSyntheticStopError(stop.id, stop.symbol, err instanceof Error ? err.message : String(err), userId, policy);
    }
  }

  return result;
}
