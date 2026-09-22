// Per-model cost / latency / realized-performance rollup for the model pickers.
//
// Pure aggregation only — no DB access here, so the whole thing is unit-testable.
// The API route (app/api/llm-usage/model-stats/route.ts) feeds it:
//   - llm_usage summary rows        → live cost per call, per (model, role)
//   - llm_call_latency audit events → live p50 latency, per (model, role)
//   - the static 2026-07-08 benchmark JSON (docs/benchmarks/) → benchmark cost +
//     cold p50 so EVERY catalog model has numbers even with zero live traffic
//   - closed lots (calculatePnl) with their entry model (proposedByModel) →
//     realized win-rate / avg P&L, GREEN (proposer) only.
//
// Role mapping conventions (see recordLlmUsage call sites + recordLlmOutcome):
//   llm_usage.context: "strategy" = green/proposer; "strategy-bear" and
//   "red-team" = red/reviewer; "strategy-tuning" = strategist (the AI review /
//   strategy-tune seat, src/lib/strategy-tuning.ts). Other contexts (chat,
//   coach, …) are ignored — this rollup exists for the Proposer/Reviewer/
//   Strategist pickers. These raw context strings are NEVER changed here —
//   only mapped to a picker role.
//   llm_call_latency payload.step: "bull" = green, "bear" = red. Strategist has
//   no latency audit events (AI review is a one-shot call, not a scored step),
//   so strategist rows always carry latencySamples: 0 / p50LatencyMs: null.
//
// Strategist rows carry cost/call + total cost over the window (the owner's
// explicit ask: historical spend on running AI review, per model) via the SAME
// live cost aggregation as green/red — just keyed under the "strategist" role.
// They never carry latency, benchmark, perf, or reviewerPerf: there's no
// offline benchmark for the tuning seat and no closed-trade/veto attribution
// concept for it either.
//
// Performance gating contract (owner request 2026-07-08): the API always
// reports `closedTrades`, and includes `perf` whenever closedTrades >= 1 —
// the UI decides how to present it (hidden/caveated below its own thresholds).
// Realized-P&L `perf` stays GREEN-only: Red attribution is per-run, not
// per-closed-trade, so we never fake closed-trade P&L for a reviewer. RED rows
// instead carry `reviewerPerf` — veto value-add fed from getRedTeamEfficacy
// (share of matured vetoes whose counterfactual "had-it-run" outcome was a loss;
// negative avg return = the veto added value). The UI applies the same
// 20/50-resolved-veto gates as the Results page 'Red Team veto efficacy' card.

// Canonicalize a (possibly OpenRouter-route-qualified) model id to its bare catalog name so
// live/historical/benchmark stats align across the routing cutover. One shared definition in
// ./model-identity — aliased to `cleanModelId` here so the call sites below stay unchanged.
import { canonicalModelId as cleanModelId } from "./model-identity";
import { getPredecessorModelIds } from "./llm-model-catalog";

export type ModelRole = "green" | "red" | "strategist";

/** The "unattributed" reviewer bucket from getRedTeamEfficacy — matured vetoes with no
 *  persisted reviewer model. It never matches a catalog model, so it's dropped from the
 *  picker rollup. Mirrors RED_TEAM_UNATTRIBUTED_MODEL (app/console/lib/red-team-efficacy.ts)
 *  and the "unattributed" bucket key in getRedTeamEfficacy (src/lib/performance.ts). */
const REVIEWER_UNATTRIBUTED_MODEL = "unattributed";

/** Subset of LlmUsageRow the rollup needs (llm_usage-shaped aggregate rows). */
export interface UsageRowLike {
  model: string | null;
  context: string | null;
  calls: number;
  costUsd: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  billedCostUsd?: number;
}

/** One llm_call_latency audit event (payload is the raw audit JSON). */
export interface LatencyEventLike {
  payload: unknown;
}

