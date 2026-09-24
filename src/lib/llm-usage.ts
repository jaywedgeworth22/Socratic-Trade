// Per-user LLM usage ledger.
//
// Pairs with the operator-funded LLM failover (see `resolveLlmCredential` in db-api-keys.ts):
// when a tenant has no LLM key of their own and falls back to the operator's env key, we record
// who spent and on whose key so the operator can see/attribute cost. Every LLM call records a row
// (the user's own key too) tagged with `keySource` ('user' | 'operator'); token counts are
// best-effort from the provider response (null when the response omits usage).

import crypto from "crypto";
import { audit, getDb } from "./db";
import { apiKeyEnvVarForService, DELETED_KEY_TOMBSTONE, getUserApiKey, keyFingerprint, LOCAL_USER, maskApiKeyPreview, type LlmKeySource } from "./db-api-keys";
import { canonicalModelId } from "./model-identity";
import { setGenAiUsageOnActiveSpan } from "./sentry-gen-ai";
import { pushLlmUsage } from "./usage-monitor-push";
export { keyFingerprint };

export interface LlmUsageEntry {
  userId: string;
  provider: "openai" | "anthropic" | string;
  model?: string;
  /** Where in the app the call originated, e.g. "chat", "strategy", "red-team". */
  context?: string;
  /** 'operator' means the operator-funded env key served this (non-owning) user. */
  keySource: Exclude<LlmKeySource, "none">;
  /** Non-secret stable fingerprint of the API key that served this call (see keyFingerprint), so
   *  usage/cost can be measured PER ATTACHED KEY — user-provided or operator. */
  keyRef?: string;
  /** The connected account this call was recorded for, so cost/tokens can be attributed and
   *  filtered per account (broker/environment derived by joining connected_accounts at read
   *  time). Undefined for account-less contexts (e.g. chat) — those stay "unattributed". */
  connectedAccountId?: string;
  promptTokens?: number;
  completionTokens?: number;
  /** Prompt tokens served from the provider's prompt cache (bill at ~0.1× input). */
  cachedPromptTokens?: number;
  /** Anthropic-only: tokens WRITTEN to the cache this call (bill at ~1.25× input). */
  cacheCreationTokens?: number;
  /** OpenRouter's per-generation id (response `id`), so the monitor can call GET
   *  /api/v1/generation?id=... to verify reported cost against the provider's own ledger. Only
   *  meaningful when `provider === "openrouter"` — see `providerRequestIdFromPayload`. */
  providerRequestId?: string;
  /** The amount the transport actually BILLED for this call, in USD, as reported by the response
   *  itself (`usage.cost`).  Only OpenRouter reports one, so `recordLlmUsage` only trusts it when
   *  `provider === "openrouter"`; every other provider leaves the ledger on the estimate.  When
   *  present it REPLACES the price-table estimate and the row is stamped `cost_source = 'billed'`. */
  billedCostUsd?: number;
  /** Wall-clock latency for this call in milliseconds. Optional so legacy callers that don't yet
   *  measure latency can still record rows; the LLM stats console reads it for p50/p95/p99.
   *  Pre-call throw sites (4xx/5xx up-front) and timeouts should still record a value so the
   *  "error" rows have meaningful latency.  Negative or non-finite values are dropped at write. */
  latencyMs?: number;
  /** Outcome of the call. Defaults to "success" when the call returned a usable response with
   *  usage data; "error" when it threw or returned an unusable body; "timeout" when the
   *  transport's abort signal fired; "canceled" when an upstream caller (e.g. a chat cancel)
   *  intentionally aborted.  Optional so legacy callers can omit it — rows without a status
   *  are treated as "success" by the stats aggregator (legacy behavior). */
  status?: "success" | "error" | "timeout" | "canceled";
  /** Test-only: override the recorded `created_at` so unit tests can drive the 90-day
   *  rolling-window aggregator.  Sanitized at write (must be a valid ISO-8601 string).
   *  Not exported in the type — callers in src/ never pass it; tests use `as never` to bypass. */
  createdAtOverride?: string;
}

