/**
 * Source × data-point capability matrix — machine-readable companion to
 * docs/source-capability-matrix.md.
 *
 * Use: sourcesFor("peRatio") | listDataPoints() | isStAllowed("fmp")
 *
 * Preference ranks are strategic (quota + role aware), not a single global
 * "best provider" score. Lower rank = try / accept earlier when healthy.
 */

export type SourceQuality = "primary" | "good" | "secondary" | "last_resort" | "avoid_for_quota";

export type QuotaPressure = "none" | "low" | "medium" | "high" | "scarce";

/** Stable ids for lookup. Scan scalars mirror EnrichmentSourcedField where applicable. */
export type DataPointId =
  | "price"
  | "bid"
  | "ask"
  | "intradayChangePct"
  | "volume"
  | "vwap"
  | "asOf"
  | "companyName"
  | "sector"
  | "industry"
  | "peRatio"
  | "pbRatio"
  | "eps"
  | "epsGrowth"
  | "dividendYield"
  | "beta"
  | "debtToEquity"
  | "returnOnEquity"
  | "returnOnAssets"
  | "revenueGrowth"
  | "fcfYield"
  | "freeCashFlowYield"
  | "grossProfitMargin"
  | "sharesOutstanding"
  | "fiftyTwoWeekHigh"
  | "fiftyTwoWeekLow"
  | "shortPercentOfFloat"
  | "institutionOwnershipPct"
  | "analystRating"
  | "analystScore"
  | "targetMean"
  | "targetHigh"
  | "targetLow"
  | "targetMedian"
  | "sentiment"
  | "headlines"
  | "insiderSentiment"
  | "daysToEarnings"
  | "senateTrades"
  | "nearTheMoneyIv"
  | "putCallRatio"
  | "earnings_transcript"
  | "sec_10k_10q"
  | "sec_8k"
  | "ohlcv_daily"
  | "vix"
  | "treasury_yields"
  | "cpi_labor"
  | "earnings_calendar"
  | "dividend_calendar"
  | "economic_calendar"
  | "congressional_trades"
  | "congress_analytics"
  | "short_interest_structured"
  | "news_stream";

export interface SourceOption {
  /** Provider / producer id as used in health logs or enrichment `name`. */
  sourceId: string;
  /** When true, Socratic-Trade product code may call this source for this field. */
  stAllowed: boolean;
  /**
   * Strategic preference within this data point only (1 = first choice when healthy).
   * Not comparable across different data points.
   */
  rank: number;
  quality: SourceQuality;
  quotaPressure: QuotaPressure;
  /** Human/agent notes: delay, quality, when to skip to preserve quota, entitlement traps. */
  notes: string[];
  /** Rough delay if known (e.g. "15m", "EOD", "filing"). */
  delay?: string;
  /** Module path hint for implementers. */
  implHint?: string;
}

export interface DataPointSpec {
  id: DataPointId;
  /** Short label for UI / docs. */
  label: string;
  /** Category for browsing. */
  category:
    | "quote"
    | "identity"
    | "fundamentals"
    | "risk"
    | "analyst"
    | "sentiment_events"
    | "options"
    | "narrative"
    | "history"
    | "macro"
    | "calendar"
    | "congress"
    | "news";
  description: string;
  sources: SourceOption[];
}

const FMP_RETIRED_NOTE =
  "ST retired 2026-08-04 — do not call. FMP remains CT latency / CT-owned only.";
const QUIVER_REMOVED_NOTE =
  "QuiverQuant disconnected from ST — use Congress.Trade for congressional data.";

function opt(
  sourceId: string,
  rank: number,
  quality: SourceQuality,
  quotaPressure: QuotaPressure,
  notes: string[],
  extra?: Partial<SourceOption>
): SourceOption {
  return {
    sourceId,
    stAllowed: extra?.stAllowed ?? true,
    rank,
    quality,
    quotaPressure,
    notes,
    delay: extra?.delay,
    implHint: extra?.implHint,
  };
}

