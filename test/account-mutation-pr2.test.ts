/**
 * §7 slice 3 PR-2 — the approval-lane money-path window (executeProposal) actually contends on
 * the per-account broker-mutation lease. PR-1 (test/account-mutation.test.ts) covers the lease
 * primitive and the risk lanes in isolation; this file drives the REAL executeProposal end to
 * end through the "test" broker (TestBrokerGateway — deterministic synchronous fills, no
 * network) so a held lease is provably observed by the approval placement window itself, not
 * just by a synthetic caller of withAccountMutation.
 *
 * New file (rather than extending test/account-mutation.test.ts) because executeProposal needs
 * the same non-trivial fixture as test/approval-lock.test.ts (temp DB, connected test-broker
 * account, vector-db + market mocks) — reused verbatim below, including the 2026-07-05
 * determinism fix (stub scanMarket so this file doesn't fan out to live Nasdaq/Yahoo fetches).
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import {
  getDb,
  getProposal,
  insertProposal,
  setActiveConnectedAccount,
  setPolicy,
  upsertConnectedAccount
} from "../src/lib/db";
import { listFillEventsByProposalId } from "../src/lib/db-fills";
import { LANE_WAITS, withAccountMutation } from "../src/lib/account-mutation";
import { executeProposal } from "../src/lib/strategy-execution";

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  storeContext: async () => {},
  storeContexts: async () => {}
}));

// FIX-1 regression harness only: a controllable hook that deletes the account's persisted
// mutation-lease row the NEXT time freshPlacementBlockReason runs — which the approval-lane span
// calls synchronously immediately before mutationCtx.assertOwned() and the placeEquityOrder call.
// Deleting the row there deterministically reproduces "the lease was lost right before the
// risk-creating broker call" without racing the real 30s TTL/heartbeat. Disarmed by default so
// every other test in this file is unaffected; must stay synchronous (the real function isn't
// awaited by its caller).
const leaseLossHooks = vi.hoisted(() => ({ armed: false }));
vi.mock("../src/lib/system-state-placement-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/system-state-placement-guard")>();
  return {
    ...actual,
    freshPlacementBlockReason: (input: Parameters<typeof actual.freshPlacementBlockReason>[0]) => {
      if (leaseLossHooks.armed) {
        leaseLossHooks.armed = false;
        getDb().prepare("DELETE FROM settings WHERE key LIKE 'operation_lease:broker-mutation:%'").run();
      }
      return actual.freshPlacementBlockReason(input);
    }
  };
});

// Same rationale as test/approval-lock.test.ts: executeProposal's market scan is incidental here
// (this file verifies the mutation-lease wrap, not scoring), but unmocked it makes REAL
// Nasdaq/Yahoo fetches — the 2026-06-21 recurring full-suite timeout flake. Stub scanMarket; keep
// every other market.ts export real.
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

vi.mock("../src/lib/market", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/market")>();
  return {
    ...actual,
    scanMarket: async (): Promise<import("../src/lib/types").MarketScan> => {
      const asOf = new Date().toISOString();
      const aapl: import("../src/lib/types").MarketQuote = {
        symbol: "AAPL",
        price: 200,
        bid: 199,
        ask: 200,
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
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-acctmut-pr2-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers (mirrors test/approval-lock.test.ts)
// ---------------------------------------------------------------------------

const ACCOUNT = "ACC-PR2-TEST";

function makeProposalId(userId: string): string {
  const proposalId = randomUUID();
  insertProposal({
    id: proposalId,
    runId: randomUUID(),
    accountNumber: ACCOUNT,
    userId,
    proposal: {
      symbol: "AAPL",
      side: "buy",
      type: "market",
      dollarAmount: 500,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "PR-2 mutation-lease test",
      tradeThesisTag: "Momentum-Breakout",
      entryMarketRegime: "Neutral (Normal Volatility)"
    },
    decision: { approved: true, reasons: [] },
    status: "proposed"
  });
  return proposalId;
}

// An account is an account: executeProposal refuses to run without a connected broker account
// (no local-simulation fallback), so every test needs a real connected TEST-BROKER account (test
// infrastructure — TestBrokerGateway, deterministic synchronous fills) wired up first.
function setPaperPolicy(userId: string): string {
  const accountId = randomUUID();
  upsertConnectedAccount({
    id: accountId,
    userId,
    broker: "test",
    environment: "paper",
    accountNumber: ACCOUNT,
    label: "PR-2 Mutation Lease Test Account",
    isActive: true
  });
  setActiveConnectedAccount(accountId, userId);
  setPolicy(
    { ...DEFAULT_POLICY, accountNumber: ACCOUNT, activeBroker: "test", systemState: "active" },
    userId
  );
  return accountId;
}

/** Start a withAccountMutation window that holds the account's lease until `release()` is
 *  called. Resolves only once the lease has actually been acquired (its body has started
 *  running), so callers can rely on the lease being held the instant this resolves. */
