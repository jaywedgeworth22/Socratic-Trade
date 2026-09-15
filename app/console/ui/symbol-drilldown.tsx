"use client";

/** Reusable symbol drilldown for the console: a clickable ticker
 *  (<SymbolButton>) that opens a drawer with the company identity, a daily
 *  price chart over /api/history, and — when the last market scan knew the
 *  symbol — the full research drawer: your exposure (position, pending ideas,
 *  recent orders), a plain-language signal summary, the eleven backend-derived
 *  metric tiles, the seven-factor score breakdown, analyst ratings + price
 *  targets, deep fundamentals, evidence bulletins, and per-field data-source
 *  provenance. When the last scan DIDN'T know the symbol (e.g. a recently
 *  traded or held name outside the scan universe), it falls back to an
 *  on-demand single-symbol fetch over /api/quote for the fundamentals/analyst
 *  tiles — only the composite score, factor breakdown, and signal summary stay
 *  scan-only, since those rank the symbol against the scan's candidate
 *  universe. Everything degrades honestly: no history → a sentence, no
 *  quote → em dashes and a notice, never a crash or a fabricated number. */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { MarketQuote, MarketQuoteSummary } from "@/lib/types";
import { useConsoleDataOptional } from "../lib/useConsoleData";
import { cx, fmtMoney, fmtPct, EM_DASH } from "../lib/format";
import { Chip } from "./primitives";
import { useSymbolDrawer } from "./symbol-drawer";
import { TickerLogo } from "./ticker-logo";
import { deriveForView, hasEnrichedData, preferFreshQuote, toQuoteView, toQuoteViewFromEnrichment, withProvenance, type QuoteView } from "./drilldown-data";
import {
  AnalystSection,
  DerivedTilesSection,
  EvidenceSection,
  ExitPlanSection,
  ExposureSection,
  FactorSection,
  LastCallSection,
  FundamentalsSection,
  PeerAccountsSection,
  SignalSummarySection,
  SourcesSection
} from "./drilldown-sections";
import { activateAccount, redirectToLogin } from "../lib/api";
import { deriveProtection } from "../lib/derive";
import type { SymbolDesk } from "@/lib/symbol-desk";

// ── Data ─────────────────────────────────────────────────────────────────────

interface HistoryBar {
  time: string; // YYYY-MM-DD
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
}

type HistoryState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error" }
  | { status: "ready"; bars: HistoryBar[] };

function useHistory(symbol: string, enabled: boolean): HistoryState {
  const [state, setState] = useState<HistoryState>({ status: "loading" });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    (async () => {
      try {
        const res = await fetch(`/api/history?symbol=${encodeURIComponent(symbol)}`, { signal: controller.signal });
        if (res.status === 401) {
          redirectToLogin();
          return;
        }
        if (!res.ok) throw new Error(`history ${res.status}`);
        const json: { bars?: HistoryBar[] } = await res.json();
        const bars = (json.bars ?? []).filter((b) => typeof b.close === "number" && Number.isFinite(b.close));
        if (controller.signal.aborted) return;
        setState(bars.length >= 2 ? { status: "ready", bars } : { status: "empty" });
      } catch (err) {
        if (!controller.signal.aborted) setState({ status: "error" });
      }
    })();
    return () => controller.abort();
  }, [symbol, enabled]);

  return state;
}

type EnrichmentState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error" }
  | { status: "ready"; view: QuoteView };

/** On-demand single-symbol quote+fundamentals fetch (/api/quote), used ONLY when the
 *  last market scan didn't know the symbol at all — e.g. a recently traded or held
 *  name outside the scan universe. Never fetched when the scan already has the symbol. */
function useOnDemandEnrichment(symbol: string, enabled: boolean): EnrichmentState {
  const [state, setState] = useState<EnrichmentState>(() => (enabled ? { status: "loading" } : { status: "idle" }));

  useEffect(() => {
    if (!enabled) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    (async () => {
      try {
        const res = await fetch(`/api/quote?symbol=${encodeURIComponent(symbol)}`, { signal: controller.signal });
        if (res.status === 401) {
          redirectToLogin();
          return;
        }
        if (!res.ok) throw new Error(`quote ${res.status}`);
        const json: Record<string, unknown> = await res.json();
        if (controller.signal.aborted) return;
        const view = toQuoteViewFromEnrichment(symbol, json);
        setState(hasEnrichedData(view) ? { status: "ready", view } : { status: "empty" });
      } catch (err) {
        if (!controller.signal.aborted) setState({ status: "error" });
      }
    })();
    return () => controller.abort();
  }, [symbol, enabled]);

  return state;
}

