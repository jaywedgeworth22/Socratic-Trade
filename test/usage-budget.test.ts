import { describe, expect, it, beforeEach, afterEach, afterAll } from "vitest";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import path from "path";
import os from "os";

const tmpDir = path.join(os.tmpdir(), `trading-test-usage-budget-${Date.now()}`);
const tmpDbPath = path.join(tmpDir, "test.db");
if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
process.env.DATABASE_URL = `file:${tmpDbPath}`;

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(`${tmpDbPath}${suffix}`); } catch { /* best-effort */ }
  }
});

const budget = await import("../src/lib/usage-budget");
const { DEFAULT_POLICY } = await import("../src/lib/defaults");
const { listNotificationEvents } = await import("../src/lib/db-notifications");

const { upsertUserApiKey, deleteUserApiKey } = await import("../src/lib/db-api-keys");

const BASE = "https://usage.example.test";
const TOKEN = "test-token";

type BudgetStatus = Awaited<ReturnType<typeof budget.getBudgetStatusCached>>;

function status(providers: Array<{
  name: string;
  status: "ok" | "warning" | "exceeded" | "unconfigured";
  spentUsd?: number;
  monthlyBudgetUsd?: number;
  projectedEomUsd?: number | null;
  projectedRunoutDate?: string | null;
  spendCoverage?: string | null;
}>): NonNullable<BudgetStatus> {
  return {
    generatedAt: new Date().toISOString(),
    month: "2026-07",
    providers: providers.map((p) => ({
      name: p.name,
      status: p.status,
      monthlyBudgetUsd: p.monthlyBudgetUsd ?? 100,
      spentUsd: p.spentUsd ?? 0,
      remainingUsd: null,
      percentUsed: null,
      projectedEomUsd: p.projectedEomUsd ?? null,
      projectedRunoutDate: p.projectedRunoutDate ?? null,
      spendCoverage: p.spendCoverage ?? null,
    })),
    summary: {
      totalBudgetUsd: 100,
      totalSpentUsd: 0,
      remainingUsd: 100,
      percentUsed: 0,
      overBudget: providers.some((p) => p.status === "exceeded"),
      warning: providers.some((p) => p.status === "warning"),
    },
  };
}

describe("usage-budget: cheaperModel", () => {
  // 2026-09-18 catalog cleanup: gpt-4o / gpt-mini-latest / gpt-5.4-nano were removed. The OpenAI
  // downgrade chain now ends at gpt-5.6-luna (the cheapest remaining OpenAI row), so any
  // premium OpenAI slug — including historical/persisted ones that no longer match the catalog —
  // downgrades to gpt-5.6-luna instead of falling off into "no cheaper model".
  it("maps known models down a tier and returns undefined when none", () => {
    expect(budget.cheaperModel("openai/gpt-4o")).toBe("openai/gpt-5.6-luna");
    expect(budget.cheaperModel("anthropic/claude-opus-4-8")).toBe("anthropic/claude-sonnet-latest");
    expect(budget.cheaperModel("anthropic/claude-opus-5-5")).toBeUndefined(); // owner rule (#3705): Opus 5.5 never downgrades on budget exhaustion
    expect(budget.cheaperModel("claude-opus-5.5")).toBeUndefined(); // owner rule (#3705): Opus 5.5 never downgrades on budget exhaustion
    expect(budget.cheaperModel("claude-haiku-4-5-20251001")).toBeUndefined(); // already cheapest (prefix)
    expect(budget.cheaperModel("openai/gpt-5.4-nano")).toBe("openai/gpt-5.6-luna"); // historical; lands on luna
    expect(budget.cheaperModel("gpt-5.5")).toBe("gpt-5.6-luna");
    expect(budget.cheaperModel("grok-4.6")).toBe("grok-build-0.1");
    expect(budget.cheaperModel("x-ai/grok-4.6")).toBe("x-ai/grok-build-0.1");
    expect(budget.cheaperModel("muse-spark-1.3")).toBe("muse-glimmer-30b");
    expect(budget.cheaperModel("meta/muse-spark-1.3")).toBe("meta/muse-glimmer-30b");
    expect(budget.cheaperModel("minimax-m3")).toBeUndefined(); // no cheaper row in the catalog
    expect(budget.cheaperModel(undefined)).toBeUndefined();
  });
});

