"use client";

/** Results — measurement, never fabrication. Paper-account and brokerage-account
 *  buckets are reported separately and never share an axis — an account is an
 *  account, distinguished only by its environment, never a "practice" tier.
 *  Uncomputable figures render as "—" with a reason, not an estimate. Tax
 *  figures are estimates only, clearly labeled. */

import { useEffect, useMemo, useState } from "react";
import type { RegimeStat, ThesisStat } from "@/lib/performance";
import type { ConnectedAccount, EquityCurvePoint, PerformanceSummary } from "@/lib/types";
import { realizedPnlNetOfEstimatedTax } from "@/lib/tax-pure";
import type { DashboardSnapshot } from "../../dashboard-types";
import { ConsoleApiError, fetchAccountPerformance, fetchLookaheadAudit, fetchSignalHealth, type LookaheadAuditResponse, type SignalHealthResponse } from "../lib/api";
import {
  buildRedTeamModelRows,
  RED_TEAM_EFFICACY_MIN_RESOLVED,
  redTeamAttributionLabel,
  redTeamReturnTone,
  redTeamSampleGate,
  redTeamSampleTier
} from "../lib/red-team-efficacy";
import { describeRedTeamFailureKind } from "@/lib/red-team-routing";
import { BenchmarkChart } from "../components/benchmark-chart";
import { EquityChart } from "../components/equity-chart";
import { deriveReality } from "../lib/derive";
import { fmtExact, fmtMoney, fmtPct, fmtQty, fmtSignedMoney, EM_DASH, SENTENCE_GAP } from "../lib/format";
import { thesisTagLabel } from "../lib/labels";
import { modelDisplayName } from "../lib/models";
import { CONSOLE_PAGE_WIDTH } from "../lib/page-width";
import { useConsoleData } from "../lib/useConsoleData";
import { Card, Chip, Dash, Empty, Select, SignedText, Stat } from "../ui/primitives";
import { SymbolButton } from "../ui/symbol-drilldown";
import { destinationLabel } from "../components/nav";

type CompareAccountSummary = { id: string; label: string; environment: "paper" | "live" };
type RedTeamEfficacySnapshot = NonNullable<DashboardSnapshot["redTeamEfficacy"]>;

/** Bucket state for the comparison account picker on Results. Mirrors the
 *  loading/empty/error/ready idiom used by the symbol drilldown's history fetch. */
type CompareState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; account: CompareAccountSummary; performance: PerformanceSummary | null; pricesUnavailable: boolean };

