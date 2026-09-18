/**
 * Approval-time re-anchor for ORDINARY pending limit proposals (src/lib/approval-reprice.ts, wired
 * into executeProposal after the protective-exit reprice): a card awaiting a human Approve for
 * hours/overnight must not place at its generation-time limitPrice. Drives the REAL approval path
 * with the broker gateway and scanMarket mocked (same pattern as test/protective-exit-reprice.test.ts),
 * plus module-level units for the short/cover rounding sign conventions and path precedence.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { repriceStoredLimitProposal } from "../src/lib/approval-reprice";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { getDb, getProposal, insertProposal, setPolicy, upsertConnectedAccount } from "../src/lib/db";
import { liveApprovalText } from "../src/lib/strategy";
import { executeProposal } from "../src/lib/strategy-execution";
import type { MarketQuote, MarketScan, TradeProposal } from "../src/lib/types";

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  storeContext: async () => {},
  storeContexts: async () => {}
}));

const broker = vi.hoisted(() => ({
  placed: [] as Array<{ symbol: string; side: string; type?: string; marketHours?: string; limitPrice?: number; quantity?: number; refId: string }>,
  positions: [] as Array<{ symbol: string; quantity: number; averageCost: number; marketValue: number }>
}));

// The fresh approval-time quote the mocked scan serves; tests move it to simulate overnight drift.
const scan = vi.hoisted(() => ({ price: 202, bid: 201.9, ask: 202 }));

vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: () => ({
    getPortfolio: async () => ({
      accountNumber: "REANCHOR",
      totalMarketValue: 100_000,
      buyingPower: 50_000,
      equityMarketValue: 10_000,
      optionMarketValue: 0,
      cash: 90_000
    }),
    getEquityPositions: async () => broker.positions,
    getEquityOrders: async () => [],
    getEquityQuotes: async () => ({}),
    getEquityTradability: async (_accountNumber: string, symbols: string[]) => Object.fromEntries(
      symbols.map((symbol) => [symbol, { tradable: true, fractional: true }])
    ),
    reviewEquityOrder: async (input: { quantity?: number; dollarAmount?: number; limitPrice?: number }) => ({
      estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * (input.limitPrice ?? scan.price),
      alerts: []
    }),
    placeEquityOrder: async (order: typeof broker.placed[number]) => {
      broker.placed.push(order);
      return { orderId: `ord-${broker.placed.length}`, refId: order.refId, state: "accepted", raw: {} };
    }
  })
}));

// Stub ONLY scanMarket (importOriginal keeps mergeQuoteData and the other exports real) so the
// approval-time scan carries the fresh AAPL quote from the mutable `scan` state above.
vi.mock("../src/lib/approval-quote-scan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/approval-quote-scan")>();
  return {
    ...actual,
    loadApprovalQuoteScan: async () =>
      actual.buildApprovalQuoteScan(
        {
          AAPL: {
            symbol: "AAPL",
            price: scan.price,
            bid: scan.bid,
            ask: scan.ask,
            provider: "test-scan"
          }
        },
        []
      )
  };
});

vi.mock("../src/lib/market", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/market")>();
  return {
    ...actual,
    scanMarket: async (): Promise<MarketScan> => {
      const asOf = new Date().toISOString();
      const aapl: MarketQuote = {
        symbol: "AAPL",
        price: scan.price,
        bid: scan.bid,
        ask: scan.ask,
        volume: 1_000_000,
        intradayChangePct: 0,
        positionMarketValue: 0,
        score: 1,
        provider: "test-scan",
        asOf
      };
      return {
        source: "test-scan",
        generatedAt: asOf,
        scannedSymbols: 1,
        returnedQuotes: 1,
        topCandidates: [aapl],
        sectorBySymbol: {},
        quotesBySymbol: { AAPL: aapl },
        warnings: []
      };
    }
  };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-approval-limit-reprice-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  broker.placed = [];
  broker.positions = [];
  scan.price = 202;
  scan.bid = 201.9;
  scan.ask = 202;
});

afterEach(() => {
  vi.useRealTimers();
});

/** Stored overnight: anchored to a $200 generation-time quote, 1% below it (patient entry). */
const STORED_BUY_LIMIT: TradeProposal = {
  symbol: "AAPL",
  side: "buy",
  type: "limit",
  quantity: 5,
  limitPrice: 198,
  referencePrice: 200,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "Patient entry (approval-limit-reprice test).",
  tradeThesisTag: "Momentum-Breakout",
  entryMarketRegime: "Neutral (Normal Volatility)"
};

