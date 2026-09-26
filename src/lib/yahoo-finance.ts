import { dataSourceFetch } from "./data-source-fetch";

/** Call-site options. userId selects that user's data-source proxy (when set);
 *  without it the operator env / residential default applies. */
export interface YahooFetchOptions {
  userId?: string;
}

export interface YahooFinanceQuote {
  /** Exchange-reported issuer identity from chart metadata (longName/shortName). */
  companyName?: string;
  price: number;
  bid: number;
  ask: number;
  /** Previous regular-session close.  Undefined when Yahoo does not report one — never
   *  defaulted to the current price (that fabricates a 0% intraday change). */
  prevClose?: number;
  volume: number;
  /** ISO timestamp of the quote (from meta.regularMarketTime) — the real "as of", not a daily-bar date. */
  asOf?: string;
  /** true when bid/ask were SYNTHESIZED from price (the chart endpoint has no real quote spread) rather
   *  than reported by Yahoo. Consumers must not treat a synthetic ask as a real quoted ask (e.g. for
   *  ask-relative limit pricing) — it is only a rough placeholder derived from the last price.
   *  `syntheticSpread` stays true only when BOTH sides were derived (for back-compat); the side-specific
   *  flags below tell you exactly which side is synthetic, so the REAL side of a one-sided quote is
   *  preserved rather than being blanket-tagged synthetic. */
  syntheticSpread?: boolean;
  /** true when the BID was derived from price (Yahoo reported no real bid). */
  syntheticBid?: boolean;
  /** true when the ASK was derived from price (Yahoo reported no real ask). */
  syntheticAsk?: boolean;
  /**
   * Optional keyless fundamentals. Chart meta already carries the 52-week range
   * on the same payload as price/volume. PE/EPS/div/beta live on crumb-authed
   * quoteSummary (YahooFinanceEnrichmentProvider) — never fabricated here.
   */
  peRatio?: number;
  eps?: number;
  dividendYield?: number;
  beta?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  open?: number;
  high?: number;
  low?: number;
  change?: number;
  changePct?: number;
}