export interface LlmTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Prompt tokens served from the provider's prompt cache. OpenAI/Gemini-compat:
   *  usage.prompt_tokens_details.cached_tokens; DeepSeek: usage.prompt_cache_hit_tokens;
   *  Anthropic: usage.cache_read_input_tokens. Subset of promptTokens. */
  cachedPromptTokens?: number;
  /** Anthropic-only: usage.cache_creation_input_tokens (cache-write premium tokens).
   *  Subset of promptTokens (which is normalized to the FULL prompt across providers). */
  cacheCreationTokens?: number;
  /**
   * `usage.cost` — the exact amount the transport charged for this call, in USD.  OpenRouter is
   * the only provider in this app that reports one (credits are 1:1 with USD), and it reports it
   * on EVERY response: usage accounting is always on there now, and the `usage: {include: true}`
   * request field that used to switch it on is documented as deprecated and inert, so no
   * request-side change is needed to receive it.  Undefined when the response omits it.
   *
   * `recordLlmUsage` gates this on `provider === "openrouter"` before trusting it as money, so a
   * hypothetical non-OpenRouter provider echoing an unrelated `cost` field can never silently
   * redefine the ledger.
   */
  billedCostUsd?: number;
}

/** Cost provenance for one ledger row.  `billed` = the transport's own `usage.cost`; `estimated`
 *  = derived from the hand-maintained `MODEL_PRICE_PER_M` table.  The two must never be added
 *  together and presented as one authoritative number — the Usage page shows the split. */
export type LlmCostSource = "billed" | "estimated";

