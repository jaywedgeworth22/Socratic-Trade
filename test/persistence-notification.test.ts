import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { LLM_OUTPUT_TOKEN_CAPS, LLM_REQUEST_DEFAULTS } from "../src/lib/llm-request";

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => ["SEC 8-K filing for AAPL.\nReported item(s): Item 2.02 Results of Operations and Financial Condition."],
  retrieveContextDetailed: async () => [{ id: "c1", text: "SEC 8-K filing for AAPL.\nReported item(s): Item 2.02 Results of Operations and Financial Condition.", source: "sec", as_of: null, score: 0.9, url: null }],
  defaultMinScore: () => 0.3,
  defaultRelevanceFloor: () => 0.3,
  defaultDedupeSimilarity: () => 0.6,
  formatChunkWithProvenance: (chunk: { text: string }, symbol?: string) => (symbol ? `[${symbol}]\n${chunk.text}` : chunk.text),
  storeContext: async () => {},
  storeContexts: async () => {}
}));
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-test-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function seedLocalOpenAiKey(): Promise<() => void> {
  const { deleteUserApiKey, upsertUserApiKey } = await import("../src/lib/db");
  upsertUserApiKey("local", "openrouter", "test-openai-key", "test fixture");
  return () => deleteUserApiKey("local", "openrouter");
}

