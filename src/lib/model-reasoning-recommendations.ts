// model-reasoning-recommendations.ts — curated per-model reasoning/thinking-effort guidance.
//
// This extends the curated model-recommendations data (PR #849's catalog chips in
// app/ui/llm-model-catalog.ts) with the REASONING dimension, kept in src/lib because two
// consumers need it and src/lib must not import from app/:
//   1. Model rotation (src/lib/model-rotation.ts): a rotating seat auto-sets each served model's
//      reasoning effort to its recommended level (unknown model -> "medium") — there is no manual
//      effort control under rotation.
//   2. The Strategy Models UI (app/console/strategy/page.tsx): per-seat advice text under each
//      reasoning control, shown BEFORE any save (e.g. the gpt-5.5 interactive-high rule).
//
// Every recommendation is still re-clamped per model at call time by
// `normalizeReasoningEffortForModel` / `interactiveStrategyReasoningEffort` (llm-request.ts), so a
// stale or wrong entry here can never send an unsupported effort on the wire — this data is
// guidance + rotation defaults, not a wire contract. Keep entries keyed by the exact curated
// catalog ids (app/ui/llm-model-catalog.ts CURATED_LLM_MODEL_GROUPS / MODEL_ROTATION_POOL).

import { displaySlugFor } from "./llm-model-catalog";
import type { LlmReasoningEffort } from "./types";

export interface ModelReasoningRecommendation {
  /** The curated recommended effort for this model (what rotation serves it at). */
  effort: LlmReasoningEffort;
  /** Optional role-specific override. The base effort is the Green/default recommendation. */
  roleEfforts?: Partial<Record<ModelReasoningRole, LlmReasoningEffort>>;
  /** Optional owner-facing advice rendered under the seat's reasoning control when this model is
   *  selected — only present where there is something real to say (provider quirks, the gpt-5.5
   *  interactive-high rule, opt-in slow tiers). */
  advice?: string;
}

export type ModelReasoningRole = "green" | "red" | "chat" | "review";

/** Rotation's effort for a model with no curated entry (task rule: unknown -> medium). The
 *  per-model clamp at call time still applies (e.g. "medium" resolves to thinking-off on
 *  DeepSeek/Mistral opt-in providers, and to nothing at all on models without the knob). */
export const DEFAULT_REASONING_RECOMMENDATION_EFFORT: LlmReasoningEffort = "medium";

const GPT_55_INTERACTIVE_HIGH_ADVICE =
  "High reasoning on gpt-5.5 is disabled for interactive strategy runs — a save that sets it is " +
  "rejected, and run time clamps any stored High to Medium. Use Medium (recommended) or Low.";

const DEEPSEEK_OPT_IN_ADVICE =
  "DeepSeek thinking is opt-in: any effort below High runs with thinking OFF (the fast tier — " +
  "recommended). High/Max spend a long hidden-thinking phase that can blow past the strategy " +
  "run's soft timeout; choose them only if you accept the latency.";

const MISTRAL_MEDIUM_ADVICE =
  "Mistral Medium accepts only None or High reasoning (provider-enforced). In the 2026-07-10 " +
  "benchmark, None (recommended) ran ~1.3s/~$0.012 per call but returned an EMPTY proposal list " +
  "every round; High actually proposed (schema-valid, brackets included) but took ~50s/~$0.07 " +
  "per call, and one of two benchmarked calls exceeded even the widened reasoning timeout.";

export const MODEL_REASONING_RECOMMENDATIONS: Record<string, ModelReasoningRecommendation> = {
  "gpt-6-astra-pro": { effort: "medium" },
  "gpt-6-astra": { effort: "medium" },
  // GPT-5.6
  "gpt-5.6": {
    effort: "medium",
    roleEfforts: { red: "high", review: "high", chat: "medium" },
    advice: "Sol: Medium for Green/Coach; High for Red Team or one-off strategy/learning review."
  },
  "gpt-5.6-sol": {
    effort: "medium",
    roleEfforts: { red: "high", review: "high", chat: "medium" },
    advice: "Sol: Medium for Green/Coach; High for Red Team or one-off strategy/learning review."
  },
  "gpt-5.6-luna": {
    effort: "medium",
    roleEfforts: { red: "medium", review: "medium", chat: "low" },
    advice: "Luna: Low for chat/high-volume synthesis; Medium for Green."
  },
  // Anthropic
  "claude-haiku-latest": { effort: "medium" },
  "claude-sonnet-latest": { effort: "medium" },
  "claude-opus-latest": { effort: "medium" },
  "claude-fable-latest": { effort: "medium" },
  // xAI
  "grok-latest": { effort: "medium" },
  // Gemini
  "gemini-flash-lite-latest": { effort: "medium" },
  "gemini-flash-latest": { effort: "medium" },
  "gemini-pro-latest": { effort: "medium" },
  // DeepSeek
  "deepseek-flash-latest": { effort: "none", advice: DEEPSEEK_OPT_IN_ADVICE },
  "deepseek-pro-latest": { effort: "none", advice: DEEPSEEK_OPT_IN_ADVICE },
  // Mistral
  "mistral-small-latest": { effort: "none" },
  "mistral-medium-latest": { effort: "none", advice: MISTRAL_MEDIUM_ADVICE },
  "mistral-large-latest": { effort: "medium" }
};

function lookup(model: string | undefined): ModelReasoningRecommendation | undefined {
  const display = displaySlugFor(model);
  if (display && MODEL_REASONING_RECOMMENDATIONS[display]) {
    return MODEL_REASONING_RECOMMENDATIONS[display];
  }
  let id = (model ?? "").trim();
  if (id.includes("/")) {
    id = id.split("/").pop()!;
  }
  return id ? MODEL_REASONING_RECOMMENDATIONS[id] : undefined;
}

/** The curated recommended effort for a model; unknown/custom ids get the "medium" default.
 *  Rotation serves every rotated model at this level (clamped per model at call time). */
export function recommendedReasoningEffortForModel(
  model: string | undefined,
  role: ModelReasoningRole = "green"
): LlmReasoningEffort {
  const recommendation = lookup(model);
  return recommendation?.roleEfforts?.[role] ?? recommendation?.effort ?? DEFAULT_REASONING_RECOMMENDATION_EFFORT;
}

/** Curated advice text for a model's reasoning control, or undefined when there is nothing
 *  model-specific worth saying. */
export function reasoningAdviceForModel(model: string | undefined): string | undefined {
  return lookup(model)?.advice;
}
