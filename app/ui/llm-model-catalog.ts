// Picker types + groups derived from the canonical three-column catalog
// (`src/lib/llm-model-catalog.ts`).  Persisted values are display slugs only.

import {
  CATALOG_DISPLAY_SLUGS,
  LLM_MODEL_CATALOG,
  type CatalogProviderId
} from "@/lib/llm-model-catalog";

export type PickerProviderId =
  | CatalogProviderId
  | "openrouter"
  | "offline";

export interface ModelOption {
  value: string;
  label: string;
  tier: "" | "$" | "$$" | "$$$";
  recommendedGreen?: boolean;
  recommendedRed?: boolean;
}

export interface ModelGroup {
  provider: PickerProviderId;
  label: string;
  options: ModelOption[];
}

export const CUSTOM_MODEL_ID_SEED = "custom-model-id";

/**
 * Sentinel model id meaning "rotate through all eligible curated models — a different one each
 * run" (comparative-measurement option for accruing attributed history across models on any real
 * broker account). Persisted as-is on policy.llmModel / policy.redTeamLlmModel; the strategy
 * run substitutes a concrete representation-weighted pick at run start (src/lib/model-rotation.ts —
 * models with no resolvable provider key are skipped; models underrepresented in recent rotation
 * history are twice as likely to be picked). Keep the literal in sync with
 * LLM_MODEL_ROTATION_SENTINEL in src/lib/llm-request.ts.
 */
export const ROTATE_ALL_MODELS_ID = "__rotate__";
export const ROTATE_ALL_MODELS_LABEL = "Rotate eligible models (comparative measurement)";

const PROVIDER_LABEL: Record<CatalogProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  xai: "xAI",
  gemini: "Google",
  mistral: "Mistral",
  moonshot: "Moonshot AI (Kimi)",
  minimax: "MiniMax",
  deepseek: "DeepSeek",
  // Was "Meta (via OpenRouter)" — every catalog model is served over OpenRouter whenever an
  // OpenRouter credential is configured (src/lib/llm-provider.ts resolveLlmEndpoint), so
  // singling out Meta implied a routing distinction that does not exist. See
  // docs/rollouts/2026-09-18-model-catalog-cleanup.md.
  meta: "Meta"
};

const PROVIDER_ORDER: CatalogProviderId[] = [
  "openai",
  "anthropic",
  "xai",
  "gemini",
  "mistral",
  "moonshot",
  "minimax",
  "deepseek",
  "meta"
];

export const CURATED_LLM_MODEL_GROUPS: ModelGroup[] = PROVIDER_ORDER.map((provider) => ({
  provider,
  label: PROVIDER_LABEL[provider],
  options: LLM_MODEL_CATALOG.filter((row) => row.provider === provider).map((row) => ({
    value: row.displaySlug,
    label: row.label,
    tier: row.tier,
    recommendedGreen: row.recommendedGreen,
    recommendedRed: row.recommendedRed
  }))
}));

export const CURATED_LLM_MODEL_IDS = [...CATALOG_DISPLAY_SLUGS];

export const CHAT_MODEL_GROUPS: ModelGroup[] = [
  ...CURATED_LLM_MODEL_GROUPS,
  {
    provider: "openrouter",
    label: "Other",
    options: [{ value: "custom", label: "Custom Model ID...", tier: "" }]
  }
];
