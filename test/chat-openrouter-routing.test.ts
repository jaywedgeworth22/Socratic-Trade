/**
 * Regression coverage for review finding llm-12: the Coach (`llmForModel` in
 * `src/lib/chat/llm.ts`) used to resolve a model to its NATIVE provider family only, while the
 * strategy engine's `resolveLlmEndpoint` (`src/lib/llm-provider.ts`) already served every model
 * through an OpenRouter key first.  An owner with only an OpenRouter key attached saw "no key" for
 * every Coach model even though the same model already worked in the strategy engine, and
 * `/api/chat/providers` never reported OpenRouter availability at all.  `chatProviderForModel` also
 * had no llama -> meta mapping, so a llama model silently routed to OpenAI.
 *
 * These tests store credentials directly in the per-user key store (`upsertUserApiKey`) with
 * `LLM_OPERATOR_FALLBACK` forced off, rather than via env vars.  This sidesteps a NODE_ENV=test-only
 * shim in `resolveLlmCredential` (db-api-keys.ts) that lets an "openrouter" credential borrow ANY
 * single native-provider env var present when the operator failover is enabled — useful for OTHER
 * suites that want to exercise universal OpenRouter routing without configuring an explicit
 * OPENROUTER_API_KEY, but exactly the ambient leakage these tests need to avoid so "only a native
 * key is attached" and "only an OpenRouter key is attached" stay deterministic and mutually exclusive.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { deleteUserApiKey, getDb, upsertUserApiKey } from "../src/lib/db";
import { AnthropicLLM, chatProviderForModel, getLLM, llmForModel, MockLLM, OpenAILLM } from "../src/lib/chat/llm";
import { getLlmUsageSummary } from "../src/lib/llm-usage";
import { normalizeOpenRouterModelId, OPENROUTER_GEMINI_FLASH } from "../src/lib/llm-provider";
import type { LlmRunArgs } from "../src/lib/chat/types";

const noopExecuteTool = async (_name: string, _input: unknown) => ({ ok: true });
const baseArgs: LlmRunArgs = { system: "You are a trading assistant.", message: "Hello", tools: [], executeTool: noopExecuteTool };

/** Minimal chat-completions response shape so OpenAILLM.run() completes without a real network call. */
function fakeChatResponse(content = "ok") {
  return { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] };
}