/** Best-available quote summary for a symbol from the snapshot's last scan. */
function resolveQuote(
  quotesBySymbol: Record<string, MarketQuoteSummary> | undefined,
  symbol: string
): MarketQuoteSummary | null {
  if (!quotesBySymbol) return null;
  const normalized = symbol.trim().toUpperCase();
  return (
    quotesBySymbol[normalized] ??
    Object.values(quotesBySymbol).find((q) => q.symbol?.trim().toUpperCase() === normalized) ??
    null
  );
}

/** Fully-enriched top-candidate quote (factor breakdown, volume, headlines)
 *  when the symbol made the last scan's candidate list. */
function resolveFullQuote(candidates: MarketQuote[] | undefined, symbol: string): MarketQuote | undefined {
  const normalized = symbol.trim().toUpperCase();
  return candidates?.find((q) => q.symbol?.trim().toUpperCase() === normalized);
}

// ── Chart ────────────────────────────────────────────────────────────────────

const TIMEFRAMES = ["1M", "6M", "1Y", "All"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

function cutoffFor(tf: Timeframe, lastDay: string): string | null {
  if (tf === "All") return null;
  const d = new Date(`${lastDay}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return null;
  if (tf === "1M") d.setUTCMonth(d.getUTCMonth() - 1);
  else if (tf === "6M") d.setUTCMonth(d.getUTCMonth() - 6);
  else d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

const W = 640;
const H = 180;
const PAD = 6;

/** Self-contained SVG close-price line (same honest style as EquityChart):
 *  no interpolation, fewer than two visible points renders a sentence. */
function PriceHistoryChart({ bars }: { bars: HistoryBar[] }) {
  const [tf, setTf] = useState<Timeframe>("1Y");

  const visible = useMemo(() => {
    const cutoff = cutoffFor(tf, bars[bars.length - 1].time);
    const inRange = cutoff ? bars.filter((b) => b.time >= cutoff) : bars;
    // A recent IPO may have no bars inside the window — fall back to everything.
    return inRange.length >= 2 ? inRange : bars;
  }, [bars, tf]);

  const vMin = Math.min(...visible.map((b) => b.close));
  const vMax = Math.max(...visible.map((b) => b.close));
  const vSpan = vMax - vMin || 1;
  const x = (i: number) => PAD + (i / (visible.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - vMin) / vSpan) * (H - PAD * 2);
  const path = visible.map((b, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(b.close).toFixed(1)}`).join(" ");
  const first = visible[0].close;
  const last = visible[visible.length - 1].close;
  const changePct = first > 0 ? ((last - first) / first) * 100 : undefined;
  const rising = last >= first;
  const stroke = rising ? "var(--con-pos)" : "var(--con-neg)";

  return (
    <figure>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="con-num text-[length:var(--con-fs-xs)]" style={{ color: stroke }}>
          {changePct !== undefined ? `${fmtPct(changePct, 1, true)} over ${tf === "All" ? "all history" : tf}` : EM_DASH}
        </span>
        <div className="flex items-center gap-1">
          {TIMEFRAMES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTf(t)}
              title={t === "All" ? "Show all available daily history" : `Show the last ${t === "1M" ? "month" : t === "6M" ? "6 months" : "year"}`}
              className={cx(
                "rounded px-2 py-0.5 text-[length:var(--con-fs-xs)] font-semibold transition-colors",
                t === tf
                  ? "bg-[color:var(--con-accent-soft)] text-[color:var(--con-accent)]"
                  : "text-[color:var(--con-faint)] hover:text-[color:var(--con-fg)]"
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)]"
        role="img"
        aria-label={`Daily closes from ${fmtMoney(first)} to ${fmtMoney(last)}`}
      >
        <path d={path} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <figcaption className="con-num mt-1 flex justify-between text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        <span>
          {visible[0].time} · {fmtMoney(first)}
        </span>
        <span>
          low {fmtMoney(vMin)} · high {fmtMoney(vMax)}
        </span>
        <span>
          {visible[visible.length - 1].time} · {fmtMoney(last)}
        </span>
      </figcaption>
    </figure>
  );
}

// ── Drilldown drawer ─────────────────────────────────────────────────────────

export function SymbolDrilldownSheet({
  symbol,
  quote
}: {
  symbol: string;
  /** Optional: the quote object the opening screen is currently rendering
   *  (e.g. a freshly fetched /api/scan row). When provided — and not older
   *  than the snapshot's run-captured quote — the sheet renders from it, so
   *  the drilldown can never disagree with the row the user clicked. */
  quote?: MarketQuote;
}) {
  // Optional: /admin mounts SymbolDrawerProvider without ConsoleDataProvider (no dashboard
  // snapshot fetch there by design — see app/admin/layout.tsx). `hasAccountData` distinguishes
  // "no provider, so exposure is genuinely unknown" from "provider present, snapshot just hasn't
  // loaded/has nothing" — the two need different copy below (see ExposureSection call).
  const consoleData = useConsoleDataOptional();
  const hasAccountData = consoleData !== null;
  const snapshot = consoleData?.snapshot ?? null;
  const { updateDrawerTitle } = useSymbolDrawer();
  const normalized = symbol.trim().toUpperCase();
  const history = useHistory(normalized, true);

  const scan = snapshot?.latestStrategyRun?.marketScan;
  const override = quote && quote.symbol?.trim().toUpperCase() === normalized ? quote : undefined;
  const fullQuote = preferFreshQuote(override, resolveFullQuote(scan?.topCandidates, normalized));
  const usingOverride = override !== undefined && fullQuote === override;
  const summaryQuote = resolveQuote(scan?.quotesBySymbol, normalized);
  const scanView = useMemo(() => toQuoteView(fullQuote, summaryQuote ?? undefined), [fullQuote, summaryQuote]);
  // The last scan didn't know this symbol at all (e.g. a recently traded or held name
  // outside the scan universe) — fetch minimal live enrichment for it on demand.
  // Factor scores + signals stay scan-only (see the content block below); everything
  // else here degrades honestly through hasEnrichedData.
  const enrichment = useOnDemandEnrichment(normalized, scanView === null);
  const onDemandView = enrichment.status === "ready" ? enrichment.view : null;
  // Best-available view for the price line / score chip / sector line / footer below.
  const view = scanView ?? onDemandView;
  const companyName = resolveDrilldownCompanyName(scanView, onDemandView);

  // The drawer title is created when the ticker is clicked, before an out-of-scan
  // symbol's on-demand identity exists. Refresh only the matching open drawer once
  // the provider response supplies the issuer name; the aria-label guard prevents a
  // late response from renaming a newer drawer.
  useEffect(() => {
    if (!companyName) return;
    updateDrawerTitle(
      `${normalized} details`,
      <SymbolDrilldownTitle symbol={normalized} companyName={companyName} />
    );
  }, [companyName, normalized, updateDrawerTitle]);

  const [desk, setDesk] = useState<SymbolDesk | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setDesk(null);
    void (async () => {
      try {
        const res = await fetch(`/api/symbol-desk?symbol=${encodeURIComponent(normalized)}`, { signal: controller.signal });
        if (res.status === 401) {
          redirectToLogin();
          return;
        }
        if (!res.ok) return;
        const json = (await res.json()) as SymbolDesk;
        if (!controller.signal.aborted) setDesk(json);
      } catch (err) {
        // Desk extras are optional — the sheet still shows quote, position, and scan research.
      }
    })();
    return () => controller.abort();
  }, [normalized]);

  const position = snapshot?.positions?.find((p) => p.symbol.trim().toUpperCase() === normalized);
  const protection =
    position && snapshot
      ? deriveProtection(
          position,
          snapshot.orders ?? [],
          snapshot.policy,
          snapshot.stopPlanBySymbol?.[normalized] ?? snapshot.stopPlanBySymbol?.[position.symbol]
        )
      : null;
  const pending = useMemo(
    () => (snapshot?.pendingProposals ?? []).filter((p) => p.proposal.symbol.trim().toUpperCase() === normalized),
    [snapshot?.pendingProposals, normalized]
  );
  const recentOrders = useMemo(
    () =>
      (snapshot?.orders ?? [])
        .filter((o) => o.symbol?.trim().toUpperCase() === normalized)
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
        .slice(0, 4),
    [snapshot?.orders, normalized]
  );
  // Current price: prefer the scan quote; otherwise the last daily close.
  const lastBars = history.status === "ready" ? history.bars : [];
  const lastBar = lastBars.length > 0 ? lastBars[lastBars.length - 1] : undefined;
  const prevClose = lastBars.length > 1 ? lastBars[lastBars.length - 2].close : undefined;
  const price = view?.price ?? lastBar?.close;

  // Day change: prefer the scan's intraday change (fully-enriched quotes only);
  // fall back to last daily close vs the previous close from real history bars.
  const scanChangePct = view?.intradayChangePct;
  const historyChangePct =
    typeof lastBar?.close === "number" && typeof prevClose === "number" && prevClose > 0
      ? ((lastBar.close - prevClose) / prevClose) * 100
      : undefined;
  const dayChangePct = scanChangePct ?? historyChangePct;
  const dayChangeTitle =
    scanChangePct !== undefined && view
      ? withProvenance(
          scanView ? "Intraday % change captured by the last market scan." : "Intraday % change from an on-demand fetch.",
          view,
          "intradayChangePct"
        )
      : "Last daily close vs the previous daily close, from the price history.";

  const derived = view ? deriveForView(view, lastBar?.volume) : null;
  const earningsSoon = typeof view?.daysToEarnings === "number" && view.daysToEarnings <= 7;

  return (
    <div className="flex flex-col gap-4">
        {/* Price line */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span
            className="con-num text-[length:var(--con-fs-xl)] font-semibold leading-tight cursor-default"
            title={
              view
                ? withProvenance(
                    usingOverride
                      ? "Latest price from the scan currently on screen."
                      : scanView
                        ? "Latest price known to the last market scan."
                        : "Latest price from an on-demand fetch (this symbol wasn't in the last market scan).",
                    view,
                    "price"
                  )
                : "Latest daily close from the price history."
            }
          >
            {fmtMoney(price)}
          </span>
          {typeof dayChangePct === "number" && (
            <span
              className="con-num cursor-default text-[length:var(--con-fs-sm)] font-semibold"
              style={{ color: dayChangePct >= 0 ? "var(--con-pos)" : "var(--con-neg)" }}
              title={dayChangeTitle}
            >
              {fmtPct(dayChangePct, 2, true)}
              {scanChangePct === undefined ? " last close" : " today"}
            </span>
          )}
          {typeof view?.score === "number" && (
            <Chip
              tone="accent"
              title="Composite 0–100 score from the last market scan — the policy-weighted total of the factor breakdown below.  Higher = the screener ranked it more attractive."
            >
              Score {Math.round(view.score)}
            </Chip>
          )}
          {earningsSoon && typeof view?.daysToEarnings === "number" && (
            <Chip
              tone="warn"
              title={withProvenance(
                "Trading days until the next scheduled earnings report.  Prices can gap sharply on the report — entries this close to earnings carry extra risk.",
                view,
                "daysToEarnings"
              )}
            >
              Earnings in {Math.round(view.daysToEarnings)}d
            </Chip>
          )}
          {view?.sector && (
            <span
              className="cursor-default text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
              title={withProvenance("Sector and industry classification.", view, "sector")}
            >
              {view.sector}
              {view.industry && view.industry !== view.sector ? ` · ${view.industry}` : ""}
            </span>
          )}
        </div>

        {/* Chart */}
        {history.status === "loading" && (
          <p className="py-8 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">
            Loading price history…
          </p>
        )}
        {history.status === "empty" && (
          <p className="py-8 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">
            No price history is available for {normalized} yet.
          </p>
        )}
        {history.status === "error" && (
          <p className="py-8 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">
            Couldn&apos;t load price history for {normalized}.
          </p>
        )}
        {history.status === "ready" && <PriceHistoryChart bars={history.bars} />}

        {/* Your exposure — account truth, available even when the scan didn't know the symbol.
            Outside the console (no ConsoleDataProvider) there is no account snapshot to read at
            all, so say that plainly instead of letting ExposureSection's normal empty state
            ("no position, no pending ideas, no recent orders") assert a negative it can't know. */}
        {hasAccountData ? (
          <>
            <ExposureSection symbol={normalized} position={position} pending={pending} orders={recentOrders} />
            {protection && (
              <ExitPlanSection symbol={normalized} protection={protection} exit={desk?.exit} />
            )}
            <PeerAccountsSection
              symbol={normalized}
              peers={desk?.peerAccounts ?? []}
              onSwitch={(accountId) => {
                void activateAccount(accountId);
              }}
            />
            <LastCallSection lastCall={desk?.lastCall} />
          </>
        ) : (
          <p className="text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">
            Account exposure (position, pending ideas, recent orders) isn&apos;t available here — open{" "}
            {normalized} from the console for that.
          </p>
        )}

        {scanView && derived ? (
          <>
            <SignalSummarySection view={scanView} derived={derived} />
            <DerivedTilesSection view={scanView} derived={derived} />
            <FactorSection view={scanView} />
            <AnalystSection view={scanView} />
            <FundamentalsSection view={scanView} />
            <EvidenceSection view={scanView} />
            <SourcesSection view={scanView} />
          </>
        ) : enrichment.status === "loading" ? (
          <p className="text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">
            {normalized} wasn&apos;t in the last market scan — fetching live fundamentals for it now…
          </p>
        ) : onDemandView && derived ? (
          <>
            {/* Factor scores + signals genuinely require a scan run (they rank this symbol
                against the candidate universe) — everything else here is real, on-demand data. */}
            <DerivedTilesSection view={onDemandView} derived={derived} />
            <AnalystSection view={onDemandView} />
            <FundamentalsSection view={onDemandView} />
            <EvidenceSection view={onDemandView} />
            <SourcesSection view={onDemandView} />
            <p className="text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">
              {"Factor scores and signals come from scan runs — run a scan that includes "}
              {normalized}
              {" for those."}
            </p>
          </>
        ) : (
          <p className="text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">
            {/* Explicit {" "} after the symbol: the literal space here was dropped at runtime
                (observed "LRCXwasn't" in prod) — same idiom as the second occurrence below. */}
            {normalized}
            {" wasn't in the last market scan, so fundamentals, factor scores, and signals aren't available yet.  The chart and your account data above are still real.  Run a scan that includes "}
            {normalized}
            {" to fill this in."}
          </p>
        )}

        {view?.asOf && (
          <p
            className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
            title="When this symbol's quote data was captured.  The chart above refreshes independently from free daily history."
          >
            Quote data from {usingOverride ? "the scan currently on screen" : scanView ? "the last market scan" : "a live on-demand fetch"} (
            {new Date(view.asOf).toLocaleString(undefined, { timeZone: "America/Chicago" })}).
          </p>
        )}
    </div>
  );
}

