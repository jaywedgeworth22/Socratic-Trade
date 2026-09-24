import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { aggregateLlmStats, aggregateLlmStatsDualWindow, aliasForModel } from "../src/lib/llm-stats";
import { getDb } from "../src/lib/db";
import { recordLlmUsage } from "../src/lib/llm-usage";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-llmstats-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  getDb().prepare("DELETE FROM llm_usage").run();
});

const record = recordLlmUsage;

describe("aliasForModel", () => {
  it("collapses every opus generation into the 'opus' alias", () => {
    for (const id of [
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-opus-5.5",
      "claude-opus-latest",
      "anthropic/claude-opus-latest",
      "anthropic/claude-opus-5",
      "CLAUDE-OPUS-5",
      "Claude-Opus-5.5-Pro"
    ]) {
      const out = aliasForModel(id);
      expect(out.family, `expected opus family for ${id}`).toBe("opus");
      expect(out.label).toBe("opus");
    }
  });

  it("collapses sonnet / haiku / fable into their families", () => {
    expect(aliasForModel("claude-sonnet-4-6").family).toBe("sonnet");
    expect(aliasForModel("claude-sonnet-5").family).toBe("sonnet");
    expect(aliasForModel("anthropic/claude-sonnet-latest").family).toBe("sonnet");
    expect(aliasForModel("claude-haiku-4-5").family).toBe("haiku");
    expect(aliasForModel("claude-haiku-latest").family).toBe("haiku");
    expect(aliasForModel("claude-fable-5").family).toBe("fable");
  });

  it("collapses gpt-5.x variants into 'gpt-5' (per owner: gpt-5 family, not 5.5 vs 5.6)", () => {
    expect(aliasForModel("gpt-5.6-sol").family).toBe("gpt-5");
    expect(aliasForModel("gpt-5.6-luna").family).toBe("gpt-5");
    // gpt-6-astra-pro is intentionally NOT a gpt-5 alias — it's the next generation.
    expect(aliasForModel("gpt-6-astra-pro").family).not.toBe("gpt-5");
    expect(aliasForModel("gpt-4o").family).toBe("gpt-4o");
    expect(aliasForModel("gpt-4o-mini").family).toBe("gpt-mini");
    expect(aliasForModel("gpt-5.4-nano").family).toBe("gpt-nano");
  });

  it("collapses gemini flash / flash-lite / pro correctly", () => {
    expect(aliasForModel("gemini-flash-lite-latest").family).toBe("gemini-flash-lite");
    expect(aliasForModel("gemini-flash-latest").family).toBe("gemini-flash");
    expect(aliasForModel("gemini-3.8-flash").family).toBe("gemini-flash");
    expect(aliasForModel("gemini-pro-latest").family).toBe("gemini-pro");
    // flash-lite must NOT match flash (flash-lite matches first in the table).
    expect(aliasForModel("gemini-flash-lite-latest").family).not.toBe("gemini-flash");
  });

  it("collapses grok / deepseek / mistral / llama / kimi correctly", () => {
    expect(aliasForModel("grok-4.5").family).toBe("grok");
    expect(aliasForModel("grok-latest").family).toBe("grok");
    expect(aliasForModel("deepseek-v4-pro-0813").family).toBe("deepseek-pro");
    expect(aliasForModel("deepseek-pro-latest").family).toBe("deepseek-pro");
    expect(aliasForModel("deepseek-v4-flash-0731").family).toBe("deepseek-flash");
    expect(aliasForModel("deepseek-r1").family).toBe("deepseek-r1");
    expect(aliasForModel("mistral-large-2512").family).toBe("mistral-large");
    expect(aliasForModel("mistral-small-latest").family).toBe("mistral-small");
    expect(aliasForModel("llama-3.3-70b-instruct").family).toBe("llama");
    expect(aliasForModel("moonshot-v1-128k").family).toBe("kimi");
  });

  it("falls back to the canonical model id for unknown aliases (long tail)", () => {
    const out = aliasForModel("some-unknown-model-7b");
    expect(out.family).toBeNull();
    expect(out.label).toBe("some-unknown-model-7b");
  });

  it("returns empty label for null / blank input", () => {
    expect(aliasForModel(null).label).toBe("");
    expect(aliasForModel(undefined).label).toBe("");
    expect(aliasForModel("").label).toBe("");
  });
});

