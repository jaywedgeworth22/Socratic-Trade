import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-ops-performance-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/ops/performance — auth", () => {
  // Generous timeouts on these two: each is the FIRST test to dynamically import
  // app/api/ops/performance/route.ts, which transitively pulls in the full db.ts/performance.ts
  // module graph (cold esbuild transform, one-time cost) — under heavy local machine contention
  // this can exceed the project's default 60s testTimeout even though the actual request logic
  // (authorizeOpsRequest short-circuits before any DB call) is near-instant.
  it(
    "rejects requests without a token",
    async () => {
      const { GET } = await import("../app/api/ops/performance/route");
      const response = await GET(new Request("http://localhost/api/ops/performance"));
      expect(response.status).toBe(401);
    },
    120_000
  );

  it(
    "rejects a request that presents only ADMIN_REINDEX_TOKEN",
    async () => {
      delete process.env.OPS_DIAGNOSTIC_TOKEN;
      process.env.ADMIN_REINDEX_TOKEN = "legacy-admin";
      const { GET } = await import("../app/api/ops/performance/route");
      const response = await GET(
        new Request("http://localhost/api/ops/performance", { headers: { "x-admin-token": "legacy-admin" } })
      );
      expect(response.status).toBe(401);
      delete process.env.ADMIN_REINDEX_TOKEN;
    },
    120_000
  );
});