/** Resolve the identity rendered in the drawer header. The scan remains first
 * choice; on-demand identity fills the header for symbols outside that scan. */
export function resolveDrilldownCompanyName(
  scanView: QuoteView | null,
  onDemandView: QuoteView | null
): string | undefined {
  const name = scanView?.companyName ?? onDemandView?.companyName;
  return name?.trim() || undefined;
}

function SymbolDrilldownTitle({ symbol, companyName }: { symbol: string; companyName?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <TickerLogo symbol={symbol} size="md" />
      <span className="min-w-0">
        <span className="block leading-tight">{symbol}</span>
        {companyName && (
          <span className="block truncate text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-faint)]">
            {companyName}
          </span>
        )}
      </span>
    </span>
  );
}

// ── SymbolButton ─────────────────────────────────────────────────────────────

/** Open the company drilldown for a scan/desk ticker.  Shared by SymbolButton
 *  and the full-card scan hit target so both surfaces open the same sheet. */
export function openSymbolDetails(
  openDrawer: ReturnType<typeof useSymbolDrawer>["openDrawer"],
  symbol: string,
  quote?: MarketQuote
): void {
  const normalized = symbol.trim().toUpperCase();
  openDrawer({
    title: <SymbolDrilldownTitle symbol={normalized} companyName={quote?.companyName} />,
    ariaLabel: `${normalized} details`,
    body: <SymbolDrilldownSheet key={normalized} symbol={normalized} quote={quote} />
  });
}

