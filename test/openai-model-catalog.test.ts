import { describe, expect, it } from "vitest";
import { modelDisplayName } from "../app/console/lib/models";
import { CHAT_MODEL_GROUPS, CURATED_LLM_MODEL_GROUPS } from "../app/ui/llm-model-catalog";
import { reasoningCapabilityForModel } from "../src/lib/llm-request";
import {
  reasoningAdviceForModel,
  recommendedReasoningEffortForModel
} from "../src/lib/model-reasoning-recommendations";

describe("curated OpenAI model choices across LLM surfaces", () => {
  const openAi = CURATED_LLM_MODEL_GROUPS.find((group) => group.provider === "openai")!;

  // 2026-09-18 catalog cleanup (cursor/model-catalog-cleanup, #3414): the curated OpenAI group
  // dropped 5 strictly-dominated rows (gpt-5.4-nano, gpt-mini-latest, gpt-5.6-terra, gpt-4o,
  // gpt-4o-mini). Only four rows remain: gpt-6-astra-pro (the pro-reasoning-mode alias of astra),
  // gpt-6-astra, gpt-5.6-luna, and gpt-5.6-sol. Green recommendation moved from terra to sol;
  // sol now carries BOTH green and red chips.
  it("offers the four curated OpenAI rows: Astra (frontier) + Sol (Green/Red) + Luna (cost-sensitive)", () => {
    expect(openAi.options.map((option) => option.value)).toEqual([
      "gpt-6-astra-pro",
      "gpt-6-astra",
      "gpt-5.6-luna",
      "gpt-5.6-sol"
    ]);
    expect(openAi.options.find((option) => option.value === "gpt-5.6-sol")?.recommendedGreen).toBe(true);
    expect(openAi.options.find((option) => option.value === "gpt-5.6-sol")?.recommendedRed).toBe(true);
    expect(openAi.options.some((option) => option.value === "gpt-5.6-terra")).toBe(false);
    expect(openAi.options.some((option) => option.value === "gpt-4o" || option.value === "gpt-4o-mini")).toBe(false);
    expect(openAi.options.some((option) => option.value === "gpt-mini-latest" || option.value === "gpt-5.4-nano")).toBe(false);
  });

  it("shares the exact curated OpenAI options with Coach/chat", () => {
    expect(CHAT_MODEL_GROUPS.find((group) => group.provider === "openai")?.options).toEqual(openAi.options);
  });

  it("has a visible reasoning control and role-specific recommendation for every curated OpenAI option", () => {
    // All four remaining OpenAI rows are reasoning-capable (frontier + cost-sensitive).
    for (const option of openAi.options) {
      expect(reasoningCapabilityForModel(option.value)).toBeDefined();
      expect(recommendedReasoningEffortForModel(option.value, "green")).toBeTruthy();
      expect(recommendedReasoningEffortForModel(option.value, "red")).toBeTruthy();
      expect(recommendedReasoningEffortForModel(option.value, "chat")).toBeTruthy();
      expect(recommendedReasoningEffortForModel(option.value, "review")).toBeTruthy();
      expect(modelDisplayName(option.value)).toMatch(/^GPT/);
    }
  });


  it("pins the intended role/effort guidance for the remaining GPT-5.6 rows", () => {
    expect(recommendedReasoningEffortForModel("gpt-5.6-luna", "chat")).toBe("low");
    expect(recommendedReasoningEffortForModel("gpt-5.6-luna", "green")).toBe("medium");
    expect(recommendedReasoningEffortForModel("gpt-5.6-sol", "green")).toBe("medium");
    expect(recommendedReasoningEffortForModel("gpt-5.6-sol", "red")).toBe("high");
    expect(recommendedReasoningEffortForModel("gpt-5.6-sol", "review")).toBe("high");
  });
});
