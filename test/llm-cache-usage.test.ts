import { describe, expect, it } from "vitest";
import { estimateLlmCostUsd, extractLlmUsage, remapOpenRouterTelemetry } from "../src/lib/llm-usage";

// Prompt-cache accounting: extractLlmUsage must surface cache-read/creation tokens from every
// provider's usage shape, and estimateLlmCostUsd must price cached tokens at the discounted rate
// instead of billing the whole prompt at the full input price (which overstated cost on cached
// calls — e.g. gpt-5.5 cached input is $0.50/M vs $5.00/M).

describe("extractLlmUsage — prompt-cache fields per provider", () => {
  it("OpenAI / Gemini-compat: prompt_tokens_details.cached_tokens", () => {
    const usage = extractLlmUsage({
      usage: {
        prompt_tokens: 6000,
        completion_tokens: 1500,
        total_tokens: 7500,
        prompt_tokens_details: { cached_tokens: 5000 }
      }
    });
    expect(usage.promptTokens).toBe(6000);
    expect(usage.cachedPromptTokens).toBe(5000);
    expect(usage.cacheCreationTokens).toBeUndefined();
  });

  it("DeepSeek: prompt_cache_hit_tokens", () => {
    const usage = extractLlmUsage({
      usage: { prompt_tokens: 5200, completion_tokens: 300, prompt_cache_hit_tokens: 4800 }
    });
    expect(usage.promptTokens).toBe(5200);
    expect(usage.cachedPromptTokens).toBe(4800);
  });

  it("Anthropic: input_tokens EXCLUDES cache tokens — promptTokens is normalized to the full prompt", () => {
    const usage = extractLlmUsage({
      usage: {
        input_tokens: 800,
        output_tokens: 400,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 1200
      }
    });
    // full prompt = 800 uncached + 4000 read + 1200 written
    expect(usage.promptTokens).toBe(6000);
    expect(usage.cachedPromptTokens).toBe(4000);
    expect(usage.cacheCreationTokens).toBe(1200);
  });

  it("xAI (Grok, OpenAI-compatible): prompt_tokens_details.cached_tokens", () => {
    // xAI's automatic prompt caching reports through the OpenAI-compatible details object.
    const usage = extractLlmUsage({
      usage: {
        prompt_tokens: 4200,
        completion_tokens: 180,
        prompt_tokens_details: { cached_tokens: 3600 }
      }
    });
    expect(usage.promptTokens).toBe(4200);
    expect(usage.cachedPromptTokens).toBe(3600);
  });

  it("Mistral (no prompt-cache fields): legacy shape, no cache tokens, cost at full input rate", () => {
    const usage = extractLlmUsage({ usage: { prompt_tokens: 3000, completion_tokens: 250, total_tokens: 3250 } });
    expect(usage).toEqual({ promptTokens: 3000, completionTokens: 250, totalTokens: 3250 });
    // Cost path: absent cache fields must be identical to the pre-change full-rate billing.
    expect(estimateLlmCostUsd("mistral-medium-3-5", usage.promptTokens, usage.completionTokens, usage.cachedPromptTokens, usage.cacheCreationTokens)).toBe(
      estimateLlmCostUsd("mistral-medium-3-5", 3000, 250)
    );
  });

  it("no cache fields → unchanged legacy shape", () => {
    const usage = extractLlmUsage({ usage: { prompt_tokens: 100, completion_tokens: 50 } });
    expect(usage).toEqual({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
  });
});

describe("estimateLlmCostUsd — cache-aware pricing", () => {
  it("prices cache reads at 0.1x input instead of full rate (gpt-5.5)", () => {
    // 6000 prompt (5000 cached) + 1500 out on gpt-5.5 ($5/$30):
    // uncached: 6000*5/1M = $0.03 ... full-price version:
    const fullPrice = estimateLlmCostUsd("openai/gpt-5.5", 6000, 1500);
    // cache-aware: (1000*5 + 5000*0.5)*1e-6 + 1500*30*1e-6
    const cached = estimateLlmCostUsd("openai/gpt-5.5", 6000, 1500, 5000);
    expect(fullPrice).toBeCloseTo((6000 * 5 + 1500 * 30) / 1_000_000, 10);
    expect(cached).toBeCloseTo((1000 * 5 + 5000 * 0.5 + 1500 * 30) / 1_000_000, 10);
    expect(cached!).toBeLessThan(fullPrice!);
  });

  it("prices Anthropic cache creation at 1.25x input", () => {
    // opus-4-8 ($5/$25): 6000 prompt = 800 full + 4000 read(0.1x) + 1200 creation(1.25x)
    const cost = estimateLlmCostUsd("anthropic/claude-opus-4-8", 6000, 400, 4000, 1200);
    const expected = ((800 + 4000 * 0.1 + 1200 * 1.25) * 5 + 400 * 25) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 10);
  });

  it("clamps malformed usage (cached > prompt) — never a negative cost", () => {
    const cost = estimateLlmCostUsd("openai/gpt-5.5", 1000, 0, 999999);
    // all 1000 treated as cached at 0.1x
    expect(cost).toBeCloseTo((1000 * 0.5) / 1_000_000, 10);
    expect(cost!).toBeGreaterThan(0);
  });

  it("back-compat: two-arg call unchanged", () => {
    expect(estimateLlmCostUsd("openai/gpt-5.5", 1000, 100)).toBeCloseTo((1000 * 5 + 100 * 30) / 1_000_000, 10);
  });

  it("openrouter/vendor/model 3-part form prices identically to bare model name", () => {
    // Before the fix, priceForModel stripped only ONE slash:
    //   "openrouter/openai/gpt-5.5" → "openai/gpt-5.5" (no price-table hit → fallback rate).
    // After the fix it strips "openrouter/" first, then "openai/" → "gpt-5.5" (correct rate).
    const bare = estimateLlmCostUsd("gpt-5.5", 1000, 100);
    const twopart = estimateLlmCostUsd("openai/gpt-5.5", 1000, 100);
    const threepart = estimateLlmCostUsd("openrouter/openai/gpt-5.5", 1000, 100);
    expect(bare).toBeCloseTo((1000 * 5 + 100 * 30) / 1_000_000, 10);
    expect(twopart).toBe(bare);
    expect(threepart).toBe(bare);
  });
});

describe("remapOpenRouterTelemetry — family identity", () => {
  it("maps OpenRouter Gemini Flash wire slugs onto gemini-flash-latest", () => {
    expect(remapOpenRouterTelemetry("openrouter", "~google/gemini-flash-latest")).toEqual({
      provider: "gemini",
      model: "gemini-flash-latest"
    });
    expect(remapOpenRouterTelemetry("openrouter", "google/gemini-3.7-flash")).toEqual({
      provider: "gemini",
      model: "gemini-flash-latest"
    });
    expect(remapOpenRouterTelemetry("openrouter", "google/gemini-3.5-flash-lite").model).toBe("gemini-flash-lite-latest");
    expect(remapOpenRouterTelemetry("openrouter", "google/gemini-3.1-pro-preview").model).toBe("gemini-pro-latest");
  });

  it("maps every Claude Opus slug onto claude-opus-latest", () => {
    expect(remapOpenRouterTelemetry("openrouter", "anthropic/claude-opus-4-8").model).toBe("claude-opus-latest");
    expect(remapOpenRouterTelemetry("anthropic", "claude-opus-4-8").model).toBe("claude-opus-latest");
    expect(remapOpenRouterTelemetry("openrouter", "anthropic/claude-opus-5-5").model).toBe("claude-opus-latest");
    expect(remapOpenRouterTelemetry("anthropic", "claude-opus-5-5").model).toBe("claude-opus-latest");
  });
});
