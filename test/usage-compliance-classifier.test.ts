/**
 * Usage-compliance Wave 2 (ST lane): OpenRouter classifier metadata + generation-id capture +
 * WS1 telemetry ingestion gaps. All offline; every provider HTTP call is stubbed.
 *
 * Covers:
 *   - buildLlmRequestBody / applyOpenRouterClassifierEnrichment: flat `trace` (NO nested
 *     `metadata` sub-object, NO bare top-level `metadata`), `user` <= 128 chars, fail-open on an
 *     unexpected enrichment error (a paid call must never break over telemetry metadata).
 *   - providerRequestIdFromPayload: OpenRouter-only generation-id extraction, `undefined` never "".
 *   - pushed telemetry events: `providerRequestId` passes through, and classifier keys are
 *     mirrored into event `metadata` — including for Voyage/SiliconFlow, which bypass OpenRouter
 *     and therefore get classifier context ONLY via the pushed event.
 *   - WS1 gap #1: market-signals/massive.ts raw fetches now route through fetchWithRetry and
 *     produce provider call-volume telemetry.
 *   - WS1 gap #2: rag/query-deconstruct.ts records LLM usage + enriches its OpenRouter request.
 *   - WS1 gap #3: rag/search-fusion.ts fetchAlternativeEmbedding meters via meterEmbed and
 *     enriches its OpenRouter request.
 */

import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from "vitest";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import path from "path";
import os from "os";

// Isolated temp SQLite (recordLlmUsage / logApiHealth write to the DB).
const tmpDir = path.join(os.tmpdir(), `trading-test-usage-compliance-${Date.now()}`);
const tmpDbPath = path.join(tmpDir, "test.db");
if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
process.env.DATABASE_URL = `file:${tmpDbPath}`;

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(`${tmpDbPath}${suffix}`); } catch { /* best-effort */ }
  }
});

const { buildLlmRequestBody, applyOpenRouterClassifierEnrichment } = await import("../src/lib/llm-call");
const { providerRequestIdFromPayload } = await import("../src/lib/llm-usage");
const push = await import("../src/lib/usage-monitor-push");

const BASE = "https://usage.example.test";
const TOKEN = "test-token";

interface CapturedRequest {
  url: string;
  rawBody: string;
  body: { events: Array<Record<string, unknown>> };
}

function makeMonitorFetchStub(captured: CapturedRequest[]) {
  return (async (url: unknown, init?: RequestInit) => {
    const rawBody = String(init?.body ?? "{}");
    captured.push({ url: String(url), rawBody, body: JSON.parse(rawBody) });
    return new Response(JSON.stringify({ ok: true, accepted: 1 }), { status: 202 });
  }) as unknown as typeof fetch;
}

const OR_SPEC = {
  model: "openai/gpt-4o-mini",
  systemPrompt: "You are a test.",
  userContent: "hello",
  maxOutputTokens: 100
};

