"use client";

/** Receipt-style approval cards. Each pending proposal renders as a decision
 *  receipt: what/how much, the thesis + confidence, the adversarial (red team)
 *  verdict, what has happened since it was proposed, the policy-gate status,
 *  and an honest three-outcomes block. Brokerage approvals go through the
 *  server's typed-confirmation contract (LIVE_CONFIRMATION_REQUIRED). */

import { memo, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, CircleAlert, Database, Ruler, ShieldCheck, Swords, TrendingUp } from "lucide-react";
import { requestedExitQuantity } from "@/lib/broker-held-orders";
import { isModelRotationSentinel } from "@/lib/llm-request";
import { canonicalModelId } from "@/lib/model-identity";
import { normalizeSymbol } from "@/lib/money";
import { resolveDailyOpeningCap } from "@/lib/policy-caps";
import type { PendingProposal, SocraticDecisionCase, SocraticRagAttribution, TradingPolicy, TradeProposal } from "@/lib/types";
import type { DashboardSnapshot } from "../../dashboard-types";
import {
  approveProposal,
  rejectProposal,
  retryRedTeam,
  ConsoleApiError,
  LiveConfirmationRequiredError,
  type ApproveResult
} from "../lib/api";
import {
  delayAdvantageUsd,
  delayedFallbackStampLabel,
  delayedFallbackStampTitle,
  nameMovePct,
  pendingShowsDelayedFallback,
  resolveProposedPrice,
  resolveProposalStop,
  resolveProposalTarget
} from "@/lib/proposal-price-review";
import { resolveApprovalExecutionMode, willPromptTypedApproval } from "../lib/approval-honesty";
import { deriveReality, estimatedClosingPnl, isClosingOrder, positionMarkPrice, realityForMode } from "../lib/derive";
import { cx, fmtMoney, fmtNum, fmtPct, fmtQty, fmtSignedMoney, timeUntil, EM_DASH } from "../lib/format";
import { feedStatusLabel, plainLabel, thesisTagLabel } from "../lib/labels";
import { modelDisplayName } from "../lib/models";
import { redTeamCardState, redTeamFailureMeta, redTeamFailureModel, redTeamVerdictLabel } from "../lib/red-team";
import { EXIT_ONLY_OWNER_APPROVE_NOTE } from "@/lib/proposal-actions";
import { ProposalScorecardBlock } from "./proposal-scorecard";
import { proposalGreenRationale, proposalHumanReviewReasons } from "../lib/thesis";
import { useConsoleData } from "../lib/useConsoleData";
import { useToast } from "../ui/toast";
import { Ago, Btn, Chip, LiveTag, SignedText, TextInput } from "../ui/primitives";
import { ModelBadge } from "../ui/provider-logo";
import { Sheet } from "../ui/sheet";
import { SymbolButton } from "../ui/symbol-drilldown";
import { DEEP_LINK_FOCUS_CLASS, proposalElementId } from "../lib/deep-link-focus";

const SIDE_LABEL: Record<string, string> = { buy: "BUY", sell: "SELL", short: "SHORT", cover: "COVER" };
const STOP_PLAN_DISPLAY: Record<string, string> = { fixed: "Fixed", atr: "ATR", trailing: "Trailing", none: "None" };

function isExit(side: string): boolean {
  return side === "sell" || side === "cover";
}

function estNotional(p: PendingProposal): number | undefined {
  const v = p.estimatedNotional ?? p.review?.estimatedNotional ?? p.proposal.dollarAmount;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

type RedTeamTrigger = NonNullable<NonNullable<TradeProposal["redTeamVerdict"]>["trigger"]>;

function redTeamTriggerMeta(trigger?: RedTeamTrigger) {
  switch (trigger) {
    case "all_openings":
      return { label: "risk-adding opening", title: "Every risk-adding opening gets the single Red Team review at its finalized size — coverage is structural, not conviction-gated." };
    case "confidence":
      return { label: "confidence", title: "The Green Team confidence cleared the configured Red Team conviction threshold." };
    case "notional":
      return { label: "large notional", title: "The order was large enough as a percentage of NAV to require adversarial review." };
    case "live_opening":
      return { label: "live opening", title: "A live opening order always gets the Red Team receipt when the debate path is available." };
    case "override_requested":
      return { label: "override request", title: "The proposal asked to override an owner preference, so the Red Team reviewed the dissent." };
    case "escalation_regime":
      return { label: "risk regime", title: "The entry regime was Risk-Off, Crisis, or Inverted, so the Red Team reviewed the setup." };
    default:
      return { label: "legacy confidence", title: "Older persisted verdicts predate the trigger field; they came from the original confidence threshold." };
  }
}

function rewardRiskFor(pending: PendingProposal) {
  const p = pending.proposal;
  if (p.side !== "buy" && p.side !== "short") return null;
  const entry = p.referencePrice ?? pending.proposalReferencePrice ?? p.limitPrice;
  const stop = p.bracketStopLoss;
  const target = p.bracketTakeProfit;
  if (!finite(entry) || !finite(stop) || !finite(target) || entry <= 0) return null;

  const reward = p.side === "short" ? entry - target : target - entry;
  const risk = p.side === "short" ? stop - entry : entry - stop;
  if (reward <= 0 || risk <= 0) return null;
  return { entry, stop, target, reward, risk, ratio: reward / risk };
}

function matchedDecision(snapshot: DashboardSnapshot | null, pending: PendingProposal): SocraticDecisionCase | undefined {
  return snapshot?.socratic?.decisions?.find((decision) => decision.proposalId === pending.id);
}

export function normalizeModelId(model: string | null | undefined): string {
  return canonicalModelId(model);
}

/** Human phrase for a persisted Green failover receipt, e.g. "gpt-5.6-terra failed (HTTP 400)". */
function failoverCause(fallback: NonNullable<TradeProposal["greenServedByFallback"]>): string {
  return fallback.reason ? `${fallback.fromModel} failed (${fallback.reason})` : `${fallback.fromModel} did not serve`;
}

export function modelProvenance(p: TradeProposal, policy: TradingPolicy | undefined): string {
  const configured = policy?.llmModel?.trim();
  const served = p.proposedByModel?.trim();
  // A rotating policy EXPECTS a different served model each run — say so plainly instead of
  // leaking the raw "__rotate__" sentinel and framing the rotation pick as an anomaly.
  const rotating = isModelRotationSentinel(configured);
  // A persisted failover receipt outranks both branches below: it is the only source that knows
  // the served model was NOT the model the run intended, and it must not be dressed up as a pick.
  if (served && p.greenServedByFallback) {
    const cause = failoverCause(p.greenServedByFallback);
    return rotating
      ? `configured to rotate; rotation pick ${cause}; served by fallback ${served}`
      : `${cause}; served by fallback ${served}`;
  }
  if (served && rotating) return `configured to rotate; served ${served} (this run's rotation pick)`;
  const normConfigured = normalizeModelId(configured);
  const normServed = normalizeModelId(served);
  if (served && configured && normServed !== normConfigured) return `served ${served}; configured primary was ${configured}`;
  if (served) return `served ${served}`;
  if (rotating) return "policy rotates models each run; the concrete pick was not persisted on this legacy proposal";
  if (configured) return `configured primary ${configured}; served model not persisted on this legacy proposal`;
  return "served model not exposed on this proposal";
}

export function fallbackProvenance(p: TradeProposal, policy: TradingPolicy | undefined): string {
  const fallbackModels = policy?.llmFallbackModels?.filter(Boolean) ?? [];
  const normServed = normalizeModelId(p.proposedByModel);
  const normFallbackModels = fallbackModels.map(normalizeModelId);
  // The proposal's OWN receipt wins over every inference below.  The run appends implicit pool
  // fallbacks when the Green seat rotates and the owner listed none, so "rotating, therefore not a
  // failover" was never a safe deduction — it just happened to be unfalsifiable from this file.
  if (p.proposedByModel && p.greenServedByFallback) {
    const fallback = p.greenServedByFallback;
    const position = fallback.attempt && fallback.attempts ? ` (attempt ${fallback.attempt} of ${fallback.attempts})` : "";
    return `${failoverCause(fallback)}; served by fallback ${p.proposedByModel}${position}`;
  }
  if (p.proposedByModel && normFallbackModels.includes(normServed)) return `served by configured fallback ${p.proposedByModel}`;
  if (p.proposedByModel && isModelRotationSentinel(policy?.llmModel)) {
    return "policy rotates models — this run's rotation pick served; no failover was recorded";
  }
  const normConfigured = normalizeModelId(policy?.llmModel);
  if (p.proposedByModel && policy?.llmModel && normServed !== normConfigured) return "served model differs from configured primary";
  if (fallbackModels.length > 0) return `fallback chain configured (${fallbackModels.length}); no per-hop history on this card`;
  return "no fallback chain configured";
}

function evidenceLabel(item: SocraticRagAttribution): string {
  return (
    [plainLabel(item.docType), item.source, finite(item.score) ? `score ${item.score.toFixed(2)}` : undefined].filter(Boolean).join(" · ") ||
    "Retrieved evidence"
  );
}

function expiryIso(p: PendingProposal, policy: TradingPolicy): string | null {
  const minutes = policy.proposalExpiryMinutes;
  if (!minutes || minutes <= 0) return null;
  const t = new Date(p.createdAt).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t + minutes * 60_000).toISOString();
}

