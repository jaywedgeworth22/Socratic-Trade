/**
 * Canonical three-column LLM catalog (owner 2026-08-21).
 *
 * 1. displaySlug — persisted / UI / settings / logs / picker
 * 2. openRouterSlug — OpenRouter chat/completions `model` on live calls
 * 3. nativeSlug — direct provider APIs (not used for live traffic today)
 *
 * Parentheticals in owner copy (e.g. "gemini-pro-latest (3.1)") are version hints
 * only.  They are never stored.
 */

export type CatalogProviderId =
  | "openai"
  | "anthropic"
  | "xai"
  | "gemini"
  | "mistral"
  | "deepseek"
  | "meta"
  | "moonshot"
  | "minimax";

export type CatalogTier = "" | "$" | "$$" | "$$$";

export interface LlmCatalogEntry {
  displaySlug: string;
  openRouterSlug: string;
  nativeSlug: string;
  /** No supported direct-provider transport in this app. */
  openRouterOnly?: boolean;
  provider: CatalogProviderId;
  label: string;
  tier: CatalogTier;
  recommendedGreen?: boolean;
  recommendedRed?: boolean;
  /** Older persisted / OpenRouter / native ids that must resolve to this row. */
  aliases: readonly string[];
  /** Model family/lineage identifier (e.g. "openai-sol", "anthropic-sonnet", "google-flash"). */
  lineage?: string;
  /** Immediate and historical predecessor model slugs whose stats roll forward into this model. */
  predecessors?: readonly string[];
}

