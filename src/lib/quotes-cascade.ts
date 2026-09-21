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
import { AlpacaSnapshotEnrichmentProvider, fetchWithRetry } from "./data-providers";
import { fetchYahooFinanceQuote, fetchYahooFinanceQuotesBatch } from "./yahoo-finance";
import { normalizeSymbol } from "./money";
import {
  isDelayedYahooFallbackQuote,
  isYahooFallbackProvider
} from "./quote-delayed-fallback";
import type { BrokerQuote, ConnectedAccount, TradingPolicy } from "./types";

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
    if (!existing) {
      bestQuotes[symbol] = quote;
      return;
    }
    // Never demote a venue-authoritative quote in favor of a fresher external print.
    if (existing.venuePriceAuthoritative && !quote.venuePriceAuthoritative) return;
    if (quote.venuePriceAuthoritative && !existing.venuePriceAuthoritative) {
      bestQuotes[symbol] = quote;
      return;
    }
    // Prefer newer asOf; if equal timestamps, prefer a provider that is not an explicit delayed tag
    const existingTime = existing.asOf ? new Date(existing.asOf).getTime() : 0;
    const newTime = quote.asOf ? new Date(quote.asOf).getTime() : 0;
    if (newTime > existingTime) {
      bestQuotes[symbol] = quote;
    }
  };

  let maxAgeMs = cascadeFreshMaxAgeMs();

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
        if (isUsableBrokerQuote(normalizedQuote, nowMs, maxAgeMs)) {
          result[symbol] = normalizedQuote;
        }
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
                volume: data.volume,
                asOf: data.asOf,
                provider: "alpaca-snapshot",
                fetchedAt: stampIngest()
              };
              updateBestQuote(symbol, q);
              if (isQuoteFresh(q, nowMs, maxAgeMs)) {
                result[symbol] = q;
              }
            }
          }
        }
        pendingSymbols = pendingSymbols.filter((s) => !result[s]);
      }
    } catch (error) {
      console.warn("[quotes-cascade] Level 2 (Alpaca Snapshots) fetch failed:", error instanceof Error ? error.message : error);
    }
  }

  // --- LEVEL 3: Yahoo Finance Batch API ---
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
              asOf: data.asOf,
              provider: "yahoo-finance-batch",
              syntheticBid: data.syntheticBid,
              syntheticAsk: data.syntheticAsk,
              syntheticSpread: data.syntheticSpread,
              fetchedAt: stampIngest()
            };
            updateBestQuote(symbol, q);
            if (isQuoteFresh(q, nowMs, maxAgeMs)) {
              result[symbol] = q;
            }
          }
        }
      }
      pendingSymbols = pendingSymbols.filter((s) => !result[s]);
    } catch (error) {
      console.warn("[quotes-cascade] Level 3 (Yahoo Finance Batch) fetch failed:", error instanceof Error ? error.message : error);
    }
  }

  // --- LEVEL 4: Yahoo Finance Single Quote API ---
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
              asOf: quote.asOf,
              provider: "yahoo-finance-single",
              syntheticBid: quote.syntheticBid,
              syntheticAsk: quote.syntheticAsk,
              syntheticSpread: quote.syntheticSpread,
              fetchedAt: stampIngest()
            };
            updateBestQuote(symbol, q);
            if (isQuoteFresh(q, nowMs, maxAgeMs)) {
              result[symbol] = q;
            }
          }
        }
      }
      pendingSymbols = pendingSymbols.filter((s) => !result[s]);
    } catch (error) {
      console.warn("[quotes-cascade] Level 4 (Yahoo Finance Single Chart) fetch failed:", error instanceof Error ? error.message : error);
    }
  }

  // --- LEVEL 5: ROIC.ai Profile API ---
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
                    const q: BrokerQuote = {
                      symbol,
                      price,
                      asOf: new Date().toISOString(),
                      provider: "roic",
                      fetchedAt: stampIngest()
                    };
                    updateBestQuote(symbol, q);
                    if (isQuoteFresh(q, nowMs, maxAgeMs)) {
                      result[symbol] = q;
                    }
                  }
                }
              }
            } catch (err) {
              console.warn(`[quotes-cascade] Level 5 (ROIC) fetch failed for ${symbol}:`, err);
            }
          })
        );
        pendingSymbols = pendingSymbols.filter((s) => !result[s]);
      }
    } catch (error) {
      console.warn("[quotes-cascade] Level 5 (ROIC) fetch failed:", error instanceof Error ? error.message : error);
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

  return result;
}
