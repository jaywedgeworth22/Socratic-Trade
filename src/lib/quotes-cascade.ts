import {
  getPolicy,
  getConnectedAccount,
  getActiveConnectedAccount,
  listConnectedAccounts,
  resolveAlpacaMarketData,
  resolveApiKeyWithSource
} from "./db";
import { getBrokerGateway } from "./broker";
import { DEFAULT_POLICY } from "./defaults";
import { AlpacaSnapshotEnrichmentProvider, apiKeyFingerprint, fetchWithRetry } from "./data-providers";
import { admitProviderRequests, withProviderLimit } from "./provider-rate-limit";
import { fetchYahooFinanceQuote, fetchYahooFinanceQuotesBatch } from "./yahoo-finance";
import { normalizeSymbol } from "./money";
import {
  isDelayedYahooFallbackQuote,
  isYahooFallbackProvider
} from "./quote-delayed-fallback";
import { upsertSymbolFieldLatest, type SymbolFieldLatestRecord } from "./db-fundamentals";
import type { BrokerQuote, ConnectedAccount, QuoteFieldProvenance, TradingPolicy } from "./types";

/**
 * Helper to extract the first valid number from fields on an object.
 */
function firstNumber(obj: any, keys: string[]): number | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === "number" && Number.isFinite(val)) return val;
    if (typeof val === "string") {
      const parsed = parseFloat(val);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/**
 * Quote fields whose per-field provenance is tracked through
 * `mergeBrokerQuoteFields` (Codex P1 review on #3449).
 */
const PROVENANCE_TRACKED_FIELDS = [
  "price",
  "bid",
  "ask",
  "bidSize",
  "askSize",
  "volume",
  "prevClose",
  "open",
  "high",
  "low",
  "close",
  "vwap",
  "change",
  "changePct",
  "netChange",
  "companyName"
] as const;

/**
 * Positive-valued fields (price, book, size, volume, OHLC, vwap): treat 0 as missing
 * so a secondary provider can backfill. Change metrics may legitimately be 0.
 * Strings (companyName) use nullish presence.
 */
function fieldHasUsableValue(field: (typeof PROVENANCE_TRACKED_FIELDS)[number], quote: BrokerQuote): boolean {
  const v = quote[field];
  if (v == null) return false;
  if (field === "companyName") return typeof v === "string" && v.length > 0;
  if (field === "change" || field === "changePct" || field === "netChange") {
    return typeof v === "number" && Number.isFinite(v);
  }
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** Coalesce numeric quote fields: prefer a positive primary, else positive secondary; change metrics allow 0. */
function coalesceQuoteNumber(
  primary: number | undefined,
  secondary: number | undefined,
  opts: { allowZero?: boolean } = {}
): number | undefined {
  const ok = (v: number | undefined): v is number =>
    typeof v === "number" && Number.isFinite(v) && (opts.allowZero ? true : v > 0);
  if (ok(primary)) return primary;
  if (ok(secondary)) return secondary;
  return undefined;
}

function stampFieldProvenance(
  primary: BrokerQuote,
  secondary: BrokerQuote
): Record<string, QuoteFieldProvenance> {
  const prov: Record<string, QuoteFieldProvenance> = {
    ...(secondary.fieldProvenance ?? {}),
    ...(primary.fieldProvenance ?? {})
  };
  for (const field of PROVENANCE_TRACKED_FIELDS) {
    const winner = fieldHasUsableValue(field, primary)
      ? primary
      : fieldHasUsableValue(field, secondary)
        ? secondary
        : undefined;
    if (!winner) continue;
    // Retain an existing per-field receipt when the winner is itself a previously
    // coalesced quote — do not overwrite with the quote-level provider/timestamps
    // (Codex P1 review on #3449: repeated merges must keep each field's supplier).
    const existing = winner.fieldProvenance?.[field];
    if (existing) {
      prov[field] = existing;
    } else {
      prov[field] = {
        provider: winner.provider,
        asOf: winner.asOf,
        fetchedAt: winner.fetchedAt
      };
    }
  }
  return prov;
}

/**
 * A quote is "field-complete" for cascade purposes when it carries the core
 * session fields the cascade exists to coalesce: a usable price, a two-sided
 * book, the previous close, and the session OHLC (Codex P1 review on #3449 —
 * a fresh broker/Alpaca price missing prevClose/OHLC must not stop the
 * cascade before Finnhub/Tiingo/Yahoo can backfill them).  VWAP is deliberately
 * excluded: it is effectively single-provider (Alpaca), so requiring it would
 * force every non-Alpaca symbol through all seven levels on every refresh,
 * conflicting with the quota-protection review finding.  A fresh but
 * field-incomplete quote stays pending; later levels backfill the gaps.
 */
export function isCascadeFieldComplete(quote: BrokerQuote): boolean {
  const positive = (v: unknown): v is number => typeof v === "number" && v > 0;
  return (
    positive(quote.price) &&
    positive(quote.bid) &&
    positive(quote.ask) &&
    positive(quote.prevClose) &&
    positive(quote.open) &&
    positive(quote.high) &&
    positive(quote.low)
  );
}

/**
 * Merges fields between an existing quote and an incoming quote.
 *
 * Rules:
 * 1. If target is venue-authoritative (e.g. Tradier paper sandbox), target's
 *    price, asOf, provider, and venuePriceAuthoritative flag are preserved.
 *    Missing descriptive fields (prevClose, open, high, low, vwap, bid, ask, etc.)
 *    are backfilled from incoming.
 * 2. If incoming is venue-authoritative and target is not, incoming takes precedence.
 * 3. Otherwise, the quote with a valid price and fresher `asOf` wins the primary
 *    price and provider, while missing fields are backfilled from the other quote.
 */
export function mergeBrokerQuoteFields(
  target?: BrokerQuote,
  incoming?: BrokerQuote
): BrokerQuote | undefined {
  if (!target && !incoming) return undefined;
  if (!target) return incoming ? { ...incoming } : undefined;
  if (!incoming) return { ...target };

  // Case 1: Target is venuePriceAuthoritative
  if (target.venuePriceAuthoritative && !incoming.venuePriceAuthoritative) {
    return {
      ...incoming,
      ...target,
      price: target.price,
      asOf: target.asOf,
      provider: target.provider,
      fetchedAt: target.fetchedAt ?? incoming.fetchedAt,
      venuePriceAuthoritative: true,
      bid: coalesceQuoteNumber(target.bid, incoming.bid),
      ask: coalesceQuoteNumber(target.ask, incoming.ask),
      volume: coalesceQuoteNumber(target.volume, incoming.volume),
      prevClose: coalesceQuoteNumber(target.prevClose, incoming.prevClose),
      open: coalesceQuoteNumber(target.open, incoming.open),
      high: coalesceQuoteNumber(target.high, incoming.high),
      low: coalesceQuoteNumber(target.low, incoming.low),
      close: coalesceQuoteNumber(target.close, incoming.close),
      vwap: coalesceQuoteNumber(target.vwap, incoming.vwap),
      change: coalesceQuoteNumber(target.change, incoming.change, { allowZero: true }),
      changePct: coalesceQuoteNumber(target.changePct, incoming.changePct, { allowZero: true }),
      bidSize: coalesceQuoteNumber(target.bidSize, incoming.bidSize),
      askSize: coalesceQuoteNumber(target.askSize, incoming.askSize),
      companyName: target.companyName ?? incoming.companyName,
      netChange: coalesceQuoteNumber(target.netChange, incoming.netChange, { allowZero: true }),
      fieldProvenance: stampFieldProvenance(target, incoming)
    };
  }

  // Case 2: Incoming is venuePriceAuthoritative
  if (incoming.venuePriceAuthoritative && !target.venuePriceAuthoritative) {
    return {
      ...target,
      ...incoming,
      price: incoming.price,
      asOf: incoming.asOf,
      provider: incoming.provider,
      fetchedAt: incoming.fetchedAt ?? target.fetchedAt,
      venuePriceAuthoritative: true,
      bid: coalesceQuoteNumber(incoming.bid, target.bid),
      ask: coalesceQuoteNumber(incoming.ask, target.ask),
      volume: coalesceQuoteNumber(incoming.volume, target.volume),
      prevClose: coalesceQuoteNumber(incoming.prevClose, target.prevClose),
      open: coalesceQuoteNumber(incoming.open, target.open),
      high: coalesceQuoteNumber(incoming.high, target.high),
      low: coalesceQuoteNumber(incoming.low, target.low),
      close: coalesceQuoteNumber(incoming.close, target.close),
      vwap: coalesceQuoteNumber(incoming.vwap, target.vwap),
      change: coalesceQuoteNumber(incoming.change, target.change, { allowZero: true }),
      changePct: coalesceQuoteNumber(incoming.changePct, target.changePct, { allowZero: true }),
      bidSize: coalesceQuoteNumber(incoming.bidSize, target.bidSize),
      askSize: coalesceQuoteNumber(incoming.askSize, target.askSize),
      companyName: incoming.companyName ?? target.companyName,
      netChange: coalesceQuoteNumber(incoming.netChange, target.netChange, { allowZero: true }),
      fieldProvenance: stampFieldProvenance(incoming, target)
    };
  }

  // Case 3: General case (neither or both are venue-authoritative)
  const targetTime = target.asOf ? new Date(target.asOf).getTime() : 0;
  const incomingTime = incoming.asOf ? new Date(incoming.asOf).getTime() : 0;
  const targetHasPrice = typeof target.price === "number" && target.price > 0;
  const incomingHasPrice = typeof incoming.price === "number" && incoming.price > 0;

  const preferIncoming =
    (!targetHasPrice && incomingHasPrice) ||
    (incomingHasPrice && incomingTime > targetTime);

  const primary = preferIncoming ? incoming : target;
  const secondary = preferIncoming ? target : incoming;

  const hasBid = typeof primary.bid === "number" && primary.bid > 0;
  const hasAsk = typeof primary.ask === "number" && primary.ask > 0;

  return {
    ...secondary,
    ...primary,
    bid: coalesceQuoteNumber(primary.bid, secondary.bid),
    ask: coalesceQuoteNumber(primary.ask, secondary.ask),
    volume: coalesceQuoteNumber(primary.volume, secondary.volume),
    prevClose: coalesceQuoteNumber(primary.prevClose, secondary.prevClose),
    open: coalesceQuoteNumber(primary.open, secondary.open),
    high: coalesceQuoteNumber(primary.high, secondary.high),
    low: coalesceQuoteNumber(primary.low, secondary.low),
    close: coalesceQuoteNumber(primary.close, secondary.close),
    vwap: coalesceQuoteNumber(primary.vwap, secondary.vwap),
    change: coalesceQuoteNumber(primary.change, secondary.change, { allowZero: true }),
    changePct: coalesceQuoteNumber(primary.changePct, secondary.changePct, { allowZero: true }),
    bidSize: coalesceQuoteNumber(primary.bidSize, secondary.bidSize),
    askSize: coalesceQuoteNumber(primary.askSize, secondary.askSize),
    companyName: primary.companyName ?? secondary.companyName,
    netChange: coalesceQuoteNumber(primary.netChange, secondary.netChange, { allowZero: true }),
    syntheticBid: hasBid ? primary.syntheticBid : secondary.syntheticBid,
    syntheticAsk: hasAsk ? primary.syntheticAsk : secondary.syntheticAsk,
    syntheticSpread:
      hasBid && hasAsk
        ? primary.syntheticSpread
        : (primary.syntheticSpread ?? secondary.syntheticSpread),
    delayedFallback: primary.delayedFallback ?? (preferIncoming ? secondary.delayedFallback : undefined),
    fieldProvenance: stampFieldProvenance(primary, secondary)
  };
}

export async function fetchFinnhubQuote(
  symbol: string,
  apiKey: string,
  keySource: string = "env",
  userId?: string,
  signal?: AbortSignal
): Promise<BrokerQuote | undefined> {
  // Paced through the provider limiter like every other Finnhub call site —
  // the cascade must not burst past Finnhub's quota (Codex P1 review on #3449).
  const res = await withProviderLimit("finnhub", () =>
    fetchWithRetry(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`,
      { signal },
      { service: "finnhub", keySource, userId }
    )
  );
  if (!res.ok) return undefined;
  const q = (await res.json()) as Record<string, unknown>;
  const c = firstNumber(q, ["c"]);
  if (!(typeof c === "number" && c > 0)) return undefined;
  const pc = firstNumber(q, ["pc"]);
  const o = firstNumber(q, ["o"]);
  const h = firstNumber(q, ["h"]);
  const l = firstNumber(q, ["l"]);
  const d = firstNumber(q, ["d"]);
  const dp = firstNumber(q, ["dp"]);
  const t = firstNumber(q, ["t"]);
  const asOf = typeof t === "number" && t > 0 ? new Date(t * 1000).toISOString() : undefined;

  return {
    symbol,
    price: c,
    prevClose: typeof pc === "number" && pc > 0 ? pc : undefined,
    open: typeof o === "number" && o > 0 ? o : undefined,
    high: typeof h === "number" && h > 0 ? h : undefined,
    low: typeof l === "number" && l > 0 ? l : undefined,
    change: typeof d === "number" ? d : undefined,
    changePct: typeof dp === "number" ? dp : undefined,
    asOf,
    provider: "finnhub",
    fetchedAt: new Date().toISOString()
  };
}

export async function fetchTiingoQuote(
  symbol: string,
  apiKey: string,
  keySource: string = "env",
  userId?: string,
  signal?: AbortSignal
): Promise<BrokerQuote | undefined> {
  const ticker = symbol.toLowerCase();
  // Admit against the shared "tiingo" quota bucket (the same lane history.ts and
  // the Tiingo enrichment provider draw from) and disable in-call retries: every
  // upstream attempt must be independently reserved and metered instead of hiding
  // an uncounted retry inside one logical call (Codex P1 review on #3449).
  const credKey = await apiKeyFingerprint(apiKey);
  if (admitProviderRequests("tiingo", credKey, 1) < 1) return undefined;
  const res = await fetchWithRetry(
    `https://api.tiingo.com/iex/${encodeURIComponent(ticker)}?token=${encodeURIComponent(apiKey)}`,
    {
      headers: { Authorization: `Token ${apiKey}`, Accept: "application/json" },
      signal
    },
    { service: "tiingo", keySource, userId, retries: 0 }
  );
  if (!res.ok) return undefined;
  const payload = await res.json();
  const arr = Array.isArray(payload) ? payload : [payload];
  if (arr.length === 0 || !arr[0] || typeof arr[0] !== "object") return undefined;
  const q = arr[0] as Record<string, unknown>;

  const price = firstNumber(q, ["tngoLast", "lastPrice", "last", "mid"]);
  const bid = firstNumber(q, ["bidPrice"]);
  const ask = firstNumber(q, ["askPrice"]);
  const resolvedPrice = price ?? (bid && ask ? (bid + ask) / 2 : undefined);
  if (!(typeof resolvedPrice === "number" && resolvedPrice > 0)) return undefined;

  const bidSize = firstNumber(q, ["bidSize"]);
  const askSize = firstNumber(q, ["askSize"]);
  const volume = firstNumber(q, ["volume"]);
  const prevClose = firstNumber(q, ["prevClose"]);
  const open = firstNumber(q, ["open"]);
  const high = firstNumber(q, ["high"]);
  const low = firstNumber(q, ["low"]);
  const timestamp =
    typeof q.timestamp === "string"
      ? q.timestamp
      : typeof q.lastSaleTimestamp === "string"
        ? q.lastSaleTimestamp
        : typeof q.quoteTimestamp === "string"
          ? q.quoteTimestamp
          : undefined;

  let change: number | undefined;
  let changePct: number | undefined;
  if (prevClose && prevClose > 0) {
    change = Math.round((resolvedPrice - prevClose) * 100) / 100;
    changePct = Math.round(((resolvedPrice - prevClose) / prevClose) * 10000) / 100;
  }

  return {
    symbol,
    price: resolvedPrice,
    bid: typeof bid === "number" && bid > 0 ? bid : undefined,
    ask: typeof ask === "number" && ask > 0 ? ask : undefined,
    bidSize: typeof bidSize === "number" && bidSize > 0 ? bidSize : undefined,
    askSize: typeof askSize === "number" && askSize > 0 ? askSize : undefined,
    volume: typeof volume === "number" && volume > 0 ? volume : undefined,
    prevClose: typeof prevClose === "number" && prevClose > 0 ? prevClose : undefined,
    open: typeof open === "number" && open > 0 ? open : undefined,
    high: typeof high === "number" && high > 0 ? high : undefined,
    low: typeof low === "number" && low > 0 ? low : undefined,
    change,
    changePct,
    asOf: timestamp,
    provider: "tiingo",
    fetchedAt: new Date().toISOString()
  };
}

export function syncQuotesToFieldStore(quotes: Record<string, BrokerQuote>): void {
  try {
    const nowIso = new Date().toISOString();
    const records: SymbolFieldLatestRecord[] = [];
    const isFiniteNumber = (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v);
    // Persist each field with ITS OWN provenance (recorded by
    // mergeBrokerQuoteFields), falling back to the merged quote's single
    // provider/asOf/fetchedAt only when no per-field receipt exists
    // (Codex P1 review on #3449).
    const pushField = (
      symbol: string,
      quote: BrokerQuote,
      field: string,
      value: unknown,
      valid: (v: unknown) => boolean,
      normalize?: (v: never) => unknown
    ): void => {
      if (!valid(value)) return;
      const prov = quote.fieldProvenance?.[field];
      records.push({
        symbol,
        field,
        valueJson: JSON.stringify(normalize ? normalize(value as never) : value),
        source: prov?.provider ?? quote.provider ?? "quote-cascade",
        asOf: prov?.asOf ?? quote.asOf ?? quote.fetchedAt ?? nowIso,
        fetchedAt: prov?.fetchedAt ?? quote.fetchedAt ?? nowIso
      });
    };
    for (const [symbol, quote] of Object.entries(quotes)) {
      if (!quote) continue;
      pushField(symbol, quote, "price", quote.price, isFiniteNumber);
      pushField(symbol, quote, "bid", quote.bid, isFiniteNumber);
      pushField(symbol, quote, "ask", quote.ask, isFiniteNumber);
      pushField(symbol, quote, "volume", quote.volume, isFiniteNumber);
      pushField(symbol, quote, "prevClose", quote.prevClose, isFiniteNumber);
      pushField(symbol, quote, "vwap", quote.vwap, isFiniteNumber);
      pushField(symbol, quote, "open", quote.open, isFiniteNumber);
      pushField(symbol, quote, "high", quote.high, isFiniteNumber);
      pushField(symbol, quote, "low", quote.low, isFiniteNumber);
      pushField(symbol, quote, "change", quote.change, isFiniteNumber);
      pushField(symbol, quote, "changePct", quote.changePct, isFiniteNumber);
      pushField(
        symbol,
        quote,
        "companyName",
        quote.companyName,
        (v): v is string => typeof v === "string" && v.trim().length > 0,
        (v: string) => v.trim()
      );
    }
    if (records.length > 0) {
      upsertSymbolFieldLatest(records);
    }
  } catch {
    // Non-blocking sync; do not fail quote resolution if DB write fails
  }
}

/**
 * Default max quote age for the cascade "accept and stop" threshold.
 *
 * MUST stay aligned with `DEFAULT_POLICY.maxQuoteAgeSec` (120s) for real-time venues.
 * Venue-delayed feeds (Tradier sandbox) use a different accept rule — see
 * `resolveVenueQuoteMode` / `venuePriceAuthoritative`.
 */
export function cascadeFreshMaxAgeMs(maxQuoteAgeSec?: number | null): number {
  const fromPolicy =
    typeof maxQuoteAgeSec === "number" && Number.isFinite(maxQuoteAgeSec) && maxQuoteAgeSec > 0
      ? maxQuoteAgeSec
      : (DEFAULT_POLICY.maxQuoteAgeSec ?? 120);
  return Math.max(1, fromPolicy) * 1000;
}

/**
 * True when the quote's trade/asOf timestamp is within the cascade accept window.
 * Missing/unparseable asOf is NEVER treated as fresh — continue the cascade.
 * Venue-authoritative quotes are handled separately (always acceptable when priced).
 */
export function isTwoSidedLiveNbbo(quote: {
  bid?: number;
  ask?: number;
  syntheticSpread?: boolean;
  syntheticBid?: boolean;
  syntheticAsk?: boolean;
}): boolean {
  if (quote.syntheticSpread || quote.syntheticBid || quote.syntheticAsk) {
    return false;
  }
  // A crossed book (bid > ask) is malformed — never treat it as a live NBBO,
  // even though both sides are positive (Codex P2 review).
  if (
    typeof quote.bid === "number" &&
    typeof quote.ask === "number" &&
    quote.ask < quote.bid
  ) {
    return false;
  }
  return (
    typeof quote.bid === "number" &&
    quote.bid > 0 &&
    typeof quote.ask === "number" &&
    quote.ask > 0
  );
}

/**
 * A two-sided book that may age by FETCH time rather than last-print time.
 * Restricted to verified real-time venues: delayed tapes (Yahoo cascade feeds,
 * secondary Tradier-paper books) age by market time instead, so a delayed quote
 * can never masquerade as live via a fresh fetch stamp (Codex P1 reviews).
 */
function isVerifiedRealtimeBook(quote: {
  bid?: number;
  ask?: number;
  syntheticSpread?: boolean;
  syntheticBid?: boolean;
  syntheticAsk?: boolean;
  venueDelayedTape?: boolean;
  provider?: string;
}): boolean {
  if (quote.venueDelayedTape) return false;
  if (isYahooFallbackProvider(quote.provider)) return false;
  return isTwoSidedLiveNbbo(quote);
}

export function isQuoteFresh(
  quote: {
    asOf?: string;
    venuePriceAuthoritative?: boolean;
    bid?: number;
    ask?: number;
    fetchedAt?: string;
    provider?: string;
    venueDelayedTape?: boolean;
    syntheticSpread?: boolean;
    syntheticBid?: boolean;
    syntheticAsk?: boolean;
  },
  nowMs: number,
  maxAgeMs: number = cascadeFreshMaxAgeMs()
): boolean {
  if (quote.venuePriceAuthoritative) return true;
  // Two-sided broker NBBO fetched just now is live even when last-print `asOf` is old
  // (quiet names / IEX last trade sitting still).  Age the fetch, not the last print.
  // Delayed tapes (Yahoo, secondary Tradier paper) and crossed books are excluded:
  // they age by market time so delay never masquerades as freshness.
  if (isVerifiedRealtimeBook(quote) && quote.fetchedAt) {
    const fetchedMs = new Date(quote.fetchedAt).getTime();
    if (!Number.isNaN(fetchedMs)) {
      const fetchAgeMs = nowMs - fetchedMs;
      if (fetchAgeMs < 0 || fetchAgeMs <= maxAgeMs) return true;
    }
  }
  if (!quote.asOf) return false;
  const asOfMs = new Date(quote.asOf).getTime();
  if (Number.isNaN(asOfMs)) return false;
  const ageMs = nowMs - asOfMs;
  if (ageMs < 0) return true; // clock skew / future stamp — accept
  return ageMs <= maxAgeMs;
}

/**
 * Broker tape the cascade should keep now.  Last-session close stays in
 * `bestQuotes` for the end-of-cascade fallback — it must not stop Level 2/3.
 * After #3031, an IEX 0-print filled by `fillMissingQuotesWithClose` was tagged
 * `session-close` and treated as usable, so RTH names never reached snapshots
 * or Yahoo and were sized at yesterday's close.
 */
export function isUsableBrokerQuote(
  quote: {
    asOf?: string;
    venuePriceAuthoritative?: boolean;
    bid?: number;
    ask?: number;
    fetchedAt?: string;
    provider?: string;
    price?: number;
    syntheticSpread?: boolean;
    syntheticBid?: boolean;
    syntheticAsk?: boolean;
  },
  nowMs: number,
  maxAgeMs: number = cascadeFreshMaxAgeMs()
): boolean {
  return isQuoteFresh(quote, nowMs, maxAgeMs);
}

/**
 * Age (seconds) used by the policy staleness gate.
 *
 * - Real-time quotes: age of trade-time `asOf` (true market freshness).
 * - Live two-sided NBBO broker quotes: age of `fetchedAt` if recent (active book).
 * - Venue-authoritative delayed feeds (Tradier sandbox): age of `fetchedAt` (snapshot
 *   freshness). The ~15m trade-time delay is the venue, not a broken cascade.
 */
export function quoteAgeSecForStalenessGate(
  quote: {
    asOf?: string;
    venuePriceAuthoritative?: boolean;
    fetchedAt?: string;
    delayedFallback?: boolean;
    provider?: string;
    bid?: number;
    ask?: number;
    syntheticSpread?: boolean;
    syntheticBid?: boolean;
    syntheticAsk?: boolean;
  venueDelayedTape?: boolean;
  } | undefined,
  nowMs: number
): { ageSec?: number; missing: boolean; venueDelayed: boolean; delayedFallback: boolean } {
  if (!quote) return { missing: true, venueDelayed: false, delayedFallback: false };
  const venueDelayed = quote.venuePriceAuthoritative === true;
  const delayedFallback = isDelayedYahooFallbackQuote(quote, nowMs);
  const liveNbbo = isVerifiedRealtimeBook(quote);
  // Venue-delayed tape and delayed Yahoo fallback: age the FETCH snapshot, not the
  // expected ~15m print.  A just-fetched delayed Yahoo quote is not a broken cascade.
  // Real-time two-sided NBBO broker quotes: also age fetchedAt if available and valid.
  // Delayed tapes (Yahoo cascade feeds, secondary Tradier paper) age by market time.
  const useFetchedAt =
    venueDelayed ||
    delayedFallback ||
    (liveNbbo && typeof quote.fetchedAt === "string" && !Number.isNaN(new Date(quote.fetchedAt).getTime()));
  const stamp = useFetchedAt ? quote.fetchedAt ?? quote.asOf : quote.asOf;
  if (!stamp) return { missing: true, venueDelayed, delayedFallback };
  const asOfMs = new Date(stamp).getTime();
  if (Number.isNaN(asOfMs)) return { missing: true, venueDelayed, delayedFallback };
  return {
    ageSec: Math.round((nowMs - asOfMs) / 1000),
    missing: false,
    venueDelayed,
    delayedFallback
  };
}

/**
 * How this connected account should resolve execution prices.
 *
 * - `venue_delayed`: Tradier paper/sandbox — the paper OMS fills against Tradier's ~15m
 *   delayed tape. Use that price; never overlay fresher Alpaca/Yahoo.
 * - `realtime`: everything else (Alpaca paper/live, Tradier production, Robinhood, …).
 */
export type VenueQuoteMode = "realtime" | "venue_delayed";

export function resolveVenueQuoteMode(
  policy: Pick<TradingPolicy, "activeBroker" | "connectedAccountId"> | null | undefined,
  userId: string
): VenueQuoteMode {
  if (policy?.activeBroker !== "tradier") return "realtime";
  const acct =
    (policy.connectedAccountId ? getConnectedAccount(policy.connectedAccountId, userId) : undefined) ??
    getActiveConnectedAccount(userId);
  if (acct?.broker === "tradier" && acct.environment === "paper") return "venue_delayed";
  return "realtime";
}

function stampVenueAuthoritative(quote: BrokerQuote, fetchedAtIso: string): BrokerQuote {
  return {
    ...quote,
    venuePriceAuthoritative: true,
    fetchedAt: fetchedAtIso
  };
}

/**
 * Minimal policy stub so getBrokerGateway can resolve ANY of the user's connected
 * accounts for market-data reads — not only the active trading account.
 */
export function policyStubForConnectedAccount(account: ConnectedAccount): TradingPolicy {
  return {
    ...DEFAULT_POLICY,
    activeBroker: account.broker,
    connectedAccountId: account.id,
    accountNumber: account.accountNumber ?? undefined
  };
}

/**
 * Robust, redundant cascading quote resolver. Checks quote sources in series:
 * 1a. Active Broker Gateway (account the user is operating)
 * 1b. EVERY other connected broker for this user (market data only — not fill venue)
 * 2. Alpaca Snapshots API (any Alpaca key on the user)
 * 3. Yahoo Finance Batch API
 * 4. Yahoo Finance Single Quote API
 * 5. ROIC.ai Profile API
 *
 * Real-time venues: accept when trade-time is within `policy.maxQuoteAgeSec` (default 120s).
 * Venue-delayed (Tradier sandbox paper): accept the *active* broker quote as authoritative
 * whenever it has a price — do NOT overlay fresher externals for those symbols. Other
 * connected brokers only fill symbols the active venue could not price.
 *
 * Market data is USER-scoped (all connected brokers share one cascade), not duplicated
 * per trading account.
 */
function throwIfCascadeAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Quote cascade cancelled.");
}

export async function fetchFreshQuotesCascade(
  symbols: string[],
  userId: string,
  accountNumber?: string,
  connectedAccountId?: string,
  options?: { signal?: AbortSignal; skipActiveBroker?: boolean }
): Promise<Record<string, BrokerQuote>> {
  const signal = options?.signal;
  throwIfCascadeAborted(signal);
  const nowMs = Date.now();
  const fetchedAtIso = new Date(nowMs).toISOString();
  // Stamp each quote when its fetch COMPLETES, not when the cascade started: a
  // quote obtained after a slow broker wait must not arrive already aged by that
  // wait (Codex P2 review).  fetchedAtIso remains as a last-resort fallback.
  const stampIngest = (): string => new Date().toISOString();
  const normalizedSymbols = Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean)));
  const result: Record<string, BrokerQuote> = {};

  if (normalizedSymbols.length === 0) return result;

  const isTest = process.env.NODE_ENV === "test";
  const allowExternal = !isTest || process.env.TEST_ALLOW_CASCADE_EXTERNAL === "1";

  // Track the best (freshest by asOf timestamp) quote found for each symbol across all levels
  const bestQuotes: Record<string, BrokerQuote> = {};
  let pendingSymbols = [...normalizedSymbols];

  const updateBestQuote = (symbol: string, quote: BrokerQuote) => {
    const existing = bestQuotes[symbol];
    const merged = existing ? mergeBrokerQuoteFields(existing, quote)! : quote;
    bestQuotes[symbol] = merged;
    if (result[symbol]) {
      result[symbol] = mergeBrokerQuoteFields(result[symbol], quote)!;
    }
  };

  let maxAgeMs = cascadeFreshMaxAgeMs();

  // Accept-and-stop gate (Codex P1 review on #3449): a quote stops the cascade
  // only when it is BOTH fresh and field-complete.  Fresh-but-incomplete quotes
  // stay pending so later levels can backfill the missing fields; the merged
  // best quote is what gets accepted.  (The venue-authoritative Level 1a path
  // keeps its unconditional accept — the active execution venue's price is
  // authoritative by owner rule.)
  const acceptIfComplete = (symbol: string, quote: BrokerQuote): void => {
    const merged = bestQuotes[symbol] ?? quote;
    if (isQuoteFresh(merged, nowMs, maxAgeMs) && isCascadeFieldComplete(merged)) {
      result[symbol] = merged;
    }
  };

  const ingestBrokerQuotes = (
    brokerQuotes: Record<string, BrokerQuote>,
    opts: { venueDelayed: boolean; delayedTape?: boolean; providerTag: string }
  ) => {
    for (const symbol of [...pendingSymbols]) {
      const quote = brokerQuotes[symbol] ?? brokerQuotes[normalizeSymbol(symbol)];
      if (!quote) continue;
      const resolvedPrice = quote.price ?? (quote.bid && quote.ask ? (quote.bid + quote.ask) / 2 : undefined);
      if (!(typeof resolvedPrice === "number" && resolvedPrice > 0)) continue;
      const ingestAt = stampIngest();
      let normalizedQuote: BrokerQuote = {
        ...quote,
        price: resolvedPrice,
        provider: quote.provider ?? opts.providerTag,
        fetchedAt: quote.fetchedAt ?? ingestAt,
        // Secondary delayed-tape books (Tradier paper) are kept for fallback but must
        // never be promoted to real-time by a fresh fetch stamp (Codex P1 review).
        ...(opts.delayedTape ? { venueDelayedTape: true as const } : {})
      };
      if (opts.venueDelayed) {
        normalizedQuote = stampVenueAuthoritative(normalizedQuote, ingestAt);
        updateBestQuote(symbol, normalizedQuote);
        result[symbol] = normalizedQuote;
      } else {
        updateBestQuote(symbol, normalizedQuote);
        // Secondary (delayed-tape) broker books get the same field-completeness
        // gate as the other levels (Codex P1 review on #3449).
        acceptIfComplete(symbol, normalizedQuote);
      }
    }
    pendingSymbols = pendingSymbols.filter((s) => !result[s]);
  };

  // --- LEVEL 1a: Active Broker Gateway ---
  throwIfCascadeAborted(signal);
  let venueMode: VenueQuoteMode = "realtime";
  let activeConnectedId: string | undefined;
  try {
    const policy = getPolicy(userId, connectedAccountId);
    maxAgeMs = cascadeFreshMaxAgeMs(policy.maxQuoteAgeSec);
    venueMode = resolveVenueQuoteMode(policy, userId);
    activeConnectedId = policy.connectedAccountId;
    const activeAccountNum = accountNumber ?? policy.accountNumber;
    // skipActiveBroker: the caller already hit this broker directly (e.g. the dashboard
    // fallback after its own gateway call timed out) — do not issue a duplicate call to
    // the same broker while it is degraded (Codex P1 review).
    if (activeAccountNum && policy.activeBroker && !options?.skipActiveBroker) {
      const gateway = getBrokerGateway(policy, userId);
      const brokerQuotes = await gateway.getEquityQuotes(activeAccountNum, pendingSymbols, { signal });
      ingestBrokerQuotes(brokerQuotes, {
        venueDelayed: venueMode === "venue_delayed",
        providerTag: String(policy.activeBroker)
      });
    }
  } catch (error) {
    console.warn("[quotes-cascade] Level 1a (active broker) failed:", error instanceof Error ? error.message : error);
  }

  // --- LEVEL 1b: ALL other connected brokers for this user (market-data only) ---
  throwIfCascadeAborted(signal);
  if (pendingSymbols.length > 0) {
    try {
      for (const account of listConnectedAccounts(userId)) {
        if (pendingSymbols.length === 0) break;
        if (activeConnectedId && account.id === activeConnectedId) continue;
        if (accountNumber && account.accountNumber && account.accountNumber === accountNumber) continue;
        if (!account.accountNumber) continue;
        try {
          throwIfCascadeAborted(signal);
          const stub = policyStubForConnectedAccount(account);
          const gateway = getBrokerGateway(stub, userId);
          const brokerQuotes = await gateway.getEquityQuotes(account.accountNumber, pendingSymbols, { signal });
          // A secondary Tradier paper/sandbox book is ~15m delayed tape: keep it for
          // fallback but never let a fresh fetch stamp promote it to real-time and stop
          // the cascade ahead of Alpaca/Yahoo (Codex P1 review).
          const delayedTape = account.broker === "tradier" && account.environment === "paper";
          ingestBrokerQuotes(brokerQuotes, {
            venueDelayed: false,
            delayedTape,
            providerTag: `${account.broker}-connected`
          });
        } catch (err) {
          console.warn(
            `[quotes-cascade] Level 1b (${account.broker} ${account.id}) failed:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    } catch (error) {
      console.warn("[quotes-cascade] Level 1b multi-broker list failed:", error instanceof Error ? error.message : error);
    }
  }

  // On venue-delayed mode we only cascade for symbols the broker could not price at all.
  // Fresher external quotes would mis-price paper fills against a delayed OMS.

  // --- LEVEL 2: Alpaca Snapshots API ---
  throwIfCascadeAborted(signal);
  if (pendingSymbols.length > 0 && allowExternal) {
    try {
      const alpacaData = resolveAlpacaMarketData(userId);
      if (alpacaData.apiKey && alpacaData.secretKey) {
        const provider = new AlpacaSnapshotEnrichmentProvider(alpacaData.apiKey, alpacaData.secretKey, alpacaData.source, userId);
        const enrichment = await provider.enrich(pendingSymbols);
        for (const symbol of pendingSymbols) {
          const data = enrichment[symbol];
          if (data) {
            const resolvedPrice = data.price ?? (data.bid && data.ask ? (data.bid + data.ask) / 2 : undefined);
            if (typeof resolvedPrice === "number" && resolvedPrice > 0) {
              const q: BrokerQuote = {
                symbol,
                price: resolvedPrice,
                bid: data.bid,
                ask: data.ask,
                bidSize: data.bidSize,
                askSize: data.askSize,
                volume: data.volume,
                prevClose: data.prevClose,
                open: data.open,
                high: data.high,
                low: data.low,
                vwap: data.vwap,
                netChange: data.netChange,
                change: data.netChange,
                changePct: data.intradayChangePct,
                companyName: data.companyName,
                asOf: data.asOf,
                provider: "alpaca-snapshot",
                fetchedAt: stampIngest()
              };
              updateBestQuote(symbol, q);
              acceptIfComplete(symbol, q);
            }
          }
        }
        pendingSymbols = pendingSymbols.filter((s) => !result[s]);
      }
    } catch (error) {
      console.warn("[quotes-cascade] Level 2 (Alpaca Snapshots) fetch failed:", error instanceof Error ? error.message : error);
    }
  }

  // --- LEVEL 3: Finnhub Real-time Quote API ---
  throwIfCascadeAborted(signal);
  if (pendingSymbols.length > 0 && allowExternal) {
    try {
      const finnhub = resolveApiKeyWithSource("finnhub", userId);
      if (finnhub.key) {
        await Promise.all(
          pendingSymbols.map(async (symbol) => {
            try {
              const q = await fetchFinnhubQuote(symbol, finnhub.key!, finnhub.source, userId, signal);
              if (q) {
                updateBestQuote(symbol, q);
                acceptIfComplete(symbol, q);
              }
            } catch (err) {
              console.warn(`[quotes-cascade] Level 3 (Finnhub) fetch failed for ${symbol}:`, err);
            }
          })
        );
        pendingSymbols = pendingSymbols.filter((s) => !result[s]);
      }
    } catch (error) {
      console.warn("[quotes-cascade] Level 3 (Finnhub) fetch failed:", error instanceof Error ? error.message : error);
    }
  }

  // --- LEVEL 4: Tiingo IEX Real-time Quote API ---
  throwIfCascadeAborted(signal);
  if (pendingSymbols.length > 0 && allowExternal) {
    try {
      const tiingo = resolveApiKeyWithSource("tiingo", userId);
      if (tiingo.key) {
        await Promise.all(
          pendingSymbols.map(async (symbol) => {
            try {
              const q = await fetchTiingoQuote(symbol, tiingo.key!, tiingo.source, userId, signal);
              if (q) {
                updateBestQuote(symbol, q);
                acceptIfComplete(symbol, q);
              }
            } catch (err) {
              console.warn(`[quotes-cascade] Level 4 (Tiingo) fetch failed for ${symbol}:`, err);
            }
          })
        );
        pendingSymbols = pendingSymbols.filter((s) => !result[s]);
      }
    } catch (error) {
      console.warn("[quotes-cascade] Level 4 (Tiingo) fetch failed:", error instanceof Error ? error.message : error);
    }
  }

  // --- LEVEL 5: Yahoo Finance Batch API ---
  throwIfCascadeAborted(signal);
  if (pendingSymbols.length > 0 && allowExternal) {
    try {
      const yahooBatch = await fetchYahooFinanceQuotesBatch(pendingSymbols);
      for (const symbol of pendingSymbols) {
        const data = yahooBatch.get(symbol);
        if (data) {
          const resolvedPrice = data.price ?? (data.bid && data.ask ? (data.bid + data.ask) / 2 : undefined);
          if (typeof resolvedPrice === "number" && resolvedPrice > 0) {
            const q: BrokerQuote = {
              symbol,
              price: resolvedPrice,
              bid: data.bid,
              ask: data.ask,
              volume: data.volume,
              prevClose: data.prevClose,
              open: data.open,
              high: data.high,
              low: data.low,
              change: data.change,
              changePct: data.changePct,
              companyName: data.companyName,
              asOf: data.asOf,
              provider: "yahoo-finance-batch",
              syntheticBid: data.syntheticBid,
              syntheticAsk: data.syntheticAsk,
              syntheticSpread: data.syntheticSpread,
              fetchedAt: stampIngest()
            };
            updateBestQuote(symbol, q);
            acceptIfComplete(symbol, q);
          }
        }
      }
      pendingSymbols = pendingSymbols.filter((s) => !result[s]);
    } catch (error) {
      console.warn("[quotes-cascade] Level 5 (Yahoo Finance Batch) fetch failed:", error instanceof Error ? error.message : error);
    }
  }

  // --- LEVEL 6: Yahoo Finance Single Quote API ---
  throwIfCascadeAborted(signal);
  if (pendingSymbols.length > 0 && allowExternal) {
    try {
      const singleResults = await Promise.all(
        pendingSymbols.map(async (symbol) => [symbol, await fetchYahooFinanceQuote(symbol)] as const)
      );
      for (const [symbol, quote] of singleResults) {
        if (quote) {
          const resolvedPrice = quote.price ?? (quote.bid && quote.ask ? (quote.bid + quote.ask) / 2 : undefined);
          if (typeof resolvedPrice === "number" && resolvedPrice > 0) {
            const q: BrokerQuote = {
              symbol,
              price: resolvedPrice,
              bid: quote.bid,
              ask: quote.ask,
              volume: quote.volume,
              prevClose: quote.prevClose,
              open: quote.open,
              high: quote.high,
              low: quote.low,
              change: quote.change,
              changePct: quote.changePct,
              companyName: quote.companyName,
              asOf: quote.asOf,
              provider: "yahoo-finance-single",
              syntheticBid: quote.syntheticBid,
              syntheticAsk: quote.syntheticAsk,
              syntheticSpread: quote.syntheticSpread,
              fetchedAt: stampIngest()
            };
            updateBestQuote(symbol, q);
            acceptIfComplete(symbol, q);
          }
        }
      }
      pendingSymbols = pendingSymbols.filter((s) => !result[s]);
    } catch (error) {
      console.warn("[quotes-cascade] Level 6 (Yahoo Finance Single Chart) fetch failed:", error instanceof Error ? error.message : error);
    }
  }

  // --- LEVEL 7: ROIC.ai Profile API ---
  throwIfCascadeAborted(signal);
  if (pendingSymbols.length > 0 && allowExternal) {
    try {
      const roic = resolveApiKeyWithSource("roic", userId);
      if (roic.key) {
        await Promise.all(
          pendingSymbols.map(async (symbol) => {
            try {
              const res = await fetchWithRetry(
                `https://api.roic.ai/v2/company/profile/${encodeURIComponent(symbol)}?apikey=${encodeURIComponent(roic.key!)}`,
                { signal },
                { service: "roic", keySource: roic.source, userId }
              );
              if (res.ok) {
                const profile = await res.json();
                const p = Array.isArray(profile) ? profile[0] : profile;
                if (p && typeof p === "object") {
                  const price = firstNumber(p, ["price"]);
                  if (typeof price === "number" && price > 0) {
                    const companyName = typeof p.companyName === "string" ? p.companyName : undefined;
                    const q: BrokerQuote = {
                      symbol,
                      price,
                      companyName,
                      asOf: new Date().toISOString(),
                      provider: "roic",
                      fetchedAt: stampIngest()
                    };
                    updateBestQuote(symbol, q);
                    acceptIfComplete(symbol, q);
                  }
                }
              }
            } catch (err) {
              console.warn(`[quotes-cascade] Level 7 (ROIC) fetch failed for ${symbol}:`, err);
            }
          })
        );
        pendingSymbols = pendingSymbols.filter((s) => !result[s]);
      }
    } catch (error) {
      console.warn("[quotes-cascade] Level 7 (ROIC) fetch failed:", error instanceof Error ? error.message : error);
    }
  }

  // --- FALLBACK ---
  // For any symbols that could not be resolved to a fresh quote (e.g. during market close / weekend),
  // fall back to the freshest quote found across any level (even if older than the freshness bar).
  // Prefer venue-authoritative when present.  Yahoo on this path is delayed fallback:
  // stamp it so approval cards say so, and keep trading (owner 2026-08-18).
  for (const symbol of normalizedSymbols) {
    if (!result[symbol]) {
      const best = bestQuotes[symbol];
      if (best) {
        const fallback: BrokerQuote = {
          ...best,
          fetchedAt: best.fetchedAt ?? fetchedAtIso
        };
        if (isYahooFallbackProvider(best.provider)) {
          fallback.delayedFallback = true;
        }
        result[symbol] = fallback;
      }
    }
  }

  syncQuotesToFieldStore(result);
  return result;
}