describe("usage-budget: evaluateBudgetForRun", () => {
  const savedFallback = process.env.LLM_OPERATOR_FALLBACK;
  beforeEach(() => {
    process.env.LLM_OPERATOR_FALLBACK = "off";
    upsertUserApiKey("local", "openai", "native-openai-placeholder");
    process.env.USAGE_MONITOR_BASE_URL = BASE;
    process.env.USAGE_INGEST_TOKEN = TOKEN;
    process.env.USAGE_BUDGET_ENFORCE = "on";
  });
  afterEach(() => {
    deleteUserApiKey("local", "openai");
    deleteUserApiKey("local", "openrouter");
    if (savedFallback === undefined) delete process.env.LLM_OPERATOR_FALLBACK;
    else process.env.LLM_OPERATOR_FALLBACK = savedFallback;
    delete process.env.USAGE_MONITOR_BASE_URL;
    delete process.env.USAGE_INGEST_TOKEN;
    delete process.env.USAGE_BUDGET_ENFORCE;
  });

  it("downgrades the model when the LLM provider is over budget", async () => {
    // 2026-09-18: premium OpenAI rows now downgrade all the way to gpt-5.6-luna (the cheapest
    // remaining OpenAI row in the curated catalog); the chain stops there, so a higher-tier slug
    // can't be downgraded further and a luna policy itself yields skip=true (see next test).
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "openai/gpt-4o", redTeamLlmModel: "openai/gpt-4o" },
      { status: status([{ name: "openai", status: "exceeded" }]) }
    );
    expect(decision.skip).toBe(false);
    expect(decision.downgraded).toBe(true);
    expect(decision.llmModel).toBe("openai/gpt-5.6-luna");
    expect(decision.redTeamLlmModel).toBe("openai/gpt-5.6-luna");
  });

  it("skips the cycle when over budget and already on the cheapest tier", async () => {
    // gpt-5.6-luna is the curated bottom of the OpenAI chain now (gpt-5.4-nano was removed).
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "openai/gpt-5.6-luna" },
      { status: status([{ name: "openai", status: "exceeded" }]) }
    );
    expect(decision.skip).toBe(true);
    expect(decision.downgraded).toBe(false);
  });

  it("still skips when green is cheapest even if the red model could be downgraded (F6)", async () => {
    // The red seat would downgrade (claude-opus-4-8 -> claude-sonnet-latest), but the green seat
    // is already at luna so the cycle is skipped per the F6 invariant.
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "openai/gpt-5.6-luna", redTeamLlmModel: "anthropic/claude-opus-4-8" },
      { status: status([{ name: "openai", status: "exceeded" }]) }
    );
    expect(decision.skip).toBe(true);
    expect(decision.downgraded).toBe(false);
  });

  it("makes NO decision when policy.llmModel is unset — the run fails closed before any spend (no-defaults)", async () => {
    // No llmModel → resolves to "" (owner directive 2026-07-07: no model default for anything,
    // ever); the run never sends an LLM request, so there is nothing to budget or downgrade.
    const decision = await budget.evaluateBudgetForRun(
      "local",
      {},
      { status: status([{ name: "openai", status: "exceeded" }]) }
    );
    expect(decision.skip).toBe(false);
    expect(decision.downgraded).toBe(false);
    expect(decision.llmModel).toBeUndefined();
  });

  it("does nothing when the LLM provider is under budget", async () => {
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "openai/gpt-4o" },
      { status: status([{ name: "openai", status: "ok" }, { name: "alpaca", status: "exceeded" }]) }
    );
    expect(decision.skip).toBe(false);
    expect(decision.downgraded).toBe(false);
  });

  it("is a no-op (fail-open) when enforcement is disabled", async () => {
    process.env.USAGE_BUDGET_ENFORCE = "off";
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "openai/gpt-4o" },
      { status: status([{ name: "openai", status: "exceeded" }]) }
    );
    expect(decision.skip).toBe(false);
    expect(decision.downgraded).toBe(false);
  });

  it("is a no-op when budget status is unavailable (monitor down)", async () => {
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "openai/gpt-4o" },
      { status: null }
    );
    expect(decision.skip).toBe(false);
    expect(decision.downgraded).toBe(false);
  });

  it("budgets native MiniMax independently from unrelated OpenRouter spend", async () => {
    const userId = "minimax-budget-user";
    upsertUserApiKey(userId, "minimax", "minimax-placeholder");
    const policy = { llmModel: "minimax-m3" };
    const overRouter = status([{ name: "openrouter", status: "exceeded" }, { name: "minimax", status: "ok" }]);
    try {
      expect(await budget.evaluateBudgetForRun(userId, policy, { status: overRouter })).toEqual({ skip: false, downgraded: false });
      expect(await budget.previewBudgetDecision(userId, policy, { status: overRouter })).toEqual({ skip: false, downgraded: false });
      const nativeExceeded = await budget.evaluateBudgetForRun(userId, policy, { status: status([{ name: "openrouter", status: "ok" }, { name: "minimax", status: "exceeded" }]) });
      expect(nativeExceeded.skip).toBe(true);
      expect(nativeExceeded.reason).toMatch(/minimax/);
      upsertUserApiKey(userId, "openrouter", "openrouter-placeholder");
      const routed = await budget.evaluateBudgetForRun(userId, policy, { status: overRouter });
      expect(routed.skip).toBe(true);
      expect(routed.reason).toMatch(/openrouter/);
    } finally {
      deleteUserApiKey(userId, "minimax");
      deleteUserApiKey(userId, "openrouter");
    }
  });

  it("enforces on openrouter when spend is booked there (universal routing)", async () => {
    upsertUserApiKey("local", "openrouter", "openrouter-placeholder");
    // gpt-5.6-luna is the new cheapest OpenAI row — already at the bottom, so over-OpenRouter
    // spend correctly skips rather than downgrade to a no-longer-existent cheaper tier.
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "openai/gpt-5.6-luna" },
      { status: status([{ name: "openrouter", status: "exceeded" }, { name: "openai", status: "ok" }]) }
    );
    expect(decision.skip).toBe(true);
    expect(decision.downgraded).toBe(false);
    expect(decision.reason).toMatch(/openrouter/i);
  });

  it("downgrades using OpenRouter status when its credential serves the run", async () => {
    upsertUserApiKey("local", "openrouter", "openrouter-placeholder");
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "openai/gpt-4o", redTeamLlmModel: "openai/gpt-4o" },
      { status: status([{ name: "openrouter", status: "exceeded" }, { name: "openai", status: "ok" }]) }
    );
    expect(decision.skip).toBe(false);
    expect(decision.downgraded).toBe(true);
    // 2026-09-18: OpenAI downgrade chain ends at gpt-5.6-luna.
    expect(decision.llmModel).toBe("openai/gpt-5.6-luna");
  });

  it("downgrades OpenRouter Muse Spark to Muse Glimmer when over budget", async () => {
    upsertUserApiKey("local", "openrouter", "openrouter-placeholder");
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "muse-spark-1.3" },
      { status: status([{ name: "openrouter", status: "exceeded" }]) }
    );
    expect(decision).toMatchObject({
      skip: false,
      downgraded: true,
      llmModel: "muse-glimmer-30b"
    });
  });
});

