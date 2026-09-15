import { NextResponse } from "next/server";
import { audit } from "@/lib/db";
import { fetchRealtimeQuotes } from "@/lib/market-realtime";
import { verifySecuritiesImportToken } from "@/lib/securities-import-auth";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// GET /api/market/quotes?symbols=AAPL,MSFT[&allowDelayed=1] — token-gated batch REAL-TIME quotes for
// congress.trade (App A). Same APP_B_INGEST_TOKEN bearer as the other peer-read routes.
//
// Exists because App A's latency-price capture was wired to a single FMP key that returned HTTP 402 in
// production and blanked the capture (7 prices recorded out of 2955 scheduled). Owner ruling
// 2026-08-20: FMP is never a market-data source. Do not reintroduce it here.
//
// A symbol we cannot price is OMITTED rather than zero-filled — the caller must be able to distinguish
// "no quote" from "some quote". By default only NON-DELAYED prices are returned; `allowDelayed=1` opts
// in to the ~15-minute-delayed Yahoo fallback, and every such quote carries `delayed: true` so a
// point-in-time capture can refuse it. For a price at a PAST instant use /api/market/intraday instead —
// a live quote can never honestly answer a question about the past.
const MAX_SYMBOLS = 200;

export async function GET(req: Request) {
  if (!verifySecuritiesImportToken(req)) {
    audit("market_read_rejected", { reason: "token", route: "quotes" });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const rateLimitResp = enforceRateLimit("peer-app", "peer-read", RATE_LIMITS.peerRead);
  if (rateLimitResp) return rateLimitResp;

  const sp = new URL(req.url).searchParams;
  const symbols = (sp.get("symbols") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_SYMBOLS);
  if (symbols.length === 0) {
    return NextResponse.json({ ok: false, error: "symbols required" }, { status: 400 });
  }

  const allowDelayed = ["1", "true", "yes"].includes((sp.get("allowDelayed") ?? "").toLowerCase());
  const quotes = await fetchRealtimeQuotes(symbols, undefined, { allowDelayed });
  // The top-level field is the moment we SERVED the response — not the freshness of
  // any quote inside it (per-quote freshness lives on each quote's own `at` field;
  // see /api/market/quotes peer routes that already use `servedAt`).  Older code
  // stamped this with `new Date()` under the `asOf` name, which a point-in-time
  // consumer could read as quote freshness even when the cascade had served a
  // delayed Yahoo fallback.
  return NextResponse.json({
    ok: true,
    servedAt: new Date().toISOString(),
    requested: symbols.length,
    returned: Object.keys(quotes).length,
    allowDelayed,
    quotes
  });
}