export const LLM_MODEL_CATALOG: readonly LlmCatalogEntry[] = [
  {
    displaySlug: "gpt-6-astra-pro",
    openRouterSlug: "openai/gpt-6-astra-pro",
    nativeSlug: "gpt-6-astra-pro",
    openRouterOnly: true,
    provider: "openai",
    // Same underlying model as gpt-6-astra, served with reasoning.mode=pro (same $/token,
    // more thinking tokens per call). OpenAI's native API has no gpt-6-astra-pro model id —
    // "pro" is a request parameter there, not a distinct SKU — hence openRouterOnly above.
    label: "gpt-6-astra-pro — GPT-6 Astra in pro reasoning mode (more thinking per call)",
    tier: "$$$",
    aliases: ["openai/gpt-6-astra-pro"],
    lineage: "openai-astra",
    predecessors: ["gpt-6-astra"]
  },
  {
    displaySlug: "gpt-6-astra",
    openRouterSlug: "openai/gpt-6-astra",
    nativeSlug: "gpt-6-astra",
    provider: "openai",
    label: "gpt-6-astra — frontier OpenAI reasoning",
    tier: "$$$",
    aliases: ["openai/gpt-6-astra"],
    lineage: "openai-astra",
    predecessors: ["gpt-5.6-sol", "gpt-5.6-terra"]
  },
  {
    displaySlug: "gpt-5.6-luna",
    openRouterSlug: "openai/gpt-5.6-luna",
    nativeSlug: "gpt-5.6-luna",
    provider: "openai",
    label: "gpt-5.6-luna — current cost-sensitive tier",
    tier: "$$",
    aliases: ["gpt-luna-latest", "openai/gpt-5.6-luna"],
    lineage: "openai-luna",
    predecessors: ["gpt-luna-latest", "gpt-5.4", "gpt-4o-mini"]
  },
  {
    displaySlug: "gpt-5.6-sol",
    openRouterSlug: "openai/gpt-5.6-sol",
    nativeSlug: "gpt-5.6-sol",
    provider: "openai",
    label: "gpt-5.6-sol — frontier professional reasoning",
    tier: "$$$",
    // Green recommendation moved here from the removed gpt-5.6-terra (2026-09-18): same
    // input price as terra, cheaper output, and the stronger model — see
    // docs/rollouts/2026-09-18-model-catalog-cleanup.md.
    recommendedGreen: true,
    recommendedRed: true,
    aliases: ["gpt-sol-latest", "openai/gpt-5.6-sol", "gpt-5.6"],
    lineage: "openai-sol",
    predecessors: ["gpt-5.6-terra", "gpt-5.5", "gpt-5.6"]
  },
  {
    displaySlug: "claude-haiku-latest",
    openRouterSlug: "~anthropic/claude-haiku-latest",
    nativeSlug: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    label: "claude-haiku-latest (4.5) — fast low-cost Claude",
    tier: "$",
    recommendedGreen: true,
    aliases: [
      "claude-haiku-4.5",
      "claude-haiku-4-5",
      "claude-haiku",
      "anthropic/claude-haiku-latest",
      "anthropic/claude-haiku-4.5"
    ],
    lineage: "anthropic-haiku",
    predecessors: ["claude-haiku-4.5", "claude-haiku-4-5", "claude-haiku"]
  },
  {
    displaySlug: "claude-sonnet-latest",
    openRouterSlug: "~anthropic/claude-sonnet-latest",
    nativeSlug: "claude-sonnet-5",
    provider: "anthropic",
    label: "claude-sonnet-latest (5) — balanced Claude analysis",
    tier: "$$",
    recommendedRed: true,
    aliases: [
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4.6",
      "claude-sonnet",
      "anthropic/claude-sonnet-latest",
      "anthropic/claude-sonnet-5"
    ],
    lineage: "anthropic-sonnet",
    predecessors: ["claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4.6", "claude-3-5-sonnet"]
  },
  {
    displaySlug: "claude-opus-latest",
    openRouterSlug: "~anthropic/claude-opus-latest",
    nativeSlug: "claude-opus-5",
    provider: "anthropic",
    label: "claude-opus-latest (5) — premium Claude reasoning",
    tier: "$$$",
    aliases: [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4.8",
      "claude-opus",
      "anthropic/claude-opus-latest",
      "anthropic/claude-opus-5"
    ],
    lineage: "anthropic-opus",
    predecessors: ["claude-opus-5", "claude-opus-4-8", "claude-opus-4.8"]
  },
  {
    displaySlug: "claude-fable-latest",
    openRouterSlug: "~anthropic/claude-fable-latest",
    nativeSlug: "claude-fable-5-1",
    provider: "anthropic",
    label: "claude-fable-latest (5.1) — most capable Claude",
    tier: "$$$",
    aliases: ["claude-fable-5-1", "claude-fable-5.1", "anthropic/claude-fable-5.1", "claude-fable-5", "claude-fable", "anthropic/claude-fable-latest", "anthropic/claude-fable-5"],
    lineage: "anthropic-fable",
    predecessors: ["claude-fable-5-1", "claude-fable-5"]
  },
  {
    displaySlug: "grok-latest",
    openRouterSlug: "~x-ai/grok-latest",
    nativeSlug: "grok-4.6",
    provider: "xai",
    label: "grok-latest (4.6) — default Grok analysis",
    tier: "$$",
    aliases: ["grok-4.6", "x-ai/grok-4.6", "grok-4.5", "grok-4.3", "grok", "x-ai/grok-latest", "x-ai/grok-4.5", "xai/grok-latest"],
    lineage: "xai-grok",
    predecessors: ["grok-4.6", "grok-4.5", "grok-4.3", "grok-build-0.1"]
  },
  {
    displaySlug: "gemini-flash-lite-latest",
    openRouterSlug: "google/gemini-3.5-flash-lite",
    nativeSlug: "gemini-flash-lite-latest",
    provider: "gemini",
    label: "gemini-flash-lite-latest (3.5) — low-cost Gemini",
    tier: "$",
    aliases: [
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
      "gemini-2.5-flash-lite",
      "google/gemini-3.5-flash-lite",
      "google/gemini-flash-lite-latest"
    ],
    lineage: "google-flash-lite",
    predecessors: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite"]
  },
  {
    displaySlug: "gemini-flash-latest",
    openRouterSlug: "~google/gemini-flash-latest",
    nativeSlug: "gemini-flash-latest",
    provider: "gemini",
    label: "gemini-flash-latest (3.8) — current flagship Flash",
    tier: "$$",
    recommendedGreen: true,
    aliases: [
      "gemini-3.8-flash",
      "google/gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-2.5-flash",
      "gemini-flash",
      "google/gemini-flash-latest",
      "google/gemini-3.7-flash",
      "google/gemini-3.6-flash"
    ],
    lineage: "google-flash",
    predecessors: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-2.5-flash"]
  },
  {
    displaySlug: "gemini-pro-latest",
    openRouterSlug: "~google/gemini-pro-latest",
    nativeSlug: "gemini-pro-latest",
    provider: "gemini",
    label: "gemini-pro-latest (3.1) — deepest Gemini reasoning",
    tier: "$$$",
    recommendedRed: true,
    aliases: [
      "gemini-3.1-pro-preview",
      "gemini-2.5-pro",
      "gemini-pro",
      "google/gemini-pro-latest",
      "google/gemini-3.1-pro-preview"
    ],
    lineage: "google-pro",
    predecessors: ["gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-pro"]
  },
  {
    displaySlug: "mistral-small-latest",
    openRouterSlug: "mistralai/mistral-small-2603",
    nativeSlug: "mistral-small-latest",
    provider: "mistral",
    label: "mistral-small-latest — low-cost Mistral Small",
    tier: "$",
    aliases: [
      "mistral-small-2603",
      "mistral-small-2506",
      "mistralai/mistral-small-2603",
      "mistralai/mistral-small-latest"
    ],
    lineage: "mistral-small",
    predecessors: ["mistral-small-2603", "mistral-small-2506"]
  },
  {
    displaySlug: "mistral-medium-latest",
    openRouterSlug: "mistralai/mistral-medium-3-5",
    nativeSlug: "mistral-medium-latest",
    provider: "mistral",
    // "Frontier" was Mistral's marketing language, not a price/capability rank: this is the
    // COSTLIEST Mistral row (1.50/7.50 vs Large's 0.50/1.50) — see the tier fix below and
    // docs/rollouts/2026-09-18-model-catalog-cleanup.md.
    label: "mistral-medium-latest — priciest Mistral tier",
    tier: "$$$",
    aliases: [
      "mistral-medium-3.5",
      "mistral-medium-3-5",
      "mistralai/mistral-medium-3.5",
      "mistralai/mistral-medium-3-5",
      "mistralai/mistral-medium-latest"
    ],
    lineage: "mistral-medium",
    predecessors: ["mistral-medium-3.5", "mistral-medium-3-5"]
  },
  {
    displaySlug: "mistral-large-latest",
    // VERIFIED 2026-09-18 against the live OpenRouter catalog (446 models): only
    // "mistralai/mistral-large-2512:batch" is listed for the current Mistral Large 3
    // generation — no non-batch route exists. The two non-batch ids OpenRouter DOES list,
    // "mistralai/mistral-large-2407" and "mistralai/mistral-large", are the OLDER
    // Nov-2024/Feb-2024 generation at $2/$6 — pointing here at either would be a downgrade
    // (stale model, worse price), not a fix, and would break the "always newest version"
    // rule. Left pointing at the (currently unservable in non-batch form) 2512 id rather
    // than a stale one: a live pick of this row with an OpenRouter credential configured
    // will 404 and fall into the model-rotation cooldown (src/lib/model-rotation.ts); the
    // reliable path today is the native Mistral API fallback, used automatically when no
    // OpenRouter credential is configured. See docs/rollouts/2026-09-18-model-catalog-cleanup.md.
    openRouterSlug: "mistralai/mistral-large-2512",
    nativeSlug: "mistral-large-latest",
    provider: "mistral",
    label: "mistral-large-latest — Mistral Large",
    // Cheapest of the three Mistral rows (0.50/1.50) — below Medium, which is now the
    // priciest. See docs/rollouts/2026-09-18-model-catalog-cleanup.md.
    tier: "$$",
    aliases: ["mistral-large", "mistral-large-2512", "mistralai/mistral-large", "mistralai/mistral-large-latest"],
    lineage: "mistral-large",
    predecessors: ["mistral-large-2512", "mistral-large-2407"]
  },
  {
    displaySlug: "kimi-latest",
    openRouterSlug: "~moonshotai/kimi-latest",
    nativeSlug: "kimi-latest",
    provider: "moonshot",
    label: "kimi-latest (k3) — Kimi frontier model",
    tier: "$$",
    aliases: ["kimi-k3", "kimi", "moonshot", "moonshot-latest", "moonshotai/kimi-latest", "~moonshotai/kimi-latest"],
    lineage: "moonshot-kimi",
    predecessors: ["kimi-k3", "moonshot-latest"]
  },
  {
    displaySlug: "deepseek-flash-latest",
    openRouterSlug: "deepseek/deepseek-v4-flash-0731",
    nativeSlug: "deepseek-v4-flash",
    provider: "deepseek",
    label: "deepseek-flash-latest (v4) — fast DeepSeek Flash",
    tier: "$",
    aliases: ["deepseek-v4-flash-0731", "deepseek/deepseek-v4-flash-0731", "deepseek-v4-flash", "deepseek-chat", "deepseek/deepseek-v4-flash", "deepseek/deepseek-flash-latest"],
    lineage: "deepseek-flash",
    predecessors: ["deepseek-v4-flash-0731", "deepseek-chat"]
  },
  {
    displaySlug: "deepseek-pro-latest",
    openRouterSlug: "deepseek/deepseek-v4-pro-0813",
    nativeSlug: "deepseek-v4-pro",
    provider: "deepseek",
    label: "deepseek-pro-latest (v4) — stronger DeepSeek Pro",
    tier: "$$",
    aliases: ["deepseek-v4-pro-0813", "deepseek/deepseek-v4-pro-0813", "deepseek-v4-pro", "deepseek/deepseek-v4-pro", "deepseek/deepseek-pro-latest"],
    lineage: "deepseek-pro",
    predecessors: ["deepseek-v4-pro-0813", "deepseek-r1"]
  },
  {
    displaySlug: "minimax-m3",
    openRouterSlug: "minimax/minimax-m3",
    nativeSlug: "MiniMax-M3",
    provider: "minimax",
    label: "minimax-m3 — general-purpose reasoning",
    tier: "$",
    aliases: ["minimax/minimax-m3"],
    lineage: "minimax",
    predecessors: ["minimax-m2.7"]
  },
  {
    displaySlug: "muse-spark-1.3",
    openRouterSlug: "meta/muse-spark-1.3",
    nativeSlug: "muse-spark-1.3",
    provider: "meta",
    label: "muse-spark-1.3 — multimodal reasoning and agents",
    tier: "$$",
    aliases: ["meta/muse-spark-1.3"],
    lineage: "meta-muse",
    predecessors: ["llama-4-scout", "llama-3.3-70b-instruct"]
  },
  {
    displaySlug: "muse-glimmer-30b",
    openRouterSlug: "meta/muse-glimmer-30b",
    nativeSlug: "muse-glimmer-30b",
    provider: "meta",
    label: "muse-glimmer-30b — efficient agent model",
    tier: "$",
    aliases: ["meta/muse-glimmer-30b"],
    lineage: "meta-muse",
    predecessors: ["llama-4-maverick"]
  }
];

