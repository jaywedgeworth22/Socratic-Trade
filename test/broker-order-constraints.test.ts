/**
 * Per-broker order-shape constraint tables (oss-lessons §7 slice 2) — a unit test per
 * constraint, plus the choke-point wrapper. Mirrors the slice-1 conformance discipline:
 * fixtures are enumerated per table row and a coverage test fails when a row is added
 * without fixtures (or fixtures name a row that no longer exists).
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyOrderConstraints,
  BROKER_ORDER_CONSTRAINTS,
  OrderConstraintBlockedError,
  toConstraintBrokerId,
  type ConstraintBrokerId
} from "../src/lib/broker-order-constraints";
import { OrderValidationError, type EquityOrderInput, type TradingPolicy } from "../src/lib/types";
import { DEFAULT_POLICY } from "../src/lib/defaults";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-ordconstraints-${randomUUID()}.db`)}`;
});

function order(patch: Partial<EquityOrderInput> = {}): EquityOrderInput {
  return {
    accountNumber: "A1",
    symbol: "T",
    side: "buy",
    type: "limit",
    quantity: 10,
    limitPrice: 27.5,
    timeInForce: "gfd",
    marketHours: "regular_hours",
    ...patch
  };
}

/** One violating and one table-clean passing fixture per constraint row. */
const FIXTURES: Record<string, { violating: EquityOrderInput; passing: EquityOrderInput }> = {
  "alpaca:alpaca-bracket-legs-entry-only": {
    violating: order({ side: "sell", bracketTakeProfit: 30, bracketStopLoss: 25 }),
    passing: order({ side: "buy", bracketTakeProfit: 30, bracketStopLoss: 25 })
  },
  "alpaca:alpaca-trailing-excludes-brackets": {
    violating: order({ type: "stop_market", limitPrice: undefined, trailPercent: 5, bracketStopLoss: 25 }),
    passing: order({ type: "stop_market", limitPrice: undefined, trailPercent: 5 })
  },
  "alpaca:alpaca-trailing-requires-share-quantity": {
    violating: order({ type: "stop_market", limitPrice: undefined, trailPercent: 5, quantity: undefined, dollarAmount: 500 }),
    passing: order({ type: "stop_market", limitPrice: undefined, trailPercent: 5, quantity: 3 })
  },
  "alpaca:alpaca-stop-price-only-on-stop-orders": {
    violating: order({ type: "limit", stopPrice: 24 }),
    passing: order({ type: "stop_limit", stopPrice: 24 })
  },
  "alpaca:alpaca-limit-price-only-on-limit-orders": {
    violating: order({ side: "cover", type: "market", limitPrice: 150.1 }),
    passing: order({ type: "stop_limit", stopPrice: 24 })
  },
  "alpaca:alpaca-extended-hours-exit-requeue": {
    violating: order({ side: "sell", type: "market", limitPrice: undefined, marketHours: "extended_hours" }),
    passing: order({ side: "sell", type: "limit", marketHours: "extended_hours" })
  },
  "alpaca:alpaca-extended-hours-limit-only": {
    violating: order({ side: "buy", type: "market", limitPrice: undefined, marketHours: "extended_hours" }),
    passing: order({ side: "buy", type: "limit", marketHours: "extended_hours" })
  },
  "robinhood:robinhood-no-short-selling": {
    violating: order({ side: "short" }),
    passing: order({ side: "sell" })
  },
  "robinhood:robinhood-no-native-trailing": {
    violating: order({ type: "stop_market", limitPrice: undefined, trailPercent: 4 }),
    passing: order({ type: "stop_market", limitPrice: undefined, stopPrice: 24 })
  },
  "robinhood:robinhood-no-bracket-legs": {
    violating: order({ bracketTakeProfit: 30 }),
    passing: order()
  },
  "tradier:tradier-no-native-trailing": {
    violating: order({ type: "stop_market", limitPrice: undefined, trailPercent: 4 }),
    passing: order({ type: "stop_market", limitPrice: undefined, stopPrice: 24 })
  },
  "tradier:tradier-bracket-legs-require-limitable-entry": {
    violating: order({ type: "market", limitPrice: undefined, bracketStopLoss: 25 }),
    passing: order({ type: "limit", bracketStopLoss: 25 })
  },
  "tradier:tradier-limit-price-only-on-limit-orders": {
    violating: order({ side: "cover", type: "stop_market", stopPrice: 155, limitPrice: 150 }),
    passing: order({ side: "sell", type: "stop_market", limitPrice: undefined, stopPrice: 140 })
  }
};

