import { NextResponse } from "next/server";
import { enrichYahooFinanceSymbol, getEnrichmentProvider, type SymbolEnrichment } from "@/lib/data-providers";
import {
  composeOnDemandQuote,
  enrichmentHasValues,
  fastQuoteEnrichment,
  loadDurableQuoteSeed,
  persistOnDemandQuote
} from "@/lib/on-demand-quote";
import { resolveRequestUser } from "@/lib/request-user";
import { enforceRateLimit } from "@/lib/rate-limit";
import { runQuoteEnrichmentSingleFlight } from "@/lib/quote-singleflight";
import {
  CASCADE_BUDGET_MS,
  YAHOO_SUMMARY_GRACE_MS,
  startCascadeBudget,
  withinBudget
} from "@/lib/quote-cascade-budget";
import { fetchYahooFinanceQuote } from "@/lib/yahoo-finance";
import { fetchFreshQuotesCascade } from "@/lib/quotes-cascade";

export const dynamic = "force-dynamic";

// On-demand single-symbol quote + fundamentals fetch for the console symbol drilldown
// (app/console/ui/symbol-drilldown.tsx) and the iOS SymbolInfoSheet. Used when the last
// market scan didn't know the symbol — or when the sheet needs a live refresh.
//
// Four layers, started together:
// 1. Durable store — last saved PE/EPS/div/52w (the "see / save / update" path).
// 2. Keyless Yahoo chart — identity + price/volume + 52-week range (already on meta).
// 3. Yahoo quoteSummary only — PE/EPS/div/beta without waiting for paid/scarce waves.
// 4. Full provider cascade — wins extra fields when it finishes in time.
//
// Deliberately does NOT compute a composite score or factor breakdown: those rank a
// symbol against the scan's candidate universe and would be fabricated for a symbol
// fetched outside a scan run.
//
// Yahoo chart + quoteSummary grace (YAHOO_SUMMARY_GRACE_MS) is the HTTP floor.  The 6s
// CASCADE_BUDGET_MS still aborts Wave C, but the response does not wait for it when the
// floor is already returnable.

const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

type EnrichmentOutcome =
  | { status: "ready"; data: SymbolEnrichment }
  | { status: "failed"; error: unknown };
