"use client";

/** Scan — the market scan table plus the Smart Money feeds.
 *
 *  Data honesty rules carried over from the legacy dashboard:
 *  - The table shows the newest of (this page's own /api/scan refresh, the
 *    scan captured at the last strategy run). Freshness is labeled, never
 *    implied.
 *  - `MarketScan.source` is a `+`-joined list of the providers that actually
 *    contributed this run — displayed through the shared plain-English source
 *    formatter, never as backend ids.
 *  - A failed refresh is a non-blocking notice; the last good scan stays up.
 *  - Missing data renders as "—"; P/E's "n/a" means negative/zero earnings. */

import { useRef, useState, type KeyboardEvent } from "react";
import { RefreshCw } from "lucide-react";
import type { MarketScan } from "@/lib/types";
import type { CongressScoreVerdictRead } from "@/lib/congress-score-gate";
import { formatSourceList } from "@/lib/dashboard-ui";
import { DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT } from "@/lib/scan-settings";
import { activeConnectedAccount } from "../lib/derive";
import { cx, fmtExact, EM_DASH } from "../lib/format";
import { CONSOLE_PAGE_WIDTH } from "../lib/page-width";
import { formatScanCandidateBreakdown, scanCandidateBreakdown } from "../lib/scan";
import { useConsoleData } from "../lib/useConsoleData";
import { Ago, Btn, Card, Chip, Empty, type ChipTone } from "../ui/primitives";
import { useToast } from "../ui/toast";
import { ScanTable } from "./scan-table";
import { SmartMoneySection } from "./smart-money";
import { asFullMarketScan, newestScan, useLiveScan } from "./use-live-scan";
import { destinationLabel } from "../components/nav";
import { WeeklyDigestCard } from "../components/weekly-digest-card";

export const metadata = { title: "Scan" };

type Tab = "scan" | "smart";