describe("OpenRouter classifier enrichment (flat trace, RESOLVED 2026-07-18 shape)", () => {
  beforeEach(() => {
    process.env.USAGE_MONITOR_ENV = "test";
  });
  afterEach(() => {
    delete process.env.USAGE_MONITOR_ENV;
    vi.restoreAllMocks();
  });

  it("openrouter chat-completions body: top-level user + FLAT trace, no metadata anywhere", () => {
    const body = buildLlmRequestBody(
      { provider: "openrouter", transport: "chat-completions" },
      { ...OR_SPEC, userId: "local", keyRef: "fp1234", service: "rag", feature: "rag-query-deconstruct" }
    );
    expect(body.user).toBe("local");
    const trace = body.trace as Record<string, unknown>;
    expect(trace).toBeDefined();
    expect(trace.sourceApp).toBe("socratic-trade");
    expect(trace.environment).toBe("test");
    expect(trace.service).toBe("rag");
    // Internal tag "rag-query-deconstruct" is translated to the owner's OpenRouter classifier
    // taxonomy at the enrichment boundary (2026-08-10) — the ledger keeps the internal name.
    expect(trace.feature).toBe("search-fusion-mmr");
    expect(trace.keyRef).toBe("fp1234");
    // The RESOLVED shape: classifier keys sit FLAT under `trace` — never a `metadata` sub-object,
    // and never a bare top-level `metadata` field (the pre-Wave-2 shape this replaces).
    expect(trace.metadata).toBeUndefined();
    expect(body.metadata).toBeUndefined();
    // gitSha rides along only when the runtime exposes a commit sha env (e.g. GITHUB_SHA in CI).
    if (trace.gitSha !== undefined) expect(String(trace.gitSha)).toMatch(/^[a-f0-9]{7,64}$/i);
  });

  it("caps user at 128 chars instead of throwing (OpenRouter documented limit)", () => {
    const body = buildLlmRequestBody(
      { provider: "openrouter", transport: "chat-completions" },
      { ...OR_SPEC, userId: "u".repeat(200), feature: "x" }
    );
    expect(String(body.user)).toHaveLength(128);
    expect((body.trace as Record<string, unknown>).sourceApp).toBe("socratic-trade");
  });

  it("omits user entirely when userId is absent or blank — never an empty string", () => {
    const noUser = buildLlmRequestBody({ provider: "openrouter", transport: "chat-completions" }, { ...OR_SPEC, feature: "x" });
    expect("user" in noUser).toBe(false);
    const blankUser = buildLlmRequestBody(
      { provider: "openrouter", transport: "chat-completions" },
      { ...OR_SPEC, userId: "   ", feature: "x" }
    );
    expect("user" in blankUser).toBe(false);
    expect((blankUser.trace as Record<string, unknown>).sourceApp).toBe("socratic-trade");
  });

  it("fail-open: an unexpected enrichment error degrades to an un-enriched body, never a throw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const base: Record<string, unknown> = { model: "openai/gpt-4o-mini" };
    // A non-string userId (impossible per types, simulating an unexpected runtime shape) makes the
    // shared zod builder throw — the wrapper must catch, log, and leave the body un-enriched.
    expect(() =>
      applyOpenRouterClassifierEnrichment(base, { userId: 42 as unknown as string, feature: "x" })
    ).not.toThrow();
    expect(base.trace).toBeUndefined();
    expect(base.user).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("non-OpenRouter providers are untouched by the classifier: OpenAI gets bare user, Anthropic gets metadata.user_id, neither gets trace", () => {
    const openai = buildLlmRequestBody(
      { provider: "openai", transport: "chat-completions" },
      { ...OR_SPEC, model: "gpt-4o-mini", userId: "local", feature: "x" }
    );
    expect(openai.user).toBe("local");
    expect(openai.trace).toBeUndefined();

    const anthropic = buildLlmRequestBody(
      { provider: "anthropic", transport: "anthropic-messages" },
      { ...OR_SPEC, model: "claude-sonnet-5", userId: "local", feature: "x" }
    );
    expect((anthropic.metadata as Record<string, unknown>).user_id).toBe("local");
    expect(anthropic.trace).toBeUndefined();
  });

  it("translates internal call-site tags to the OpenRouter classifier taxonomy (2026-08-10)", () => {
    // The owner's Classifiers-beta config defaults feature to "assistant-chat" when trace.feature
    // is absent/unrecognized — off-taxonomy internal names made the decision engine's spend show
    // as "assistant chat" on the OpenRouter dashboard. Every internal tag must resolve to a
    // taxonomy value, and subsystem must derive from the resolved feature (never the "llm" filler).
    const cases: Array<[string, string, string]> = [
      ["strategy", "green-team", "strategy"],
      ["strategy-bear", "green-team", "strategy"],
      ["red-team", "red-team", "strategy"],
      ["strategy-tuning", "tuning", "strategy"],
      ["learning-review", "framework-review", "strategy"],
      ["post-mortem", "post-mortem", "strategy"],
      ["outcome-postmortem", "post-mortem", "strategy"],
      ["proposal-revalidation", "revalidation", "strategy"],
      ["rag-query-deconstruct", "search-fusion-mmr", "rag"],
      ["chat", "chat", "chat"],
      ["chat-salience", "chat-salience", "memory"],
      ["memory-salience", "memory-salience", "memory"],
      ["embed", "embed", "rag"],
      ["rerank", "rerank", "rag"]
    ];
    for (const [internal, feature, service] of cases) {
      const body: Record<string, unknown> = {};
      applyOpenRouterClassifierEnrichment(body, { feature: internal });
      const trace = body.trace as Record<string, unknown>;
      expect(trace.feature, internal).toBe(feature);
      expect(trace.service, internal).toBe(service);
    }
    // Unknown tags pass through verbatim (visible in the console) rather than being silently
    // funneled into the assistant-chat default by an absent feature.
    const body: Record<string, unknown> = {};
    applyOpenRouterClassifierEnrichment(body, { feature: "brand-new-lane", service: "llm" });
    const trace = body.trace as Record<string, unknown>;
    expect(trace.feature).toBe("brand-new-lane");
    expect(trace.service).toBe("strategy");
    // An explicit caller service that IS a taxonomy subsystem always wins.
    const body2: Record<string, unknown> = {};
    applyOpenRouterClassifierEnrichment(body2, { feature: "embed", service: "monitoring" });
    expect((body2.trace as Record<string, unknown>).service).toBe("monitoring");
  });

  it("falls back to the inferred feature tag when the caller passes none (un-migrated call sites)", () => {
    const body = buildLlmRequestBody(
      { provider: "openrouter", transport: "chat-completions" },
      {
        ...OR_SPEC,
        schema: {
          name: "red_team_verdict",
          schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } }
        }
      }
    );
    expect((body.trace as Record<string, unknown>).feature).toBe("red-team");
  });
});