const ALL_ROWS = (Object.keys(BROKER_ORDER_CONSTRAINTS) as ConstraintBrokerId[]).flatMap((broker) =>
  BROKER_ORDER_CONSTRAINTS[broker].map((row) => ({ broker, row, key: `${broker}:${row.id}` }))
);

describe("broker-order-constraints — table integrity", () => {
  it("every constraint row has fixtures, and every fixture names a real row", () => {
    const rowKeys = ALL_ROWS.map((entry) => entry.key).sort();
    expect(Object.keys(FIXTURES).sort()).toEqual(rowKeys);
  });

  it("every row carries a receipt note, and block rows carry a message", () => {
    for (const { key, row } of ALL_ROWS) {
      expect(row.note.length, key).toBeGreaterThan(20);
      if (row.remedy === "block") expect(typeof row.message, key).toBe("function");
      if (row.remedy === "reshape") expect(typeof row.reshape, key).toBe("function");
    }
  });

  it("the test broker is deliberately constraint-free", () => {
    expect(BROKER_ORDER_CONSTRAINTS.test).toEqual([]);
  });

  it("toConstraintBrokerId folds alpaca-mcp into alpaca and fails null on unknowns", () => {
    expect(toConstraintBrokerId("alpaca")).toBe("alpaca");
    expect(toConstraintBrokerId("alpaca-mcp")).toBe("alpaca");
    expect(toConstraintBrokerId("robinhood")).toBe("robinhood");
    expect(toConstraintBrokerId("tradier")).toBe("tradier");
    expect(toConstraintBrokerId("test")).toBe("test");
    expect(toConstraintBrokerId("etrade")).toBeNull();
    expect(toConstraintBrokerId(undefined)).toBeNull();
  });
});

describe("broker-order-constraints — per-constraint behavior", () => {
  for (const { broker, row, key } of ALL_ROWS) {
    const fixtures = FIXTURES[key];
    if (!fixtures) continue; // the integrity test above already failed loudly

    it(`${key} — violating fixture ${row.remedy === "block" ? "blocks" : "reshapes"}`, () => {
      if (row.remedy === "block") {
        // OrderConstraintBlockedError extends OrderValidationError, so lanes classify it
        // "blocked"; the subclass carries the row identity for the choke-point audit.
        try {
          applyOrderConstraints(broker, fixtures.violating);
          expect.fail(`${key}: expected a block`);
        } catch (error) {
          expect(error, key).toBeInstanceOf(OrderValidationError);
          expect(error, key).toBeInstanceOf(OrderConstraintBlockedError);
          expect((error as OrderConstraintBlockedError).constraintId, key).toBe(row.id);
        }
        return;
      }
      const { input: reshaped, reshaped: receipts } = applyOrderConstraints(broker, fixtures.violating);
      const receipt = receipts.find((entry) => entry.constraintId === row.id);
      expect(receipt, key).toBeDefined();
      expect(receipt!.changedFields.length, key).toBeGreaterThan(0);
      expect(row.violates(reshaped), `${key}: reshape must satisfy its own constraint`).toBe(false);
    });

    it(`${key} — passing fixture is untouched`, () => {
      const before = structuredClone(fixtures.passing);
      const { input: after, reshaped: receipts } = applyOrderConstraints(broker, fixtures.passing);
      expect(after).toEqual(before);
      expect(receipts).toEqual([]);
    });

    it(`${key} — never mutates the caller's input`, () => {
      const original = structuredClone(fixtures.violating);
      try {
        applyOrderConstraints(broker, fixtures.violating);
      } catch {
        // block rows throw — mutation check still applies
      }
      expect(fixtures.violating).toEqual(original);
    });
  }
});

