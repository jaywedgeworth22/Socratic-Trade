import { PayloadTooLargeError, readJsonWithLimit } from "@/lib/bounded-body";
import { authorizeOpsRequest } from "@/lib/ops-auth";
import { recomputeConnectedAccountHighWaterMark } from "@/lib/risk-hwm";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const OPS_HWM_RECOMPUTE_MAX_BYTES = 4 * 1024;

/**
 * Token-gated heal: rebuild a cash-flow-aware drawdown high-water mark from Alpaca CSD/CSW
 * (and the other transfer types in broker-cash-flows) plus current equity, then persist
 * `risk:hwm:${userId}:${accountNumber}:${source}`.
 *
 * Headers: `x-ops-token: <secret>` OR `Authorization: Bearer <secret>`
 * Body: `{ "connectedAccountId": "<uuid>" }`
 *
 * Never returns secrets or API keys.
 */
export async function POST(request: Request) {
  if (!authorizeOpsRequest(request)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized. Set OPS_DIAGNOSTIC_TOKEN and pass x-ops-token or Authorization: Bearer." },
      { status: 401 }
    );
  }

  let body: { connectedAccountId?: unknown };
  try {
    body = await readJsonWithLimit<{ connectedAccountId?: unknown }>(request, OPS_HWM_RECOMPUTE_MAX_BYTES);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return NextResponse.json({ ok: false, error: "Request body too large" }, { status: 413 });
    }
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const connectedAccountId =
    typeof body?.connectedAccountId === "string" ? body.connectedAccountId.trim() : "";
  if (!connectedAccountId) {
    return NextResponse.json({ ok: false, error: "connectedAccountId is required" }, { status: 400 });
  }

  const result = await recomputeConnectedAccountHighWaterMark(connectedAccountId);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    ok: true,
    oldHwm: result.oldHwm,
    newHwm: result.newHwm,
    equity: result.equity,
    netTransfers: result.netTransfers,
    transferCount: result.transferCount,
    impliedDrawdownPct: result.impliedDrawdownPct
  });
}