type BudgetedOutcome = EnrichmentOutcome | { status: "timed-out" };

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("symbol") ?? "";
  const symbol = raw.trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) {
    return NextResponse.json({ error: "invalid or missing symbol" }, { status: 400 });
  }

  const { userId } = resolveRequestUser(request);
  // Generous per-user cap: read-only and single-symbol, but still fans out to several
  // data providers, so guard against a tight refresh loop hammering upstreams.
  const limited = enforceRateLimit(userId, "quote", { limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const budget = startCascadeBudget(CASCADE_BUDGET_MS);
  try {
    const richPromise: Promise<EnrichmentOutcome> = runQuoteEnrichmentSingleFlight(
      `${userId}:${symbol}`,
      async () =>
        (await getEnrichmentProvider(userId).enrich([symbol], { signal: budget.signal }))[symbol] ?? {}
    )
      .then((data) => ({ status: "ready" as const, data }))
      .catch((error) => ({ status: "failed" as const, error }));
    // Capture rich as soon as it settles so a fast cascade still merges, without holding
    // the HTTP response for the 6s Wave C budget when Yahoo already has a floor.
    let richPeek: EnrichmentOutcome | { status: "timed-out" } = { status: "timed-out" };
    void richPromise.then(
      (outcome) => {
        richPeek = outcome;
      },
      (error) => {
        richPeek = { status: "failed", error };
      }
    );
    const fastPromise: Promise<EnrichmentOutcome> = (async (): Promise<EnrichmentOutcome> => {
      const yahooQuotePromise = fetchYahooFinanceQuote(symbol).catch(() => undefined);
      const liveQuotePromise = (async () => {
        if (!userId) return undefined;
        try {
          const quotes = await fetchFreshQuotesCascade([symbol], userId, undefined, undefined, { signal: budget.signal });
          const q = quotes[symbol];
          return q && typeof q.price === "number" && q.price > 0 && !q.delayedFallback ? q : undefined;
        } catch {
          return undefined;
        }
      })();

      const [yahooQuote, liveQuote] = await Promise.all([yahooQuotePromise, liveQuotePromise]);
      if (liveQuote && typeof liveQuote.price === "number" && yahooQuote) {
        const livePrice = liveQuote.price;
        const base = fastQuoteEnrichment(yahooQuote);
        const intradayChangePct =
          yahooQuote.prevClose > 0
            ? Math.round(((livePrice - yahooQuote.prevClose) / yahooQuote.prevClose) * 10_000) / 100
            : base.intradayChangePct;
        return {
          status: "ready",
          data: {
            ...base,
            price: livePrice,
            ...(liveQuote.volume && liveQuote.volume > 0 ? { volume: liveQuote.volume } : {}),
            ...(intradayChangePct !== undefined ? { intradayChangePct } : {}),
            asOf: liveQuote.asOf ?? liveQuote.fetchedAt ?? base.asOf,
            sources: {
              ...base.sources,
              price: liveQuote.provider ?? "quotes-cascade",
              ...(liveQuote.asOf ? { asOf: liveQuote.provider ?? "quotes-cascade" } : {})
            }
          }
        };
      }
      if (yahooQuote) {
        return { status: "ready", data: fastQuoteEnrichment(yahooQuote) };
      }
      if (liveQuote) {
        return {
          status: "ready",
          data: {
            price: liveQuote.price,
            ...(liveQuote.volume && liveQuote.volume > 0 ? { volume: liveQuote.volume } : {}),
            asOf: liveQuote.asOf ?? liveQuote.fetchedAt,
            sources: {
              price: liveQuote.provider ?? "quotes-cascade",
              ...(liveQuote.asOf ? { asOf: liveQuote.provider ?? "quotes-cascade" } : {})
            }
          }
        };
      }
      return { status: "failed", error: new Error("no current quote returned") };
    })().catch((error) => ({ status: "failed" as const, error }));
    const yahooPromise: Promise<EnrichmentOutcome> = enrichYahooFinanceSymbol(symbol)
      .then((data) => ({ status: "ready" as const, data }))
      .catch((error) => ({ status: "failed" as const, error }));

    const [durable, fast] = await Promise.all([loadDurableQuoteSeed(symbol), fastPromise]);
    const yahoo = await withinBudget(yahooPromise, YAHOO_SUMMARY_GRACE_MS);
    // One extra tick so a fast cascade's then-handler can populate richPeek before we peek.
    await Promise.resolve();
    const fastData = fast.status === "ready" ? fast.data : {};
    const yahooData = yahoo.status === "ready" ? yahoo.data : {};
    const floorReady =
      fast.status === "ready"
      || enrichmentHasValues(durable)
      || (yahoo.status === "ready" && enrichmentHasValues(yahooData));

    let rich: BudgetedOutcome;
    if (floorReady) {
      rich = richPeek;
      budget.abort(new Error("yahoo floor ready"));
    } else {
      rich = await withinBudget(richPromise, CASCADE_BUDGET_MS, budget.signal);
    }
    const richData = rich.status === "ready" ? rich.data : {};
    const enrichment = composeOnDemandQuote([durable, fastData, yahooData, richData]);

    const hasLiveQuote =
      fast.status === "ready"
      || (yahoo.status === "ready" && enrichmentHasValues(yahooData))
      || (rich.status === "ready" && enrichmentHasValues(richData));
    // Yahoo (+ durable) floor is already returnable, or rich finished inside the budget — abort any
    // still-running cascade work so scarce providers do not keep spending after the response is fixed.
    if (hasLiveQuote || enrichmentHasValues(durable)) {
      budget.abort(new Error("yahoo floor ready"));
      persistOnDemandQuote(symbol, enrichment);
      return NextResponse.json({ symbol, ...enrichment });
    }

    const error = rich.status === "failed" ? rich.error : fast.error;
    const message = rich.status === "timed-out" && yahoo.status === "timed-out"
      ? "quote fetch timed out"
      : error instanceof Error
        ? error.message
        : "quote fetch failed";
    return NextResponse.json({ symbol, error: message }, { status: 502 });
  } finally {
    budget.clear();
  }
}
