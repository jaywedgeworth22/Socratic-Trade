import { describe, expect, it } from "vitest";
import { deriveRetiredModelIds } from "../app/console/components/model-stats-drawer";
import { CURATED_LLM_MODEL_IDS } from "../app/ui/llm-model-catalog";

/** 2026-09-18: the Model Stats drawer only ever iterated CURATED_LLM_MODEL_GROUPS (the CURRENT
 *  curated catalog), so a model that left the catalog — e.g. minimax-m2.7, removed in the same
 *  cleanup that motivated this test — lost its cost/latency/performance history off the screen
 *  entirely, even though the API still returns stats rows for it. deriveRetiredModelIds is the
 *  pure "ids with stats minus ids in the catalog" computation behind the trailing "Retired
 *  Models" group; this file tests it directly rather than rendering the client component. */
describe("deriveRetiredModelIds", () => {
  it("returns nothing when every stats id is still in the catalog", () => {
    expect(deriveRetiredModelIds(["gpt-6-astra", "claude-sonnet-latest"], ["gpt-6-astra", "claude-sonnet-latest", "grok-latest"])).toEqual([]);
  });

  it("returns stats ids that are not in the catalog, sorted", () => {
    const statsModelIds = ["gpt-6-astra", "minimax-m2.7", "gpt-4o-mini", "gemini-flash-latest"];
    const catalogModelIds = ["gpt-6-astra", "gemini-flash-latest", "minimax-m3"];
    expect(deriveRetiredModelIds(statsModelIds, catalogModelIds)).toEqual(["gpt-4o-mini", "minimax-m2.7"]);
  });

  it("dedupes a retired id that appears more than once in the stats input", () => {
    expect(deriveRetiredModelIds(["deepseek-r1", "deepseek-r1", "llama-4-scout"], ["deepseek-pro-latest"])).toEqual(["deepseek-r1", "llama-4-scout"]);
  });

  it("is empty when there are no recorded stats at all", () => {
    expect(deriveRetiredModelIds([], CURATED_LLM_MODEL_IDS)).toEqual([]);
  });

  it("derives from the live curated catalog (not a hardcoded removed-model list), so a model still in the catalog never shows as retired", () => {
    for (const id of CURATED_LLM_MODEL_IDS) {
      expect(deriveRetiredModelIds([id], CURATED_LLM_MODEL_IDS)).toEqual([]);
    }
  });
});