/** Normalized benchmark reference for one (model, role) — from the static benchmark JSON. */
export interface BenchmarkRoleSummary {
  model: string;
  role: ModelRole;
  /** Benchmark avg estimated cost per call (USD). */
  benchmarkCostUsd?: number;
  /** Benchmark COLD p50 latency (ms) — first-call latency, the pessimistic bound. */
  benchmarkColdP50Ms?: number;
}

/** Subset of ClosedLot the rollup needs. */
export interface ClosedLotLike {
  /** Model that proposed the ENTRY (proposedByModel stamped on the opening proposal). */
  entryModel?: string | null;
  /** Model that reviewed the ENTRY (reviewedByModel stamped on the opening proposal). */
  reviewedByModel?: string | null;
  pnl: number;
  returnPct: number;
}

export interface ModelPerf {
  closedTrades: number;
  /** % of closed lots with returnPct > 0, 0-100, 1 decimal. */
  winRate: number;
  /** Mean returnPct across closed lots, 2 decimals. */
  avgPnlPct: number;
  /** Sum of realized P&L (USD), 2 decimals. */
  totalPnlUsd: number;
}

/** Reviewer (Red Team) veto value-add for one model — from getRedTeamEfficacy(userId).byModel.
 *  NOT win-rate / realized P&L: it measures the counterfactual outcome of the risk-adding
 *  proposals this reviewer vetoed. A veto resolves ~5 trading days after it's made. */
export interface ReviewerPerf {
  /** Matured blocking vetoes (keyed runId+symbol) attributed to this reviewer model. Sample size. */
  maturedVetoes: number;
  /** % of matured vetoes whose counterfactual return was NEGATIVE (the veto avoided a loser). HIGHER = better. */
  vetoValueAddRate: number;
  /** % of matured vetoes whose counterfactual return was POSITIVE (the veto missed a winner). */
  survivorRiskHitRate: number;
  /** Mean counterfactual return (%) of vetoed names; NEGATIVE = good (losses avoided). */
  avgReturnPct: number;
}

export interface ModelRoleStats {
  model: string;
  role: ModelRole;
  /** Live llm_usage calls in the window for this (model, role). */
  liveCalls: number;
  /** Live avg cost per call (USD); null when liveCalls === 0. */
  avgCostUsd: number | null;
  /** Live TOTAL cost (USD) summed over the window; null when liveCalls === 0. Primarily for the
   *  Strategist section (historical spend on running AI review, per model) but computed for every
   *  role from the same cost aggregation. */
  totalCostUsd: number | null;
  /** Live p50 latency (ms) from llm_call_latency audits; null when no samples. */
  p50LatencyMs: number | null;
  /** Number of successful live latency samples behind p50LatencyMs. */
  latencySamples: number;
  benchmarkCostUsd: number | null;
  benchmarkColdP50Ms: number | null;
  /** ALWAYS reported (0 when none) so the UI can render "needs >= N (n=X)". Green only; 0 for red. */
  closedTrades: number;
  /** Realized performance — present whenever closedTrades >= 1 (green only); UI applies display thresholds. */
  perf: ModelPerf | null;
  /** Reviewer veto value-add — present on RED rows with any matured vetoes for this model; always
   *  null on GREEN rows. The UI hides it below 20 matured vetoes and caveats it below 50. */
  reviewerPerf: ReviewerPerf | null;
  /** Total tokens consumed in the window; null when liveCalls === 0. */
  totalTokens: number | null;
  /** Mean tokens per call; null when liveCalls === 0. */
  avgTokensPerCall: number | null;
  /** Prompt / input tokens consumed in the window. */
  promptTokens: number | null;
  /** Completion / output tokens consumed in the window. */
  completionTokens: number | null;
  /** Predecessor model display slug if stats were rolled forward via lineage. */
  inheritedFrom: string | null;
  /** True when metrics (calls, latency, tokens, or trade outcomes) roll forward from a predecessor. */
  isInherited: boolean;
  /** Number of closed trades inherited from predecessor(s). */
  inheritedClosedTrades?: number;
}

