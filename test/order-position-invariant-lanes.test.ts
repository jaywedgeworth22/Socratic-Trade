/**
 * PR #3759 review round (2026-09-25): a transient placement-time position-read failure must not
 * kill an exit as terminal "blocked".
 *
 *  - Approval lane: executeProposal read the account's positions seconds earlier (same call, under
 *    the strategy lock) and now passes that read as the caller-verified hint, so the choke point's
 *    fresh read can fail without refusing an owner-approved exit.
 *  - Both lanes: a `position_unverified` refusal (nothing reached the broker, transient cause) is
 *    booked retryable "not_placed", never "blocked".
 *
 * The approval tests drive the REAL executeProposal and the REAL withPositionInvariant wrapper over
 * a mocked adapter.  The autopilot test drives runStrategyOnce over the deterministic test broker
 * (fixture shape from test/account-mutation-pr2-strategy-loop.test.ts).
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { BrokerGateway, EquityOrderInput, EquityPosition, TradingPolicy } from "../src/lib/types";

const gatewayFactory = vi.hoisted(() => ({
  current: undefined as undefined | ((policy: TradingPolicy, userId: string) => BrokerGateway)
}));

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  storeContext: async () => {},
  storeContexts: async () => {}
}));

// Keep the approval lane off live Nasdaq/Yahoo (same stub as test/broker-minimum-bump-execute.test.ts).
vi.mock("../src/lib/approval-quote-scan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/approval-quote-scan")>();
  return {
    ...actual,
    loadApprovalQuoteScan: async () =>
      actual.buildApprovalQuoteScan(
        { AAPL: { symbol: "AAPL", price: 200, bid: 199, ask: 200, provider: "test-scan" } },
        []
      )
  };
});

vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  return {
    ...actual,
    getBrokerGateway: (policy: TradingPolicy, userId: string = "local") => {
      if (!gatewayFactory.current) throw new Error("test gateway factory not set");
      return gatewayFactory.current(policy, userId);
    }
  };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-position-invariant-lanes-${randomUUID()}.db`)}`;
});

afterEach(() => {
  gatewayFactory.current = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const APPROVAL_ACCOUNT = "TEST";

function approvalAdapter(positions: EquityPosition[], place: (input: EquityOrderInput & { refId: string }) => Promise<unknown>) {
  return {
    getAccounts: async () => [{ accountNumber: APPROVAL_ACCOUNT, type: "brokerage" }],
    getPortfolio: async () => ({
      accountNumber: APPROVAL_ACCOUNT,
      totalMarketValue: 10_000,
      buyingPower: 8_000,
      equityMarketValue: 2_000,
      optionMarketValue: 0,
      cash: 8_000
    }),
    getEquityPositions: async () => positions,
    getEquityOrders: async () => [],
    getEquityQuotes: async () => ({ AAPL: { bid: 199, ask: 200, asOf: new Date().toISOString() } }),
    getEquityTradability: async (_account: string, symbols: string[]) =>
      Object.fromEntries(symbols.map((symbol) => [symbol, { tradable: true, fractional: true }])),
    reviewEquityOrder: async (input: { quantity?: number; dollarAmount?: number }) => ({
      estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * 200,
      alerts: [],
      raw: {}
    }),
    placeEquityOrder: place,
    cancelEquityOrder: async () => ({ ok: true })
  };
}

async function seedApprovalSell(userId: string): Promise<string> {
  const { upsertConnectedAccount, setPolicy, insertProposal } = await import("../src/lib/db");
  const connectedAccountId = `acct-${userId}`;
  upsertConnectedAccount({
    id: connectedAccountId,
    userId,
    broker: "test",
    environment: "paper",
    accountNumber: APPROVAL_ACCOUNT,
    isActive: true,
    label: "Position invariant approval lane"
  });
  setPolicy(
    {
      ...DEFAULT_POLICY,
      accountNumber: APPROVAL_ACCOUNT,
      connectedAccountId,
      activeBroker: "test",
      systemState: "active"
    },
    userId
  );
  const proposalId = randomUUID();
  insertProposal({
    id: proposalId,
    runId: randomUUID(),
    accountNumber: APPROVAL_ACCOUNT,
    userId,
    proposal: {
      symbol: "AAPL",
      side: "sell",
      type: "market",
      quantity: 10,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "Owner-approved exit of the AAPL long.",
      tradeThesisTag: "Risk-Exit",
      entryMarketRegime: "Neutral (Normal Volatility)"
    },
    decision: { approved: true, reasons: [] },
    status: "proposed"
  });
  return proposalId;
}

describe("approval lane — a failed placement-time position read", () => {
  it("places an owner-approved exit using the position executeProposal just read (caller-verified hint)", async () => {
    const userId = `invariant-approval-hint-${randomUUID()}`;
    const placed: Array<EquityOrderInput & { refId: string }> = [];
    const place = async (input: EquityOrderInput & { refId: string }) => {
      placed.push(input);
      return { orderId: `ord-${randomUUID()}`, refId: input.refId, state: "confirmed", raw: {} };
    };
    const { withPositionInvariant } = await import("../src/lib/order-position-invariant");
    gatewayFactory.current = (policy, uid) => {
      const adapter = approvalAdapter([{ symbol: "AAPL", quantity: 10, averageCost: 180, marketValue: 2_000 }], place);
      // executeProposal's own reads succeed; ONLY the choke point's fresh read fails.
      const failingRead = {
        ...adapter,
        getEquityPositions: async () => {
          throw new Error("alpaca getPositions timed out");
        }
      };
      const chokePoint = withPositionInvariant(failingRead as unknown as BrokerGateway, policy, uid);
      return { ...adapter, placeEquityOrder: (input: EquityOrderInput & { refId: string }) => chokePoint.placeEquityOrder(input) } as unknown as BrokerGateway;
    };
    const proposalId = await seedApprovalSell(userId);
    const { executeProposal } = await import("../src/lib/strategy");
    const { listAudit } = await import("../src/lib/db");

    const result = await executeProposal(proposalId, userId);

    expect(["placed", "filled"]).toContain(result.status);
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ symbol: "AAPL", side: "sell", quantity: 10 });
    expect("verifiedPositionQuantity" in placed[0]).toBe(false);
    const readFailed = listAudit(200, userId).filter((entry) => entry.kind === "order_position_read_failed");
    expect(readFailed.map((entry) => (entry.payload as Record<string, unknown>).fallback)).toEqual(["caller_verified_quantity"]);
  }, 120_000);

  it("books a position_unverified refusal as retryable not_placed, never blocked", async () => {
    const userId = `invariant-approval-unverified-${randomUUID()}`;
    const { OrderPositionInvariantError } = await import("../src/lib/order-position-invariant");
    const place = async () => {
      throw new OrderPositionInvariantError(
        "AAPL SELL not placed: could not verify the broker's AAPL position just before placement.  Nothing was sent to the broker, so this is safe to retry once the position read succeeds.",
        "position_unverified"
      );
    };
    gatewayFactory.current = () =>
      approvalAdapter([{ symbol: "AAPL", quantity: 10, averageCost: 180, marketValue: 2_000 }], place) as unknown as BrokerGateway;
    const proposalId = await seedApprovalSell(userId);
    const { executeProposal } = await import("../src/lib/strategy");
    const { getProposal, listAudit } = await import("../src/lib/db");

    let outcome: unknown;
    try {
      outcome = await executeProposal(proposalId, userId);
    } catch (error) {
      outcome = error;
    }

    expect(getProposal(proposalId, userId)?.status).toBe("not_placed");
    const kinds = listAudit(200, userId).map((entry) => entry.kind);
    expect(kinds).toContain("order_not_placed_position_unverified");
    expect(kinds).not.toContain("order_blocked_validation");
    expect(String(outcome instanceof Error ? outcome.message : JSON.stringify(outcome))).toMatch(/safe to retry/i);
  }, 120_000);
});

describe("autopilot lane — a failed placement-time position read", () => {
  it("books a position_unverified refusal as retryable not_placed, never blocked", async () => {
    const userId = `invariant-autopilot-unverified-${randomUUID()}`;
    vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
    vi.stubEnv("AGENTIC_TEST_FORCE_TRADING_DAY", "1");
    const bullProposal = {
      symbol: "AAPL",
      side: "buy",
      type: "market",
      dollarAmount: 1000,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "Bull thesis for AAPL — position-invariant lane test",
      tradeThesisTag: "Momentum-Breakout",
      confidenceScore: 85
    };
    const chat = (content: unknown) =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("openrouter.ai") || href.includes("api.openai.com")) {
        const body = String(init?.body ?? "");
        if (body.includes("Red Team Risk Agent") || body.includes("rigorously critique")) {
          return chat({ verdict: "approve", reason: "Lane fixture looks fine." });
        }
        return chat({ proposals: [bullProposal] });
      }
      if (href.includes("nasdaq.com")) {
        return new Response(
          JSON.stringify({
            data: {
              asof: "2026-06-15",
              table: {
                rows: [
                  {
                    symbol: "AAPL",
                    lastsale: "$200",
                    pctchange: "1%",
                    volume: "1000000",
                    marketCap: "3000000000000",
                    sector: "Technology",
                    industry: "Consumer Electronics"
                  }
                ]
              }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });

    const { getTestGateway } = await import("../src/lib/robinhood");
    const { OrderPositionInvariantError } = await import("../src/lib/order-position-invariant");
    gatewayFactory.current = (_policy, uid) => {
      const base = getTestGateway(uid);
      return new Proxy(base, {
        get(target, prop, receiver) {
          if (prop === "placeEquityOrder") {
            return async () => {
              throw new OrderPositionInvariantError(
                "AAPL SELL not placed: could not verify the broker's AAPL position just before placement.  Nothing was sent to the broker, so this is safe to retry once the position read succeeds.",
                "position_unverified"
              );
            };
          }
          return Reflect.get(target, prop, receiver);
        }
      });
    };

    const { setActiveConnectedAccount, setPolicy, upsertConnectedAccount, upsertUserApiKey, listRecentProposals, listAudit } =
      await import("../src/lib/db");
    upsertUserApiKey(userId, "openrouter", "test-openai-key", "position invariant lane fixture");
    const accountId = randomUUID();
    upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "TEST",
      label: "Position invariant autopilot lane",
      isActive: true
    });
    setActiveConnectedAccount(accountId, userId);
    setPolicy(
      {
        ...DEFAULT_POLICY,
        connectedAccountId: accountId,
        accountNumber: "TEST",
        activeBroker: "test",
        systemState: "active",
        strategyAuthority: "decide",
        includedIndices: [],
        additionalSymbols: ["AAPL"],
        llmModel: "openai/gpt-4.1-mini",
        redTeamLlmModel: "openai/gpt-4.1-mini",
        maxOrderPctOfNav: 100,
        maxDailyNotional: 400_000,
        maxDailyPctOfNav: 0,
        maxSymbolExposurePct: 100,
        maxGrossExposurePct: 1000,
        maxNetExposurePct: 1000
      },
      userId,
      accountId
    );

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const run = await runStrategyOnce(userId, { manual: false, connectedAccountId: accountId });

    expect(run.status).toBe("completed");
    const result = run.proposals.find((p) => p.proposal.symbol === "AAPL");
    expect(result?.status).toBe("error");
    expect(result?.reasons?.[0]).toMatch(/safe to retry/i);
    const rows = listRecentProposals("TEST", 100, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("not_placed");
    const kinds = listAudit(500, userId).map((entry) => entry.kind);
    expect(kinds).toContain("order_not_placed_position_unverified");
    expect(kinds).not.toContain("order_blocked_live_preflight");
  }, 180_000);
});