export const CATALOG_DISPLAY_SLUGS: readonly string[] = LLM_MODEL_CATALOG.map((row) => row.displaySlug);

const LOOKUP = new Map<string, LlmCatalogEntry>();

function indexKey(raw: string): string {
  return raw.trim().replace(/^~/, "").replace(/^openrouter\//i, "").replace(/:batch$/i, "").toLowerCase();
}

for (const entry of LLM_MODEL_CATALOG) {
  LOOKUP.set(indexKey(entry.displaySlug), entry);
  LOOKUP.set(indexKey(entry.openRouterSlug), entry);
  LOOKUP.set(indexKey(entry.nativeSlug), entry);
  for (const alias of entry.aliases) {
    LOOKUP.set(indexKey(alias), entry);
  }
}

export function catalogEntryFor(model: string | null | undefined): LlmCatalogEntry | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  const direct = LOOKUP.get(indexKey(trimmed));
  if (direct) return direct;
  const leaf = trimmed.includes("/") ? trimmed.split("/").pop() || trimmed : trimmed;
  return LOOKUP.get(indexKey(leaf));
}

/** Persist / UI / stats identity.  Empty string for null/blank. */
export function displaySlugFor(model: string | null | undefined): string {
  if (!model) return "";
  const trimmed = model.trim();
  if (!trimmed) return "";
  return catalogEntryFor(trimmed)?.displaySlug ?? "";
}

