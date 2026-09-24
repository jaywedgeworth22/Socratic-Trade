import os from "os";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = `file:${path.join(os.tmpdir(), `llm-catalog-test-${Date.now()}.db`)}`;

// 21 rows as of the 2026-09-18 model-catalog cleanup (down from 32) — see
// docs/rollouts/2026-09-18-model-catalog-cleanup.md for the removed rows and why.
const OWNER_ROWS: Array<[string, string, string]> = [
  ["gpt-6-astra-pro", "openai/gpt-6-astra-pro", "gpt-6-astra-pro"],
  ["gpt-6-astra", "openai/gpt-6-astra", "gpt-6-astra"],
  ["minimax-m3", "minimax/minimax-m3", "MiniMax-M3"],
  ["muse-spark-1.3", "meta/muse-spark-1.3", "muse-spark-1.3"],
  ["muse-glimmer-30b", "meta/muse-glimmer-30b", "muse-glimmer-30b"],
  ["gpt-5.6-sol", "openai/gpt-5.6-sol", "gpt-5.6-sol"],
  ["gpt-5.6-luna", "openai/gpt-5.6-luna", "gpt-5.6-luna"],
  ["claude-sonnet-latest", "~anthropic/claude-sonnet-latest", "claude-sonnet-5"],
  ["claude-haiku-latest", "~anthropic/claude-haiku-latest", "claude-haiku-4-5-20251001"],
  ["claude-opus-latest", "~anthropic/claude-opus-latest", "claude-opus-5-5"],
  ["claude-fable-latest", "~anthropic/claude-fable-latest", "claude-fable-5-1"],
  ["grok-latest", "~x-ai/grok-latest", "grok-4.6"],
  ["gemini-flash-lite-latest", "google/gemini-3.5-flash-lite", "gemini-flash-lite-latest"],
  ["gemini-flash-latest", "~google/gemini-flash-latest", "gemini-flash-latest"],
  ["gemini-pro-latest", "~google/gemini-pro-latest", "gemini-pro-latest"],
  ["mistral-large-latest", "mistralai/mistral-large-2512", "mistral-large-latest"],
  ["mistral-medium-latest", "mistralai/mistral-medium-3-5", "mistral-medium-latest"],
  ["mistral-small-latest", "mistralai/mistral-small-2603", "mistral-small-latest"],
  ["kimi-latest", "~moonshotai/kimi-latest", "kimi-latest"],
  ["deepseek-flash-latest", "deepseek/deepseek-v4-flash-0731", "deepseek-v4-flash"],
  ["deepseek-pro-latest", "deepseek/deepseek-v4-pro-0813", "deepseek-v4-pro"]
];

const ALIASES: Array<[string, string]> = [
  ["claude-sonnet-5", "claude-sonnet-latest"],
  ["claude-haiku-4.5", "claude-haiku-latest"],
  ["claude-opus-5-5", "claude-opus-latest"],
  ["claude-opus-5.5", "claude-opus-latest"],
  ["claude-opus-5", "claude-opus-latest"],
  ["claude-fable-5", "claude-fable-latest"],
  ["grok-4.5", "grok-latest"],
  ["deepseek-v4-flash", "deepseek-flash-latest"],
  ["deepseek-v4-pro", "deepseek-pro-latest"],
  ["gemini-3.5-flash-lite", "gemini-flash-lite-latest"],
  ["google/gemini-3.7-flash", "gemini-flash-latest"],
  ["mistral-medium-3.5", "mistral-medium-latest"],
  ["mistral-medium-3-5", "mistral-medium-latest"]
];