describe("usage-budget: getBudgetStatusCached", () => {
  const priorReadToken = process.env.USAGE_READ_TOKEN;
  beforeEach(() => {
    delete process.env.USAGE_READ_TOKEN;
  });
  afterEach(async () => {
    delete process.env.USAGE_MONITOR_BASE_URL;
    delete process.env.USAGE_INGEST_TOKEN;
    if (priorReadToken === undefined) delete process.env.USAGE_READ_TOKEN;
    else process.env.USAGE_READ_TOKEN = priorReadToken;
    budget.resetUsageBudgetCacheForTests();
    const { resetPeerLaneBackoffForTests } = await import("../src/lib/peer-lane-backoff");
    resetPeerLaneBackoffForTests();
  });

  it("fetches + parses the monitor response with bearer auth", async () => {
    process.env.USAGE_MONITOR_BASE_URL = BASE;
    process.env.USAGE_INGEST_TOKEN = TOKEN;
    let capturedAuth: string | null = null;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      capturedAuth = headers?.authorization ?? null;
      return new Response(JSON.stringify(status([{ name: "anthropic", status: "warning" }])), { status: 200 });
    }) as unknown as typeof fetch;

    const s = await budget.getBudgetStatusCached({ force: true, fetchImpl });
    expect(capturedAuth).toBe(`Bearer ${TOKEN}`);
    expect(s?.providers[0]?.name).toBe("anthropic");
    expect(s?.providers[0]?.status).toBe("warning");
  });

  it("returns null when unconfigured", async () => {
    const s = await budget.getBudgetStatusCached({ force: true });
    expect(s).toBeNull();
  });

  it("parses projectedEomUsd/projectedRunoutDate/spendCoverage forecast fields when present", async () => {
    process.env.USAGE_MONITOR_BASE_URL = BASE;
    process.env.USAGE_INGEST_TOKEN = TOKEN;
    const raw = {
      generatedAt: new Date().toISOString(),
      month: "2026-07",
      providers: [
        {
          name: "openai",
          status: "ok",
          monthlyBudgetUsd: 100,
          spentUsd: 20,
          remainingUsd: 80,
          percentUsed: 20,
          projectedEomUsd: 145.5,
          projectedRunoutDate: "2026-07-22",
          spendCoverage: "complete",
        },
      ],
      summary: { totalBudgetUsd: 100, totalSpentUsd: 20, remainingUsd: 80, percentUsed: 20, overBudget: false, warning: false },
    };
    const fetchImpl = (async () => new Response(JSON.stringify(raw), { status: 200 })) as unknown as typeof fetch;

    const s = await budget.getBudgetStatusCached({ force: true, fetchImpl });
    expect(s?.providers[0]?.projectedEomUsd).toBe(145.5);
    expect(s?.providers[0]?.projectedRunoutDate).toBe("2026-07-22");
    expect(s?.providers[0]?.spendCoverage).toBe("complete");
  });

  it("defaults forecast fields to null when the monitor response omits them (older monitor)", async () => {
    process.env.USAGE_MONITOR_BASE_URL = BASE;
    process.env.USAGE_INGEST_TOKEN = TOKEN;
    const fetchImpl = (async () => new Response(JSON.stringify(status([{ name: "openai", status: "ok" }])), { status: 200 })) as unknown as typeof fetch;

    const s = await budget.getBudgetStatusCached({ force: true, fetchImpl });
    expect(s?.providers[0]?.projectedEomUsd).toBeNull();
    expect(s?.providers[0]?.projectedRunoutDate).toBeNull();
    expect(s?.providers[0]?.spendCoverage).toBeNull();
  });

  it("does not stall a run on a slow UM — serves stale cache / fail-open (#2550)", async () => {
    process.env.USAGE_MONITOR_BASE_URL = BASE;
    process.env.USAGE_INGEST_TOKEN = TOKEN;
    const { recordPeerLaneSample, PEER_LANE_USAGE_MONITOR } = await import("../src/lib/peer-lane-backoff");
    recordPeerLaneSample(PEER_LANE_USAGE_MONITOR, 6900);
    recordPeerLaneSample(PEER_LANE_USAGE_MONITOR, 7100);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify(status([{ name: "openai", status: "ok" }])), { status: 200 });
    }) as unknown as typeof fetch;
    const s = await budget.getBudgetStatusCached({ fetchImpl });
    expect(s).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("usage-budget: checkBudgetAndAlert", () => {
  beforeEach(() => {
    process.env.USAGE_MONITOR_BASE_URL = BASE;
    process.env.USAGE_INGEST_TOKEN = TOKEN;
  });
  afterEach(() => {
    delete process.env.USAGE_MONITOR_BASE_URL;
    delete process.env.USAGE_INGEST_TOKEN;
  });

  it("records a budget_alert notification for an exceeded provider without throwing", async () => {
    const before = listNotificationEvents("local", 100).length;
    await expect(
      budget.checkBudgetAndAlert("local", DEFAULT_POLICY, {
        status: status([{ name: "anthropic", status: "exceeded", spentUsd: 120, monthlyBudgetUsd: 100 }]),
      })
    ).resolves.toBeUndefined();
    const after = listNotificationEvents("local", 100);
    expect(after.length).toBeGreaterThan(before);
    expect(after.some((n) => n.type === "budget_alert")).toBe(true);
  });

  it("suppresses a second alert for the same (user, provider, level) within the cooldown", async () => {
    const provider = `cooldown-provider-${Date.now()}`;
    const st = status([{ name: provider, status: "exceeded", spentUsd: 120, monthlyBudgetUsd: 100 }]);
    await budget.checkBudgetAndAlert("local", DEFAULT_POLICY, { status: st });
    const afterFirst = listNotificationEvents("local", 200).filter((n) => n.type === "budget_alert").length;

    await budget.checkBudgetAndAlert("local", DEFAULT_POLICY, { status: st });
    const afterSecond = listNotificationEvents("local", 200).filter((n) => n.type === "budget_alert").length;

    expect(afterSecond).toBe(afterFirst); // the second call was suppressed by the cooldown, no new alert
  });

  it("the alert cooldown survives a simulated process restart", async () => {
    const { flushDurableStateNow, resetDurableStateCacheForTests } = await import("../src/lib/durable-state");
    const provider = `restart-provider-${Date.now()}`;
    const st = status([{ name: provider, status: "exceeded", spentUsd: 120, monthlyBudgetUsd: 100 }]);

    await budget.checkBudgetAndAlert("local", DEFAULT_POLICY, { status: st });
    const afterFirst = listNotificationEvents("local", 200).filter((n) => n.type === "budget_alert").length;
    flushDurableStateNow(); // the cooldown's debounced write lands in SQLite

    // Simulate a restart: forget the in-memory durable-state cache (SQLite rows are untouched).
    resetDurableStateCacheForTests();

    await budget.checkBudgetAndAlert("local", DEFAULT_POLICY, { status: st });
    const afterSecond = listNotificationEvents("local", 200).filter((n) => n.type === "budget_alert").length;
    // A fresh process must still honor the cooldown recorded before the "restart" — no duplicate alert.
    expect(afterSecond).toBe(afterFirst);
  });

  it("alerts on a forecasted breach even when lagging MTD status is still ok", async () => {
    const provider = `forecast-provider-${Date.now()}`;
    // MTD spend is comfortably ok (20/100 = 20%), but the projected EOM spend (145) is well past
    // the 100 budget — the forecast-aware alert must still fire.
    const st = status([{
      name: provider,
      status: "ok",
      spentUsd: 20,
      monthlyBudgetUsd: 100,
      projectedEomUsd: 145,
      projectedRunoutDate: "2026-07-22",
    }]);
    const before = listNotificationEvents("local", 200).filter((n) => n.type === "budget_alert").length;
    await budget.checkBudgetAndAlert("local", DEFAULT_POLICY, { status: st });
    const after = listNotificationEvents("local", 200).filter((n) => n.type === "budget_alert").length;
    expect(after).toBeGreaterThan(before);
  });

  it("does not alert when MTD is ok and there is no forecasted breach", async () => {
    const provider = `no-breach-provider-${Date.now()}`;
    const st = status([{ name: provider, status: "ok", spentUsd: 10, monthlyBudgetUsd: 100, projectedEomUsd: 30 }]);
    const before = listNotificationEvents("local", 200).filter((n) => n.type === "budget_alert").length;
    await budget.checkBudgetAndAlert("local", DEFAULT_POLICY, { status: st });
    const after = listNotificationEvents("local", 200).filter((n) => n.type === "budget_alert").length;
    expect(after).toBe(before);
  });
});

