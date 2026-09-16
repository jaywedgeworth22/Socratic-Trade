"use client";

/** Autonomy Desk — "what does Socratic Trade believe, what did it do,
 *  what evidence moved it, and how should the framework improve?" */

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  Check,
  Database,
  GitBranch,
  MessageSquare,
  RotateCcw,
  TrendingUp,
  X,
  Zap
} from "lucide-react";
import type { DashboardSnapshot, StrategyDecision } from "../dashboard-types";
import { formatSourceList, friendlySource } from "@/lib/dashboard-ui";
import type { BenchmarkComparison, MarketQuote, PendingProposal, SocraticDecisionCase, SocraticFrameworkProposal, TradeProposal } from "@/lib/types";
import { BenchmarkChart } from "./components/benchmark-chart";
import { EquityChart } from "./components/equity-chart";
import { PositionsCard } from "./components/positions";
import { ReadinessChecklistHero } from "./components/readiness-checklist";
import { deriveDayPnl, deriveMarkToMarket, deriveReality, deriveRiskUtilization, deriveSpend, deriveStateInfo, selectEquityWindow } from "./lib/derive";
import { cx, EM_DASH, fmtDay, fmtExact, fmtMoney, fmtMoneyWhole, fmtPct, fmtSignedMoney, SENTENCE_GAP, timeUntil } from "./lib/format";
import { describeLastRun } from "./lib/last-run";
import {
  decisionStatusLabel,
  evidenceKindLabel,
  frameworkPriorityLabel,
  frameworkStatusLabel,
  frameworkSubsystemLabel,
  plainLabel,
  thesisTagLabel
} from "./lib/labels";
import { redTeamFailureMeta, redTeamVerdictLabel } from "./lib/red-team";
import { decisionActionLabel, deterministicOutcomePresentation, isSuccessfulApprovalResult, splitThesisRationale } from "./lib/thesis";
import { useConsoleData } from "./lib/useConsoleData";
import { safeTopCandidates } from "./lib/evidence-rows";
import { destinationLabel } from "./components/nav";
import { Ago, Card, Chip, Dash, Meter, SignedText, Stat } from "./ui/primitives";
import { SymbolButton } from "./ui/symbol-drilldown";
import { isExecutedStatus, isNotPlacedStatus, isProposalRowApprovable, proposalChipTone, sideVerb } from "./lib/action-verbs";
import { approveProposal, LiveConfirmationRequiredError } from "./lib/api";
import { approvalHomeToast } from "./lib/approval-honesty";
import { applyCoachChipPrefill, COACH_NOTE_CHIPS } from "./lib/coach-chips";
import { Sheet } from "./ui/sheet";
import { useToast } from "./ui/toast";