describe("ops performance snapshot — shape and math", () => {
  it("computes realized P&L, trade stats, thesis scorecard, model attribution, funnel and equity curve", async () => {
    process.env.OPS_DIAGNOSTIC_TOKEN = "test-ops-token";
    const db = await import("../src/lib/db");
    const userId = `ops-perf-user-${randomUUID()}`;
    const accountId = `acct-${randomUUID()}`;
    const accountNumber = `PERF-${randomUUID()}`;

    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber,
      label: "Ops Perf Test Account",
      isActive: true
    });
    db.setPolicy({ ...db.getPolicy(userId, accountId), systemState: "active", strategyAuthority: "decide" }, userId, accountId);

    const now = Date.now();
    const daysAgo = (n: number) => new Date(now - n * 24 * 60 * 60 * 1000).toISOString();

    // Winning round trip: +200, inside the 30-day window, model "claude-opus-5.5".
    db.insertFillEvent({
      accountNumber,
      source: "paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      price: 100,
      notional: 1000,
      status: "filled",
      userId,
      filledAt: daysAgo(10),
      raw: { proposal: { proposedByModel: "claude-opus-5.5", tradeThesisTag: "Value-Quality" } }
    });
    db.insertFillEvent({
      accountNumber,
      source: "paper",
      symbol: "AAPL",
      side: "sell",
      quantity: 10,
      price: 120,
      notional: 1200,
      status: "filled",
      userId,
      filledAt: daysAgo(5)
    });

    // Losing round trip: -150, inside the window, same model.
    db.insertFillEvent({
      accountNumber,
      source: "paper",
      symbol: "MSFT",
      side: "buy",
      quantity: 5,
      price: 100,
      notional: 500,
      status: "filled",
      userId,
      filledAt: daysAgo(8),
      raw: { proposal: { proposedByModel: "claude-opus-5.5", tradeThesisTag: "Momentum" } }
    });
    db.insertFillEvent({
      accountNumber,
      source: "paper",
      symbol: "MSFT",
      side: "sell",
      quantity: 5,
      price: 70,
      notional: 350,
      status: "filled",
      userId,
      filledAt: daysAgo(3)
    });

    // A round trip OUTSIDE the 30-day window (closed 200 days ago) — must not count toward
    // windowed tradeStats, but its model attribution is lifetime so it still shows there.
    db.insertFillEvent({
      accountNumber,
      source: "paper",
      symbol: "TSLA",
      side: "buy",
      quantity: 2,
      price: 200,
      notional: 400,
      status: "filled",
      userId,
      filledAt: daysAgo(220),
      raw: { proposal: { proposedByModel: "claude-opus-5.5", tradeThesisTag: "Momentum" } }
    });
    db.insertFillEvent({
      accountNumber,
      source: "paper",
      symbol: "TSLA",
      side: "sell",
      quantity: 2,
      price: 210,
      notional: 420,
      status: "filled",
      userId,
      filledAt: daysAgo(200)
    });

    // Proposal funnel: 2 placed, 1 blocked (with a reason), 1 rejected_by_broker.
    const insertProposal = (status: string, decision: unknown) =>
      db.insertProposal({
        id: randomUUID(),
        userId,
        runId: randomUUID(),
        accountNumber,
        proposal: { symbol: "AAPL", side: "buy", type: "market", dollarAmount: 100, timeInForce: "gfd", marketHours: "regular_hours", rationale: "test" },
        decision,
        status
      });
    insertProposal("placed", { approved: true, reasons: [] });
    insertProposal("placed", { approved: true, reasons: [] });
    insertProposal("blocked", { approved: false, reasons: ["Daily notional cap exceeded."] });
    insertProposal("rejected_by_broker", { approved: true, reasons: [] });

    // Portfolio snapshots -> equity curve.
    db.insertPortfolioSnapshot({
      accountNumber,
      source: "paper",
      equity: 10500,
      cash: 5000,
      buyingPower: 5000,
      positionsValue: 5500,
      positions: [],
      userId,
      createdAt: daysAgo(10)
    });
    db.insertPortfolioSnapshot({
      accountNumber,
      source: "paper",
      equity: 10800,
      cash: 5300,
      buyingPower: 5300,
      positionsValue: 5500,
      positions: [],
      userId,
      createdAt: daysAgo(2)
    });

    const { buildOpsPerformanceSnapshot } = await import("../src/lib/ops-performance");
    const snapshot = await buildOpsPerformanceSnapshot({ connectedAccountId: accountId, days: 30 });

    expect(snapshot.accounts).toHaveLength(1);
    const account = snapshot.accounts[0];
    expect(account.error).toBeUndefined();
    expect(account.label).toBe("Ops Perf Test Account");
    expect(account.environment).toBe("paper");
    expect(account.systemState).toBe("active");
    expect(account.pricesUnavailable).toBe(true);

    // Realized P&L: +200 (AAPL) - 150 (MSFT) + 20 (TSLA, outside window but still realized-to-date) = 70.
    expect(account.paperRealizedPnl).toBeCloseTo(70, 2);
    expect(account.liveRealizedPnl).toBe(0);

    // Windowed trade stats exclude the TSLA round trip (closed 200 days ago, outside 30-day window).
    expect(account.tradeStats.tradeCount).toBe(2);
    expect(account.tradeStats.winRate).toBeCloseTo(50, 1);
    expect(account.tradeStats.avgWinUsd).toBeCloseTo(200, 2);
    expect(account.tradeStats.avgLossUsd).toBeCloseTo(150, 2);
    expect(account.tradeStats.profitFactor).toBeCloseTo(200 / 150, 2);
    expect(account.tradeStats.expectancyUsd).toBeCloseTo((200 - 150) / 2, 2);

    // Model attribution is lifetime (all 3 round trips): 3 trades, 2 wins (AAPL +200, TSLA +20),
    // 1 loss (MSFT -150), total pnl = 70.  Fills carry raw.proposal.proposedByModel = "claude-opus-5.5",
    // which thesisMetaFromFill canonicalizes via canonicalModelId -> "claude-opus-latest" (same
    // canonicalization every other model-attribution consumer in this codebase relies on).
    const modelRow = account.modelAttribution.find((m) => m.model === "claude-opus-latest");
    expect(modelRow).toBeDefined();
    expect(modelRow!.trades).toBe(3);
    expect(modelRow!.totalPnlUsd).toBeCloseTo(70, 2);

    // Thesis scorecard reflects the same account/source lots.
    expect(account.thesisScorecard.length).toBeGreaterThan(0);

    // Proposal funnel (created_at defaults to "now", inside the 30-day window).
    const placedCount = account.proposalFunnel.counts.find((c) => c.status === "placed")?.count;
    expect(placedCount).toBe(2);
    const blockedCount = account.proposalFunnel.counts.find((c) => c.status === "blocked")?.count;
    expect(blockedCount).toBe(1);
    expect(account.proposalFunnel.topBlockReasons[0]).toEqual({ reason: "Daily notional cap exceeded.", count: 1 });

    // Equity curve: both snapshots are inside the 30-day window, downsampled to one point/day.
    expect(account.equityCurve.length).toBe(2);
    expect(account.equityCurve[0].equity).toBe(10500);
    expect(account.equityCurve[1].equity).toBe(10800);
    expect(account.equityCurve.every((p) => typeof p.date === "string" && p.date.length === 10)).toBe(true);

    // Red Team efficacy is always present, even with zero vetoes.
    expect(account.redTeamEfficacy.totalVetoes).toBe(0);

    delete process.env.OPS_DIAGNOSTIC_TOKEN;
  });

  it("returns a zeroed entry for a connected account with no accountNumber yet, and never throws", async () => {
    const db = await import("../src/lib/db");
    const userId = `ops-perf-empty-${randomUUID()}`;
    const accountId = `acct-empty-${randomUUID()}`;

    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "robinhood",
      environment: "live",
      label: "Not yet synced",
      isActive: false
    });

    const { buildOpsPerformanceSnapshot } = await import("../src/lib/ops-performance");
    const snapshot = await buildOpsPerformanceSnapshot({ connectedAccountId: accountId });
    expect(snapshot.accounts).toHaveLength(1);
    const account = snapshot.accounts[0];
    expect(account.accountNumber).toBeNull();
    expect(account.tradeStats).toEqual({ windowDays: 90, tradeCount: 0, winRate: 0, expectancyUsd: 0 });
    expect(account.equityCurve).toEqual([]);
    expect(account.proposalFunnel.counts).toEqual([]);
  });

  it("survives a malformed Red Team audit payload for an account — falls back to an empty " +
    "redTeamEfficacy instead of throwing and losing the whole account's rollup", async () => {
    const db = await import("../src/lib/db");
    const userId = `ops-perf-badaudit-${randomUUID()}`;
    const accountId = `acct-badaudit-${randomUUID()}`;
    const accountNumber = `BADAUDIT-${randomUUID()}`;

    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber,
      label: "Bad Audit Test Account",
      isActive: true
    });
    db.setPolicy({ ...db.getPolicy(userId, accountId), systemState: "active", strategyAuthority: "decide" }, userId, accountId);

    const now = Date.now();
    const daysAgo = (n: number) => new Date(now - n * 24 * 60 * 60 * 1000).toISOString();

    // A real, valid round trip so this test can prove the REST of the account's rollup (P&L,
    // trade stats) still computes correctly despite the corrupted Red Team audit row below —
    // not just that the call doesn't throw.
    db.insertFillEvent({
      accountNumber,
      source: "paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      price: 100,
      notional: 1000,
      status: "filled",
      userId,
      filledAt: daysAgo(10)
    });
    db.insertFillEvent({
      accountNumber,
      source: "paper",
      symbol: "AAPL",
      side: "sell",
      quantity: 10,
      price: 120,
      notional: 1200,
      status: "filled",
      userId,
      filledAt: daysAgo(5)
    });

    // A malformed audit_events row of the exact kind getRedTeamEfficacy scans
    // (proposal_rejected_by_red_team) — inserted directly via getDb() because db.audit() always
    // JSON.stringifies its payload and can never produce invalid JSON on its own. This reproduces
    // a partial write / historical bad row: listAuditByKind's JSON.parse(row.payload) throws a
    // SyntaxError on this row with no per-row guard.
    db.getDb()
      .prepare(
        "INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(randomUUID(), userId, accountId, new Date().toISOString(), "proposal_rejected_by_red_team", "{not valid json");

    const { buildOpsPerformanceSnapshot } = await import("../src/lib/ops-performance");
    // Must not throw / reject — this is the regression this test guards against.
    const snapshot = await buildOpsPerformanceSnapshot({ connectedAccountId: accountId, days: 30 });

    expect(snapshot.accounts).toHaveLength(1);
    const account = snapshot.accounts[0];
    // The Red Team read failure is isolated to redTeamEfficacy alone — it does NOT flip the
    // whole account into the generic error branch.
    expect(account.error).toBeUndefined();
    expect(account.redTeamEfficacy.totalVetoes).toBe(0);
    expect(account.redTeamEfficacy.coverage).toBe("unavailable (read failed)");
    // The rest of the account's rollup still computed correctly from the real fills.
    expect(account.paperRealizedPnl).toBeCloseTo(200, 2);
    expect(account.tradeStats.tradeCount).toBe(1);
  });

  it("clamps an out-of-range days param and defaults a missing one", async () => {
    const db = await import("../src/lib/db");
    const userId = `ops-perf-clamp-${randomUUID()}`;
    const accountId = `acct-clamp-${randomUUID()}`;
    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: `CLAMP-${randomUUID()}`,
      label: "Clamp Test",
      isActive: true
    });

    const { buildOpsPerformanceSnapshot } = await import("../src/lib/ops-performance");
    expect((await buildOpsPerformanceSnapshot({ connectedAccountId: accountId, days: -5 })).windowDays).toBe(1);
    expect((await buildOpsPerformanceSnapshot({ connectedAccountId: accountId, days: 999999 })).windowDays).toBe(3650);
    expect((await buildOpsPerformanceSnapshot({ connectedAccountId: accountId, days: Number.NaN })).windowDays).toBe(90);
  });

  it("serves the GET route end to end and honors the account filter", async () => {
    process.env.OPS_DIAGNOSTIC_TOKEN = "test-ops-token-2";
    const db = await import("../src/lib/db");
    const userId = `ops-perf-route-${randomUUID()}`;
    const accountId = randomUUID();
    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "live",
      accountNumber: `ROUTE-${randomUUID()}`,
      label: "Route Test Account",
      isActive: true
    });

    const { GET } = await import("../app/api/ops/performance/route");
    const response = await GET(
      new Request(`http://localhost/api/ops/performance?account=${accountId}&days=15`, {
        headers: { "x-ops-token": "test-ops-token-2" }
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.windowDays).toBe(15);
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].connectedAccountId).toBe(accountId);

    delete process.env.OPS_DIAGNOSTIC_TOKEN;
  });
});

