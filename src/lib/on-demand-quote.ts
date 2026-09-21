import type { SymbolEnrichment } from "./data-providers";
import type { MarketQuoteSummary } from "./types";
import type { YahooFinanceQuote } from "./yahoo-finance";

/**
 * On-demand `/api/quote` merge helpers for the iOS/web company sheet.
 *
 * The sheet used to return only the Yahoo chart floor (price/volume/name)
 * whenever the 6s multi-provider cascade timed out — and it never read or
 * wrote `symbol_field_latest`, so previously saved PE/EPS/div/52w stayed
 * invisible and opening a ticker never updated the store.
 */

const CURRENT_FIELDS = ["price", "volume", "intradayChangePct", "asOf"] as const;

/** The keyless chart quote is the bounded floor for a valid ticker. */
export function fastQuoteEnrichment(quote: YahooFinanceQuote | undefined): SymbolEnrichment {
  if (!quote) return {};
  const yahooPrevClose = quote.prevClose;
  const intradayChangePct =
    typeof yahooPrevClose === "number" && yahooPrevClose > 0
      ? Math.round(((quote.price - yahooPrevClose) / yahooPrevClose) * 10_000) / 100
      : undefined;
  const fundamentals: SymbolEnrichment = {
    ...(quote.peRatio !== undefined ? { peRatio: quote.peRatio } : {}),
    ...(quote.eps !== undefined ? { eps: quote.eps } : {}),
    ...(quote.dividendYield !== undefined ? { dividendYield: quote.dividendYield } : {}),
    ...(quote.beta !== undefined ? { beta: quote.beta } : {}),
    ...(quote.fiftyTwoWeekHigh !== undefined ? { fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh } : {}),
    ...(quote.fiftyTwoWeekLow !== undefined ? { fiftyTwoWeekLow: quote.fiftyTwoWeekLow } : {})
  };
  const fundamentalSources = Object.fromEntries(
    (["peRatio", "eps", "dividendYield", "beta", "fiftyTwoWeekHigh", "fiftyTwoWeekLow"] as const)
      .filter((field) => fundamentals[field] !== undefined)
      .map((field) => [field, "yahoo-finance"])
  ) as SymbolEnrichment["sources"];
  return {
    ...(quote.companyName ? { companyName: quote.companyName } : {}),
    price: quote.price,
    ...(quote.volume > 0 ? { volume: quote.volume } : {}),
    ...(intradayChangePct !== undefined ? { intradayChangePct } : {}),
    ...(quote.asOf ? { asOf: quote.asOf } : {}),
    ...fundamentals,
    sources: {
      ...(quote.companyName ? { companyName: "yahoo-finance" } : {}),
      price: "yahoo-finance",
      ...(quote.volume > 0 ? { volume: "yahoo-finance" } : {}),
      ...(intradayChangePct !== undefined ? { intradayChangePct: "yahoo-finance" } : {}),
      ...(quote.asOf ? { asOf: "yahoo-finance" } : {}),
      ...fundamentalSources
    }
  };
}

/** Rich fundamentals fill holes, while the freshest timestamped price family wins. */
export function mergeOnDemandEnrichment(
  fast: SymbolEnrichment,
  rich: SymbolEnrichment
): SymbolEnrichment {
  const definedRich = Object.fromEntries(
    Object.entries(rich).filter(([key, value]) => key !== "sources" && value !== undefined)
  ) as SymbolEnrichment;
  const fastAsOf = Date.parse(fast.asOf ?? "");
  const richAsOf = Date.parse(rich.asOf ?? "");
  const useRichCurrent = rich.price !== undefined
    && (fast.price === undefined || (Number.isFinite(richAsOf) && (!Number.isFinite(fastAsOf) || richAsOf >= fastAsOf)));
  const current = useRichCurrent ? rich : fast;
  const currentFields = {
    ...(current.price !== undefined ? { price: current.price } : {}),
    ...(current.volume !== undefined ? { volume: current.volume } : {}),
    ...(current.intradayChangePct !== undefined ? { intradayChangePct: current.intradayChangePct } : {}),
    ...(current.asOf !== undefined ? { asOf: current.asOf } : {})
  };
  const currentSources = Object.fromEntries(
    CURRENT_FIELDS
      .filter((field) => current.sources?.[field] !== undefined)
      .map((field) => [field, current.sources?.[field]])
  ) as SymbolEnrichment["sources"];
  return {
    ...fast,
    ...definedRich,
    ...currentFields,
    sources: { ...fast.sources, ...rich.sources, ...currentSources }
  };
}

export function composeOnDemandQuote(
  layers: Array<SymbolEnrichment | undefined>
): SymbolEnrichment {
  return layers.reduce<SymbolEnrichment>(
    (merged, layer) => (layer ? mergeOnDemandEnrichment(merged, layer) : merged),
    {}
  );
}

export function enrichmentHasValues(enrichment: SymbolEnrichment | undefined): boolean {
  if (!enrichment) return false;
  return Object.keys(enrichment).some((key) => {
    if (key === "sources" || key === "fieldObservations" || key === "fieldDates") return false;
    return enrichment[key as keyof SymbolEnrichment] !== undefined;
  });
}

export async function loadDurableQuoteSeed(symbol: string): Promise<SymbolEnrichment> {
  try {
    const [{ marketQuoteSummariesFromFieldStore }, { persistedSlowEnrichment }] = await Promise.all([
      import("./db-fundamentals"),
      import("./market")
    ]);
    const store = marketQuoteSummariesFromFieldStore([symbol]);
    const quote = store[symbol];
    if (!quote) return {};
    return persistedSlowEnrichment(quote as MarketQuoteSummary);
  } catch {
    return {};
  }
}

export function persistOnDemandQuote(symbol: string, enrichment: SymbolEnrichment): void {
  void import("./db-fundamentals")
    .then((mod) => {
      if (
        typeof mod.recordsFromEnrichmentMap !== "function"
        || typeof mod.upsertSymbolFieldLatest !== "function"
      ) {
        return;
      }
      const records = mod.recordsFromEnrichmentMap({ [symbol]: enrichment });
      if (records.length > 0) mod.upsertSymbolFieldLatest(records);
    })
    .catch(() => {
      // Same fire-and-forget contract as CascadingEnrichmentProvider: a store
      // write must never fail the quote the user is looking at.
    });
}