function seedPending(
  userId: string,
  proposal: TradeProposal,
  opts: { environment?: "paper" | "live"; policyOverrides?: Record<string, unknown> } = {}
): string {
  upsertConnectedAccount({
    id: `acct-${userId}`,
    userId,
    broker: "test",
    environment: opts.environment ?? "paper",
    accountNumber: "REANCHOR",
    label: "Reanchor Test",
    isActive: true
  });
  setPolicy(
    {
      ...DEFAULT_POLICY,
      accountNumber: "REANCHOR",
      connectedAccountId: `acct-${userId}`,
      systemState: "active",
      additionalSymbols: ["AAPL"],
      maxDailyNotional: 5000,
      ...opts.policyOverrides
    },
    userId
  );
  const proposalId = randomUUID();
  insertProposal({
    id: proposalId,
    runId: randomUUID(),
    accountNumber: "REANCHOR",
    userId,
    proposal,
    decision: { approved: true, reasons: [] },
    status: "proposed"
  });
  return proposalId;
}

function repriceAudits(kind: "approval_limit_repriced" | "approval_limit_reprice_reapproval", proposalId: string) {
  return (getDb()
    .prepare("SELECT payload FROM audit_events WHERE kind = ?")
    .all(kind) as Array<{ payload: string }>)
    .map((row) => JSON.parse(row.payload) as {
      proposalId: string;
      from: { limitPrice?: number; anchorPrice?: number };
      to: { limitPrice?: number; anchorPrice?: number };
      drift: { material: boolean; toleranceBps: number; anchorDriftBps?: number };
      reason?: string;
    })
    .filter((payload) => payload.proposalId === proposalId);
}

function atRegularHours<T>(fn: () => Promise<T>): Promise<T> {
  // Date only: executeProposal / sqliteYieldRetry now await setImmediate.
  // Full fake timers swallow that and the 30s test timeout fires instead.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-10T14:30:00Z")); // 10:30 ET = regular session (EDT)
  return fn().finally(() => vi.useRealTimers());
}