describe("ops performance snapshot — 60s cache", () => {
  it("serves a cached value within the TTL and recomputes after a reset", async () => {
    const db = await import("../src/lib/db");
    const { getOrBuildOpsPerformanceSnapshot, resetOpsPerformanceCacheForTests } = await import("../src/lib/ops-performance");
    resetOpsPerformanceCacheForTests();

    const userId = `ops-perf-cache-${randomUUID()}`;
    const accountId = `acct-cache-${randomUUID()}`;
    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: `CACHE-${randomUUID()}`,
      label: "Cache Test v1",
      isActive: true
    });

    const first = await getOrBuildOpsPerformanceSnapshot({ connectedAccountId: accountId, days: 90 });
    expect(first.accounts[0]?.label).toBe("Cache Test v1");

    // Mutate the underlying row — a cache hit must NOT see this change within the TTL.
    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: `CACHE-${randomUUID()}`,
      label: "Cache Test v2 — should not be visible yet",
      isActive: true
    });

    const second = await getOrBuildOpsPerformanceSnapshot({ connectedAccountId: accountId, days: 90 });
    expect(second).toBe(first); // same object reference: served from cache, not recomputed
    expect(second.accounts[0]?.label).toBe("Cache Test v1");

    resetOpsPerformanceCacheForTests();
    const third = await getOrBuildOpsPerformanceSnapshot({ connectedAccountId: accountId, days: 90 });
    expect(third).not.toBe(first);
    expect(third.accounts[0]?.label).toBe("Cache Test v2 — should not be visible yet");
  });

  it("single-flights concurrent requests for the same key", async () => {
    const db = await import("../src/lib/db");
    const { getOrBuildOpsPerformanceSnapshot, resetOpsPerformanceCacheForTests } = await import("../src/lib/ops-performance");
    resetOpsPerformanceCacheForTests();

    const userId = `ops-perf-flight-${randomUUID()}`;
    const accountId = `acct-flight-${randomUUID()}`;
    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: `FLIGHT-${randomUUID()}`,
      label: "Single Flight Test",
      isActive: true
    });

    const [a, b] = await Promise.all([
      getOrBuildOpsPerformanceSnapshot({ connectedAccountId: accountId, days: 45 }),
      getOrBuildOpsPerformanceSnapshot({ connectedAccountId: accountId, days: 45 })
    ]);
    expect(a).toBe(b);
  });
});