describe("persistence and notifications", () => {
  it("counts reviewed estimated notional for share-quantity market orders", async () => {
    const { dailyExecutionStats, insertProposal } = await import("../src/lib/db");
    insertProposal({
      id: randomUUID(),
      runId: "run-1",
      accountNumber: "A1",
      proposal: {
        symbol: "AAPL",
        side: "buy",
        type: "market",
        quantity: 0.05,
        timeInForce: "gfd",
        marketHours: "regular_hours",
        rationale: "test"
      },
      decision: { approved: true, reasons: [] },
      review: { estimatedNotional: 10, alerts: [], raw: {} },
      estimatedNotional: 10,
      status: "paper"
    });

    expect(dailyExecutionStats("A1").notional).toBe(10);
  });

  it("rejects overlapping strategy run locks", async () => {
    const { acquireStrategyLock, releaseStrategyLock } = await import("../src/lib/db");
    expect(acquireStrategyLock("owner1")).toBe(true);
    expect(acquireStrategyLock("owner2")).toBe(false);
    releaseStrategyLock("owner1");
    expect(acquireStrategyLock("owner3")).toBe(true);
    releaseStrategyLock("owner3");
  });

  it("keeps strategy run locks isolated per user", async () => {
    const { acquireStrategyLock, releaseStrategyLock } = await import("../src/lib/db");
    const userA = `lock-a-${randomUUID()}`;
    const userB = `lock-b-${randomUUID()}`;

    expect(acquireStrategyLock("owner-a", userA)).toBe(true);
    expect(acquireStrategyLock("owner-b", userB)).toBe(true);
    expect(acquireStrategyLock("owner-a2", userA)).toBe(false);

    releaseStrategyLock("owner-a", userA);
    releaseStrategyLock("owner-b", userB);
  });

  it("strips legacy dryRun/paperMode keys from old stored policy JSON instead of leaking them", async () => {
    const { getPolicy, setSetting } = await import("../src/lib/db");
    setSetting("policy", { ...DEFAULT_POLICY, dryRun: true, paperMode: false, paperStartingCash: 5000 });

    const policy = getPolicy() as typeof DEFAULT_POLICY & { dryRun?: boolean; paperMode?: boolean; paperStartingCash?: number };

    // These fields were removed entirely — an account's own `environment` (paper/live) is the sole
    // source of truth for execution mode now, not a policy-level override. Old rows that still carry
    // them must not leak the stale values back out.
    expect(policy.dryRun).toBeUndefined();
    expect(policy.paperMode).toBeUndefined();
    expect(policy.paperStartingCash).toBeUndefined();
  });

  it("activates strategy profiles without corrupting user-scoped settings", async () => {
    const userId = `profile-user-${randomUUID()}`;
    const { createStrategyProfile, getStrategyPrompt } = await import("../src/lib/db");

    createStrategyProfile({ name: "Active Test", prompt: "profile prompt", active: true }, userId);

    expect(getStrategyPrompt(userId)).toBe("profile prompt");
  });

  it("keeps connected account credentials server-only and preserves them on metadata edits", async () => {
    const accountId = randomUUID();
    const { getActiveConnectedAccount, listConnectedAccounts, setActiveConnectedAccount, upsertConnectedAccount } = await import("../src/lib/db");

    upsertConnectedAccount({
      id: accountId,
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-TEST",
      label: "Alpaca Test",
      apiKey: "key-123",
      apiSecret: "secret-456",
      baseUrl: "https://paper-api.alpaca.markets/v2",
      isActive: true
    });

    const listed = listConnectedAccounts().find((account) => account.id === accountId);
    expect(listed?.apiKey).toBeUndefined();
    expect(listed?.apiSecret).toBeUndefined();
    expect(listed?.baseUrl).toBe("https://paper-api.alpaca.markets/v2");
    expect(getActiveConnectedAccount()?.apiKey).toBe("key-123");
    expect(getActiveConnectedAccount()?.apiSecret).toBe("secret-456");
    expect(getActiveConnectedAccount()?.baseUrl).toBe("https://paper-api.alpaca.markets/v2");

    upsertConnectedAccount({
      id: accountId,
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-TEST",
      label: "Renamed Alpaca",
      baseUrl: "https://paper-api.alpaca.markets/v2",
      isActive: true
    });

    expect(getActiveConnectedAccount()?.label).toBe("Renamed Alpaca");
    expect(getActiveConnectedAccount()?.apiKey).toBe("key-123");
    expect(getActiveConnectedAccount()?.baseUrl).toBe("https://paper-api.alpaca.markets/v2");
    expect(() => setActiveConnectedAccount("missing-account")).toThrow("Connected account not found.");
    expect(getActiveConnectedAccount()?.id).toBe(accountId);

  });

  it("derives broker/paper execution state purely from the connected account's own environment", async () => {
    const userId = `execution-mode-user-${randomUUID()}`;
    const accountId = randomUUID();
    const { getActiveConnectedAccount, getPolicy, setPolicy, upsertConnectedAccount } = await import("../src/lib/db");
    const { deriveExecutionState } = await import("../src/lib/execution-mode");

    upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "APCA-PAPER-TEST",
      label: "Alpaca Paper",
      isActive: true
    });
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "APCA-PAPER-TEST", activeBroker: "alpaca" }, userId);

    const policy = getPolicy(userId);
    const activeAccount = getActiveConnectedAccount(userId);
    const executionState = deriveExecutionState(policy, activeAccount);

    expect(policy.activeBroker).toBe("alpaca");
    expect(policy.connectedAccountId).toBe(accountId);
    expect(executionState.mode).toBe("broker/paper");
    expect(executionState.clarification).toContain("Alpaca Paper");
  });

  it("resolves user API keys before env fallback and reports the source", async () => {
    const originalFinnhubKey = process.env.FINNHUB_API_KEY;
    process.env.FINNHUB_API_KEY = "env-finnhub";
    try {
      const { deleteUserApiKey, resolveApiKey, resolveApiKeyWithSource, upsertUserApiKey } = await import("../src/lib/db");
      const userId = `key-user-${randomUUID()}`;

      expect(resolveApiKeyWithSource("finnhub", userId)).toMatchObject({ key: "env-finnhub", source: "env", envVar: "FINNHUB_API_KEY" });

      upsertUserApiKey(userId, "FINNHUB_API_KEY", "user-finnhub");
      expect(resolveApiKey("finnhub", userId)).toBe("user-finnhub");
      expect(resolveApiKeyWithSource("finnhub", userId)).toMatchObject({ key: "user-finnhub", source: "user" });

      deleteUserApiKey(userId, "finnhub");
      expect(resolveApiKeyWithSource("finnhub", userId)).toMatchObject({ key: "env-finnhub", source: "env" });
    } finally {
      if (originalFinnhubKey) process.env.FINNHUB_API_KEY = originalFinnhubKey;
      else delete process.env.FINNHUB_API_KEY;
    }
  });

  it("writes one strategy_run audit event from runStrategyOnce", async () => {
    const originalOpenAiKey = process.env.OPENROUTER_API_KEY;
    let cleanupOpenAiKey: (() => void) | undefined;
    // Seed a key + stub the LLM so the run completes (0 proposals). The strategy session now
    // requires a resolvable LLM credential — without one runStrategyOnce returns "failed" — and
    // this test only needs the run to complete to assert the audit event was written.
    process.env.OPENROUTER_API_KEY = "test-openai-key";
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      if (String(url).includes("openrouter.ai") || String(url).includes("api.openai.com")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ proposals: [] }) } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (String(url).includes("nasdaq.com")) {
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

    try {
      cleanupOpenAiKey = await seedLocalOpenAiKey();
      const { listAudit, setPolicy, upsertConnectedAccount, setActiveConnectedAccount } = await import("../src/lib/db");
      const { runStrategyOnce } = await import("../src/lib/strategy");
      
      const mockAccountId = randomUUID();
      upsertConnectedAccount({
        id: mockAccountId,
        userId: "local",
        broker: "test",
        environment: "paper",
        accountNumber: "TEST",
        label: "Test Account",
        isActive: true
      });
      setActiveConnectedAccount(mockAccountId);

      setPolicy({
        ...DEFAULT_POLICY,
        systemState: "active",
        // Classic model so request-body assertions check temperature + exact caps
        // (reasoning-model bounds are covered by test/llm-request.test.ts).
        llmModel: "openai/gpt-4o-mini",
        includedIndices: [],
        additionalSymbols: ["AAPL"],
        strategyAuthority: "decide"
      });
      const before = listAudit(200).filter((event) => event.kind === "strategy_run").length;
      const result = await runStrategyOnce();
      const after = listAudit(200).filter((event) => event.kind === "strategy_run").length;
      expect(result.status).toBe("completed");
      expect(after).toBe(before + 1);
    } finally {
      cleanupOpenAiKey?.();
      if (originalOpenAiKey) process.env.OPENROUTER_API_KEY = originalOpenAiKey;
      else delete process.env.OPENROUTER_API_KEY;
    }
  }, 30_000);

  it("records a failed Green Team LLM step when the proposal request times out", async () => {
    const originalOpenAiKey = process.env.OPENROUTER_API_KEY;
    let cleanupOpenAiKey: (() => void) | undefined;
    process.env.OPENROUTER_API_KEY = "test-openai-key";
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const href = String(url);
      if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) {
        throw new Error("The operation was aborted due to timeout");
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

    try {
      cleanupOpenAiKey = await seedLocalOpenAiKey();
      const { listAudit, setPolicy, upsertConnectedAccount, setActiveConnectedAccount } = await import("../src/lib/db");
      const { runStrategyOnce } = await import("../src/lib/strategy");

      const mockAccountId = randomUUID();
      upsertConnectedAccount({
        id: mockAccountId,
        userId: "local",
        broker: "test",
        environment: "paper",
        accountNumber: "TEST",
        label: "Timeout Test Account",
        isActive: true
      });
      setActiveConnectedAccount(mockAccountId);
      setPolicy({
        ...DEFAULT_POLICY,
        systemState: "active",
        llmModel: "openai/gpt-5.5",
        llmReasoningEffort: "high",
        includedIndices: [],
        additionalSymbols: ["AAPL"],
        strategyAuthority: "decide"
      });

      const result = await runStrategyOnce();
      expect(result.status).toBe("failed");
      // gpt-5.5 is a reasoning model, so the strategy call gets the reasoning-class-aware timeout
      // (150s) rather than the base 60s — the message reports the actual bound that elapsed.
      expect(result.summary).toContain("Green Team proposal timed out after 150s using OpenRouter gpt-5.5");
      expect(result.llmSteps).toMatchObject([
        {
          step: "bull",
          label: "Green Team proposal",
          provider: "openai",
          model: "gpt-5.5",
          status: "failed"
        }
      ]);

      const audit = listAudit(200);
      const stepEvents = audit
        .filter((event) => event.kind === "llm_step")
        .map((event) => event.payload as { runId?: string; status?: string; reason?: string })
        .filter((payload) => payload.runId === result.runId);
      expect(stepEvents.map((event) => event.status).sort()).toEqual(["failed", "started"]);
      expect(stepEvents.find((event) => event.status === "failed")?.reason).toContain("Lower reasoning effort");

      const runAudit = audit
        .filter((event) => event.kind === "strategy_run")
        .map((event) => event.payload as { runId?: string; llmSteps?: unknown[] })
        .find((payload) => payload.runId === result.runId);
      expect(runAudit?.llmSteps).toMatchObject([{ step: "bull", status: "failed" }]);
    } finally {
      cleanupOpenAiKey?.();
      if (originalOpenAiKey) process.env.OPENROUTER_API_KEY = originalOpenAiKey;
      else delete process.env.OPENROUTER_API_KEY;
    }
  }, 30_000);

  it("records a pre-run portfolio snapshot before any proposals execute", async () => {
    const originalOpenAiKey = process.env.OPENROUTER_API_KEY;
    let cleanupOpenAiKey: (() => void) | undefined;
    // Seed a key + stub the LLM to return 0 proposals → the run completes as a no-op. (The strategy
    // session now requires a resolvable LLM credential; without one runStrategyOnce returns "failed".)
    // We just need to verify a pre-run snapshot was written with the run's runId.
    process.env.OPENROUTER_API_KEY = "test-openai-key";
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const href = String(url);
      if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ proposals: [] }) } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (href.includes("nasdaq.com")) {
        return new Response(
          JSON.stringify({
            data: {
              asof: "2026-06-21",
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

    try {
      cleanupOpenAiKey = await seedLocalOpenAiKey();
      const { listPortfolioSnapshots, setPolicy, upsertConnectedAccount, setActiveConnectedAccount } = await import("../src/lib/db");
      const { runStrategyOnce } = await import("../src/lib/strategy");

      const mockAccountId = randomUUID();
      // The test broker's getAccounts() always returns accountNumber "TEST", so the policy
      // must also reference "TEST" for the account-selection check to pass.
      upsertConnectedAccount({
        id: mockAccountId,
        userId: "local",
        broker: "test",
        environment: "paper",
        accountNumber: "TEST",
        label: "Pre-Snapshot Test Account",
        isActive: true
      });
      setActiveConnectedAccount(mockAccountId);
      setPolicy({
        ...DEFAULT_POLICY,
        systemState: "active",
        // Classic model so request-body assertions check temperature + exact caps
        // (reasoning-model bounds are covered by test/llm-request.test.ts).
        llmModel: "openai/gpt-4o-mini",
        includedIndices: [],
        additionalSymbols: ["AAPL"],
        strategyAuthority: "decide"
      });

      const snapshotsBefore = listPortfolioSnapshots("TEST").length;
      const result = await runStrategyOnce();
      expect(result.status).toBe("completed");
      // After the run, at least two snapshots must exist (pre-run + post-run).
      const snapshotsAfter = listPortfolioSnapshots("TEST");
      expect(snapshotsAfter.length).toBeGreaterThan(snapshotsBefore);
      // The pre-run snapshot is the first snapshot written for this runId.
      const runSnapshots = snapshotsAfter.filter((s) => s.runId === result.runId);
      expect(runSnapshots.length).toBeGreaterThanOrEqual(2);
    } finally {
      cleanupOpenAiKey?.();
      if (originalOpenAiKey) process.env.OPENROUTER_API_KEY = originalOpenAiKey;
      else delete process.env.OPENROUTER_API_KEY;
    }
  }, 20_000);

  it("sends retrieved context in user content instead of the stable system prompt", async () => {
    const originalOpenAiKey = process.env.OPENROUTER_API_KEY;
    let cleanupOpenAiKey: (() => void) | undefined;
    process.env.OPENROUTER_API_KEY = "test-openai-key";
    const openAiBodies: any[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) {
        openAiBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ proposals: [] }) } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
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

    try {
      cleanupOpenAiKey = await seedLocalOpenAiKey();
      const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount } = await import("../src/lib/db");
      const { runStrategyOnce } = await import("../src/lib/strategy");

      const mockAccountId = randomUUID();
      upsertConnectedAccount({
        id: mockAccountId,
        userId: "local",
        broker: "test",
        environment: "paper",
        accountNumber: "TEST",
        label: "Prompt Test Account",
        isActive: true
      });
      setActiveConnectedAccount(mockAccountId);
      setPolicy({
        ...DEFAULT_POLICY,
        systemState: "active",
        // Classic model so request-body assertions check temperature + exact caps
        // (reasoning-model bounds are covered by test/llm-request.test.ts).
        llmModel: "openai/gpt-4o-mini",
        includedIndices: [],
        additionalSymbols: ["AAPL"],
        strategyAuthority: "decide"
      });

      await runStrategyOnce();

      // Single-adversary consolidation: the in-flow Bear was DELETED, so a zero-proposal run makes
      // exactly ONE LLM call (the Bull). The Red Team review only runs per risk-adding opening —
      // its request bounds are covered by test/red-team.test.ts.
      expect(openAiBodies).toHaveLength(1);
      expect(openAiBodies[0].max_completion_tokens).toBe(LLM_OUTPUT_TOKEN_CAPS.strategyProposal);
      // The Bull (proposer) stays deterministic, greedy temp-0.
      expect(openAiBodies[0].temperature).toBe(LLM_REQUEST_DEFAULTS.deterministicTemperature);

      const bullBody = openAiBodies[0];
      const systemContent = bullBody.input.find((item: any) => item.role === "system")?.content ?? "";
      const userContent = JSON.parse(bullBody.input.find((item: any) => item.role === "user")?.content ?? "{}");
      expect(systemContent).toContain('Current executionMode is "broker/paper"');
      expect(userContent.executionMode).toBe("broker/paper");
      expect(userContent.executionModeClarification).toContain("deterministic fills");
      expect(userContent.executionModeClarification).toContain("not a product account");
      expect(systemContent).toContain("`retrievedFinancialContext`");
      expect(systemContent).not.toContain("Item 2.02 Results of Operations");
      expect(userContent.retrievedFinancialContext).toContain("Item 2.02 Results of Operations");
      // 2026-07-04 RAG quick-wins: strategy.ts now prefixes each retrieved chunk with a provenance
      // header (via formatChunkWithProvenance, stubbed above to prepend "[SYMBOL]") before joining
      // into ragContext, so the model sees which symbol each chunk came from and can cite it — the
      // original chunk text still survives verbatim as a substring (asserted above).
      // 2026-07-17 RAG-B10/B13: strategy.ts now wraps each symbol's chunks in a dossier header
      // ("### RAG Dossier for SYMBOL") before the provenance-prefixed chunks.
      expect(userContent.retrievedFinancialContext).toMatch(/^### RAG Dossier for AAPL/);
      for (const body of openAiBodies) {
        const content = body.input.find((item: any) => item.role === "user")?.content ?? "{}";
        expect(JSON.parse(content).executionMode).toBe("broker/paper");
      }
    } finally {
      cleanupOpenAiKey?.();
      if (originalOpenAiKey) process.env.OPENROUTER_API_KEY = originalOpenAiKey;
      else delete process.env.OPENROUTER_API_KEY;
    }
  });

  it("skips notification delivery when webhook URL is not configured", async () => {
    const { sendNotification } = await import("../src/lib/notifications");
    const event = await sendNotification({ type: "fill", title: "Fill", payload: { id: "1" } }, { policy: DEFAULT_POLICY });
    expect(event.status).toBe("skipped");
    expect(event.error).toBe("No notification channels enabled.");
  });

  it("bridges legacy notification events to direct email delivery", async () => {
    const { getDb, setNotifyPrefs } = await import("../src/lib/db");
    const { sendNotification } = await import("../src/lib/notifications");
    const userId = `notify-email-${randomUUID()}`;
    const calls: Array<{ url: string; body: unknown }> = [];

    vi.stubEnv("RESEND_API_KEY", "rk_test");
    vi.stubEnv("NOTIFY_EMAIL_FROM", "alerts@example.test");
    vi.stubGlobal(
      "fetch",
      (async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response("ok", { status: 200 });
      }) as typeof fetch
    );
    setNotifyPrefs(userId, { channels: ["email"], email: "ops@example.test" });

    const event = await sendNotification(
      {
        type: "fill",
        title: "AAPL fill",
        payload: { fill: { symbol: "AAPL", side: "buy", status: "filled", quantity: 1, notional: 123.45 } }
      },
      { policy: DEFAULT_POLICY, userId }
    );

    expect(event.status).toBe("sent");
    expect(event.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    const emailBody = calls[0]?.body as { text?: string };
    expect(emailBody).toMatchObject({
      from: "alerts@example.test",
      to: ["ops@example.test"],
      subject: "[Socratic-Trade] AAPL fill"
    });
    expect(String(emailBody.text)).toContain("AAPL");
    expect(String(emailBody.text)).toMatch(/\n\(sent by Socratic-Trade\)$/);
    const audit = getDb()
      .prepare("SELECT payload FROM audit_events WHERE user_id = ? AND kind = 'notify.sent' ORDER BY created_at DESC LIMIT 1")
      .get(userId) as { payload: string } | undefined;
    expect(JSON.parse(audit?.payload ?? "{}")).toMatchObject({ channel: "email", kind: "fill" });
  }, 15000);

  it("records notification events under the requested user", async () => {
    const { listNotificationEvents } = await import("../src/lib/db");
    const { sendNotification } = await import("../src/lib/notifications");
    const userId = `notify-user-${randomUUID()}`;

    const event = await sendNotification(
      { type: "fill", title: "User Fill", payload: { id: "n1" } },
      { policy: DEFAULT_POLICY, userId }
    );

    const events = listNotificationEvents(userId);
    expect(events[0]?.id).toBe(event.id);
    expect(listNotificationEvents("local").some((item) => item.id === event.id)).toBe(false);
  });

  it("records successful webhook delivery when configured", async () => {
    const { sendNotification } = await import("../src/lib/notifications");
    const event = await sendNotification(
      { type: "fill", title: "Fill", payload: { id: "2" } },
      {
        policy: {
          ...DEFAULT_POLICY,
          notificationSettings: { webhookUrl: "https://example.test/webhook?token=secret", enabledEvents: ["fill"] }
        },
        fetcher: async () => new Response(null, { status: 204 }),
        // Legacy webhook path re-validates its target with a real DNS lookup on every send
        // (SSRF/rebinding hardening — src/lib/egress-guard.ts). "example.test" is an
        // IANA-reserved, never-resolving host used deliberately; stub the resolver so this
        // test stays hermetic.
        resolveWebhookHost: async () => ["8.8.8.8"]
      }
    );

    expect(event.status).toBe("sent");
    expect(event.webhookUrl).toBe("https://example.test/webhook");
  });

  it("sanitizes custom Alpaca baseUrl and instantiates client correctly", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const { upsertConnectedAccount } = await import("../src/lib/db");
    const userId = `alpaca-base-url-user-${randomUUID()}`;
    const accountId = randomUUID();

    upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-URL-TEST",
      label: "Custom Alpaca",
      apiKey: "PK-KEY",
      baseUrl: "https://custom-alpaca-endpoint.com/v2/",
      isActive: true
    });

    const gateway1 = getAlpacaGateway(userId);
    expect(((gateway1 as any).alpaca).configuration.baseUrl).toBe("https://custom-alpaca-endpoint.com");
  });

  it("does not fall back to generic Alpaca keys for a selected connected account with missing credentials", async () => {
    const originalPaperKey = process.env.ALPACA_PAPER_API_KEY;
    const originalPaperSecret = process.env.ALPACA_PAPER_SECRET_KEY;
    process.env.ALPACA_PAPER_API_KEY = "PK-OTHER-ACCOUNT";
    process.env.ALPACA_PAPER_SECRET_KEY = "other-secret";
    try {
      const { getAlpacaGateway } = await import("../src/lib/alpaca");
      const { upsertConnectedAccount } = await import("../src/lib/db");
      const userId = `alpaca-missing-key-user-${randomUUID()}`;

      upsertConnectedAccount({
        id: randomUUID(),
        userId,
        broker: "alpaca",
        environment: "live",
        accountNumber: "294709855",
        label: "Roth IRA",
        baseUrl: "https://api.alpaca.markets",
        isActive: true
      });

      expect(() => getAlpacaGateway(userId)).toThrow(/Alpaca credentials are missing for Roth IRA/);
    } finally {
      if (originalPaperKey) process.env.ALPACA_PAPER_API_KEY = originalPaperKey;
      else delete process.env.ALPACA_PAPER_API_KEY;
      if (originalPaperSecret) process.env.ALPACA_PAPER_SECRET_KEY = originalPaperSecret;
      else delete process.env.ALPACA_PAPER_SECRET_KEY;
    }
  });

  it("binds Alpaca credentials to the targeted connected account, not only the active one", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const { upsertConnectedAccount } = await import("../src/lib/db");
    const userId = `alpaca-target-user-${randomUUID()}`;
    const paperId = randomUUID();
    const rothId = randomUUID();

    upsertConnectedAccount({
      id: paperId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PAPER-ACTIVE",
      label: "Alpaca Paper",
      apiKey: "PK-PAPER",
      apiSecret: "paper-secret",
      isActive: true
    });
    upsertConnectedAccount({
      id: rothId,
      userId,
      broker: "alpaca",
      environment: "live",
      accountNumber: "ROTH-TARGET",
      label: "Roth IRA",
      apiKey: "PK-ROTH",
      apiSecret: "roth-secret",
      baseUrl: "https://api.alpaca.markets",
      isActive: false
    });

    const gateway = getAlpacaGateway(userId, rothId);
    const config = ((gateway as unknown as { alpaca: { configuration: { keyId?: string; oauth?: string; baseUrl?: string } } }).alpaca)
      .configuration;
    expect(config.keyId).toBe("PK-ROTH");
    expect(config.baseUrl).toBe("https://api.alpaca.markets");
  });
});
