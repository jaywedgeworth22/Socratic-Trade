import { authorizeOpsRequest } from "@/lib/ops-auth";
import {
  OPS_FILL_RECONCILE_DEFAULT_BUDGET,
  OPS_FILL_RECONCILE_MAX_BUDGET,
  runOpsFillReconcile
} from "@/lib/ops-fill-reconcile";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Token-gated fill reconciliation backfill for ONE connected account — same gate as
 * `/api/ops/snapshot` (`authorizeOpsRequest`, OPS_DIAGNOSTIC_TOKEN via the x-ops-token header or a
 * bearer authorization header).
 *
 * GET  `?account=<connectedAccountId>` — read-only: current counts (placed proposals, pending
 *      receipts, broker-originated fills, bracket fills awaiting legs).  No broker calls.
 * POST `?account=<connectedAccountId>&budget=<n>` — run one reconciliation pass with up to `budget`
 *      per-order broker lookups (default 100, max 500) and no throttles, then report before/after
 *      counts and a per-sweep summary.  Idempotent: bookings are deduped by broker order id.  Never
 *      places or cancels an order.  The same pass runs automatically every scheduler tick with a
 *      small budget, so this route only speeds up draining a historical backlog.
 */
async function handle(request: Request, dryRun: boolean) {
  if (!authorizeOpsRequest(request)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized. Set OPS_DIAGNOSTIC_TOKEN and pass x-ops-token." },
      { status: 401 }
    );
  }
  const url = new URL(request.url);
  const account = url.searchParams.get("account")?.trim();
  if (!account) {
    return NextResponse.json({ ok: false, error: "Pass account=<connectedAccountId>." }, { status: 400 });
  }
  const budgetParam = url.searchParams.get("budget");
  const lookupBudget = budgetParam != null && budgetParam.trim() !== "" ? Number(budgetParam) : OPS_FILL_RECONCILE_DEFAULT_BUDGET;
  const result = await runOpsFillReconcile({ connectedAccountId: account, lookupBudget, dryRun });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ...result, maxBudget: OPS_FILL_RECONCILE_MAX_BUDGET });
}

export async function GET(request: Request) {
  return handle(request, true);
}

export async function POST(request: Request) {
  return handle(request, false);
}
