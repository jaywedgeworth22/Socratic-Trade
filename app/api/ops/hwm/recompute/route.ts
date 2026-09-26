import { PayloadTooLargeError, readJsonWithLimit } from "@/lib/bounded-body";
import { authorizeOpsRequest } from "@/lib/ops-auth";
import { recomputeConnectedAccountHighWaterMark } from "@/lib/risk-hwm";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const OPS_HWM_RECOMPUTE_MAX_BYTES = 4 * 1024;

/**
 * Token-gated heal: rebuild a cash-flow-aware drawdown high-water mark from Alpaca's non-trade
 * ledger (`category=non_trade_activity`, classified in broker-cash-flows) replayed against
 * Alpaca's daily closes, then persist `risk:hwm:${userId}:${accountNumber}:${source}`.
 *
 * Headers: `x-ops-token: <secret>` OR `Authorization: Bearer <secret>`
 * Body: `{ "connectedAccountId": "<uuid>", "acceptUnexplained"?: true, "acceptEquityReset"?: true }`
 *
 * Honest outcomes (nothing is persisted on either):
 *  - 502 `flowsUnavailable: true` — the activity ledger could not be read.
 *  - 409 `unexplainedEquityChange` — equity fell with no ledger flow (or holds equity with no
 *    deposit on the ledger).  The body carries the proposed HWM; re-run with
 *    `acceptUnexplained: true` to keep it or `acceptEquityReset: true` to reset to equity.
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

  let body: { connectedAccountId?: unknown; acceptUnexplained?: unknown; acceptEquityReset?: unknown };
  try {
    body = await readJsonWithLimit<{ connectedAccountId?: unknown; acceptUnexplained?: unknown; acceptEquityReset?: unknown }>(
      request,
      OPS_HWM_RECOMPUTE_MAX_BYTES
    );
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

  const result = await recomputeConnectedAccountHighWaterMark(connectedAccountId, {
    acceptUnexplained: body?.acceptUnexplained === true,
    acceptEquityReset: body?.acceptEquityReset === true
  });
  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: result.error,
        persisted: false,
        ...(result.flowsUnavailable ? { flowsUnavailable: true } : {}),
        ...(result.httpStatus !== undefined ? { brokerHttpStatus: result.httpStatus } : {}),
        ...(result.unexplainedEquityChange ? { unexplainedEquityChange: result.unexplainedEquityChange } : {})
      },
      { status: result.status }
    );
  }

  return NextResponse.json({
    ok: true,
    persisted: true,
    oldHwm: result.oldHwm,
    newHwm: result.newHwm,
    equity: result.equity,
    netTransfers: result.netTransfers,
    transferCount: result.transferCount,
    impliedDrawdownPct: result.impliedDrawdownPct,
    method: result.method,
    capitalIn: result.capitalIn,
    capitalOut: result.capitalOut,
    ledger: {
      query: result.ledgerQuery,
      pages: result.ledgerPages,
      truncated: result.ledgerTruncated,
      ...(result.ledgerFallbackFrom ? { fallbackFrom: result.ledgerFallbackFrom } : {})
    },
    unclassified: result.unclassified,
    unexplainedEquityChanges: result.unexplainedEquityChanges,
    warnings: result.warnings
  });
}
