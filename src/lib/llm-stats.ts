// LLM stats aggregator + alias resolver.
//
// Owner rule 2026-09-23 (Jay, scope clarification): every LLM call is kept FOREVER.  The
// console page must show TWO side-by-side windows — all-time and the rolling last 90 days —
// because the long-window numbers are stable for trade-outcome correlation while the short
// window catches a recent pricing-tier drop or a model swap.
//
// Owner rule 2026-09-23 (alias collapsing): single-generation model versions are statistically
// thin on their own.  ALL opus versions (claude-opus-4-8, claude-opus-5, claude-opus-5.5 when
// it lands, anthropic/claude-opus-latest, …) collapse into one `opus` bucket.  Same for
// sonnet, haiku, gemini-flash, grok-latest, deepseek-pro, mistral-large, gpt-5.x, etc.  The
// pre-canonical `canonicalModelId` already does most of this — this module just exposes the
// `aliasFamily` map for the console so the legend can name the bucket and the stats rows can
// group by it.

import { canonicalModelId } from "./model-identity";
import { getDb } from "./db";

/** Public alias families the LLM stats console aggregates by.  One entry per "line" of model
 *  (e.g. all opus generations, all gemini flash generations, etc.).  An LLM call whose model id
 *  matches one of these patterns rolls up into that family; everything else gets its own row. */
export const ALIAS_FAMILIES = [
  // Anthropic — every opus / sonnet / haiku / fable generation lands here.
  "opus",
  "sonnet",
  "haiku",
  "fable",
  // OpenAI — gpt-5.x, gpt-4o, mini, nano
  "gpt-5",
  "gpt-4o",
  "gpt-mini",
  "gpt-nano",
  // Google Gemini — flash, flash-lite, pro
  "gemini-flash",
  "gemini-flash-lite",
  "gemini-pro",
  // xAI Grok — every generation
  "grok",
  // DeepSeek — r1, pro, flash
  "deepseek-pro",
  "deepseek-flash",
  "deepseek-r1",
  // Mistral — large / medium / small
  "mistral-large",
  "mistral-medium",
  "mistral-small",
  // Meta / moonshot / kimi
  "llama",
  "kimi"
] as const;
export type AliasFamily = (typeof ALIAS_FAMILIES)[number];

/** Map every alias family to the set of substrings/regexes that identify it.  Match is
 *  case-insensitive.  The order matters — first match wins, so "opus" must come before
 *  "sonnet" (which would otherwise eat "claude-opus" via the "sonnet"-prefix risk; in practice
 *  the patterns here are distinct, but defensively keep opus first). */
const ALIAS_PATTERNS: ReadonlyArray<readonly [AliasFamily, RegExp]> = [
  ["opus", /opus/i],
  ["sonnet", /sonnet/i],
  ["haiku", /haiku/i],
  ["fable", /fable/i],
  // Order matters: gpt-mini + gpt-nano MUST come before gpt-5 because the bare "gpt-5" regex
  // would otherwise swallow gpt-5.4-nano (the dash is optional and 5.4 starts with 5).  Same
  // gpt-mini-before-gpt-4o trick.  sol/terra/luna are EXPLICIT patterns below so gpt-5.6-sol
  // rolls into the gpt-5 family while gpt-5.4-nano stays separate.
  ["gpt-mini", /\bgpt[-_ ]?(?:4o-mini|4\.1-mini|mini)\b/i],
  ["gpt-nano", /\bgpt[-_ 0-9.]*nano\b/i],
  ["gpt-4o", /\bgpt[-_ ]?4o\b/i],
  // The whole gpt-5 family: bare "gpt-5", gpt-5.5, gpt-5.6-sol, gpt-5.6-luna, gpt-5.6-terra,
  // and any future gpt-5 variant suffix (dated builds, new codenames, …).  nano/mini
  // variants are still routed by the earlier gpt-nano / gpt-mini patterns, which win on
  // order.
  ["gpt-5", /\bgpt-5(?:[.\d-][^\s]*)?$/i],
  ["gemini-flash-lite", /gemini[-_ ]?flash[-_ ]?lite/i],
  ["gemini-flash", /gemini[-_ ]?flash/i],
  ["gemini-pro", /gemini[-_ ]?pro/i],
  ["grok", /grok/i],
  ["deepseek-r1", /deepseek[-_ ]?r1|deepseek[-_ ]?reasoner/i],
  ["deepseek-pro", /deepseek[-_ ]?pro/i],
  ["deepseek-flash", /deepseek[-_ ]?(?:flash|chat|v4-flash)/i],
  ["mistral-large", /mistral[-_ ]?large/i],
  ["mistral-medium", /mistral[-_ ]?medium/i],
  ["mistral-small", /mistral[-_ ]?small/i],
  ["llama", /llama/i],
  ["kimi", /kimi|moonshot/i]
];

