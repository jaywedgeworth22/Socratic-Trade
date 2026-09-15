"use client";

/** Live market-scan fetcher for the console's Scan destination.
 *
 *  GET /api/scan runs a fresh, read-only scan of the configured universe
 *  (screener + per-symbol enrichment; the server caches aggressively, so
 *  repeat calls are cheap, but a cold scan can take up to ~25s). The
 *  snapshot's `latestStrategyRun.marketScan` is only the scan captured at the
 *  last strategy run — this hook keeps the table current between runs.
 *  Failures never blank anything: the caller keeps rendering the last good
 *  scan and surfaces `error` as a non-blocking notice. */

import { useCallback, useEffect, useRef, useState } from "react";
import type { MarketQuote, MarketScan } from "@/lib/types";
import { isUnusableEmptyMarketScan } from "@/lib/scan-singleflight";
import { redirectToLogin } from "../lib/api";

function isMarketScan(value: unknown): value is MarketScan {
  return Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray((value as MarketScan).topCandidates) &&
      typeof (value as MarketScan).generatedAt === "string"
  );
}

async function readErrorMessage(res: Response): Promise<string> {
  // Session expiry is a status, not a body shape.  A JSON 401 must still redirect.
  if (res.status === 401) {
    redirectToLogin();
    return "Session expired.";
  }
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object") {
      const record = body as { error?: unknown; warnings?: unknown };
      const warnings = Array.isArray(record.warnings)
        ? record.warnings.filter((warning): warning is string => typeof warning === "string" && warning.length > 0)
        : [];
      if (warnings.length > 0) return warnings.join("  ");
      if (typeof record.error === "string") return record.error;
    }
  } catch {
    /* body wasn't JSON — fall through to a generic message */
  }
  if (res.status === 429) return "Scan rate limit reached — wait a minute before refreshing again.";
  return `Market scan failed (${res.status}).`;
}

export type RefreshOutcome =
  | { status: "ok"; scan: MarketScan }
  | { status: "error"; message: string }
  /** Aborted because a newer request started or the page unmounted. */
  | { status: "superseded" };

export interface LiveScan {
  /** Latest scan fetched by this page (null until the first fetch succeeds). */
  scan: MarketScan | null;
  /** A scan request is currently in flight. */
  refreshing: boolean;
  /** Last fetch error, in plain language. The previous scan stays rendered. */
  error: string | null;
  /** Run a fresh scan now. */
  refresh: () => Promise<RefreshOutcome>;
}

/** `scopeKey` identifies the account scope the scan was requested under (the
 *  active connected account + broker account number). /api/scan runs against
 *  the SERVER's current active policy, so when the user switches accounts in
 *  the chrome (this page stays mounted), a retained scan from the previous
 *  scope must be dropped and refetched — otherwise its universe and "held"
 *  chips would keep winning the newest-scan comparison. Pass null while the
 *  snapshot hasn't loaded yet. */
export function useLiveScan(scopeKey: string | null): LiveScan {
  const [scan, setScan] = useState<MarketScan | null>(null);
  // Starts true because the mount effect always kicks off a fetch — this keeps
  // the first paint on "scanning" instead of flashing an empty state.
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const lastScope = useRef<string | null>(null);

  const refresh = useCallback(async (): Promise<RefreshOutcome> => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch("/api/scan", { cache: "no-store", signal: controller.signal });
      if (!res.ok) throw new Error(await readErrorMessage(res));
      const data: unknown = await res.json();
      if (!isMarketScan(data)) throw new Error("The scan service returned an unexpected payload.");
      if (controller.signal.aborted) return { status: "superseded" };
      setScan(data);
      return { status: "ok", scan: data };
    } catch (err) {
      if ((err instanceof DOMException && err.name === "AbortError") || controller.signal.aborted) {
        return { status: "superseded" };
      }
      // Browser network failures surface unhelpful engine-specific strings
      // ("Failed to fetch", "Load failed") — translate those to a plain
      // sentence; pass real server messages through untouched.
      const raw = err instanceof Error ? err.message : "";
      const isNetwork = /load failed|failed to fetch|networkerror|network connection|aborted/i.test(raw);
      const message = isNetwork || !raw ? "Couldn't reach the scan service." : raw;
      setError(message);
      return { status: "error", message };
    } finally {
      // Only the newest request may clear the busy flag — an aborted older
      // request finishing late must not hide a still-running newer one.
      if (inFlight.current === controller) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const controllers = inFlight;
    return () => controllers.current?.abort();
  }, [refresh]);

  // Account-scope change: drop the previous scope's scan and refetch. The
  // FIRST observed scope is just recorded — the mount fetch above already ran
  // against the server's current (same) active account.
  useEffect(() => {
    if (scopeKey === null) return; // snapshot not loaded yet — nothing to compare
    if (lastScope.current === null) {
      lastScope.current = scopeKey;
      return;
    }
    if (lastScope.current !== scopeKey) {
      lastScope.current = scopeKey;
      setScan(null);
      setError(null);
      void refresh();
    }
  }, [scopeKey, refresh]);

  return { scan, refreshing, error, refresh };
}

/** Client-side mirror of `fullMarketScan()` in src/lib/dashboard.ts: the
 *  latest strategy_run audit can carry a compact/historical scan shape whose
 *  candidates lack per-quote fields (price, intraday change) and whose
 *  top-level `warnings`/counters may be absent. Only a shape the full table
 *  can render is accepted; anything else returns null so the page falls back
 *  to the live scan / loading / empty state instead of crashing. */
export function asFullMarketScan(scan: unknown): MarketScan | null {
  if (!scan || typeof scan !== "object") return null;
  const s = scan as Partial<MarketScan>;
  if (!Array.isArray(s.topCandidates) || typeof s.generatedAt !== "string") return null;
  // A 505-symbol abort with 0 quotes is a quote miss, not last-good.  Drop it
  // so the page keeps a priced scan (or the error banner) instead of painting
  // "No Candidates" / Guardrails.  A true empty universe (scanned 0) still
  // renders so the page can say so honestly.
  if (isUnusableEmptyMarketScan(s)) return null;
  // An EMPTY candidate list is a VALID scan result for an empty universe —
  // accept it so the page can render that state.  The first-candidate shape
  // check applies only when candidates are present: the compact prompt shape
  // keys candidates as {sym, px, ...}, which the table cannot render.
  if (s.topCandidates.length > 0) {
    const first = s.topCandidates[0] as Partial<MarketQuote> | undefined;
    if (typeof first?.symbol !== "string" || typeof first.price !== "number" || typeof first.intradayChangePct !== "number") {
      return null;
    }
  }
  // Older persisted runs may predate `warnings`; normalize so the page never
  // dereferences a missing array.
  return { ...(s as MarketScan), warnings: Array.isArray(s.warnings) ? s.warnings : [] };
}

/** Prefer whichever scan is newest by `generatedAt` — a strategy run that
 *  completes after the page's own refresh should win, and vice versa. */
export function newestScan(a: MarketScan | null | undefined, b: MarketScan | null | undefined): MarketScan | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const ta = Date.parse(a.generatedAt);
  const tb = Date.parse(b.generatedAt);
  if (!Number.isFinite(ta)) return b;
  if (!Number.isFinite(tb)) return a;
  return tb > ta ? b : a;
}