/** Full catalog. Keep in sync with docs/source-capability-matrix.md. */
export const DATA_POINT_CATALOG: readonly DataPointSpec[] = [
  {
    id: "price",
    label: "Last price",
    category: "quote",
    description: "Most recent trade or delayed last for scan/decision UX.",
    sources: [
      opt("alpaca-snapshot", 1, "primary", "low", ["Prefer when connected — best for trading decisions."], {
        delay: "plan-dependent",
        implHint: "AlpacaSnapshotEnrichmentProvider",
      }),
      opt("robinhood-fundamentals", 2, "good", "low", ["Connected RH session; retail ToS."], { delay: "realtime-ish" }),
      opt("nasdaq-quote", 3, "good", "none", ["Keyless delayed quote; same host family as screener."], {
        delay: "15m",
        implHint: "NasdaqQuoteEnrichmentProvider",
      }),
      opt("yahoo-finance", 4, "good", "none", ["Keyless floor; can 429 on datacenter IPs."], {
        delay: "15m",
        implHint: "YahooFinanceEnrichmentProvider",
      }),
      opt("tiingo", 5, "good", "medium", ["IEX path on free tier; share quota with EOD history."], { delay: "IEX" }),
      opt("twelvedata", 6, "secondary", "medium", ["Credit-weighted free tier."]),
      opt("roic", 7, "avoid_for_quota", "medium", [
        "Can return price but prefer ROIC budget for unique fundamentals/transcripts.",
      ]),
      opt("yh-finance-apidojo", 8, "last_resort", "scarce", ["RapidAPI monthly — wave-C gap fill only."]),
      opt("real-time-finance-data", 9, "last_resort", "scarce", ["RapidAPI scarce."]),
      opt("mboum-finance", 10, "last_resort", "scarce", ["RapidAPI scarce SteadyAPI host."]),
      opt("yahoo-finance15", 11, "last_resort", "scarce", ["~100 req/month class — never for price alone if Yahoo filled."]),
      opt("fmp", 99, "last_resort", "high", [FMP_RETIRED_NOTE], { stAllowed: false }),
    ],
  },
  {
    id: "bid",
    label: "Bid",
    category: "quote",
    description: "Best bid for spread UX.",
    sources: [
      opt("alpaca-snapshot", 1, "primary", "low", ["Broker preferred."]),
      opt("yahoo-finance", 2, "secondary", "none", ["Often missing on delayed paths."]),
      opt("tiingo", 3, "secondary", "medium", ["IEX when entitled."]),
    ],
  },
  {
    id: "ask",
    label: "Ask",
    category: "quote",
    description: "Best ask for spread UX.",
    sources: [
      opt("alpaca-snapshot", 1, "primary", "low", ["Broker preferred."]),
      opt("yahoo-finance", 2, "secondary", "none", ["Often missing on delayed paths."]),
      opt("tiingo", 3, "secondary", "medium", ["IEX when entitled."]),
    ],
  },
  {
    id: "intradayChangePct",
    label: "Intraday change %",
    category: "quote",
    description: "Session percent change.",
    sources: [
      opt("yahoo-finance", 1, "primary", "none", ["Reliable free field."], { delay: "15m" }),
      opt("nasdaq-quote", 2, "good", "none", [], { delay: "15m" }),
      opt("alpaca-snapshot", 3, "primary", "low", ["Broker."]),
      opt("tiingo", 4, "good", "medium", []),
      opt("yh-finance-apidojo", 5, "last_resort", "scarce", ["Wave-C only."]),
      opt("real-time-finance-data", 6, "last_resort", "scarce", []),
    ],
  },
  {
    id: "volume",
    label: "Volume",
    category: "quote",
    description: "Session share volume.",
    sources: [
      opt("yahoo-finance", 1, "primary", "none", []),
      opt("nasdaq-quote", 2, "good", "none", []),
      opt("alpaca-snapshot", 3, "primary", "low", []),
      opt("finnhub", 4, "good", "low", ["Free 60/min — good secondary."]),
      opt("tiingo", 5, "good", "medium", []),
      opt("twelvedata", 6, "secondary", "medium", []),
      opt("yh-finance-apidojo", 7, "last_resort", "scarce", []),
    ],
  },
  {
    id: "vwap",
    label: "VWAP",
    category: "quote",
    description: "Session volume-weighted average price.",
    sources: [
      opt("alpaca-snapshot", 1, "primary", "low", ["dailyBar.vw — do not invent from delayed OHLC."]),
    ],
  },
  {
    id: "asOf",
    label: "Quote / fact as-of time",
    category: "quote",
    description: "Economic or quote timestamp for the value.",
    sources: [
      opt("any-live-quote-path", 1, "primary", "none", [
        "Every quote provider must stamp; never fabricate.",
        "Pair with fetchedAt for provenance.",
      ]),
    ],
  },
  {
    id: "companyName",
    label: "Company name",
    category: "identity",
    description: "Display name.",
    sources: [
      opt("yahoo-finance", 1, "primary", "none", ["Cache hard once filled."]),
      opt("nasdaq-quote", 2, "good", "none", []),
      opt("finnhub", 3, "good", "low", ["Skip if free path already filled (quota)."]),
      opt("tiingo", 4, "good", "medium", []),
      opt("roic", 5, "avoid_for_quota", "medium", ["Avoid spending ROIC solely for name."]),
      opt("sec-xbrl", 6, "good", "none", ["Filing entity name."]),
      opt("filingapi", 7, "last_resort", "scarce", ["quotaScarce."]),
      opt("yh-finance-apidojo", 8, "last_resort", "scarce", []),
    ],
  },
  {
    id: "sector",
    label: "Sector",
    category: "identity",
    description: "Sector label (vendor taxonomies differ).",
    sources: [
      opt("yahoo-finance", 1, "primary", "none", ["Labels not identical across vendors."]),
      opt("finnhub", 2, "good", "low", []),
      opt("roic", 3, "good", "medium", []),
      opt("twelvedata", 4, "secondary", "medium", []),
      opt("filingapi", 5, "last_resort", "scarce", []),
      opt("mboum-finance", 6, "last_resort", "scarce", ["SteadyAPI modules."]),
      opt("fmp", 99, "last_resort", "high", [FMP_RETIRED_NOTE], { stAllowed: false }),
    ],
  },
  {
    id: "industry",
    label: "Industry",
    category: "identity",
    description: "Industry label.",
    sources: [
      opt("yahoo-finance", 1, "primary", "none", []),
      opt("finnhub", 2, "good", "low", []),
      opt("roic", 3, "good", "medium", []),
      opt("twelvedata", 4, "secondary", "medium", []),
      opt("filingapi", 5, "last_resort", "scarce", []),
    ],
  },
  {
    id: "peRatio",
    label: "P/E ratio",
    category: "fundamentals",
    description: "Trailing P/E; n/a when EPS ≤ 0.",
    sources: [
      opt("yahoo-finance", 1, "primary", "none", ["Fine for scan; n/a on negative earnings."]),
      opt("finnhub", 2, "good", "low", ["Free metrics when entitled."]),
      opt("roic", 3, "good", "medium", ["Deeper plan; skip if Yahoo already filled unless distrusting quality."]),
      opt("twelvedata", 4, "avoid_for_quota", "high", ["Fundamentals expensive in credits — avoid for PE alone."]),
      opt("sec-xbrl", 5, "good", "none", ["Derive from filings when strategy needs restatement-safe inputs."]),
      opt("filingapi", 6, "last_resort", "scarce", []),
      opt("yh-finance-apidojo", 7, "last_resort", "scarce", ["Wave-C only if still empty."]),
      opt("seeking-alpha-rapidapi", 8, "last_resort", "scarce", []),
      opt("fmp", 99, "last_resort", "high", [FMP_RETIRED_NOTE, "Was ratios-ttm."], { stAllowed: false }),
    ],
  },
  {
    id: "pbRatio",
    label: "P/B ratio",
    category: "fundamentals",
    description: "Price to book.",
    sources: [
      opt("yahoo-finance", 1, "primary", "none", []),
      opt("roic", 2, "good", "medium", []),
      opt("filingapi", 3, "secondary", "scarce", []),
      opt("yh-finance-apidojo", 4, "last_resort", "scarce", []),
      opt("fmp", 99, "last_resort", "high", [FMP_RETIRED_NOTE], { stAllowed: false }),
    ],
  },
  {
    id: "eps",
    label: "EPS (TTM / period)",
    category: "fundamentals",
    description: "Earnings per share.",
    sources: [
      opt("yahoo-finance", 1, "primary", "none", ["Convenience TTM."]),
      opt("sec-xbrl", 2, "primary", "none", ["Filing truth — prefer when numbers drive hard gates."], {
        delay: "filing",
      }),
      opt("finnhub", 3, "good", "low", []),
      opt("roic", 4, "good", "medium", []),
      opt("twelvedata", 5, "secondary", "high", ["Credit-heavy."]),
      opt("yh-finance-apidojo", 6, "last_resort", "scarce", []),
    ],
  },
  {
    id: "epsGrowth",
    label: "EPS growth",
    category: "fundamentals",
    description: "YoY or TTM growth rate.",
    sources: [
      opt("yahoo-finance", 1, "good", "none", ["Often sparse."]),
      opt("roic", 2, "primary", "medium", ["Better coverage on paid plan."]),
      opt("twelvedata", 3, "secondary", "high", []),
      opt("sec-xbrl", 4, "good", "none", ["Derive across periods."], { delay: "filing" }),
    ],
  },
  {
    id: "dividendYield",
    label: "Dividend yield %",
    category: "fundamentals",
    description: "Annualized dividend yield.",
    sources: [
      opt("yahoo-finance", 1, "primary", "none", []),
      opt("finnhub", 2, "good", "low", []),
      opt("roic", 3, "good", "medium", []),
      opt("tiingo", 4, "secondary", "medium", ["Meta on daily endpoint."]),
      opt("filingapi", 5, "last_resort", "scarce", []),
      opt("fmp", 99, "last_resort", "high", [FMP_RETIRED_NOTE], { stAllowed: false }),
    ],
  },
  {
    id: "beta",
    label: "Beta",
    category: "risk",
    description: "Market beta (model varies by vendor).",
    sources: [
      opt("yahoo-finance", 1, "primary", "none", ["Models differ across vendors."]),
      opt("twelvedata", 2, "secondary", "medium", []),
      opt("yh-finance-apidojo", 3, "last_resort", "scarce", []),
      opt("fmp", 99, "last_resort", "high", [FMP_RETIRED_NOTE], { stAllowed: false }),
    ],
  },
  {
    id: "debtToEquity",
    label: "Debt / equity",
    category: "fundamentals",
    description: "Leverage ratio.",
    sources: [
      opt("yahoo-finance", 1, "primary", "none", []),
      opt("sec-xbrl", 2, "primary", "none", ["Prefer for capital-structure decisions."], { delay: "filing" }),
      opt("roic", 3, "good", "medium", []),
      opt("twelvedata", 4, "secondary", "high", []),
      opt("fmp", 99, "last_resort", "high", [FMP_RETIRED_NOTE], { stAllowed: false }),
    ],
  },
  {
    id: "returnOnEquity",
    label: "ROE",
    category: "fundamentals",
    description: "Return on equity (prefer provider % over crude rebuild).",
    sources: [
      opt("roic", 1, "primary", "medium", ["Strong on individual plan."]),
      opt("yahoo-finance", 2, "good", "none", ["When present."]),
      opt("filingapi", 3, "secondary", "scarce", []),
      opt("sec-xbrl", 4, "good", "none", ["Derive."], { delay: "filing" }),
      opt("fmp", 99, "last_resort", "high", [FMP_RETIRED_NOTE, "ratios-ttm."], { stAllowed: false }),
    ],
  },
  {
    id: "returnOnAssets",
    label: "ROA",
    category: "fundamentals",
    description: "Return on assets.",
    sources: [
      opt("roic", 1, "primary", "medium", []),
      opt("sec-xbrl", 2, "good", "none", [], { delay: "filing" }),
      opt("fmp", 99, "last_resort", "high", [FMP_RETIRED_NOTE], { stAllowed: false }),
    ],
  },
  {
    id: "revenueGrowth",
    label: "Revenue growth",
    category: "fundamentals",
    description: "Top-line growth rate.",
    sources: [
      opt("yahoo-finance", 1, "good", "none", []),
      opt("roic", 2, "primary", "medium", []),
      opt("twelvedata", 3, "secondary", "high", []),
      opt("sec-xbrl", 4, "good", "none", [], { delay: "filing" }),
    ],
  },
  {
    id: "fcfYield",
    label: "FCF yield",
    category: "fundamentals",
    description: "Free cash flow yield (legacy field name).",
    sources: [
      opt("yahoo-finance", 1, "good", "none", ["Often derived."]),
      opt("roic", 2, "primary", "medium", []),
      opt("fmp", 99, "last_resort", "high", [FMP_RETIRED_NOTE], { stAllowed: false }),
    ],
  },
  {
    id: "freeCashFlowYield",
    label: "Free cash flow yield",
    category: "fundamentals",
    description: "Alias/sibling of fcfYield depending on provider.",
    sources: [
      opt("yahoo-finance", 1, "good", "none", ["Treat as same economic idea when merging with fcfYield."]),
      opt("roic", 2, "primary", "medium", []),
    ],
  },
  {
    id: "grossProfitMargin",
    label: "Gross profit margin",
    category: "fundamentals",
    description: "Gross margin %.",
    sources: [
      opt("roic", 1, "primary", "medium", []),
      opt("twelvedata", 2, "secondary", "high", []),
      opt("sec-xbrl", 3, "good", "none", [], { delay: "filing" }),
      opt("fmp", 99, "last_resort", "high", [FMP_RETIRED_NOTE], { stAllowed: false }),
    ],
  },
  {
    id: "sharesOutstanding",
    label: "Shares outstanding",
    category: "fundamentals",
    description: "Share count (watch diluted vs basic).",
    sources: [
      opt("yahoo-finance", 1, "primary", "none", ["Confirm diluted vs basic if strategy cares."]),
      opt("sec-xbrl", 2, "primary", "none", [], { delay: "filing" }),
      opt("finnhub", 3, "good", "low", []),
    ],
  },
  {
    id: "fiftyTwoWeekHigh",
    label: "52-week high",
    category: "risk",
    description: "Trailing year high.",
    sources: [
      opt("yahoo-finance", 1, "primary", "none", []),
      opt("mboum-finance", 2, "secondary", "scarce", ["SteadyAPI — scarce."]),
      opt("yahoo-finance15", 3, "last_resort", "scarce", []),
      opt("twelvedata-rapidapi", 4, "last_resort", "scarce", [
        "suppliesFields intentionally limited to 52w — only when still empty.",
      ]),
      opt("yh-finance-apidojo", 5, "last_resort", "scarce", []),
      opt("fmp", 99, "last_resort", "high", [FMP_RETIRED_NOTE], { stAllowed: false }),
    ],
  },
  {
    id: "fiftyTwoWeekLow",
    label: "52-week low",
    category: "risk",
    description: "Trailing year low.",
    sources: [
      opt("yahoo-finance", 1, "primary", "none", []),
      opt("mboum-finance", 2, "secondary", "scarce", []),
      opt("twelvedata-rapidapi", 3, "last_resort", "scarce", ["Gated to 52w gaps only."]),
      opt("yh-finance-apidojo", 4, "last_resort", "scarce", []),
    ],
  },
  {
    id: "shortPercentOfFloat",
    label: "Short % of float",
    category: "risk",
    description: "Short interest as % of free float.",
    sources: [
      opt("yahoo-finance", 1, "primary", "none", ["Cascade primary via takeScalar."], { delay: "stale-ish" }),
      opt("massive", 2, "good", "medium", [
        "Secondary for disagreement bulletin vs Yahoo.",
        "Starter plan product — not free.",
      ], { delay: "FINRA cycle", implHint: "MassiveEnrichmentProvider" }),
      opt("finra-short", 3, "primary", "none", ["Origin data; 2×/month — do not expect daily refresh."], {
        delay: "bi-monthly",
      }),
      opt("roic", 4, "secondary", "medium", ["When present."]),
      opt("fmp", 99, "last_resort", "high", [FMP_RETIRED_NOTE, "FMP has no true short-interest endpoint historically."], {
        stAllowed: false,
      }),
    ],
  },
  {
    id: "institutionOwnershipPct",
    label: "Institutional ownership %",
    category: "risk",
    description: "Percent held by institutions.",
    sources: [
      opt("yahoo-finance", 1, "primary", "none", ["13F-lagged."], { delay: "quarterly" }),
      opt("roic", 2, "good", "medium", []),
      opt("massive", 3, "secondary", "medium", []),
    ],
  },
  {
    id: "analystRating",
    label: "Analyst rating (blended)",
    category: "analyst",
    description: "Consensus label; per-provider votes in analystBySource.",
    sources: [
      opt("finnhub", 1, "primary", "low", ["Free recommendations — preserve for this + news."]),
      opt("yahoo-finance", 2, "good", "none", ["recommendationMean-style."]),
      opt("filingapi", 3, "secondary", "scarce", []),
      opt("yh-finance-apidojo", 4, "last_resort", "scarce", []),
      opt("fmp", 99, "last_resort", "high", [FMP_RETIRED_NOTE, "grades-consensus."], { stAllowed: false }),
    ],
  },
  {
    id: "analystScore",
    label: "Analyst score 0–100",
    category: "analyst",
    description: "Blended numeric score from cascade.",
    sources: [
      opt("cascade-blend", 1, "primary", "none", [
        "Derived from analystBySource votes — not a single vendor field.",
      ]),
    ],
  },
  {
    id: "targetMean",
    label: "Analyst target mean",
    category: "analyst",
    description: "Mean price target.",
    sources: [
      opt("yh-finance-apidojo", 1, "secondary", "scarce", [
        "One of few remaining ST paths after FMP retirement.",
        "Expect sparse coverage — preserve RapidAPI for holdings gaps.",
      ]),
      opt("fmp", 99, "last_resort", "high", [FMP_RETIRED_NOTE, "price-target-consensus required Ultimate-class entitlement."], {
        stAllowed: false,
      }),
    ],
  },
  {
    id: "targetHigh",
    label: "Analyst target high",
    category: "analyst",
    description: "High price target.",
    sources: [
      opt("yh-finance-apidojo", 1, "secondary", "scarce", []),
      opt("fmp", 99, "last_resort", "high", [FMP_RETIRED_NOTE], { stAllowed: false }),
    ],
  },
  {
    id: "targetLow",
    label: "Analyst target low",
    category: "analyst",
    description: "Low price target.",
    sources: [
      opt("yh-finance-apidojo", 1, "secondary", "scarce", []),
      opt("fmp", 99, "last_resort", "high", [FMP_RETIRED_NOTE], { stAllowed: false }),
    ],
  },
  {
    id: "targetMedian",
    label: "Analyst target median",
    category: "analyst",
    description: "Median price target.",
    sources: [
      opt("fmp", 99, "last_resort", "high", [FMP_RETIRED_NOTE], { stAllowed: false }),
    ],
  },
  {
    id: "sentiment",
    label: "News sentiment 0–100",
    category: "sentiment_events",
    description: "News tone; 50 = neutral.",
    sources: [
      opt("finnhub", 1, "primary", "low", ["Free workhorse for company news sentiment."]),
      opt("alpaca-news", 2, "good", "low", ["Broker key."]),
      opt("marketaux", 3, "secondary", "scarce", ["~100/day free."]),
      opt("alpha-vantage", 4, "avoid_for_quota", "scarce", [
        "NEWS_SENTIMENT burns global 25/day per IP — prefer calendars if AV budget is tight.",
      ]),
      opt("real-time-finance-data", 5, "last_resort", "scarce", []),
    ],
  },
  {
    id: "headlines",
    label: "Headlines",
    category: "sentiment_events",
    description: "Recent headline strings.",
    sources: [
      opt("finnhub", 1, "primary", "low", ["Stamp first-seen for evidence age."]),
      opt("alpaca-news", 2, "good", "low", []),
      opt("marketaux", 3, "secondary", "scarce", []),
      opt("alpha-vantage", 4, "avoid_for_quota", "scarce", ["Avoid burning 25/day."]),
    ],
  },
  {
    id: "insiderSentiment",
    label: "Insider sentiment",
    category: "sentiment_events",
    description: "Recent Form-4-ish buy/sell tilt.",
    sources: [
      opt("finnhub", 1, "primary", "low", ["Free insider-transactions — prefer first."]),
      opt("sec-form4", 2, "primary", "none", ["EDGAR origin; more effort."], { delay: "filing" }),
      opt("filingapi", 3, "secondary", "scarce", []),
      opt("insiders-rapidapi", 4, "last_resort", "scarce", [
        "quotaScarce — only when free paths left field empty.",
      ]),
      opt("fmp", 99, "last_resort", "high", [FMP_RETIRED_NOTE], { stAllowed: false }),
    ],
  },
  {
    id: "daysToEarnings",
    label: "Days to next earnings",
    category: "sentiment_events",
    description: "Trading days until next report; never fabricate 0.",
    sources: [
      opt("yahoo-finance", 1, "primary", "none", ["calendarEvents."]),
      opt("nasdaq-calendar", 2, "primary", "none", ["Market-wide free calendar host."], {
        implHint: "nasdaq-calendar-provider",
      }),
      opt("finnhub", 3, "good", "low", ["/calendar/earnings."]),
      opt("alpha-vantage", 4, "secondary", "scarce", [
        "EARNINGS_CALENDAR is a good AV use of the 25/day — better than quotes.",
      ]),
      opt("filingapi", 5, "last_resort", "scarce", []),
      opt("roic", 6, "secondary", "medium", []),
    ],
  },
  {
    id: "senateTrades",
    label: "Congressional trade signal",
    category: "congress",
    description: "Congressional activity count/signal on the symbol.",
    sources: [
      opt("congress.trade", 1, "primary", "low", [
        "Only system of record for ST.",
        "Default CONGRESS_TRADE_AS_CONGRESS_SOURCE on.",
      ], { implHint: "CongressTradeEnrichmentProvider / web-sources/congress" }),
      opt("quiverquant", 99, "last_resort", "high", [QUIVER_REMOVED_NOTE], { stAllowed: false }),
      opt("fmp", 99, "last_resort", "high", [FMP_RETIRED_NOTE, "house-latest/senate-latest were wrong ownership."], {
        stAllowed: false,
      }),
    ],
  },
  {
    id: "nearTheMoneyIv",
    label: "Near-the-money IV",
    category: "options",
    description: "Approx NTM implied vol %.",
    sources: [
      opt("robinhood-options", 1, "primary", "low", ["Opt-in RH chain enrichment."]),
      opt("alpaca-options", 2, "secondary", "low", ["Indicative free feed; greeks not always present."]),
    ],
  },
  {
    id: "putCallRatio",
    label: "Put/call OI ratio",
    category: "options",
    description: "Near-money put/call open interest ratio.",
    sources: [
      opt("robinhood-options", 1, "primary", "low", ["Opt-in."]),
      opt("alpaca-options", 2, "secondary", "low", ["Indicative."]),
    ],
  },
  {
    id: "earnings_transcript",
    label: "Earnings call transcript (full text)",
    category: "narrative",
    description: "Full call transcript for RAG doc_type earnings-transcript.",
    sources: [
      opt("roic-earnings-transcript", 1, "primary", "medium", [
        "Owner individual plan — best ST full-text path when key present.",
        "API: GET /v3.0.0/earnings-calls?identifier= then GET /v3.0.0/earnings-calls/{EXCHANGE:SYM}?fiscal_year=&fiscal_quarter=.",
        "List-first, skip-if-stored, speaker-section chunks, earnings-summary digest.",
        "Universe = holdings then watchlist then policy indices then RAG manifest.  Individual = 20 quarters.",
        "Retrieval gated by ROIC key + ROIC_TRANSCRIPTS_DISABLED, independent of FMP rights.",
      ], { implHint: "src/lib/web-sources/roic-transcripts.ts" }),
      opt("earningscalls", 2, "good", "scarce", [
        "~200 req/month free RapidAPI class.",
        "Free tier may return 250-char PREVIEW only — entitlement probe + preview guard refuse poison cache.",
        "Smart picker: holdings > recency > scan rank > watchlist.",
        "Fetch-once-forever cache; negative TTL for not-yet-available.",
      ], {
        implHint: "src/lib/earningscalls-transcripts.ts",
        delay: "post-call publication lag",
      }),
      opt("fmp-earnings-transcript", 99, "last_resort", "high", [
        FMP_RETIRED_NOTE,
        "Required Ultimate + storage rights flags; 402 common on Starter.",
        "Default-off producer retained for rights tooling only.",
      ], { stAllowed: false, implHint: "src/lib/web-sources/fmp-transcripts.ts" }),
      opt("seeking-alpha-rapidapi", 10, "last_resort", "scarce", [
        "Not a full transcript SoR — enrichment articles only.",
      ]),
    ],
  },
  {
    id: "sec_10k_10q",
    label: "10-K / 10-Q body",
    category: "narrative",
    description: "Periodic filing text for RAG.",
    sources: [
      opt("sec-edgar", 1, "primary", "none", [
        "Only origin. Budget SEC_FILING_RAG_MAX_PER_RUN / TTL.",
      ], { delay: "filing", implHint: "web-sources/sec-filings + rag ingest" }),
    ],
  },
  {
    id: "sec_8k",
    label: "8-K material event",
    category: "narrative",
    description: "Current report events / optional full body.",
    sources: [
      opt("sec-8k", 1, "primary", "none", ["Default ON producer; full body flag optional."], {
        implHint: "web-sources/sec8k.ts",
      }),
    ],
  },
  {
    id: "ohlcv_daily",
    label: "Daily OHLCV history",
    category: "history",
    description: "Adjusted daily bars for backtest / technicals.",
    sources: [
      opt("massive", 1, "primary", "medium", ["Starter history depth; paced REST."], {
        implHint: "history.ts fetchMassive",
      }),
      opt("tradier", 2, "primary", "low", ["When broker connected; live vs sandbox base."]),
      opt("tiingo", 3, "primary", "medium", [
        "Best free adjusted multi-decade EOD.",
        "Shares RATE_QUOTAS with TiingoEnrichmentProvider — do not blow enrichment+history together.",
      ]),
      opt("yahoo-finance", 4, "good", "none", ["Keyless chart failover."]),
      opt("marketstack", 5, "last_resort", "scarce", ["~100/mo free — last resort."]),
      opt("congress.trade-prices", 6, "secondary", "low", ["Opt-in only; avoid Massive echo waste."]),
      opt("stooq", 99, "last_resort", "none", ["DEAD — PoW/CAPTCHA wall; do not integrate."], {
        stAllowed: false,
      }),
    ],
  },
  {
    id: "vix",
    label: "VIX level",
    category: "macro",
    description: "Cboe volatility index for regime.",
    sources: [
      opt("vix-cboe", 1, "primary", "none", ["CDN; DC-friendly — prefer first."], {
        implHint: "macro.ts",
      }),
      opt("vix-yahoo", 2, "secondary", "none", ["Falls back when Cboe fails; 429 risk on DC."]),
    ],
  },
  {
    id: "treasury_yields",
    label: "Treasury yields / curve",
    category: "macro",
    description: "Par yields / slope for regime.",
    sources: [
      opt("treasury-gov-xml", 1, "primary", "none", ["Keyless public domain."]),
      opt("fred", 2, "good", "low", ["DGS* series — NO durable DB cache (FRED ToU); memory only."]),
    ],
  },
  {
    id: "cpi_labor",
    label: "CPI / labor prints",
    category: "macro",
    description: "Inflation and employment series.",
    sources: [
      opt("bls", 1, "primary", "low", ["Cache-friendly public domain."]),
      opt("fred", 2, "good", "low", ["No durable DB cache."]),
    ],
  },
  {
    id: "earnings_calendar",
    label: "Earnings calendar (market-wide)",
    category: "calendar",
    description: "Upcoming earnings dates across symbols.",
    sources: [
      opt("nasdaq-calendar", 1, "primary", "none", ["Keyless; ToS caution accepted for convenience."]),
      opt("finnhub", 2, "good", "low", ["/calendar/earnings ~1mo forward."]),
      opt("alpha-vantage", 3, "good", "scarce", ["Best use of 25/day — horizon=3month batch."]),
      opt("yahoo-finance", 4, "secondary", "none", ["Per-symbol, not market-wide bulk."]),
    ],
  },
  {
    id: "dividend_calendar",
    label: "Dividend / split / IPO calendar",
    category: "calendar",
    description: "Corp actions calendars.",
    sources: [
      opt("nasdaq-calendar", 1, "primary", "none", []),
      opt("alpha-vantage", 2, "good", "scarce", ["DIVIDENDS / SPLITS / IPO_CALENDAR — preferred AV spend."]),
      opt("tiingo", 3, "secondary", "medium", ["Via history corporate actions when entitled."]),
    ],
  },
  {
    id: "economic_calendar",
    label: "Macro economic calendar",
    category: "calendar",
    description: "FOMC, CPI release schedule, etc.",
    sources: [
      opt("fmp", 99, "last_resort", "high", [
        FMP_RETIRED_NOTE,
        "ST economic calendar empty until non-FMP source wired.",
      ], { stAllowed: false }),
    ],
  },
  {
    id: "congressional_trades",
    label: "Congressional disclosures (structured)",
    category: "congress",
    description: "House/Senate STOCK Act trades.",
    sources: [
      opt("congress.trade", 1, "primary", "low", ["SoR — never scrape Quiver/FMP on ST."]),
      opt("quiverquant", 99, "last_resort", "high", [QUIVER_REMOVED_NOTE], { stAllowed: false }),
    ],
  },
  {
    id: "congress_analytics",
    label: "Congress analytics (skill/clusters)",
    category: "congress",
    description: "Member skill, clusters, conviction scores.",
    sources: [
      opt("congress.trade", 1, "primary", "low", ["CONGRESS_ANALYTICS_ENABLED default ON."]),
    ],
  },
  {
    id: "short_interest_structured",
    label: "Short interest (structured series)",
    category: "risk",
    description: "FINRA-cycle short interest history.",
    sources: [
      opt("finra-short", 1, "primary", "none", ["Origin; bi-monthly."], { delay: "bi-monthly" }),
      opt("massive", 2, "good", "medium", ["Convenience API over FINRA."]),
    ],
  },
  {
    id: "news_stream",
    label: "Company / market news stream",
    category: "news",
    description: "Ongoing news for sentiment and RAG.",
    sources: [
      opt("finnhub", 1, "primary", "low", ["Free continuous."]),
      opt("alpaca-news", 2, "good", "low", []),
      opt("marketaux", 3, "secondary", "scarce", ["100/day."]),
      opt("fintechstudios", 4, "secondary", "high", ["Paid niche."]),
      opt("tiingo-news", 5, "secondary", "high", ["403 on free Tiingo — Power only."]),
      opt("alpha-vantage", 6, "avoid_for_quota", "scarce", ["Avoid — burns 25/day."]),
    ],
  },
] as const;