// USD per 1M tokens, [input, output]. Best-effort; unknown models fall back to a
// conservative env-configurable default (LLM_UNPRICED_MODEL_COST_PER_M) so unpriced
// models count against budgets rather than flying under as $0.
//
// VERIFIED 2026-09-18 against the live public OpenRouter model list (446 models) as part of
// the model-catalog cleanup — see docs/rollouts/2026-09-18-model-catalog-cleanup.md for the
// full before/after and the source figures. Every price below for a row still in
// LLM_MODEL_CATALOG (src/lib/llm-model-catalog.ts) was checked against that list; entries
// that were wrong are noted with what they were.
const MODEL_PRICE_PER_M: Record<string, [number, number]> = {
  // Legacy/orphan ids — never part of the curated catalog; left as historical price
  // snapshots, not touched by the 2026-09-18 catalog cleanup.
  "gpt-4.1": [2, 8],
  "gpt-4.1-mini": [0.4, 1.6],
  "o4-mini": [1.1, 4.4],
  "o1-preview": [15, 60],
  "o1-mini": [3, 12],
  "o3-mini": [1.1, 4.4],
  "o1": [15, 60],
  "gpt-5.5": [5, 30],
  "gpt-5.4": [2.5, 15],
  "gpt-5.6": [5, 30],
  "gemini-3.1-flash-lite": [0.25, 1.5],
  "gemini-3.1-pro-preview": [2, 12],
  "gemini-3.5-flash": [1.5, 9],
  "gemini-3.6-flash": [0.75, 3.75],
  "gemini-3.7-flash": [0.375, 1.875],
  "gemini-2.5-flash-lite": [0.1, 0.4],
  "gemini-2.5-flash": [0.3, 2.5],
  "gemini-2.5-pro": [1.25, 10],
  "mistral-small-2506": [0.1, 0.3],
  "mistral-large": [2, 6],
  "mistral-medium": [0.4, 2],
  "mistral-small": [0.1, 0.3],
  "deepseek-v4-flash": [0.14, 0.28],
  "deepseek-v4-pro": [0.435, 0.87],
  "deepseek-chat": [0.14, 0.28],
  "grok-4.3": [1.25, 2.5],
  "grok-4.5": [1.25, 2.5],
  "claude-fable-5": [10, 50],
  "claude-opus-4-8": [5, 25],

  // --- Curated catalog rows (LLM_MODEL_CATALOG, 21 rows as of 2026-09-18) ---
  "gpt-6-astra-pro": [10, 50],
  "gpt-6-astra": [10, 50],
  "gpt-5.6-sol": [2, 10], // was [5, 30] — real price is $2/$10 (verified 2026-09-18)
  "gpt-5.6-luna": [0.2, 1.2], // was [1, 6] — real price is $0.20/$1.20 (verified 2026-09-18)
  "grok-4.6": [2, 6],
  "grok-latest": [2, 6],
  "claude-fable-latest": [10, 50],
  "claude-opus-latest": [4.5, 22.5],
  "claude-opus-5-5": [4.5, 22.5],
  "claude-opus-5.5": [4.5, 22.5],
  "claude-opus-5": [5, 25],
  "claude-sonnet-5": [2, 10], // was [3, 15] — real price is $2/$10 (verified 2026-09-18)
  "claude-sonnet-4-6": [2, 10], // was [3, 15] — kept in sync with claude-sonnet-5 above
  "claude-sonnet-latest": [2, 10], // was [3, 15] — real price is $2/$10 (verified 2026-09-18)
  "claude-haiku-4-5": [1, 5],
  "claude-haiku-4.5": [1, 5],
  "claude-haiku-latest": [1, 5],
  "gemini-flash-lite-latest": [0.3, 2.5], // was [0.25, 1.5] — now serves 3.5, not 3.1 (verified 2026-09-18)
  "gemini-3.8-flash": [0.75, 3.75],
  "gemini-flash-latest": [0.75, 3.75],
  "gemini-pro-latest": [2, 12],
  "mistral-large-2512": [0.5, 1.5],
  "mistral-large-latest": [0.5, 1.5],
  "mistral-medium-3-5": [1.5, 7.5],
  "mistral-medium-latest": [1.5, 7.5],
  "mistral-small-latest": [0.15, 0.6],
  "deepseek-v4-flash-0731": [0.06, 0.12], // was [0.065, 0.18] — real price is $0.06/$0.12 (verified 2026-09-18)
  "deepseek-flash-latest": [0.06, 0.12], // was [0.065, 0.18] — kept in sync with deepseek-v4-flash-0731 above
  "deepseek-v4-pro-0813": [0.57816, 1.73448], // was [0.57948, 1.73844] — exact JSON figures (verified 2026-09-18)
  "deepseek-pro-latest": [0.57816, 1.73448], // was [0.57948, 1.73844] — kept in sync with deepseek-v4-pro-0813 above
  "minimax-m3": [0.3, 1.2],
  "muse-spark-1.3": [1.25, 4.25],
  "muse-glimmer-30b": [0.35, 1.5], // was [0.3, 1.1] — real (live OpenRouter) price is $0.35/$1.50 (verified 2026-09-18)
  "kimi-latest": [1.95, 10.92], // was [0.3, 1.2] — the old figure was Kimi's cache-HIT input price, not the
  "kimi-k3": [1.95, 10.92], //     real cache-miss rate; real price is $1.95/$10.92 (verified 2026-09-18)

  // --- Retired from the curated catalog 2026-09-18 (model-catalog cleanup) ---
  // Kept ONLY so any historical usage row still recorded under one of these ids still
  // resolves to a cost estimate — do not remove until confirmed no historical usage rows
  // reference them, and do not offer these for new selection (they are no longer in
  // LLM_MODEL_CATALOG). See docs/rollouts/2026-09-18-model-catalog-cleanup.md.
  "gpt-4o": [2.5, 10],
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-5.4-mini": [0.75, 4.5],
  "gpt-mini-latest": [0.75, 4.5],
  "gpt-5.4-nano": [0.2, 1.25],
  "gpt-5.6-terra": [2.5, 15],
  "grok-build-0.1": [1, 2],
  "grok-build-latest": [1, 2],
  "minimax-m2.7": [0.3, 1.2],
  "deepseek-reasoner": [0.55, 2.19],
  "deepseek-r1": [0.55, 2.19],
  "llama-4-maverick": [0.2, 0.696],
  "llama-4-scout": [0.1, 0.3],
  "llama-70b-latest": [0.72, 0.72],
  "llama-3.3-70b-instruct": [0.72, 0.72]
};

/** Conservative default: $15/1M tokens total ($7.50 input, $7.50 output). Env-configurable. */
function defaultModelPricePerM(): [number, number] {
  const v = Number(process.env.LLM_UNPRICED_MODEL_COST_PER_M);
  const perM = Number.isFinite(v) && v > 0 ? v : 15;
  return [perM / 2, perM / 2];
}