function useComparePerformance(accountId: string | null): CompareState {
  const [state, setState] = useState<CompareState>({ status: "idle" });

  useEffect(() => {
    if (!accountId) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      try {
        const result = await fetchAccountPerformance(accountId);
        if (cancelled) return;
        setState({
          status: "ready",
          account: result.account,
          performance: result.performance,
          pricesUnavailable: result.pricesUnavailable
        });
      } catch (error) {
        if (cancelled) return;
        setState({
          status: "error",
          message: error instanceof ConsoleApiError ? error.message : "Could not load comparison performance."
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  return state;
}

/** Pick the bucket (realized/unrealized/winRate/avgReturn/curve) matching an account's
 *  OWN money-reality out of a full PerformanceSummary — same paper-vs-live split the
 *  active account already uses above.
 *
 *  `pricesUnavailable` forces `unrealized` to `undefined` (rendered as "-" by BucketCard)
 *  instead of the comparison endpoint's synthetic $0 — that endpoint never fetches live
 *  quotes, so its unrealized figures aren't real data, just an artifact of an empty
 *  currentPrices map (see app/api/connected-accounts/[id]/performance/route.ts). Realized
 *  P&L, win rate, and avg return don't depend on currentPrices, so they stay untouched. */
function bucketFor(
  performance: PerformanceSummary | null,
  environment: "paper" | "live",
  pricesUnavailable = false
): {
  realized?: number;
  unrealized?: number;
  winRate?: number;
  avgReturn?: number;
  closedLotCount: number;
  curve: EquityCurvePoint[];
} {
  if (!performance) {
    return { realized: undefined, unrealized: undefined, winRate: undefined, avgReturn: undefined, closedLotCount: 0, curve: [] };
  }
  const bucket =
    environment === "paper"
      ? {
          realized: performance.paperRealizedPnl,
          unrealized: performance.paperUnrealizedPnl,
          winRate: performance.paperWinRate,
          avgReturn: performance.paperAverageReturnPct,
          closedLotCount: performance.paperClosedLotCount,
          curve: performance.paperEquityCurve
        }
      : {
          realized: performance.liveRealizedPnl,
          unrealized: performance.liveUnrealizedPnl,
          winRate: performance.liveWinRate,
          avgReturn: performance.liveAverageReturnPct,
          closedLotCount: performance.liveClosedLotCount,
          curve: performance.liveEquityCurve
        };
  return pricesUnavailable ? { ...bucket, unrealized: undefined } : bucket;
}

export default function ResultsPage() {
  const { snapshot } = useConsoleData();
  const [compareAccountId, setCompareAccountId] = useState<string | null>(null);
  const reality = useMemo(() => (snapshot ? deriveReality(snapshot) : null), [snapshot]);
  const compareState = useComparePerformance(compareAccountId);
  if (!snapshot || !reality) return null;

  const perf = snapshot.performance;
  const tax = snapshot.tax;
  const subtractFromResults = Boolean(snapshot.policy.taxSettings?.subtractFromResults);
  const estimatedTaxLiability = tax?.estimatedTaxLiability;
  const netRealized = (realized?: number) =>
    realizedPnlNetOfEstimatedTax(realized, estimatedTaxLiability, subtractFromResults);
  // Real multi-account comparison: every OTHER connected account (any environment) the
  // user could pick, never a hardcoded paper/live pairing of the same account's own data.
  const otherAccounts: ConnectedAccount[] = snapshot.connectedAccounts.filter((a) => a.id !== reality.account?.id);

  // The selected account lives in exactly ONE money-reality, so only its bucket
  // shows by default. A comparison account's bucket is one explicit picker
  // selection away — never silently mixed onto the page as if it belonged to
  // this account. With no connected account there is no bucket to show at all —
  // neither "paper" nor "live" is true, so rendering one anyway (all zeros/dashes)
  // would misrepresent an account that doesn't exist as if it were a real paper
  // account with nothing in it.
  const hasAccount = reality.tone !== "none";
  const liveSelected = reality.tone === "live";
  const paperBucket = (
    <BucketCard
      title="Paper Account"
      tone="paper"
      realized={netRealized(perf?.paperRealizedPnl)}
      unrealized={perf?.paperUnrealizedPnl}
      winRate={perf?.paperWinRate}
      avgReturn={perf?.paperAverageReturnPct}
      closedLotCount={perf?.paperClosedLotCount ?? 0}
      curve={perf?.paperEquityCurve ?? []}
      netOfTax={subtractFromResults}
      unmatchedClosingFills={perf?.paperUnmatchedClosingFills ?? 0}
    />
  );
  const liveBucket = (
    <BucketCard
      title="Brokerage Account"
      tone="live"
      realized={netRealized(perf?.liveRealizedPnl)}
      unrealized={perf?.liveUnrealizedPnl}
      winRate={perf?.liveWinRate}
      avgReturn={perf?.liveAverageReturnPct}
      closedLotCount={perf?.liveClosedLotCount ?? 0}
      curve={perf?.liveEquityCurve ?? []}
      netOfTax={subtractFromResults}
      unmatchedClosingFills={perf?.liveUnmatchedClosingFills ?? 0}
    />
  );

  return (
    <div className={`${CONSOLE_PAGE_WIDTH} flex flex-col gap-4`}>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">{destinationLabel("/console/results")}</h1>
        <Chip tone={reality.tone}>
          {reality.word} · {reality.phrase}
        </Chip>
        <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          for {reality.account?.label ?? "no connected account"}
        </span>
        <div className="flex-1" />
        {otherAccounts.length > 0 && (
          <div className="flex items-center gap-2">
            <label htmlFor="compare-account" className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              Compare with
            </label>
            <Select
              id="compare-account"
              value={compareAccountId ?? ""}
              onChange={(event) => setCompareAccountId(event.target.value || null)}
            >
              <option value="">None</option>
              {otherAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label} ({account.environment})
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>

      {/* Buckets: selected reality first; a comparison account's bucket only once picked.
          With no connected account, there is no bucket of either reality to show — an
          empty state, not a paper bucket full of zeros standing in for an account that
          doesn't exist. */}
      <div className={compareAccountId ? "grid gap-4 lg:grid-cols-2" : "grid gap-4"}>
        {hasAccount ? (
          liveSelected ? liveBucket : paperBucket
        ) : (
          <Card title="Account P&L">
            <Empty>Connect a broker account to see its P&amp;L here.</Empty>
          </Card>
        )}
        {compareAccountId &&
          (compareState.status === "ready" ? (
            <BucketCard
              title={compareState.account.label}
              tone={compareState.account.environment}
              {...bucketFor(compareState.performance, compareState.account.environment, compareState.pricesUnavailable)}
              grossAnnotate={subtractFromResults}
            />
          ) : compareState.status === "error" ? (
            <Card title="Comparison">
              <Empty>{compareState.message}</Empty>
            </Card>
          ) : (
            <Card title="Comparison">
              <Empty>Loading comparison…</Empty>
            </Card>
          ))}
      </div>
      {compareAccountId && (
        <p className="-mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Comparison only — these two accounts&apos; results never share an axis or a total.
        </p>
      )}

      {/* Benchmark */}
      <Card title="Versus the Market (Same-Cash S&P)">
        {perf?.benchmark ? (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <Stat
                label="Your account"
                value={fmtPct(perf.benchmark.accountReturnPct, 2, true)}
                sub={`Trailing ~${perf.benchmark.points} session${perf.benchmark.points === 1 ? "" : "s"} (${perf.benchmark.startDate} → ${perf.benchmark.endDate})`}
                title="Time-weighted return: the window is split at every deposit/withdrawal into back-to-back capital regimes; each regime’s market return is chained (multiplied) with the others.  Having $100 for 10 days then $10 for 100 days does not let the long small-balance stretch dominate like a simple start→end ratio would.  One last snapshot per day, including early deposits, up to several years of sessions."
              />
              <Stat
                label={perf.benchmark.benchmarkSymbol}
                value={fmtPct(perf.benchmark.benchmarkReturnPct, 2, true)}
                sub="same sub-periods, chained"
                title="SPY return over each capital regime’s calendar dates, geometrically chained the same way as your account (equals full-window SPY when segments cover the whole timeline)."
              />
              <div>
                <div className="con-card-title">vs {perf.benchmark.benchmarkSymbol}</div>
                <div className="con-num mt-1 text-[length:var(--con-fs-xl)] font-semibold">
                  <SignedText value={perf.benchmark.excessReturnPct}>
                    <span title="Your time-weighted account return minus the chained SPY return.  Deposits and withdrawals define the sub-period cuts; they are not counted as performance.">
                      {fmtPct(perf.benchmark.excessReturnPct, 2, true)}
                    </span>
                  </SignedText>
                </div>
                <div className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                  account − SPY (positive = beating the market)
                </div>
              </div>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Stat
                label={`Same cash in ${perf.benchmark.benchmarkSymbol}`}
                value={fmtMoney(perf.benchmark.shadowValue)}
                sub={`${perf.benchmark.startDate} → ${perf.benchmark.endDate}`}
                title={`Hypothetical ${perf.benchmark.benchmarkSymbol} tracker funded with the same deposits and withdrawals as this account.${SENTENCE_GAP}Each transfer is a breakpoint; that day's invested dollars grow with ${perf.benchmark.benchmarkSymbol} until the next transfer.${SENTENCE_GAP}Same-day additions and withdrawals are treated as landing at the daily cutoff.`}
              />
              <div>
                <div className="con-card-title">You vs that</div>
                <div className="con-num mt-1 text-[length:var(--con-fs-xl)] font-semibold">
                  <SignedText value={perf.benchmark.dollarExcess}>
                    <span
                      title={`Your ending equity minus the same-cash ${perf.benchmark.benchmarkSymbol} tracker.${SENTENCE_GAP}Positive means you have more dollars than if the same cash had tracked the S&P.`}
                    >
                      {fmtSignedMoney(perf.benchmark.dollarExcess)}
                    </span>
                  </SignedText>
                </div>
                <div className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                  account dollars − same-cash {perf.benchmark.benchmarkSymbol}
                </div>
              </div>
            </div>
            {perf.benchmark.accountEquitySeries.length >= 2 && perf.benchmark.shadowBenchmarkSeries.length >= 2 && (
              <div className="mt-4 border-t border-[color:var(--con-line)] pt-3">
                <div className="con-card-title mb-2">Account vs same-cash {perf.benchmark.benchmarkSymbol}</div>
                <BenchmarkChart
                  account={perf.benchmark.accountEquitySeries}
                  shadow={perf.benchmark.shadowBenchmarkSeries}
                  accountLabel="Your account"
                  benchmarkLabel={perf.benchmark.benchmarkSymbol}
                />
              </div>
            )}
            <p className="mt-3 border-t border-[color:var(--con-line)] pt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              {perf.benchmark.cashFlowAdjusted
                ? `Time-weighted across capital regimes — neutralized ${fmtMoney(Math.abs(perf.benchmark.netExternalFlows ?? 0))} net ${
                    (perf.benchmark.netExternalFlows ?? 0) < 0 ? "withdrawals" : "deposits"
                  } (deposits +, withdrawals −).${SENTENCE_GAP}Each stretch between transfers is its own sub-period for you and for ${perf.benchmark.benchmarkSymbol}; the % tiles chain those returns, and the dollar chart applies the same cash to ${perf.benchmark.benchmarkSymbol} at each breakpoint.${SENTENCE_GAP}Flows come from the broker ledger when present, otherwise snapshots and fills.`
                : `No material deposits or withdrawals detected — single continuous period (account equity growth vs ${perf.benchmark.benchmarkSymbol} over the same dates).`}
              {(perf.benchmark.unverifiedFlows?.length ?? 0) > 0 &&
                ` ${perf.benchmark.unverifiedFlows!.length} inferred transfer${
                  perf.benchmark.unverifiedFlows!.length === 1 ? "" : "s"
                } failed the sanity check against its own sub-period's equity move — shown below as "inferred — unverified" and excluded from the time-weighted math.`}
            </p>
            {perf.benchmark.subPeriods && perf.benchmark.subPeriods.length > 1 && (
              <div className="mt-3 overflow-x-auto border-t border-[color:var(--con-line)] pt-2">
                <div className="con-card-title mb-1.5">Capital Regimes (Between Deposits / Withdrawals)</div>
                <table className="w-full min-w-[32rem] text-left text-[length:var(--con-fs-xs)]">
                  <thead className="text-[color:var(--con-faint)]">
                    <tr>
                      <th className="py-1 pr-2 font-medium">Window</th>
                      <th className="py-1 pr-2 font-medium">Start → end equity</th>
                      <th className="py-1 pr-2 font-medium">Transfer</th>
                      <th className="py-1 pr-2 font-medium">You</th>
                      <th className="py-1 font-medium">{perf.benchmark.benchmarkSymbol}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {perf.benchmark.subPeriods.map((seg) => (
                      <tr key={`${seg.startDate}-${seg.endDate}-${seg.externalFlow}`} className="border-t border-[color:var(--con-line)]">
                        <td className="py-1 pr-2 whitespace-nowrap">
                          {seg.startDate} → {seg.endDate}
                        </td>
                        <td className="py-1 pr-2 whitespace-nowrap">
                          {fmtMoney(seg.startEquity)} → {fmtMoney(seg.endEquity)}
                        </td>
                        <td className="py-1 pr-2 whitespace-nowrap">
                          {Math.abs(seg.externalFlow) < 0.01 ? (
                            "—"
                          ) : (
                            <span className="inline-flex items-center gap-1.5">
                              {seg.externalFlow > 0 ? "deposit" : "withdrawal"} {fmtMoney(Math.abs(seg.externalFlow))}
                              {seg.flowUnverified && (
                                <Chip
                                  tone="warn"
                                  title="This inferred transfer is far larger than this sub-period's own equity move, so it cannot be reconciled — a real transfer moves equity by roughly its size.  It is shown for your review but EXCLUDED from the time-weighted return; this row's return is the raw equity growth."
                                >
                                  inferred — unverified
                                </Chip>
                              )}
                            </span>
                          )}
                        </td>
                        <td className="py-1 pr-2">
                          <SignedText value={seg.accountReturnPct}>{fmtPct(seg.accountReturnPct, 2, true)}</SignedText>
                        </td>
                        <td className="py-1">
                          <SignedText value={seg.benchmarkReturnPct}>{fmtPct(seg.benchmarkReturnPct, 2, true)}</SignedText>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : perf?.benchmarkUnavailable ? (
          <div className="flex flex-col gap-2">
            <div>
              <Chip tone="warn">benchmark unavailable</Chip>
            </div>
            <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
              {perf.benchmarkUnavailable.reason === "stale-series"
                ? "The SPY price series is stale — it ends before your account window, so a comparison would print 0.00% for a dead feed, not a flat market."
                : perf.benchmarkUnavailable.reason === "no-bars"
                  ? "No SPY price history was returned by any provider."
                  : "The SPY price fetch failed."}{" "}
              Your account return is not compared against a dead benchmark; nothing here is estimated.
            </p>
            {perf.benchmarkUnavailable.detail && (
              <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">{perf.benchmarkUnavailable.detail}</p>
            )}
          </div>
        ) : (
          <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">
            Not computable yet — the comparison needs enough overlapping history between your equity snapshots and SPY.
            It appears here on its own; nothing is estimated in the meantime.
          </p>
        )}
      </Card>

      {/* Scorecards */}
      {/* id="thesis-regime" is the deep-link target for the home page's Framework-improvements
          card when it's showing this same thesis/regime data as its fallback body; scroll-mt
          clears the app shell's sticky reality/chrome header (see shell.tsx). */}
      <div id="thesis-regime" className="grid scroll-mt-28 gap-4 lg:grid-cols-2">
        <ScorecardCard
          title="By Thesis"
          rows={(snapshot.thesisScorecard ?? []).map((t: ThesisStat) => ({
            name: thesisTagLabel(t.thesisTag),
            trades: t.trades,
            winRate: t.winRate,
            avgReturnPct: t.avgReturnPct,
            totalPnl: t.totalPnl
          }))}
          nameLabel="Thesis"
        />
        <ScorecardCard
          title="By Market Regime at Entry"
          rows={(snapshot.regimeScorecard ?? []).map((r: RegimeStat) => ({
            name: r.regime,
            trades: r.trades,
            winRate: r.winRate,
            avgReturnPct: r.avgReturnPct,
            totalPnl: r.totalPnl
          }))}
          nameLabel="Regime"
        />
      </div>
      <RedTeamEfficacyCard efficacy={snapshot.redTeamEfficacy} />
      <SignalHealthCard />
      <LookaheadAuditCard />

      {/* Tax */}
      <Card
        title="Tax"
        action={<Chip tone="warn">estimates only — not tax advice</Chip>}
      >
        {!tax ? (
          <Empty>No tax summary available for this account yet.</Empty>
        ) : (
          <TaxBlock />
        )}
      </Card>
    </div>
  );
}

/** Signal health (r2 lesson: health): rolling diagnostics of the AI's OWN confidenceScore against
 *  matured decision outcomes, from the daily signal-health snapshot rows. Measurement, never
 *  fabrication — a horizon below the observation floor shows an honest empty state, and every
 *  figure is arithmetic over matured outcomes (no estimates). Compact by design; a dedicated page
 *  is a follow-up. */
function SignalHealthCard() {
  const [state, setState] = useState<
    { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: SignalHealthResponse }
  >({ status: "loading" });
  const [horizon, setHorizon] = useState<string>("1d");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchSignalHealth();
        if (cancelled) return;
        setState({ status: "ready", data });
        // Land on the first horizon that actually has data so the default view is never
        // an empty tab while another horizon has history.
        const withData = data.horizons.find((h) => h.snapshots.length > 0);
        if (withData) setHorizon(withData.horizon);
      } catch (error) {
        if (cancelled) return;
        setState({
          status: "error",
          message: error instanceof ConsoleApiError ? error.message : "Could not load signal health."
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const advisoryChip = (
    <Chip tone="muted" title="Rolling rank IC of the AI's own confidence scores against matured side-adjusted outcome returns.  Advisory diagnostics — sizing only changes under the opt-in signal-health auto-throttle.">
      confidence vs outcomes
    </Chip>
  );

  if (state.status === "loading") {
    return (
      <Card title="Signal Health" action={advisoryChip}>
        <Empty>Loading signal health…</Empty>
      </Card>
    );
  }
  if (state.status === "error") {
    return (
      <Card title="Signal Health" action={advisoryChip}>
        <Empty>{state.message}</Empty>
      </Card>
    );
  }

  const { data } = state;
  const selected = data.horizons.find((h) => h.horizon === horizon) ?? data.horizons[0];
  const latest = selected?.snapshots[0];
  const anyData = data.horizons.some((h) => h.snapshots.length > 0);

  if (!anyData || !selected) {
    return (
      <Card title="Signal Health" action={advisoryChip}>
        <Empty>
          Not enough matured decisions to measure signal health yet.{SENTENCE_GAP}It needs at least {data.minObservations}{" "}
          decisions with matured outcomes per horizon; nothing is estimated in the meantime.
        </Empty>
      </Card>
    );
  }

  const slope = latest?.rollingRankICSlope;
  return (
    <Card
      title="Signal Health"
      action={
        <div className="flex items-center gap-2">
          {advisoryChip}
          <Select value={selected.horizon} onChange={(event) => setHorizon(event.target.value)} aria-label="Signal-health horizon">
            {data.horizons.map((h) => (
              <option key={h.horizon} value={h.horizon}>
                {h.horizon} horizon
              </option>
            ))}
          </Select>
        </div>
      }
    >
      {!latest ? (
        <Empty>
          No {selected.horizon}-horizon snapshot yet — this horizon has fewer than {data.minObservations} decisions with
          matured outcomes.{SENTENCE_GAP}Nothing is estimated in the meantime.
        </Empty>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label={`Rank IC (${latest.horizon})`}
              value={<SignedText value={latest.rankIC}>{latest.rankIC.toFixed(3)}</SignedText>}
              sub={`t ${latest.tStat.toFixed(2)} · ${latest.nObservations} decisions over ${latest.nDates} days`}
              tone={latest.rankIC > 0 ? "pos" : latest.rankIC < 0 ? "neg" : "muted"}
              title="Pooled Spearman rank correlation between the AI's confidence score and the matured side-adjusted return.  Positive means higher confidence really did precede better outcomes."
            />
            <Stat
              label="Trend"
              value={slope !== undefined ? <SignedText value={slope}>{`${slope > 0 ? "+" : ""}${slope.toFixed(4)}`}</SignedText> : <Dash />}
              sub={slope !== undefined ? "rolling rank-IC slope, per window" : "needs a second daily snapshot"}
              tone={slope !== undefined ? (slope < 0 ? "neg" : "pos") : "muted"}
              title="OLS slope of the rolling rank-IC series.  A sustained negative slope is the drift alarm's trigger — signal decay shows here weeks before the equity curve."
            />
            <Stat
              label={`Top-${data.topK} Churn`}
              value={latest.topKChurnPct !== undefined ? fmtPct(latest.topKChurnPct, 1) : <Dash />}
              sub={latest.topKChurnPct !== undefined ? "mean Jaccard distance, consecutive days" : "needs two decision days"}
              title="How much the AI's highest-confidence names reshuffle day to day.  High churn means conviction is flipping names faster than a thesis should."
            />
            <Stat
              label="Gross vs Net"
              value={`${fmtPct(latest.grossReturnPct, 2, true)} / ${fmtPct(latest.netOfCostReturnPct, 2, true)}`}
              sub={`mean matured return, net of ${data.costRoundTripBps}bps round-trip`}
              tone={latest.netOfCostReturnPct > 0 ? "pos" : latest.netOfCostReturnPct < 0 ? "neg" : "muted"}
              title="Mean side-adjusted matured return across observations, gross and after debiting the round-trip transaction-cost estimate.  A signal that only wins gross is not a signal."
            />
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="con-table">
              <thead>
                <tr>
                  <th title="Confidence-score quantile — Q1 lowest confidence, top bucket highest.">Confidence bucket</th>
                  <th className="num">n</th>
                  <th className="num">Avg return</th>
                  <th className="num">Hit rate</th>
                </tr>
              </thead>
              <tbody>
                {latest.quantileBuckets.map((bucket, index) => (
                  <tr key={bucket.bucket}>
                    <td className="font-semibold">
                      Q{bucket.bucket}
                      {index === 0 ? " (lowest)" : index === latest.quantileBuckets.length - 1 ? " (highest)" : ""}
                    </td>
                    <td className="num con-num">{bucket.n}</td>
                    <td className="num">
                      <SignedText value={bucket.avgReturn}>{fmtPct(bucket.avgReturn, 2, true)}</SignedText>
                    </td>
                    <td className="num con-num">{fmtPct(bucket.hitRate * 100, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            A healthy signal rises from Q1 to the top bucket.{SENTENCE_GAP}Updated {fmtExact(latest.createdAt)} CT.
          </p>
        </>
      )}
    </Card>
  );
}

const LOOKAHEAD_FIELD_LABELS: Record<string, string> = {
  momentum: "Momentum",
  liquidity: "Liquidity",
  value: "Value",
  quality: "Quality",
  volatility: "Volatility",
  sentiment: "Sentiment",
  positioning: "Positioning",
  diversification: "Diversification",
  rag_evidence: "RAG evidence"
};

/** Lookahead audit (freqtrade lookahead-analysis port): weekly truncated-replay findings —
 *  persisted decision-time values vs values recomputed from data truncated to the decision date.
 *  Honest three-way classification; 'unverifiable' rows are deliberate coverage-gap receipts and
 *  are rendered plainly, never hidden or implied clean. Compact by design — no dedicated page. */
function LookaheadAuditCard() {
  const [state, setState] = useState<
    { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: LookaheadAuditResponse }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchLookaheadAudit();
        if (cancelled) return;
        setState({ status: "ready", data });
      } catch (error) {
        if (cancelled) return;
        setState({
          status: "error",
          message: error instanceof ConsoleApiError ? error.message : "Could not load the lookahead audit."
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const replayChip = (
    <Chip tone="muted" title="Weekly truncated-replay audit: momentum/liquidity factors are recomputed from OHLC truncated to each decision date, and RAG evidence is re-retrieved with the as-of pin under a strict point-in-time filter.  Factors with no point-in-time source stay honestly unverifiable.  Advisory only — findings gate nothing.">
      truncated replay
    </Chip>
  );

  if (state.status === "loading") {
    return (
      <Card title="Lookahead Audit" action={replayChip}>
        <Empty>Loading lookahead audit…</Empty>
      </Card>
    );
  }
  if (state.status === "error") {
    return (
      <Card title="Lookahead Audit" action={replayChip}>
        <Empty>{state.message}</Empty>
      </Card>
    );
  }

  const { data } = state;
  const { verdict } = data;
  if (data.findings.length === 0) {
    return (
      <Card title="Lookahead Audit" action={replayChip}>
        <Empty>
          No findings yet.{SENTENCE_GAP}The weekly audit samples matured decisions once they clear the outcome
          horizon; nothing is estimated in the meantime.
        </Empty>
      </Card>
    );
  }

  const verdictLine =
    verdict.verdict === "lookahead_mismatch_detected"
      ? `${verdict.mismatches} mismatch${verdict.mismatches === 1 ? "" : "es"} across ${verdict.qualifying} verifiable observations.`
      : verdict.verdict === "no_lookahead_bias_detected"
        ? `No lookahead bias detected across ${verdict.qualifying} verifiable observations.`
        : `Insufficient sample — ${verdict.qualifying} of the ${verdict.floor} verifiable observations needed before an all-clear.`;
  const verdictTone =
    verdict.verdict === "lookahead_mismatch_detected" ? "neg" : verdict.verdict === "no_lookahead_bias_detected" ? "pos" : "muted";
  const shown = data.findings.slice(0, 30);

  return (
    <Card
      title="Lookahead Audit"
      action={
        <div className="flex items-center gap-2">
          {replayChip}
          <Chip tone={verdictTone}>
            {verdict.verdict === "lookahead_mismatch_detected"
              ? "mismatch detected"
              : verdict.verdict === "no_lookahead_bias_detected"
                ? "no bias detected"
                : "insufficient sample"}
          </Chip>
        </div>
      }
    >
      <p className="text-[length:var(--con-fs-sm)]">
        {verdictLine}
        {SENTENCE_GAP}
        {verdict.unverifiable} observation{verdict.unverifiable === 1 ? " is" : "s are"} unverifiable (no point-in-time
        source) and never count toward an all-clear.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="con-table">
          <thead>
            <tr>
              <th>Decision</th>
              <th>Field</th>
              <th className="num" title="Value persisted at decision time (factor sub-score, or used-chunk count for RAG evidence).">Persisted</th>
              <th className="num" title="Value recomputed from data truncated to the decision date (or the strict as-of replay).">Replayed</th>
              <th className="num" title="Absolute sub-score difference; 1 − Jaccard for RAG evidence.">Δ</th>
              <th>Classification</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((finding) => {
              const reasonRaw = typeof finding.detail?.reason === "string" ? finding.detail.reason : undefined;
              // Snake-case gate tokens render inline; sentence-length coverage-gap reasons stay
              // in the tooltip so the table row remains compact.
              const shortReason = reasonRaw && !reasonRaw.includes(" ") ? reasonRaw.replaceAll("_", " ") : undefined;
              return (
                <tr key={`${finding.decisionId}:${finding.factorOrField}`}>
                  <td className="font-semibold">
                    {finding.symbol}
                    <span className="text-[color:var(--con-faint)]"> · {finding.asOf ? `${fmtExact(finding.asOf)} CT` : EM_DASH}</span>
                  </td>
                  <td>{LOOKAHEAD_FIELD_LABELS[finding.factorOrField] ?? finding.factorOrField}</td>
                  <td className="num con-num">{finding.persistedValue !== undefined ? finding.persistedValue.toFixed(1) : <Dash />}</td>
                  <td className="num con-num">{finding.recomputedValue !== undefined ? finding.recomputedValue.toFixed(1) : <Dash />}</td>
                  <td className="num con-num">{finding.delta !== undefined ? finding.delta.toFixed(2) : <Dash />}</td>
                  <td>
                    {finding.classification === "clean" ? (
                      <Chip tone="pos">clean</Chip>
                    ) : finding.classification === "mismatch" ? (
                      <Chip tone="neg" title={reasonRaw}>mismatch{shortReason ? ` — ${shortReason}` : ""}</Chip>
                    ) : (
                      <Chip tone="muted" title={reasonRaw ?? (typeof finding.detail?.backtestSafety === "string" ? finding.detail.backtestSafety : undefined)}>
                        unverifiable{shortReason ? ` — ${shortReason}` : ""}
                      </Chip>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Showing {shown.length} of {data.findings.length} recent findings.{SENTENCE_GAP}Mismatch tolerance{" "}
        {data.tolerancePoints} sub-score points; RAG drift tolerance Jaccard {data.jaccardMin}.{SENTENCE_GAP}Runs every{" "}
        {data.cadenceDays} day{data.cadenceDays === 1 ? "" : "s"}{data.enabled ? "" : " (currently disabled by LOOKAHEAD_AUDIT_ENABLED)"}.
      </p>
    </Card>
  );
}

/** #2552: aggregate critic health — failed adversarial reviews / attempted reviews (30d,
 *  user-wide). A per-card "AI critic failed" chip cannot show that 4 of 5 reviews in one batch
 *  failed; this is the ownable aggregate for spotting a flaky reviewer model or config. */
function CriticFailureStat({ criticFailure }: { criticFailure: RedTeamEfficacySnapshot["criticFailure"] }) {
  const reviews = criticFailure?.reviews ?? 0;
  const failures = criticFailure?.failures ?? 0;
  const top = criticFailure?.topFailure;
  const topText = top
    ? `mostly ${top.model ? modelDisplayName(top.model) : "unattributed"} · ${describeRedTeamFailureKind(
        top.kind as Parameters<typeof describeRedTeamFailureKind>[0]
      )}`
    : undefined;
  return (
    <Stat
      label={`Critic Failure Rate (${criticFailure?.windowDays ?? 30}d)`}
      value={reviews > 0 ? fmtPct(criticFailure?.failureRatePct ?? 0, 1) : <Dash />}
      sub={reviews > 0 ? [`${failures}/${reviews} reviews failed`, topText].filter(Boolean).join(" · ") : "no reviews attempted in the window"}
      tone={failures > 0 ? "neg" : reviews > 0 ? "pos" : "muted"}
      title="Of the proposals whose adversarial review was attempted (a redTeamVerdict exists), the share where the review FAILED to run (timeout, provider error, rate limit, malformed response).  User-wide across accounts — critic failures are a model/config condition.  Proposals below every review trigger are not counted."
    />
  );
}

function RedTeamEfficacyCard({ efficacy }: { efficacy: RedTeamEfficacySnapshot | undefined }) {
  if (!efficacy) {
    return (
      <Card title="Red Team Veto Efficacy">
        <Empty>Select an account to score Red Team history.</Empty>
      </Card>
    );
  }

  if (efficacy.vetoDecisions === 0) {
    return (
      <Card title="Red Team Veto Efficacy">
        <Empty>No Red Team veto decisions recorded yet.</Empty>
        {/* Critic health must not hide behind an empty veto history — a batch of failed reviews
            with zero vetoes is exactly the "nobody sees it in aggregate" case (#2552). */}
        {(efficacy.criticFailure?.reviews ?? 0) > 0 && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <CriticFailureStat criticFailure={efficacy.criticFailure} />
          </div>
        )}
      </Card>
    );
  }

  const modelRows = buildRedTeamModelRows(efficacy);
  const sampleLabel = redTeamSampleGate(efficacy.maturedVetoes);
  const sampleTier = redTeamSampleTier(efficacy.maturedVetoes);

  return (
    <Card
      title="Red Team Veto Efficacy"
      action={
        <Chip
          tone={sampleTier === "ready" ? "pos" : sampleTier === "caution" ? "warn" : "muted"}
          title="Blocking vetoes are scored from matured counterfactuals; overridden vetoes are tracked separately and never mixed into the payoff metric."
        >
          {sampleLabel}
        </Chip>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Stat
          label="Veto Decisions"
          value={efficacy.vetoDecisions}
          sub={`${efficacy.totalVetoes} blocking · ${efficacy.appliedOverrideVetoes}/${efficacy.overrideVetoes} overrides applied`}
          title="Opening-side Red Team veto decisions only.  Blocking vetoes keep the trade out; applied overrides proceed on a logged autonomy thesis and are not counted as missed opportunities.  Survived Red Team reviews are not persisted in this metric."
        />
        <Stat
          label="Resolved Blocking Vetoes"
          value={efficacy.totalVetoes > 0 ? `${efficacy.maturedVetoes}/${efficacy.totalVetoes}` : <Dash />}
          sub={efficacy.totalVetoes > 0 ? efficacy.coverage : "no blocking vetoes recorded"}
          title="Blocking vetoes whose forward return actually resolved.  Unresolvable names stay disclosed instead of disappearing from the denominator."
        />
        <Stat
          label="Applied Override Share"
          value={fmtPct(efficacy.overrideSharePct, 1)}
          sub={efficacy.appliedOverrideVetoes > 0 ? `${efficacy.appliedOverrideVetoes} applied` : "none applied"}
          title="Share of opening-side Red Team veto decisions where the Socratic override path actually applied.  Refused overrides and later blocks are not counted as applied."
        />
        <Stat
          label="Avoided Losers"
          value={efficacy.maturedVetoes >= RED_TEAM_EFFICACY_MIN_RESOLVED ? fmtPct(efficacy.vetoValueAddRate, 1) : <Dash />}
          sub={efficacy.maturedVetoes >= RED_TEAM_EFFICACY_MIN_RESOLVED ? "resolved blocking vetoes" : `needs >=${RED_TEAM_EFFICACY_MIN_RESOLVED} resolved vetoes`}
          tone={efficacy.maturedVetoes >= RED_TEAM_EFFICACY_MIN_RESOLVED ? "pos" : "muted"}
          title="Among resolved blocking vetoes, how often the vetoed trade would have lost money.  Higher is better for the reviewer."
        />
        <Stat
          label="Missed Winners"
          value={efficacy.maturedVetoes >= RED_TEAM_EFFICACY_MIN_RESOLVED ? fmtPct(efficacy.survivorRiskHitRate, 1) : <Dash />}
          sub={efficacy.maturedVetoes >= RED_TEAM_EFFICACY_MIN_RESOLVED ? "resolved blocking vetoes" : `needs >=${RED_TEAM_EFFICACY_MIN_RESOLVED} resolved vetoes`}
          tone={efficacy.maturedVetoes >= RED_TEAM_EFFICACY_MIN_RESOLVED ? "neg" : "muted"}
          title="Among resolved blocking vetoes, how often the veto killed a trade that would have made money."
        />
        <Stat
          label="Avg Vetoed Trade Return"
          value={efficacy.maturedVetoes >= RED_TEAM_EFFICACY_MIN_RESOLVED ? fmtPct(efficacy.avgReturnPct, 2, true) : <Dash />}
          sub={efficacy.maturedVetoes >= RED_TEAM_EFFICACY_MIN_RESOLVED ? "negative = good for the veto" : `needs >=${RED_TEAM_EFFICACY_MIN_RESOLVED} resolved vetoes`}
          tone={efficacy.maturedVetoes >= RED_TEAM_EFFICACY_MIN_RESOLVED ? (efficacy.avgReturnPct < 0 ? "pos" : efficacy.avgReturnPct > 0 ? "neg" : "muted") : "muted"}
          title="Average side-adjusted forward return of the trades the blocking veto kept out.  Negative means the veto avoided losses; positive means it missed winners."
        />
        <CriticFailureStat criticFailure={efficacy.criticFailure} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <div className="con-card-title">By Reviewer Attribution</div>
            <Chip tone="muted" title="Rows without a persisted reviewer model are shown as unattributed, never backfilled from current settings.">
              persisted only
            </Chip>
          </div>
          {modelRows.length === 0 ? (
            <Empty>No resolved blocking vetoes yet.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="con-table">
                <thead>
                  <tr>
                    <th>Red Team</th>
                    <th className="num">n</th>
                    <th className="num">Avoided</th>
                    <th className="num">Missed</th>
                    <th className="num" title="Average side-adjusted vetoed-trade return.  Negative is good for the veto.">Avg</th>
                  </tr>
                </thead>
                <tbody>
                  {modelRows.map((row) => {
                    const tier = redTeamSampleTier(row.maturedVetoes);
                    const gateLabel =
                      tier === "hidden"
                        ? `needs >=20 vetoes (n=${row.maturedVetoes})`
                        : tier === "caution"
                          ? `small sample (n=${row.maturedVetoes})`
                          : `n=${row.maturedVetoes}`;
                    return (
                      <tr key={row.model}>
                        <td className="font-semibold">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span>{redTeamAttributionLabel(row.model)}</span>
                            {tier !== "ready" ? <Chip tone={tier === "hidden" ? "muted" : "warn"}>{gateLabel}</Chip> : null}
                          </div>
                        </td>
                        <td className="num con-num">{row.maturedVetoes}</td>
                        <td className="num con-num" title={gateLabel}>
                          {tier === "hidden" ? EM_DASH : fmtPct(row.vetoValueAddRate, 1)}
                        </td>
                        <td className="num con-num" title={gateLabel}>
                          {tier === "hidden" ? EM_DASH : fmtPct(row.survivorRiskHitRate, 1)}
                        </td>
                        <td className="num" title={gateLabel}>
                          {tier === "hidden" ? (
                            EM_DASH
                          ) : (
                            <span style={{ color: row.avgReturnPct < 0 ? "var(--con-pos)" : row.avgReturnPct > 0 ? "var(--con-neg)" : undefined }}>
                              {fmtPct(row.avgReturnPct, 2, true)}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <div className="con-card-title">Recent Resolved Vetoes</div>
            <Chip tone="muted" title="Most recent resolved blocking vetoes first. Positive means the veto killed a would-have-worked trade; negative means it kept out a loser.">
              blocking only
            </Chip>
          </div>
          {efficacy.records.length === 0 ? (
            <Empty>No resolved blocking vetoes yet.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="con-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th>Thesis</th>
                    <th>Red Team</th>
                    <th className="num" title="Side-adjusted forward return after the veto.  Negative = the veto avoided a loser.">Return</th>
                    <th>Readout</th>
                  </tr>
                </thead>
                <tbody>
                  {efficacy.records.map((record) => (
                    <tr key={`${record.runId}:${record.symbol}`}>
                      <td className="font-semibold">
                        <SymbolButton symbol={record.symbol} />
                      </td>
                      <td className="capitalize">{record.side ?? EM_DASH}</td>
                      <td title={record.reason ?? undefined}>{record.thesisTag ? thesisTagLabel(record.thesisTag) : EM_DASH}</td>
                      <td>{redTeamAttributionLabel(record.model)}</td>
                      <td className="num">
                        <span style={{ color: record.returnPct < 0 ? "var(--con-pos)" : record.returnPct > 0 ? "var(--con-neg)" : undefined }}>
                          {fmtPct(record.returnPct, 2, true)}
                        </span>
                      </td>
                      <td>
                        <Chip tone={redTeamReturnTone(record.returnPct)}>
                          {record.returnPct < 0 ? "avoided loser" : record.returnPct > 0 ? "missed winner" : "flat"}
                        </Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function BucketCard({
  title,
  tone,
  realized,
  unrealized,
  winRate,
  avgReturn,
  closedLotCount,
  curve,
  netOfTax = false,
  grossAnnotate = false,
  unmatchedClosingFills = 0
}: {
  title: string;
  tone: "paper" | "live";
  realized?: number;
  unrealized?: number;
  winRate?: number;
  avgReturn?: number;
  /** Number of CLOSED lots behind winRate/avgReturn. Zero closed lots must render as "no data
   *  yet" (EM_DASH), never a fabricated "0%"/"+0.00%" — winRate/avgReturn both compute to 0 (not
   *  undefined) for an empty lot list, so the value itself can't distinguish "no trades closed"
   *  from "closed trades that genuinely broke even". Gate on this count, not the value. */
  closedLotCount: number;
  curve: Array<{ timestamp: string; equity: number; source: "live" | "paper" }>;
  netOfTax?: boolean;
  grossAnnotate?: boolean;
  unmatchedClosingFills?: number;
}) {
  const realizedBasisNote =
    "All-time, app-booked closed lots (this app's own FIFO lot ledger).  Exits of positions this app did not open — pre-app holdings, manual trades — are not included.";
  const unrealizedBasisNote =
    "This app's lot ledger: average entry price of app-booked open lots × quantity, marked to the latest known price.  May differ from your broker's own cost-basis figure for positions built partly outside this app.";
  return (
    <Card title={title}>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div
            className="con-card-title"
            title={netOfTax ? `${realizedBasisNote} Net of estimated tax at your configured short- and long-term rates.` : realizedBasisNote}
          >
            Realized P&amp;L{netOfTax ? " (net of est. tax)" : grossAnnotate ? " (gross — no tax adjustment)" : ""}
          </div>
          <div className="con-num mt-0.5 text-[length:var(--con-fs-lg)] font-semibold">
            {typeof realized === "number" ? <SignedText value={realized}>{fmtSignedMoney(realized)}</SignedText> : <Dash />}
          </div>
          {unmatchedClosingFills > 0 && (
            <p
              className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
              title={`These exits closed positions this app never recorded an opening fill for, so there is no cost basis here to compute their gain or loss from.${SENTENCE_GAP}Their P&L is not included above.`}
            >
              Excludes {unmatchedClosingFills} closing {unmatchedClosingFills === 1 ? "fill" : "fills"} with no opening lot
              on record.{SENTENCE_GAP}Pre-app or manually traded positions.
            </p>
          )}
        </div>
        <div>
          <div className="con-card-title" title={unrealizedBasisNote}>
            Unrealized P&amp;L
          </div>
          <div className="con-num mt-0.5 text-[length:var(--con-fs-lg)] font-semibold">
            {typeof unrealized === "number" ? <SignedText value={unrealized}>{fmtSignedMoney(unrealized)}</SignedText> : <Dash />}
          </div>
        </div>
        <div>
          <div className="con-card-title" title="Share of CLOSED lots that were profitable.  Shows — until this bucket has closed at least one lot — a 0% here would otherwise be indistinguishable from “no trades closed yet”.">
            Win Rate
          </div>
          <div className="con-num mt-0.5">{closedLotCount > 0 && typeof winRate === "number" ? fmtPct(winRate, 0) : EM_DASH}</div>
        </div>
        <div>
          <div className="con-card-title" title="Capital-weighted realized return across closed lots (sum of P&amp;L ÷ sum of entry notional).  Not the same as account NAV change — open positions and cash are excluded.  Unweighted trade averages were retired because small round-trips dominated.  The SPY panel below is the account equity time-weighted return.">Avg Return / Closed Capital</div>
          <div className="con-num mt-0.5" title="Raw realized return per closed trade, based on entry and exit prices.  It is not adjusted for SPY or market beta.">
            {closedLotCount > 0 && typeof avgReturn === "number" ? fmtPct(avgReturn, 2, true) : EM_DASH}
          </div>
        </div>
      </div>
      <div className="mt-3 border-t border-[color:var(--con-line)] pt-3">
        <EquityChart points={curve} label={tone === "live" ? "real-money" : "paper-money"} />
        {curve.length >= 2 && (
          <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            Raw account equity — includes any deposits/withdrawals, so a transfer moves this line without being a
            gain or loss.  The market comparison below adjusts for detected transfers.
          </p>
        )}
      </div>
    </Card>
  );
}

function ScorecardCard({
  title,
  rows,
  nameLabel
}: {
  title: string;
  rows: Array<{ name: string; trades: number; winRate: number; avgReturnPct: number; totalPnl: number }>;
  nameLabel: string;
}) {
  const sorted = useMemo(() => [...rows].sort((a, b) => b.trades - a.trades), [rows]);
  return (
    <Card title={title} padded={false}>
      {sorted.length === 0 ? (
        <Empty>No closed trades to score yet.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="con-table">
            <thead>
              <tr>
                <th>{nameLabel}</th>
                <th className="num">n</th>
                <th className="num">Win</th>
                <th className="num" title="Raw average realized return per closed lot in this group, not benchmark-relative.  Use the SPY panel for excess return.">Avg</th>
                <th className="num">P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => {
                const thin = row.trades < 5;
                return (
                  <tr key={row.name} className={thin ? "opacity-60" : undefined} title={thin ? "Small sample — read with caution." : undefined}>
                    <td className="font-semibold">{row.name}</td>
                    <td className="num con-num">{row.trades}</td>
                    <td className="num con-num">{fmtPct(row.winRate, 0)}</td>
                    <td className="num" title="Raw average realized return for this thesis/regime group.  Positive means the closed lots made money in their own direction; it is not SPY-relative.">
                      <SignedText value={row.avgReturnPct}>{fmtPct(row.avgReturnPct, 2, true)}</SignedText>
                    </td>
                    <td className="num">
                      <SignedText value={row.totalPnl}>{fmtSignedMoney(row.totalPnl)}</SignedText>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function TaxBlock() {
  const { snapshot } = useConsoleData();
  const tax = snapshot?.tax;
  const subtractFromResults = Boolean(snapshot?.policy.taxSettings?.subtractFromResults);
  if (!tax) return null;

  const ira = tax.settings.taxationType === "roth_ira" || tax.settings.taxationType === "traditional_ira";
  const shortTermDisplay = subtractFromResults
    ? realizedPnlNetOfEstimatedTax(tax.shortTermRealized, tax.estimatedShortTermTax, true)
    : tax.shortTermRealized;
  const longTermDisplay = subtractFromResults
    ? realizedPnlNetOfEstimatedTax(tax.longTermRealized, tax.estimatedLongTermTax, true)
    : tax.longTermRealized;

  return (
    <div className="flex flex-col gap-4 text-[length:var(--con-fs-sm)]">
      {subtractFromResults && !ira && (
        <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Realized figures below are net of estimated tax at your configured rates (same toggle as Guardrails → Tax).
        </p>
      )}
      {ira && (
        <p className="text-[color:var(--con-muted)]">
          This is an IRA — no yearly taxes on trades here, so rates are zeroed and loss-harvest
          candidates are not shown.{SENTENCE_GAP}A taxable-account loss can still appear as a lockout chip below.{SENTENCE_GAP}
          Ignore (the default) does not constrain this IRA.{SENTENCE_GAP}Auto lets Green weigh it.{SENTENCE_GAP}Block
          refuses.{SENTENCE_GAP}Minimum loss is optional (blank = every loss).
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label={`Short-Term Realized ${tax.taxYear}${subtractFromResults && !ira ? " (net)" : ""}`}
          value={fmtSignedMoney(shortTermDisplay)}
        />
        <Stat label={`Long-Term Realized${subtractFromResults && !ira ? " (net)" : ""}`} value={fmtSignedMoney(longTermDisplay)} />
        <Stat label="Disallowed Wash-Sale Loss" value={fmtMoney(tax.disallowedWashSaleLoss)} />
        <Stat label="Estimated Tax Liability" value={fmtMoney(tax.estimatedTaxLiability)} sub={`ST ${fmtMoney(tax.estimatedShortTermTax)} · LT ${fmtMoney(tax.estimatedLongTermTax)}`} />
      </div>

      {tax.lockedSymbols.length > 0 && (
        <div>
          <div className="con-card-title mb-1">Wash-Sale Lockouts (All Your Accounts)</div>
          <div className="flex flex-wrap gap-1.5">
            {tax.lockedSymbols.map((s) => (
              <Chip key={s} tone="warn" title={ira ? "A taxable account realized a loss in this symbol.  Ignore does not constrain this IRA.  Auto weighs it.  Block refuses.  Minimum loss is optional." : "Rebuying within 30 days of the loss would forfeit the loss deduction.  The buy gate enforces this automatically."}>
                <SymbolButton symbol={s} className="text-inherit" /> locked
              </Chip>
            ))}
          </div>
        </div>
      )}

      {tax.openLots.length > 0 && (
        <div>
          <div className="con-card-title mb-1">Open Lots — Days to Long-Term Treatment</div>
          <div className="overflow-x-auto">
            <table className="con-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="num">Qty</th>
                  <th className="num">Days held</th>
                  <th className="num">To long-term</th>
                  <th className="num">Unrealized</th>
                  <th className="num">Early-exit tax cost</th>
                </tr>
              </thead>
              <tbody>
                {[...tax.openLots]
                  .sort((a, b) => a.daysToLongTerm - b.daysToLongTerm)
                  .slice(0, 12)
                  .map((lot, i) => (
                    <tr key={`${lot.symbol}-${i}`}>
                      <td className="font-semibold">
                        <span className="inline-flex items-center gap-1.5">
                          <SymbolButton symbol={lot.symbol} />
                          {lot.ledgerMismatch && (
                            <Chip
                              tone="warn"
                              title="This symbol's recorded lots disagree with the live broker position (wrong side, wrong size, or no position at all).  Its lot-derived figures are suppressed and it is excluded from wash-sale and early-exit tax math."
                            >
                              ledger mismatch
                            </Chip>
                          )}
                        </span>
                      </td>
                      <td className="num con-num">{fmtQty(lot.quantity)}</td>
                      <td className="num con-num">{lot.daysHeld}</td>
                      <td className="num con-num">{lot.isLongTerm ? "long-term" : `${lot.daysToLongTerm}d`}</td>
                      <td className="num">
                        {typeof lot.unrealizedGain === "number" ? (
                          <SignedText value={lot.unrealizedGain}>{fmtSignedMoney(lot.unrealizedGain)}</SignedText>
                        ) : (
                          EM_DASH
                        )}
                      </td>
                      <td className="num con-num" title="Extra estimated tax if sold now vs waiting for long-term treatment.">
                        {typeof lot.earlyExitTaxPremium === "number" ? `~${fmtMoney(lot.earlyExitTaxPremium)}` : EM_DASH}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {(tax.ledgerMismatchedSymbols?.length ?? 0) > 0 && (
            <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              {tax.ledgerMismatchedSymbols!.length} symbol{tax.ledgerMismatchedSymbols!.length === 1 ? "" : "s"} (
              {tax.ledgerMismatchedSymbols!.join(", ")}) excluded from wash-sale and early-exit tax figures — the
              recorded lot ledger disagrees with the live broker positions (see the row chip). The rows stay visible;
              their money figures are suppressed rather than computed from wrong lots.
            </p>
          )}
        </div>
      )}

      {tax.harvestCandidates.length > 0 && (
        <div>
          <div className="con-card-title mb-1">Loss-Harvest Candidates</div>
          <div className="flex flex-wrap gap-1.5">
            {tax.harvestCandidates.slice(0, 8).map((h) => (
              <Chip key={h.symbol} tone="muted">
                <SymbolButton symbol={h.symbol} className="text-inherit" /> {fmtSignedMoney(h.unrealizedLoss)}
              </Chip>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
