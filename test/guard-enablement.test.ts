import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
process.env.OPENROUTER_API_KEY = "test-key";

// Guard enablement 2026-07-28 (docs/guard-enablement-proposal-2026-07-28.md):
//  (a) tuning deep-merge precedence in db-profiles' mergePolicy — stored explicit keys win,
//      missing keys inherit the new defaults.
//  (b) advisory drawdown-breaker breach notification fires ONCE per (user, account, source, day).

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-guard-enablement-${randomUUID()}.db`)}`;
});

vi.mock("../src/lib/vector-db", () => ({
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  retrieveContextDetailed: async () => [],
  defaultMinScore: () => 0.3,
  defaultRelevanceFloor: () => 0.3,
  defaultDedupeSimilarity: () => 0.6,
  formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
  storeContext: async () => {},
  storeContexts: async () => {},
  getCurrentVectorProviderAuthority: () => "test-provider",
  managedVectorLedgerAuthority: () => "test-ledger"
}));

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-guard-enablement-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.OPENROUTER_API_KEY;
});

describe("mergePolicy — tuning deep-merge (db-profiles runtime copy)", () => {
  it("a stored policy with NO tuning inherits every new default tuning key", async () => {
    const { mergePolicy } = await import("../src/lib/db-profiles");
    const merged = mergePolicy({});
    expect(merged.tuning).toEqual({
      riskReceipts: true,
      volTargeting: true,
      targetPortfolioVolPct: 25,
      portfolioHeatBudgetPct: 10,
      // Owner ruling 2026-09-24 (board 687a5fb4): deRiskExitsOnAdversaryUnavailable default
      // flipped ON — see test/model-defaults-derisk-exits.test.ts for dedicated coverage.
      deRiskExitsOnAdversaryUnavailable: true
    });
  });

  it("explicit stored tuning keys WIN over the new defaults; missing keys still inherit", async () => {
    const { mergePolicy } = await import("../src/lib/db-profiles");
    const merged = mergePolicy({ tuning: { volTargeting: false, targetPortfolioVolPct: 40 } });
    expect(merged.tuning?.volTargeting).toBe(false); // explicit opt-out preserved
    expect(merged.tuning?.targetPortfolioVolPct).toBe(40); // explicit value preserved
    expect(merged.tuning?.riskReceipts).toBe(true); // inherited default
    expect(merged.tuning?.portfolioHeatBudgetPct).toBe(10); // inherited default
  });

  it("an explicit maxQuoteAgeSec of 0 (gate off) survives the merge; default is 120", async () => {
    const { mergePolicy } = await import("../src/lib/db-profiles");
    expect(mergePolicy({}).maxQuoteAgeSec).toBe(120);
    expect(mergePolicy({ maxQuoteAgeSec: 0 }).maxQuoteAgeSec).toBe(0);
  });

  it("riskRules deep-merge: default maxDrawdownPct 15 inherited, explicit value wins, action stays advisory", async () => {
    const { mergePolicy } = await import("../src/lib/db-profiles");
    const inherited = mergePolicy({});
    expect(inherited.riskRules.maxDrawdownPct).toBe(15);
    expect(inherited.riskRules.drawdownBreakerAction).toBeUndefined(); // unset = advisory
    const explicit = mergePolicy({ riskRules: { maxDrawdownPct: 25 } });
    expect(explicit.riskRules.maxDrawdownPct).toBe(25);
    expect(explicit.riskRules.stopLossPct).toBe(8); // untouched defaults still merge through
  });
});

