// Regression: post-cancel bookkeeping must survive the #3383 busy_timeout drop.
//
// #3383 lowered the serving `busy_timeout` from 60000ms to SQLITE_BUSY_PIN_MS (100ms) so a
// contended writer can no longer sleep the Node event loop.  The cost is that a write which used
// to WAIT now THROWS.  In `cancelBrokerProtectiveStop` the post-cancel `deleteBrokerProtectiveStop`
// sat inside the same try as the broker call, so a SQLITE_BUSY there was caught by the broker's
// catch: it audited a SUCCESSFUL cancel as `broker_protective_stop_cancel_error` and re-persisted
// the row as `pending_cancel` for an order that no longer exists at the broker.  The next tick can
// only resolve that row by 404ing its cancel.  Same class as #3386.
//
// This file is separate from broker-protective-stops.test.ts because the `vi.mock` below is
// hoisted file-wide and must not perturb the other cases in that suite.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerGateway, EquityOrder } from "../src/lib/types";

const state = vi.hoisted(() => ({
  /** Number of consecutive SQLITE_BUSY throws the next delete should raise before succeeding. */
  deleteBusyThrows: 0,
  /** When set, the delete throws this non-retryable sqlite code instead (fails immediately). */
  deleteHardFailCode: null as string | null,
  /** Every audit event name the module emitted during a case. */
  auditEvents: [] as string[]
}));

vi.mock("../src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db")>();
  return {
    ...actual,
    audit: (event: string, ...rest: unknown[]) => {
      state.auditEvents.push(event);
      return (actual.audit as unknown as (...a: unknown[]) => unknown)(event, ...rest);
    },
    deleteBrokerProtectiveStop: (id: string, userId: string) => {
      if (state.deleteHardFailCode) {
        const err = new Error("disk I/O error") as Error & { code?: string };
        err.code = state.deleteHardFailCode;
        throw err;
      }
      if (state.deleteBusyThrows > 0) {
        state.deleteBusyThrows -= 1;
        const err = new Error("database is locked") as Error & { code?: string };
        err.code = "SQLITE_BUSY";
        throw err;
      }
      return actual.deleteBrokerProtectiveStop(id, userId);
    }
  };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-protstops-busy-${randomUUID()}.db`)}`;
});

function cancellingGateway(): BrokerGateway & { cancelled: string[] } {
  const g = {
    cancelled: [] as string[],
    async cancelEquityOrder(_accountNumber: string, orderId: string) {
      g.cancelled.push(orderId);
      return { orderId, refId: "x", state: "cancel_requested", raw: {} };
    },
    async getEquityOrders(): Promise<EquityOrder[]> {
      return [];
    }
  };
  return g as unknown as BrokerGateway & { cancelled: string[] };
}

describe("cancelBrokerProtectiveStop — SQLITE_BUSY on post-cancel bookkeeping (#3383 pin, #3386 class)", () => {
  beforeEach(() => {
    state.deleteBusyThrows = 0;
    state.deleteHardFailCode = null;
    state.auditEvents = [];
  });

  it("retries a transient SQLITE_BUSY delete instead of re-persisting pending_cancel for an order it DID cancel", async () => {
    const { cancelBrokerProtectiveStop } = await import("../src/lib/broker-protective-stops");
    const { upsertBrokerProtectiveStop, listBrokerProtectiveStops } = await import("../src/lib/db");
    const gw = cancellingGateway();

    upsertBrokerProtectiveStop({
      id: "protstop-local-PS-BUSY-AAPL",
      userId: "local",
      accountNumber: "PS-BUSY",
      symbol: "AAPL",
      brokerOrderId: "ord-busy-1",
      quantity: 10,
      stopPrice: 92,
      status: "resting",
      kind: "fixed"
    });

    // The first two delete attempts hit a contended write; sqliteYieldRetry must ride them out.
    state.deleteBusyThrows = 2;
    await cancelBrokerProtectiveStop("local", "PS-BUSY", "AAPL", gw);

    // The broker cancel really happened...
    expect(gw.cancelled).toEqual(["ord-busy-1"]);
    // ...and the tracking row is GONE, not resurrected as pending_cancel.
    expect(listBrokerProtectiveStops("PS-BUSY", "local")).toHaveLength(0);
    // A successful cancel must never be recorded as a broker cancel failure.
    expect(state.auditEvents).not.toContain("broker_protective_stop_cancel_error");
  });

  it("does not mislabel a failed bookkeeping write as a broker cancel failure", async () => {
    const { cancelBrokerProtectiveStop } = await import("../src/lib/broker-protective-stops");
    const { upsertBrokerProtectiveStop, listBrokerProtectiveStops } = await import("../src/lib/db");
    const gw = cancellingGateway();

    upsertBrokerProtectiveStop({
      id: "protstop-local-PS-BUSY2-AAPL",
      userId: "local",
      accountNumber: "PS-BUSY2",
      symbol: "AAPL",
      brokerOrderId: "ord-busy-2",
      quantity: 10,
      stopPrice: 92,
      status: "resting",
      kind: "fixed"
    });

    // A stamped non-BUSY sqlite code is not retryable, so sqliteYieldRetry rethrows at once — the
    // same end state as an exhausted 60s budget, without spending 60s of real time in the test.
    state.deleteHardFailCode = "SQLITE_IOERR";
    await cancelBrokerProtectiveStop("local", "PS-BUSY2", "AAPL", gw);

    expect(gw.cancelled).toEqual(["ord-busy-2"]);
    // The failure is reported as what it is — a bookkeeping write failure, not a cancel failure.
    expect(state.auditEvents).toContain("broker_protective_stop_bookkeeping_error");
    expect(state.auditEvents).not.toContain("broker_protective_stop_cancel_error");
    // The row is left exactly as it was for the reconcile loop, which already handles a tracked
    // order that is gone at the broker.  It must NOT be flipped to pending_cancel, which would make
    // the next tick retry a cancel against an order that is already cancelled.
    const rows = listBrokerProtectiveStops("PS-BUSY2", "local");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("resting");
  });
});