describe("broker-order-constraints — the 2026-07-27 T regression (Alpaca sell + bracket 422)", () => {
  it("strips bracket legs from a SELL so the exit still places", () => {
    const sell = order({ side: "sell", type: "market", limitPrice: undefined, bracketTakeProfit: 30, bracketStopLoss: 25, bracketStopLimit: 24.9 });
    const { input: reshaped, reshaped: receipts } = applyOrderConstraints("alpaca", sell);
    expect(reshaped.bracketTakeProfit).toBeUndefined();
    expect(reshaped.bracketStopLoss).toBeUndefined();
    expect(reshaped.bracketStopLimit).toBeUndefined();
    expect(reshaped.side).toBe("sell");
    expect(reshaped.type).toBe("market");
    expect(reshaped.quantity).toBe(sell.quantity);
    expect(receipts.map((entry) => entry.constraintId)).toContain("alpaca-bracket-legs-entry-only");
  });

  it("strips bracket legs from a COVER (also an exit)", () => {
    const cover = order({ side: "cover", bracketStopLoss: 25 });
    const { input: reshaped } = applyOrderConstraints("alpaca", cover);
    expect(reshaped.bracketStopLoss).toBeUndefined();
  });

  it("leaves bracket legs on entries (buy AND short) untouched", () => {
    for (const side of ["buy", "short"] as const) {
      const entry = order({ side, bracketTakeProfit: 30, bracketStopLoss: 25 });
      const { input: reshaped, reshaped: receipts } = applyOrderConstraints("alpaca", entry);
      expect(reshaped.bracketTakeProfit, side).toBe(30);
      expect(reshaped.bracketStopLoss, side).toBe(25);
      expect(receipts.find((r) => r.constraintId === "alpaca-bracket-legs-entry-only"), side).toBeUndefined();
    }
  });

  it("re-queues a non-limit EXTENDED-HOURS exit to regular hours instead of blocking it (review finding)", () => {
    const exit = order({ side: "sell", type: "market", limitPrice: undefined, marketHours: "extended_hours" });
    const { input: reshaped, reshaped: receipts } = applyOrderConstraints("alpaca", exit);
    expect(reshaped.marketHours).toBe("regular_hours");
    expect(reshaped.side).toBe("sell");
    expect(receipts.map((entry) => entry.constraintId)).toContain("alpaca-extended-hours-exit-requeue");
  });

  it("still blocks a non-limit extended-hours ENTRY (both buy and short)", () => {
    for (const side of ["buy", "short"] as const) {
      expect(
        () => applyOrderConstraints("alpaca", order({ side, type: "market", limitPrice: undefined, marketHours: "extended_hours" })),
        side
      ).toThrowError(OrderValidationError);
    }
  });

  it("chains reshapes: an exit wearing brackets AND a stray stopPrice sheds both, two receipts", () => {
    const messy = order({ side: "sell", type: "limit", stopPrice: 24, bracketTakeProfit: 30 });
    const { input: reshaped, reshaped: receipts } = applyOrderConstraints("alpaca", messy);
    expect(reshaped.bracketTakeProfit).toBeUndefined();
    expect(reshaped.stopPrice).toBeUndefined();
    expect(reshaped.limitPrice).toBe(messy.limitPrice);
    expect(receipts.map((entry) => entry.constraintId).sort()).toEqual([
      "alpaca-bracket-legs-entry-only",
      "alpaca-stop-price-only-on-stop-orders"
    ]);
  });
});