describe("aggregateLlmStats (single window)", () => {
  it("sums cost, tokens, and latency percentiles per alias", () => {
    const now = Date.now();
    const iso = (offset: number) => new Date(now - offset).toISOString();
    // Two opus calls (openrouter provider so billedCostUsd is honored as the actual cost),
    // one sonnet (estimated via price table — anthropic provider), one unknown model.
    record({
      userId: "local",
      provider: "openrouter",
      model: "anthropic/claude-opus-4-8",
      context: "test",
      keySource: "user",
      promptTokens: 1000,
      completionTokens: 500,
      billedCostUsd: 0.01,
      latencyMs: 1500,
      status: "success",
      createdAtOverride: iso(0)
    } as never);
    record({
      userId: "local",
      provider: "openrouter",
      model: "anthropic/claude-opus-5",
      context: "test",
      keySource: "user",
      promptTokens: 1000,
      completionTokens: 500,
      billedCostUsd: 0.01,
      latencyMs: 2500,
      status: "success",
      createdAtOverride: iso(0)
    } as never);
    record({
      userId: "local",
      provider: "anthropic",
      model: "claude-sonnet-5",
      context: "test",
      keySource: "user",
      promptTokens: 1000,
      completionTokens: 500,
      latencyMs: 800,
      status: "success",
      createdAtOverride: iso(0)
    } as never);
    record({
      userId: "local",
      provider: "openrouter",
      model: "some-random-7b",
      context: "test",
      keySource: "user",
      promptTokens: 100,
      completionTokens: 50,
      latencyMs: 600,
      status: "error",
      createdAtOverride: iso(0)
    } as never);
    const rows = aggregateLlmStats();
    const opus = rows.find((r) => r.alias === "opus");
    const sonnet = rows.find((r) => r.alias === "sonnet");
    const randomRow = rows.find((r) => r.alias === "some-random-7b");
    expect(opus).toBeDefined();
    expect(opus!.calls).toBe(2);
    expect(opus!.billedCostUsd).toBeCloseTo(0.02);
    expect(opus!.sourceModels).toEqual(expect.arrayContaining(["anthropic/claude-opus-4-8", "anthropic/claude-opus-5"]));
    expect(opus!.latencyP50).toBe(1500); // nearest-rank p50 of [1500, 2500] = 1500
    expect(opus!.latencyP95).toBe(2500);
    expect(sonnet!.calls).toBe(1);
    // sonnet is anthropic provider → estimated via price table (claude-sonnet-5 = $2/$10).
    // 1000 prompt * 2/1M + 500 completion * 10/1M = 0.002 + 0.005 = 0.007.
    expect(sonnet!.estimatedCostUsd).toBeCloseTo(0.007, 3);
    expect(sonnet!.billedCostUsd).toBe(0);
    expect(randomRow).toBeDefined();
    expect(randomRow!.errorCalls).toBe(1);
  });
});

describe("aggregateLlmStatsDualWindow", () => {
  it("returns all-time + last-90d as separate arrays", () => {
    // 1 row within 90d, 1 row older than 90d.
    const now = Date.now();
    record({
      userId: "local",
      provider: "anthropic",
      model: "claude-opus-5",
      context: "test",
      keySource: "user",
      promptTokens: 100,
      completionTokens: 50,
      billedCostUsd: 0.005,
      costSource: "billed",
      latencyMs: 1000,
      status: "success",
      createdAtOverride: new Date(now - 5 * 24 * 3600_000).toISOString()
    } as never);
    record({
      userId: "local",
      provider: "anthropic",
      model: "claude-opus-4-8",
      context: "test",
      keySource: "user",
      promptTokens: 100,
      completionTokens: 50,
      billedCostUsd: 0.005,
      costSource: "billed",
      latencyMs: 1100,
      status: "success",
      createdAtOverride: new Date(now - 200 * 24 * 3600_000).toISOString()
    } as never);
    const dual = aggregateLlmStatsDualWindow();
    expect(dual.allTime.find((r) => r.alias === "opus")!.calls).toBe(2);
    expect(dual.last90d.find((r) => r.alias === "opus")!.calls).toBe(1);
  });
});
