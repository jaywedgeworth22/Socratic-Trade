import { authorizeOpsRequest } from "@/lib/ops-auth";
import {
  getOrBuildOpsPerformanceSnapshot,
  OPS_PERFORMANCE_DEFAULT_DAYS,
  OPS_PERFORMANCE_MAX_DAYS,
  OPS_PERFORMANCE_MIN_DAYS
} from "@/lib/ops-performance";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Token-gated, read-only realized-performance rollup for remote diagnostics — same gate as
 * `/api/ops/snapshot` (`authorizeOpsRequest`: `OPS_DIAGNOSTIC_TOKEN` via `x-ops-token` or
 * `Authorization: Bearer`).  GET only.
 *
 * `/api/connected-accounts/[id]/performance` and `/console/results` are session-gated (no way
 * for a remote agent/uptime probe to authenticate), and `/api/ops/snapshot` carries strategy-run
 * and audit state but no P&L.  This fills that gap: per-account realized P&L, win rate, profit
 * factor, expectancy, thesis/Red-Team/model attribution, the proposal status funnel, and a
 * downsampled equity curve — see `src/lib/ops-performance.ts` for the full shape and the
 * query-cost notes.
 *
 * Query: `account=<connectedAccountId>` (optional — narrows to one account across every user;
 * omitted returns every account `/api/ops/snapshot` covers), `days=<n>` (default 90, clamped
 * 1-3650 — the lookback window for trade-level stats, the proposal funnel, and the equity curve;
 * thesis/Red-Team/model attribution are lifetime, matching how the app's own scorecards work).
 *
 * Response cached in-process for 60s (single-flight per `account`+`days` key) — this runs inside
 * a production web process whose event loop is already known to stall under load.
 */
export async function GET(request: Request) {
  if (!authorizeOpsRequest(request)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized. Set OPS_DIAGNOSTIC_TOKEN and pass x-ops-token or Authorization: Bearer." },
      { status: 401 }
    );
  }

  const url = new URL(request.url);
  const account = url.searchParams.get("account")?.trim() || undefined;
  const daysParam = url.searchParams.get("days");
  const days = daysParam != null && daysParam.trim() !== "" ? Number(daysParam) : OPS_PERFORMANCE_DEFAULT_DAYS;

  const snapshot = await getOrBuildOpsPerformanceSnapshot({
    connectedAccountId: account,
    days: Number.isFinite(days) ? days : OPS_PERFORMANCE_DEFAULT_DAYS
  });

  return NextResponse.json({
    ok: true,
    minDays: OPS_PERFORMANCE_MIN_DAYS,
    maxDays: OPS_PERFORMANCE_MAX_DAYS,
    ...snapshot
  });
}
