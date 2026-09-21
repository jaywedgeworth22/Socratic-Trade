"use client";

/** Macro — the market-regime and macro-indicator board. Everything here is
 *  computed server-side from free sources (FRED, Cboe, CFTC, Kenneth French,
 *  Massive) — the exact inputs the strategist reads. Rules: every value gets a
 *  plain-language explanation of what it is AND what its current reading
 *  typically implies; missing data renders as "—", never an estimate; when the
 *  FRED feed is unsourced the backend's placeholder constants are blanked
 *  rather than shown next to real numbers. */

import Link from "next/link";
import type { MarketSignals } from "@/lib/market-signals";
import type { MarketNewsItem } from "@/lib/market-signals/massive";
import { fmtPct, EM_DASH } from "../lib/format";
import { CONSOLE_PAGE_WIDTH } from "../lib/page-width";
import { useConsoleData } from "../lib/useConsoleData";
import { Ago, Card, Chip, Empty } from "../ui/primitives";
import { SymbolButton } from "../ui/symbol-drilldown";
import {
  buildSections,
  macroSourcing,
  numFrom,
  regimeInfo,
  REGIME_USAGE,
  type Board,
  type MacroSourcing,
  type Tile,
  type TileTone
} from "./indicators";
import { TrendsCard } from "./trends";
import { destinationLabel } from "../components/nav";
import { WeeklyDigestCard } from "../components/weekly-digest-card";

export const metadata = { title: "Macro" };

export default function MacroPage() {
  const { snapshot, error } = useConsoleData();
  if (!snapshot) return null;
  const board = snapshot.macroBoard;

  return (
    <div className={`${CONSOLE_PAGE_WIDTH} flex flex-col gap-4`}>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">{destinationLabel("/console/macro")}</h1>
        <span
          className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
          title="The macro and market-regime board: rates, inflation, volatility, positioning, breadth — the same inputs the strategist reads on every run."
        >
          the market backdrop the strategist trades against
        </span>
        {board && (macroSourcing(board).fred || macroSourcing(board).treasury || macroSourcing(board).bls) && board.macro.asOf && (
          <>
            <div className="flex-1" />
            <span
              className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
              title="Publication date of the FRED macro suite.  Macro series update on different schedules (daily yields, monthly CPI), so this is the fetch date, not every series' vintage.">
              macro as of {board.macro.asOf}
            </span>
          </>
        )}
      </div>

      {error && (
        <div
          className="rounded-[var(--con-radius-sm)] border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] px-3 py-2 text-[length:var(--con-fs-sm)] text-[color:var(--con-warn)]"
          title={error}
        >
          Live refresh is failing — showing the last good snapshot. The console keeps retrying automatically.
        </div>
      )}

      {!board ? <NoBoardYet /> : <BoardView board={board} snapshot={{ regimeScorecard: snapshot.regimeScorecard }} />}
    </div>
  );
}

function NoBoardYet() {
  return (
    <Card title={<span title="Computed on the server with every dashboard refresh — no strategy run required.">Macro &amp; market regime</span>}>
      <Empty>
        No macro board in this snapshot yet. It is computed on the server with every dashboard refresh (FRED macro,
        Cboe, CFTC, factor and breadth feeds) and should appear within one refresh (~15s). If it stays missing, the
        server is likely running an older build that doesn&apos;t send it. Nothing is estimated in the meantime.
      </Empty>
    </Card>
  );
}

// ── Board ────────────────────────────────────────────────────────────────────

function BoardView({
  board,
  snapshot
}: {
  board: Board;
  snapshot: { regimeScorecard?: Array<{ regime: string; trades: number; winRate: number; avgReturnPct: number }> };
}) {
  const sourcing = macroSourcing(board);
  const sections = buildSections(board, sourcing);

  return (
    <>
      <RegimeCard board={board} sourcing={sourcing} regimeScorecard={snapshot.regimeScorecard} />
      <WeeklyDigestCard />
      {!sourcing.fred && <UnsourcedNotice vixLive={sourcing.vix} treasuryLive={sourcing.treasury} blsLive={sourcing.bls} />}
      <TrendsCard history={board.history} />
      {sections.map((s) => (
        <Card key={s.id} title={<span title={s.desc}>{s.title}</span>}>
          <TileGrid tiles={s.tiles} />
        </Card>
      ))}
      <BreadthCard signals={board.signals} />
      <NewsCard news={board.news} />
      <p className="text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-faint)]">
        All values are computed server-side from free sources — FRED (macro), Cboe (SKEW/VVIX), CFTC (futures
        positioning, weekly), Kenneth French (factor returns, ~6-week publication lag), and Massive (full-market
        breadth and news) — the same inputs fed to the strategist. Missing values render as {EM_DASH}, never estimates.
      </p>
    </>
  );
}