function zeroProposalFetchStub() {
  return async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("openrouter.ai") || href.includes("api.openai.com")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ proposals: [] }) } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (href.includes("nasdaq.com")) {
      return new Response(
        JSON.stringify({
          data: {
            asof: "2026-06-30",
            table: { rows: [{ symbol: "AAPL", lastsale: "$200", pctchange: "1%", volume: "1000000", marketCap: "3000000000000", sector: "Technology", industry: "Consumer Electronics" }] }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  };
}

describe("advisory drawdown-breaker notification (dedup per user/account/source/day)", () => {
  it("notifies on the first breach of the day and NOT again the same day", async () => {
    process.env.OPENROUTER_API_KEY = "test-openai-key";
    vi.stubGlobal("fetch", zeroProposalFetchStub());

    const { upsertConnectedAccount, setActiveConnectedAccount, setPolicy, upsertUserApiKey, listAudit, listNotificationEvents } = await import("../src/lib/db");
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");

    upsertUserApiKey("local", "openrouter", "test-openai-key", "test fixture");
    const accountId = randomUUID();
    upsertConnectedAccount({ id: accountId, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "Test Account", isActive: true });
    setActiveConnectedAccount(accountId);

    // Persist a HIGH high-water mark so the run observes a ~60% drawdown — breaching both the
    // explicit 20% fixture limit and the new 15% default.
    recordAndEvaluateDrawdownBreaker({
      accountNumber: "TEST",
      source: "paper",
      equity: 250_000,
      riskRules: { maxDrawdownPct: 20 },
      userId: "local"
    });

    setPolicy({
      ...DEFAULT_POLICY,
      systemState: "active",
      llmModel: "openai/gpt-4.1-mini",
      includedIndices: [],
      additionalSymbols: ["AAPL"],
      strategyAuthority: "decide",
      // Advisory mode (no drawdownBreakerAction) with an explicit limit.
      riskRules: { ...DEFAULT_POLICY.riskRules, maxDrawdownPct: 20 }
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");

    const first = await runStrategyOnce();
    expect(first.status).toBe("completed");

    const advisoriesAfterFirst = listNotificationEvents("local", 100).filter((e) => e.type === "risk_advisory");
    expect(advisoriesAfterFirst).toHaveLength(1);
    expect(advisoriesAfterFirst[0].title).toContain("Drawdown advisory");
    expect(advisoriesAfterFirst[0].title).toContain("agent still in control");

    // Second run the same day: the breach is still evaluated (receipt + prompt context each run)
    // but the owner is NOT notified again.
    const second = await runStrategyOnce();
    expect(second.status).toBe("completed");

    expect(listNotificationEvents("local", 100).filter((e) => e.type === "risk_advisory")).toHaveLength(1);
    const drawdownAudits = listAudit(500).filter((e) => e.kind === "policy_violation_drawdown");
    expect(drawdownAudits.length).toBeGreaterThanOrEqual(2); // one receipt per breaching run
  }, 150_000);

  it("does NOT deliver when the user has risk_advisory switched off — real toggle, no force-include (owner ruling 2026-08-12)", async () => {
    process.env.OPENROUTER_API_KEY = "test-openai-key";
    vi.stubGlobal("fetch", zeroProposalFetchStub());

    const { upsertConnectedAccount, setActiveConnectedAccount, setPolicy, upsertUserApiKey, listNotificationEvents } = await import("../src/lib/db");
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");

    upsertUserApiKey("local", "openrouter", "test-openai-key", "test fixture");
    const accountId = randomUUID();
    upsertConnectedAccount({ id: accountId, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "Test Account", isActive: true });
    setActiveConnectedAccount(accountId);

    recordAndEvaluateDrawdownBreaker({
      accountNumber: "TEST",
      source: "paper",
      equity: 250_000,
      riskRules: { maxDrawdownPct: 20 },
      userId: "local"
    });

    setPolicy({
      ...DEFAULT_POLICY,
      systemState: "active",
      llmModel: "openai/gpt-4.1-mini",
      includedIndices: [],
      additionalSymbols: ["AAPL"],
      strategyAuthority: "decide",
      riskRules: { ...DEFAULT_POLICY.riskRules, maxDrawdownPct: 20 },
      // The user explicitly turned risk_advisory off in Settings. Before the owner's 2026-08-12
      // "ALL toggles must be real" ruling, the drawdown-advisory send site force-injected
      // risk_advisory into the effective enabledEvents regardless, silently overriding this
      // forever. That pattern is removed (a one-time migration — db.ts migration 78 — backfills
      // any LEGACY stored array that predates the event type instead), so an explicit, deliberate
      // opt-out like this one must now be honored and stay honored.
      notificationSettings: { webhookUrl: "", enabledEvents: ["fill", "block"] }
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    const advisories = listNotificationEvents("local", 100).filter((e) => e.type === "risk_advisory");
    expect(advisories).toHaveLength(1);
    expect(advisories[0].error).toBe("Notification type is disabled.");
  }, 150_000);
});