describe("three-column LLM catalog", () => {
  let CURATED_LLM_MODEL_IDS: string[];
  let CATALOG_DISPLAY_SLUGS: readonly string[];
  let LLM_MODEL_CATALOG: ReadonlyArray<{ displaySlug: string; openRouterSlug: string; label: string }>;
  let CURATED_LLM_MODEL_GROUPS: ReadonlyArray<{ label: string; options: ReadonlyArray<{ label: string }> }>;
  let displaySlugFor: (model: string | null | undefined) => string;
  let nativeSlugFor: (model: string | null | undefined) => string;
  let openRouterSlugFor: (model: string | null | undefined) => string;
  let nativeModelSlugForProvider: (model: string, family: "openai") => string;
  let normalizeOpenRouterModelId: (raw?: string) => string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolveLlmEndpoint: (...args: any[]) => { provider: string; model: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let upsertUserApiKey: (...args: any[]) => unknown;

  beforeAll(async () => {
    const { getDb } = await import("../src/lib/db");
    getDb();
    const dbApi = await import("../src/lib/db-api-keys");
    upsertUserApiKey = dbApi.upsertUserApiKey;
    const catalog = await import("../src/lib/llm-model-catalog");
    CATALOG_DISPLAY_SLUGS = catalog.CATALOG_DISPLAY_SLUGS;
    LLM_MODEL_CATALOG = catalog.LLM_MODEL_CATALOG;
    displaySlugFor = catalog.displaySlugFor;
    nativeSlugFor = catalog.nativeSlugFor;
    openRouterSlugFor = catalog.openRouterSlugFor;
    const ui = await import("../app/ui/llm-model-catalog");
    CURATED_LLM_MODEL_IDS = ui.CURATED_LLM_MODEL_IDS;
    CURATED_LLM_MODEL_GROUPS = ui.CURATED_LLM_MODEL_GROUPS;
    const provider = await import("../src/lib/llm-provider");
    nativeModelSlugForProvider = provider.nativeModelSlugForProvider;
    normalizeOpenRouterModelId = provider.normalizeOpenRouterModelId;
    resolveLlmEndpoint = provider.resolveLlmEndpoint;
  });

  it("contains exactly the owner display slugs", () => {
    expect([...CATALOG_DISPLAY_SLUGS].sort()).toEqual(OWNER_ROWS.map(([display]) => display).sort());
    expect(new Set(CURATED_LLM_MODEL_IDS)).toEqual(new Set(CATALOG_DISPLAY_SLUGS));
    expect(new Set(LLM_MODEL_CATALOG.map((row) => row.displaySlug)).size).toBe(OWNER_ROWS.length);
  });

  it("resolves OpenRouter wire slugs (column 2) and native slugs (column 3)", () => {
    for (const [display, openRouter, native] of OWNER_ROWS) {
      expect(openRouterSlugFor(display), display).toBe(openRouter);
      expect(normalizeOpenRouterModelId(display), display).toBe(openRouter);
      expect(nativeSlugFor(display), display).toBe(native);
      expect(nativeModelSlugForProvider(display, "openai"), display).toBe(native);
    }
  });

  it("round-trips older persisted ids onto the new display slugs", () => {
    for (const [alias, display] of ALIASES) {
      expect(displaySlugFor(alias), alias).toBe(display);
      const row = OWNER_ROWS.find(([id]) => id === display)!;
      expect(normalizeOpenRouterModelId(alias), alias).toBe(row[1]);
      expect(nativeSlugFor(alias), alias).toBe(row[2]);
    }
  });

  it("never sends a display slug to OpenRouter when the wire slug differs", () => {
    expect(normalizeOpenRouterModelId("grok-latest")).toBe("~x-ai/grok-latest");
    expect(normalizeOpenRouterModelId("gemini-flash-lite-latest")).toBe("google/gemini-3.5-flash-lite");
    expect(normalizeOpenRouterModelId("deepseek-flash-latest")).toBe("deepseek/deepseek-v4-flash-0731");
    expect(normalizeOpenRouterModelId("deepseek-pro-latest")).toBe("deepseek/deepseek-v4-pro-0813");
    expect(normalizeOpenRouterModelId("mistral-small-latest")).toBe("mistralai/mistral-small-2603");
    expect(normalizeOpenRouterModelId("mistral-medium-latest")).toBe("mistralai/mistral-medium-3-5");
    expect(nativeSlugFor("openai/gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(nativeSlugFor("anthropic/claude-sonnet-latest")).toBe("claude-sonnet-5");
  });

  it("constructs live OpenRouter calls with the wire slug", () => {
    upsertUserApiKey("catalog-or-user", "openrouter", "sk-or-catalog-test");
    const endpoint = resolveLlmEndpoint({ llmModel: "grok-latest" }, "catalog-or-user");
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.model).toBe("~x-ai/grok-latest");
    const aliased = resolveLlmEndpoint({ llmModel: "claude-sonnet-5" }, "catalog-or-user");
    expect(aliased.model).toBe("~anthropic/claude-sonnet-latest");
  });

  it("sends OpenRouter family-latest aliases with the required ~ prefix", () => {
    const latestWire = OWNER_ROWS
      .map(([, openRouter]) => openRouter)
      .filter((slug) => /-(?:latest)$/.test(slug.replace(/^~/, "").split("/")[1] ?? ""));
    expect(latestWire.length).toBeGreaterThan(0);
    for (const slug of latestWire) {
      expect(slug.startsWith("~"), slug).toBe(true);
    }
    expect(openRouterSlugFor("gemini-flash-latest:batch")).toBe("google/gemini-3.8-flash:batch");
    expect(normalizeOpenRouterModelId("google/gemini-3.6-flash:batch")).toBe("google/gemini-3.8-flash:batch");
  });

  // Owner formatting/copy rules (2026-09-18 model-catalog cleanup) — see
  // docs/rollouts/2026-09-18-model-catalog-cleanup.md.
  it("formats every dropdown row like the stats/benchmark page (slug-first) and never mentions OpenRouter", () => {
    for (const row of LLM_MODEL_CATALOG) {
      expect(row.label.startsWith(row.displaySlug), row.displaySlug).toBe(true);
      expect(row.label, row.displaySlug).not.toMatch(/openrouter/i);
    }
    for (const group of CURATED_LLM_MODEL_GROUPS) {
      expect(group.label).not.toMatch(/openrouter/i);
      for (const option of group.options) {
        expect(option.label).not.toMatch(/openrouter/i);
      }
    }
  });

  it("never routes two rows to the same OpenRouter wire slug (astra / astra-pro excepted)", () => {
    const astraPair = new Set(["gpt-6-astra", "gpt-6-astra-pro"]);
    const seen = new Map<string, string>();
    for (const row of LLM_MODEL_CATALOG) {
      if (astraPair.has(row.displaySlug)) continue;
      const prior = seen.get(row.openRouterSlug);
      expect(prior, `${row.displaySlug} and ${prior} both route to ${row.openRouterSlug}`).toBeUndefined();
      seen.set(row.openRouterSlug, row.displaySlug);
    }
  });
});
