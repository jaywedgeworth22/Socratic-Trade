// /api/ops/fill-reconcile — token-gated, idempotent backfill for one connected account (board
// 687a5fb4 lane G1).  Tradier REST is stubbed through global.fetch; per-run temp SQLite DB.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const TOKEN = "test-ops-token-fill-reconcile";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-ops-fill-reconcile-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function opsRequest(path: string, method: "GET" | "POST" = "GET", token: string | null = TOKEN): Request {
  return new Request(`http://localhost${path}`, { method, headers: token ? { "x-ops-token": token } : {} });
}

describe("/api/ops/fill-reconcile", () => {
  it(
    "rejects a request without the ops token and requires an account",
    async () => {
      process.env.OPS_DIAGNOSTIC_TOKEN = TOKEN;
      const { GET, POST } = await import("../app/api/ops/fill-reconcile/route");
      expect((await POST(opsRequest("/api/ops/fill-reconcile?account=x", "POST", null))).status).toBe(401);
      expect((await GET(opsRequest("/api/ops/fill-reconcile"))).status).toBe(400);
      expect((await GET(opsRequest(`/api/ops/fill-reconcile?account=${randomUUID()}`))).status).toBe(404);
    },
    // First import of the route pulls the whole broker + strategy module graph (cold transform).
    300_000
  );

  it(
    "previews counts on GET, then converges a stuck Tradier proposal on POST, idempotently",
    async () => {
      process.env.OPS_DIAGNOSTIC_TOKEN = TOKEN;
      const db = await import("../src/lib/db");
      const { resetFillReconciliationStateForTests } = await import("../src/lib/fill-reconciliation");
      resetFillReconciliationStateForTests();
      const userId = `ops-fill-${randomUUID()}`;
      const accountId = `trd-${randomUUID()}`;
      const accountNumber = `VA${Math.floor(Math.random() * 1e8)}`;
      db.upsertConnectedAccount({
        id: accountId,
        userId,
        broker: "tradier",
        environment: "paper",
        accountNumber,
        label: "Tradier Sandbox",
        apiKey: "tok-sandbox-ops",
        apiSecret: undefined,
        isActive: true
      });
      const proposalId = randomUUID();
      const proposal = {
        symbol: "SHEL", side: "buy", type: "limit", quantity: 156, limitPrice: 64.2, timeInForce: "gfd", marketHours: "regular_hours",
        rationale: "Energy relative strength.", tradeThesisTag: "Sector-Relative-Strength", entryMarketRegime: "Neutral"
      };
      db.insertProposal({ userId, id: proposalId, runId: randomUUID(), accountNumber, proposal, decision: { allowed: true, reasons: [] }, orderId: "36120300", status: "placed", executionMode: "broker/paper" });
      db.insertFillEvent({
        userId, proposalId, accountNumber, source: "paper", executionMode: "broker/paper", symbol: "SHEL", side: "buy",
        quantity: 156, price: 0, notional: 0, status: "pending_reconciliation", brokerOrderId: "36120300",
        filledAt: "2026-08-05T14:10:00.000Z", raw: { proposal }
      });

      const calls: string[] = [];
      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        const u = String(url);
        calls.push(u);
        if (u.includes(`/accounts/${accountNumber}/orders/36120300`)) {
          return new Response(JSON.stringify({ order: {
            id: 36120300, type: "limit", symbol: "SHEL", side: "buy", quantity: 156, status: "filled", price: 64.2,
            avg_fill_price: 64.11, exec_quantity: 156, create_date: "2026-08-05T14:10:00.000Z", transaction_date: "2026-08-05T14:10:04.000Z", class: "equity"
          } }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (u.includes(`/accounts/${accountNumber}/orders`)) {
          return new Response(JSON.stringify({ orders: "null" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("", { status: 404 });
      });

      const { GET, POST } = await import("../app/api/ops/fill-reconcile/route");
      const preview = await (await GET(opsRequest(`/api/ops/fill-reconcile?account=${accountId}`))).json();
      expect(preview).toMatchObject({ ok: true, dryRun: true, broker: "tradier", supportsOrderLookup: true, before: { placedProposals: 1, pendingReceipts: 1 } });
      expect(calls).toHaveLength(0); // GET never calls the broker
      expect(JSON.stringify(preview)).not.toContain(accountNumber);

      const run = await (await POST(opsRequest(`/api/ops/fill-reconcile?account=${accountId}&budget=5`, "POST"))).json();
      expect(run).toMatchObject({ ok: true, dryRun: false, lookupBudget: 5, after: { placedProposals: 0, pendingReceipts: 0, filledReceipts: 1 } });
      expect(db.getProposal(proposalId, userId)?.status).toBe("filled");

      const again = await (await POST(opsRequest(`/api/ops/fill-reconcile?account=${accountId}`, "POST"))).json();
      expect(again.after).toMatchObject({ filledReceipts: 1, brokerOriginatedFills: 0 });
      expect(db.listFillEvents(accountNumber, "paper", undefined, userId)).toHaveLength(1);
    },
    120_000
  );
});