describe("usage-budget: formatBudgetAdvisory", () => {
  it("returns undefined when status is null/undefined", () => {
    expect(budget.formatBudgetAdvisory(null)).toBeUndefined();
    expect(budget.formatBudgetAdvisory(undefined)).toBeUndefined();
  });

  it("returns undefined when every provider is ok/unconfigured (nothing worth mentioning)", () => {
    const s = status([{ name: "openai", status: "ok" }, { name: "anthropic", status: "unconfigured" }]);
    expect(budget.formatBudgetAdvisory(s)).toBeUndefined();
  });

  it("summarizes an exceeded provider with a downgrade/skip suggestion, not a command", () => {
    const s = status([{ name: "openai", status: "exceeded", spentUsd: 150, monthlyBudgetUsd: 100 }]);
    const line = budget.formatBudgetAdvisory(s);
    expect(line).toBeTruthy();
    expect(line).toContain("openai");
    expect(line).toContain("150.00");
    expect(line).toContain("$100");
    expect(line).toContain("status=exceeded");
    // Advisory language, not a directive — the agent decides.
    expect(line).toMatch(/worth weighing|your call/i);
  });

  it("summarizes a warning provider with a softer watch-it suggestion", () => {
    const s = status([{ name: "anthropic", status: "warning", spentUsd: 85, monthlyBudgetUsd: 100 }]);
    const line = budget.formatBudgetAdvisory(s);
    expect(line).toBeTruthy();
    expect(line).toContain("anthropic");
    expect(line).toContain("status=warning");
    expect(line).toMatch(/approaching|your call/i);
  });

  it("only mentions notable providers, silently omitting ok/unconfigured ones", () => {
    const s = status([
      { name: "openai", status: "ok" },
      { name: "anthropic", status: "exceeded", spentUsd: 200, monthlyBudgetUsd: 100 },
    ]);
    const line = budget.formatBudgetAdvisory(s);
    expect(line).toContain("anthropic");
    expect(line).not.toContain("openai");
  });

  it("surfaces a provider that's ok on lagging spend but forecasted to breach, with forecast fields", () => {
    const s = status([{
      name: "openai",
      status: "ok",
      spentUsd: 20,
      monthlyBudgetUsd: 100,
      projectedEomUsd: 145,
      projectedRunoutDate: "2026-07-22",
    }]);
    const line = budget.formatBudgetAdvisory(s);
    expect(line).toBeTruthy();
    expect(line).toContain("openai");
    expect(line).toContain("projected EOM $145.00");
    expect(line).toContain("projected runout 2026-07-22");
    expect(line).toContain("status=ok");
    expect(line).toContain("forecast=exceeded");
  });
});