/** Map an llm_usage context to a picker role; null = not a strategy-loop context. */
export function roleForUsageContext(context: string | null | undefined): ModelRole | null {
  if (context === "strategy") return "green";
  if (context === "strategy-bear" || context === "red-team") return "red";
  if (context === "strategy-tuning") return "strategist";
  return null;
}

/** Map an llm_call_latency step to a picker role; null = unknown step. */
export function roleForLatencyStep(step: string | null | undefined): ModelRole | null {
  if (step === "bull") return "green";
  if (step === "bear") return "red";
  return null;
}

/** p50 via nearest-rank on a sorted copy; null for an empty list. */
export function medianMs(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor((sorted.length - 1) / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid] + sorted[mid + 1]) / 2);
}

function key(model: string, role: ModelRole): string {
  return `${role} ${model}`;
}

export interface AggregateModelStatsInput {
  usageRows: UsageRowLike[];
  latencyEvents: LatencyEventLike[];
  benchmarkSummaries: BenchmarkRoleSummary[];
  closedLots: ClosedLotLike[];
  /** Optional extra model ids (e.g. the picker catalog) that must appear even with zero data anywhere. */
  models?: string[];
  /** Per-model reviewer (Red Team) veto value-add — pass getRedTeamEfficacy(userId).byModel.
   *  Applied to RED rows only; the "unattributed" bucket is filtered out (never a catalog model). */
  reviewerPerfByModel?: Array<{
    model: string;
    maturedVetoes: number;
    vetoValueAddRate: number;
    survivorRiskHitRate: number;
    avgReturnPct: number;
  }>;
}

/**
 * Roll everything up to one row per (model, role). Emits the union of models seen in any
 * input (usage, latency, benchmark, closed lots, `models`), both roles each, so the picker
 * UI can look up any dropdown option and always find a row.
 */
