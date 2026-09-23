import { NextResponse } from "next/server";
import { aggregateLlmStats, aggregateLlmStatsDualWindow } from "@/lib/llm-stats";
import { requireAdmin } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

/** Admin LLM stats — per-alias aggregates with two time windows (all-time + last-90d) plus
 *  an optional custom window the caller specifies via `sinceIso`.
 *
 *  Owner rule 2026-09-23: keep every LLM call forever, so the all-time window is unbounded.
 *  The console page renders BOTH windows side by side so the long-window numbers are
 *  stable for trade-outcome correlation while the short window catches a recent pricing-tier
 *  drop or a model swap.
 *
 *  Alias mapping collapses all opus generations (`claude-opus-4-8`, `claude-opus-5`,
 *  `claude-opus-5.5` once it lands, `anthropic/claude-opus-latest`) into a single `opus`
 *  bucket — needed for statistically significant trade-outcome data per family.
 *
 *  Query params:
 *    userId    optional; scope aggregates to a single tenant (admin only).
 *    sinceIso  optional; returns a `custom` row set bounded below by this ISO-8601 instant.
 */
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const userId = url.searchParams.get("userId") || undefined;
  const sinceIso = url.searchParams.get("sinceIso") || undefined;

  const { allTime, last90d } = aggregateLlmStatsDualWindow({ userId });
  const custom = sinceIso ? aggregateLlmStats({ userId, sinceIso }) : undefined;

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    userId: userId ?? null,
    allTime,
    last90d,
    ...(custom ? { custom: { sinceIso, rows: custom } } : {})
  });
}