function UnsourcedNotice({
  vixLive,
  treasuryLive,
  blsLive
}: {
  vixLive: boolean;
  treasuryLive: boolean;
  blsLive: boolean;
}) {
  const anyKeyless = vixLive || treasuryLive || blsLive;
  // Build the "what's still live" clause as a list rather than enumerating every combination —
  // scales cleanly as more key-free fallbacks (Treasury, BLS, ...) get added over time.
  const liveClauses: string[] = [];
  if (vixLive) liveClauses.push("the VIX (fetched key-free from Yahoo/Cboe)");
  if (treasuryLive) liveClauses.push("the 3M/2Y/10Y Treasury yields and the two curves computed from them (fetched key-free from Treasury.gov)");
  if (blsLive) liveClauses.push("CPI, unemployment, and nonfarm payrolls (fetched from BLS, keyless or lightly-keyed)");
  const liveList =
    liveClauses.length <= 1
      ? liveClauses[0]
      : liveClauses.length === 2
        ? `${liveClauses[0]} and ${liveClauses[1]}`
        : `${liveClauses.slice(0, -1).join(", ")}, and ${liveClauses[liveClauses.length - 1]}`;

  return (
    <div className="rounded-[var(--con-radius-sm)] border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] px-3 py-2 text-[length:var(--con-fs-sm)]">
      <span className="font-semibold text-[color:var(--con-warn)]">
        {anyKeyless ? "FRED macro feed unsourced — partial key-free data only." : "Macro feed unsourced."}
      </span>{" "}
      <span className="text-[color:var(--con-muted)]">
        {anyKeyless ? (
          <>
            No FRED API key is configured. {liveList} {liveClauses.length > 1 ? "are" : "is"} still live, but every
            other FRED-based tile below shows {EM_DASH} instead of the backend&apos;s placeholder constants — this
            board never shows fabricated numbers. The regime label is degraded too: its yield-curve-vs-Fed-funds
            input needs a FRED key for the Fed funds rate, so treat the label as {vixLive ? "VIX" : "partial"}-informed
            only.{" "}
          </>
        ) : (
          <>
            No FRED API key is configured and every key-free fallback lookup (VIX, Treasury yield curve, BLS) failed
            too, so the regime reads &quot;Unknown&quot;. The FRED-based tiles below show {EM_DASH} instead of the
            backend&apos;s placeholder constants — this board never shows fabricated numbers.{" "}
          </>
        )}
        Signals from other free sources (Cboe, CFTC, factors, breadth, news) still show real readings. Add a FRED key
        under{" "}
        <Link href="/console/connections" className="font-semibold text-[color:var(--con-accent)] hover:underline" title="Connections → API keys">
          Connections
        </Link>{" "}
        to light the rest up.
      </span>
    </div>
  );
}

// ── Regime card ──────────────────────────────────────────────────────────────