/** A ticker rendered as logo + text that opens the drilldown sheet. Drop this
 *  wherever a table shows a symbol. */
export function SymbolButton({
  symbol,
  className,
  title,
  showLogo = true,
  logoSize = "sm",
  quote,
  children
}: {
  symbol: string;
  className?: string;
  title?: string;
  showLogo?: boolean;
  logoSize?: "sm" | "md" | "lg";
  /** Optional: the quote object this button's row is currently rendering
   *  (e.g. a freshly fetched /api/scan result). Passed through to the sheet
   *  so the drilldown matches the row instead of the snapshot's last run. */
  quote?: MarketQuote;
  /** Optional custom label; defaults to the symbol text. */
  children?: ReactNode;
}) {
  const { openDrawer } = useSymbolDrawer();
  const normalized = symbol.trim().toUpperCase();

  return (
    <button
      type="button"
      title={title ?? `Open ${normalized} details`}
      onClick={(e) => {
        e.stopPropagation();
        openSymbolDetails(openDrawer, normalized, quote);
      }}
      className={cx(
        "inline-flex cursor-pointer items-center gap-1.5 font-semibold underline decoration-[color:var(--con-line-strong)] decoration-1 underline-offset-[3px] transition-colors hover:text-[color:var(--con-accent)] hover:decoration-[color:var(--con-accent)]",
        className
      )}
    >
      {showLogo && <TickerLogo symbol={normalized} size={logoSize} />}
      <span>{children ?? normalized}</span>
    </button>
  );
}