async function holdLease(
  userId: string,
  accountId: string
): Promise<{ release: () => void; done: ReturnType<typeof withAccountMutation<void>> }> {
  let release!: () => void;
  let acquiredResolve!: () => void;
  const acquired = new Promise<void>((resolve) => {
    acquiredResolve = resolve;
  });
  const done = withAccountMutation(
    { userId, accountNumber: ACCOUNT, connectedAccountId: accountId, lane: "account-drain", waitMs: 0 },
    async () => {
      acquiredResolve();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
  );
  await acquired;
  return { release, done };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PR-2 money-path windows", () => {
  const originalApprovalPlacementWait = LANE_WAITS.approvalPlacement;

  afterEach(() => {
    // LANE_WAITS is an exported mutable table (mirrors ttlMs/heartbeatMs test overrides) — restore
    // it so a shrunk wait never leaks into another test/file.
    LANE_WAITS.approvalPlacement = originalApprovalPlacementWait;
  });

  it(
    "returns busy without claiming or placing when the approval lane's lease is already held, then places normally on retry",
    async () => {
      const userId = `mutation-pr2-${randomUUID()}`;
      const accountId = setPaperPolicy(userId);
      const proposalId = makeProposalId(userId);

      // Shrink the bounded wait so the busy path resolves quickly instead of waiting the real 30s.
      LANE_WAITS.approvalPlacement = 50;

      const holder = await holdLease(userId, accountId);
      try {
        const busyResult = await executeProposal(proposalId, userId);

        expect(busyResult.status).toBe("busy");
        expect(busyResult.reasons).toBeDefined();
        expect(busyResult.reasons![0]).toMatch(/broker operation.*in progress/i);

        // Never claimed: the lease is acquired BEFORE claimProposalForExecution, so a busy exit
        // must leave the row exactly as it started. executionMode/review are written ONLY by
        // claimProposalForExecution, so asserting them undefined makes "never claimed" literal
        // rather than inferred from status alone.
        const rowWhileBusy = getProposal(proposalId, userId);
        expect(rowWhileBusy?.status).toBe("proposed");
        expect(rowWhileBusy?.executionMode).toBeUndefined();
        expect(rowWhileBusy?.review).toBeUndefined();

        // No order reached the broker: no fill receipt exists for this proposal.
        expect(listFillEventsByProposalId(proposalId, userId)).toEqual([]);
      } finally {
        holder.release();
        await holder.done;
      }

      // Retry once the lease is free: the same proposal now places/fills normally.
      const retryResult = await executeProposal(proposalId, userId);
      expect(["placed", "filled"]).toContain(retryResult.status);
      expect(retryResult.orderId).toBeTruthy();

      const rowAfterRetry = getProposal(proposalId, userId);
      expect(["placed", "filled"]).toContain(rowAfterRetry?.status);
      expect(listFillEventsByProposalId(proposalId, userId)).toHaveLength(1);
    },
    20000
  );
});

describe("PR-2 lease-loss short-circuit (regression for the FIX-1 mutation-lease fence)", () => {
  afterEach(() => {
    // Disarm even on a failed assertion so a stuck flag can't bleed into a later test.
    leaseLossHooks.armed = false;
  });

  it(
    "lands not_placed without contacting the broker or auditing order_placement_uncertain when the lease is lost immediately before placement",
    async () => {
      const userId = `mutation-pr2-leaseloss-${randomUUID()}`;
      setPaperPolicy(userId);
      const proposalId = makeProposalId(userId);

      // Deletes the account's lease row the next time freshPlacementBlockReason runs — which is
      // the statement immediately preceding mutationCtx.assertOwned() in the approval span, so by
      // the time assertOwned() runs the lease is already gone and it throws
      // OperationLeaseOwnershipError before gateway.placeEquityOrder is ever called.
      leaseLossHooks.armed = true;

      // executeProposal now THROWS for non-placement outcomes (#3343). The lease-lost refusal
      // is a deterministic pre-submission refusal — no order was placed — so the caller surfaces
      // it via an exception instead of a return object.
      await expect(executeProposal(proposalId, userId)).rejects.toThrow(/lease lost/i);

      const row = getProposal(proposalId, userId);
      expect(row?.status).toBe("not_placed");

      // The order provably never reached the broker.
      expect(listFillEventsByProposalId(proposalId, userId)).toEqual([]);

      const auditKinds = getDb()
        .prepare("SELECT kind FROM audit_events WHERE user_id = ?")
        .all(userId)
        .map((r) => (r as { kind: string }).kind);
      // The whole point of the FIX-1 fence: a lost lease must short-circuit BEFORE
      // reconcilePlacementError, so it can never be misclassified as a broker-side uncertainty
      // (which would wrongly feed the broker-health run suppressor for a non-broker fault).
      expect(auditKinds).not.toContain("order_placement_uncertain");
      expect(auditKinds).toContain("order_not_placed_lease_lost");
    },
    20000
  );
});
