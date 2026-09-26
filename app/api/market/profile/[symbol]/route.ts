import { NextResponse } from "next/server";
import { audit } from "@/lib/db";
import { fetchCompanyProfile } from "@/lib/market-read";
import { verifySecuritiesImportToken } from "@/lib/securities-import-auth";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// GET /api/market/profile/{symbol} — token-gated company profile for congress.trade
// (App A) enrichment. Same APP_B_INGEST_TOKEN bearer as /api/market/prices and
// /api/market/quotes. Returns { ref } on 200; unknown symbols return 404 with
// the envelope { ref: null } so App A keeps asking other tickers (a bare
// framework 404 would stop the CT profile walk for the rest of the run).
// Sector / industry / marketCap come from the local imported ref cache or the
// keyless Nasdaq delayed screener. FMP is never used here.
export async function GET(req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  if (!verifySecuritiesImportToken(req)) {
    audit("market_read_rejected", { reason: "token", route: "profile" });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const rateLimitResp = enforceRateLimit("peer-app", "peer-read", RATE_LIMITS.peerRead);
  if (rateLimitResp) return rateLimitResp;
  const { symbol } = await params;
  const ref = await fetchCompanyProfile(symbol);
  if (!ref) {
    return NextResponse.json({ ref: null }, { status: 404 });
  }
  return NextResponse.json({ ref });
}
