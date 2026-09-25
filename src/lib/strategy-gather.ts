import {
  STRATEGY_GATHER_DEADLINE_MS,
  STRATEGY_GATHER_QUOTE_FALLBACK_MS,
  STRATEGY_GATHER_TIMEOUT_MESSAGE
} from "./gather-budget";
import { withDeadline } from "./inflight-deadline";
import { newestPersistedMarketScan } from "./market-scan-freshness";
import { mergeQuoteData, scanMarket } from "./market";
import { normalizeSymbol } from "./money";
import { fetchFreshQuotesCascade } from "./quotes-cascade";
import type { EquityPosition, IndexUniverse, MarketScan, ScoringWeights, TradingPolicy, UniverseFloor } from "./types";

export {
  STRATEGY_GATHER_DEADLINE_MS,
  STRATEGY_GATHER_FULL_POOL_MIN_MS,
  STRATEGY_GATHER_KEYED_WAVE_MIN_MS,
  STRATEGY_GATHER_LIVE_ENRICH_MIN_MS,
  STRATEGY_GATHER_QUOTE_FALLBACK_MS,
  STRATEGY_GATHER_RETURN_RESERVE_MS,
  STRATEGY_GATHER_SCARCE_WAVE_MIN_MS,
  STRATEGY_GATHER_TIMEOUT_MESSAGE,
  enrichmentPlanForDeadline,
  gatherRemainingMs,
  planGatherEnrichment
} from "./gather-budget";

export type StrategyGatherResult = {
  baseMarketScan: MarketScan;
  marketScan: MarketScan;
  usedLastGood: boolean;
  lastGoodAt?: string;
};

export type StrategyGatherInput = {
  allowedSymbols: string[];
  positions: EquityPosition[];
  scanWeights: ScoringWeights;
  userId: string;
  dynamicUniverses: IndexUniverse[];
  connectedAccountId?: string;
  accountNumber?: string;
  candidateLimit?: number;
  outlierReserve?: number;
  universeFloor?: UniverseFloor;
  congressMultiplier?: number;
  deadlineMs?: number;
  quoteFallbackMs?: number;
};

function uniqueSymbols(symbols: string[]): string[] {
  return Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean)));
}

export function throwIfGatherAborted(signal: AbortSignal | undefined, message = STRATEGY_GATHER_TIMEOUT_MESSAGE): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(message);
}

function withLastGoodWarning(scan: MarketScan, lastGoodAt: string, deadlineMs: number): MarketScan {
  const warning =
    `Live gather timed out after ${deadlineMs}ms; using the last completed scan from ${lastGoodAt} and a short quote refresh.`;
  // Defense in depth: `newestPersistedMarketScan` (market-scan-freshness.ts) already validates/
  // normalizes the persisted payload so `scan.warnings` should always be a real array by the time
  // it reaches here, but this is the exact spread that threw "scan.warnings is not iterable" in
  // production when an unvalidated `{ omitted: true, ... }` audit-bounded summary was mistaken for
  // a full scan — never let a missing/malformed `warnings` array crash a last-good fallback.
  const existingWarnings = Array.isArray(scan.warnings) ? scan.warnings : [];
  return {
    ...scan,
    warnings: [...existingWarnings, warning]
  };
}

async function refreshTopCandidateQuotes(
  scan: MarketScan,
  input: StrategyGatherInput,
  signal: AbortSignal
): Promise<MarketScan> {
  const quoteSymbols = uniqueSymbols(scan.topCandidates.map((quote) => quote.symbol));
  throwIfGatherAborted(signal);
  const quotes = await fetchFreshQuotesCascade(
    quoteSymbols,
    input.userId,
    input.accountNumber,
    input.connectedAccountId,
    { signal }
  );
  throwIfGatherAborted(signal);
  return mergeQuoteData(scan, quotes);
}

/**
 * Scan + fresh top-candidate quotes for one strategy run.
 *
 * The 8-minute deadline MUST abort the in-flight work.  `withDeadline` without a
 * controller is a pure race: the caller marks the run failed and the next account
 * starts another full scan while the abandoned Nasdaq/enrichment/broker walk keeps
 * the sockets and the event loop.  That pile-up is why Roth + Paper spent 2026-08-21
 * RTH on `strategy gather timeout` after both completed the prior close.
 *
 * When the live scan still cannot finish, reuse the newest persisted MarketScan
 * (real last tape, not a fabricated book) plus a short quote refresh so Green can
 * start.  No last-good row still fails the run — there is nothing honest to decide on.
 */
export async function gatherStrategyMarket(input: StrategyGatherInput): Promise<StrategyGatherResult> {
  const deadlineMs = input.deadlineMs ?? STRATEGY_GATHER_DEADLINE_MS;
  const quoteFallbackMs = input.quoteFallbackMs ?? STRATEGY_GATHER_QUOTE_FALLBACK_MS;
  const deadlineAt = Date.now() + deadlineMs;
  const controller = new AbortController();
  const { signal } = controller;

  try {
    return await withDeadline(
      (async () => {
        const scanned = await scanMarket(
          input.allowedSymbols,
          input.positions,
          input.scanWeights,
          input.userId,
          input.dynamicUniverses,
          {
            candidateLimit: input.candidateLimit,
            outlierReserve: input.outlierReserve,
            universeFloor: input.universeFloor,
            congressMultiplier: input.congressMultiplier,
            signal,
            deadlineAt
          }
        );
        throwIfGatherAborted(signal);
        return {
          baseMarketScan: scanned,
          marketScan: await refreshTopCandidateQuotes(scanned, input, signal),
          usedLastGood: false
        };
      })(),
      deadlineMs,
      STRATEGY_GATHER_TIMEOUT_MESSAGE,
      { controller }
    );
  } catch (error) {
    const timedOut =
      error instanceof Error && error.message === STRATEGY_GATHER_TIMEOUT_MESSAGE;
    if (!timedOut) throw error;

    const lastGood = newestPersistedMarketScan(input.userId, input.connectedAccountId);
    if (!lastGood) throw error;

    const seeded = withLastGoodWarning(lastGood.scan, lastGood.entry.createdAt, deadlineMs);
    const quoteController = new AbortController();
    let marketScan = seeded;
    try {
      marketScan = await withDeadline(
        refreshTopCandidateQuotes(seeded, input, quoteController.signal),
        quoteFallbackMs,
        "strategy gather quote fallback timeout",
        { controller: quoteController }
      );
    } catch {
      // Last-good prices stay.  A second hang must not fail the run after we already
      // chose the honest tape over an empty gather.
    }
    return {
      baseMarketScan: seeded,
      marketScan,
      usedLastGood: true,
      lastGoodAt: lastGood.entry.createdAt
    };
  }
}

export function gatherPolicySlice(policy: Pick<
  TradingPolicy,
  "marketScanCandidateLimit" | "marketScanOutlierReserve" | "universeFloor" | "accountNumber"
>): Pick<StrategyGatherInput, "candidateLimit" | "outlierReserve" | "universeFloor" | "accountNumber"> {
  return {
    candidateLimit: policy.marketScanCandidateLimit,
    outlierReserve: policy.marketScanOutlierReserve,
    universeFloor: policy.universeFloor,
    accountNumber: policy.accountNumber
  };
}
