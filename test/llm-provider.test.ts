/**
 * Tests for resolveLlmEndpoint — provider routing based on model name.
 * All tests run entirely offline (no real API key or network call required).
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import os from "os";
import path from "path";

// Point the DB at a temp file before any imports touch it.
const tmpDb = path.join(os.tmpdir(), `llm-provider-test-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${tmpDb}`;

describe("resolveLlmEndpoint", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolveLlmEndpoint: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let setApiKey: (...args: any[]) => any;

  beforeAll(async () => {
    // Ensure DB is initialised before module import.
    const { getDb } = await import("../src/lib/db");
    getDb();
    const dbApiKeys = await import("../src/lib/db-api-keys");
    setApiKey = dbApiKeys.upsertUserApiKey;
    const mod = await import("../src/lib/llm-provider");
    resolveLlmEndpoint = mod.resolveLlmEndpoint;
  });

  it("routes to OpenRouter when user has an OpenRouter key", () => {
    setApiKey("test-user-or", "openrouter", "sk-or-test-key");
    const endpoint = resolveLlmEndpoint({ llmModel: "claude-sonnet-5" }, "test-user-or");
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(endpoint.key).toBe("sk-or-test-key");
    expect(endpoint.model).toBe("~anthropic/claude-sonnet-latest");
    expect(endpoint.transport).toBe("chat-completions");
  });

  it("falls back to native Anthropic endpoint when user has an Anthropic key but no OpenRouter key", () => {
    setApiKey("test-user-anthropic", "anthropic", "sk-ant-test-key");
    const endpoint = resolveLlmEndpoint({ llmModel: "claude-sonnet-5" }, "test-user-anthropic");
    expect(endpoint.provider).toBe("anthropic");
    expect(endpoint.url).toBe("https://api.anthropic.com/v1/messages");
    expect(endpoint.key).toBe("sk-ant-test-key");
    expect(endpoint.model).toBe("claude-sonnet-5");
    expect(endpoint.transport).toBe("anthropic-messages");
  });

  it("falls back to native xAI endpoint when user has an xAI key but no OpenRouter key", () => {
    setApiKey("test-user-xai", "xai", "xai-test-key");
    const endpoint = resolveLlmEndpoint({ llmModel: "grok-4.5" }, "test-user-xai");
    expect(endpoint.provider).toBe("xai");
    expect(endpoint.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(endpoint.key).toBe("xai-test-key");
    expect(endpoint.model).toBe("grok-4.6");
    expect(endpoint.transport).toBe("chat-completions");
  });

  it("falls back to native Moonshot endpoint when user has a Moonshot key but no OpenRouter key", () => {
    setApiKey("test-user-moonshot", "moonshot", "sk-moonshot-test-key");
    const endpoint = resolveLlmEndpoint({ llmModel: "kimi-latest" }, "test-user-moonshot");
    expect(endpoint.provider).toBe("moonshot");
    expect(endpoint.url).toBe("https://api.moonshot.cn/v1/chat/completions");
    expect(endpoint.key).toBe("sk-moonshot-test-key");
    expect(endpoint.model).toBe("kimi-latest");
    expect(endpoint.transport).toBe("chat-completions");
  });

  it("falls back to the native MiniMax endpoint with the MiniMax credential", () => {
    setApiKey("test-user-minimax", "minimax", "sk-minimax-test-key");
    // 2026-09-18 catalog cleanup: minimax-m2.7 was removed in favor of minimax-m3.
    const endpoint = resolveLlmEndpoint({ llmModel: "minimax-m3" }, "test-user-minimax");
    expect(endpoint.provider).toBe("minimax");
    expect(endpoint.url).toBe("https://api.minimax.io/v1/chat/completions");
    expect(endpoint.key).toBe("sk-minimax-test-key");
    expect(endpoint.model).toBe("MiniMax-M3");
    expect(endpoint.transport).toBe("chat-completions");
  });

  it("uses the same credential service for eligibility and actual MiniMax execution", async () => {
    const { modelCredentialService } = await import("../src/lib/llm-provider");
    setApiKey("minimax-eligibility", "minimax", "minimax-placeholder");
    expect(modelCredentialService("minimax-m3", "minimax-eligibility")).toBe("minimax");
    expect(resolveLlmEndpoint({ llmModel: "minimax-m3" }, "minimax-eligibility").provider).toBe("minimax");
    setApiKey("minimax-eligibility", "openrouter", "openrouter-placeholder");
    expect(modelCredentialService("minimax-m3", "minimax-eligibility")).toBe("openrouter");
    expect(resolveLlmEndpoint({ llmModel: "minimax-m3" }, "minimax-eligibility").provider).toBe("openrouter");
  });

  it("keeps an explicit OpenRouter model on OpenRouter even when its native key exists", async () => {
    const { modelCredentialService, modelRequiresOpenRouter } = await import("../src/lib/llm-provider");
    setApiKey("explicit-openrouter-minimax", "minimax", "minimax-placeholder");
    const model = "openrouter/minimax/minimax-m3";

    expect(modelRequiresOpenRouter(model)).toBe(true);
    expect(modelRequiresOpenRouter(" OpenRouter/~anthropic/claude-sonnet-latest ")).toBe(true);
    expect(modelCredentialService(model, "explicit-openrouter-minimax")).toBe("openrouter");
    const endpoint = resolveLlmEndpoint({ llmModel: model }, "explicit-openrouter-minimax");
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.key).toBeUndefined();
    expect(endpoint.model).toBe("minimax/minimax-m3");
  });

  it("requires OpenRouter for Astra Pro even with a native OpenAI key", () => {
    setApiKey("astra-pro-native", "openai", "openai-placeholder");
    const endpoint = resolveLlmEndpoint({ llmModel: "gpt-6-astra-pro" }, "astra-pro-native");
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.key).toBeUndefined();
    expect(endpoint.model).toBe("openai/gpt-6-astra-pro");
  });

  it("requires OpenRouter for Meta and never sends a Meta key to OpenAI", async () => {
    const { modelCredentialService } = await import("../src/lib/llm-provider");
    setApiKey("meta-native-only", "meta", "meta-placeholder");
    for (const model of ["muse-spark-1.3", "muse-glimmer-30b", "llama-4-maverick"]) {
      const endpoint = resolveLlmEndpoint({ llmModel: model }, "meta-native-only");
      expect(endpoint.provider).toBe("openrouter");
      expect(endpoint.key).toBeUndefined();
      expect(modelCredentialService(model, "meta-native-only")).toBe("openrouter");
    }
    setApiKey("meta-native-only", "openrouter", "openrouter-placeholder");
    const endpoint = resolveLlmEndpoint({ llmModel: "muse-spark-1.3" }, "meta-native-only");
    expect(endpoint.model).toBe("meta/muse-spark-1.3");
    expect(endpoint.key).toBe("openrouter-placeholder");
  });

  it("fails closed (key undefined) when user has no keys at all", () => {
    const endpoint = resolveLlmEndpoint({ llmModel: "claude-sonnet-5" }, "user-with-no-keys");
    expect(endpoint.key).toBeUndefined();
  });

  it("maps Flash-class aliases to the owner OpenRouter Flash wire slug", async () => {
    const { normalizeOpenRouterModelId, OPENROUTER_GEMINI_FLASH, OPENROUTER_GEMINI_FLASH_BATCH } =
      await import("../src/lib/llm-provider");
    expect(normalizeOpenRouterModelId("gemini-flash-latest")).toBe(OPENROUTER_GEMINI_FLASH);
    expect(normalizeOpenRouterModelId("google/gemini-flash-latest")).toBe(OPENROUTER_GEMINI_FLASH);
    expect(normalizeOpenRouterModelId("google/gemini-3.6-flash")).toBe(OPENROUTER_GEMINI_FLASH);
    expect(normalizeOpenRouterModelId("google/gemini-3.8-flash:batch")).toBe(OPENROUTER_GEMINI_FLASH_BATCH);
    expect(normalizeOpenRouterModelId("gemini-3.5-flash")).toBe(OPENROUTER_GEMINI_FLASH);
    expect(normalizeOpenRouterModelId("google/gemini-3.7-flash")).toBe(OPENROUTER_GEMINI_FLASH);
  });

  it("maps Mistral Medium to the owner OpenRouter wire slug", async () => {
    const { normalizeOpenRouterModelId } = await import("../src/lib/llm-provider");
    expect(normalizeOpenRouterModelId("mistral-medium-latest")).toBe("mistralai/mistral-medium-3-5");
    expect(normalizeOpenRouterModelId("mistral-medium-3-5")).toBe("mistralai/mistral-medium-3-5");
    expect(normalizeOpenRouterModelId("mistral-medium-3.5")).toBe("mistralai/mistral-medium-3-5");
    expect(normalizeOpenRouterModelId("mistralai/mistral-medium-3.5")).toBe("mistralai/mistral-medium-3-5");
    expect(normalizeOpenRouterModelId("mistralai/mistral-medium-3-5")).toBe("mistralai/mistral-medium-3-5");
    expect(normalizeOpenRouterModelId("gpt-5.4-nano")).toBe("openai/gpt-5.4-nano");
  });

  it("emits owner OpenRouter wire slugs for catalog families and aliases", async () => {
    const { normalizeOpenRouterModelId } = await import("../src/lib/llm-provider");
    const cases: Array<[string, string]> = [
      ["claude-sonnet-5", "~anthropic/claude-sonnet-latest"],
      ["claude-sonnet-latest", "~anthropic/claude-sonnet-latest"],
      ["anthropic/claude-sonnet-latest", "~anthropic/claude-sonnet-latest"],
      ["~anthropic/claude-sonnet-latest", "~anthropic/claude-sonnet-latest"],
      ["openrouter/~anthropic/claude-sonnet-latest", "~anthropic/claude-sonnet-latest"],
      ["claude-haiku-4.5", "~anthropic/claude-haiku-latest"],
      ["claude-haiku-latest", "~anthropic/claude-haiku-latest"],
      ["anthropic/claude-haiku-latest", "~anthropic/claude-haiku-latest"],
      ["~anthropic/claude-haiku-latest", "~anthropic/claude-haiku-latest"],
      ["claude-opus-5", "~anthropic/claude-opus-latest"],
      ["claude-opus-latest", "~anthropic/claude-opus-latest"],
      ["anthropic/claude-opus-latest", "~anthropic/claude-opus-latest"],
      ["~anthropic/claude-opus-latest", "~anthropic/claude-opus-latest"],
      ["claude-fable-5", "~anthropic/claude-fable-latest"],
      ["claude-fable-latest", "~anthropic/claude-fable-latest"],
      ["anthropic/claude-fable-latest", "~anthropic/claude-fable-latest"],
      ["~anthropic/claude-fable-latest", "~anthropic/claude-fable-latest"],
      ["grok-4.5", "~x-ai/grok-latest"],
      ["grok-latest", "~x-ai/grok-latest"],
      ["x-ai/grok-latest", "~x-ai/grok-latest"],
      ["~x-ai/grok-latest", "~x-ai/grok-latest"],
      ["gpt-6-astra", "openai/gpt-6-astra"],
      ["openai/gpt-6-astra", "openai/gpt-6-astra"],
      ["~openai/gpt-6-astra", "openai/gpt-6-astra"],
      ["kimi-latest", "~moonshotai/kimi-latest"],
      ["moonshotai/kimi-latest", "~moonshotai/kimi-latest"],
      ["~moonshotai/kimi-latest", "~moonshotai/kimi-latest"],
      ["minimax-m3", "minimax/minimax-m3"],
      ["minimax/minimax-m3", "minimax/minimax-m3"],
      // 2026-09-18: deepseek-r1 removed from the curated catalog (the new deepseek-flash-latest /
      // deepseek-pro-latest rows subsume the v4 use cases). deepseek-reasoner is no longer a
      // catalog alias of any row, so it now normalizes to a vendor-prefixed slug instead of
      // collapsing to deepseek-r1.
      ["deepseek/deepseek-reasoner", "deepseek/deepseek-reasoner"],
      ["deepseek-r1", "deepseek/deepseek-reasoner"]
    ];
    for (const [input, expected] of cases) {
      expect(normalizeOpenRouterModelId(input), input).toBe(expected);
    }
  });
});
