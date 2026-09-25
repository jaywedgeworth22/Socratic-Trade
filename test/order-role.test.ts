/**
 * Unit + DB-backed tests for src/lib/order-role.ts — the classifier that answers the owner
 * report this exists for: four resting Alpaca-paper orders (BAC, BRK-B, KO, PYPL) turned out to
 * be correct, app-placed protective stops, but nothing in the ops snapshot or the console Orders
 * screen said so. One `describe` block per OrderRole plus the DB-backed context builder,
 * `attachOrderRoles`, and `buildOpsWorkingOrderDetails`.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EquityOrder } from "../src/lib/types";

// order-role.ts pulls in ./db (~5k lines) + order-provenance.ts + broker-held-orders.ts +
// broker-side.ts — a multi-second cold import solo, and much slower under full-suite/full-fleet
// CPU contention (mirrors test/chat-orchestrator-search-knowledge.test.ts's own note on this
// exact class of flake). Importing inside a test body charges that one-time cost to the FIRST
// test's default testTimeout; beforeAll gets its own explicit budget instead, so every test body
// below is a synchronous, millisecond-fast call against the already-cached module.
let orderRole: typeof import("../src/lib/order-role");
let db: typeof import("../src/lib/db");

beforeAll(async () => {
  orderRole = await import("../src/lib/order-role");
  db = await import("../src/lib/db");
}, 120_000);

beforeEach(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-order-role-unit-${randomUUID()}.db`)}`;
});

function order(overrides: Partial<EquityOrder> = {}): EquityOrder {
  return {
    id: `ord-${randomUUID()}`,
    symbol: "BAC",
    side: "sell",
    type: "stop_market",
    state: "new",
    quantity: 24,
    filledQuantity: 0,
    createdAt: "2026-09-24T14:00:00.000Z",
    ...overrides
  };
}

const NO_CTX = { appPlaced: false } as const;

// The DB-backed describe blocks below share ONE sqlite connection for the whole file (the
// beforeAll warm-import above deliberately does not vi.resetModules() per test, so the cold
// module-load cost is paid once — see the comment there). broker_protective_stops and
// synthetic_trailing_stops both have a UNIQUE(user_id, account_number, symbol) constraint, so
// reusing "APCA-PAPER" as a hardcoded account number across tests that reuse the same symbol
// (several use "BAC") would make a later test's upsert silently overwrite an earlier test's row
// via ON CONFLICT. A fresh account number per test sidesteps that regardless of run order.
function freshAccountNumber(): string {
  return `APCA-PAPER-${randomUUID()}`;
}

describe("classifyOrderRole — protective_stop", () => {
  it("classifies a broker_protective_stops fixed-kind row and states the stop price", () => {
    const result = orderRole.classifyOrderRole(order({ quantity: 24 }), {
      appPlaced: true,
      protectiveStop: { kind: "fixed", stopPrice: 38.5 }
    });
    expect(result.role).toBe("protective_stop");
    expect(result.whyResting).toBe("Protective stop for 24 BAC at $38.50; rests until price falls to that level.");
  });

  it("falls back to the protstop- client_order_id prefix when no tracked row matches", () => {
    const result = orderRole.classifyOrderRole(order({ clientOrderId: "protstop-local-APCA-BAC-1" }), NO_CTX);
    expect(result.role).toBe("protective_stop");
  });

  it("does not refer to an unknown level when the tracked price is missing", () => {
    const result = orderRole.classifyOrderRole(order({ clientOrderId: "protstop-local-APCA-BAC-1" }), NO_CTX);
    expect(result.role).toBe("protective_stop");
    expect(result.whyResting).toBe("Protective stop for 24 BAC; rests until it fills at the broker.");
    expect(result.whyResting).not.toContain("that level");
  });

  it("a stop protecting a SHORT (exits with buy/cover) rests until price RISES, not falls", () => {
    const result = orderRole.classifyOrderRole(order({ symbol: "KO", side: "buy", quantity: 10 }), {
      appPlaced: true,
      protectiveStop: { kind: "fixed", stopPrice: 60 }
    });
    expect(result.whyResting).toContain("rests until price rises to that level");
  });
});

describe("classifyOrderRole — trailing_stop", () => {
  it("classifies a broker_protective_stops trailing-kind row and states the trail percent", () => {
    const result = orderRole.classifyOrderRole(order({ symbol: "BRK-B", quantity: 5 }), {
      appPlaced: true,
      protectiveStop: { kind: "trailing", trailPercent: 5 }
    });
    expect(result.role).toBe("trailing_stop");
    expect(result.whyResting).toBe("Protective trailing stop for 5 BRK-B; rests until price falls 5%.");
  });

  it("never invents a trail percent that isn't in ctx", () => {
    const result = orderRole.classifyOrderRole(order({ symbol: "PYPL" }), {
      appPlaced: true,
      protectiveStop: { kind: "trailing" }
    });
    expect(result.whyResting).not.toMatch(/%.*%/);
    expect(result.whyResting).toBe("Protective trailing stop for 24 PYPL; rests until price falls.");
  });
});

describe("classifyOrderRole — synthetic_stop", () => {
  it("classifies a synthetic_trailing_stops-triggered exit", () => {
    const result = orderRole.classifyOrderRole(order({ symbol: "T" }), {
      appPlaced: true,
      syntheticStop: { trailPercent: 8 }
    });
    expect(result.role).toBe("synthetic_stop");
    expect(result.whyResting).toContain("App-managed synthetic trailing-stop trigger for 24 T");
  });

  it("falls back to the sstop- client_order_id prefix when no tracked row matches", () => {
    const result = orderRole.classifyOrderRole(order({ clientOrderId: "sstop-abc-123" }), NO_CTX);
    expect(result.role).toBe("synthetic_stop");
  });
});

describe("classifyOrderRole — replacement", () => {
  it("classifies a live order_replacements replacement leg", () => {
    const result = orderRole.classifyOrderRole(order({ symbol: "MSFT" }), {
      appPlaced: true,
      replacement: { status: "replacement_submitted" }
    });
    expect(result.role).toBe("replacement");
    expect(result.whyResting).toContain("Automatic replacement for a stale limit order on 24 MSFT");
  });
});

describe("classifyOrderRole — bracket_take_profit / bracket_stop_loss / entry (bracket)", () => {
  it("classifies the not-yet-filled opening leg of a bracket order as entry", () => {
    const result = orderRole.classifyOrderRole(order({ side: "buy", type: "limit", orderClass: "bracket" }), NO_CTX);
    expect(result.role).toBe("entry");
    expect(result.whyResting).toContain("Entry leg of a bracket order");
  });

  it("classifies a bracket exit limit leg as bracket_take_profit", () => {
    const result = orderRole.classifyOrderRole(order({ side: "sell", type: "limit", orderClass: "bracket" }), NO_CTX);
    expect(result.role).toBe("bracket_take_profit");
  });

  it("classifies a bracket exit stop leg as bracket_stop_loss", () => {
    const result = orderRole.classifyOrderRole(order({ side: "sell", type: "stop_market", orderClass: "bracket" }), NO_CTX);
    expect(result.role).toBe("bracket_stop_loss");
    expect(result.whyResting).toContain("rests until price falls to that level");
  });

  it("an OCO order_class also matches the bracket family", () => {
    const result = orderRole.classifyOrderRole(order({ side: "sell", type: "limit", orderClass: "oco" }), NO_CTX);
    expect(result.role).toBe("bracket_take_profit");
  });

  it("an OCO exit pending cancellation remains an exit even when its sibling is no longer working", () => {
    const result = orderRole.classifyOrderRole(order({ side: "buy", type: "stop_market", orderClass: "oco", state: "pending_cancel" }), {
      appPlaced: true,
      bracketSiblingWorkingCount: 0
    });
    expect(result.role).toBe("bracket_stop_loss");
  });

  // Regression: src/lib/broker-side.ts's toBrokerSide maps a SHORT entry to a raw "sell" and a
  // COVER exit to a raw "buy" -- the exact inverse of a LONG bracket's buy-to-open/sell-to-close.
  // isOpeningSide(order.side) alone therefore gets a SHORT bracket's entry/exit legs backwards;
  // bracketSiblingWorkingCount is the side-agnostic fix (see OrderRoleContext's own doc comment).
  it("a SHORT bracket's still-resting entry (broker-reported side=sell, no working siblings) is still entry, not an exit leg", () => {
    const result = orderRole.classifyOrderRole(order({ side: "sell", type: "market", orderClass: "bracket" }), {
      appPlaced: true,
      bracketSiblingWorkingCount: 0
    });
    expect(result.role).toBe("entry");
  });

  it("a SHORT bracket's cover-side exit legs (broker-reported side=buy, one working sibling each) are exit legs, not entry", () => {
    const takeProfit = orderRole.classifyOrderRole(order({ side: "buy", type: "limit", orderClass: "bracket" }), {
      appPlaced: true,
      bracketSiblingWorkingCount: 1
    });
    expect(takeProfit.role).toBe("bracket_take_profit");
    const stopLoss = orderRole.classifyOrderRole(order({ side: "buy", type: "stop_market", orderClass: "bracket" }), {
      appPlaced: true,
      bracketSiblingWorkingCount: 1
    });
    expect(stopLoss.role).toBe("bracket_stop_loss");
  });

  it("without batch context (bracketSiblingWorkingCount undefined), falls back to isOpeningSide -- correct for LONG, inverted for SHORT (documented limitation)", () => {
    // LONG bracket, no batch context: still correct.
    const longEntry = orderRole.classifyOrderRole(order({ side: "buy", type: "market", orderClass: "bracket" }), NO_CTX);
    expect(longEntry.role).toBe("entry");
    // SHORT bracket, no batch context: the documented fallback limitation -- a still-resting
    // short entry (side=sell) is misread as an exit leg absent sibling-count context.
    const shortEntryNoContext = orderRole.classifyOrderRole(order({ side: "sell", type: "market", orderClass: "bracket" }), NO_CTX);
    expect(shortEntryNoContext.role).toBe("bracket_stop_loss");
  });
});

describe("classifyOrderRole — entry / exit (generic app-tracked)", () => {
  it("an app-placed opening-side order (not bracket, not a tracked stop) is entry", () => {
    const result = orderRole.classifyOrderRole(order({ side: "buy", type: "limit" }), { appPlaced: true });
    expect(result.role).toBe("entry");
    expect(result.whyResting).toBe("Entry order for 24 BAC; rests until it fills at the broker.");
  });

  it("an app-placed closing-side order (not bracket, not a tracked stop) is exit", () => {
    const result = orderRole.classifyOrderRole(order({ side: "sell", type: "limit" }), { appPlaced: true });
    expect(result.role).toBe("exit");
  });

  it("a short's cover reports as a raw buy but is still an opening/closing side per isOpeningSide", () => {
    const coverResult = orderRole.classifyOrderRole(order({ side: "cover", type: "limit" }), { appPlaced: true });
    expect(coverResult.role).toBe("exit");
    const shortResult = orderRole.classifyOrderRole(order({ side: "short", type: "limit" }), { appPlaced: true });
    expect(shortResult.role).toBe("entry");
  });
});

describe("classifyOrderRole — external", () => {
  it("classifies an order with no tracked row and no app-minted prefix as external", () => {
    const result = orderRole.classifyOrderRole(order({ clientOrderId: "6fa459ea-ee8a-3ca4-894e-db77e160355e" }), NO_CTX);
    expect(result.role).toBe("external");
    expect(result.whyResting).toContain("Placed outside the app's own order-tracking");
  });

  it("classifies an order with no client_order_id at all as external", () => {
    const result = orderRole.classifyOrderRole(order({ clientOrderId: undefined }), NO_CTX);
    expect(result.role).toBe("external");
  });
});

describe("ORDER_ROLE_LABELS", () => {
  it("has a Title Case label for every OrderRole", () => {
    expect(orderRole.ORDER_ROLE_LABELS).toEqual({
      protective_stop: "Protective Stop",
      trailing_stop: "Trailing Stop",
      bracket_take_profit: "Take-Profit Leg",
      bracket_stop_loss: "Stop-Loss Leg",
      entry: "Entry",
      exit: "Exit",
      synthetic_stop: "Synthetic Stop",
      replacement: "Replacement",
      external: "External"
    });
  });
});

describe("loadOrderRoleContexts — DB-backed", () => {
  it("matches a broker_protective_stops row by broker_order_id and surfaces kind/stopPrice/trailPercent", () => {
    const accountNumber = freshAccountNumber();
    db.upsertBrokerProtectiveStop({
      id: randomUUID(),
      userId: "local",
      accountNumber,
      symbol: "BAC",
      brokerOrderId: "broker-order-1",
      quantity: 24,
      stopPrice: 38.5,
      status: "resting",
      kind: "fixed"
    });
    const contexts = orderRole.loadOrderRoleContexts([{ id: "broker-order-1", clientOrderId: undefined, symbol: "BAC" }], {
      userId: "local",
      accountNumber
    });
    const ctx = contexts.get("broker-order-1");
    expect(ctx?.protectiveStop).toEqual({ kind: "fixed", stopPrice: 38.5, trailPercent: undefined });
  });

  it("matches a synthetic_trailing_stops row by last_attempt_ref_id", () => {
    const accountNumber = freshAccountNumber();
    db.upsertSyntheticStop({
      id: randomUUID(),
      userId: "local",
      accountNumber,
      symbol: "T",
      side: "long",
      quantity: 10,
      entryPrice: 20,
      extremePrice: 22,
      trailPercent: 8,
      status: "triggered",
      lastAttemptRefId: "sstop-abc-123"
    });
    const contexts = orderRole.loadOrderRoleContexts([{ id: "order-2", clientOrderId: "sstop-abc-123", symbol: "T" }], {
      userId: "local",
      accountNumber
    });
    const ctx = contexts.get("order-2");
    expect(ctx?.syntheticStop).toEqual({ trailPercent: 8 });
  });

  it("matches an order_replacements row by replacement_order_id, only when status is submitted/confirmed", () => {
    const accountNumber = freshAccountNumber();
    const now = new Date().toISOString();
    db.getDb()
      .prepare(
        `INSERT INTO order_replacements (id, user_id, account_number, original_order_id, replacement_ref_id, status, replacement_order_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), "local", accountNumber, "stale-order-1", "repl-ref-1", "replacement_submitted", "new-order-1", now, now);
    const contexts = orderRole.loadOrderRoleContexts([{ id: "new-order-1", clientOrderId: undefined, symbol: "MSFT" }], {
      userId: "local",
      accountNumber
    });
    expect(contexts.get("new-order-1")?.replacement).toEqual({ status: "replacement_submitted" });
  });

  it("does NOT surface a cancel_requested (not-yet-submitted) replacement row", () => {
    const accountNumber = freshAccountNumber();
    const now = new Date().toISOString();
    db.getDb()
      .prepare(
        `INSERT INTO order_replacements (id, user_id, account_number, original_order_id, replacement_ref_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), "local", accountNumber, "stale-order-2", "repl-ref-2", "cancel_requested", now, now);
    const contexts = orderRole.loadOrderRoleContexts([{ id: "stale-order-2", clientOrderId: "repl-ref-2", symbol: "MSFT" }], {
      userId: "local",
      accountNumber
    });
    expect(contexts.get("stale-order-2")?.replacement).toBeUndefined();
  });

  it("returns an empty map when accountNumber is empty, without querying the DB", () => {
    const contexts = orderRole.loadOrderRoleContexts([{ id: "x", clientOrderId: undefined, symbol: "X" }], {
      userId: "local",
      accountNumber: ""
    });
    expect(contexts.size).toBe(0);
  });
});

describe("attachOrderRoles", () => {
  it("attaches role/whyResting only to working orders, leaving terminal orders untouched", () => {
    const accountNumber = freshAccountNumber();
    db.upsertBrokerProtectiveStop({
      id: randomUUID(),
      userId: "local",
      accountNumber,
      symbol: "BAC",
      brokerOrderId: "working-1",
      quantity: 24,
      stopPrice: 38.5,
      status: "resting",
      kind: "fixed"
    });
    const working = order({ id: "working-1", state: "new" });
    const filled = order({ id: "filled-1", state: "filled" });
    const result = orderRole.attachOrderRoles([working, filled], "local", accountNumber);
    expect(result.find((o) => o.id === "working-1")?.role).toBe("protective_stop");
    expect(result.find((o) => o.id === "working-1")?.whyResting).toBeDefined();
    expect(result.find((o) => o.id === "filled-1")?.role).toBeUndefined();
    expect(result.find((o) => o.id === "filled-1")?.whyResting).toBeUndefined();
  });

  it("end to end: a real SHORT bracket's 2 working exit legs (post-fill OCO pair) classify correctly from the batch alone", () => {
    // No broker_protective_stops / synthetic_trailing_stops / order_replacements rows and no
    // app-minted client_order_id prefix -- purely proving the bracketSiblingWorkingCount signal
    // loadOrderRoleContexts derives from the batch itself, the same shape attachOrderRoles
    // receives in production from gateway.getEquityOrders().
    const accountNumber = freshAccountNumber();
    const takeProfitLeg = order({
      id: "short-tp-1",
      symbol: "KO",
      side: "buy", // covers the short -- toBrokerSide maps cover -> buy
      type: "limit",
      orderClass: "bracket",
      state: "new"
    });
    const stopLossLeg = order({
      id: "short-sl-1",
      symbol: "KO",
      side: "buy",
      type: "stop_market",
      orderClass: "bracket",
      state: "new"
    });
    const result = orderRole.attachOrderRoles([takeProfitLeg, stopLossLeg], "local", accountNumber);
    expect(result.find((o) => o.id === "short-tp-1")?.role).toBe("bracket_take_profit");
    expect(result.find((o) => o.id === "short-sl-1")?.role).toBe("bracket_stop_loss");
  });

  it("a lone pending_cancel OCO leg remains a stop-loss exit in the Orders batch", () => {
    const accountNumber = freshAccountNumber();
    const remainingExit = order({
      id: "oco-pending-cancel",
      side: "buy", // covers a short, so raw broker side alone suggests entry
      type: "stop_market",
      orderClass: "oco",
      state: "pending_cancel"
    });
    const result = orderRole.attachOrderRoles([remainingExit], "local", accountNumber);
    expect(result[0]?.role).toBe("bracket_stop_loss");
  });

  it("end to end: a real SHORT bracket's still-resting entry (lone working bracket order for the symbol) classifies as entry", () => {
    const accountNumber = freshAccountNumber();
    const shortEntry = order({
      id: "short-entry-1",
      symbol: "PYPL",
      side: "sell", // opens the short -- toBrokerSide maps short -> sell
      type: "market",
      orderClass: "bracket",
      state: "new"
    });
    const result = orderRole.attachOrderRoles([shortEntry], "local", accountNumber);
    expect(result.find((o) => o.id === "short-entry-1")?.role).toBe("entry");
  });

  it("returns the orders unchanged when accountNumber is empty", () => {
    const working = order({ state: "new" });
    const result = orderRole.attachOrderRoles([working], "local", "");
    expect(result[0]).toBe(working);
  });

  it("returns the orders unchanged when there are no working orders", () => {
    const filled = order({ state: "filled" });
    const result = orderRole.attachOrderRoles([filled], "local", freshAccountNumber());
    expect(result[0]).toBe(filled);
  });
});

describe("buildOpsWorkingOrderDetails", () => {
  it("maps a working order to the compact ops-snapshot shape, excluding id/clientOrderId/account", () => {
    const accountNumber = freshAccountNumber();
    db.upsertBrokerProtectiveStop({
      id: randomUUID(),
      userId: "local",
      accountNumber,
      symbol: "BAC",
      brokerOrderId: "ord-detail-1",
      quantity: 24,
      stopPrice: 38.5,
      status: "resting",
      kind: "trailing",
      trailPercent: 5
    });
    const o = order({ id: "ord-detail-1", clientOrderId: "protstop-local-1", state: "new" });
    const details = orderRole.buildOpsWorkingOrderDetails([o], "local", accountNumber);
    expect(details).toHaveLength(1);
    expect(details[0]).toEqual({
      symbol: "BAC",
      side: "sell",
      type: "stop_market",
      orderClass: null,
      quantity: 24,
      filledQuantity: 0,
      limitPrice: null,
      stopPrice: null,
      trailPercent: 5,
      timeInForce: null,
      state: "new",
      createdAt: "2026-09-24T14:00:00.000Z",
      updatedAt: null,
      role: "trailing_stop",
      whyResting: "Protective trailing stop for 24 BAC; rests until price falls 5%."
    });
    expect(details[0]).not.toHaveProperty("id");
    expect(details[0]).not.toHaveProperty("clientOrderId");
    expect(details[0]).not.toHaveProperty("accountNumber");
  });

  it("drops terminal orders and caps at OPS_ORDERS_DETAIL_MAX_PER_ACCOUNT", () => {
    const working = Array.from({ length: orderRole.OPS_ORDERS_DETAIL_MAX_PER_ACCOUNT + 10 }, (_, i) =>
      order({ id: `working-${i}`, symbol: `SYM${i}`, state: "new" })
    );
    const terminal = order({ id: "done-1", state: "filled" });
    const details = orderRole.buildOpsWorkingOrderDetails([...working, terminal], "local", freshAccountNumber());
    expect(details).toHaveLength(orderRole.OPS_ORDERS_DETAIL_MAX_PER_ACCOUNT);
    expect(details.every((d) => d.symbol.startsWith("SYM"))).toBe(true);
  });

  it("returns [] when accountNumber is empty", () => {
    const details = orderRole.buildOpsWorkingOrderDetails([order({ state: "new" })], "local", "");
    expect(details).toEqual([]);
  });
});