describe("providerRequestIdFromPayload", () => {
  it("returns the OpenRouter generation id when present", () => {
    expect(providerRequestIdFromPayload("openrouter", { id: "gen-abc123" })).toBe("gen-abc123");
  });
  it("returns undefined — never an empty string — for blank/absent ids", () => {
    expect(providerRequestIdFromPayload("openrouter", { id: "" })).toBeUndefined();
    expect(providerRequestIdFromPayload("openrouter", {})).toBeUndefined();
    expect(providerRequestIdFromPayload("openrouter", null)).toBeUndefined();
    expect(providerRequestIdFromPayload("openrouter", { id: 42 })).toBeUndefined();
  });
  it("returns undefined for every non-OpenRouter provider (their envelope ids are not verifiable generations)", () => {
    expect(providerRequestIdFromPayload("openai", { id: "chatcmpl-1" })).toBeUndefined();
    expect(providerRequestIdFromPayload("anthropic", { id: "msg_1" })).toBeUndefined();
    expect(providerRequestIdFromPayload("voyage", { id: "x" })).toBeUndefined();
  });
});

describe("pushed telemetry: providerRequestId + classifier metadata", () => {
  beforeEach(() => {
    push.__resetUsageMonitorState();
    process.env.USAGE_MONITOR_BASE_URL = BASE;
    process.env.USAGE_INGEST_TOKEN = TOKEN;
    process.env.USAGE_MONITOR_ENV = "test";
  });
  afterEach(() => {
    push.__resetUsageMonitorState();
    delete process.env.USAGE_MONITOR_BASE_URL;
    delete process.env.USAGE_INGEST_TOKEN;
    delete process.env.USAGE_MONITOR_ENV;
  });

  it("LLM events carry providerRequestId and classifier keys in metadata", async () => {
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeMonitorFetchStub(captured));
    push.pushLlmUsage({
      sourceEventId: "llm-row-gen",
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      context: "rag-query-deconstruct",
      userId: "local",
      keySource: "user",
      keyRef: "fp1234",
      totalTokens: 100,
      costUsd: 0.0001,
      providerRequestId: "gen-abc123",
    });
    await push.flushUsageMonitor();

    expect(captured).toHaveLength(1);
    const e = captured[0]!.body.events[0]!;
    expect(e.providerRequestId).toBe("gen-abc123");
    const md = e.metadata as Record<string, unknown>;
    expect(md.sourceApp).toBe("socratic-trade");
    expect(md.environment).toBe("test");
    expect(md.service).toBe("llm");
    expect(md.feature).toBe("rag-query-deconstruct");
    expect(md.keyRef).toBe("fp1234");
    expect(md.user).toBe("local");
  });

  it("LLM events omit providerRequestId when absent (never an empty string)", async () => {
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeMonitorFetchStub(captured));
    push.pushLlmUsage({
      sourceEventId: "llm-row-nogen",
      provider: "anthropic",
      context: "strategy",
      userId: "local",
      keySource: "operator",
      totalTokens: 10,
    });
    await push.flushUsageMonitor();
    const e = captured[0]!.body.events[0]!;
    expect("providerRequestId" in e).toBe(false);
    expect(captured[0]!.rawBody.includes("\"providerRequestId\"")).toBe(false);
  });

  it("Voyage RAG events (OpenRouter bypass) still carry classifier keys via pushed metadata", async () => {
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeMonitorFetchStub(captured));
    push.pushRagUsage({
      sourceEventId: "rag-row-voyage",
      provider: "voyage",
      operation: "embed",
      model: "voyage-finance-2",
      userId: "local",
      tokensIn: 120,
      costUsd: 0.00001,
    });
    await push.flushUsageMonitor();
    const e = captured[0]!.body.events[0]!;
    expect("providerRequestId" in e).toBe(false);
    const md = e.metadata as Record<string, unknown>;
    expect(md.sourceApp).toBe("socratic-trade");
    expect(md.environment).toBe("test");
    expect(md.service).toBe("rag");
    expect(md.feature).toBe("embed");
    expect(md.user).toBe("local");
  });

  it("OpenRouter RAG events carry the embed generation id as providerRequestId", async () => {
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeMonitorFetchStub(captured));
    push.pushRagUsage({
      sourceEventId: "rag-row-or",
      provider: "openrouter",
      operation: "embed",
      model: "baai/bge-m3",
      userId: "local",
      tokensIn: 60,
      costUsd: 0.0000006,
      providerRequestId: "gen-embed-1",
    });
    await push.flushUsageMonitor();
    expect(captured[0]!.body.events[0]!.providerRequestId).toBe("gen-embed-1");
  });

  it("recordLlmUsage threads providerRequestId from the ledger into the pushed event", async () => {
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeMonitorFetchStub(captured));
    const { recordLlmUsage } = await import("../src/lib/llm-usage");
    recordLlmUsage({
      userId: "local",
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      context: "strategy",
      keySource: "user",
      keyRef: "fp9999",
      promptTokens: 10,
      completionTokens: 5,
      providerRequestId: "gen-ledger-1",
    });
    await push.flushUsageMonitor();
    const e = captured[0]!.body.events[0]!;
    expect(e.providerRequestId).toBe("gen-ledger-1");
    expect((e.metadata as Record<string, unknown>).sourceApp).toBe("socratic-trade");
  });
});