function priceForModel(model: string | undefined): [number, number] {
  if (!model) return defaultModelPricePerM();
  // Strip the full OpenRouter routing prefix so price-table bare IDs match outbound model names.
  // Handles three forms:
  //   "gpt-5.4-mini"                → unchanged
  //   "openai/gpt-5.4-mini"         → "gpt-5.4-mini"  (vendor/model)
  //   "openrouter/openai/gpt-5.4-mini" → "gpt-5.4-mini"  (full 3-part OR prefix)
  // Mirrors stripRoutingPrefix() in app/admin/llm-usage/model-merge.ts.
  let m = model.toLowerCase();
  m = m.replace(/^openrouter\//, ""); // strip leading "openrouter/" if present
  const slashIdx = m.indexOf("/");
  if (slashIdx !== -1) m = m.slice(slashIdx + 1); // strip one vendor segment (e.g. "openai/")
  if (MODEL_PRICE_PER_M[m]) return MODEL_PRICE_PER_M[m];
  const canonical = canonicalModelId(model);
  if (canonical && MODEL_PRICE_PER_M[canonical]) return MODEL_PRICE_PER_M[canonical];
  // Prefix match (e.g. dated suffixes like claude-haiku-4-5-20251001).
  // Longest-prefix wins so family aliases cannot shadow a more specific tier snapshot
  // (e.g. gpt-5.6 must not price gpt-5.6-terra-* as Sol).
  const hit = Object.keys(MODEL_PRICE_PER_M)
    .sort((left, right) => right.length - left.length)
    .find((k) => m.startsWith(k));
  return hit ? MODEL_PRICE_PER_M[hit] : defaultModelPricePerM();
}

// Cache-read tokens bill at ~0.1× the input rate across providers that report them
// (OpenAI gpt-5.5: $0.50 vs $5.00; Anthropic cache read: 0.1×; DeepSeek cache hit: ~0.1×).
// Anthropic cache WRITES bill at 1.25× input (5-minute ephemeral TTL).
const CACHE_READ_INPUT_MULTIPLIER = 0.1;
const CACHE_WRITE_INPUT_MULTIPLIER = 1.25;

/** Best-effort cost in USD. Unpriced models fall back to a conservative default
 *  (env LLM_UNPRICED_MODEL_COST_PER_M as a single USD-per-1M-tokens number, split 50/50
 *  between input/output; default 15 → $7.50/$7.50 per 1M). Cache-read tokens are priced
 *  at ~0.1× input and Anthropic cache-creation tokens at 1.25× input, so cached calls no
 *  longer overstate cost (previously ALL prompt tokens billed at the full input rate).
 *  Returns undefined only when token counts are both zero/unknown. */
export function estimateLlmCostUsd(
  model: string | undefined,
  promptTokens?: number,
  completionTokens?: number,
  cachedPromptTokens?: number,
  cacheCreationTokens?: number
): number | undefined {
  const price = priceForModel(model);
  const inTok = promptTokens ?? 0;
  const outTok = completionTokens ?? 0;
  if (inTok === 0 && outTok === 0) return undefined;
  // Clamp so malformed provider usage (cached > prompt) can never produce a negative cost.
  const cached = Math.min(Math.max(cachedPromptTokens ?? 0, 0), inTok);
  const creation = Math.min(Math.max(cacheCreationTokens ?? 0, 0), inTok - cached);
  const fullRate = inTok - cached - creation;
  const inputCost = (fullRate + cached * CACHE_READ_INPUT_MULTIPLIER + creation * CACHE_WRITE_INPUT_MULTIPLIER) * price[0];
  return (inputCost + outTok * price[1]) / 1_000_000;
}

/** Normalize OpenAI (chat-completions + responses), Anthropic, DeepSeek, and Gemini-compat
 *  usage shapes, including prompt-cache accounting. `promptTokens` is normalized to the FULL
 *  prompt on every provider: OpenAI/DeepSeek report it that way natively, while Anthropic's
 *  `input_tokens` EXCLUDES cache read/creation tokens — those are added back here. */
export function extractLlmUsage(responseJson: unknown): LlmTokenUsage {
  const u = (responseJson as { usage?: Record<string, unknown> } | undefined)?.usage;
  if (!u || typeof u !== "object") return {};
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  // Cache reads: OpenAI/Gemini-compat nest under prompt_tokens_details; DeepSeek and Anthropic are top-level.
  const cachedPromptTokens = num(details.cached_tokens) ?? num(u.prompt_cache_hit_tokens) ?? num(u.cache_read_input_tokens);
  const cacheCreationTokens = num(u.cache_creation_input_tokens);
  const anthropicIn = num(u.input_tokens);
  const promptTokens =
    num(u.prompt_tokens) ??
    // Anthropic: input_tokens excludes cache read/creation — normalize to the full prompt.
    (anthropicIn !== undefined ? anthropicIn + (num(u.cache_read_input_tokens) ?? 0) + (cacheCreationTokens ?? 0) : undefined);
  const completionTokens = num(u.completion_tokens) ?? num(u.output_tokens);
  const totalTokens = num(u.total_tokens) ?? (promptTokens !== undefined || completionTokens !== undefined ? (promptTokens ?? 0) + (completionTokens ?? 0) : undefined);
  // OpenRouter's own billed amount for this generation.  Negative values are nonsense (a refund is
  // not a call cost) so they are dropped rather than allowed to reduce a running total.
  const rawCost = num(u.cost);
  const billedCostUsd = rawCost !== undefined && rawCost >= 0 ? rawCost : undefined;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(billedCostUsd !== undefined ? { billedCostUsd } : {})
  };
}