/** Compact red-team chip for the default collapsed card (PR-A2). Full verdict text
 *  stays in the expanded "Show full reasoning" body. Exported for unit tests. */
export type RedTeamSummaryChip = {
  tone: "pos" | "neg" | "warn" | "muted" | "accent";
  label: string;
  title: string;
};

export function redTeamCollapsedChip(
  redCard: ReturnType<typeof redTeamCardState>,
  verdict: TradeProposal["redTeamVerdict"] | undefined,
  overrideApplied?: boolean,
  configuredRedTeamModel?: string | null
): RedTeamSummaryChip {
  // Alias used by tests / call sites that prefer the program name.
  return redTeamSummaryChip(redCard, verdict, overrideApplied, configuredRedTeamModel);
}

/** Program name for the collapsed-card AI-critic chip (PR-A2). */
export function redTeamSummaryChip(
  redCard: ReturnType<typeof redTeamCardState>,
  verdict: TradeProposal["redTeamVerdict"] | undefined,
  overrideApplied?: boolean,
  configuredRedTeamModel?: string | null
): RedTeamSummaryChip {
  if (redCard === "verdict-panel" && verdict) {
    if (!verdict.available) {
      // #2552: the chip carries the CAUSE, not a bare "failed" — the PWA already renders
      // "Red team FAILED (malformed response) — DeepSeek" and the console hid it. A
      // not-configured "failure" is a different situation (nothing tried to run) and gets a
      // muted, distinctly-labeled chip instead of the warn failure treatment.
      const failureMeta = redTeamFailureMeta(verdict.failureKind);
      if (verdict.failureKind === "not_configured") {
        return { tone: "muted", label: "AI critic: not configured", title: failureMeta.title };
      }
      const failedModel = redTeamFailureModel(verdict, configuredRedTeamModel);
      const cause = failedModel ? `${modelDisplayName(failedModel)}: ${failureMeta.label}` : failureMeta.label;
      return {
        tone: "warn",
        label: `AI critic failed — ${cause}`,
        title: verdict.reason ? `${failureMeta.title} ${verdict.reason}` : failureMeta.title
      };
    }
    if (verdict.rejected || verdict.verdict === "reject") {
      return {
        tone: "neg",
        label: "AI critic: reject",
        title: redTeamVerdictLabel(verdict, overrideApplied)
      };
    }
    if (verdict.verdict === "approve-at-half") {
      return {
        tone: "warn",
        label: "AI critic: half size",
        title: redTeamVerdictLabel(verdict, overrideApplied)
      };
    }
    return {
      tone: "pos",
      label: "AI critic: approve",
      title: redTeamVerdictLabel(verdict, overrideApplied)
    };
  }
  if (redCard === "legacy-unavailable") {
    return {
      tone: "warn",
      label: "AI critic: unavailable",
      title: "The adversarial review was required but could not run — you are the sole reviewer."
    };
  }
  return {
    tone: "muted",
    label: "No AI critic",
    title: "No adversarial review ran for this proposal — below every dissent trigger."
  };
}