describe("ops performance snapshot — query cost against a synthetic DB", () => {
  it("builds a snapshot for an account with a large realized history in a bounded time", async () => {
    const db = await import("../src/lib/db");
    const { buildOpsPerformanceSnapshot, resetOpsPerformanceCacheForTests } = await import("../src/lib/ops-performance");
    resetOpsPerformanceCacheForTests();

    const userId = `ops-perf-load-${randomUUID()}`;
    const accountId = `acct-load-${randomUUID()}`;
    const accountNumber = `LOAD-${randomUUID()}`;
    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber,
      label: "Synthetic Load Test",
      isActive: true
    });

    const now = Date.now();
    const ROUND_TRIPS = 300; // 600 fills
    for (let i = 0; i < ROUND_TRIPS; i++) {
      const filledAtBuy = new Date(now - (ROUND_TRIPS - i) * 3 * 60 * 60 * 1000).toISOString();
      const filledAtSell = new Date(now - (ROUND_TRIPS - i) * 3 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString();
      const symbol = `SYN${i % 20}`;
      db.insertFillEvent({
        accountNumber,
        source: "paper",
        symbol,
        side: "buy",
        quantity: 1,
        price: 100,
        notional: 100,
        status: "filled",
        userId,
        filledAt: filledAtBuy,
        raw: { proposal: { proposedByModel: i % 2 === 0 ? "model-a" : "model-b", tradeThesisTag: "Synthetic" } }
      });
      db.insertFillEvent({
        accountNumber,
        source: "paper",
        symbol,
        side: "sell",
        quantity: 1,
        price: i % 3 === 0 ? 90 : 110,
        notional: i % 3 === 0 ? 90 : 110,
        status: "filled",
        userId,
        filledAt: filledAtSell
      });
    }

    const PROPOSALS = 500;
    const statuses = ["proposed", "blocked", "placed", "rejected_by_broker", "withdrawn"];
    for (let i = 0; i < PROPOSALS; i++) {
      const status = statuses[i % statuses.length];
      db.insertProposal({
        id: randomUUID(),
        userId,
        runId: randomUUID(),
        accountNumber,
        proposal: { symbol: `SYN${i % 20}`, side: "buy", type: "market", dollarAmount: 100, timeInForce: "gfd", marketHours: "regular_hours", rationale: "load test" },
        decision: status === "blocked" ? { approved: false, reasons: [`Synthetic block reason ${i % 7}`] } : { approved: true, reasons: [] },
        status
      });
    }

    const SNAPSHOTS = 200;
    for (let i = 0; i < SNAPSHOTS; i++) {
      db.insertPortfolioSnapshot({
        accountNumber,
        source: "paper",
        equity: 10000 + i * 10,
        cash: 5000,
        buyingPower: 5000,
        positionsValue: 5000 + i * 10,
        positions: [],
        userId,
        createdAt: new Date(now - (SNAPSHOTS - i) * 24 * 60 * 60 * 1000).toISOString()
      });
    }

    const startedAt = Date.now();
    const snapshot = await buildOpsPerformanceSnapshot({ connectedAccountId: accountId, days: 90 });
    const elapsedMs = Date.now() - startedAt;

    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.accounts[0].tradeStats.tradeCount).toBeGreaterThan(0);
    // Generous bound so this is a smoke check, not a flaky micro-benchmark — the actual measured
    // duration on the seed hardware is recorded in docs/rollouts/2026-09-24-st-ops-performance.md.
    expect(elapsedMs).toBeLessThan(5000);
    // eslint-disable-next-line no-console
    console.log(`[ops-performance query-cost] 300 round trips / 500 proposals / 200 snapshots -> ${elapsedMs}ms`);
  });
});