const BY_ID: Map<DataPointId, DataPointSpec> = new Map(
  DATA_POINT_CATALOG.map((d) => [d.id, d as DataPointSpec])
);

/** All data point ids. */
export function listDataPoints(): DataPointId[] {
  return DATA_POINT_CATALOG.map((d) => d.id);
}

/** Spec for one data point, or undefined if unknown. */
export function getDataPoint(id: DataPointId | string): DataPointSpec | undefined {
  return BY_ID.get(id as DataPointId);
}

/**
 * Sources that can supply `dataPoint`, sorted by strategic rank ascending.
 * By default only ST-allowed sources; pass `{ includeForbidden: true }` for archaeology.
 */
export function sourcesFor(
  dataPoint: DataPointId | string,
  options?: { includeForbidden?: boolean }
): SourceOption[] {
  const spec = getDataPoint(dataPoint);
  if (!spec) return [];
  const rows = options?.includeForbidden ? spec.sources : spec.sources.filter((s) => s.stAllowed);
  return [...rows].sort((a, b) => a.rank - b.rank);
}

/** True if ST product code may call this source id at all (any field). */
export function isStAllowedSource(sourceId: string): boolean {
  const retired = new Set(["fmp", "fmp-rapidapi", "fmp-earnings-transcript", "quiverquant", "unusual_whales", "stooq"]);
  if (retired.has(sourceId)) return false;
  // If it appears anywhere as stAllowed false only, still false
  let saw = false;
  let anyAllowed = false;
  for (const d of DATA_POINT_CATALOG) {
    for (const s of d.sources) {
      if (s.sourceId === sourceId) {
        saw = true;
        if (s.stAllowed) anyAllowed = true;
      }
    }
  }
  if (!saw) return true; // unknown source — don't hard-block
  return anyAllowed;
}

/** Data points a source can contribute to (ST-allowed only by default). */
export function dataPointsForSource(
  sourceId: string,
  options?: { includeForbidden?: boolean }
): DataPointId[] {
  const out: DataPointId[] = [];
  for (const d of DATA_POINT_CATALOG) {
    const hit = d.sources.some(
      (s) => s.sourceId === sourceId && (options?.includeForbidden || s.stAllowed)
    );
    if (hit) out.push(d.id);
  }
  return out;
}

/** Markdown-ish one-liner for agent prompts. */
export function describeSourcesFor(dataPoint: DataPointId | string): string {
  const spec = getDataPoint(dataPoint);
  if (!spec) return `Unknown data point: ${dataPoint}`;
  const lines = sourcesFor(dataPoint).map(
    (s) =>
      `${s.rank}. ${s.sourceId} [${s.quality}/${s.quotaPressure}]${s.delay ? ` delay=${s.delay}` : ""} — ${s.notes.join(" ")}`
  );
  return `${spec.label} (${spec.id}):\n${lines.join("\n")}`;
}