/** Resolve a model id (possibly route-qualified like `anthropic/claude-opus-5.5`) to one of the
 *  alias families.  Returns the canonical (catalog) id when no family matches, so the console
 *  still has a stable per-row label for the long tail.  Empty string for null/blank. */
export function aliasForModel(model: string | null | undefined): { family: AliasFamily | null; label: string } {
  const canonical = canonicalModelId(model);
  if (!canonical) return { family: null, label: "" };
  for (const [family, pattern] of ALIAS_PATTERNS) {
    if (pattern.test(canonical)) return { family, label: family };
  }
  return { family: null, label: canonical };
}

export interface AliasStatRow {
  /** Either an alias family ("opus", "sonnet", "gemini-flash") or a canonical id for the long
   *  tail of models that don't roll up. */
  alias: string;
  family: AliasFamily | null;
  /** Distinct model ids that contributed to this row (e.g. ["claude-opus-4-8", "claude-opus-5",
   *  "anthropic/claude-opus-latest"] for the opus row).  Empty for empty models. */
  sourceModels: string[];
  /** Distinct providers that contributed. */
  providers: string[];
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  billedCostUsd: number;
  estimatedCostUsd: number;
  errorCalls: number;
  timeoutCalls: number;
  canceledCalls: number;
  /** p50/p95/p99 over latency_ms WHERE latency_ms IS NOT NULL.  Null when no row had latency. */
  latencyP50: number | null;
  latencyP95: number | null;
  latencyP99: number | null;
  latencySamples: number;
}

export interface AliasStatsOptions {
  /** ISO-8601 lower bound (inclusive).  undefined = no lower bound (all-time). */
  sinceIso?: string;
  /** Optional user_id filter (admin can scope to a single tenant). undefined = all users. */
  userId?: string;
}

/** Aggregate llm_usage rows into per-alias stat rows.  Two windows are produced by calling this
 *  once with no `sinceIso` (all-time) and once with `sinceIso = now - 90d` (rolling quarter).
 *
 *  Implementation note: the sums aggregate per model in SQL (GROUP BY model, provider,
 *  cost_source) so the unbounded all-time window materializes O(distinct models) grouped rows
 *  instead of O(all LLM calls) raw rows — the ledger is kept forever, so raw-row
 *  materialization would grow without bound.  Alias buckets still merge in JS because
 *  `aliasForModel` is deterministic per model id; the merge is exact (sums, status counts,
 *  distinct source-model/provider sets).  Latency percentiles come from a second narrow
 *  query that only touches rows with a recorded latency, so the merged distributions are
 *  identical to a full-row scan. */
