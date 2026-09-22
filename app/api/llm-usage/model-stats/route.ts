import { NextResponse } from "next/server";
import { listAuditByKind, listConnectedAccounts, listFillEvents } from "@/lib/db";
import { getLlmUsageSummary } from "@/lib/llm-usage";
import { aggregateModelStats, normalizeBenchmarkSummaries, type ClosedLotLike } from "@/lib/model-stats";
import { calculatePnl, getRedTeamEfficacy, RED_TEAM_EFFICACY_DEFAULT_AUDIT_LIMIT } from "@/lib/performance";
import { resolveRequestUserId } from "@/lib/request-user";
// Static benchmark reference (2026-07-08 model benchmark run): bundled at build time so the
// endpoint has cost/latency numbers for every catalog model even with zero live traffic.
import benchmarkJson from "../../../../docs/benchmarks/2026-07-08-llm-model-benchmark.json";
// Supplemental keyed re-benchmark (2026-07-10): the 2026-07-08 sweep recorded 0 successes for
// every Mistral row (a since-fixed capability-map bug, see docs/rollouts/2026-07-10-mistral-
// rebench.md), so normalizeBenchmarkSummaries dropped them for lack of any numbers. This run's
// summaries carry the real Mistral cost/latency at the pool's DEFAULT reasoning effort — the
// high-reasoning-effort probe (docs/benchmarks/2026-07-10-mistral-rebench-high.json) is
// deliberately NOT merged here to avoid a second, ambiguous row for the same (model, role); its
// numbers instead inform the advice text under the Mistral reasoning-effort control
// (src/lib/model-reasoning-recommendations.ts).
import mistralRebenchJson from "../../../../docs/benchmarks/2026-07-10-mistral-rebench.json";

export const dynamic = "force-dynamic";

// Per-(model, role) cost / latency / realized-performance stats for the Proposer/Reviewer/
// Strategist model pickers (the Framework/strategy page drawers). Auth mirrors the sibling
// /api/llm-usage route: identity comes only from the middleware-verified user.
//
// Live sources (this user's data only):
//   - llm_usage rows        → calls + avg cost per call ("strategy" = green,
//                             "strategy-bear"/"red-team" = red, "strategy-tuning" = strategist —
//                             the AI review seat; see roleForUsageContext in model-stats.ts)
//   - llm_call_latency audit events → p50 latency (step bull = green, bear = red; strategist has
//     no latency audit events, so its rows always show latencySamples: 0)
//   - closed lots across ALL of the user's connected accounts, attributed to the entry
//     proposal's proposedByModel → realized win-rate / avg P&L (GREEN only).
//   - getRedTeamEfficacy(userId).byModel (user-wide, all accounts) → per-reviewer veto
//     value-add (RED only): the counterfactual outcome of the proposals each reviewer
//     vetoed. Red attribution is per-run, not per-closed-trade, so it feeds `reviewerPerf`
//     rather than the closed-trade `perf` field — see model-stats.ts.
// Benchmark sources: docs/benchmarks/2026-07-08-llm-model-benchmark.json (full sweep, cold p50 +
// est. cost/call) topped up by the 2026-07-10 Mistral re-benchmark (see the import comment above),
// clearly separated in the payload so the UI can label live vs benchmark. No benchmark rows exist
// for the strategist role — it's live-only (cost/call, call count, total cost over the window); the
// `stats` array already carries `role: "strategist"` rows via aggregateModelStats, so the drawer
// filters on that role rather than this route needing a separate response field.
export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const url = new URL(request.url);
  const sinceDaysParam = url.searchParams.get("sinceDays");
  // Default to 0 (all time / lifetime) unless a specific bounded window is requested.
  const sinceDays = sinceDaysParam !== null ? Math.max(0, Number(sinceDaysParam) || 0) : 0;
  const sinceIso = sinceDays > 0 ? new Date(Date.now() - sinceDays * 24 * 60 * 60_000).toISOString() : undefined;

  const usageRows = getLlmUsageSummary({ sinceIso, userId });
  const latencyEvents = listAuditByKind("llm_call_latency", 10000, userId);

  // Closed lots across every connected account (paper + live), FIFO-replayed exactly as the
  // Results page does. No currentPrices — only REALIZED outcomes matter here.
  const closedLots: ClosedLotLike[] = [];
  for (const account of listConnectedAccounts(userId)) {
    if (!account.accountNumber) continue;
    const { closedLots: lots } = calculatePnl(listFillEvents(account.accountNumber, undefined, undefined, userId), {});
    for (const lot of lots) closedLots.push({ entryModel: lot.entryModel, reviewedByModel: lot.reviewedByModel, pnl: lot.pnl, returnPct: lot.returnPct });
  }

  // Reviewer veto value-add, user-wide (omit connectedAccountId) so it aggregates across all
  // the user's accounts — matching how the Proposer's realized P&L above spans every account.
  // auditLimit matches getRedTeamEfficacy's own default (RED_TEAM_EFFICACY_DEFAULT_AUDIT_LIMIT)
  // rather than a separate hardcoded number — see that constant's comment for why this was
  // raised past the original 500.
  const reviewerPerfByModel = getRedTeamEfficacy(userId, { auditLimit: RED_TEAM_EFFICACY_DEFAULT_AUDIT_LIMIT }).byModel;

  const stats = aggregateModelStats({
    usageRows,
    latencyEvents,
    // Concatenation is safe: normalizeBenchmarkSummaries drops the 2026-07-08 Mistral rows for
    // lack of numbers (all-error), so the 2026-07-10 rows are the only ones that survive for
    // those (model, role) pairs — no overwrite ambiguity.
    benchmarkSummaries: normalizeBenchmarkSummaries([...benchmarkJson.summaries, ...mistralRebenchJson.summaries]),
    closedLots,
    reviewerPerfByModel
  });

  // "Most recently updated" — the later of the two merged runs' timestamps, so the drawer's
  // disclaimer date is honest even though it only ever shows one date for a two-source blend.
  const mostRecentRunAt =
    new Date(mistralRebenchJson.runAt).getTime() > new Date(benchmarkJson.runAt).getTime() ? mistralRebenchJson.runAt : benchmarkJson.runAt;

  return NextResponse.json({
    sinceDays,
    benchmark: { runAt: mostRecentRunAt, source: "2026-07-08-llm-model-benchmark+2026-07-10-mistral-rebench" },
    stats
  });
}