export function aggregateModelStats(input: AggregateModelStatsInput): ModelRoleStats[] {
  const modelSet = new Set<string>((input.models ?? []).map(cleanModelId));

  // Live cost and token usage per (model, role) from llm_usage rows.
  const usageData = new Map<
    string,
    { calls: number; totalCostUsd: number; promptTokens: number; completionTokens: number; totalTokens: number }
  >();
  for (const row of input.usageRows) {
    const role = roleForUsageContext(row.context);
    if (!role || !row.model) continue;
    const model = cleanModelId(row.model);
    modelSet.add(model);
    const k = key(model, role);
    const bucket = usageData.get(k) ?? { calls: 0, totalCostUsd: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    bucket.calls += Number.isFinite(row.calls) ? row.calls : 0;
    bucket.totalCostUsd += Number.isFinite(row.costUsd) ? row.costUsd : 0;
    bucket.promptTokens += Number.isFinite(row.promptTokens) ? Number(row.promptTokens) : 0;
    bucket.completionTokens += Number.isFinite(row.completionTokens) ? Number(row.completionTokens) : 0;
    bucket.totalTokens += Number.isFinite(row.totalTokens) ? Number(row.totalTokens) : 0;
    usageData.set(k, bucket);
  }

  // Live latency samples per (model, role). Only successful calls count — an instant
  // 429/error would otherwise drag the p50 toward zero.
  const latency = new Map<string, number[]>();
  for (const event of input.latencyEvents) {
    const p = event.payload as { step?: unknown; model?: unknown; durationMs?: unknown; ok?: unknown } | null | undefined;
    if (!p || typeof p !== "object") continue;
    const role = roleForLatencyStep(typeof p.step === "string" ? p.step : undefined);
    const modelRaw = typeof p.model === "string" && p.model ? p.model : undefined;
    const durationMs = typeof p.durationMs === "number" && Number.isFinite(p.durationMs) && p.durationMs > 0 ? p.durationMs : undefined;
    if (!role || !modelRaw || durationMs === undefined || p.ok !== true) continue;
    const model = cleanModelId(modelRaw);
    modelSet.add(model);
    const k = key(model, role);
    const bucket = latency.get(k);
    if (bucket) bucket.push(durationMs);
    else latency.set(k, [durationMs]);
  }

  // Benchmark reference per (model, role).
  const benchmark = new Map<string, BenchmarkRoleSummary>();
  for (const summary of input.benchmarkSummaries) {
    if (!summary.model) continue;
    const model = cleanModelId(summary.model);
    modelSet.add(model);
    benchmark.set(key(model, summary.role), { ...summary, model });
  }

  // Realized performance per entry model — GREEN (proposer) and RED (reviewer).
  const proposerLotsByModel = new Map<string, ClosedLotLike[]>();
  const reviewerLotsByModel = new Map<string, ClosedLotLike[]>();
  for (const lot of input.closedLots) {
    if (lot.entryModel) {
      const entryModel = cleanModelId(lot.entryModel);
      modelSet.add(entryModel);
      const bucket = proposerLotsByModel.get(entryModel);
      if (bucket) bucket.push(lot);
      else proposerLotsByModel.set(entryModel, [lot]);
    }
    if (lot.reviewedByModel) {
      const reviewedByModel = cleanModelId(lot.reviewedByModel);
      modelSet.add(reviewedByModel);
      const bucket = reviewerLotsByModel.get(reviewedByModel);
      if (bucket) bucket.push(lot);
      else reviewerLotsByModel.set(reviewedByModel, [lot]);
    }
  }

  // Reviewer (Red Team) veto value-add per model — RED role only by construction. The
  // "unattributed" bucket (vetoes with no persisted reviewer model) is dropped: it never
  // matches a catalog model.
  const reviewerByModel = new Map<string, ReviewerPerf>();
  for (const row of input.reviewerPerfByModel ?? []) {
    if (!row.model || row.model === REVIEWER_UNATTRIBUTED_MODEL) continue;
    const model = cleanModelId(row.model);
    modelSet.add(model);
    const incoming: ReviewerPerf = {
      maturedVetoes: row.maturedVetoes,
      vetoValueAddRate: row.vetoValueAddRate,
      survivorRiskHitRate: row.survivorRiskHitRate,
      avgReturnPct: row.avgReturnPct
    };
    const existing = reviewerByModel.get(model);
    if (!existing) {
      reviewerByModel.set(model, incoming);
      continue;
    }
    const n1 = existing.maturedVetoes;
    const n2 = incoming.maturedVetoes;
    const n = n1 + n2;
    reviewerByModel.set(model, {
      maturedVetoes: n,
      vetoValueAddRate: n > 0 ? (existing.vetoValueAddRate * n1 + incoming.vetoValueAddRate * n2) / n : 0,
      survivorRiskHitRate: n > 0 ? (existing.survivorRiskHitRate * n1 + incoming.survivorRiskHitRate * n2) / n : 0,
      avgReturnPct: n > 0 ? (existing.avgReturnPct * n1 + incoming.avgReturnPct * n2) / n : 0
    });
  }

  const out: ModelRoleStats[] = [];
  const models = Array.from(modelSet).sort();
  for (const model of models) {
    for (const role of ["green", "red", "strategist"] as ModelRole[]) {
      const c = usageData.get(key(model, role));
      const lat = latency.get(key(model, role)) ?? [];
      const bench = benchmark.get(key(model, role));
      // Strategist has no closed-trade/veto attribution concept — only green (proposer entries)
      // and red (reviewer vetoes) ever carry lots; strategist always sees an empty list here.
      const lots =
        role === "green" ? (proposerLotsByModel.get(model) ?? []) : role === "red" ? (reviewerLotsByModel.get(model) ?? []) : [];
      const closedTrades = lots.length;
      let perf: ModelPerf | null = null;
      if (closedTrades >= 1) {
        const wins = lots.filter((l) => l.returnPct > 0).length;
        perf = {
          closedTrades,
          winRate: Number(((wins / closedTrades) * 100).toFixed(1)),
          avgPnlPct: Number((lots.reduce((s, l) => s + l.returnPct, 0) / closedTrades).toFixed(2)),
          totalPnlUsd: Number(lots.reduce((s, l) => s + l.pnl, 0).toFixed(2))
        };
      }
      out.push({
        model,
        role,
        liveCalls: c?.calls ?? 0,
        avgCostUsd: c && c.calls > 0 ? Number((c.totalCostUsd / c.calls).toFixed(6)) : null,
        totalCostUsd: c && c.calls > 0 ? Number(c.totalCostUsd.toFixed(6)) : null,
        p50LatencyMs: medianMs(lat),
        latencySamples: lat.length,
        benchmarkCostUsd: typeof bench?.benchmarkCostUsd === "number" ? bench.benchmarkCostUsd : null,
        benchmarkColdP50Ms: typeof bench?.benchmarkColdP50Ms === "number" ? bench.benchmarkColdP50Ms : null,
        closedTrades,
        perf,
        // Mirror the green-perf guard: reviewer veto value-add is a RED-only measure.
        reviewerPerf: role === "red" ? (reviewerByModel.get(model) ?? null) : null,
        totalTokens: c && c.calls > 0 ? c.totalTokens : null,
        avgTokensPerCall: c && c.calls > 0 && c.totalTokens > 0 ? Math.round(c.totalTokens / c.calls) : null,
        promptTokens: c && c.calls > 0 ? c.promptTokens : null,
        completionTokens: c && c.calls > 0 ? c.completionTokens : null,
        inheritedFrom: null,
        isInherited: false,
        inheritedClosedTrades: undefined
      });
    }
  }

  // Predecessor Lineage Roll-Forward:
  // When models shift up slightly (e.g., GPT-5.6 Sol succeeding Terra, Gemini Flash 3.8 succeeding 3.7),
  // a new model starts with zero live samples, starving the UI and policy engine of statistical
  // baselines. If a model lacks sufficient samples (< 3 live calls or < 20 closed trades / vetoes),
  // roll forward and inherit historical evidence from its catalog-configured predecessors.
  const outByKey = new Map<string, ModelRoleStats>(out.map((row) => [key(row.model, row.role), row]));
  for (const stat of out) {
    const rawPreds = getPredecessorModelIds(stat.model);
    if (!rawPreds || rawPreds.length === 0) continue;
    const preds = rawPreds.map(cleanModelId);

    // 1. Cost, latency, and token metrics roll-forward (when liveCalls < 3)
    if (stat.liveCalls < 3) {
      for (const pred of preds) {
        const predStat = outByKey.get(key(pred, stat.role));
        if (predStat && predStat.liveCalls > 0) {
          stat.liveCalls = predStat.liveCalls;
          stat.avgCostUsd = predStat.avgCostUsd;
          stat.totalCostUsd = predStat.totalCostUsd;
          stat.totalTokens = predStat.totalTokens;
          stat.avgTokensPerCall = predStat.avgTokensPerCall;
          stat.promptTokens = predStat.promptTokens;
          stat.completionTokens = predStat.completionTokens;
          if (stat.latencySamples === 0 && predStat.latencySamples > 0) {
            stat.p50LatencyMs = predStat.p50LatencyMs;
            stat.latencySamples = predStat.latencySamples;
          }
          stat.isInherited = true;
          stat.inheritedFrom = predStat.model;
          break;
        }
      }
    }

    // 2. Realized performance roll-forward (Green Team, when closedTrades < 20)
    if (stat.role === "green" && stat.closedTrades < 20) {
      for (const pred of preds) {
        const predLots = proposerLotsByModel.get(pred) ?? [];
        if (predLots.length > 0) {
          const currentLots = proposerLotsByModel.get(stat.model) ?? [];
          const combinedLots = [...currentLots, ...predLots];
          const totalClosed = combinedLots.length;
          const wins = combinedLots.filter((l) => l.returnPct > 0).length;
          stat.perf = {
            closedTrades: totalClosed,
            winRate: Number(((wins / totalClosed) * 100).toFixed(1)),
            avgPnlPct: Number((combinedLots.reduce((s, l) => s + l.returnPct, 0) / totalClosed).toFixed(2)),
            totalPnlUsd: Number(combinedLots.reduce((s, l) => s + l.pnl, 0).toFixed(2))
          };
          stat.closedTrades = totalClosed;
          stat.isInherited = true;
          stat.inheritedFrom = stat.inheritedFrom ?? pred;
          stat.inheritedClosedTrades = predLots.length;
          break;
        }
      }
    }

    // 3. Reviewer veto value-add roll-forward (Red Team, when maturedVetoes < 20)
    if (stat.role === "red" && (!stat.reviewerPerf || stat.reviewerPerf.maturedVetoes < 20)) {
      for (const pred of preds) {
        const predStat = outByKey.get(key(pred, "red"));
        if (predStat?.reviewerPerf && predStat.reviewerPerf.maturedVetoes > 0) {
          const cur = stat.reviewerPerf;
          const predPerf = predStat.reviewerPerf;
          if (!cur || cur.maturedVetoes === 0) {
            stat.reviewerPerf = { ...predPerf };
          } else {
            const n1 = cur.maturedVetoes;
            const n2 = predPerf.maturedVetoes;
            const n = n1 + n2;
            stat.reviewerPerf = {
              maturedVetoes: n,
              vetoValueAddRate: Number(((cur.vetoValueAddRate * n1 + predPerf.vetoValueAddRate * n2) / n).toFixed(1)),
              survivorRiskHitRate: Number(((cur.survivorRiskHitRate * n1 + predPerf.survivorRiskHitRate * n2) / n).toFixed(1)),
              avgReturnPct: Number(((cur.avgReturnPct * n1 + predPerf.avgReturnPct * n2) / n).toFixed(2))
            };
          }
          stat.isInherited = true;
          stat.inheritedFrom = stat.inheritedFrom ?? predStat.model;
          break;
        }
      }
    }
  }

  return out;
}

/** Raw shape of one summaries[] entry in docs/benchmarks/2026-07-08-llm-model-benchmark.json. */
export interface RawBenchmarkSummary {
  model?: unknown;
  role?: unknown;
  coldP50LatencyMs?: unknown;
  p50LatencyMs?: unknown;
  avgEstCostUsd?: unknown;
  coldAvgCostUsd?: unknown;
  warmAvgCostUsd?: unknown;
  successes?: unknown;
}

/**
 * Normalize the benchmark JSON's summaries into BenchmarkRoleSummary rows. Entries with
 * zero successes (e.g. the mistral rows that only saw HTTP errors) carry no numbers and
 * are dropped. Cold p50 is preferred (that's what a first picker-driven call feels like);
 * when a run never recorded a cold sample the overall p50 stands in. Cost prefers the
 * all-rounds average, then cold, then warm.
 */
export function normalizeBenchmarkSummaries(raw: RawBenchmarkSummary[]): BenchmarkRoleSummary[] {
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
  const out: BenchmarkRoleSummary[] = [];
  for (const s of raw) {
    const modelRaw = typeof s.model === "string" ? s.model : undefined;
    const role = s.role === "green" || s.role === "red" ? (s.role as ModelRole) : undefined;
    if (!modelRaw || !role) continue;
    const model = cleanModelId(modelRaw);
    const benchmarkColdP50Ms = num(s.coldP50LatencyMs) ?? num(s.p50LatencyMs);
    const benchmarkCostUsd = num(s.avgEstCostUsd) ?? num(s.coldAvgCostUsd) ?? num(s.warmAvgCostUsd);
    if (benchmarkColdP50Ms === undefined && benchmarkCostUsd === undefined) continue;
    out.push({
      model,
      role,
      ...(benchmarkCostUsd !== undefined ? { benchmarkCostUsd } : {}),
      ...(benchmarkColdP50Ms !== undefined ? { benchmarkColdP50Ms } : {})
    });
  }
  return out;
}