/** Wave C: memo so parent dashboard re-renders do not rebuild every card. */
export const ApprovalCard = memo(function ApprovalCard({
  pending,
  focused = false
}: {
  pending: PendingProposal;
  focused?: boolean;
}) {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [busy, setBusy] = useState<"approve" | "reject" | "retry" | null>(null);
  const actionBusy = busy === "approve" || busy === "reject";
  const [liveOpen, setLiveOpen] = useState(false);
  const [forcedExpected, setForcedExpected] = useState<string | null>(null);
  const [forcedReasons, setForcedReasons] = useState<string[]>([]);
  // PR-A2: default collapsed so Approve/Reject stay reachable; expand for the full receipt.
  const [expanded, setExpanded] = useState(false);

  const p = pending.proposal;
  const currentMode = snapshot ? deriveReality(snapshot).mode : undefined;
  const resolvedMode = resolveApprovalExecutionMode(pending.executionMode, currentMode);
  const reality = realityForMode(resolvedMode);
  const live = reality.tone === "live";
  const notional = estNotional(pending);
  const expiresAt = snapshot ? expiryIso(pending, snapshot.policy) : null;
  const decisionCase = matchedDecision(snapshot, pending);
  const rewardRisk = rewardRiskFor(pending);
  const redTrigger = redTeamTriggerMeta(p.redTeamVerdict?.trigger);
  const policy = snapshot?.policy;
  // Owner preference: when typed confirmation is off, approving a broker order is one-click like any
  // other — no "APPROVE LIVE <SYMBOL>" phrase. The server honors the same flag (assertLiveApprovalConfirmation).
  const willPromptTyped = willPromptTypedApproval(resolvedMode, policy?.requireTypedConfirmation);
  const openingInExitOnly =
    policy?.systemState === "close_only" && (p.side === "buy" || p.side === "short");
  const dailyUsed = finite(pending.decision.dailyNotionalUsed) ? pending.decision.dailyNotionalUsed : snapshot?.dailyStats.notional;
  const dailyCap = policy ? resolveDailyOpeningCap(policy, snapshot?.portfolio?.totalMarketValue) : undefined;
  const dailyRemaining = dailyCap && finite(dailyUsed) ? Math.max(0, dailyCap.notional - dailyUsed) : undefined;
  const referencePrice = resolveProposedPrice({
    proposalReferencePrice: pending.proposalReferencePrice,
    referencePrice: p.referencePrice,
    limitPrice: p.limitPrice
  });
  const livePrice = finite(pending.proposalCurrentPrice) && pending.proposalCurrentPrice > 0
    ? pending.proposalCurrentPrice
    : undefined;
  const currentDrift = nameMovePct(referencePrice, livePrice);
  const targetPrice = resolveProposalTarget(p);
  const stopPrice = resolveProposalStop(p);
  const delayUsd = delayAdvantageUsd({
    proposed: referencePrice,
    now: livePrice,
    quantity: p.quantity,
    side: p.side
  });

  // Estimated realized P/L for an exit (sell-of-long or cover-of-short): only meaningful when
  // there's a matching held position to close against. Fresh price prefers the proposal's own
  // drift price (pending.proposalCurrentPrice, already fetched for the "Since proposed" line
  // above) and falls back to the position's own mark (marketValue/quantity, same snapshot).
  // Missing position or price => estPnl stays null and the line is omitted — never fabricated.
  // The position's SIGN must agree with the exit side (isClosingOrder): a card can sit for hours
  // while the position underneath flips or closes — a sell card over a now-short position would
  // otherwise show a long-exit "P/L" for an order that actually opens more short exposure.
  const symbolPosition = isExit(p.side)
    ? snapshot?.positions?.find((pos) => normalizeSymbol(pos.symbol) === normalizeSymbol(p.symbol))
    : undefined;
  const matchedPosition = symbolPosition && isClosingOrder({ symbol: p.symbol, side: p.side }, symbolPosition)
    ? symbolPosition
    : undefined;
  // A price that exactly equals the position's average cost is almost certainly the broker
  // adapter's no-quote fallback (Robinhood sets marketValue = quantity * averageCost when it
  // cannot quote, and the server's currentPrices fall back to that mark) — showing it would
  // render a fake $0.00 P/L. Treat it as unavailable; the line is omitted rather than misleading.
  const costSuspicious = (price: number | undefined): boolean =>
    price !== undefined &&
    matchedPosition !== undefined &&
    matchedPosition.averageCost > 0 &&
    Math.abs(price - matchedPosition.averageCost) / matchedPosition.averageCost < 1e-9;
  const exitPriceCandidate = finite(pending.proposalCurrentPrice)
    ? pending.proposalCurrentPrice
    : (positionMarkPrice(matchedPosition) ?? undefined);
  const exitCurrentPrice = costSuspicious(exitPriceCandidate) ? undefined : exitPriceCandidate;
  // Cap the exit quantity to the current position size so stale oversize exit proposals
  // (e.g. the user manually reduced the position after the approval card was created)
  // don't overstate the estimated closing P/L — same guard as closingOrderPnl in orders/lib.ts.
  const exitQty = requestedExitQuantity(p);
  const cappedExitQty = exitQty != null
    ? Math.min(exitQty, Math.abs(matchedPosition?.quantity ?? 0))
    : undefined;
  const estPnl = matchedPosition && cappedExitQty != null
    ? estimatedClosingPnl({ position: matchedPosition, shares: cappedExitQty, currentPrice: exitCurrentPrice })
    : null;

  // Model attribution prefers the PERSISTED per-proposal values (p.proposedByModel /
  // p.redTeamVerdict.model — stamped failover-aware by src/lib/strategy.ts), falling back
  // to the snapshot policy's configured models only for legacy proposals that predate them
  // (the policy-derived value can be stale if the owner swapped models since proposing).
  const greenModelPersisted = p.proposedByModel?.trim() || null;
  // The "__rotate__" sentinel is a rotation marker, never a servable model — a ModelBadge for the
  // literal sentinel would be a lie (and providerForModel would even give it an OpenAI logo).
  const greenPolicyRotates = isModelRotationSentinel(snapshot?.policy.llmModel);
  const greenModelConfigured = greenPolicyRotates ? null : (snapshot?.policy.llmModel?.trim() || null);
  // No-defaults directive: never display a made-up default model as if it served this proposal.
  const greenModel = greenModelPersisted ?? greenModelConfigured ?? "unknown";
  // NO fallback to the green model here (no-defaults directive): Red never silently reuses Green,
  // so displaying Green would misattribute the critique. "unknown" only for legacy verdicts that
  // predate per-proposal model stamping on a policy whose Red model was since cleared (or rotates).
  const redConfigured = isModelRotationSentinel(snapshot?.policy.redTeamLlmModel) ? null : (snapshot?.policy.redTeamLlmModel?.trim() || null);
  const redModel = p.redTeamVerdict?.model?.trim() || redConfigured || "unknown";
  // FAILED review: attribute honestly — never blame a fallback model that provably never ran.
  const redFailure = redTeamFailureMeta(p.redTeamVerdict?.failureKind);
  const redFailureModel =
    p.redTeamVerdict && !p.redTeamVerdict.available ? redTeamFailureModel(p.redTeamVerdict, snapshot?.policy.redTeamLlmModel) : null;
  // Exactly one Red Team section renders — the verdict panel (success OR failure), the legacy
  // "unavailable" callout, or the "no review triggered" note. A total function keeps them mutually
  // exclusive so a failed review can never render as both the panel and the callout (dedup).
  const redCard = redTeamCardState(Boolean(p.redTeamVerdict), pending.decision.adversaryUnavailable === true);
  const humanReviewReasons = proposalHumanReviewReasons(p);
  const greenRationale = proposalGreenRationale(p);
  const redCollapsed = redTeamCollapsedChip(
    redCard,
    p.redTeamVerdict,
    pending.decision.socraticOverride?.applied,
    snapshot?.policy.redTeamLlmModel
  );
  const sizeText =
    typeof p.dollarAmount === "number"
      ? `~${fmtMoney(p.dollarAmount)}`
      : typeof p.quantity === "number"
        ? `${fmtQty(p.quantity)} sh`
        : EM_DASH;

  const finish = (result: ApproveResult) => {
    if (result.status === "filled") {
      toast.push("pos", `${SIDE_LABEL[p.side] ?? p.side} ${p.symbol} filled`, "The broker reports that the order completed.");
    } else if (result.status === "placed") {
      toast.push("pos", `${SIDE_LABEL[p.side] ?? p.side} ${p.symbol} placed`, "The order went to the broker with a durable, idempotent intent record.");
    } else if (result.status === "paper") {
      toast.push("pos", `${SIDE_LABEL[p.side] ?? p.side} ${p.symbol} filled (paper)`, "Recorded on the broker paper account.");
    } else if (result.status === "blocked") {
      toast.push("warn", "Blocked at approval time", (result.reasons ?? []).join(" ") || "The policy gate re-ran and refused it.");
    } else if (result.status === "busy") {
      toast.push(
        "warn",
        "Approval is still busy",
        (result.reasons ?? []).join(" ") ||
          "A strategy run is still in progress after waiting.  Wait for the run to finish (or for its lock to expire, up to ~5 minutes), then Approve again."
      );
    } else {
      toast.push("info", `Result: ${feedStatusLabel(result.status)}`, (result.reasons ?? []).join(" ") || undefined);
    }
  };

  const approve = async () => {
    if (willPromptTyped) {
      setLiveOpen(true);
      return;
    }
    setBusy("approve");
    try {
      const result = await approveProposal(pending.id);
      await refresh();
      finish(result);
    } catch (error) {
      if (error instanceof LiveConfirmationRequiredError) {
        setForcedExpected(error.expectedText);
        setForcedReasons(error.reasons);
        setLiveOpen(true);
      } else {
        toast.push("neg", "Approval failed", error instanceof ConsoleApiError ? error.message : String(error));
      }
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    setBusy("reject");
    try {
      await rejectProposal(pending.id);
      await refresh();
      toast.push("info", `Rejected ${p.symbol}`, "The idea keeps being scored — you'll see how it does after you passed.");
    } catch (error) {
      toast.push("neg", "Rejection failed", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const retryCritic = async () => {
    setBusy("retry");
    try {
      await retryRedTeam(pending.id);
      await refresh();
      toast.push("info", `Red Team retried ${p.symbol}`, "The new verdict is on this card.");
    } catch (error) {
      toast.push("neg", "Red Team retry failed", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const priceStrip = (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[length:var(--con-fs-xs)] sm:grid-cols-4">
      <div>
        <div className="con-card-title mb-0.5">Proposed</div>
        <p className="con-num">{referencePrice != null ? fmtMoney(referencePrice) : EM_DASH}</p>
      </div>
      <div>
        <div className="con-card-title mb-0.5">Now</div>
        <p className="con-num">
          {livePrice != null ? fmtMoney(livePrice) : EM_DASH}
          {currentDrift != null && (
            <>
              {" "}
              <SignedText value={currentDrift}>{fmtPct(currentDrift, 2, true)}</SignedText>
            </>
          )}
        </p>
      </div>
      <div>
        <div className="con-card-title mb-0.5">Target</div>
        <p className="con-num">{targetPrice != null ? fmtMoney(targetPrice) : "none"}</p>
      </div>
      <div>
        <div className="con-card-title mb-0.5">Delay</div>
        <p>
          {delayUsd == null
            ? EM_DASH
            : Math.abs(delayUsd) < 0.005
              ? "unchanged"
              : delayUsd > 0
                ? `better by ${fmtMoney(delayUsd)}`
                : `worse by ${fmtMoney(Math.abs(delayUsd))}`}
        </p>
      </div>
      {stopPrice != null && (
        <div className="col-span-2 sm:col-span-4">
          <span className="text-[color:var(--con-faint)]">Stop {fmtMoney(stopPrice)}</span>
        </div>
      )}
    </div>
  );

  return (
    // No overflow-hidden: it creates a containing block that breaks sticky CTAs (PR-A2).
    <article
      id={proposalElementId(pending.id)}
      aria-label={`${SIDE_LABEL[p.side] ?? p.side.toUpperCase()} ${p.symbol}`}
      className={cx("con-card", live && "border-[color:var(--con-live-border)]", focused && DEEP_LINK_FOCUS_CLASS)}
    >
      {/* Header: verb + company logo + symbol + size + reality word — always visible (PR-A2). */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[color:var(--con-line)] px-4 py-3">
        <span className={cx("inline-flex items-center gap-2 text-[length:var(--con-fs-md)] font-bold", isExit(p.side) ? "text-[color:var(--con-warn)]" : undefined)}>
          {SIDE_LABEL[p.side] ?? p.side.toUpperCase()}
          <SymbolButton symbol={p.symbol} logoSize="sm" className="text-inherit" />
        </span>
        <span className="con-num cursor-default text-[length:var(--con-fs-md)] font-semibold" title="Proposed order size (approximate notional or share count).">
          {sizeText}
        </span>
        {isExit(p.side) && (
          <Chip tone="warn" title="Risk-reducing exits are never trapped by caps or universe rules.">
            <ShieldCheck size={11} /> risk-reducing
          </Chip>
        )}
        <div className="flex-1" />
        <Chip tone={reality.tone} title={reality.clarification}>
          {reality.word} · {reality.phrase}
        </Chip>
        {pendingShowsDelayedFallback(pending) && (
          <Chip tone="warn" title={delayedFallbackStampTitle()}>
            {delayedFallbackStampLabel()}
          </Chip>
        )}
      </header>

      <div className="flex flex-col gap-3 px-4 py-3 text-[length:var(--con-fs-sm)]">
        {/* Collapsed summary (PR-A2): AI-critic chip + 2–3 line thesis. Full receipt below when expanded. */}
        {!expanded && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={redCollapsed.tone} title={redCollapsed.title}>
                <Swords size={11} /> {redCollapsed.label}
              </Chip>
              {typeof p.confidenceScore === "number" && (
                <Chip
                  tone="muted"
                  title="The proposing model's stated conviction in this trade, on a 0–100 scale."
                >
                  conf {p.confidenceScore}/100
                </Chip>
              )}
              <Chip tone="accent" title="The thesis tag this idea is filed under — its long-run hit rate is tracked on the Results screen.">
                {thesisTagLabel(p.tradeThesisTag)}
              </Chip>
              <span className="text-[color:var(--con-faint)]">
                Proposed <Ago iso={pending.createdAt} />
              </span>
            </div>
            {priceStrip}
            {pendingShowsDelayedFallback(pending) && (
              <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]" title={delayedFallbackStampTitle()}>
                {delayedFallbackStampTitle()}
              </p>
            )}
            {p.redTeamVerdict && !p.redTeamVerdict.available && p.redTeamVerdict.failureKind !== "not_configured" && (
              <div className="flex flex-wrap items-center gap-2">
                <Btn variant="outline" size="sm" disabled={busy !== null} onClick={() => void retryCritic()}>
                  {busy === "retry" ? "Retrying Red Team…" : "Retry Red Team"}
                </Btn>
              </div>
            )}
            {openingInExitOnly ? (
              <p className="text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-warn)]">
                {EXIT_ONLY_OWNER_APPROVE_NOTE}
              </p>
            ) : null}
            {greenRationale ? (
              <p className="line-clamp-3 leading-relaxed text-[color:var(--con-muted)]">{greenRationale}</p>
            ) : (
              <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">No thesis text on this proposal.</p>
            )}
            {estPnl && (
              <p
                className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]"
                title="Estimated at approval-card render time.  The server re-prices at the moment you actually approve."
              >
                Est. P/L if filled:{" "}
                <SignedText value={estPnl.pnl}>
                  {fmtSignedMoney(estPnl.pnl)} ({fmtPct(estPnl.pnlPct, 1, true)})
                </SignedText>
              </p>
            )}
          </>
        )}

        <button
          type="button"
          className="ac-expand-toggle inline-flex items-center gap-1.5 self-start text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)] hover:underline"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <>
              <ChevronUp size={14} aria-hidden /> Hide full reasoning
            </>
          ) : (
            <>
              <ChevronDown size={14} aria-hidden /> Show full reasoning
            </>
          )}
        </button>

        {expanded && (
          <>
        {/* Estimated closing P/L: only for exits with a matching held position and a fresh
            price. Omitted entirely (no dashes-on-card noise) when either is missing. */}
        {estPnl && (
          <div
            className="rounded-control border border-[color:var(--con-line)] p-3"
            title="Estimated at approval-card render time: shares this order would close × (current price − average cost), sign-flipped for a short cover.  The server re-prices at the moment you actually approve."
          >
            <div className="con-card-title mb-1 flex items-center gap-1.5">
              <TrendingUp size={12} /> Est. P/L if filled
            </div>
            <p className="text-[color:var(--con-muted)]">
              {fmtQty(estPnl.shares)} sh @ {fmtMoney(estPnl.currentPrice)} vs basis {fmtMoney(estPnl.basisPrice)} —{" "}
              <SignedText value={estPnl.pnl}>
                {fmtSignedMoney(estPnl.pnl)} ({fmtPct(estPnl.pnlPct, 1, true)})
              </SignedText>
            </p>
          </div>
        )}

        {/* Green team: the proposing (bull) model + its conviction, always shown. */}
        <div className="con-team con-team-green">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div
                className="con-card-title mb-1.5"
                title="Green team = the proposer (bull): the model that generated this trade idea and argues for it."
              >
                Proposed by (green team)
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <ModelBadge modelId={greenModel} size="md" title="The model that generated this proposal" />
                {!greenModelPersisted && !greenModelConfigured && (
                  <span
                    className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
                    title={
                      greenPolicyRotates
                        ? "The policy rotates models each run; this legacy proposal predates per-proposal model stamping, so the concrete rotation pick was not recorded."
                        : "This legacy proposal has no served-model stamp and no model is currently configured.  The app has no hidden Green Team default."
                    }
                  >
                    ({greenPolicyRotates ? "policy rotates models" : "model not recorded"})
                  </span>
                )}
              </div>
            </div>
            {typeof p.confidenceScore === "number" && (
              <div
                className="shrink-0 cursor-default text-right"
                title="The proposing model's stated conviction in this trade, on a 0–100 scale.  Higher = stronger conviction; high scores can trigger the red-team debate and influence sizing."
              >
                <span className="con-confidence-num">{p.confidenceScore}</span>
                <span className="con-num text-[length:var(--con-fs-sm)] font-semibold text-[color:var(--con-faint)]">/100</span>
                <div className="con-card-title">confidence</div>
              </div>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Chip tone="accent" title="The thesis tag this idea is filed under — its long-run hit rate is tracked on the Results screen.">
              {thesisTagLabel(p.tradeThesisTag)}
            </Chip>
            <span className="cursor-default text-[color:var(--con-faint)]" title="The market regime the strategist saw when it proposed this trade.">
              Regime at proposal: {p.entryMarketRegime || EM_DASH}
            </span>
            <span className="text-[color:var(--con-faint)]">
              Proposed <Ago iso={pending.createdAt} />
            </span>
            <Chip tone="muted" title={modelProvenance(p, policy)}>
              {p.proposedByModel ? "served model" : "model legacy"}
            </Chip>
            {p.proposedByModel && policy?.llmModel && !isModelRotationSentinel(policy?.llmModel) && normalizeModelId(p.proposedByModel) !== normalizeModelId(policy?.llmModel) && (
              <Chip tone="muted" title={fallbackProvenance(p, policy)}>
                failover
              </Chip>
            )}
          </div>
          <p className="mt-2 leading-relaxed text-[color:var(--con-muted)]">{proposalGreenRationale(p)}</p>
        </div>

        {/* Red team: the single adversarial reviewer + its verdict — including the FAILURE state,
            so a review that could not run is never visually identical to one that never triggered. */}
        {redCard === "verdict-panel" && p.redTeamVerdict && (
          <div className="con-team con-team-red">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <div
                className="con-card-title flex items-center gap-1.5"
                title="Red team = the single adversarial reviewer: a model tasked with fact-checking and attacking the finalized trade before you see it."
              >
                <Swords size={12} /> Devil&apos;s advocate (red team)
              </div>
              {p.redTeamVerdict.available ? (
                <ModelBadge modelId={redModel} title="The adversarial reviewer model that critiqued this proposal" />
              ) : redFailureModel ? (
                <ModelBadge modelId={redFailureModel} title="The adversarial reviewer model that failed to produce a verdict" />
              ) : (
                <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]" title={redFailure.title}>
                  no reviewer model configured
                </span>
              )}
            </div>
            <p className="mt-1.5 leading-relaxed text-[color:var(--con-muted)]">
              {p.redTeamVerdict.reason}
              {!p.redTeamVerdict.available && " No model critiqued this trade — review it as the sole adversary."}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[length:var(--con-fs-xs)]">
              {p.redTeamVerdict.available ? (
                <span className="font-semibold" style={{ color: p.redTeamVerdict.rejected ? "var(--con-neg)" : "var(--con-pos)" }}>
                  Verdict: {redTeamVerdictLabel(p.redTeamVerdict, pending.decision.socraticOverride?.applied)}
                </span>
              ) : (
                <span className="font-semibold" style={{ color: "var(--con-warn)" }} title={redFailure.title}>
                  No verdict: review failed ({redFailure.label})
                </span>
              )}
              {(p.redTeamVerdict.available || p.redTeamVerdict.trigger) && (
                <Chip tone="warn" title={redTrigger.title}>
                  trigger: {redTrigger.label}
                </Chip>
              )}
              {!p.redTeamVerdict.available && p.redTeamVerdict.failureKind !== "not_configured" && (
                <Btn variant="outline" size="sm" disabled={busy !== null} onClick={() => void retryCritic()}>
                  {busy === "retry" ? "Retrying Red Team…" : "Retry Red Team"}
                </Btn>
              )}
            </div>
          </div>
        )}
        {expanded && openingInExitOnly ? (
          <p className="text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-warn)]">
            {EXIT_ONLY_OWNER_APPROVE_NOTE}
          </p>
        ) : null}
        {redCard === "no-review" && (
          <p
            className="cursor-default text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
            title="None of the dissent triggers (confidence, notional, live opening, override request, risk regime) applied, so no adversarial reviewer was asked.  The empty state is information, not an omission."
          >
            No adversarial review ran for this proposal — below every dissent trigger.
          </p>
        )}

        {/* §5.1 / R19 — LEGACY fallback ONLY: a pending card with NO structured red-team verdict but the
            stored `adversaryUnavailable` decision flag set (old proposals persisted before the
            single-adversary consolidation). The structured-verdict failure state — including the
            "sole adversary" framing — is owned by the Red Team panel above; gating this on the ABSENCE
            of `redTeamVerdict` keeps the two mutually exclusive so an unavailable review never renders
            twice (was: this block also fired on `!available`, duplicating the panel above). */}
        {redCard === "legacy-unavailable" && (
          <div
            className="rounded-control border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] p-3"
            title="The adversarial (red team) review was required but could not run, so this trade was routed to you unreviewed — you are the only reviewer it will get."
          >
            <div className="con-card-title flex items-center gap-1.5" style={{ color: "var(--con-warn)" }}>
              <Swords size={12} /> Red Team review unavailable
            </div>
            <p className="mt-1.5 leading-relaxed text-[color:var(--con-muted)]">
              {pending.decision.adversaryUnavailableReason ?? "The adversarial review could not run for this proposal."}
              {" "}No model critiqued this trade — review it as the sole adversary.
            </p>
          </div>
        )}

        {humanReviewReasons.length > 0 && (
          <div className="rounded-control border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] p-3">
            <div className="con-card-title flex items-center gap-1.5" style={{ color: "var(--con-warn)" }}>
              <CircleAlert size={12} /> Why your approval is required
            </div>
            <div className="mt-2 space-y-2">
              {humanReviewReasons.map((reason) => (
                <div key={reason.code}>
                  <div className="font-semibold text-[color:var(--con-fg)]">{reason.title}</div>
                  <p className="mt-0.5 leading-relaxed text-[color:var(--con-muted)]">{reason.summary}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Provenance + sizing receipt */}
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.05fr)_minmax(260px,0.95fr)]">
          <div className="rounded-control border border-[color:var(--con-line)] p-3">
            <div className="con-card-title mb-2 flex items-center gap-1.5" title="Sizing inputs already available on the approval snapshot; missing values stay blank instead of being inferred.">
              <Ruler size={12} /> Sizing provenance
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[length:var(--con-fs-xs)]">
              <dt className="text-[color:var(--con-faint)]">advised size</dt>
              <dd className="con-num text-right text-[color:var(--con-fg)]">{sizeText}</dd>
              <dt className="text-[color:var(--con-faint)]">broker review notional</dt>
              <dd className="con-num text-right text-[color:var(--con-fg)]">{fmtMoney(pending.review?.estimatedNotional ?? notional)}</dd>
              <dt className="text-[color:var(--con-faint)]">per-order cap</dt>
              <dd className="con-num text-right text-[color:var(--con-fg)]">{fmtMoney(policy?.maxOrderNotional)}</dd>
              <dt className="text-[color:var(--con-faint)]">daily cap remaining</dt>
              <dd className="con-num text-right text-[color:var(--con-fg)]">
                {fmtMoney(dailyRemaining)}
                {dailyCap?.mode === "pct_nav" ? ` (${fmtPct(dailyCap.configuredValue, 1)} NAV cap)` : ""}
              </dd>
              <dt className="text-[color:var(--con-faint)]">projected symbol exposure</dt>
              <dd className="con-num text-right text-[color:var(--con-fg)]">{fmtPct(pending.decision.projectedSymbolExposurePct, 1)}</dd>
              <dt className="text-[color:var(--con-faint)]">ADV cap</dt>
              <dd className="con-num text-right text-[color:var(--con-fg)]">{fmtPct(policy?.maxOrderPctOfAdv, 1)}</dd>
              <dt className="text-[color:var(--con-faint)]">sizer band</dt>
              <dd className="con-num text-right text-[color:var(--con-fg)]">
                {finite(policy?.tuning?.sizingFloorPct) || finite(policy?.tuning?.sizingCeilingPct)
                  ? `${fmtPct(policy?.tuning?.sizingFloorPct, 0)}-${fmtPct(policy?.tuning?.sizingCeilingPct, 0)}`
                  : EM_DASH}
              </dd>
              <dt className="text-[color:var(--con-faint)]">entry drift</dt>
              <dd className="con-num text-right text-[color:var(--con-fg)]">
                {finite(currentDrift) ? `${fmtPct(currentDrift, 2, true)} / max ${fmtPct(policy?.maxEntryDriftPct, 1)}` : EM_DASH}
              </dd>
            </dl>
            {pending.review?.alerts?.length ? (
              <ul className="mt-2 list-disc pl-4 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                {pending.review.alerts.slice(0, 3).map((alert, i) => (
                  <li key={i}>{alert}</li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="rounded-control border border-[color:var(--con-line)] p-3">
            <div className="con-card-title mb-2 flex items-center gap-1.5" title="Bracket reward:risk geometry from the persisted entry anchor, stop, and take-profit.">
              <TrendingUp size={12} /> Reward:risk geometry
            </div>
            {rewardRisk ? (
              <>
                <div className="mb-2 flex h-2 overflow-hidden rounded-full bg-[color:var(--con-line)]" aria-hidden>
                  <div className="bg-[color:var(--con-neg)]" style={{ flex: 1 }} />
                  <div className="bg-[color:var(--con-pos)]" style={{ flex: Math.min(4, rewardRisk.ratio) }} />
                </div>
                <div className="grid grid-cols-3 gap-2 text-[length:var(--con-fs-xs)]">
                  <div title="Persisted decision-time entry/reference price.">
                    <div className="text-[color:var(--con-faint)]">Entry</div>
                    <div className="con-num font-semibold">{fmtMoney(rewardRisk.entry)}</div>
                  </div>
                  <div title="Loss side of the bracket.">
                    <div className="text-[color:var(--con-faint)]">Risk</div>
                    <div className="con-num font-semibold text-[color:var(--con-neg)]">{fmtMoney(rewardRisk.risk)}</div>
                  </div>
                  <div title="Profit side of the bracket.">
                    <div className="text-[color:var(--con-faint)]">Reward</div>
                    <div className="con-num font-semibold text-[color:var(--con-pos)]">{fmtMoney(rewardRisk.reward)}</div>
                  </div>
                </div>
                <p className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                  R:R <strong className="con-num text-[color:var(--con-fg)]">{fmtNum(rewardRisk.ratio)}:1</strong> from stop{" "}
                  {fmtMoney(rewardRisk.stop)} to target {fmtMoney(rewardRisk.target)}.
                </p>
              </>
            ) : (
              <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                No complete opening bracket is attached to this proposal, so reward:risk is not computed.
              </p>
            )}
          </div>
        </div>

        <div className="rounded-control border border-[color:var(--con-line)] p-3">
          <div className="con-card-title mb-2 flex items-center gap-1.5" title="Decision-case evidence linked by proposal id.">
            <Database size={12} /> Evidence citations
          </div>
          {decisionCase?.ragAttributions?.length ? (
            <div className="flex flex-col gap-2">
              {decisionCase.ragAttributions.slice(0, 3).map((item, i) => (
                <div key={`${item.chunkId ?? item.title ?? item.source ?? "rag"}-${i}`} className="text-[length:var(--con-fs-xs)]">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip tone="accent" title={item.chunkId ? `Chunk ${item.chunkId}` : undefined}>
                      {evidenceLabel(item)}
                    </Chip>
                    {item.publishedAt && <span className="text-[color:var(--con-faint)]">{item.publishedAt}</span>}
                  </div>
                  <p className="mt-1 leading-relaxed text-[color:var(--con-muted)]">{item.contribution || item.title || item.text.slice(0, 160)}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              No proposal-linked RAG citations are attached to this card yet.  Served model and policy evidence are still persisted above.
            </p>
          )}
        </div>

        {priceStrip}
        {pendingShowsDelayedFallback(pending) && (
          <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]" title={delayedFallbackStampTitle()}>
            {delayedFallbackStampTitle()}
          </p>
        )}

        {/* Since proposed + revalidation */}
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <div className="con-card-title mb-1" title="Raw side-adjusted move since the proposal's reference price, not benchmark-relative.  Positive means the idea has moved in the proposed direction.">
              Since proposed
            </div>
            {typeof pending.performanceSinceProposalPct === "number" ? (
              <p title="Raw proposal return since the decision-time reference price.  It is not adjusted for SPY; benchmark-relative learning is handled separately in Results.">
                <SignedText value={pending.performanceSinceProposalPct}>{fmtPct(pending.performanceSinceProposalPct, 2, true)}</SignedText>{" "}
                <span className="text-[color:var(--con-faint)]">
                  in the proposed direction
                  {referencePrice != null && livePrice != null ? ` (${fmtMoney(referencePrice)} → ${fmtMoney(livePrice)})` : ""}
                </span>
              </p>
            ) : (
              <p className="text-[color:var(--con-faint)]">
                {referencePrice != null ? `Proposed ${fmtMoney(referencePrice)}` : "No proposed price on this card."}
                {livePrice != null ? ` · now ${fmtMoney(livePrice)}` : ""}
              </p>
            )}
          </div>
          <div>
            <div className="con-card-title mb-1">Last re-check</div>
            {pending.revalidationNote ? (
              <p className="text-[color:var(--con-muted)]">
                &ldquo;{pending.revalidationNote}&rdquo;{" "}
                <span className="text-[color:var(--con-faint)]">
                  <Ago iso={pending.lastRevalidatedAt} />
                </span>
              </p>
            ) : (
              <p className="text-[color:var(--con-faint)]">Not re-validated yet — the next run re-checks it.</p>
            )}
          </div>
        </div>

        {/* Gate status */}
        <div>
          <div className="con-card-title mb-1">Policy gate</div>
          {pending.decision.reasons.length > 0 ? (
            <ul className="list-disc pl-4 text-[color:var(--con-muted)]">
              {pending.decision.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : (
            <p className="text-[color:var(--con-muted)]">
              Passed every check when proposed.  The full gate re-runs server-side at the moment you approve — with fresh
              prices, caps, and wash-sale state.
            </p>
          )}
          {pending.decision.washSale?.note && (
            <p
              className="mt-1 font-semibold text-[color:var(--con-warn)]"
              title="This account's Tax rules disregard IRA wash sales (Rev. Rul. 2008-5 would otherwise block this rebuy).  The purchase is annotated and audited; disregarding is an audit-risk acceptance."
            >
              {pending.decision.washSale.note}
            </p>
          )}
        </div>

        {/* Unified decision scorecard (r3): the typed deterministic receipt persisted with the
            proposal — collapsible so the card's default expanded read stays compact. */}
        {p.scorecard && <ProposalScorecardBlock scorecard={p.scorecard} />}

        {/* Repair-ladder receipts: deterministic post-generation corrections/fallbacks, named and
            visible by design — never silent edits (TradeProposal.dataAdjustments). */}
        {Array.isArray(p.dataAdjustments) && p.dataAdjustments.length > 0 && (
          <div>
            <div
              className="con-card-title mb-1"
              title="Deterministic consistency checks run after the model produced this proposal.  Each entry names a correction or fallback the app applied — recorded as a receipt, never a silent edit, and never a block."
            >
              Data adjustments
            </div>
            <ul className="list-disc pl-4 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              {p.dataAdjustments.map((receipt, i) => (
                <li key={i}>{receipt}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Three outcomes */}
        <div className="rounded-control border border-[color:var(--con-line)] p-3 text-[length:var(--con-fs-xs)] leading-relaxed">
          <p>
            <strong>If you approve:</strong> {SIDE_LABEL[p.side]?.toLowerCase() ?? p.side} {sizeText} at {p.type.replace("_", " ")}
            {typeof p.limitPrice === "number" ? ` (limit ${fmtMoney(p.limitPrice)})` : ""}.
            {typeof p.bracketStopLoss === "number" || typeof p.bracketTakeProfit === "number" ? (
              <>
                {" "}
                Bracket protection: {typeof p.bracketStopLoss === "number" ? `stop ${fmtMoney(p.bracketStopLoss)}` : ""}
                {typeof p.bracketStopLoss === "number" && typeof p.bracketTakeProfit === "number" ? " · " : ""}
                {typeof p.bracketTakeProfit === "number" ? `take-profit ${fmtMoney(p.bracketTakeProfit)}` : ""}.
              </>
            ) : null}
            {p.stopPlan && p.stopPlan.style === "default" ? (
              <>
                {" "}
                <strong>Stop plan (reset to default):</strong> this scale-in clears any existing per-position override
                (none/trailing/fixed/ATR) and returns the combined lot to the account's own stop precedence.
              </>
            ) : p.stopPlan && p.stopPlan.style !== "default" ? (
              <>
                {" "}
                <strong>Stop plan ({STOP_PLAN_DISPLAY[p.stopPlan.style] ?? p.stopPlan.style}):</strong>{" "}
                {p.stopPlan.style === "none"
                  ? `the LLM chose to carry NO stop-loss on this position${p.stopPlan.rationale ? ` — "${p.stopPlan.rationale}"` : ""}.`
                  : `this position's stop pins to the ${STOP_PLAN_DISPLAY[p.stopPlan.style] ?? p.stopPlan.style} distance, overriding the account's own default${p.stopPlan.rationale ? ` — "${p.stopPlan.rationale}"` : ""}.`}
              </>
            ) : null}
            {willPromptTyped ? " This uses the broker-account approval phrase before anything is placed." : ""}
          </p>
          <p className="mt-1">
            <strong>If you reject:</strong> nothing is traded. The idea stays on the record and its counterfactual return
            keeps being measured.
          </p>
          <p className="mt-1">
            <strong>If you do nothing:</strong>{" "}
            {expiresAt ? (
              <>
                it expires {timeUntil(expiresAt)} and nothing is traded.
              </>
            ) : (
              "it stays pending until a run withdraws it or you decide."
            )}
          </p>
        </div>
          </>
        )}
      </div>

      {/* Actions — sticky above mobile tab bar (PR-A2); static on desktop. API/confirm unchanged. */}
      <footer className="ac-actions flex items-center justify-end gap-2 border-t border-[color:var(--con-line)] px-4 py-3">
        <Btn variant="ghost" disabled={actionBusy} onClick={() => void reject()} aria-label={`Reject ${p.symbol}`}>
          {busy === "reject" ? "Rejecting…" : "Reject"}
        </Btn>
        {/* Approving a broker-connected order stays visually primary; the typed
            ritual in the sheet is the real friction. Retry Red Team must not grey
            Approve — that hang is why Paper cards looked stuck after yesterday. */}
        <Btn
          variant={live ? "primary" : "pos"}
          disabled={actionBusy}
          onClick={() => void approve()}
          aria-label={
            live
              ? willPromptTyped
                ? `Approve live broker order for ${pending.proposal.side} ${pending.proposal.symbol}`
                : `Approve live order for ${pending.proposal.side} ${pending.proposal.symbol}`
              : `Approve paper order for ${pending.proposal.side} ${pending.proposal.symbol}`
          }
        >
          {busy === "approve" ? (
            "Approving…"
          ) : willPromptTyped ? (
            <>
              Approve live… <LiveTag />
            </>
          ) : live ? (
            <>
              Approve live <LiveTag />
            </>
          ) : (
            "Approve"
          )}
        </Btn>
      </footer>

      {(live || liveOpen) && (
        <LiveApproveSheet
          open={liveOpen}
          onClose={() => {
            setLiveOpen(false);
            setForcedExpected(null);
            setForcedReasons([]);
          }}
          pending={pending}
          notional={notional}
          seedExpected={forcedExpected}
          seedReasons={forcedReasons}
          onDone={finish}
        />
      )}
    </article>
  );
});

/** The typed real-money confirmation. The server contract
 *  (assertLiveApprovalConfirmation) verifies: proposal id, account number,
 *  executionMode "broker/live", the reviewed estimated notional (±$0.01), and
 *  the exact phrase APPROVE LIVE <SYMBOL>. On mismatch the server answers 409
 *  with its reasons and the authoritative expected text — rendered verbatim. */
function LiveApproveSheet({
  open,
  onClose,
  pending,
  notional,
  seedExpected,
  seedReasons,
  onDone
}: {
  open: boolean;
  onClose: () => void;
  pending: PendingProposal;
  notional: number | undefined;
  seedExpected?: string | null;
  seedReasons?: string[];
  onDone: (result: ApproveResult) => void;
}) {
  const { refresh } = useConsoleData();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverReasons, setServerReasons] = useState<string[]>(seedReasons ?? []);
  const [serverExpected, setServerExpected] = useState<string | null>(seedExpected ?? null);

  useEffect(() => {
    if (seedExpected) setServerExpected(seedExpected);
    if (seedReasons && seedReasons.length > 0) setServerReasons(seedReasons);
  }, [seedExpected, seedReasons]);

  const expectedText = useMemo(
    () => serverExpected ?? seedExpected ?? `APPROVE LIVE ${pending.proposal.symbol.toUpperCase()}`,
    [serverExpected, seedExpected, pending.proposal.symbol]
  );
  const matches = typed.trim().toUpperCase() === expectedText;

  const submit = async () => {
    setBusy(true);
    try {
      const result = await approveProposal(pending.id, {
        proposalId: pending.id,
        accountNumber: pending.accountNumber ?? null,
        executionMode: "broker/live",
        estimatedNotional: notional ?? null,
        typedText: typed.trim().toUpperCase()
      });
      await refresh();
      onClose();
      setTyped("");
      setServerReasons([]);
      onDone(result);
    } catch (error) {
      if (error instanceof LiveConfirmationRequiredError) {
        // The server is the authority: show its reasons and its expected text.
        setServerReasons(error.reasons);
        setServerExpected(error.expectedText);
        setTyped("");
      } else {
        toast.push("neg", "Live approval failed", error instanceof ConsoleApiError ? error.message : String(error));
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Broker order approval" tone="live">
      <div className="mb-3 rounded-control border border-[color:var(--con-live-border)] bg-[color:var(--con-surface-2)] p-3 text-[length:var(--con-fs-sm)]">
        <div className="font-bold">Brokerage account</div>
        <p className="con-num mt-1">
          {SIDE_LABEL[pending.proposal.side] ?? pending.proposal.side.toUpperCase()}{" "}
          <SymbolButton symbol={pending.proposal.symbol} className="text-inherit" /> — estimated{" "}
          <strong>{fmtMoney(notional)}</strong>
          {pending.accountNumber ? ` from account ·· ${pending.accountNumber.slice(-4)}` : ""}
        </p>
        <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          The server re-checks everything at this moment — fresh price, entry drift, caps, wash-sale locks. If anything no
          longer passes, nothing is placed and you&apos;ll see the reasons here.
        </p>
      </div>

      {serverReasons.length > 0 && (
        <div className="mb-3 rounded-control border border-[color:var(--con-warn-border)] p-3 text-[length:var(--con-fs-xs)]">
          <div className="font-semibold text-[color:var(--con-warn)]">The server refused the confirmation:</div>
          <ul className="mt-1 list-disc pl-4 text-[color:var(--con-muted)]">
            {serverReasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      <label className="con-label" htmlFor={`live-typed-${pending.id}`}>
        Type exactly: <span className="con-mono text-[color:var(--con-fg)]">{expectedText}</span>
      </label>
      <TextInput
        id={`live-typed-${pending.id}`}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="characters"
        spellCheck={false}
        onPaste={(e) => e.preventDefault()}
        placeholder={expectedText}
        className="con-mono"
      />
      <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">Paste is disabled on purpose — the words are the consent.</p>

      <div className="mt-4 flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Btn>
        <Btn variant="primary" disabled={!matches || busy} onClick={() => void submit()}>
          {busy ? "Placing…" : (
            <>
              Place broker order <LiveTag />
            </>
          )}
        </Btn>
      </div>
    </Sheet>
  );
}