describe("executeProposal — approval-time ordinary-limit re-anchor", () => {
  it("patient buy limit, quote moved up 1%: re-anchors proportionally and places at the fresh limit", async () => {
    await atRegularHours(async () => {
      const userId = `reanchor-buy-${randomUUID()}`;
      const proposalId = seedPending(userId, STORED_BUY_LIMIT);
      const result = await executeProposal(proposalId, userId);
      expect(result.status).toBe("placed");
      expect(broker.placed).toHaveLength(1);
      expect(broker.placed[0]).toMatchObject({
        symbol: "AAPL",
        side: "buy",
        type: "limit",
        limitPrice: 199.98 // 202 * (198 / 200) — the stored 1%-below-anchor ratio, NOT the stale 198
      });
      // The repriced order is persisted back onto the row; the original referencePrice stays
      // untouched (entry-drift guard / analytics anchor) while repriceAnchorPrice carries the
      // fresh anchor for any later reprice.
      const persistedRow = getProposal(proposalId, userId);
      expect(persistedRow?.status).toBe("placed");
      expect(persistedRow?.proposal).toMatchObject({
        limitPrice: 199.98,
        referencePrice: 200,
        repriceAnchorPrice: 202,
        repricedFromLimit: 198
      });
      expect(persistedRow?.proposal.rationale).toContain("Limit re-anchored from $198.00 to $199.98");
      // Audit receipt records old limit, new limit, and the anchor drift.
      const receipts = repriceAudits("approval_limit_repriced", proposalId);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].from.limitPrice).toBe(198);
      expect(receipts[0].to.limitPrice).toBe(199.98);
      expect(receipts[0].drift.anchorDriftBps).toBeCloseTo(100, 6);
    });
  }, 30000);

  it("marketable buy limit (limit above reference): re-anchors and places", async () => {
    await atRegularHours(async () => {
      const userId = `reanchor-marketable-${randomUUID()}`;
      const proposalId = seedPending(userId, { ...STORED_BUY_LIMIT, limitPrice: 201 });
      const result = await executeProposal(proposalId, userId);
      expect(result.status).toBe("placed");
      expect(broker.placed).toHaveLength(1);
      expect(broker.placed[0]).toMatchObject({ type: "limit", limitPrice: 203.01 }); // 202 * (201 / 200)
    });
  }, 30000);

  it("sell limit exit in REGULAR hours (not claimed by the protective path): re-anchors and places", async () => {
    await atRegularHours(async () => {
      const userId = `reanchor-sell-${randomUUID()}`;
      broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 150, marketValue: 2020 }];
      const proposalId = seedPending(userId, {
        ...STORED_BUY_LIMIT,
        side: "sell",
        limitPrice: 210, // take-profit style, 5% above the stored anchor
        tradeThesisTag: "Take-Profit",
        rationale: "Regular-hours exit (approval-limit-reprice test)."
      });
      const result = await executeProposal(proposalId, userId);
      expect(result.status).toBe("placed");
      expect(broker.placed).toHaveLength(1);
      expect(broker.placed[0]).toMatchObject({ side: "sell", type: "limit", limitPrice: 212.1 }); // 202 * (210 / 200)
      expect(repriceAudits("approval_limit_repriced", proposalId)).toHaveLength(1);
    });
  }, 30000);

  it("LIVE + typed confirmation, MATERIAL move: re-queued (not placed) with the reason persisted; approving again places at the refreshed price", async () => {
    await atRegularHours(async () => {
      const userId = `reanchor-live-material-${randomUUID()}`;
      const proposalId = seedPending(userId, STORED_BUY_LIMIT, { environment: "live" });
      // The typed phrase confirmed the STORED $198 limit; the anchor moved 100 bps (> 15 bps
      // tolerance), so the reprice must go back to the human instead of the broker.
      const confirmation = {
        proposalId,
        accountNumber: "REANCHOR",
        executionMode: "broker/live" as const,
        typedText: liveApprovalText("AAPL")
      };
      const first = await executeProposal(proposalId, userId, { liveConfirmation: confirmation });
      expect(first.status).toBe("proposed");
      expect(first.reasons?.[0]).toContain("approve the repriced order again");
      expect(broker.placed).toHaveLength(0);
      const requeued = getProposal(proposalId, userId);
      expect(requeued?.status).toBe("proposed");
      expect(requeued?.proposal).toMatchObject({ limitPrice: 199.98, repriceAnchorPrice: 202, repricedFromLimit: 198 });
      expect(requeued?.proposal.priceRequoteReason).toContain("re-anchored materially");
      expect(requeued?.proposal.priceRequotedAt).toBeDefined();
      const deferReceipts = repriceAudits("approval_limit_reprice_reapproval", proposalId);
      expect(deferReceipts).toHaveLength(1);
      expect(deferReceipts[0].drift.material).toBe(true);
      // Approve AGAIN with the quote unmoved: drift now measures from repriceAnchorPrice (202), so
      // the refreshed price places without compounding the same move a second time.
      const second = await executeProposal(proposalId, userId, {
        liveConfirmation: { ...confirmation, estimatedNotional: requeued?.estimatedNotional }
      });
      expect(second.status).toBe("placed");
      expect(broker.placed).toHaveLength(1);
      expect(broker.placed[0]).toMatchObject({ type: "limit", limitPrice: 199.98 });
    });
  }, 30000);

  it("fallback-stamped anchor (manual proposal, no reference): NOT repriced — a reviewed hard limit places verbatim", async () => {
    await atRegularHours(async () => {
      const userId = `reanchor-hard-limit-${randomUUID()}`;
      // A chat/manual proposal arrives with NO referencePrice; insertProposal stamps
      // referencePrice = limitPrice with provenance "limit-fallback". That is a hard price —
      // re-anchoring would turn a hard $200 limit into a current-market ($202) limit.
      const { referencePrice: _omitted, ...manual } = { ...STORED_BUY_LIMIT, limitPrice: 200 };
      const proposalId = seedPending(userId, manual as TradeProposal);
      const stored = getProposal(proposalId, userId);
      expect(stored?.proposal.referencePriceProvenance).toBe("limit-fallback");
      const result = await executeProposal(proposalId, userId);
      expect(result.status).toBe("placed");
      expect(broker.placed[0]).toMatchObject({ type: "limit", limitPrice: 200 });
      expect(repriceAudits("approval_limit_repriced", proposalId)).toHaveLength(0);
    });
  }, 30000);

  it("GENUINE at-market limit (limit exactly at a provided quote anchor): DOES reprice — provenance beats the equality heuristic", async () => {
    await atRegularHours(async () => {
      const userId = `reanchor-at-market-${randomUUID()}`;
      // The LLM legitimately set the limit exactly at the decision-time quote; insertProposal
      // stamps provenance "provided" because the reference arrived with the proposal. Skipping
      // this one would leave the exact class of stale order this feature exists to prevent.
      const proposalId = seedPending(userId, { ...STORED_BUY_LIMIT, limitPrice: 200, referencePrice: 200 });
      const stored = getProposal(proposalId, userId);
      expect(stored?.proposal.referencePriceProvenance).toBe("provided");
      const result = await executeProposal(proposalId, userId);
      expect(result.status).toBe("placed");
      expect(broker.placed[0]).toMatchObject({ type: "limit", limitPrice: 202 }); // 202 * (200/200)
      expect(repriceAudits("approval_limit_repriced", proposalId)).toHaveLength(1);
    });
  }, 30000);

  it("PAPER opening beyond the entry-drift cap: re-queued for fresh consent with the decision receipt flipped to approved:false", async () => {
    await atRegularHours(async () => {
      const userId = `reanchor-drift-cap-${randomUUID()}`;
      // Anchor 180 -> fresh 202 = ~1222 bps, beyond the default maxEntryDriftPct (10% = 1000 bps).
      // Once the reprice moves the limit, the drift guard's limit-order exemption no longer
      // holds, so even a PAPER opening goes back to the human.
      const proposalId = seedPending(userId, { ...STORED_BUY_LIMIT, limitPrice: 178, referencePrice: 180 });
      const result = await executeProposal(proposalId, userId);
      expect(result.status).toBe("proposed");
      expect(result.reasons?.[0]).toContain("entry-drift cap");
      expect(broker.placed).toHaveLength(0);
      const requeued = getProposal(proposalId, userId);
      expect(requeued?.status).toBe("proposed");
      expect(requeued?.proposal.priceRequoteReason).toContain("entry-drift cap");
      // The held card must not carry an approved decision receipt (codex P2).
      expect(requeued?.decision.approved).toBe(false);
      expect(requeued?.decision.reasons?.join(" ")).toContain("entry-drift cap");
    });
  }, 30000);

  it("missing referencePrice: unchanged behavior — places at the stored limit, no throw, no reprice", async () => {
    await atRegularHours(async () => {
      const userId = `reanchor-noref-${randomUUID()}`;
      const { referencePrice: _omitted, ...withoutReference } = STORED_BUY_LIMIT;
      const proposalId = seedPending(userId, STORED_BUY_LIMIT);
      // insertProposal defensively stamps referencePrice = limitPrice when absent, so a truly
      // reference-less row (legacy shape) has to be written directly.
      getDb()
        .prepare("UPDATE trade_proposals SET proposal = ? WHERE id = ?")
        .run(JSON.stringify(withoutReference), proposalId);
      const result = await executeProposal(proposalId, userId);
      expect(result.status).toBe("placed");
      expect(broker.placed).toHaveLength(1);
      expect(broker.placed[0]).toMatchObject({ type: "limit", limitPrice: 198 });
      expect(repriceAudits("approval_limit_repriced", proposalId)).toHaveLength(0);
    });
  }, 30000);

  it("protective-exit-repriced proposal is NOT double-repriced by the ordinary-limit path", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z")); // 08:00 ET = pre-market (EDT)
    try {
      const userId = `reanchor-protective-${randomUUID()}`;
      broker.positions = [{ symbol: "AAPL", quantity: 5, averageCost: 220, marketValue: 1000 }];
      scan.price = 200;
      scan.bid = 199;
      scan.ask = 200;
      const proposalId = seedPending(
        userId,
        {
          symbol: "AAPL",
          side: "sell",
          type: "limit",
          quantity: 5,
          limitPrice: 219.67, // stored pre-market off a $220 quote
          referencePrice: 220,
          timeInForce: "gfd",
          marketHours: "extended_hours",
          rationale: "Proactive stop-loss exit (double-reprice guard test).",
          tradeThesisTag: "Risk-Exit",
          entryMarketRegime: "Active Risk Check"
        },
        { policyOverrides: { allowExtendedHoursSyntheticStops: true } }
      );
      const result = await executeProposal(proposalId, userId);
      expect(result.status).toBe("placed");
      expect(broker.placed).toHaveLength(1);
      // The protective path's bid-anchored marketable limit (199 * (1 - 0.0015)) stands; the
      // ordinary re-anchor (which would have produced 200 * 219.67/220 = 199.70) never ran.
      expect(broker.placed[0]).toMatchObject({ type: "limit", marketHours: "extended_hours", limitPrice: 198.7 });
      expect(repriceAudits("approval_limit_repriced", proposalId)).toHaveLength(0);
      const persistedRow = getProposal(proposalId, userId);
      expect(persistedRow?.proposal.repriceAnchorPrice).toBeUndefined();
      expect(persistedRow?.proposal.repricedFromLimit).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  }, 30000);

  it("market-type proposal is untouched by the reprice path", async () => {
    await atRegularHours(async () => {
      const userId = `reanchor-market-${randomUUID()}`;
      const proposalId = seedPending(userId, { ...STORED_BUY_LIMIT, type: "market", limitPrice: undefined });
      const result = await executeProposal(proposalId, userId);
      expect(result.status).toBe("placed");
      expect(broker.placed).toHaveLength(1);
      expect(broker.placed[0]).toMatchObject({ type: "market" });
      expect(broker.placed[0].limitPrice).toBeUndefined();
      expect(repriceAudits("approval_limit_repriced", proposalId)).toHaveLength(0);
      expect(getProposal(proposalId, userId)?.proposal.repriceAnchorPrice).toBeUndefined();
    });
  }, 30000);
});