/**
 * Extracts a provider-generation id from a raw LLM response body, but ONLY when the transport that
 * actually served the call was OpenRouter — every provider's response envelope carries a top-level
 * `id` (OpenAI `chatcmpl-...`, Anthropic `msg_...`, OpenRouter `gen-...`), and only OpenRouter's is
 * useful downstream (the monitor calls `GET /api/v1/generation?id=...` to verify reported cost).
 * Returns `undefined` (never `""`) for any other provider or a malformed/absent id — callers push
 * this straight through as `providerRequestId`.
 */
export function providerRequestIdFromPayload(provider: string, payload: unknown): string | undefined {
  if (provider !== "openrouter") return undefined;
  const id = (payload as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Maps a served (provider, model) pair onto the catalog family identity used for usage,
 * Results, and price-benchmark history. OpenRouter vendor prefixes become the native family
 * (`google` → `gemini`); the model is always `canonicalModelId` so `google/gemini-3.7-flash`
 * and `gemini-flash-latest` land in the same bucket (same for every Opus, every Sonnet, …).
 */
export function remapOpenRouterTelemetry(provider: string, model: string): { provider: string; model: string };
export function remapOpenRouterTelemetry(provider: string, model: string | undefined): { provider: string; model: string | undefined };
export function remapOpenRouterTelemetry(provider: string, model: string | undefined): { provider: string; model: string | undefined } {
  const family = model ? canonicalModelId(model) || undefined : undefined;
  if (provider === "openrouter" && model) {
    const slashIdx = model.indexOf("/");
    if (slashIdx !== -1) {
      let p = model.slice(0, slashIdx).replace(/^~/, "");
      if (p === "google") p = "gemini";
      if (p === "mistralai") p = "mistral";
      if (p === "x-ai") p = "xai";
      if (p === "meta-llama") p = "meta";
      if (p === "moonshotai") p = "moonshot";
      return { provider: p, model: family ?? model.slice(slashIdx + 1) };
    }
    return { provider, model: family ?? model };
  }
  return { provider, model: family ?? model };
}

/** Record one LLM call against a user. Never throws — usage accounting must not break an LLM run. */
export function recordLlmUsage(entry: LlmUsageEntry): void {
  try {
    const canonical = remapOpenRouterTelemetry(entry.provider, entry.model);
    // Keep the transport route in the ledger and telemetry. OpenRouter is
    // the credential/key namespace that actually served the call; the
    // canonical vendor model is only for pricing and model statistics.
    const provider = entry.provider;
    const model = entry.model;
    const usageId = crypto.randomUUID();
    // Sanitize createdAtOverride: only accept a non-empty ISO string.  Anything else falls
    // back to "now" — never trust an arbitrary string to be persisted verbatim.
    const overrideRaw = (entry as { createdAtOverride?: unknown }).createdAtOverride;
    const overrideValid = typeof overrideRaw === "string" && /^\d{4}-\d{2}-\d{2}T/.test(overrideRaw);
    const occurredAt = overrideValid ? (overrideRaw as string) : new Date().toISOString();
    const total =
      entry.promptTokens !== undefined || entry.completionTokens !== undefined ? (entry.promptTokens ?? 0) + (entry.completionTokens ?? 0) : undefined;
    // Money precedence: the transport's OWN billed amount beats our price table.  Only OpenRouter
    // reports one, so the provider gate keeps a stray `usage.cost` on some other provider from
    // silently redefining spend.  A billed 0 is a real answer (a free/promotional model), so the
    // check is `>= 0`, not truthiness.
    const billedCostUsd =
      entry.provider === "openrouter" && typeof entry.billedCostUsd === "number" && Number.isFinite(entry.billedCostUsd) && entry.billedCostUsd >= 0
        ? entry.billedCostUsd
        : undefined;
    const estimatedCostUsd = estimateLlmCostUsd(entry.model ?? canonical.model, entry.promptTokens, entry.completionTokens, entry.cachedPromptTokens, entry.cacheCreationTokens);
    const cost = billedCostUsd ?? estimatedCostUsd;
    // Provenance travels with the row so the Usage page can label an estimate as an estimate
    // instead of mixing it into a "billed" total.  Null only when there is no cost at all.
    const costSource: LlmCostSource | null = billedCostUsd !== undefined ? "billed" : estimatedCostUsd !== undefined ? "estimated" : null;
    // Prompt-cache visibility (no schema change): when the provider served part of the prompt from
    // cache, write an audit row so cache hit rates + savings are observable per provider/model/context.
    if ((entry.cachedPromptTokens ?? 0) > 0 || (entry.cacheCreationTokens ?? 0) > 0) {
      audit(
        "llm_cache_usage",
        {
          provider,
          model,
          context: entry.context,
          promptTokens: entry.promptTokens,
          cachedPromptTokens: entry.cachedPromptTokens,
          cacheCreationTokens: entry.cacheCreationTokens,
          costUsd: cost,
          costSource
        },
        entry.userId,
        entry.connectedAccountId
      );
    }
    // Sanitize latency: drop negative or non-finite values so a buggy timer can't poison the
    // stats percentiles.  When omitted entirely the column stays NULL, which the stats
    // aggregator skips (it does NOT count NULL latency toward the latency distribution).
    const latencyMs =
      typeof entry.latencyMs === "number" && Number.isFinite(entry.latencyMs) && entry.latencyMs >= 0
        ? Math.round(entry.latencyMs)
        : null;
    // Status defaults to "success" for legacy callers; explicit callers may stamp error /
    // timeout / canceled.  The CHECK constraint is added by migration #91 — values not in the
    // allowed set are coerced to NULL to keep the row insert valid even if a future caller
    // hands us an unexpected enum value.
    const allowedStatus = new Set(["success", "error", "timeout", "canceled"]);
    const status = entry.status && allowedStatus.has(entry.status) ? entry.status : null;
    getDb()
      .prepare(
        `INSERT INTO llm_usage (id, user_id, provider, model, context, key_source, key_ref, connected_account_id, prompt_tokens, completion_tokens, total_tokens, cost_usd, cost_source, latency_ms, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        usageId,
        entry.userId,
        provider,
        model ?? null,
        entry.context ?? "unknown",
        entry.keySource,
        entry.keyRef ?? null,
        entry.connectedAccountId ?? null,
        entry.promptTokens ?? null,
        entry.completionTokens ?? null,
        total ?? null,
        cost ?? null,
        costSource,
        latencyMs,
        status,
        occurredAt
      );
    setGenAiUsageOnActiveSpan({
      provider,
      model,
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens
    });
    // Fire-and-forget forward to the API Usage Monitor (no-op unless configured; never throws).
    pushLlmUsage({
      sourceEventId: usageId,
      occurredAt,
      provider,
      model,
      context: entry.context,
      userId: entry.userId,
      keySource: entry.keySource,
      keyRef: entry.keyRef,
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      totalTokens: total,
      costUsd: cost,
      providerRequestId: entry.providerRequestId,
    });
  } catch {
    /* ledger is best-effort; never break the caller */
  }
}

export interface LlmUsageRow {
  userId: string;
  provider: string;
  /** LLM model name; null for rows recorded before model tracking. */
  model: string | null;
  /** Where in the app this call originated (chat, strategy, red-team, etc.). */
  context: string | null;
  keySource: LlmKeySource;
  /** Per-attached-key fingerprint (see keyFingerprint); null for legacy rows without one. */
  keyRef: string | null;
  /** Connected account this usage is attributed to; null for unattributed / account-less rows. */
  connectedAccountId: string | null;
  /** Broker of the attributed account (via join to connected_accounts); null when unattributed
   *  or the account has since been deleted. */
  broker: string | null;
  /** 'paper' | 'live' of the attributed account; null when unattributed. */
  environment: string | null;
  /** Human label of the attributed account; null when unattributed. */
  accountLabel: string | null;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Calls whose total_tokens column was non-NULL (token telemetry present). */
  callsWithTokens: number;
  /** Total spend for the group.  This is the SUM of `billedCostUsd` and `estimatedCostUsd`, so it
   *  is only fully authoritative when `estimatedCalls === 0` — surfaces that show it must say so
   *  rather than presenting a mixed figure as billed truth. */
  costUsd: number;
  /** Portion of `costUsd` that came from the transport's own `usage.cost` (OpenRouter). */
  billedCostUsd: number;
  /** Portion of `costUsd` derived from the hand-maintained price table.  Legacy rows written
   *  before cost provenance existed count here — they were estimates. */
  estimatedCostUsd: number;
  /** Calls whose cost is the transport's billed amount. */
  billedCalls: number;
  /** Calls whose cost is a price-table estimate (including pre-provenance legacy rows). */
  estimatedCalls: number;
}

/**
 * Aggregate usage grouped by (userId, provider, keySource, keyRef) — so usage/cost is measured per
 * ATTACHED KEY, not just per source. `sinceIso` bounds the window. `operatorFundedOnly` returns only
 * rows where a NON-`local` tenant spent on the operator key — the figure the operator most cares
 * about while the failover is enabled.
 */
export function getLlmUsageSummary(opts: {
  sinceIso?: string;
  operatorFundedOnly?: boolean;
  userId?: string;
  /** Filter to a single connected account. */
  connectedAccountId?: string;
  /** Filter to a broker (e.g. "alpaca", "robinhood") — matched via join to connected_accounts. */
  broker?: string;
} = {}): LlmUsageRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.sinceIso) {
    where.push("lu.created_at >= ?");
    params.push(opts.sinceIso);
  }
  if (opts.userId) {
    where.push("lu.user_id = ?");
    params.push(opts.userId);
  }
  if (opts.connectedAccountId) {
    where.push("lu.connected_account_id = ?");
    params.push(opts.connectedAccountId);
  }
  if (opts.broker) {
    where.push("ca.broker = ?");
    params.push(opts.broker);
  }
  if (opts.operatorFundedOnly) {
    where.push("lu.key_source = 'operator'");
    where.push("lu.user_id != 'local'");
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // LEFT JOIN so unattributed rows (null connected_account_id) and rows whose account was since
  // deleted still appear (broker/environment/label come back null → "unattributed" in the UI).
  const rows = getDb()
    .prepare(
      `SELECT lu.user_id, lu.provider, lu.model, lu.context, lu.key_source, lu.key_ref,
              lu.connected_account_id,
              ca.broker AS broker, ca.environment AS environment, ca.label AS account_label,
              COUNT(*) AS calls,
              COALESCE(SUM(lu.prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(lu.completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(lu.total_tokens),0) AS total_tokens,
              COALESCE(SUM(CASE WHEN lu.total_tokens IS NOT NULL THEN 1 ELSE 0 END),0) AS calls_with_tokens,
              COALESCE(SUM(lu.cost_usd),0) AS cost_usd,
              -- Cost provenance split.  Rows written before the cost_source column existed have
              -- NULL there and were estimates, so "not billed" is the honest bucket for them.
              COALESCE(SUM(CASE WHEN lu.cost_source = 'billed' THEN lu.cost_usd ELSE 0 END),0) AS billed_cost_usd,
              COALESCE(SUM(CASE WHEN lu.cost_source = 'billed' THEN 0 ELSE COALESCE(lu.cost_usd,0) END),0) AS estimated_cost_usd,
              COALESCE(SUM(CASE WHEN lu.cost_source = 'billed' THEN 1 ELSE 0 END),0) AS billed_calls,
              COALESCE(SUM(CASE WHEN lu.cost_source = 'billed' THEN 0 ELSE 1 END),0) AS estimated_calls
       FROM llm_usage lu
       LEFT JOIN connected_accounts ca ON ca.id = lu.connected_account_id
       ${clause}
       GROUP BY lu.user_id, lu.provider, lu.model, lu.context, lu.key_source, lu.key_ref,
                lu.connected_account_id, ca.broker, ca.environment, ca.label
       ORDER BY cost_usd DESC, calls DESC`
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    userId: String(r.user_id),
    provider: String(r.provider),
    model: r.model == null ? null : String(r.model),
    context: r.context == null ? null : String(r.context),
    keySource: r.key_source as LlmKeySource,
    keyRef: r.key_ref == null ? null : String(r.key_ref),
    connectedAccountId: r.connected_account_id == null ? null : String(r.connected_account_id),
    broker: r.broker == null ? null : String(r.broker),
    environment: r.environment == null ? null : String(r.environment),
    accountLabel: r.account_label == null ? null : String(r.account_label),
    calls: Number(r.calls),
    promptTokens: Number(r.prompt_tokens),
    completionTokens: Number(r.completion_tokens),
    totalTokens: Number(r.total_tokens),
    callsWithTokens: Number(r.calls_with_tokens ?? 0),
    costUsd: Number(r.cost_usd),
    billedCostUsd: Number(r.billed_cost_usd ?? 0),
    estimatedCostUsd: Number(r.estimated_cost_usd ?? 0),
    billedCalls: Number(r.billed_calls ?? 0),
    estimatedCalls: Number(r.estimated_calls ?? 0)
  }));
}

export interface KeyDescriptor {
  /** Irreversible, non-secret short fingerprint (first 8 hex chars of SHA-256(key)) — safe to ship
   *  to the client. NEVER a prefix/suffix of the raw key: Connections promises a key is never
   *  displayed again once stored, and this must hold for the usage/admin surfaces too. */
  fingerprint: string;
  /** Human label, e.g. "operator (openai)", "u_abc (anthropic)", "operator env (openai)". */
  label: string;
}

/**
 * A short, irreversible display fingerprint for a raw API key: the first 8 hex chars of
 * SHA-256(key). Distinct from `keyFingerprint` in db-api-keys.ts (16 hex chars, used as the
 * usage-ledger's `key_ref` grouping key) — this one exists purely so a human can recognize "is
 * this the same key" in the UI without ever reconstructing or partially exposing the secret.
 */
export function displayKeyFingerprint(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex").slice(0, 8);
}

/** Produce a display-safe masked representation of a raw API key. Delegates to the canonical
 *  `maskApiKeyPreview` (db-api-keys.ts) — the same mask the Connections page shows — and degrades to
 *  a head-only form for a key too short to elide, since this descriptor always needs a string.
 *  Usage/admin descriptors use `displayKeyFingerprint` instead; this remains for Connections-style
 *  previews and tests that share the same mask helper. */
export function maskApiKey(rawKey: string): string {
  return maskApiKeyPreview(rawKey) ?? `${rawKey.slice(0, 4)}...`;
}

/**
 * Resolve a non-secret, human-readable descriptor (fingerprint + label) for a usage row's opaque
 * `keyRef`, by matching the fingerprint against the LIVE key stores. Returns undefined once the key
 * is detached — the ledger keeps the fingerprint, but a friendly label is only available while the
 * key is still attached. Never returns any prefix/suffix of the raw key.
 */
export function describeUsageKey(row: { keyRef: string | null; userId: string; provider: string }): KeyDescriptor | undefined {
  if (!row.keyRef) return undefined;
  // The user's own stored key (for `local` this is the migrated operator key).
  const own = getUserApiKey(row.userId, row.provider)?.apiKey;
  if (own && keyFingerprint(own) === row.keyRef) {
    const label = row.userId === LOCAL_USER ? `primary user (${row.provider})` : `${row.userId} (${row.provider})`;
    return { fingerprint: displayKeyFingerprint(own), label };
  }
  // The operator's server failover key (stored for LOCAL_USER or in process.env).
  const localOpKey = getUserApiKey(LOCAL_USER, row.provider)?.apiKey;
  if (localOpKey && localOpKey !== DELETED_KEY_TOMBSTONE && keyFingerprint(localOpKey) === row.keyRef) {
    return { fingerprint: displayKeyFingerprint(localOpKey), label: `server failover (${row.provider})` };
  }
  const envVar = apiKeyEnvVarForService(row.provider);
  const envKey = envVar ? process.env[envVar]?.trim() : undefined;
  if (envKey && keyFingerprint(envKey) === row.keyRef) {
    return { fingerprint: displayKeyFingerprint(envKey), label: `server failover (${row.provider})` };
  }
  return undefined;
}