describe("withOrderConstraints — placement choke point", () => {
  function policy(patch: Partial<TradingPolicy> = {}): TradingPolicy {
    return { ...DEFAULT_POLICY, activeBroker: "alpaca", accountNumber: "A1", connectedAccountId: "acct-1", ...patch };
  }

  function stubGateway() {
    const seen: Array<EquityOrderInput & { refId: string }> = [];
    const cancels: string[] = [];
    const gateway = {
      placeEquityOrder: async (input: EquityOrderInput & { refId: string }) => {
        seen.push(input);
        return { orderId: "o1", state: "queued", raw: {} };
      },
      cancelEquityOrder: async (_account: string, orderId: string) => {
        cancels.push(orderId);
        return { orderId, state: "cancelled", raw: {} };
      }
    };
    return { seen, cancels, gateway };
  }

  it("reshapes before the adapter sees the order, preserves refId, and audits a receipt", async () => {
    const { withOrderConstraints } = await import("../src/lib/broker");
    const db = await import("../src/lib/db");
    const { seen, gateway } = stubGateway();
    const wrapped = withOrderConstraints(gateway as never, policy(), "local");
    const refId = randomUUID();
    await wrapped.placeEquityOrder({ ...order({ side: "sell", bracketStopLoss: 25 }), refId });
    expect(seen).toHaveLength(1);
    expect(seen[0].bracketStopLoss).toBeUndefined();
    expect(seen[0].refId).toBe(refId);
    const receipt = db
      .getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = 'order_constraint_reshaped'")
      .all()
      .map((row) => JSON.parse((row as { payload: string }).payload))
      .find((payload) => payload.refId === refId);
    expect(receipt).toBeDefined();
    expect(receipt.constraintId).toBe("alpaca-bracket-legs-entry-only");
    expect(receipt.changedFields).toEqual(["bracketStopLoss"]);
  });

  it("blocks a Robinhood short with OrderValidationError before anything reaches the adapter", async () => {
    const { withOrderConstraints } = await import("../src/lib/broker");
    const { seen, gateway } = stubGateway();
    const wrapped = withOrderConstraints(gateway as never, policy({ activeBroker: "robinhood" }), "local");
    await expect(
      wrapped.placeEquityOrder({ ...order({ side: "short" }), refId: randomUUID() })
    ).rejects.toBeInstanceOf(OrderValidationError);
    expect(seen).toHaveLength(0);
  });

  it("audits order_constraint_blocked with the row identity when a block fires", async () => {
    const { withOrderConstraints } = await import("../src/lib/broker");
    const db = await import("../src/lib/db");
    const { seen, gateway } = stubGateway();
    const wrapped = withOrderConstraints(gateway as never, policy(), "local");
    const refId = randomUUID();
    await expect(
      wrapped.placeEquityOrder({ ...order({ side: "buy", type: "market", limitPrice: undefined, marketHours: "extended_hours" }), refId })
    ).rejects.toBeInstanceOf(OrderConstraintBlockedError);
    expect(seen).toHaveLength(0);
    const receipt = db
      .getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = 'order_constraint_blocked'")
      .all()
      .map((row) => JSON.parse((row as { payload: string }).payload))
      .find((payload) => payload.refId === refId);
    expect(receipt).toBeDefined();
    expect(receipt.constraintId).toBe("alpaca-extended-hours-limit-only");
    expect(receipt.reason).toContain("extended-hours");
  });

  it("test broker passes any shape through untouched", async () => {
    const { withOrderConstraints } = await import("../src/lib/broker");
    const { seen, gateway } = stubGateway();
    const wrapped = withOrderConstraints(gateway as never, policy({ activeBroker: "test" }), "local");
    const wild = { ...order({ side: "sell", trailPercent: 9, bracketTakeProfit: 30 }), refId: randomUUID() };
    await wrapped.placeEquityOrder(wild);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(wild);
  });

  it("does not intercept cancels (risk-reducing paths stay unguarded)", async () => {
    const { withOrderConstraints } = await import("../src/lib/broker");
    const { cancels, gateway } = stubGateway();
    const wrapped = withOrderConstraints(gateway as never, policy(), "local");
    await wrapped.cancelEquityOrder!("A1", "o9");
    expect(cancels).toEqual(["o9"]);
  });
});
