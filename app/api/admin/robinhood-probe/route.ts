import { NextRequest, NextResponse } from "next/server";
import { callRobinhoodMcpTool, robinhoodMcpDataEnabled, robinhoodHistoricalsStartTime } from "@/lib/robinhood";
import { resolveRequestUserId } from "@/lib/request-user";
import { requireAdmin } from "@/lib/auth/admin";
import { withAdminOperationGuard } from "@/lib/admin-operation-guard";

export const dynamic = "force-dynamic";

// Dev/diagnostic route: dumps the RAW output of Robinhood MCP data tools for one symbol so the
// exact field shapes (get_equity_historicals / get_equity_fundamentals) can be confirmed before
// trusting the parsers/enrichment mapping. Admin-gated by a middleware-verified primary/allowlisted
// admin email or a timing-safe x-admin-token; there is no environment bypass.
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  if (!robinhoodMcpDataEnabled()) {
    return NextResponse.json({
      ok: false,
      error: "ROBINHOOD_ADAPTER is not 'mcp'. Set ROBINHOOD_ADAPTER=mcp and connect OAuth (or set ROBINHOOD_MCP_AUTH_TOKEN) first."
    });
  }
  const userId = resolveRequestUserId(request);
  const symbol = (new URL(request.url).searchParams.get("symbol") || "AAPL").toUpperCase();
  return withAdminOperationGuard(request, "robinhood-probe", async () => {
    const [historicals, fundamentals] = await Promise.allSettled([
      callRobinhoodMcpTool(userId, "get_equity_historicals", { symbols: [symbol], interval: "day", start_time: robinhoodHistoricalsStartTime("5year"), bounds: "regular" }),
      callRobinhoodMcpTool(userId, "get_equity_fundamentals", { symbols: [symbol] })
    ]);
    return NextResponse.json({
      ok: true,
      symbol,
      historicals: historicals.status === "fulfilled" ? historicals.value : { error: String(historicals.reason) },
      fundamentals: fundamentals.status === "fulfilled" ? fundamentals.value : { error: String(fundamentals.reason) }
    });
  });
}