function RegimeCard({
  board,
  sourcing,
  regimeScorecard
}: {
  board: Board;
  sourcing: MacroSourcing;
  regimeScorecard?: Array<{ regime: string; trades: number; winRate: number; avgReturnPct: number }>;
}) {
  const info = regimeInfo(board.regime);
  const vix = sourcing.vix ? numFrom(board.macro.vix) : undefined;
  const curve = sourcing.fred ? board.derived.yieldCurveSpread : undefined;
  const inverted = typeof curve === "number" && curve < -0.1;
  // Exact-string join: both `r.regime` (scorecard) and `board.regime` are `entryMarketRegime`-
  // derived values from MARKET_REGIME_LABELS (src/lib/macro.ts) — a persisted contract. See that
  // const's doc comment before renaming a label; existing rows would silently stop matching.
  const stat = regimeScorecard?.find((r) => r.regime === board.regime);
  // VIX-only fallback: the backend still computed this label, but its yield-curve
  // input was a placeholder constant — say so instead of presenting it as fully backed.
  const degraded = !sourcing.fred && sourcing.vix && !board.regime.toLowerCase().includes("unknown");

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="con-card-title" title="A deterministic label recomputed from VIX and the yield curve on every run — not an LLM opinion.">
            Current market regime
          </div>
          <div className="mt-1 text-[length:var(--con-fs-xl)] font-bold leading-tight" title={info.meaning}>
            {board.regime}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {degraded && (
            <Chip
              tone="warn"
              title="No FRED feed: the backend computed this label from a live VIX but a PLACEHOLDER yield curve.  Curve-driven effects (Cautious / Risk-Off tilts from inversion) cannot be trusted — treat the label as VIX-informed only."
            >
              degraded — curve input unsourced
            </Chip>
          )}
          <Chip
            tone={info.chipTone}
            title={
              info.chipWord === "escalation"
                ? "Escalation regimes (Risk-Off, Crisis, Inverted) get extra brakes: entry vetoes, optional exposure caps, and flip-triggered runs."
                : info.chipWord === "no data"
                  ? "The classifier has no macro feed to read, so it refuses to guess."
                  : "No regime-specific vetoes or caps apply right now."
            }
          >
            {info.chipWord}
          </Chip>
        </div>
      </div>

      <p className="mt-2 text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]">{info.meaning}</p>
      {degraded && (
        <p
          className="mt-1 text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-warn)]"
          title="The strategist consumes the same label, so this limitation applies to its regime-conditioned behavior too — a recorded backend follow-up."
        >
          Caution: this label was computed without a real yield curve (no FRED key) — only the VIX input was live.
          A curve-only regime read is not possible, so curve-driven tilts in this label are unreliable.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]" title="The only two inputs the classifier reads.">
          classifier inputs:
        </span>
        <Chip
          tone={typeof vix === "number" ? (vix > 30 ? "neg" : vix > 20 ? "warn" : vix < 13 ? "pos" : "muted") : "muted"}
          title="30-day expected S&P 500 volatility — the fear gauge.  Bands: below 13 Risk-On, 13–20 normal, above 20 Risk-Off, above 30 Crisis."
        >
          VIX {typeof vix === "number" ? vix.toFixed(2) : EM_DASH}
        </Chip>
        <Chip
          tone={typeof curve === "number" ? (inverted ? "neg" : "pos") : "muted"}
          title={`10Y Treasury yield minus the Fed's policy rate.  More than 0.10 points below zero counts as inverted and nudges the regime toward Cautious / Risk-Off.${
            typeof curve === "number" ? "" : " Unsourced in this snapshot — no FRED key."
          }`}
        >
          10Y − policy {typeof curve === "number" ? `${curve >= 0 ? "+" : ""}${curve.toFixed(2)} pp${inverted ? " · inverted" : ""}` : EM_DASH}
        </Chip>
      </div>

      {stat && stat.trades > 0 && (
        <p
          className="mt-3 border-t border-[color:var(--con-line)] pt-2 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]"
          title="From your closed trades whose entry was stamped with this exact regime label.  Small samples read with caution."
        >
          Your record in this regime: <span className="con-num font-semibold">{stat.trades}</span> closed{" "}
          {stat.trades === 1 ? "trade" : "trades"} · win rate{" "}
          <span className="con-num font-semibold">{fmtPct(stat.winRate, 0)}</span> · avg return{" "}
          <span className="con-num font-semibold">{fmtPct(stat.avgReturnPct, 2, true)}</span>{" "}
          <Link href="/console/results" className="text-[color:var(--con-accent)] hover:underline" title="Full per-regime scorecard on the Results screen">
            — full scorecard
          </Link>
        </p>
      )}

      <details className="con-disclosure mt-1">
        <summary title="Where this label actually changes behavior — sizing, vetoes, caps, and triggers.">
          How the strategist uses this label
        </summary>
        <ul className="flex flex-col gap-2 pb-2 text-[length:var(--con-fs-sm)]">
          {REGIME_USAGE.map((u) => (
            <li key={u.title} className="con-row rounded-[var(--con-radius-sm)] px-2 py-1.5" title={u.body}>
              <span className="font-semibold">{u.title}.</span>{" "}
              <span className="text-[color:var(--con-muted)]">{u.body}</span>
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

// ── Indicator tiles ──────────────────────────────────────────────────────────

const TONE_COLOR: Record<Exclude<TileTone, undefined>, string> = {
  pos: "var(--con-pos)",
  neg: "var(--con-neg)",
  warn: "var(--con-warn)"
};

function tileTooltip(t: Tile): string {
  return [t.what, t.reading ? `Now: ${t.reading}` : undefined, t.asOf ? `As of ${t.asOf}.` : undefined]
    .filter(Boolean)
    .join(" ");
}

function TileGrid({ tiles }: { tiles: Tile[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
      {tiles.map((t) => (
        <div
          key={t.key}
          className="con-row rounded-[var(--con-radius-sm)] border border-[color:var(--con-line)] p-3"
          title={tileTooltip(t)}
        >
          <div className="con-card-title">{t.label}</div>
          <div
            className="con-num mt-1 text-[length:var(--con-fs-md)] font-semibold"
            style={t.tone ? { color: TONE_COLOR[t.tone] } : undefined}
          >
            {t.value}
          </div>
          <div className="mt-1 text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">
            {t.reading ?? (t.value === EM_DASH ? "Not available in this snapshot." : t.what)}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Breadth ──────────────────────────────────────────────────────────────────

function BreadthCard({ signals }: { signals: MarketSignals }) {
  const pct = signals.marketBreadthPct;
  const hasBreadth = typeof pct === "number" || typeof signals.marketAdvancers === "number";
  const gainers = signals.marketTopGainers ?? [];
  const losers = signals.marketTopLosers ?? [];
  if (!hasBreadth && gainers.length === 0 && losers.length === 0) return null;

  const pctTone: TileTone = typeof pct === "number" ? (pct >= 55 ? "pos" : pct <= 45 ? "neg" : undefined) : undefined;
  const asOf = signals.marketBreadthAsOf;

  const tiles: Tile[] = [
    {
      key: "breadth",
      label: "Breadth (all US)",
      value: typeof pct === "number" ? `${pct}%` : EM_DASH,
      tone: pctTone,
      what: "Share of every U.S. stock that closed higher than the prior close (full-universe, not an index).",
      reading:
        typeof pct === "number"
          ? pct >= 55
            ? "Broad participation — rallies with wide breadth are healthier."
            : pct <= 45
              ? "Weak breadth — most stocks fell; narrow markets are fragile."
              : "Mixed tape."
          : undefined,
      asOf
    },
    {
      key: "advancers",
      label: "Advancers",
      value: typeof signals.marketAdvancers === "number" ? signals.marketAdvancers.toLocaleString() : EM_DASH,
      tone: typeof signals.marketAdvancers === "number" ? "pos" : undefined,
      what: "Count of U.S. stocks that closed up versus the prior close.",
      asOf
    },
    {
      key: "decliners",
      label: "Decliners",
      value: typeof signals.marketDecliners === "number" ? signals.marketDecliners.toLocaleString() : EM_DASH,
      tone: typeof signals.marketDecliners === "number" ? "neg" : undefined,
      what: "Count of U.S. stocks that closed down versus the prior close.",
      asOf
    }
  ];

  return (
    <Card
      title={
        <span title="True full-market breadth from Massive grouped daily bars — every listed U.S. stock, not just an index.  Broad participation confirms a move; narrow breadth undermines it.">
          Full-market breadth{asOf ? ` · ${asOf}` : ""}
        </span>
      }
    >
      <TileGrid tiles={tiles} />
      {(gainers.length > 0 || losers.length > 0) && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <MoverList title="Top gainers" movers={gainers} asOf={asOf} />
          <MoverList title="Top losers" movers={losers} asOf={asOf} />
        </div>
      )}
    </Card>
  );
}

function MoverList({ title, movers, asOf }: { title: string; movers: Array<{ sym: string; pct: number }>; asOf?: string }) {
  if (movers.length === 0) return null;
  return (
    <div
      className="rounded-[var(--con-radius-sm)] border border-[color:var(--con-line)] p-3"
      title={`Biggest full-market movers (volume at least 1M shares), percent versus the prior close.${asOf ? ` As of ${asOf}.` : ""}`}
    >
      <div className="con-card-title mb-2">{title}</div>
      <div className="flex flex-col">
        {movers.map((m) => (
          <div
            key={m.sym}
            className="con-row flex items-center justify-between gap-3 rounded-control px-1.5 py-1"
            title={`${m.sym} closed ${m.pct >= 0 ? "up" : "down"} ${Math.abs(m.pct).toFixed(1)}% versus the prior close.`}
          >
            <span className="text-[length:var(--con-fs-sm)] font-semibold">{m.sym}</span>
            <span
              className="con-num text-[length:var(--con-fs-xs)] font-semibold"
              style={{ color: m.pct >= 0 ? "var(--con-pos)" : "var(--con-neg)" }}
            >
              {m.pct >= 0 ? "+" : ""}
              {m.pct.toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── News ─────────────────────────────────────────────────────────────────────

function NewsCard({ news }: { news?: MarketNewsItem[] }) {
  if (!news || news.length === 0) return null;
  return (
    <Card title={<span title="Recent market-wide headlines from the Massive news feed — context only; headlines are not trade signals.">Market news</span>}>
      <ul className="flex flex-col">
        {news.map((n, i) => (
          <li
            key={`${n.url ?? n.title}-${i}`}
            className="con-row rounded-[var(--con-radius-sm)] px-2 py-2"
            title={`${n.title}${n.publisher ? ` — ${n.publisher}` : ""}${n.url ? ".  Opens the article in a new tab." : ""}`}
          >
            <div className="text-[length:var(--con-fs-sm)] leading-snug">
              {n.url ? (
                <a href={n.url} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline">
                  {n.title}
                </a>
              ) : (
                <span className="font-medium">{n.title}</span>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              {n.publisher && <span title="Publisher">{n.publisher}</span>}
              {n.publishedAt && <Ago iso={n.publishedAt} />}
              {(n.tickers ?? []).slice(0, 6).map((t) => (
                <span
                  key={t}
                  className="con-chip"
                  title={`This story mentions ${t}.`}
                >
                  <SymbolButton symbol={t} className="text-inherit" />
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
