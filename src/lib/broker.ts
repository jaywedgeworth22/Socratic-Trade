import type { BrokerGateway, EquityOrderInput, ExecutedOrder, TradingPolicy } from "./types";
import { getRobinhoodGateway, getTestGateway } from "./robinhood";
import { getAlpacaGateway } from "./alpaca";
import { getTradierGateway } from "./tradier";
import { getEToroGateway } from "./etoro";
import { getPublicGateway } from "./public-broker";
import { getWebullGateway } from "./webull";
import { getKalshiGateway } from "./kalshi-broker";
import { audit, getActiveConnectedAccount, getConnectedAccount } from "./db";
import { deriveExecutionState } from "./execution-mode";
import { assertLivePreflight } from "./preflight-live-guard";
import { applyOrderConstraints, OrderConstraintBlockedError, toConstraintBrokerId } from "./broker-order-constraints";
import { accountMutationSerializationEnabled, hasActiveLocalBrokerMutationClaim } from "./account-mutation";
import { withPositionInvariant } from "./order-position-invariant";

function resolveGateway(policy: TradingPolicy, userId: string): BrokerGateway {
  if (policy.activeBroker === "alpaca" || policy.activeBroker === "alpaca-mcp") {
    return getAlpacaGateway(userId, policy.connectedAccountId);
  }
  if (policy.activeBroker === "robinhood") {
    return getRobinhoodGateway(userId);
  }
  // "test" is TEST INFRASTRUCTURE (TestBrokerGateway) — a genuinely connected account whose
  // broker is "test", used by the unit-test suite so execution flows through this same broker
  // path without hitting real Alpaca/Robinhood. It is not a product default.
  if (policy.activeBroker === "test") {
    return getTestGateway(userId);
  }
  if (policy.activeBroker === "tradier") {
    return getTradierGateway(userId, policy.connectedAccountId);
  }
  if (policy.activeBroker === "etoro") {
    return getEToroGateway(userId, policy.connectedAccountId);
  }
  if (policy.activeBroker === "public") {
    return getPublicGateway(userId, policy.connectedAccountId);
  }
  if (policy.activeBroker === "webull") {
    return getWebullGateway(userId, policy.connectedAccountId);
  }
  if (policy.activeBroker === "kalshi") {
    return getKalshiGateway(userId, policy.connectedAccountId);
  }
  // No connected account: an account is an account, and with none connected the app cannot
  // place orders. There is no local-simulation fallback.
  throw new Error("No connected broker account. Connect a broker account before the app can place orders.");
}

/**
 * Wrap a gateway so `placeEquityOrder` runs the default-off live pre-flight guard first. This is the
 * SINGLE choke point every real-order PLACEMENT path flows through — the strategy loop, approval path,
 * synthetic stops, broker protective stops, order replacement, and any future caller — so real capital
 * is never committed unless `ALLOW_LIVE_TRADING` is set AND the connected account's environment is
 * genuinely live.
 *
 * `cancelEquityOrder` is deliberately NOT guarded here: cancelling is RISK-REDUCING, and an operator
 * who disables live trading in an emergency must still be able to cancel outstanding live orders /
 * stale protective stops (manual `/api/orders/cancel`, cancel-on-close cleanup, etc.). The narrow
 * cancel-THEN-place workflows (order replacement, protective-stop reconcile) instead run the pre-flight
 * BEFORE their own cancel phase (see `livePreflightBlocks`), so they fail atomically with no orphaned
 * cancel — without blocking standalone cancels.
 *
 * No-op on the broker/paper path. Execution state is derived lazily (only when a placement actually
 * runs) so read-only gateway uses pay no extra DB cost. A Proxy (not mutation) keeps the underlying
 * gateway untouched, so re-resolving the gateway can never double-wrap it.
 */