describe("ops performance snapshot — unfiltered, multi-account path (event-loop safety)", () => {
  it(
    "yields between accounts on the endpoint's own default (unfiltered) request, so a realistic " +
      "multi-account, multi-thousand-fill build cannot monopolize the event loop for its whole duration",
    async () => {
      const db = await import("../src/lib/db");
      const { buildOpsPerformanceSnapshot, resetOpsPerformanceCacheForTests } = await import("../src/lib/ops-performance");
      const yieldSpy = vi.spyOn(await import("../src/lib/slow-sync-guard"), "yieldEventLoop");
      resetOpsPerformanceCacheForTests();

      const runId = randomUUID();
      const ACCOUNT_COUNT = 4;
      const ROUND_TRIPS_PER_ACCOUNT = 250; // 500 fills/account — realistic multi-thousand-fill total
      const accountIds: string[] = [];
      const now = Date.now();

      for (let a = 0; a < ACCOUNT_COUNT; a++) {
        const userId = `ops-perf-unfiltered-${runId}-${a}`;
        const accountId = `acct-unfiltered-${runId}-${a}`;
        const accountNumber = `UNFILTERED-${runId}-${a}`;
        accountIds.push(accountId);
        db.upsertConnectedAccount({
          id: accountId,
          userId,
          broker: "alpaca",
          environment: "paper",
          accountNumber,
          label: `Unfiltered Load Test ${a}`,
          isActive: true
        });
        for (let i = 0; i < ROUND_TRIPS_PER_ACCOUNT; i++) {
          const filledAtBuy = new Date(now - (ROUND_TRIPS_PER_ACCOUNT - i) * 3 * 60 * 60 * 1000).toISOString();
          const filledAtSell = new Date(now - (ROUND_TRIPS_PER_ACCOUNT - i) * 3 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString();
          const symbol = `UNF${i % 20}`;
          db.insertFillEvent({
            accountNumber,
            source: "paper",
            symbol,
            side: "buy",
            quantity: 1,
            price: 100,
            notional: 100,
            status: "filled",
            userId,
            filledAt: filledAtBuy
          });
          db.insertFillEvent({
            accountNumber,
            source: "paper",
            symbol,
            side: "sell",
            quantity: 1,
            price: i % 3 === 0 ? 90 : 110,
            notional: i % 3 === 0 ? 90 : 110,
            status: "filled",
            userId,
            filledAt: filledAtSell
          });
        }
      }

      const startedAt = Date.now();
      // No `connectedAccountId` — this is the endpoint's own documented default
      // (scripts/fetch-prod-ops-performance.sh sends no `account` param unless
      // OPS_PERFORMANCE_ACCOUNT is set), which iterates every connected account across every
      // user in one request, not just the one this test seeded.
      const snapshot = await buildOpsPerformanceSnapshot({ days: 90 });
      const elapsedMs = Date.now() - startedAt;

      const built = snapshot.accounts.filter((account) => accountIds.includes(account.connectedAccountId));
      expect(built).toHaveLength(ACCOUNT_COUNT);
      for (const account of built) {
        expect(account.error).toBeUndefined();
        expect(account.tradeStats.tradeCount).toBeGreaterThan(0);
      }

      // The regression this guards against: buildOpsPerformanceSnapshot used to run every
      // account's full-ledger FIFO replay back to back in ONE synchronous stretch with no
      // scheduling point in between, so an unfiltered request's cost scaled with (accounts x
      // ledger size) while never giving the process a chance to serve /api/health or any other
      // queued request in between. yieldEventLoop() (this codebase's own fix for this exact
      // class of incident — see slow-sync-guard.ts, sec-ingest-worker.ts, db-learning.ts) must
      // be called at least once per account processed here.
      expect(yieldSpy.mock.calls.length).toBeGreaterThanOrEqual(ACCOUNT_COUNT);

      // Generous smoke bound, not a micro-benchmark — matches the single-account query-cost test above.
      expect(elapsedMs).toBeLessThan(15_000);
      // eslint-disable-next-line no-console
      console.log(
        `[ops-performance query-cost] unfiltered, ${ACCOUNT_COUNT} accounts x ${ROUND_TRIPS_PER_ACCOUNT} round trips -> ${elapsedMs}ms, ${yieldSpy.mock.calls.length} yields`
      );
    }
  );
});