function optionalFinite(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function optionalPositive(value: unknown): number | undefined {
  const n = optionalFinite(value);
  return n !== undefined && n > 0 ? n : undefined;
}

/** Fields the keyless chart endpoint actually returns (today: 52-week range). */
export function yahooFundamentalsFromRecord(row: Record<string, unknown>): Pick<
  YahooFinanceQuote,
  "peRatio" | "eps" | "dividendYield" | "beta" | "fiftyTwoWeekHigh" | "fiftyTwoWeekLow"
> {
  const peRatio = optionalPositive(row.trailingPE ?? row.peRatio);
  const eps = optionalFinite(row.epsTrailingTwelveMonths ?? row.eps);
  const beta = optionalFinite(row.beta);
  const fiftyTwoWeekHigh = optionalPositive(row.fiftyTwoWeekHigh);
  const fiftyTwoWeekLow = optionalPositive(row.fiftyTwoWeekLow);
  return {
    ...(peRatio !== undefined ? { peRatio } : {}),
    ...(eps !== undefined ? { eps } : {}),
    ...(beta !== undefined ? { beta } : {}),
    ...(fiftyTwoWeekHigh !== undefined ? { fiftyTwoWeekHigh } : {}),
    ...(fiftyTwoWeekLow !== undefined ? { fiftyTwoWeekLow } : {})
  };
}

/** Map a chart `meta` object (plus optional indicator volume) into a quote. */
export function yahooQuoteFromChartMeta(
  meta: Record<string, unknown>,
  volumeHint?: number
): YahooFinanceQuote | undefined {
  const price = Number(meta.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) return undefined;
  const companyName = [meta.longName, meta.shortName]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim();
  // Sentry review: when Yahoo omits chartPreviousClose, fall back to undefined — NOT the
  // current price.  Falling back to price fabricates intradayChangePct ≈ 0% and hides the
  // real "previous close unknown" state from the quote route's fallback chain.
  const prevCloseRaw = meta.chartPreviousClose ? Number(meta.chartPreviousClose) : NaN;
  const prevClose = Number.isFinite(prevCloseRaw) && prevCloseRaw > 0 ? prevCloseRaw : undefined;
  const volume = Number(meta.regularMarketVolume ?? volumeHint ?? 0);
  const t = Number(meta.regularMarketTime);
  const asOf = Number.isFinite(t) && t > 0 ? new Date(t * 1000).toISOString() : undefined;
  return {
    ...(companyName ? { companyName } : {}),
    price,
    bid: price * 0.999,
    ask: price * 1.001,
    ...(prevClose !== undefined ? { prevClose } : {}),
    volume,
    asOf,
    syntheticBid: true,
    syntheticAsk: true,
    syntheticSpread: true,
    ...yahooFundamentalsFromRecord(meta)
  };
}

export async function fetchYahooFinanceQuote(symbol: string, options?: YahooFetchOptions): Promise<YahooFinanceQuote | undefined> {
  const clean = encodeURIComponent(symbol.toUpperCase());
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${clean}?interval=1d&range=1d`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await dataSourceFetch(url, { cache: "no-store", signal: controller.signal }, { userId: options?.userId });
    clearTimeout(timeout);
    if (!response.ok) return undefined;
    const payload = await response.json() as { chart?: { result?: Array<{ meta?: Record<string, unknown>, indicators?: { quote?: Array<{ volume?: unknown[] }> } }> } };
    const meta = payload?.chart?.result?.[0]?.meta;
    if (!meta) return undefined;
    const quote = payload?.chart?.result?.[0]?.indicators?.quote?.[0];
    const volumeHint = Number(quote?.volume?.[0] ?? 0);
    // Chart meta already includes fiftyTwoWeekHigh/Low on the same payload as
    // price/volume/name. The previous mapper dropped them, so the iOS/web
    // company sheet showed dashes for 52W even after a successful live fetch.
    return yahooQuoteFromChartMeta(meta, Number.isFinite(volumeHint) ? volumeHint : undefined);
  } catch {
    clearTimeout(timeout);
    return undefined;
  }
}

export async function fetchYahooFinanceQuotesBatch(
  symbols: string[],
  options?: { concurrency?: number; userId?: string }
): Promise<Map<string, YahooFinanceQuote>> {
  const result = new Map<string, YahooFinanceQuote>();
  if (symbols.length === 0) return result;

  const chunkSize = 50;
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += chunkSize) {
    chunks.push(symbols.slice(i, i + chunkSize));
  }
  // Default stays serial so existing quote-cascade callers do not suddenly fan out.
  // Empty-screener fallback passes a small concurrency so a 500-name universe can
  // still finish inside the interactive scan budget.
  const concurrency = Math.max(1, Math.min(options?.concurrency ?? 1, 4));
  for (let i = 0; i < chunks.length; i += concurrency) {
    const wave = chunks.slice(i, i + concurrency);
    const maps = await Promise.all(wave.map((chunk) => fetchYahooQuoteChunk(chunk, options?.userId)));
    for (const map of maps) {
      for (const [symbol, quote] of map) result.set(symbol, quote);
    }
  }

  return result;
}

async function fetchYahooQuoteChunk(chunk: string[], userId?: string): Promise<Map<string, YahooFinanceQuote>> {
  const result = new Map<string, YahooFinanceQuote>();
  const cleanSymbols = chunk.map((s) => encodeURIComponent(s.toUpperCase().trim())).join(",");
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${cleanSymbols}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await dataSourceFetch(url, { cache: "no-store", signal: controller.signal }, { userId });
    clearTimeout(timeout);
    if (!response.ok) return result;
    const payload = await response.json() as {
      quoteResponse?: {
        result?: Array<{
          symbol: string;
          regularMarketPrice?: number;
          bid?: number;
          ask?: number;
          regularMarketPreviousClose?: number;
          regularMarketOpen?: number;
          regularMarketDayHigh?: number;
          regularMarketDayLow?: number;
          regularMarketVolume?: number;
          regularMarketTime?: number;
          regularMarketChange?: number;
          regularMarketChangePercent?: number;
          shortName?: string;
          longName?: string;
          trailingPE?: number;
          fiftyTwoWeekHigh?: number;
          fiftyTwoWeekLow?: number;
        }>;
      };
    };

    const items = payload?.quoteResponse?.result;
    if (!items) return result;

    for (const item of items) {
      if (!item.symbol) continue;
      const price = Number(item.regularMarketPrice);
      if (!Number.isFinite(price) || price <= 0) continue;
      // Mirror yahooQuoteFromChartMeta: omit prevClose when Yahoo does not supply it.
      // Substituting `price` fabricates a 0% change and can falsely complete the cascade gate
      // (Codex P2 review on #3449).
      const prevClose = optionalPositive(item.regularMarketPreviousClose);
      const open = optionalPositive(item.regularMarketOpen);
      const high = optionalPositive(item.regularMarketDayHigh);
      const low = optionalPositive(item.regularMarketDayLow);
      const change = optionalFinite(item.regularMarketChange);
      const changePct = optionalFinite(item.regularMarketChangePercent);
      const companyName = [item.longName, item.shortName]
        .find((v): v is string => typeof v === "string" && v.trim().length > 0)
        ?.trim();
      const peRatio = optionalPositive(item.trailingPE);
      const fiftyTwoWeekHigh = optionalPositive(item.fiftyTwoWeekHigh);
      const fiftyTwoWeekLow = optionalPositive(item.fiftyTwoWeekLow);

      // Track each side independently so a one-sided quote keeps its REAL side (a real bid must not
      // be blanket-tagged synthetic just because the ask had to be derived, and vice versa).
      const syntheticBid = !(item.bid && item.bid > 0);
      const syntheticAsk = !(item.ask && item.ask > 0);
      const hasRealSpread = !syntheticBid && !syntheticAsk;
      const bid = syntheticBid ? price * 0.999 : Number(item.bid);
      const ask = syntheticAsk ? price * 1.001 : Number(item.ask);
      const volume = Number(item.regularMarketVolume ?? 0);
      const t = Number(item.regularMarketTime);
      const asOf = Number.isFinite(t) && t > 0 ? new Date(t * 1000).toISOString() : undefined;

      result.set(item.symbol.toUpperCase().trim(), {
        price,
        bid,
        ask,
        volume,
        asOf,
        ...(prevClose !== undefined ? { prevClose } : {}),
        ...(open !== undefined ? { open } : {}),
        ...(high !== undefined ? { high } : {}),
        ...(low !== undefined ? { low } : {}),
        ...(change !== undefined ? { change } : {}),
        ...(changePct !== undefined ? { changePct } : {}),
        ...(companyName ? { companyName } : {}),
        ...(peRatio !== undefined ? { peRatio } : {}),
        ...(fiftyTwoWeekHigh !== undefined ? { fiftyTwoWeekHigh } : {}),
        ...(fiftyTwoWeekLow !== undefined ? { fiftyTwoWeekLow } : {}),
        // Side-specific synthetic flags set EXPLICITLY (true AND false) so a consumer that falls back
        // to the coarse `syntheticSpread` when a side flag is absent (e.g. market.ts) never mislabels
        // a real side: a one-sided quote's real side now carries an explicit `false`, so the fallback
        // only fires for producers that genuinely don't set side flags. `syntheticSpread` stays true
        // only when BOTH sides were derived (back-compat for any coarse-only consumer).
        syntheticBid,
        syntheticAsk,
        ...(hasRealSpread ? {} : { syntheticSpread: true })
      });
    }
  } catch (err) {
    clearTimeout(timeout);
    console.error("[yahoo-finance] batch fetch failed for chunk:", chunk, err);
  }

  return result;
}