export default function ConsoleHomePage() {
  const { snapshot, refresh } = useConsoleData();

  // C4: memoize pure derives so a parent re-render with a stable snapshot object
  // does not re-walk equity curves / risk meters / framework rows.
  const derived = useMemo(() => {
    if (!snapshot) return null;
    const reality = deriveReality(snapshot);
    const state = deriveStateInfo(snapshot.policy);
    const spend = deriveSpend(snapshot);
    const portfolio = snapshot.portfolio;
    const dayPnl = deriveDayPnl(snapshot.performance, reality.mode, portfolio, undefined, snapshot.performance?.dayPnlHints);
    const markToMarket = deriveMarkToMarket(snapshot);
    const risk = deriveRiskUtilization(snapshot);
    const equityWindow = selectEquityWindow(
      reality.mode === "broker/live"
        ? snapshot.performance?.liveEquityCurve ?? []
        : snapshot.performance?.paperEquityCurve ?? []
    );
    const latest = snapshot.latestStrategyRun;
    const latestRow = snapshot.strategyRuns?.[0];
    const lastRun = latestRow ? describeLastRun(latestRow) : null;
    const nextRun = snapshot.scheduler?.nextRunAt;
    const primaryDecision = snapshot.socratic?.decisions?.[0];
    const primaryTrace = latest?.proposals?.[0];
    const primaryProposal = primaryTrace?.proposal ?? snapshot.pendingProposals[0]?.proposal;
    const traceRows =
      latest?.proposals?.slice(0, 5).map((item) =>
        decisionFromProposal(
          item.id ?? `${latest?.runId}-${item.proposal.symbol}-${item.status}`,
          item.proposal,
          item.status,
          item.reasons,
          latest.createdAt,
          Boolean(item.id) && item.status === "proposed"
        )
      ) ?? [];
    const latestProposals =
      traceRows.length > 0
        ? traceRows
        : snapshot.pendingProposals.slice(0, 5).map((pending) => decisionFromPending(pending));
    const previousTrades = snapshot.socratic?.decisions?.slice(0, 5).map(decisionFromSocratic) ?? [];
    const frameworkRows = deriveFrameworkRows(snapshot);
    const hasFrameworkProposals = (snapshot.socratic?.frameworkProposals?.length ?? 0) > 0;
    return {
      reality,
      state,
      spend,
      portfolio,
      dayPnl,
      markToMarket,
      risk,
      equityWindow,
      latest,
      latestRow,
      lastRun,
      nextRun,
      primaryDecision,
      primaryProposal,
      latestProposals,
      previousTrades,
      frameworkRows,
      hasFrameworkProposals
    };
  }, [snapshot]);

  if (!snapshot || !derived) return null;

  const {
    reality,
    state,
    spend,
    portfolio,
    dayPnl,
    markToMarket,
    risk,
    equityWindow,
    latest,
    latestRow,
    lastRun,
    nextRun,
    primaryDecision,
    primaryProposal,
    latestProposals,
    previousTrades,
    frameworkRows,
    hasFrameworkProposals
  } = derived;

  // Intentionally full-bleed (no CONSOLE_PAGE_WIDTH cap, see ./lib/page-width.ts):
  // this is a two-column dashboard (main column + aside, aside floored at
  // 320px via xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)] below), not
  // a single reading column like the other console pages. Capping it to
  // CONSOLE_PAGE_WIDTH would starve the main column to satisfy the aside's
  // floor. See docs/rollouts/2026-07-08-console-page-width-parity.md.
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[length:var(--con-fs-lg)] font-bold">{destinationLabel("/console")}</h1>
      {/* First-run checklist (PR-A3): when incomplete it dominates Thesis above the
          strategy bar + two-column desk; when ready it collapses to "You're set". */}
      <ReadinessChecklistHero snapshot={snapshot} />

      <section className="con-strategy-bar">
        <span className="con-card-title flex items-center gap-1.5">
          <Brain size={13} /> Strategy
        </span>
        <Chip tone={state.tone === "warn" ? "warn" : state.tone === "neg" ? "neg" : state.tone === "muted" ? "muted" : "pos"} title={state.detail}>
          {state.label}
        </Chip>
        {primaryProposal?.redTeamVerdict?.available && (
          <Chip tone={primaryProposal.redTeamVerdict.rejected ? "neg" : "pos"}>
            {primaryProposal.redTeamVerdict.rejected ? "Red Team: thesis rejected" : "Red Team: thesis survived"}
          </Chip>
        )}
        {latestRow && lastRun && (
          <span
            className={cx(
              "text-[length:var(--con-fs-xs)]",
              lastRun.failed
                ? "text-[color:var(--con-neg)]"
                : lastRun.skipped
                  ? "text-[color:var(--con-warn)]"
                  : "text-[color:var(--con-muted)]"
            )}
            title={lastRun.title}
          >
            Last run {lastRun.statusLabel} · <Ago iso={latestRow.finishedAt ?? latestRow.startedAt} />
            {lastRun.cause && (
              <>
                {" "}
                {EM_DASH} {lastRun.cause}
              </>
            )}
          </span>
        )}
        {/* Only on failure. The "Latest strategy run" card below has its own Activity link,
            but that card renders only when the run produced proposals — which a failed run
            usually did not, so on exactly the occasion you most want the record there is no
            way through to it from here. */}
        {lastRun?.failed && (
          <Link href="/console/activity" className="text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]">
            {destinationLabel("/console/activity")}
          </Link>
        )}
        {state.state === "active" && nextRun && (
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
            Next {timeUntil(nextRun)} · {snapshot.policy.runCadenceMinutes}m cadence
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-[length:var(--con-fs-xs)]">
          {snapshot.portfolioReadError ? (
            <Chip tone="warn" title={snapshot.portfolioReadError}>
              Portfolio fetch failed: {snapshot.portfolioReadError.length > 50 ? snapshot.portfolioReadError.slice(0, 50) + "..." : snapshot.portfolioReadError}
            </Chip>
          ) : typeof spend.capNotional === "number" ? (
            <>
              <span className="con-num font-semibold text-[color:var(--con-fg)]">
                {fmtMoneyWhole(Math.max(0, spend.capNotional - spend.usedNotional))}
              </span>
              <span className="text-[color:var(--con-muted)]">
                opening authority of{" "}
                {spend.capMode === "pct_nav"
                  ? `${fmtPct(spend.capConfiguredValue, 1)} cap`
                  : `${fmtMoneyWhole(spend.capNotional)} cap`}
              </span>
            </>
          ) : (
            <>
              <span className="con-num font-semibold text-[color:var(--con-fg)]">
                {fmtMoney(portfolio?.buyingPower)}
              </span>
              <span className="text-[color:var(--con-muted)]">buying power</span>
            </>
          )}
        </span>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {latestProposals.length > 0 ? (
            <Card
              title={
                <span className="flex items-center gap-1.5">
                  <Zap size={13} /> Latest Strategy Run
                </span>
              }
              action={
                <Link href="/console/activity" className="flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]">
                  {destinationLabel("/console/activity")} <ArrowRight size={12} />
                </Link>
              }
            >
              <div className="flex flex-col gap-2">
                {latestProposals.map((row) => {
                  const proposal = row.proposal ?? row.decision;
                  const decision = row.decision;
                  
                  return (
                    <ProposalRow
                      key={row.id}
                      row={row}
                      latest={latest}
                      proposal={proposal as TradeProposal}
                      decision={decision}
                      snapshot={snapshot}
                      refresh={refresh}
                    />
                  );
                })}
              </div>
            </Card>
          ) : (
            <Card
              title={
                <span className="flex items-center gap-1.5">
                  <Zap size={13} /> Autonomous Actions
                </span>
              }
              action={
                <Link href="/console/activity" className="flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]">
                  {destinationLabel("/console/activity")} <ArrowRight size={12} />
                </Link>
              }
            >
              <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                No recent autonomous actions are in the snapshot yet.  Run Socratic Trade once to create the first
                persisted decision trace.
              </p>
            </Card>
          )}

          

          <Card
            title={
              <span className="flex items-center gap-1.5">
                <TrendingUp size={13} /> Outcome Learning Loop
              </span>
            }
            action={
              <Link href="/console/results" className="flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]">
                {destinationLabel("/console/results")} <ArrowRight size={12} />
              </Link>
            }
          >
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label={reality.tone === "paper" ? "Portfolio Value · Paper" : "Portfolio Value"}
                value={fmtMoney(portfolio?.totalMarketValue)}
                sub={reality.tone === "paper" ? reality.phrase : reality.account?.label}
              />
              <div>
                <div className="con-card-title">Day P&amp;L</div>
                <div className="con-num mt-1 text-[length:var(--con-fs-xl)] font-semibold leading-tight">
                  {dayPnl ? (
                    <SignedText value={dayPnl.pnl}>
                      {fmtSignedMoney(dayPnl.pnl)} ({fmtPct(dayPnl.pct, 2, true)})
                    </SignedText>
                  ) : (
                    <Dash />
                  )}
                </div>
                <div
                  className={cx(
                    "mt-0.5 text-[length:var(--con-fs-xs)]",
                    dayPnl?.isStaleBaseline ? "font-semibold text-[color:var(--con-warn)]" : "text-[color:var(--con-faint)]"
                  )}
                  title={
                    dayPnl
                      ? dayPnl.isStaleBaseline
                        ? `Baseline: ${fmtMoney(dayPnl.baselineEquity)} at ${fmtExact(dayPnl.baselineAt)}.  No snapshot was persisted between then and today, so this compares across a real gap, not just "yesterday" — treat it as directional only.`
                        : `Baseline: ${fmtMoney(dayPnl.baselineEquity)} at ${fmtExact(dayPnl.baselineAt)}`
                      : undefined
                  }
                >
                  {dayPnl
                    ? dayPnl.isStaleBaseline
                      ? `No recent baseline — comparing to ${fmtDay(dayPnl.baselineAt)}`
                      : "vs last snapshot before today"
                    : "no prior-day snapshot yet"}
                </div>
              </div>
              <Stat label="Cash" value={fmtMoney(portfolio?.cash)} sub={`Buying power ${fmtMoney(portfolio?.buyingPower)}`} />
              <Stat
                label="Closed Thesis Samples"
                value={snapshot.thesisScorecard?.reduce((sum, t) => sum + t.trades, 0) ?? 0}
                sub="basis for future framework changes"
              />
            </div>
          </Card>

          <MarkToMarketCard markToMarket={markToMarket} equityWindow={equityWindow} />
          <VsMarketCard benchmark={snapshot.performance?.benchmark} />
          <PositionsCard snapshot={snapshot} />

          {previousTrades.length > 0 && (
            <div className="flex flex-col gap-4 mt-6">
              <div className="flex items-center justify-between">
                <h2 className="text-[length:var(--con-fs-lg)] font-semibold">Previous Trades</h2>
                <Link href="/console/decisions" className="flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]">
                  All Decisions <ArrowRight size={12} />
                </Link>
              </div>
              {previousTrades.map((row) => (
                <ProposalRow
                  key={row.id}
                  row={row}
                  latest={latest}
                  proposal={row.proposal}
                  decision={row.decision}
                  snapshot={snapshot}
                  refresh={refresh}
                />
              ))}
            </div>
          )}
        </div>

        <aside className="flex min-w-0 flex-col gap-4">
          <RiskUtilizationCard risk={risk} />
          <MarketAnalysisCard snapshot={snapshot} />

          

          <Card
            title={
              <span className="flex items-center gap-1.5">
                <MessageSquare size={13} /> Coach Socratic Trade
              </span>
            }
            action={
              <Link href="/console/assistant" className="flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]">
                Coach <ArrowRight size={12} />
              </Link>
            }
          >
            <div className="con-coach-box">
              <p>
                {primaryDecision?.coachNotes?.length
                  ? primaryDecision.coachNotes.at(-1)
                  : "Tell it what it overweighted, underweighted, ignored, or should refocus on.  Coaching attaches to the decision case instead of disappearing into chat."}
              </p>
              <CoachNoteForm decision={primaryDecision} refresh={refresh} />
            </div>
          </Card>

          <Card
            title={
              <span className="flex items-center gap-1.5">
                <GitBranch size={13} /> Framework Improvements
              </span>
            }
            action={
              // The fallback body below renders thesis/regime scorecard rows, not framework
              // proposals — that data lives (and is fully rendered) on Results, not Strategy.
              // Only link to Strategy when framework proposals are actually shown here.
              <Link
                href={hasFrameworkProposals ? "/console/strategy" : "/console/results#thesis-regime"}
                className="flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]"
              >
                {hasFrameworkProposals ? "Strategy" : "Results"} <ArrowRight size={12} />
              </Link>
            }
          >
            {hasFrameworkProposals ? (
              <FrameworkProposalList proposals={snapshot.socratic?.frameworkProposals ?? []} refresh={refresh} />
            ) : (
              <div className="flex flex-col gap-2">
                {frameworkRows.map((row, idx) => (
                  <EvidenceCard key={idx} {...row} />
                ))}
              </div>
            )}
          </Card>

          <Card title="Run Cadence">
            {/* Run once lives only in the chrome bar (labeled desktop / icon-only phone).
                A second button here stacked under the sticky header on mobile — two "Run once"
                controls within ~1 inch (owner report). Cadence status chips stay local. */}
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={state.tone === "warn" ? "warn" : state.tone === "neg" ? "neg" : state.tone === "muted" ? "muted" : "pos"}>{state.label}</Chip>
              {latestRow && lastRun && (
                <Chip
                  tone={
                    lastRun.failed ? "neg" : lastRun.skipped ? "warn" : "muted"
                  }
                  title={lastRun.title}
                >
                  latest {lastRun.statusLabel} · <Ago iso={latestRow.finishedAt ?? latestRow.startedAt} />
                </Chip>
              )}
            </div>
            <div className="mt-3 border-t border-[color:var(--con-line)] pt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              {state.state === "active" && state.marketOpen === false ? (
                <span title={state.detail}>{state.detail}</span>
              ) : state.state === "active" && nextRun ? (
                <span title={fmtExact(nextRun)}>Next scheduled run {timeUntil(nextRun)} · cadence {snapshot.policy.runCadenceMinutes} min</span>
              ) : state.state === "active" ? (
                <span title={`Configured cadence: every ${snapshot.policy.runCadenceMinutes} minutes.`}>
                  Running now. Planned cadence is every {snapshot.policy.runCadenceMinutes} min; the next run time is not available in this snapshot.
                </span>
              ) : (
                <span title={`If restarted, scheduled runs use the configured cadence: every ${snapshot.policy.runCadenceMinutes} minutes.`}>
                  Not running now. If restarted, planned cadence is every {snapshot.policy.runCadenceMinutes} min.
                </span>
              )}
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function VsMarketCard({ benchmark }: { benchmark?: BenchmarkComparison }) {
  if (!benchmark) return null;
  const symbol = benchmark.benchmarkSymbol;
  return (
    <Card
      title={
        <span className="flex items-center gap-1.5">
          <TrendingUp size={13} /> Versus {symbol}
        </span>
      }
      action={
        <Link href="/console/results" className="flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]">
          Results <ArrowRight size={12} />
        </Link>
      }
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Your account"
          value={fmtPct(benchmark.accountReturnPct, 2, true)}
          sub={`${benchmark.startDate} → ${benchmark.endDate}`}
        />
        <Stat label={symbol} value={fmtPct(benchmark.benchmarkReturnPct, 2, true)} sub="same cash, chained" />
        <div>
          <div className="con-card-title">You vs that</div>
          <div className="con-num mt-1 text-[length:var(--con-fs-xl)] font-semibold leading-tight">
            <SignedText value={benchmark.dollarExcess}>{fmtSignedMoney(benchmark.dollarExcess)}</SignedText>
            <span className="mt-0.5 block text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-faint)]">
              {fmtPct(benchmark.excessReturnPct, 2, true)} time-weighted
            </span>
          </div>
        </div>
      </div>
      {benchmark.accountEquitySeries.length >= 2 && benchmark.shadowBenchmarkSeries.length >= 2 && (
        <div className="mt-4 border-t border-[color:var(--con-line)] pt-3">
          <BenchmarkChart
            account={benchmark.accountEquitySeries}
            shadow={benchmark.shadowBenchmarkSeries}
            accountLabel="Your account"
            benchmarkLabel={symbol}
          />
        </div>
      )}
      <p className="mt-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Same deposits and withdrawals as this account, applied at each day's cutoff.{SENTENCE_GAP}
        The dashed line is what those dollars would be if they had tracked {symbol}.
      </p>
    </Card>
  );
}

function MarkToMarketCard({
  markToMarket,
  equityWindow
}: {
  markToMarket: ReturnType<typeof deriveMarkToMarket>;
  equityWindow: ReturnType<typeof selectEquityWindow>;
}) {
  return (
    <Card
      title={
        <span className="flex items-center gap-1.5">
          <TrendingUp size={13} /> Mark to Market
        </span>
      }
    >
      {!markToMarket ? (
        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          No open positions are marked yet for this account.
        </p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Open Market Value" value={fmtMoney(markToMarket.marketValue)} />
            <div>
              <div className="con-card-title">Open P&amp;L</div>
              <div className="con-num mt-1 text-[length:var(--con-fs-xl)] font-semibold leading-tight">
                <SignedText value={markToMarket.unrealizedPnl}>
                  {fmtSignedMoney(markToMarket.unrealizedPnl)}
                  {markToMarket.unrealizedPct !== undefined ? ` (${fmtPct(markToMarket.unrealizedPct, 2, true)})` : ""}
                </SignedText>
              </div>
              <div
                className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
                title="Gross cost basis: the sum of |average entry price × quantity| across open positions, long and short alike.  The percentage above divides by this, not the net signed basis — a short position's capital is still capital at risk, not a subtraction from a long position's."
              >
                vs gross open cost basis {fmtMoney(markToMarket.costBasis)}
              </div>
            </div>
            <Stat label="Cash" value={fmtMoney(markToMarket.cash)} />
            <Stat label="Buying Power" value={fmtMoney(markToMarket.buyingPower)} />
          </div>
          <div className="mt-4 border-t border-[color:var(--con-line)] pt-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="con-card-title">{equityWindow.label}</div>
              <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                persisted account snapshots only
              </span>
            </div>
            <EquityChart points={equityWindow.points} label={equityWindow.label.toLowerCase()} />
          </div>
        </>
      )}
    </Card>
  );
}

function RiskUtilizationCard({ risk }: { risk: ReturnType<typeof deriveRiskUtilization> }) {
  const rows = [
    {
      label: "Daily Notional",
      used: fmtMoney(risk.dailyNotional.used),
      limit: typeof risk.dailyNotional.limit === "number" ? fmtMoneyWhole(risk.dailyNotional.limit) : "no cap",
      pct: risk.dailyNotional.pct
    },
    {
      label: "Opening Orders",
      used: String(risk.dailyOrders.used),
      limit: String(risk.dailyOrders.limit ?? 0),
      pct: risk.dailyOrders.pct
    },
    {
      label: "Capital Deployed",
      used: fmtMoney(risk.investedCapital.used),
      limit: typeof risk.investedCapital.limit === "number" ? fmtMoney(risk.investedCapital.limit) : "n/a",
      pct: risk.investedCapital.pct
    }
  ];
  return (
    <Card
      title={
        <span className="flex items-center gap-1.5">
          <Database size={13} /> Risk Utilization
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        {rows.map((row) => (
          <div key={row.label}>
            <div className="mb-1 flex items-center justify-between gap-3 text-[length:var(--con-fs-sm)]">
              <span className="font-semibold">{row.label}</span>
              <span className="con-num text-[color:var(--con-muted)]">
                {row.used} of {row.limit}
                {row.pct !== undefined ? ` · ${fmtPct(row.pct, 1)}` : ""}
              </span>
            </div>
            <Meter value={row.pct !== undefined ? row.pct : 0} max={100} label={row.label} />
          </div>
        ))}
      </div>
    </Card>
  );
}

function MarketAnalysisCard({ snapshot }: { snapshot: DashboardSnapshot }) {
  const { macroBoard, latestScan } = snapshot;
  if (!macroBoard) return null;

  return (
    <Card
      title={
        <span className="flex items-center gap-1.5">
          <TrendingUp size={13} /> Market Analysis
        </span>
      }
      action={
        <Link href="/console/macro" className="flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]">
          Details <ArrowRight size={12} />
        </Link>
      }
    >
      <div className="flex flex-col gap-3">
        <Stat label="Regime" value={macroBoard.regime || "Unknown"} />
        {latestScan?.breadthPct != null && (
          <Stat label="Market Breadth" value={fmtPct(latestScan.breadthPct, 1)} />
        )}
        {macroBoard.macro?.vix && (
          <Stat label="VIX" value={macroBoard.macro.vix} />
        )}
      </div>
    </Card>
  );
}

type DecisionRowData = {
  id: string;
  symbol: string;
  verb: string;
  size: string;
  status: string;
  rationale: string;
  href?: string;
  title?: string;
  confidence?: number;
  at?: string;
  approvable?: boolean;
  proposal?: any;
  decision?: any;
};

type EvidenceRow = {
  title: string;
  meta: string;
  metaTitle?: string;
  body: string;
  symbol?: string;
  quote?: MarketQuote;
  tone?: "pos" | "warn" | "neg" | "accent";
};

function deriveThesisHeadline(latest: StrategyDecision | undefined, proposal: TradeProposal | undefined, decision?: SocraticDecisionCase): string {
  if (decision?.thesis) {
    return `Market thesis: ${formatMarketThesis(decision.thesis, decision.symbol)}`;
  }
  if (proposal?.tradeThesisTag) {
    return `Market thesis: ${formatMarketThesis(proposal.tradeThesisTag, proposal.symbol)}`;
  }
  if (latest?.status && /skipped/.test(latest.status)) {
    return "Latest run was skipped before a decision — not a successful evaluation.";
  }
  if (latest?.summary) return "Latest run completed; Socratic Trade is holding its current posture.";
  return "Waiting for the next market thesis.";
}

function ThesisNarrative({
  latest,
  proposal,
  decision,
  status
}: {
  latest: StrategyDecision | undefined;
  proposal: TradeProposal | undefined;
  decision?: SocraticDecisionCase;
  status?: string;
}) {
  const rationale = decision?.rationale ?? proposal?.rationale;
  if (!rationale) {
    return (
      <p>
        {latest?.summary ?? "Run Socratic Trade to form a thesis from the current market, portfolio, evidence, and remembered outcomes."}
      </p>
    );
  }

  const parts = splitThesisRationale(
    rationale,
    decision?.greenTeamRationale ?? proposal?.greenTeamRationale
  );
  const redTeam = decision?.redTeamVerdict ?? proposal?.redTeamVerdict;
  const sizing = decision?.sizingSnapshot ?? proposal?.sizingSnapshot;
  const outcome = deterministicOutcomePresentation(status, decision?.policyDecision);
  const symbol = decision?.symbol ?? proposal?.symbol;
  const side = decision?.side ?? proposal?.side;
  const expression = symbol ? `Current expression: ${side ? `${side.toUpperCase()} ` : ""}${symbol}. ` : "";

  return (
    <div className="mt-3 grid gap-3 text-[length:var(--con-fs-sm)] leading-relaxed">
      <section className="rounded-control border border-[color:var(--con-pos-border)] border-l-4 border-l-[color:var(--con-pos)] bg-[color:var(--con-pos-soft)] px-3 py-2.5">
        <div className="text-[length:var(--con-fs-xs)] font-bold uppercase tracking-[0.12em] text-[color:var(--con-pos)]">
          Green Team proposal
        </div>
        <p className="mt-1">{expression}{parts.greenTeam}</p>
      </section>

      {(parts.checks || sizing) && (
        <section className="rounded-control border border-[color:var(--con-line)] px-3 py-2.5">
          <div className="text-[length:var(--con-fs-xs)] font-bold uppercase tracking-[0.12em] text-[color:var(--con-faint)]">
            Deterministic sizing &amp; risk receipts
          </div>
          {sizing && (
            <p className="mt-1 font-semibold">
              App-calculated at decision time: {fmtMoney(sizing.estimatedNotional)} = {fmtPct(sizing.estimatedPctOfNav, 2)} of {fmtMoney(sizing.portfolioValue)} NAV.
              {sizing.sizeBasis === "quantity" && sizing.quantity != null
                ? ` Broker route: ${sizing.quantity} share${sizing.quantity === 1 ? "" : "s"}.`
                : sizing.sizeBasis === "notional" && sizing.dollarAmount != null
                  ? ` Broker route: ${fmtMoney(sizing.dollarAmount)} notional.`
                  : ""}
              {sizing.dailyOpeningCap
                ? ` Daily opening cap: ${
                    sizing.dailyOpeningCap.mode === "pct_nav"
                      ? `${fmtPct(sizing.dailyOpeningCap.configuredValue, 1)} of NAV`
                      : `${fmtMoney(sizing.dailyOpeningCap.configuredValue)} fixed (${fmtPct(sizing.dailyOpeningCap.pctOfNav, 1)} of NAV)`
                  } = ${fmtMoney(sizing.dailyOpeningCap.effectiveNotional)}.`
                : ""}
              {sizing.dailyNotionalUsed != null
                ? ` Used today: ${fmtMoney(sizing.dailyNotionalUsed)}${
                    sizing.remainingDailyNotional != null
                      ? `; remaining: ${fmtMoney(sizing.remainingDailyNotional)}`
                      : ""
                  }.`
                : ""}
            </p>
          )}
          {parts.checks && <p className="mt-1">{parts.checks}</p>}
        </section>
      )}

      {redTeam && (
        <section className="rounded-control border border-[color:var(--con-neg-border)] border-l-4 border-l-[color:var(--con-neg)] bg-[color:var(--con-neg-soft)] px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[length:var(--con-fs-xs)] font-bold uppercase tracking-[0.12em] text-[color:var(--con-neg)]">
              Red Team review
            </div>
            <Chip
              tone={!redTeam.available ? "warn" : redTeam.rejected ? "neg" : "pos"}
              title={!redTeam.available ? redTeamFailureMeta(redTeam.failureKind).title : undefined}
            >
              {redTeamVerdictLabel(redTeam, decision?.policyDecision?.socraticOverride?.applied, status)}
            </Chip>
          </div>
          {!redTeam.available && (
            // #2552 parity with the PWA: name the CAUSE (which reviewer, which failure) instead
            // of only the outcome — the reviewer model is only shown when one actually ran.
            <p className="mt-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-warn)]">
              Red Team failed{redTeam.model ? ` — ${redTeam.model}` : ""} ({redTeamFailureMeta(redTeam.failureKind).label})
            </p>
          )}
          <p className="mt-1">{redTeam.reason}</p>
        </section>
      )}

      {outcome && (
        <section
          className={`rounded-control border px-3 py-2.5 ${
            outcome.tone === "pos"
              ? "border-[color:var(--con-pos-border)] bg-[color:var(--con-pos-soft)]"
              : outcome.tone === "neg"
                ? "border-[color:var(--con-neg-border)] bg-[color:var(--con-neg-soft)]"
                : "border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)]"
          }`}
        >
          <div className="text-[length:var(--con-fs-xs)] font-bold uppercase tracking-[0.12em] text-[color:var(--con-faint)]">
            Deterministic outcome · {outcome.label}
          </div>
          <p className="mt-1">{outcome.body}</p>
        </section>
      )}
    </div>
  );
}

function formatMarketThesis(raw: string, symbol?: string | null): string {
  const trimmed = raw.trim();
  const symbolPrefix = symbol ? new RegExp(`^${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:\\-]\\s*`, "i") : null;
  const withoutSymbol = symbolPrefix ? trimmed.replace(symbolPrefix, "") : trimmed;
  return withoutSymbol
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function decisionFromSocratic(decision: SocraticDecisionCase): DecisionRowData {
  const reasons = decision.policyDecision?.reasons ?? [];
  const rationale = decision.policyDecision?.socraticOverride?.applied
    ? `${decision.rationale} Override: ${decision.policyDecision.socraticOverride.thesis}`
    : decision.rationale;
  return {
    id: decision.id,
    symbol: decision.symbol ?? "Portfolio",
    verb: sideVerb(decision.side, decision.status),
    size: decision.notional ? fmtMoney(decision.notional) : EM_DASH,
    status: decision.status,
    rationale: withBlockReasons(rationale, decision.status, reasons),
    href: `/console/decisions/${encodeURIComponent(decision.id)}`,
    title: reasons.length > 0 ? `Policy reasons:\n${reasons.join("\n")}` : undefined,
    confidence: decision.confidenceScore,
    at: decision.createdAt,
    decision,
    approvable: false
  };
}

function decisionFromProposal(
  id: string,
  proposal: TradeProposal,
  status: string,
  reasons: string[] = [],
  at?: string,
  approvable = false
): DecisionRowData {
  return {
    id,
    symbol: proposal.symbol,
    verb: sideVerb(proposal.side, status),
    size: proposal.dollarAmount ? fmtMoney(proposal.dollarAmount) : proposal.quantity ? `${proposal.quantity} sh` : EM_DASH,
    status,
    rationale: withBlockReasons(proposal.rationale, status, reasons),
    title: reasons.length > 0 ? `Policy reasons:\n${reasons.join("\n")}` : undefined,
    confidence: proposal.confidenceScore,
    at,
    proposal,
    approvable
  };
}

function decisionFromPending(pending: PendingProposal): DecisionRowData {
  const proposal = pending.proposal;
  return {
    ...decisionFromProposal(pending.id, proposal, "pending", [], pending.createdAt, true),
    size: pending.estimatedNotional ? fmtMoney(pending.estimatedNotional) : proposal.dollarAmount ? fmtMoney(proposal.dollarAmount) : EM_DASH
  };
}

function deriveEvidenceRows(snapshot: DashboardSnapshot, latest: StrategyDecision | undefined, decision?: SocraticDecisionCase, proposal?: any): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  if (decision) {
    // Persisted decision cases can predate evidence/rag arrays or arrive partial from older rows.
    for (const item of (decision.evidence ?? []).slice(0, 5)) {
      const source = evidenceSourceLabel(item.source);
      rows.push({
        title: item.title,
        meta: [evidenceKindLabel(item.kind), source].filter(Boolean).join(" · "),
        metaTitle: source ? `Source: ${source}` : undefined,
        body: item.summary,
        tone: toneFromSocratic(item.tone)
      });
    }
    for (const rag of (decision.ragAttributions ?? []).slice(0, 2)) {
      if (rows.some((r) => r.body === rag.contribution)) continue;
      const source = evidenceSourceLabel(rag.source);
      rows.push({
        title: rag.docType ? `Retrieved ${plainLabel(rag.docType)}` : "Retrieved evidence",
        meta: [source, rag.score != null ? `score ${rag.score.toFixed(2)}` : rag.symbol].filter(Boolean).join(" · "),
        metaTitle: source ? `Source: ${source}` : undefined,
        body: rag.contribution,
        tone: "accent"
      });
    }
    if (rows.length > 0) return rows.slice(0, 6);
  }
  const scan = snapshot.latestScan;
  if (scan) {
    const sources = formatSourceList(scan.source);
    rows.push({
      title: "Market scan",
      meta: `${scan.returnedQuotes}/${scan.scannedSymbols} quotes${sources ? ` · ${sources}` : ""}`,
      metaTitle: sources ? `Quote sources: ${sources}` : "Quote sources were not recorded for this scan.",
      body:
        typeof scan.breadthPct === "number"
          ? `Market breadth was ${fmtPct(scan.breadthPct, 1)} when the thesis was formed.`
          : "The latest thesis links to a captured scan, with source attribution preserved.",
      tone: "accent"
    });
    // latestScan can be a truthy partial audit shape without topCandidates (strategy_run /
    // market_scan history). Never call .slice on a missing array — that white-screened /console.
    for (const candidate of safeTopCandidates(scan).slice(0, 3)) rows.push(evidenceFromCandidate(candidate));
  }

  const p = proposal ?? latest?.proposals?.[0]?.proposal ?? snapshot.pendingProposals[0]?.proposal;
  if (p?.proposedByModel) {
    rows.push({
      title: "Model attribution",
      meta: p.proposedByModel,
      body: "The proposal stores the model that actually generated it, so later outcome review can score models instead of guessing.",
      tone: "pos"
    });
  }
  if (p?.redTeamVerdict) {
    const verdict = p.redTeamVerdict;
    if (verdict.available) {
      rows.push({
        title: "Adversarial review",
        meta: verdict.model ?? "red team",
        body: verdict.reason,
        tone: verdict.rejected ? "neg" : "warn"
      });
    } else {
      const failure = redTeamFailureMeta(verdict.failureKind);
      rows.push({
        title: "Adversarial review FAILED",
        meta: [verdict.model, failure.label].filter(Boolean).join(" · ") || failure.label,
        metaTitle: failure.title,
        body: verdict.reason,
        tone: "warn"
      });
    }
  }
  return rows.slice(0, 6);
}

function evidenceFromCandidate(candidate: MarketQuote): EvidenceRow {
  const bullet = candidate.evidenceBulletins?.[0] ?? candidate.headlines?.[0];
  const sources = sourceListFromQuote(candidate) || evidenceSourceLabel(candidate.provider);
  const score = typeof candidate.score === "number" && Number.isFinite(candidate.score) ? candidate.score : 0;
  const changePct = typeof candidate.intradayChangePct === "number" && Number.isFinite(candidate.intradayChangePct) ? candidate.intradayChangePct : 0;
  return {
    title: candidate.symbol,
    symbol: candidate.symbol,
    quote: candidate,
    meta: `score ${Math.round(score)}${sources ? ` · ${sources}` : ""}`,
    metaTitle: sources ? `Data sources: ${sources}` : undefined,
    body:
      bullet ??
      `${candidate.companyName ?? candidate.symbol} was in the latest candidate set with ${fmtPct(changePct, 2, true)} intraday change.`,
    tone: changePct < 0 ? "warn" : "pos"
  };
}

function deriveDissentRows(proposal: TradeProposal | undefined, latest: StrategyDecision | undefined, decision?: SocraticDecisionCase): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  if (decision?.dissent?.length) {
    return decision.dissent.slice(0, 4).map((item) => ({
      title: item.title,
      meta: [evidenceKindLabel(item.kind), item.source].filter(Boolean).join(" · "),
      body: item.summary,
      tone: toneFromSocratic(item.tone)
    }));
  }
  if (proposal?.redTeamVerdict?.available) {
    rows.push({
      title: "Red Team review",
      meta: redTeamVerdictLabel(proposal.redTeamVerdict),
      body: proposal.redTeamVerdict.reason,
      tone: proposal.redTeamVerdict.rejected ? "neg" : "warn"
    });
  }
  const reasons = latest?.proposals?.[0]?.reasons ?? [];
  for (const reason of reasons.slice(0, 2)) {
    rows.push({ title: "Policy note", meta: "gate output", body: reason, tone: "warn" });
  }
  if (rows.length === 0) {
    rows.push({
      title: "No dissent recorded",
      meta: "current decision",
      body: "No red-team, policy, or invalidation counterargument has been attached to the latest decision yet.",
      tone: "accent"
    });
  }
  return rows.slice(0, 3);
}

function deriveFrameworkRows(snapshot: DashboardSnapshot): EvidenceRow[] {
  const proposals = snapshot.socratic?.frameworkProposals ?? [];
  if (proposals.length > 0) return proposals.slice(0, 5).map(frameworkToEvidenceRow);
  const rows: EvidenceRow[] = [];
  const topThesis = [...(snapshot.thesisScorecard ?? [])].sort((a, b) => b.trades - a.trades)[0];
  if (topThesis) {
    rows.push({
      title: topThesis.thesisTag,
      meta: `${topThesis.trades} closed · ${fmtPct(topThesis.winRate, 1)} win rate`,
      metaTitle: "Raw realized return for closed lots in this thesis bucket, not benchmark-relative.  The SPY comparison lives on Results.",
      body: `Raw average return ${fmtPct(topThesis.avgReturnPct, 2, true)}.  Socratic Trade should use this as earned evidence before changing sizing or thesis weight.`,
      tone: topThesis.avgReturnPct >= 0 ? "pos" : "warn"
    });
  }
  const topRegime = [...(snapshot.regimeScorecard ?? [])].sort((a, b) => b.trades - a.trades)[0];
  if (topRegime) {
    rows.push({
      title: topRegime.regime,
      meta: `${topRegime.trades} closed in regime`,
      metaTitle: "Raw realized return for closed lots opened in this regime, not benchmark-relative.  The SPY comparison lives on Results.",
      body: `Raw regime average return ${fmtPct(topRegime.avgReturnPct, 2, true)}.  Use this to challenge or support future regime-specific autonomy.`,
      tone: topRegime.avgReturnPct >= 0 ? "pos" : "warn"
    });
  }
  return rows;
}

function frameworkToEvidenceRow(proposal: SocraticFrameworkProposal): EvidenceRow {
  return {
    title: proposal.title,
    meta: `${frameworkStatusLabel(proposal.status)} · ${frameworkSubsystemLabel(proposal.subsystem)} · ${frameworkPriorityLabel(proposal.priority)}`,
    body: proposal.proposedChange,
    tone: proposal.priority === "high" ? "warn" : proposal.status === "accepted" || proposal.status === "applied" ? "pos" : "accent"
  };
}

function toneFromSocratic(tone: string | undefined): EvidenceRow["tone"] {
  if (tone === "positive") return "pos";
  if (tone === "negative") return "neg";
  if (tone === "warning") return "warn";
  return "accent";
}

function ProposalRow({
  row,
  latest,
  proposal,
  decision,
  snapshot,
  refresh
}: {
  row: DecisionRowData;
  latest: StrategyDecision | undefined;
  proposal: TradeProposal | undefined;
  decision: SocraticDecisionCase | undefined;
  snapshot: DashboardSnapshot;
  refresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [liveConfirm, setLiveConfirm] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState(0);
  const toast = useToast();

  const handleApprove = async () => {
    setBusy(true);
    try {
      const confirmBody = liveConfirm ? {
        proposalId: row.id,
        executionMode: "broker/live" as const,
        typedText: liveConfirm
      } : undefined;
      const res = await approveProposal(row.id, confirmBody);
      const outcome = approvalHomeToast(res.status, res.reasons);
      toast.push(outcome.tone, outcome.title, outcome.detail);
      if (isSuccessfulApprovalResult(res.status)) {
        setOpen(false);
        refresh();
      } else {
        refresh();
      }
    } catch (e: any) {
      if (e instanceof LiveConfirmationRequiredError) {
        setLiveConfirm(e.expectedText);
      } else {
        toast.push("neg", "Approval failed", e.message || String(e));
        // Remount the phrase field so a leftover matching value cannot dead-end
        // the sheet.  Keep Approve disabled while the ritual is showing — enabling
        // it would send the expected phrase without the owner typing it.
        setConfirmKey((key) => key + 1);
      }
    } finally {
      setBusy(false);
    }
  };

  const showApprove = isProposalRowApprovable(row.approvable, row.status);
  const evidenceRows = deriveEvidenceRows(snapshot, latest, decision);

  let combinedStatus = "";
  if (isExecutedStatus(row.status)) {
    combinedStatus = row.verb;
  } else {
    let statusText = decisionStatusLabel(row.status);
    if (statusText === "Placement pending" || statusText === "Proposed" || statusText === "Planned") {
      statusText = "Pending";
    }
    const sideNoun = row.verb === "Sell" ? "Sale" : row.verb;
    combinedStatus = `${sideNoun} ${statusText}`;
  }
  const chipTone = proposalChipTone(row.status);

  return (
    <>
      <div className="flex items-stretch gap-0 rounded-md border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)]">
        <div className="flex shrink-0 items-center px-2.5 py-2.5">
          {row.symbol === "Portfolio" ? <strong>{row.symbol}</strong> : <SymbolButton symbol={row.symbol} />}
        </div>
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-r-md p-2.5 text-left transition-colors hover:bg-[color:var(--con-surface-3)] focus-visible:bg-[color:var(--con-surface-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--con-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--con-surface-2)]"
          onClick={() => setOpen(true)}
          aria-label={`View ${row.symbol} proposal details`}
        >
          <Chip tone={chipTone}>
            {combinedStatus}
          </Chip>
          <span className="flex items-center gap-1 whitespace-nowrap text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            View details <ArrowRight size={12} />
          </span>
        </button>
      </div>
      
      <Sheet open={open} onClose={() => setOpen(false)} title={<span className="flex items-center gap-1.5"><Brain size={13} /> Proposal Details</span>} wide>
        <div className="flex flex-col gap-4 mt-2">
          <ThesisNarrative
            latest={latest}
            proposal={proposal}
            decision={decision}
            status={row.status}
          />
          {proposal?.tradeThesisTag && (
            <div className="flex flex-wrap gap-2">
              <Chip tone="accent" title="The thesis bucket this reasoning is filed under for later outcome scoring.">
                {thesisTagLabel(proposal.tradeThesisTag)}
              </Chip>
            </div>
          )}
          {evidenceRows.length > 0 && (
            <div className="border-t border-[color:var(--con-line)] pt-4 mt-2">
              <h3 className="font-semibold text-[length:var(--con-fs-sm)] flex items-center gap-1.5 mb-3">
                <Database size={13} /> Relevant Evidence
              </h3>
              <div className="flex flex-col gap-3">
                {evidenceRows.map((er, idx) => (
                  <EvidenceCard key={idx} {...er} />
                ))}
              </div>
            </div>
          )}
          {showApprove && (
            <div className="border-t border-[color:var(--con-line)] pt-4 mt-2 flex flex-col gap-2">
              {liveConfirm && (
                <div className="text-[length:var(--con-fs-sm)] p-3 bg-[color:var(--con-warn-soft)] border border-[color:var(--con-warn-border)] rounded-md">
                  <p className="mb-2 font-semibold text-[color:var(--con-warn)]">Live trading requires confirmation.  Type <strong>{liveConfirm}</strong> to proceed.</p>
                  <input
                    key={confirmKey}
                    type="text"
                    className="con-input w-full mb-2"
                    placeholder={liveConfirm}
                    onChange={(e) => {
                      if (e.target.value === liveConfirm) {
                        handleApprove();
                      }
                    }}
                  />
                </div>
              )}
              <button 
                className="con-btn con-btn-primary w-full justify-center" 
                onClick={handleApprove}
                disabled={busy || !!liveConfirm}
              >
                {busy ? "Approving..." : "Approve Proposal"}
              </button>
            </div>
          )}
        </div>
      </Sheet>
    </>
  );
}


function EvidenceCard({ title, meta, metaTitle, body, symbol, quote, tone = "accent" }: EvidenceRow) {
  return (
    <article className={`con-evidence-card con-evidence-${tone}`}>
      <div className="flex items-start justify-between gap-3">
        {symbol ? (
          <SymbolButton symbol={symbol} quote={quote}>
            {title}
          </SymbolButton>
        ) : (
          <strong>{title}</strong>
        )}
        <span title={metaTitle}>{meta}</span>
      </div>
      <p>{body}</p>
    </article>
  );
}

function withBlockReasons(rationale: string, status: string, reasons: string[]): string {
  if (reasons.length === 0) return rationale;
  if (!/blocked|failed|rejected|skipped/i.test(status)) return rationale;
  return `${rationale} Blocked because: ${reasons.slice(0, 3).join(" ")}${reasons.length > 3 ? " ..." : ""}`;
}

function evidenceSourceLabel(source?: string | null): string {
  if (!source) return "";
  return formatSourceList(source) || friendlySource(source);
}

function sourceListFromQuote(candidate: MarketQuote): string {
  const sources = Object.values(candidate.sources ?? {}).filter(Boolean);
  if (candidate.provider) sources.unshift(candidate.provider);
  return formatSourceList(sources.join("+"));
}

function CoachNoteForm({ decision, refresh }: { decision?: SocraticDecisionCase; refresh: () => Promise<void> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  if (!decision) return null;

  const applyChip = (prefill: string) => {
    setNote((current) => applyCoachChipPrefill(current, prefill));
    noteRef.current?.focus();
  };

  return (
    <form
      className="mt-3 flex flex-col gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        const trimmed = note.trim();
        if (!trimmed) return;
        setBusy(true);
        setMessage(null);
        try {
          const res = await fetch(`/api/socratic/decisions/${encodeURIComponent(decision.id)}/coach`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ note: trimmed })
          });
          if (!res.ok) throw new Error(await res.text());
          setNote("");
          setMessage("Saved.");
          await refresh();
        } catch (error) {
          setMessage(error instanceof Error ? error.message : "Could not save note.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="flex flex-wrap gap-2">
        {COACH_NOTE_CHIPS.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className="con-chip con-chip-muted cursor-pointer"
            onClick={() => applyChip(chip.prefill)}
          >
            {chip.label}
          </button>
        ))}
      </div>
      <textarea
        ref={noteRef}
        className="con-textarea"
        rows={3}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="What should Socratic Trade learn from this decision?"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="con-btn con-btn-primary con-btn-sm" disabled={busy || !note.trim()}>
          <MessageSquare size={14} /> Save Note
        </button>
        {message && <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">{message}</span>}
      </div>
    </form>
  );
}

function FrameworkProposalList({ proposals, refresh }: { proposals: SocraticFrameworkProposal[]; refresh: () => Promise<void> }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [reviewing, setReviewing] = useState(false);

  const pendingCount = proposals.filter((p) => p.status === "pending").length;

  const runAiReview = async () => {
    setReviewing(true);
    setMessage(null);
    try {
      const res = await fetch("/api/socratic/framework/review", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { reviewed?: number; skippedReason?: string };
      await refresh();
      setMessage(
        data.reviewed
          ? `AI reviewed ${data.reviewed} pending proposal${data.reviewed === 1 ? "" : "s"}.`
          : data.skippedReason === "no_pending"
            ? "No pending proposals to review."
            : data.skippedReason === "no_llm_key"
              ? "AI review needs an LLM key configured."
              : data.skippedReason === "over_budget"
                ? "AI review skipped: LLM budget spent."
                : "AI review produced no recommendations."
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not run AI review.");
    } finally {
      setReviewing(false);
    }
  };

  const update = async (
    proposal: SocraticFrameworkProposal,
    status: "pending" | "accepted" | "rejected" | "applied",
    ownerVerb?: "accept" | "reject" | "rewrite"
  ) => {
    setBusyId(proposal.id);
    setMessage(null);
    try {
      const ownerResponse = responses[proposal.id]?.trim();
      const res = await fetch(`/api/socratic/framework/${encodeURIComponent(proposal.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status,
          ...(ownerVerb ? { ownerVerb } : {}),
          ...(ownerResponse ? { ownerResponse } : {})
        })
      });
      if (!res.ok) throw new Error(await res.text());
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update proposal.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          Learning proposals across all accounts{pendingCount > 0 ? ` · ${pendingCount} shown pending` : ""}
        </span>
        {/* Not gated on the shown pendingCount: this list is truncated to the 25 most recent
            (mixed status), but the review route works on the FULL pending backlog server-side —
            so keep the button live whenever we're not already reviewing. */}
        <button
          type="button"
          className="con-btn con-btn-outline con-btn-sm"
          disabled={reviewing}
          onClick={() => void runAiReview()}
          title="Review every pending proposal (across all accounts) in a single LLM call and attach an advisory recommendation to each."
        >
          <Brain size={14} /> {reviewing ? "Reviewing…" : "AI review pending"}
        </button>
      </div>
      <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
        <strong>Accept</strong> = agree this change should be made (intent only — nothing auto-implements).{" "}
        <strong>Applied</strong> = you already put that change into policy/prompt/code.{" "}
        <strong>Rewrite</strong> = accept your edited text.{" "}
        <strong>Reject</strong> = discard.  Decisions can be changed anytime.
      </p>
      {proposals.slice(0, 5).map((proposal) => {
        const responseText = (responses[proposal.id] ?? proposal.ownerResponse ?? "").trim();
        const busy = busyId === proposal.id;
        return (
        <article key={proposal.id} className="con-evidence-card con-evidence-accent">
          <div className="flex items-start justify-between gap-3">
            <strong>{proposal.title}</strong>
            <span>{frameworkStatusLabel(proposal.status)}</span>
          </div>
          <p>{proposal.proposedChange}</p>
          {proposal.aiReview && (
            <div className="mt-2 rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2 text-[length:var(--con-fs-xs)]">
              <div className="flex items-center gap-2 font-semibold">
                <Brain size={13} /> AI recommends: {proposal.aiReview.verdict}
              </div>
              <p className="mt-1 text-[color:var(--con-muted)]">{proposal.aiReview.rationale}</p>
              {proposal.aiReview.verdict === "rewrite" && proposal.aiReview.rewrittenChange && (
                <div className="mt-2">
                  <p className="text-[color:var(--con-fg)]">{proposal.aiReview.rewrittenChange}</p>
                  <button
                    type="button"
                    className="con-btn con-btn-outline con-btn-sm mt-2"
                    disabled={busy}
                    onClick={() => setResponses((current) => ({ ...current, [proposal.id]: proposal.aiReview!.rewrittenChange ?? "" }))}
                  >
                    <MessageSquare size={13} /> Use suggested rewrite
                  </button>
                </div>
              )}
            </div>
          )}
          <textarea
            className="con-textarea mt-3"
            rows={3}
            value={responses[proposal.id] ?? proposal.ownerResponse ?? ""}
            onChange={(event) => setResponses((current) => ({ ...current, [proposal.id]: event.target.value }))}
            placeholder="Owner response or rewrite"
          />
          {proposal.ownerResponse && (
            <p className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              {proposal.ownerVerb ? `${proposal.ownerVerb}: ` : "Owner: "}
              {proposal.ownerResponse}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="con-btn con-btn-pos con-btn-sm"
              disabled={busy}
              title="Agree this proposed change should be made.  Does not auto-edit policy or prompts."
              onClick={() => void update(proposal, "accepted", "accept")}
            >
              <Check size={14} /> Accept
            </button>
            <button
              type="button"
              className="con-btn con-btn-outline con-btn-sm"
              disabled={busy || !responseText}
              title="Accept using the text in Owner response as the rewritten proposed change."
              onClick={() => void update(proposal, "accepted", "rewrite")}
            >
              <MessageSquare size={14} /> Rewrite
            </button>
            <button
              type="button"
              className="con-btn con-btn-outline con-btn-sm"
              disabled={busy || (proposal.status !== "accepted" && proposal.status !== "applied")}
              title="Mark that you already implemented the accepted change (policy, prompt, or code)."
              onClick={() => void update(proposal, "applied")}
            >
              <GitBranch size={14} /> Applied
            </button>
            <button
              type="button"
              className="con-btn con-btn-danger-outline con-btn-sm"
              disabled={busy}
              title="Discard this proposal.  You can change your mind later."
              onClick={() => void update(proposal, "rejected", "reject")}
            >
              <X size={14} /> Reject
            </button>
            {proposal.status !== "pending" && (
              <button
                type="button"
                className="con-btn con-btn-outline con-btn-sm"
                disabled={busy}
                title="Return this proposal to Pending so it can be re-reviewed."
                onClick={() => void update(proposal, "pending")}
              >
                <RotateCcw size={14} /> Reopen
              </button>
            )}
          </div>
        </article>
        );
      })}
      {message && <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">{message}</span>}
    </div>
  );
}
// PR trigger
