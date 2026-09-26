import { authorizeOpsRequest } from "@/lib/ops-auth";
import { buildOpsAccountActivityReport, clampActivityDays } from "@/lib/ops-account-activity";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Token-gated, read-only view of one connected Alpaca account's NON-TRADE ledger: deposits,
 * withdrawals, IRA contributions/distributions, withholding, dividends, fees, journals — each
 * row classified the way the drawdown high-water mark treats it — plus a per-type summary and
 * the persisted HWM state.  Lets a fleet agent see exactly what Alpaca reports (or which error
 * it returned) without an OAuth session.
 *
 * Headers: `x-ops-token: <secret>` OR `Authorization: Bearer <secret>`
 * Query: `connectedAccountId` (required), `days` (default 365, max 1825)
 *
 * 200 = ledger read; 502 = the ledger read failed (body still carries the broker's status and
 * trimmed reason).  Never returns credentials, account numbers, or activity ids.
 */
export async function GET(request: Request) {
  if (!authorizeOpsRequest(request)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized. Set OPS_DIAGNOSTIC_TOKEN and pass x-ops-token or Authorization: Bearer." },
      { status: 401 }
    );
  }

  const url = new URL(request.url);
  const connectedAccountId = url.searchParams.get("connectedAccountId")?.trim() ?? "";
  if (!connectedAccountId) {
    return NextResponse.json({ ok: false, error: "connectedAccountId is required" }, { status: 400 });
  }
  const days = clampActivityDays(url.searchParams.get("days"));

  const outcome = await buildOpsAccountActivityReport({ connectedAccountId, days });
  if (!outcome.ok) {
    return NextResponse.json({ ok: false, error: outcome.error }, { status: outcome.status });
  }
  return NextResponse.json(outcome.report, { status: outcome.status });
}
