import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewedOrder } from "../src/lib/types";

// Owner ruling 2026-07-09: a fractional/dollar order landing below the broker's minimum size is
// BUMPED to the floor and placed (audited), not skipped — brokerMinimumHandling "bump" is the
// default. This suite covers the planner: when a bump is safe/executable it returns the sizing
// patch, and every case where it can't be made safe returns undefined so the caller falls back to
// the existing skip path (covered by broker-minimum-guard.test.ts).
beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-broker-min-bump-${randomUUID()}.db`)}`;
});

function baseReview(overrides: Partial<ReviewedOrder> = {}): ReviewedOrder {
  return { estimatedNotional: 0.23, alerts: [], raw: {}, ...overrides };
}

describe("planBrokerMinimumBump", () => {
  it("bumps a dollar-based BUY to exactly the broker floor", async () => {
    const { planBrokerMinimumBump } = await import("../src/lib/broker-minimum-guard");
    const plan = planBrokerMinimumBump(baseReview(), "robinhood", { dollarAmount: 0.23, side: "buy" });
    expect(plan).toBeDefined();
    expect(plan!.patch.dollarAmount).toBe(1);
    // The patch must explicitly clear quantity: brokers prefer quantity when both are set, so a
    // stale sub-minimum quantity would defeat the bump. toHaveProperty(k, undefined) passes for a
    // MISSING key too, so assert via an Object.assign round-trip onto a mixed-form order.
    const mixed = Object.assign({ quantity: 0.001, dollarAmount: 0.23 }, plan!.patch);
    expect(mixed.quantity).toBeUndefined();
    expect(mixed.dollarAmount).toBe(1);
    expect(plan!.fromNotional).toBeCloseTo(0.23);
    expect(plan!.toNotional).toBeCloseTo(1);
  });

  it("bumps a fractional-quantity BUY by scaling the quantity with a small cushion", async () => {
    const { planBrokerMinimumBump } = await import("../src/lib/broker-minimum-guard");
    // 0.001 sh at ~$230 implied -> needs ~0.00437 sh for $1.005
    const plan = planBrokerMinimumBump(baseReview(), "robinhood", { quantity: 0.001, side: "buy" });
    expect(plan).toBeDefined();
    expect(plan!.patch.quantity).toBeCloseTo((0.001 * 1 * 1.005) / 0.23, 6);
    const mixedQty = Object.assign({ quantity: 0.001, dollarAmount: 0.23 }, plan!.patch);
    expect(mixedQty.dollarAmount).toBeUndefined();
    // resulting notional lands just above the floor, never under it
    const impliedPrice = 0.23 / 0.001;
    expect(plan!.patch.quantity! * impliedPrice).toBeGreaterThanOrEqual(1);
  });

  it("declines to bump an OPENING order whose floor exceeds the effective per-order cap", async () => {
    const { planBrokerMinimumBump } = await import("../src/lib/broker-minimum-guard");
    // 20% of a $4 NAV = $0.80 cap < $1 floor -> policy would reject the bump; skip path instead
    const plan = planBrokerMinimumBump(baseReview(), "robinhood", { dollarAmount: 0.23, side: "buy" }, { openingCapNotional: 0.8 });
    expect(plan).toBeUndefined();
  });

  it("still bumps an OPENING order when the floor fits the cap", async () => {
    const { planBrokerMinimumBump } = await import("../src/lib/broker-minimum-guard");
    const plan = planBrokerMinimumBump(baseReview(), "robinhood", { dollarAmount: 0.23, side: "buy" }, { openingCapNotional: 2 });
    expect(plan).toBeDefined();
    expect(plan!.patch.dollarAmount).toBe(1);
  });

  it("declines a quantity BUY whose CUSHIONED target exceeds the cap even though the floor fits", async () => {
    const { planBrokerMinimumBump } = await import("../src/lib/broker-minimum-guard");
    // quantity patches aim floor*1.005; a cap between the floor and the cushioned target must decline
    const plan = planBrokerMinimumBump(baseReview(), "robinhood", { quantity: 0.001, side: "buy" }, { openingCapNotional: 1.002 });
    expect(plan).toBeUndefined();
    // ...while a dollar patch targeting exactly the floor still fits the same cap
    const dollarPlan = planBrokerMinimumBump(baseReview(), "robinhood", { dollarAmount: 0.23, side: "buy" }, { openingCapNotional: 1.002 });
    expect(dollarPlan).toBeDefined();
  });

  it("declines quantity scaling when the reviewed notional is too small to trust as a price oracle", async () => {
    const { planBrokerMinimumBump } = await import("../src/lib/broker-minimum-guard");
    const plan = planBrokerMinimumBump(baseReview({ estimatedNotional: 0.01 }), "robinhood", { quantity: 0.001, side: "buy" });
    expect(plan).toBeUndefined();
    // dollar-based buys don't use the review as a price oracle and still bump
    const dollarPlan = planBrokerMinimumBump(baseReview({ estimatedNotional: 0.01 }), "robinhood", { dollarAmount: 0.01, side: "buy" });
    expect(dollarPlan).toBeDefined();
  });

  it("bumps a partial SELL trim by scaling quantity, staying under the held position", async () => {
    const { planBrokerMinimumBump } = await import("../src/lib/broker-minimum-guard");
    // The production case: an AAPL trim clamped to ~$0.23 on a tiny NAV. 0.001 sh of ~$230 stock,
    // holding 0.02 sh -> bump needs ~0.00437 sh, well under the position.
    const plan = planBrokerMinimumBump(baseReview(), "robinhood", { quantity: 0.001, side: "sell", positionQuantity: 0.02 });
    expect(plan).toBeDefined();
    expect(plan!.patch.quantity).toBeCloseTo((0.001 * 1 * 1.005) / 0.23, 6);
    expect(plan!.patch.quantity!).toBeLessThan(0.02);
  });

  it("degrades a SELL bump that needs more than the held position to a FULL-position exit", async () => {
    const { planBrokerMinimumBump } = await import("../src/lib/broker-minimum-guard");
    // Holding only 0.002 sh (~$0.46): reaching $1 would need ~0.0044 sh > held -> sell it all
    // (brokers permit liquidating a whole fractional position at any notional).
    const plan = planBrokerMinimumBump(baseReview(), "robinhood", { quantity: 0.001, side: "sell", positionQuantity: 0.002 });
    expect(plan).toBeDefined();
    expect(plan!.patch.quantity).toBe(0.002);
  });

  it("converts a dollar-based SELL to a position-bounded quantity order (the production AAPL case)", async () => {
    const { planBrokerMinimumBump } = await import("../src/lib/broker-minimum-guard");
    // $0.22 dollar trim of a ~$1.09 position (0.005 sh @ ~$218 implied): converted to the
    // quantity (~0.00461 sh) that reaches the $1 floor, priced off the position's market value.
    const plan = planBrokerMinimumBump(baseReview({ estimatedNotional: 0.22 }), "robinhood", {
      dollarAmount: 0.22,
      side: "sell",
      positionQuantity: 0.005,
      positionMarketValue: 1.09
    });
    expect(plan).toBeDefined();
    expect(plan!.patch.dollarAmount).toBeUndefined();
    const impliedPrice = 1.09 / 0.005;
    expect(plan!.patch.quantity).toBeCloseTo((1 * 1.005) / impliedPrice, 6);
    expect(plan!.patch.quantity! * impliedPrice).toBeGreaterThanOrEqual(1);
    expect(plan!.patch.quantity!).toBeLessThan(0.005);
  });

  it("degrades a dollar-based SELL of a sub-floor position to a full-position exit", async () => {
    const { planBrokerMinimumBump } = await import("../src/lib/broker-minimum-guard");
    const plan = planBrokerMinimumBump(baseReview({ estimatedNotional: 0.22 }), "robinhood", {
      dollarAmount: 0.22,
      side: "sell",
      positionQuantity: 0.004,
      positionMarketValue: 0.9
    });
    expect(plan).toBeDefined();
    expect(plan!.patch.quantity).toBe(0.004);
  });

  it("declines a dollar-based SELL when the position's market value is unknown", async () => {
    const { planBrokerMinimumBump } = await import("../src/lib/broker-minimum-guard");
    const plan = planBrokerMinimumBump(baseReview(), "robinhood", { dollarAmount: 0.23, side: "sell", positionQuantity: 0.02 });
    expect(plan).toBeUndefined();
  });

  it("bumps a COVER against a short position stored with negative quantity", async () => {
    const { planBrokerMinimumBump } = await import("../src/lib/broker-minimum-guard");
    const plan = planBrokerMinimumBump(baseReview(), "robinhood", { quantity: 0.001, side: "cover", positionQuantity: -0.02 });
    expect(plan).toBeDefined();
    expect(plan!.patch.quantity).toBeCloseTo((0.001 * 1 * 1.005) / 0.23, 6);
    expect(plan!.patch.quantity!).toBeGreaterThan(0);
  });

  it("declines a SELL when the held quantity is unknown", async () => {
    const { planBrokerMinimumBump } = await import("../src/lib/broker-minimum-guard");
    const plan = planBrokerMinimumBump(baseReview(), "robinhood", { quantity: 0.001, side: "sell" });
    expect(plan).toBeUndefined();
  });

  // CORRECTED 2026-09-25 (board 687a5fb4, lane G3): describeBrokerMinimumOrderBlock no longer
  // exempts a full-position exit from the broker's floor (see broker-minimum-guard.test.ts) —
  // Robinhood rejects these unconditionally. A SELL/COVER already sized to the ENTIRE held
  // position has nowhere left to bump TO, so the planner must decline immediately rather than
  // hand back a same-size "bump" that would just re-review and get blocked one round trip later.
  it("declines a SELL that is already the full held position (nothing left to bump to)", async () => {
    const { planBrokerMinimumBump } = await import("../src/lib/broker-minimum-guard");
    const plan = planBrokerMinimumBump(baseReview({ estimatedNotional: 0.22 }), "robinhood", {
      quantity: 0.002,
      side: "sell",
      positionQuantity: 0.002
    });
    expect(plan).toBeUndefined();
  });

  it("declines a COVER that is already the full held short position (magnitude comparison)", async () => {
    const { planBrokerMinimumBump } = await import("../src/lib/broker-minimum-guard");
    const plan = planBrokerMinimumBump(baseReview({ estimatedNotional: 0.22 }), "robinhood", {
      quantity: 0.002,
      side: "cover",
      positionQuantity: -0.002
    });
    expect(plan).toBeUndefined();
  });

  it("declines a whole-share order (the dollar floor doesn't apply)", async () => {
    const { planBrokerMinimumBump } = await import("../src/lib/broker-minimum-guard");
    const plan = planBrokerMinimumBump(baseReview({ estimatedNotional: 0.5 }), "robinhood", { quantity: 1, side: "buy" });
    expect(plan).toBeUndefined();
  });

  it("declines when the broker has no known floor", async () => {
    const { planBrokerMinimumBump } = await import("../src/lib/broker-minimum-guard");
    const plan = planBrokerMinimumBump(baseReview(), "alpaca", { dollarAmount: 0.23, side: "buy" });
    expect(plan).toBeUndefined();
  });

  it("declines when the order is already at/above the floor", async () => {
    const { planBrokerMinimumBump } = await import("../src/lib/broker-minimum-guard");
    const plan = planBrokerMinimumBump(baseReview({ estimatedNotional: 1.5 }), "robinhood", { dollarAmount: 1.5, side: "buy" });
    expect(plan).toBeUndefined();
  });
});