describe("repriceStoredLimitProposal — sign conventions and precedence (module units)", () => {
  const base: TradeProposal = {
    symbol: "AAPL",
    side: "short",
    type: "limit",
    quantity: 5,
    limitPrice: 199.99,
    referencePrice: 200,
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "sign-convention unit",
    tradeThesisTag: "Short-Entry",
    entryMarketRegime: "Neutral (Normal Volatility)"
  };
  // 201 * (199.99 / 200) = 200.98995 — exactly mid-tick, so the rounding direction is observable.
  const quote = { price: 201 };

  it("SHORT rounds DOWN (sell-side marketable direction)", () => {
    const { proposal, drift } = repriceStoredLimitProposal({ ...base }, DEFAULT_POLICY, quote);
    expect(proposal.limitPrice).toBe(200.98);
    expect(proposal.repricedFromLimit).toBe(199.99);
    expect(drift.anchorDriftBps).toBeCloseTo(50, 6);
    expect(drift.material).toBe(true); // 50 bps > the 15 bps default tolerance
  });

  it("COVER rounds UP (buy-side marketable direction)", () => {
    const { proposal } = repriceStoredLimitProposal({ ...base, side: "cover" }, DEFAULT_POLICY, quote);
    expect(proposal.limitPrice).toBe(200.99);
  });

  it("SELL rounds DOWN and BUY rounds UP", () => {
    expect(repriceStoredLimitProposal({ ...base, side: "sell" }, DEFAULT_POLICY, quote).proposal.limitPrice).toBe(200.98);
    expect(repriceStoredLimitProposal({ ...base, side: "buy" }, DEFAULT_POLICY, quote).proposal.limitPrice).toBe(200.99);
  });

  it("declines proposals the protective-exit path claims, even when that path left them unchanged", () => {
    const protectiveClaimed: TradeProposal = {
      ...base,
      side: "sell",
      marketHours: "extended_hours",
      tradeThesisTag: "Risk-Exit"
    };
    const result = repriceStoredLimitProposal(protectiveClaimed, DEFAULT_POLICY, quote);
    expect(result.proposal).toBe(protectiveClaimed);
  });

  it("unmoved quote: returns the same proposal reference (sub-tick churn floor)", () => {
    const input: TradeProposal = { ...base, side: "buy" };
    const result = repriceStoredLimitProposal(input, DEFAULT_POLICY, { price: 200 });
    expect(result.proposal).toBe(input);
    expect(result.drift.material).toBe(false);
  });

  it("BUY bracket: every leg scales by the same ratio — geometry preserved, no inversion, exits rounded toward the entry", () => {
    const bracket: TradeProposal = {
      ...base,
      side: "buy",
      limitPrice: 100,
      referencePrice: 100,
      repriceAnchorPrice: 100, // carried genuine anchor — ref===limit alone would read as the fallback stamp
      bracketTakeProfit: 110,
      bracketStopLoss: 95,
      bracketStopLimit: 94.5
    };
    // Quote moved +2%: exact ratio prices are 102 / 112.2 / 96.9 / 96.39.
    const { proposal } = repriceStoredLimitProposal(bracket, DEFAULT_POLICY, { price: 102 });
    expect(proposal.limitPrice).toBe(102); // buy entry rounds up (exact here)
    expect(proposal.bracketTakeProfit).toBe(112.2); // sell-side TP rounds down (toward entry)
    expect(proposal.bracketStopLoss).toBe(96.9); // sell-side SL rounds up (toward entry)
    expect(proposal.bracketStopLimit).toBe(96.39);
    // Geometry: TP stays above entry, SL stays below — no inversion after re-anchor.
    expect(proposal.bracketTakeProfit!).toBeGreaterThan(proposal.limitPrice!);
    expect(proposal.bracketStopLoss!).toBeLessThan(proposal.limitPrice!);
    expect(proposal.rationale).toContain("bracket legs re-anchored");
  });

  it("SHORT bracket mirrors: TP below entry rounds up, SL above entry rounds down; geometry preserved", () => {
    const bracket: TradeProposal = {
      ...base,
      side: "short",
      limitPrice: 100,
      referencePrice: 100,
      repriceAnchorPrice: 100,
      bracketTakeProfit: 90,
      bracketStopLoss: 105
    };
    // Quote moved -1%: exact ratio prices are 99 / 89.1 / 103.95.
    const { proposal } = repriceStoredLimitProposal(bracket, DEFAULT_POLICY, { price: 99 });
    expect(proposal.limitPrice).toBe(99); // short entry rounds down (exact here)
    expect(proposal.bracketTakeProfit).toBe(89.1); // buy-side TP rounds up (toward entry)
    expect(proposal.bracketStopLoss).toBe(103.95); // buy-side SL rounds down (toward entry)
    expect(proposal.bracketTakeProfit!).toBeLessThan(proposal.limitPrice!);
    expect(proposal.bracketStopLoss!).toBeGreaterThan(proposal.limitPrice!);
  });

  it("partial bracket (stop-loss only) re-anchors the present leg and leaves the absent ones undefined", () => {
    const bracket: TradeProposal = {
      ...base,
      side: "buy",
      limitPrice: 50,
      referencePrice: 50,
      repriceAnchorPrice: 50,
      bracketStopLoss: 47
    };
    const { proposal } = repriceStoredLimitProposal(bracket, DEFAULT_POLICY, { price: 51 });
    expect(proposal.bracketStopLoss).toBeCloseTo(47.94, 2);
    expect(proposal.bracketTakeProfit).toBeUndefined();
    expect(proposal.bracketStopLimit).toBeUndefined();
    expect(proposal.rationale).toContain("bracket legs re-anchored");
  });

  it("non-bracket reprice rationale does not claim bracket re-anchoring", () => {
    const { proposal } = repriceStoredLimitProposal({ ...base, side: "buy" }, DEFAULT_POLICY, quote);
    expect(proposal.rationale).not.toContain("bracket");
  });

  it("provenance discriminates: limit-fallback never reprices, provided reprices even at exact equality, legacy (no provenance) uses the conservative equality skip", () => {
    const equal: TradeProposal = { ...base, side: "buy", limitPrice: 200, referencePrice: 200 };
    const fallback: TradeProposal = { ...equal, referencePriceProvenance: "limit-fallback" };
    expect(repriceStoredLimitProposal(fallback, DEFAULT_POLICY, { price: 210 }).proposal).toBe(fallback);
    const provided: TradeProposal = { ...equal, referencePriceProvenance: "provided" };
    expect(repriceStoredLimitProposal(provided, DEFAULT_POLICY, { price: 210 }).proposal).not.toBe(provided);
    // Pre-marker legacy row: conservative equality skip (48h-TTL-bounded ambiguity window).
    expect(repriceStoredLimitProposal(equal, DEFAULT_POLICY, { price: 210 }).proposal).toBe(equal);
    // A carried repriceAnchorPrice (real quote from a prior reprice) restores legacy eligibility.
    const carried: TradeProposal = { ...equal, repriceAnchorPrice: 200 };
    expect(repriceStoredLimitProposal(carried, DEFAULT_POLICY, { price: 210 }).proposal).not.toBe(carried);
    // limit-fallback stays hard even with a carried anchor: the human's price is the contract.
    const fallbackCarried: TradeProposal = { ...fallback, repriceAnchorPrice: 200 };
    expect(repriceStoredLimitProposal(fallbackCarried, DEFAULT_POLICY, { price: 210 }).proposal).toBe(fallbackCarried);
  });

  it("dollar-sized bracket that goes sub-one-share after repricing strips its legs (generation-path parity)", () => {
    const dollarBracket: TradeProposal = {
      ...base,
      side: "buy",
      quantity: undefined,
      dollarAmount: 100,
      limitPrice: 99,
      referencePrice: 100,
      bracketTakeProfit: 110,
      bracketStopLoss: 95
    };
    // 102 * (99/100) = 100.98 -> floor(100 / 100.98) = 0 whole shares.
    const { proposal } = repriceStoredLimitProposal(dollarBracket, DEFAULT_POLICY, { price: 102 });
    expect(proposal.limitPrice).toBe(100.98);
    expect(proposal.bracketTakeProfit).toBeUndefined();
    expect(proposal.bracketStopLoss).toBeUndefined();
    expect(proposal.rationale).toContain("bracket removed");
    // A larger dollar size keeps its bracket: floor(500 / 100.98) = 4 shares.
    const kept = repriceStoredLimitProposal({ ...dollarBracket, dollarAmount: 500 }, DEFAULT_POLICY, { price: 102 });
    expect(kept.proposal.bracketTakeProfit).toBeDefined();
    expect(kept.proposal.rationale).not.toContain("bracket removed");
  });

  it("collision probe A ($1 tick-factor boundary): TP is clamped a full tick ABOVE the repriced entry, never equal", () => {
    const bracket: TradeProposal = {
      ...base,
      side: "buy",
      limitPrice: 1.03,
      referencePrice: 1.03,
      repriceAnchorPrice: 1.03,
      bracketTakeProfit: 1.04
    };
    const { proposal } = repriceStoredLimitProposal(bracket, DEFAULT_POLICY, { price: 1.0055 });
    // Pre-clamp both legs rounded to $1.01 (verifier-reproduced collision). The clamp restores
    // >= 1-tick separation.
    expect(proposal.limitPrice).toBeDefined();
    expect(proposal.bracketTakeProfit!).toBeGreaterThan(proposal.limitPrice!);
  });

  it("collision probe C (tight stop gap): SL is clamped a full tick BELOW the repriced entry, never equal", () => {
    const bracket: TradeProposal = {
      ...base,
      side: "buy",
      limitPrice: 2.0,
      referencePrice: 2.0,
      repriceAnchorPrice: 2.0,
      bracketStopLoss: 1.99
    };
    const { proposal } = repriceStoredLimitProposal(bracket, DEFAULT_POLICY, { price: 1.8 });
    expect(proposal.limitPrice).toBe(1.8);
    expect(proposal.bracketStopLoss!).toBeLessThan(proposal.limitPrice!);
  });

  it("materiality boundary: anchor drift exactly AT the tolerance is immaterial; just above is material", () => {
    // Default tolerance is 15 bps. Anchor 200 -> fresh 200.30 = exactly 15 bps; 200.31 > 15 bps.
    const atTolerance = repriceStoredLimitProposal({ ...base, side: "buy", limitPrice: 190, referencePrice: 200 }, DEFAULT_POLICY, { price: 200.3 });
    expect(atTolerance.drift.anchorDriftBps).toBeCloseTo(15, 6);
    expect(atTolerance.drift.material).toBe(false);
    const above = repriceStoredLimitProposal({ ...base, side: "buy", limitPrice: 190, referencePrice: 200 }, DEFAULT_POLICY, { price: 200.31 });
    expect(above.drift.material).toBe(true);
  });

  it("repeated reprices replace the rationale tag instead of stacking an unbounded chain", () => {
    const first = repriceStoredLimitProposal({ ...base, side: "buy" }, DEFAULT_POLICY, { price: 210 });
    expect(first.proposal.rationale.match(/\[Limit re-anchored/g)).toHaveLength(1);
    const second = repriceStoredLimitProposal(first.proposal, DEFAULT_POLICY, { price: 220 });
    expect(second.proposal.rationale.match(/\[Limit re-anchored/g)).toHaveLength(1);
    expect(second.proposal.rationale).toContain("$220.00"); // the CURRENT tag, not the first one
  });
});