function withLivePreflight(gateway: BrokerGateway, policy: TradingPolicy, userId: string): BrokerGateway {
  return new Proxy(gateway, {
    get(target, prop, receiver) {
      if (prop === "placeEquityOrder") {
        // async so a guard failure becomes a REJECTED promise (correct async contract) rather than a
        // synchronous throw, matching how every caller `await`s placeEquityOrder.
        return async (input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> => {
          const activeAccount =
            (policy.connectedAccountId ? getConnectedAccount(policy.connectedAccountId, userId) : undefined) ??
            getActiveConnectedAccount(userId);
          const executionState = deriveExecutionState(policy, activeAccount);
          // resolveGateway already refused a missing account before this Proxy could exist, but guard
          // again here (defense in depth / type narrowing) rather than trust that invariant blindly.
          if (!executionState.mode) {
            throw new Error("No connected broker account. Connect a broker account before the app can place orders.");
          }
          assertLivePreflight({
            mode: executionState.mode,
            symbol: input.symbol,
            side: input.side
          });
          return target.placeEquityOrder(input);
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  });
}

/**
 * Wrap a gateway so `placeEquityOrder` runs the declarative per-broker order-shape constraint
 * tables (broker-order-constraints.ts, oss-lessons §7 slice 2) before the adapter sees the order.
 * Same single-choke-point rationale as `withLivePreflight` above — every placement lane flows
 * through here — but unlike the live preflight this applies in EVERY environment: the motivating
 * Alpaca 422 ("bracket orders must be entry orders", symbol T, 2026-07-27) happened on paper.
 *
 * A "block" violation throws OrderValidationError, which the strategy/approval lanes classify as
 * proposal status "blocked" (nothing was sent to the broker). A "reshape" (e.g. stripping bracket
 * legs off an exit) is audited per constraint as `order_constraint_reshaped` so the correction is
 * visible, then placement proceeds with the corrected shape. Cancels are untouched (risk-reducing).
 */
export function withOrderConstraints(gateway: BrokerGateway, policy: TradingPolicy, userId: string): BrokerGateway {
  return new Proxy(gateway, {
    get(target, prop, receiver) {
      if (prop === "placeEquityOrder") {
        return async (input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> => {
          const broker = toConstraintBrokerId(policy.activeBroker);
          // Unknown broker: resolveGateway already threw for anything not in the table, so this
          // is unreachable in practice — but fail OPEN here (adapter's own validation still runs)
          // rather than invent a block the table doesn't document.
          if (!broker) return target.placeEquityOrder(input);
          let applied: ReturnType<typeof applyOrderConstraints>;
          try {
            applied = applyOrderConstraints(broker, input);
          } catch (error) {
            // Audit blocks HERE, where the row identity is known — the strategy lane's own audit
            // for this branch predates the tables and carries a preflight-flavored kind.
            if (error instanceof OrderConstraintBlockedError) {
              audit(
                "order_constraint_blocked",
                {
                  broker,
                  constraintId: error.constraintId,
                  description: error.constraintDescription,
                  symbol: input.symbol,
                  side: input.side,
                  type: input.type,
                  refId: input.refId,
                  reason: error.message
                },
                userId,
                policy.connectedAccountId
              );
            }
            throw error;
          }
          const { input: constrained, reshaped } = applied;
          for (const receipt of reshaped) {
            audit(
              "order_constraint_reshaped",
              {
                broker,
                constraintId: receipt.constraintId,
                description: receipt.description,
                changedFields: receipt.changedFields,
                symbol: input.symbol,
                side: input.side,
                type: input.type,
                refId: input.refId
              },
              userId,
              policy.connectedAccountId
            );
          }
          return target.placeEquityOrder({ ...constrained, refId: input.refId });
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  });
}

/**
 * Advisory backstop for the per-account mutation lease (§7 slice 3): a placement arriving with
 * NO active local mutation claim for its account is audited as `broker_mutation_unleased` and
 * ALLOWED THROUGH — a receipt, not a cage. This converts "a wrap point was missed" (new lane,
 * refactor, future caller) from a silent serialization hole into a greppable audit event.
 * Cancels are deliberately never inspected here (see the cancel doctrine in account-mutation.ts).
 */
function withMutationLeaseReceipt(gateway: BrokerGateway, policy: TradingPolicy, userId: string): BrokerGateway {
  return new Proxy(gateway, {
    get(target, prop, receiver) {
      if (prop === "placeEquityOrder") {
        return async (input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> => {
          if (
            accountMutationSerializationEnabled() &&
            !hasActiveLocalBrokerMutationClaim(userId, input.accountNumber, policy.connectedAccountId)
          ) {
            audit(
              "broker_mutation_unleased",
              { accountNumber: input.accountNumber, symbol: input.symbol, side: input.side, type: input.type, refId: input.refId },
              userId,
              policy.connectedAccountId
            );
          }
          return target.placeEquityOrder(input);
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  });
}

export function getBrokerGateway(policy: TradingPolicy, userId: string = "local"): BrokerGateway {
  // Composition order: the live preflight (outermost) authorizes the attempt, then the position
  // invariant (order-position-invariant.ts) reads the FRESH broker position and refuses/clamps/
  // re-verbs closing orders (a sell only ever reduces a long; a cover only ever reduces a short),
  // then the constraint tables validate/reshape the order shape, then the mutation-lease receipt
  // backstop observes, then the adapter runs its own checks.
  return withLivePreflight(
    withPositionInvariant(
      withOrderConstraints(withMutationLeaseReceipt(resolveGateway(policy, userId), policy, userId), policy, userId),
      policy,
      userId
    ),
    policy,
    userId
  );
}