/** OpenRouter chat/completions `model`.  Unknown ids keep a vendor-prefixed fallback. */
export function openRouterSlugFor(model: string | null | undefined): string {
  const trimmed = (model ?? "").trim();
  if (!trimmed) return "";
  const batch = /:batch$/i.test(trimmed);
  const entry = catalogEntryFor(trimmed);
  if (entry) {
    // The Flash-latest alias has no :batch sibling. Pin offline/eval to 3.8 batch.
    if (batch && entry.displaySlug === "gemini-flash-latest") {
      return "google/gemini-3.8-flash:batch";
    }
    return batch && !entry.openRouterSlug.endsWith(":batch") ? `${entry.openRouterSlug}:batch` : entry.openRouterSlug;
  }
  return "";
}

/**
 * Direct-provider slug.  Never returns an OpenRouter vendor path
 * (`anthropic/…`, `openai/…`) so a future native client cannot send column 2 by accident.
 */
export function nativeSlugFor(model: string | null | undefined): string {
  const trimmed = (model ?? "").trim();
  if (!trimmed) return "";
  const entry = catalogEntryFor(trimmed);
  if (entry) return entry.nativeSlug;
  const bare = trimmed.replace(/^~/, "").replace(/^openrouter\//i, "").replace(/:batch$/i, "");
  return bare.includes("/") ? bare.split("/").pop() || bare : bare;
}

// grok-build-0.1 (the previous sole exclusion — a coding-specialist checkpoint unsuited to
// either team role) was removed from the catalog entirely on 2026-09-18, not just excluded
// from rotation; see docs/rollouts/2026-09-18-model-catalog-cleanup.md. Empty for now — kept
// as a mechanism for a future model that should stay curated/selectable but not rotate.
export const ROTATION_EXCLUDED_DISPLAY_SLUGS: readonly string[] = [];

export const CATALOG_ROTATION_POOL: readonly string[] = CATALOG_DISPLAY_SLUGS.filter(
  (id) => !ROTATION_EXCLUDED_DISPLAY_SLUGS.includes(id)
);

/**
 * Return all configured predecessor model slugs for a model (or empty array if none).
 * Enables rolling forward historical cost, latency, token, and performance stats into
 * newly adopted or bumped model versions before they establish their own sample size.
 */
export function getPredecessorModelIds(model: string | null | undefined): string[] {
  if (!model) return [];
  const entry = catalogEntryFor(model);
  return entry?.predecessors ? [...entry.predecessors] : [];
}