describe("WS1 gap #1: massive.ts routes through the tracked provider boundary", () => {
  beforeEach(() => {
    push.__resetUsageMonitorState();
    process.env.USAGE_MONITOR_BASE_URL = BASE;
    process.env.USAGE_INGEST_TOKEN = TOKEN;
    process.env.USAGE_MONITOR_ENV = "test";
    process.env.MASSIVE_API_KEY = "massive-test-key";
  });
  afterEach(async () => {
    const { clearMassiveRestBudgetForTests } = await import("../src/lib/market-signals/massive");
    clearMassiveRestBudgetForTests();
    push.__resetUsageMonitorState();
    delete process.env.USAGE_MONITOR_BASE_URL;
    delete process.env.USAGE_INGEST_TOKEN;
    delete process.env.USAGE_MONITOR_ENV;
    delete process.env.MASSIVE_API_KEY;
    vi.unstubAllGlobals();
  });

  it("fetchGroupedBarsRest emits massive call-volume telemetry with the env key lane", async () => {
    const monitorCaptured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeMonitorFetchStub(monitorCaptured));

    const providerCalls: Array<{ url: string; auth: string | undefined }> = [];
    vi.stubGlobal("fetch", (async (url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      providerCalls.push({ url: String(url), auth: headers?.Authorization });
      return new Response(
        JSON.stringify({ status: "OK", results: [{ T: "AAPL", c: 210.5, o: 209, h: 211, l: 208, v: 1000000 }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch);

    process.env.MASSIVE_LOCAL_HISTORY_ENABLED = "off";
    const { fetchGroupedBarsRest, clearMassiveRestBudgetForTests } = await import("../src/lib/market-signals/massive");
    clearMassiveRestBudgetForTests();
    const bars = await fetchGroupedBarsRest("2026-07-17");
    expect(bars).not.toBeNull();
    expect(bars![0]!.ticker).toBe("AAPL");
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]!.auth).toBe("Bearer massive-test-key");

    await push.flushUsageMonitor();
    const events = monitorCaptured.flatMap((c) => c.body.events);
    const vol = events.find((e) => e.provider === "massive");
    expect(vol).toBeDefined();
    expect(vol!.unit).toBe("request");
    expect(vol!.requests).toBe(1);
    expect((vol!.metadata as Record<string, unknown>).successes).toBe(1);
    expect((vol!.metadata as Record<string, unknown>).keySource).toBe("env");
  });

  it("fetchMassiveNews emits massive call-volume telemetry", async () => {
    const monitorCaptured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeMonitorFetchStub(monitorCaptured));
    vi.stubGlobal("fetch", (async () =>
      new Response(
        JSON.stringify({ results: [{ title: "Markets rally", article_url: "https://example.test/a", published_utc: "2026-07-17T12:00:00Z", publisher: { name: "Test Wire" } }] }),
        { status: 200 }
      )) as unknown as typeof fetch);

    const { fetchMassiveNews, clearMassiveRestBudgetForTests } = await import("../src/lib/market-signals/massive");
    clearMassiveRestBudgetForTests();
    const news = await fetchMassiveNews(3);
    expect(news).toHaveLength(1);

    await push.flushUsageMonitor();
    const events = monitorCaptured.flatMap((c) => c.body.events);
    expect(events.find((e) => e.provider === "massive")).toBeDefined();
  });
});

describe("WS1 gap #2: query-deconstruct meters its LLM call + enriches the OpenRouter request", () => {
  beforeEach(() => {
    push.__resetUsageMonitorState();
    process.env.USAGE_MONITOR_BASE_URL = BASE;
    process.env.USAGE_INGEST_TOKEN = TOKEN;
    process.env.USAGE_MONITOR_ENV = "test";
  });
  afterEach(() => {
    push.__resetUsageMonitorState();
    delete process.env.USAGE_MONITOR_BASE_URL;
    delete process.env.USAGE_INGEST_TOKEN;
    delete process.env.USAGE_MONITOR_ENV;
    vi.unstubAllGlobals();
  });

  it("records usage with the OpenRouter generation id and sends a flat-trace-enriched body", async () => {
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-test-deconstruct");

    const monitorCaptured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeMonitorFetchStub(monitorCaptured));

    const llmRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", (async (url: unknown, init?: RequestInit) => {
      llmRequests.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(
        JSON.stringify({
          id: "gen-deconstruct-1",
          choices: [{ message: { content: '{"queries":["AAPL revenue growth by segment","AAPL total debt and maturities"]}' } }],
          usage: { prompt_tokens: 40, completion_tokens: 20 }
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch);

    const { deconstructQuery } = await import("../src/lib/rag/query-deconstruct");
    const queries = await deconstructQuery("compare revenue growth and total debt maturities for AAPL", "local");
    expect(queries).toEqual(["AAPL revenue growth by segment", "AAPL total debt and maturities"]);

    // Request body: json_object response_format + flat trace enrichment + user.
    expect(llmRequests).toHaveLength(1);
    const sent = llmRequests[0]!.body;
    expect((sent.response_format as Record<string, unknown>).type).toBe("json_object");
    const trace = sent.trace as Record<string, unknown>;
    expect(trace.sourceApp).toBe("socratic-trade");
    expect(trace.service).toBe("rag");
    // Taxonomy translation (2026-08-10): internal "rag-query-deconstruct" → "search-fusion-mmr".
    expect(trace.feature).toBe("search-fusion-mmr");
    expect(sent.user).toBe("local");
    expect(sent.metadata).toBeUndefined();
    // Bounded output cap actually on the wire (the old path sent no cap at all).
    expect(sent.max_tokens ?? sent.max_completion_tokens).toBeDefined();

    // Pushed telemetry: one llm event with the generation id + classifier metadata.
    await push.flushUsageMonitor();
    const events = monitorCaptured.flatMap((c) => c.body.events);
    const llmEvent = events.find((e) => e.service === "llm");
    expect(llmEvent).toBeDefined();
    expect(llmEvent!.providerRequestId).toBe("gen-deconstruct-1");
    expect((llmEvent!.metadata as Record<string, unknown>).feature).toBe("rag-query-deconstruct");
  });

  it("falls back to the heuristic split when the LLM call fails (no usage row pushed)", async () => {
    const monitorCaptured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeMonitorFetchStub(monitorCaptured));
    vi.stubGlobal("fetch", (async () => new Response("upstream down", { status: 503 })) as unknown as typeof fetch);

    const { deconstructQuery } = await import("../src/lib/rag/query-deconstruct");
    const queries = await deconstructQuery("compare revenue growth and total debt maturities for AAPL", "local");
    expect(queries.length).toBeGreaterThan(0); // heuristic fallback still answers

    await push.flushUsageMonitor();
    const events = monitorCaptured.flatMap((c) => c.body.events);
    expect(events.find((e) => e.service === "llm")).toBeUndefined();
  });
});

describe("WS1 gap #3: search-fusion fetchAlternativeEmbedding meters + enriches", () => {
  beforeEach(() => {
    push.__resetUsageMonitorState();
    process.env.USAGE_MONITOR_BASE_URL = BASE;
    process.env.USAGE_INGEST_TOKEN = TOKEN;
    process.env.USAGE_MONITOR_ENV = "test";
  });
  afterEach(() => {
    push.__resetUsageMonitorState();
    delete process.env.USAGE_MONITOR_BASE_URL;
    delete process.env.USAGE_INGEST_TOKEN;
    delete process.env.USAGE_MONITOR_ENV;
    vi.unstubAllGlobals();
  });

  it("OpenRouter embeds send attribution headers + flat trace, and meter with the generation id", async () => {
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test-fusion");

    const monitorCaptured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeMonitorFetchStub(monitorCaptured));

    const embedRequests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", (async (url: unknown, init?: RequestInit) => {
      embedRequests.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? "{}"))
      });
      return new Response(
        JSON.stringify({ id: "gen-fusion-embed-1", data: [{ embedding: [0.1, 0.2, 0.3] }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch);

    const { fetchAlternativeEmbedding } = await import("../src/lib/rag/search-fusion");
    const vectors = await fetchAlternativeEmbedding(["test passage"], "local");
    expect(vectors).toEqual([[0.1, 0.2, 0.3]]);

    expect(embedRequests).toHaveLength(1);
    const req = embedRequests[0]!;
    expect(req.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(req.headers["HTTP-Referer"]).toBe("https://socratictrade.com");
    expect(req.headers["X-Title"]).toBe("Socratic-Trade");
    const trace = req.body.trace as Record<string, unknown>;
    expect(trace.sourceApp).toBe("socratic-trade");
    expect(trace.service).toBe("rag");
    expect(trace.feature).toBe("search-fusion-mmr");
    expect(req.body.user).toBe("local");

    await push.flushUsageMonitor();
    const events = monitorCaptured.flatMap((c) => c.body.events);
    const rag = events.find((e) => e.service === "rag");
    expect(rag).toBeDefined();
    expect(rag!.provider).toBe("openrouter");
    expect(rag!.providerRequestId).toBe("gen-fusion-embed-1");
    expect((rag!.metadata as Record<string, unknown>).feature).toBe("embed");
  });
});