describe("llmForModel — OpenRouter-first routing (review finding llm-12)", () => {
  let savedFallback: string | undefined;

  beforeAll(() => {
    process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/chat-openrouter-routing-${randomUUID()}.db`;
    getDb();
    savedFallback = process.env.LLM_OPERATOR_FALLBACK;
    // Force the operator-funded failover OFF so resolveLlmCredential never falls through to the
    // NODE_ENV=test borrow-any-key shim described above — every credential in this suite comes
    // from an explicit per-user store write, nothing ambient.
    process.env.LLM_OPERATOR_FALLBACK = "off";
  });

  afterAll(() => {
    if (savedFallback !== undefined) process.env.LLM_OPERATOR_FALLBACK = savedFallback;
    else delete process.env.LLM_OPERATOR_FALLBACK;
  });

  // (a) ── OpenRouter key present -> routes through OpenRouter with the normalized wire slug ────

  it("resolves a model via OpenRouter (not MockLLM) when only an OpenRouter key is attached", async () => {
    const userId = `u_or_${randomUUID()}`;
    upsertUserApiKey(userId, "openrouter", "sk-or-test-key");
    try {
      // "gemini-flash-latest" natively belongs to the "gemini" family (see chatProviderForModel),
      // and this user has NO gemini key stored — under the old native-only routing this would have
      // reported "no key" (MockLLM) even though OpenRouter can serve it.
      const llm = llmForModel("gemini-flash-latest", userId);
      expect(llm).toBeInstanceOf(OpenAILLM);
      expect(llm).not.toBeInstanceOf(MockLLM);
      // Wire model id must be normalized the SAME way the strategy engine normalizes it, so an
      // availability probe and the actual call can never disagree about a model's id.
      expect(llm.modelName).toBe(normalizeOpenRouterModelId("gemini-flash-latest"));
      expect(llm.modelName).toBe(OPENROUTER_GEMINI_FLASH);

      // Usage must still be recorded, and recorded against "openrouter" — the existing
      // recordLlmUsage/extractLlmUsage plumbing in chat/llm.ts must keep working unmodified.
      const fakeTransport = vi.fn().mockResolvedValue(fakeChatResponse());
      const llmWithTransport = llmForModel("gemini-flash-latest", userId, { openAITransport: fakeTransport });
      await llmWithTransport.run(baseArgs);
      expect(fakeTransport).toHaveBeenCalledOnce();
      const rows = getLlmUsageSummary({ userId });
      expect(rows.some((r) => r.provider === "openrouter")).toBe(true);
    } finally {
      deleteUserApiKey(userId, "openrouter");
    }
  });

  // (b) ── No OpenRouter key -> native-provider fallback is unchanged (no regression) ────────────

  it("falls back to the native provider when no OpenRouter key resolves (Anthropic)", () => {
    const userId = `u_native_anthropic_${randomUUID()}`;
    upsertUserApiKey(userId, "anthropic", "ant-test-key");
    try {
      const llm = llmForModel("claude-haiku-4-5", userId);
      expect(llm).toBeInstanceOf(AnthropicLLM);
    } finally {
      deleteUserApiKey(userId, "anthropic");
    }
  });

  it("falls back to the native provider when no OpenRouter key resolves (Gemini, OpenAI-compatible loop) and records that provider", async () => {
    const userId = `u_native_gemini_${randomUUID()}`;
    upsertUserApiKey(userId, "gemini", "gem-test-key");
    try {
      const fakeTransport = vi.fn().mockResolvedValue(fakeChatResponse());
      const llm = llmForModel("gemini-2.5-flash", userId, { openAITransport: fakeTransport });
      expect(llm).toBeInstanceOf(OpenAILLM);
      // The native catalog column resolves the persisted family alias.
      expect(llm.modelName).toBe("gemini-flash-latest");
      await llm.run(baseArgs);
      const rows = getLlmUsageSummary({ userId });
      expect(rows.some((r) => r.provider === "gemini")).toBe(true);
      expect(rows.some((r) => r.provider === "openrouter")).toBe(false);
    } finally {
      deleteUserApiKey(userId, "gemini");
    }
  });

  it("preserves adaptive thinking after resolving the native Opus model ID", async () => {
    const userId = `u_opus_${randomUUID()}`;
    upsertUserApiKey(userId, "anthropic", "anthropic-placeholder");
    const transport = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Answer" }], stop_reason: "end_turn" });
    try {
      const llm = llmForModel("claude-opus-latest", userId, { transport, reasoningEffort: "high" });
      await llm.run(baseArgs);
      const body = transport.mock.calls[0][0];
      expect(body.model).toBe("claude-opus-5-5");
      expect(body.thinking).toEqual({ type: "adaptive" });
      expect(body.output_config).toEqual({ effort: "high" });
      expect(body.max_tokens).toBeGreaterThanOrEqual(4096);
    } finally {
      deleteUserApiKey(userId, "anthropic");
    }
  });

  it("keeps Meta credentials away from the OpenAI fallback", () => {
    const userId = `u_meta_${randomUUID()}`;
    upsertUserApiKey(userId, "meta", "meta-placeholder");
    try {
      expect(llmForModel("muse-spark-1.3", userId)).toBeInstanceOf(MockLLM);
      upsertUserApiKey(userId, "openrouter", "openrouter-placeholder");
      const llm = llmForModel("muse-spark-1.3", userId);
      expect(llm).toBeInstanceOf(OpenAILLM);
      expect(llm.modelName).toBe("meta/muse-spark-1.3");
    } finally {
      deleteUserApiKey(userId, "meta");
      deleteUserApiKey(userId, "openrouter");
    }
  });

  it("uses native MiniMax IDs and preserves reasoning across tool turns", async () => {
    const userId = `u_minimax_${randomUUID()}`;
    upsertUserApiKey(userId, "minimax", "minimax-test-placeholder");
    const reasoning = [{ type: "reasoning.text", text: "tool context", index: 0 }];
    const requests: Array<Record<string, any>> = [];
    const transport = vi.fn(async (body) => {
      requests.push(JSON.parse(JSON.stringify(body)));
      return requests.length === 1
        ? { choices: [{ finish_reason: "tool_calls", message: {
            content: null,
            reasoning_details: reasoning,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "get_quote", arguments: "{}" } }]
          } }] }
        : fakeChatResponse("Visible answer");
    });
    try {
      const llm = llmForModel("minimax-m3", userId, { openAITransport: transport });
      const result = await llm.run({ ...baseArgs, tools: [{ name: "get_quote", description: "Quote", input_schema: { type: "object" } }] });
      expect(requests).toHaveLength(2);
      expect(requests[0].model).toBe("MiniMax-M3");
      expect(requests[0].reasoning_split).toBe(true);
      expect(requests[0].max_completion_tokens).toBe(5024);
      expect(requests[1].messages.find((m: { role: string }) => m.role === "assistant").reasoning_details).toEqual(reasoning);
      expect(result.text).toBe("Visible answer");
    } finally {
      deleteUserApiKey(userId, "minimax");
    }
  });

  it("does not native-fallback an explicit OpenRouter MiniMax id", () => {
    const userId = `u_explicit_or_minimax_${randomUUID()}`;
    upsertUserApiKey(userId, "minimax", "minimax-test-placeholder");
    try {
      expect(llmForModel("openrouter/minimax/minimax-m3", userId)).toBeInstanceOf(MockLLM);
    } finally {
      deleteUserApiKey(userId, "minimax");
    }
  });

  it("normalizes the env-default OpenRouter model in the emitted request", async () => {
    const userId = `u_env_or_minimax_${randomUUID()}`;
    const savedProvider = process.env.CHAT_LLM;
    const savedModel = process.env.CHAT_LLM_MODEL;
    process.env.CHAT_LLM = "openrouter";
    process.env.CHAT_LLM_MODEL = "minimax-m3";
    upsertUserApiKey(userId, "openrouter", "openrouter-test-placeholder");
    const transport = vi.fn().mockResolvedValue(fakeChatResponse());
    try {
      const llm = getLLM(userId, { openAITransport: transport });
      expect(llm).toBeInstanceOf(OpenAILLM);
      await llm.run(baseArgs);
      expect(transport.mock.calls[0][0].model).toBe("minimax/minimax-m3");
    } finally {
      deleteUserApiKey(userId, "openrouter");
      if (savedProvider === undefined) delete process.env.CHAT_LLM;
      else process.env.CHAT_LLM = savedProvider;
      if (savedModel === undefined) delete process.env.CHAT_LLM_MODEL;
      else process.env.CHAT_LLM_MODEL = savedModel;
    }
  });

  it("uses the native MiniMax env-default transport with tenant usage and reasoning", async () => {
    const userId = `u_env_native_minimax_${randomUUID()}`;
    const savedProvider = process.env.CHAT_LLM;
    const savedModel = process.env.CHAT_LLM_MODEL;
    process.env.CHAT_LLM = "minimax";
    process.env.CHAT_LLM_MODEL = "minimax-m3";
    upsertUserApiKey(userId, "minimax", "minimax-test-placeholder");
    const transport = vi.fn().mockResolvedValue(fakeChatResponse());
    try {
      const llm = getLLM(userId, { openAITransport: transport, reasoningEffort: "high" });
      expect(llm).toBeInstanceOf(OpenAILLM);
      await llm.run(baseArgs);
      const body = transport.mock.calls[0][0];
      expect(body.model).toBe("MiniMax-M3");
      expect(body.reasoning_split).toBe(true);
      expect(body.max_completion_tokens).toBeGreaterThan(1024);
      expect(body.max_tokens).toBeUndefined();
      expect(getLlmUsageSummary({ userId }).some((row) => row.provider === "minimax")).toBe(true);
    } finally {
      deleteUserApiKey(userId, "minimax");
      if (savedProvider === undefined) delete process.env.CHAT_LLM;
      else process.env.CHAT_LLM = savedProvider;
      if (savedModel === undefined) delete process.env.CHAT_LLM_MODEL;
      else process.env.CHAT_LLM_MODEL = savedModel;
    }
  });

  it("still reports MockLLM (not an error) when NEITHER an OpenRouter key nor the native key resolves", () => {
    const userId = `u_none_${randomUUID()}`;
    expect(llmForModel("gpt-5.4-mini", userId)).toBeInstanceOf(MockLLM);
    expect(llmForModel("claude-haiku-4-5", userId)).toBeInstanceOf(MockLLM);
  });

  it("does not borrow an unrelated provider's key across families", () => {
    const userId = `u_wrong_family_${randomUUID()}`;
    upsertUserApiKey(userId, "openai", "oai-test-key");
    try {
      expect(llmForModel("gemini-2.5-flash", userId)).toBeInstanceOf(MockLLM);
      expect(llmForModel("claude-sonnet-4-6", userId)).toBeInstanceOf(MockLLM);
      expect(llmForModel("mistral-large-2512", userId)).toBeInstanceOf(MockLLM);
    } finally {
      deleteUserApiKey(userId, "openai");
    }
  });

  // (c) ── llama -> meta family mapping (was silently defaulting to "openai") ─────────────────────

  it("maps a llama model to the meta family, not openai", () => {
    expect(chatProviderForModel("llama-3.3-70b-instruct")).toBe("meta");
    expect(chatProviderForModel("meta-llama/llama-3.3-70b-instruct")).toBe("meta");
    expect(chatProviderForModel("llama-3.3-70b-instruct")).not.toBe("openai");
  });

  it("does not invoke an OpenAI transport with a standalone Meta key", async () => {
    const userId = `u_meta_${randomUUID()}`;
    upsertUserApiKey(userId, "meta", "meta-test-key");
    try {
      const fakeTransport = vi.fn().mockResolvedValue(fakeChatResponse());
      const llm = llmForModel("llama-3.3-70b-instruct", userId, { openAITransport: fakeTransport });
      expect(llm).toBeInstanceOf(MockLLM);
      await llm.run(baseArgs);
      expect(fakeTransport).not.toHaveBeenCalled();
    } finally {
      deleteUserApiKey(userId, "meta");
    }
  });

  it("a llama model with only an OpenAI key attached is MockLLM (confirms it no longer silently defaults to openai)", () => {
    const userId = `u_meta_wrong_key_${randomUUID()}`;
    upsertUserApiKey(userId, "openai", "oai-test-key");
    try {
      expect(llmForModel("llama-3.3-70b-instruct", userId)).toBeInstanceOf(MockLLM);
    } finally {
      deleteUserApiKey(userId, "openai");
    }
  });
});

// (d) ── /api/chat/providers reports OpenRouter availability ──────────────────────────────────────

describe("GET /api/chat/providers — OpenRouter row", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function callRoute(): Promise<Record<string, boolean>> {
    const { GET } = await import("../app/api/chat/providers/route");
    const res = await GET(new Request("http://localhost/api/chat/providers"));
    const body = (await res.json()) as { providers: Record<string, boolean> };
    return body.providers;
  }

  it("reports openrouter: true when an OpenRouter key resolves", async () => {
    vi.stubEnv("LLM_OPERATOR_FALLBACK", "on");
    vi.stubEnv("OPENROUTER_API_KEY", "live-or-key");
    const providers = await callRoute();
    expect(providers.openrouter).toBe(true);
  });

  it("reports openrouter: false when no OpenRouter key resolves", async () => {
    vi.stubEnv("LLM_OPERATOR_FALLBACK", "off");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const providers = await callRoute();
    expect(providers.openrouter).toBe(false);
  });
});