export function aggregateLlmStats(opts: AliasStatsOptions = {}): AliasStatRow[] {
  const db = getDb();

  const params: unknown[] = [];
  const where: string[] = ["1=1"];
  if (opts.sinceIso) {
    where.push("created_at >= ?");
    params.push(opts.sinceIso);
  }
  if (opts.userId) {
    where.push("user_id = ?");
    params.push(opts.userId);
  }
  const filter = where.join(" AND ");

  interface GroupRow {
    model: string | null;
    provider: string | null;
    cost_source: string | null;
    calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost_usd: number;
    error_calls: number;
    timeout_calls: number;
    canceled_calls: number;
  }
  const groups = db
    .prepare(
      `SELECT model, provider, cost_source,
              COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COALESCE(SUM(cost_usd), 0) AS cost_usd,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_calls,
              SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) AS timeout_calls,
              SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END) AS canceled_calls
       FROM llm_usage WHERE ${filter}
       GROUP BY model, provider, cost_source`
    )
    .all(...params) as GroupRow[];

  const buckets = new Map<string, AliasStatRow>();
  const bucketFor = (model: string | null): AliasStatRow => {
    const { family, label } = aliasForModel(model);
    const key = label || "(unknown)";
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        alias: key,
        family,
        sourceModels: [],
        providers: [],
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        billedCostUsd: 0,
        estimatedCostUsd: 0,
        errorCalls: 0,
        timeoutCalls: 0,
        canceledCalls: 0,
        latencyP50: null,
        latencyP95: null,
        latencyP99: null,
        latencySamples: 0
      };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  for (const g of groups) {
    const bucket = bucketFor(g.model);
    bucket.calls += g.calls;
    bucket.promptTokens += g.prompt_tokens;
    bucket.completionTokens += g.completion_tokens;
    bucket.totalTokens += g.total_tokens;
    if (g.cost_source === "billed") {
      bucket.billedCostUsd += g.cost_usd;
    } else {
      // "estimated" or a legacy row without cost_source — estimated by default
      // (matches the legacy treatment of rows that predate cost provenance).
      bucket.estimatedCostUsd += g.cost_usd;
    }
    bucket.errorCalls += g.error_calls;
    bucket.timeoutCalls += g.timeout_calls;
    bucket.canceledCalls += g.canceled_calls;
    if (g.model && !bucket.sourceModels.includes(g.model)) bucket.sourceModels.push(g.model);
    if (g.provider && !bucket.providers.includes(g.provider)) bucket.providers.push(g.provider);
  }

  // Latency percentiles: only rows that actually recorded a latency participate.  Merging
  // the per-row samples in JS yields the exact same order statistics as a full scan.
  interface LatRow {
    model: string | null;
    latency_ms: number;
  }
  const latRows = db
    .prepare(`SELECT model, latency_ms FROM llm_usage WHERE ${filter} AND latency_ms IS NOT NULL`)
    .all(...params) as LatRow[];
  const latencies = new Map<string, number[]>();
  for (const r of latRows) {
    const key = aliasForModel(r.model).label || "(unknown)";
    let list = latencies.get(key);
    if (!list) {
      list = [];
      latencies.set(key, list);
    }
    list.push(r.latency_ms);
  }

  // Compute percentiles per bucket.
  for (const [key, list] of latencies.entries()) {
    const bucket = buckets.get(key);
    if (!bucket) continue;
    list.sort((a, b) => a - b);
    bucket.latencySamples = list.length;
    bucket.latencyP50 = pctile(list, 0.5);
    bucket.latencyP95 = pctile(list, 0.95);
    bucket.latencyP99 = pctile(list, 0.99);
  }

  // Sort by total cost descending so the priciest rows surface first.
  const out = Array.from(buckets.values());
  out.sort((a, b) => b.billedCostUsd + b.estimatedCostUsd - (a.billedCostUsd + a.estimatedCostUsd));
  return out;
}

/** Convenience: aggregate both all-time and last-90d windows in one call.  The console page
 *  uses this so a single network round-trip returns the two side-by-side windows the owner
 *  asked for ("all-time stats for opus, last 3 months stats for opus"). */
export function aggregateLlmStatsDualWindow(opts: { userId?: string; now?: Date } = {}): {
  allTime: AliasStatRow[];
  last90d: AliasStatRow[];
} {
  const now = opts.now ?? new Date();
  const sinceIso = new Date(now.getTime() - 90 * 24 * 3600 * 1000).toISOString();
  return {
    allTime: aggregateLlmStats(opts.userId ? { userId: opts.userId } : {}),
    last90d: aggregateLlmStats({ ...(opts.userId ? { userId: opts.userId } : {}), sinceIso })
  };
}

/** Nearest-rank percentile.  Returns null for empty input.  Caller is responsible for sorting
 *  the array ascending — pass an unsorted array and the result is undefined behavior. */
function pctile(sortedAsc: number[], q: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(q * sortedAsc.length) - 1));
  return sortedAsc[idx];
}