export default function ScanPage() {
  const { snapshot } = useConsoleData();
  const toast = useToast();
  // Scope the live scan to the active account: /api/scan runs against the
  // server's CURRENT active policy, so switching accounts in the chrome (this
  // page stays mounted) must drop and refetch a scan taken under the previous
  // account — its universe and "held" chips would otherwise keep winning the
  // newest-scan comparison below.
  const scopeKey = snapshot
    ? `${activeConnectedAccount(snapshot)?.id ?? ""}:${snapshot.policy.accountNumber ?? ""}`
    : null;
  const live = useLiveScan(scopeKey);
  const [tab, setTab] = useState<Tab>("scan");
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  // Validate the run-captured scan before trusting it — historical/compact
  // strategy_run audits can carry a partial shape the table can't render.
  const runScan = asFullMarketScan(snapshot?.latestScan);
  const scan: MarketScan | null = newestScan(live.scan, runScan);
  const smartCount = (snapshot?.smartMoney?.congress?.length ?? 0) + (snapshot?.smartMoney?.insider?.length ?? 0);

  if (!snapshot) return null;

  const onRefresh = async () => {
    const started = Date.now();
    const outcome = await live.refresh();
    if (outcome.status === "ok") {
      const secs = Math.max(1, Math.round((Date.now() - started) / 1000));
      toast.push(
        "pos",
        "Scan refreshed",
        `${outcome.scan.topCandidates.length} candidate${outcome.scan.topCandidates.length === 1 ? "" : "s"} from ${outcome.scan.scannedSymbols} scanned symbols in ${secs}s.`
      );
    } else if (outcome.status === "error") {
      toast.push("neg", "Scan refresh failed", `${outcome.message} The last good scan stays on screen.`);
    }
  };

  // eslint-disable-next-line react-hooks/purity
  const scanAgeMs = scan ? Date.now() - Date.parse(scan.generatedAt) : 0;
  // A scan is considered fresh if it is less than 15 minutes old.
  const isFresh = scan !== null && scanAgeMs < 15 * 60 * 1000;

  const tabDefs = [
    {
      id: "scan" as Tab,
      label: scan ? `Market scan (${scan.topCandidates.length})` : "Market scan",
      title: "Screened and scored candidates from the market scan, with per-field source attribution."
    },
    {
      id: "smart" as Tab,
      label: smartCount > 0 ? `Smart money (${smartCount})` : "Smart money",
      title: "Recently disclosed congressional trades and insider (Form 4) activity — everything on file, not just scan overlaps."
    }
  ] as const;

  const onTabsKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const ids = tabDefs.map((t) => t.id);
    const next = ids[(ids.indexOf(tab) + (e.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length];
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className={cx(CONSOLE_PAGE_WIDTH, "flex flex-col gap-4")}>
      {/* Header: title · freshness · last-scanned · refresh */}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">{destinationLabel("/console/scan")}</h1>
        {scan && (
          <Chip
            tone={isFresh ? "accent" : "muted"}
            title={
              isFresh
                ? "This scan was generated within the last 15 minutes."
                : "Captured earlier.  Hit Refresh scan for a current view."
            }
          >
            {/* Ago already renders "…ago" — no trailing "old" (read "1h ago old"). */}
            {isFresh ? "fresh" : <Ago iso={scan.generatedAt} />}
            {scan.cached ? " · cached" : ""}
          </Chip>
        )}
        {scan && (
          <span
            className="cursor-default text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
            title="When this scan's data was generated."
          >
            scanned <Ago iso={scan.generatedAt} />
          </span>
        )}
        <div className="flex-1" />
        <Btn
          size="sm"
          variant="outline"
          onClick={() => void onRefresh()}
          disabled={live.refreshing}
          title="Run a fresh market scan now — re-screens the universe and re-pulls quotes and enrichment.  Read-only: it never places trades.  Can take up to ~25 seconds when caches are cold."
        >
          <RefreshCw size={13} className={cx(live.refreshing && "animate-spin")} aria-hidden />
          {live.refreshing ? "Scanning…" : "Refresh scan"}
        </Btn>
      </div>

      {/* Tabs */}
      <div
        role="tablist"
        aria-label="Scan views"
        onKeyDown={onTabsKeyDown}
        className="flex gap-1 self-start rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface)] p-1"
      >
        {tabDefs.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            id={`scan-tab-${t.id}`}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`scan-tabpanel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            type="button"
            onClick={() => setTab(t.id)}
            title={t.title}
            className={cx(
              "rounded-control px-3 py-1 text-[length:var(--con-fs-xs)] font-semibold transition-colors",
              tab === t.id
                ? "bg-[color:var(--con-accent-soft)] text-[color:var(--con-accent)]"
                : "text-[color:var(--con-muted)] hover:text-[color:var(--con-fg)]"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`scan-tabpanel-${tab}`} aria-labelledby={`scan-tab-${tab}`}>
        {tab === "scan" ? (
          <MarketScanTab
            scan={scan}
            refreshing={live.refreshing}
            error={live.error}
            onRefresh={() => void onRefresh()}
            policyLimit={snapshot.policy.marketScanCandidateLimit}
            congressScoreVerdict={snapshot.smartMoney?.congressScoreVerdict}
            gatingEnabled={snapshot.policy.tuning?.congressGoNoGoGating ?? false}
          />
        ) : (
          <SmartMoneySection snapshot={snapshot} />
        )}
      </div>
    </div>
  );
}

function MarketScanTab({
  scan,
  refreshing,
  error,
  onRefresh,
  policyLimit,
  congressScoreVerdict,
  gatingEnabled
}: {
  scan: MarketScan | null;
  refreshing: boolean;
  error: string | null;
  onRefresh: () => void;
  policyLimit?: number;
  congressScoreVerdict?: CongressScoreVerdictRead | null;
  gatingEnabled?: boolean;
}) {
  // No scan at all: friendly empty state that explains how to get one.
  if (!scan) {
    return (
      <Card>
        {refreshing ? (
          <Empty>Scanning the market — fetching quotes and enrichment for your universe.  This can take up to ~25 seconds.</Empty>
        ) : (
          <>
            {error && (
              <p className="mb-1 rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                {error}
              </p>
            )}
            <Empty>
              No market scan yet.  Run one now with the button below, or it appears automatically after the next strategy
              run.  If your universe is empty, add symbols or choose a base index in Guardrails first.
            </Empty>
            <div className="flex justify-center pb-2">
              <Btn variant="primary" onClick={onRefresh} title="Run a fresh market scan now.  Read-only: it never places trades.">
                Run scan
              </Btn>
            </div>
          </>
        )}
      </Card>
    );
  }

  const limit = scan.candidateLimit ?? policyLimit ?? DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT;
  const breakdown = scanCandidateBreakdown({
    totalCandidates: scan.topCandidates.length,
    limit,
    outlierCandidateCount: scan.outlierCandidateCount,
    heldCandidateCount: scan.heldCandidateCount
  });
  const sources = formatSourceList(scan.source);
  const warningText =
    scan.warnings.length > 1 ? `${scan.warnings[0]} (+${scan.warnings.length - 1} more — hover for all)` : scan.warnings[0];

  // Effective gating state for the label/tooltip. The policy flag alone does NOT mean the
  // congress signal is being zeroed: only a FRESH FAIL_SIGNIFICANCE verdict actually zeroes
  // the congress term (see congressGateMultiplier in src/lib/congress-score-gate.ts). PASS,
  // INSUFFICIENT, and any stale verdict fail open (multiplier 1 — no change).
  const activelyGating =
    !!gatingEnabled &&
    !!congressScoreVerdict &&
    !congressScoreVerdict.stale &&
    congressScoreVerdict.verdict === "FAIL_SIGNIFICANCE";
  // PASS is a clean signal (pos); FAIL_SIGNIFICANCE is a real, data-backed failure that gates
  // (warn); INSUFFICIENT is neutral — too little data to judge — and must not read as a failure
  // (muted). See classifyCongressVerdict in src/lib/congress-score-gate.ts.
  const verdictTone: ChipTone = !congressScoreVerdict
    ? "muted"
    : congressScoreVerdict.verdict === "PASS"
      ? "pos"
      : congressScoreVerdict.verdict === "FAIL_SIGNIFICANCE"
        ? "warn"
        : "muted";
  const gatingLabel = !gatingEnabled
    ? {
        text: "Off",
        className: "text-[color:var(--con-faint)]",
        title: "Go/no-go gating is disabled in policy — the congress signal is applied unconditionally."
      }
    : activelyGating
      ? {
          text: "Zeroing",
          className: "font-medium text-[color:var(--con-warn)]",
          title: "Gating is enabled and this fresh FAIL_SIGNIFICANCE verdict is currently zeroing the congress signal in this scan."
        }
      : congressScoreVerdict?.stale
        ? {
            text: "Enabled",
            className: "font-medium text-[color:var(--con-fg)]",
            title: "Gating is enabled, but the cached verdict is stale — the congress signal is applied (fail-open, no zeroing)."
          }
        : {
            text: "Enabled",
            className: "font-medium text-[color:var(--con-fg)]",
            title: "Gating is enabled, but the current verdict does not zero the congress signal (only a fresh FAIL_SIGNIFICANCE gates)."
          };

  return (
    <div className="flex flex-col gap-3">
      {congressScoreVerdict && (
        <div className="flex flex-wrap items-center gap-2 rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2 text-[length:var(--con-fs-xs)]">
          <span className="font-semibold text-[color:var(--con-fg)]">
            Congress Signal Validation:
          </span>
          <Chip
            tone={verdictTone}
            title={congressScoreVerdict.reasons.length > 0 ? congressScoreVerdict.reasons.join("\n") : "Signal passed statistical significance validation."}
          >
            {/* Decided vocabulary, not the raw verdict enum (FAIL_SIGNIFICANCE etc.). */}
            {congressScoreVerdict.verdict === "PASS"
              ? "Pass"
              : congressScoreVerdict.verdict === "FAIL_SIGNIFICANCE"
                ? "Fails significance"
                : congressScoreVerdict.verdict === "INSUFFICIENT"
                  ? "Not enough data"
                  : congressScoreVerdict.verdict}
          </Chip>
          <span className="text-[color:var(--con-faint)]">
            t-stat: {congressScoreVerdict.stats.rankICTStat.toFixed(2)}
            {congressScoreVerdict.stats.marginalICMeanIC !== undefined ? ` · marginal IC: ${(congressScoreVerdict.stats.marginalICMeanIC * 100).toFixed(2)}%` : ""}
          </span>
          <div className="flex-1" />
          <span className="text-[color:var(--con-faint)]" title={gatingLabel.title}>
            Gating: <span className={gatingLabel.className}>{gatingLabel.text}</span>
          </span>
        </div>
      )}
      {/* A failed refresh never contradicts a populated table — muted notice only. */}
      {error && (
        <p className="rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          {error} Showing the last good scan from {fmtExact(scan.generatedAt)}.
        </p>
      )}
      {/* Loud data shortfall — never leave blank PE/EPS/news as silent dashes. */}
      {scan.dataCoverage &&
        (scan.dataCoverage.missingFields.length > 0 || scan.dataCoverage.partialFields.length > 0) && (
        <div
          role="status"
          className="rounded-control border border-[color:var(--con-neg-border,var(--con-warn-border))] bg-[color:var(--con-neg-soft,var(--con-warn-soft))] px-3 py-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-neg,var(--con-warn))]"
          title={
            [
              scan.dataCoverage.shortfallSummary,
              scan.dataCoverage.topGaps
                .map((g) => `${g.field}: ${Math.round(g.fillRate * 100)}% filled, ${g.missingCount} blank`)
                .join("\n"),
              scan.dataCoverage.contributingSources.length
                ? `Sources seen: ${scan.dataCoverage.contributingSources.join(", ")}`
                : "No field sources stamped on candidates."
            ].join("\n\n")
          }
        >
          <div className="font-semibold">Data coverage shortfall</div>
          <div className="mt-0.5 opacity-95">{scan.dataCoverage.shortfallSummary}</div>
          {scan.dataCoverage.topGaps.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {scan.dataCoverage.topGaps.slice(0, 6).map((g) => (
                <span
                  key={g.field}
                  className="rounded-control border border-current/20 px-1.5 py-0.5 font-mono text-[length:var(--con-fs-2xs)] opacity-90"
                >
                  {g.field} {Math.round(g.fillRate * 100)}%
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <WeeklyDigestCard />
      {scan.warnings.length > 0 && (
        <p
          className="cursor-default rounded-control border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] px-3 py-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]"
          title={scan.warnings.join("\n")}
        >
          {warningText}
        </p>
      )}

      <Card
        title={
          <span title="Every symbol the screener returned quotes for this run, ranked by scan score.">
            Market scan candidates
          </span>
        }
        action={
          sources ? (
            <span
              className="max-w-[55%] cursor-default truncate text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
              title={`Every provider that actually contributed data this run: ${sources}.`}
            >
              Sources: {sources}
            </span>
          ) : undefined
        }
        padded={false}
      >
        <p
          className="cursor-default px-4 pb-2 pt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
          title={`Scanned ${typeof scan.scannedSymbols === "number" ? scan.scannedSymbols : "an unrecorded number of"} symbols; ${typeof scan.returnedQuotes === "number" ? scan.returnedQuotes : "an unrecorded number of"} returned quotes${sources ? ` from ${sources}` : ""}; ${scan.topCandidates.length} candidates total (cap ${limit}) decomposed as ${formatScanCandidateBreakdown(breakdown)}${breakdown.hasHeldBreakdown ? " — held positions are never hidden regardless of rank, so the total can exceed the cap" : ""}.`}
        >
          {typeof scan.returnedQuotes === "number" ? scan.returnedQuotes : EM_DASH} quotes · {formatScanCandidateBreakdown(breakdown)}
          {typeof scan.breadthPct === "number" && (
            <span title="Market breadth — the share of the full screened universe advancing today.  A quick risk-on/risk-off gauge.">
              {" "}
              · breadth {scan.breadthPct.toFixed(0)}%
            </span>
          )}
        </p>
        {scan.topCandidates.length === 0 ? (
          <Empty>
            {(scan.scannedSymbols ?? 0) > 0 && (scan.returnedQuotes ?? 0) === 0
              ? "The scan could not price any names.  Refresh after quotes recover."
              : (scan.scannedSymbols ?? 0) === 0
                ? "This universe has no symbols.  Choose a base index or add symbols on Guardrails, then refresh."
                : "The scan returned no ranked names.  Refresh after quotes recover."}
          </Empty>
        ) : (
          <ScanTable scan={scan} />
        )}
      </Card>
    </div>
  );
}
