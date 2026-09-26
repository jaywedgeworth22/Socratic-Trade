import { DEFAULT_POLICY, DEFAULT_TAX_SETTINGS } from "@/lib/defaults";
import {
  getActiveConnectedAccount,
  getConnectedAccount,
  getDb,
  getPolicy,
  resolveLlmCredential,
  setPolicy,
  setStrategyPrompt
} from "@/lib/db";
import { llmModelFamily, modelCredentialService } from "@/lib/llm-provider";
import { isModelRotationSentinel } from "@/lib/llm-request";
import { isIndexUniverse, normalizeIncludedIndices } from "@/lib/index-universes";
import { getBrokerGateway } from "@/lib/broker";
import { stripNullsDeep } from "@/lib/policy-null-stripping";
import { normalizeExclusivePolicyCaps } from "@/lib/policy-normalization";
import { resolveRequestUserId } from "@/lib/request-user";
import {
  invalidSymbolMessage,
  newlyAddedInvalidSymbols,
  normalizePolicySymbolList,
  sanitizePolicySymbolList,
  validateNewCustomPolicySymbols
} from "@/lib/policy-symbol-validation";
import {
  MAX_MARKET_SCAN_CANDIDATE_LIMIT,
  MAX_MARKET_SCAN_OUTLIER_RESERVE,
  MIN_MARKET_SCAN_CANDIDATE_LIMIT,
  MIN_MARKET_SCAN_OUTLIER_RESERVE,
  normalizeMarketScanCandidateLimit,
  normalizeMarketScanOutlierReserve
} from "@/lib/scan-settings";
import { ALL_LLM_REASONING_EFFORTS, isDisallowedInteractiveStrategyReasoningConfig, resolveReviewerReasoningEffort } from "@/lib/llm-request";
import { validateWebhookUrl } from "@/lib/egress-guard";
import { NOTIFICATION_EVENT_TYPES } from "@/lib/types";
import type { IndexUniverse, NotificationEventType, TradingPolicy } from "@/lib/types";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return NextResponse.json(getPolicy(resolveRequestUserId(request)));
}

export async function PUT(request: Request) {
  const rawBody: unknown = await request.json();
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return new NextResponse("Policy update body must be a JSON object.", { status: 400 });
  }
  const body = rawBody as Record<string, unknown>;
  const userId = resolveRequestUserId(request, body);
  const requestedTarget = body.targetConnectedAccountId;
  if (requestedTarget !== undefined && (typeof requestedTarget !== "string" || requestedTarget.trim().length === 0)) {
    return new NextResponse("targetConnectedAccountId must be a non-empty string.", { status: 400 });
  }
  const explicitTarget = typeof requestedTarget === "string" ? requestedTarget.trim() : undefined;
  if (explicitTarget && !getConnectedAccount(explicitTarget, userId)) {
    return new NextResponse("The target connected account was not found.", { status: 404 });
  }
  // Snapshot the implicit target once at request entry. Without this, a concurrent account switch
  // between getPolicy() and setPolicy() can merge Account A's patch and persist it into Account B.
  const targetConnectedAccountId = explicitTarget ?? getActiveConnectedAccount(userId)?.id;
  const current = getPolicy(userId, targetConnectedAccountId);
  const additionalSymbols = normalizePolicySymbolList(body.additionalSymbols, current.additionalSymbols ?? []);
  const blocklist = normalizePolicySymbolList(body.blocklist, current.blocklist ?? []);
  const invalidNewSymbols = newlyAddedInvalidSymbols([...additionalSymbols, ...blocklist], [
    ...(current.additionalSymbols ?? []),
    ...(current.blocklist ?? [])
  ]);
  if (invalidNewSymbols.length > 0) {
    return new NextResponse(invalidSymbolMessage(invalidNewSymbols), { status: 400 });
  }
  const customSymbolError = await validateNewCustomPolicySymbols(additionalSymbols, current.additionalSymbols ?? []);
  if (customSymbolError) return new NextResponse(customSymbolError, { status: 400 });
  const bodyNotificationSettings =
    typeof body.notificationSettings === "object" && body.notificationSettings
      ? (body.notificationSettings as Record<string, unknown>)
      : undefined;
  const policy: TradingPolicy = {
    ...DEFAULT_POLICY,
    ...current,
    ...Object.fromEntries(
      Object.entries(body).filter(
        ([key]) =>
          ![
            "strategyPrompt",
            "userId",
            "targetConnectedAccountId",
            // Derived from the owned connected-account row on every read; never client-writable.
            "connectedAccountId",
            "activeBroker",
            "accountNumber"
          ].includes(key)
      )
    ),
    includedIndices: Array.isArray(body.includedIndices)
      ? normalizeIncludedIndices(Array.from(new Set(body.includedIndices.map(String).filter(isIndexUniverse))) as IndexUniverse[])
      : current.includedIndices,
    additionalSymbols: sanitizePolicySymbolList(additionalSymbols),
    blocklist: sanitizePolicySymbolList(blocklist),
    scoringWeights: {
      ...DEFAULT_POLICY.scoringWeights,
      ...current.scoringWeights,
      ...(typeof body.scoringWeights === "object" && body.scoringWeights ? body.scoringWeights : {})
    },
    sectorCaps: normalizeSectorCaps(typeof body.sectorCaps === "object" && body.sectorCaps ? body.sectorCaps : current.sectorCaps),
    riskRules: {
      ...DEFAULT_POLICY.riskRules,
      ...current.riskRules,
      ...(typeof body.riskRules === "object" && body.riskRules ? body.riskRules : {})
    },
    notificationSettings: {
      ...DEFAULT_POLICY.notificationSettings,
      ...current.notificationSettings,
      ...(bodyNotificationSettings ?? {}),
      enabledEvents:
        Array.isArray(bodyNotificationSettings?.enabledEvents)
          ? bodyNotificationSettings.enabledEvents.filter(isNotificationEvent)
          : current.notificationSettings.enabledEvents
    },
    taxSettings: {
      ...DEFAULT_TAX_SETTINGS,
      ...current.taxSettings,
      ...(typeof body.taxSettings === "object" && body.taxSettings ? body.taxSettings : {})
    },
    tuning: {
      ...current.tuning,
      ...(typeof body.tuning === "object" && body.tuning ? body.tuning : {})
    },
    // Materialize triggerSettings only when something actually sets it — an ABSENT key must stay
    // absent so "follow the global env" stays distinguishable from an explicit (empty) object.
    // Cleared sub-keys arrive as null and are removed by stripNullsDeep below, which is how an
    // account returns to the global default.
    ...(body.triggerSettings !== undefined || current.triggerSettings !== undefined
      ? {
          triggerSettings: {
            ...current.triggerSettings,
            ...(typeof body.triggerSettings === "object" && body.triggerSettings ? body.triggerSettings : {})
          }
        }
      : {})
  };
  // Owner directive 2026-07-07: an empty/cleared model is NOT silently deleted or substituted — a
  // blank model id is rejected by validatePolicy so the user must pick one explicitly. This covers
  // the learning-review model too (#1278): a blank used to be quietly deleted here ("cleared →
  // feature no-ops"), but mergePolicy now refills the explicit claude-fable-5 default, which would
  // turn a clear into a silent revert-to-default. Rejecting mirrors the Green/Red model rules; the
  // runner's "no-model" skip remains only as a backstop for corrupt stored data that bypassed this
  // route.
  // The client serializes a CLEARED optional field as `null` (JSON.stringify drops `undefined`, which the
  // `...current` merge above would otherwise silently restore). Strip those nulls back to absent so blanking
  // a field actually turns the guard off / reverts it to its default.
  // EXCEPTION — learningReviewModel: a cleared model must be REJECTED, not stripped. validatePolicy
  // rejects a blank STRING below, but a `null` would be deleted by stripNullsDeep before that check
  // runs, and setPolicy would then merge DEFAULT_POLICY.learningReviewModel (claude-fable-5) back —
  // the exact silent clear->default this route exists to prevent (owner: require a model be chosen;
  // no hidden model default). Reject the null clear explicitly, mirroring the blank-string path.
  if (body.learningReviewModel === null) {
    return new NextResponse("learningReviewModel must be a non-empty model id.", { status: 400 });
  }
  stripNullsDeep(policy as unknown as Record<string, unknown>);
  const capFields = ["maxOrderNotional", "maxOrderPctOfNav", "maxDailyNotional", "maxDailyPctOfNav"] as const;
  const capPreference = capFields.some((key) => Object.prototype.hasOwnProperty.call(body, key))
    ? body as Partial<TradingPolicy>
    : current;
  normalizeExclusivePolicyCaps(policy, capPreference);
  // Only enforce the interactive gpt-5.5/high-reasoning rejection when THIS request actually
  // changes the model/effort combination. validatePolicy runs against the MERGED policy, so a
  // stored gpt-5.5+high config used to fail EVERY unrelated save (notification prefs, short
  // selling, ...) with a confusing model error. Stale stored configs are already safe at run
  // time — interactiveStrategyReasoningEffort clamps them to medium — so unrelated writes may
  // pass through; only a write that sets the disallowed combo is rejected.
  const reasoningConfigChanged =
    policy.llmModel !== current.llmModel ||
    policy.redTeamLlmModel !== current.redTeamLlmModel ||
    policy.llmReasoningEffort !== current.llmReasoningEffort ||
    policy.redTeamReasoningEffort !== current.redTeamReasoningEffort;
  // Account verification is required when autonomy/account readiness changes, but a
  // transient broker read must not strand an unrelated guardrail save. Robinhood's
  // account-list MCP call can be briefly unavailable while its portfolio/order paths
  // are otherwise usable; the next run still performs its own live account checks.
  const accountReadinessChanged =
    policy.systemState !== current.systemState ||
    policy.accountNumber !== current.accountNumber ||
    policy.activeBroker !== current.activeBroker;
  const validationError = await validatePolicy(policy, userId, {
    enforceInteractiveReasoningRule: reasoningConfigChanged,
    // Keyed-provider backstop gating mirrors the reasoning rule: validatePolicy runs against the
    // MERGED policy, so enforcing it on every save would 400 EVERY unrelated write (notification
    // prefs, caps, ...) for a user whose STORED model's provider key was since removed. A stored
    // unkeyed model is already safe at run time (proposeTrades throws / the Red review fails
    // closed); only a write that actually sets/changes that model must prove its provider is keyed.
    enforceKeyedGreenModelRule: policy.llmModel !== current.llmModel,
    enforceKeyedRedModelRule: policy.redTeamLlmModel !== current.redTeamLlmModel,
    // Same MERGED-policy scoping as the rules above: bound tuning.marketableLimitBufferBps only when
    // THIS request actually sets/changes it — otherwise a stored out-of-range value would 400 EVERY
    // unrelated save. A stale stored value is already safe at run time (validatedMarketableLimitBufferBps
    // defaults/clamps it); only a write that changes the field must pass the bound.
    enforceMarketableLimitBufferRule: policy.tuning?.marketableLimitBufferBps !== current.tuning?.marketableLimitBufferBps,
    // Same MERGED-policy scoping as above: only re-run the (network) egress check when THIS
    // request actually sets/changes webhookUrl — a DNS blip on an already-saved, working
    // webhook must not block every unrelated policy save (notification prefs, caps, ...).
    enforceWebhookUrlRule: policy.notificationSettings.webhookUrl !== current.notificationSettings.webhookUrl,
    verifySelectedAccount: accountReadinessChanged
  });
  if (validationError) return new NextResponse(validationError, { status: 400 });
  // Validation above is intentionally side-effect free. Apply the policy and optional prompt in one
  // SQLite transaction so a rejected companion field can never leave the prompt partially changed.
  let targetDisappeared = false;
  getDb().transaction(() => {
    // Account deletion is a separate request and can complete while custom-symbol validation awaits.
    // Re-check inside the write transaction; setPolicy intentionally falls back to user-level storage
    // when an account id does not resolve, which would be the wrong failure mode for a deleted target.
    if (targetConnectedAccountId && !getConnectedAccount(targetConnectedAccountId, userId)) {
      targetDisappeared = true;
      return;
    }
    setPolicy(policy, userId, targetConnectedAccountId);
    if (typeof body.strategyPrompt === "string") {
      setStrategyPrompt(body.strategyPrompt, userId, targetConnectedAccountId);
    }
  })();
  if (targetDisappeared) {
    return new NextResponse("The target connected account changed before this update could be saved.", { status: 409 });
  }
  return NextResponse.json(getPolicy(userId, targetConnectedAccountId));
}

async function validatePolicy(
  policy: TradingPolicy,
  userId: string,
  options: {
    enforceInteractiveReasoningRule?: boolean;
    enforceKeyedGreenModelRule?: boolean;
    enforceKeyedRedModelRule?: boolean;
    enforceMarketableLimitBufferRule?: boolean;
    enforceWebhookUrlRule?: boolean;
    verifySelectedAccount?: boolean;
  } = {}
): Promise<string | undefined> {
  // Invalid legacy watchlist / ignore-list symbols are sanitized out in the PUT handler above, so stale
  // bad data cannot block unrelated policy updates. Newly added custom Additional Watchlist symbols are
  // quote-checked before save so the user gets an explicit reason when a ticker cannot be tracked.

  if (!["propose", "decide"].includes(policy.strategyAuthority)) return "strategyAuthority must be propose or decide.";
  if (policy.socraticOverrideMode !== undefined && !["off", "propose", "execute"].includes(policy.socraticOverrideMode)) return "socraticOverrideMode must be off, propose, or execute.";
  if (policy.socraticOverrideMaxPctOfNav !== undefined && (!Number.isFinite(policy.socraticOverrideMaxPctOfNav) || policy.socraticOverrideMaxPctOfNav <= 0 || policy.socraticOverrideMaxPctOfNav > 100)) return "socraticOverrideMaxPctOfNav must be between 0 and 100.";
  if (policy.sellToFundBuy !== undefined && !["off", "suggest", "propose", "automated"].includes(policy.sellToFundBuy)) return "sellToFundBuy must be off, suggest, propose, or automated.";
  if (policy.outcomeGradingMode !== undefined && !["raw", "alpha"].includes(policy.outcomeGradingMode)) return "outcomeGradingMode must be raw or alpha.";
  if (policy.benchmarkMode !== undefined && !["market", "sector"].includes(policy.benchmarkMode)) return "benchmarkMode must be market or sector.";
  // NOTE: any non-empty id ≤64 chars is deliberately valid here — this includes custom provider
  // model ids AND the "__rotate__" rotation sentinel (LLM_MODEL_ROTATION_SENTINEL in
  // src/lib/llm-request.ts; resolved to a concrete model at run start by src/lib/model-rotation.ts).
  // Do not add a catalog whitelist.
  if (policy.llmModel !== undefined && (typeof policy.llmModel !== "string" || policy.llmModel.trim().length === 0 || policy.llmModel.length > 64)) return "llmModel must be a non-empty model id.";
  if (policy.redTeamLlmModel !== undefined && (typeof policy.redTeamLlmModel !== "string" || policy.redTeamLlmModel.trim().length === 0 || policy.redTeamLlmModel.length > 64)) return "redTeamLlmModel must be a non-empty model id.";
  if (policy.learningReviewEnabled !== undefined && typeof policy.learningReviewEnabled !== "boolean") return "learningReviewEnabled must be a boolean.";
  if (policy.learningReviewMode !== undefined && !["annotate", "decide"].includes(policy.learningReviewMode)) return "learningReviewMode must be annotate or decide.";
  if (policy.brokerMinimumHandling !== undefined && !["bump", "skip"].includes(policy.brokerMinimumHandling)) return "brokerMinimumHandling must be bump or skip.";
  if (policy.learningReviewModel !== undefined && (typeof policy.learningReviewModel !== "string" || policy.learningReviewModel.trim().length === 0 || policy.learningReviewModel.length > 64)) return "learningReviewModel must be a non-empty model id.";
  if (policy.learningReviewReasoningEffort !== undefined && !ALL_LLM_REASONING_EFFORTS.includes(policy.learningReviewReasoningEffort)) {
    return "learningReviewReasoningEffort must be none, minimal, low, medium, high, xhigh, or max.";
  }
  if (policy.learningReviewMinNewLessons !== undefined && (!Number.isInteger(policy.learningReviewMinNewLessons) || policy.learningReviewMinNewLessons < 1 || policy.learningReviewMinNewLessons > 1000)) return "learningReviewMinNewLessons must be an integer between 1 and 1000.";
  if (policy.learningReviewMaxWaitDays !== undefined && (!Number.isInteger(policy.learningReviewMaxWaitDays) || policy.learningReviewMaxWaitDays < 1 || policy.learningReviewMaxWaitDays > 365)) return "learningReviewMaxWaitDays must be an integer between 1 and 365.";
  // Owner directive 2026-07-07: a chosen model must belong to a provider the user holds a key for
  // (no defaults; only keyed providers are usable). Same-model-for-both is allowed — independence is
  // the user's choice, not enforced. The Settings UI disables non-keyed options; this is the
  // server-side backstop. (Mandatory "both models set" is enforced in the Settings UI and at strategy
  // runtime via fail-closed on an unconfigured model.)
  // The "__rotate__" rotation sentinel is EXEMPT from the keyed-provider check: it is not a concrete
  // model with a single provider to key-check — rotation resolves it, per run, to a pick drawn ONLY
  // from credential-resolvable models (src/lib/model-rotation.ts), so the keyed guarantee is upheld
  // at serve time, not save time.
  if ((options.enforceKeyedGreenModelRule ?? true) && typeof policy.llmModel === "string" && policy.llmModel.trim() && !isModelRotationSentinel(policy.llmModel)) {
    // Match the user's actual OpenRouter-first/native-fallback execution path.
    const provider = modelCredentialService(policy.llmModel, userId);
    if (!resolveLlmCredential(provider, userId).key) {
      return provider === "openrouter"
        ? `Add an OpenRouter API key before selecting ${policy.llmModel.trim()} as your strategist (green team) model — all models are served through OpenRouter.`
        : `Add an API key for ${provider} before selecting ${policy.llmModel.trim()} as your strategist (green team) model.`;
    }
  }
  if ((options.enforceKeyedRedModelRule ?? true) && typeof policy.redTeamLlmModel === "string" && policy.redTeamLlmModel.trim() && !isModelRotationSentinel(policy.redTeamLlmModel)) {
    const provider = modelCredentialService(policy.redTeamLlmModel, userId);
    if (!resolveLlmCredential(provider, userId).key) {
      return provider === "openrouter"
        ? `Add an OpenRouter API key before selecting ${policy.redTeamLlmModel.trim()} as your reviewer (red team) model — all models are served through OpenRouter.`
        : `Add an API key for ${provider} before selecting ${policy.redTeamLlmModel.trim()} as your reviewer (red team) model.`;
    }
  }
  if (policy.llmReasoningEffort !== undefined && !ALL_LLM_REASONING_EFFORTS.includes(policy.llmReasoningEffort)) {
    return "llmReasoningEffort must be none, minimal, low, medium, high, xhigh, or max.";
  }
  if (policy.redTeamReasoningEffort !== undefined && !ALL_LLM_REASONING_EFFORTS.includes(policy.redTeamReasoningEffort)) {
    return "redTeamReasoningEffort must be none, minimal, low, medium, high, xhigh, or max.";
  }
  // Per-team reasoning (2026-07-10): each team's (model, effort) combo is checked with ITS OWN
  // effort — the proposer's legacy `llmReasoningEffort`, and the reviewer's `redTeamReasoningEffort`
  // falling back to the proposer's until explicitly set (resolveReviewerReasoningEffort). A
  // violating combo on EITHER team rejects, and the message names which team so the owner knows
  // which control to change.
  if (options.enforceInteractiveReasoningRule ?? true) {
    if (isDisallowedInteractiveStrategyReasoningConfig(policy.llmModel, policy.llmReasoningEffort)) {
      return "Green Team: gpt-5.5 with high reasoning is disabled for interactive strategy runs. Use medium/low reasoning or choose a faster model.";
    }
    if (isDisallowedInteractiveStrategyReasoningConfig(policy.redTeamLlmModel, resolveReviewerReasoningEffort(policy))) {
      return "Red Team: gpt-5.5 with high reasoning is disabled for interactive strategy runs. Use medium/low reasoning or choose a faster model.";
    }
  }
  if (policy.holdingHorizon && !["intraday", "swing", "position", "longterm"].includes(policy.holdingHorizon)) return "holdingHorizon must be intraday, swing, position, or longterm.";
  if (policy.maxOrderNotional !== undefined && policy.maxOrderNotional <= 0) return "maxOrderNotional must be positive.";
  if (policy.maxOrderPctOfNav !== undefined && (policy.maxOrderPctOfNav <= 0 || policy.maxOrderPctOfNav > 100)) return "maxOrderPctOfNav must be between 0 and 100.";
  if (policy.maxDailyNotional !== undefined && policy.maxDailyNotional <= 0) return "maxDailyNotional must be positive.";
  if (policy.maxDailyPctOfNav !== undefined && (policy.maxDailyPctOfNav <= 0 || policy.maxDailyPctOfNav > 100)) return "maxDailyPctOfNav must be between 0 and 100.";
  if (policy.maxDailyNotional !== undefined && policy.maxOrderNotional !== undefined && policy.maxDailyNotional < policy.maxOrderNotional) return "maxDailyNotional must be at least maxOrderNotional.";
  if (policy.maxDailyPctOfNav !== undefined && policy.maxOrderPctOfNav !== undefined && policy.maxDailyPctOfNav < policy.maxOrderPctOfNav) return "maxDailyPctOfNav must be at least maxOrderPctOfNav.";
  if (policy.maxSymbolExposurePct !== undefined && (policy.maxSymbolExposurePct <= 0 || policy.maxSymbolExposurePct > 100)) return "maxSymbolExposurePct must be between 0 and 100.";
  if (policy.maxPortfolioBeta !== undefined && (!Number.isFinite(policy.maxPortfolioBeta) || policy.maxPortfolioBeta <= 0 || policy.maxPortfolioBeta > 10)) return "maxPortfolioBeta must be a positive number (≤ 10).";
  if (policy.maxAvgCorrelation !== undefined && (!Number.isFinite(policy.maxAvgCorrelation) || policy.maxAvgCorrelation <= 0 || policy.maxAvgCorrelation > 1)) return "maxAvgCorrelation must be between 0 (off) and 1.";
  if (policy.maxEntryDriftPct !== undefined && (!Number.isFinite(policy.maxEntryDriftPct) || policy.maxEntryDriftPct < 0 || policy.maxEntryDriftPct > 100)) return "maxEntryDriftPct must be between 0 (off) and 100.";
  if (policy.secondaryBuyPullbackPct !== undefined && (!Number.isFinite(policy.secondaryBuyPullbackPct) || policy.secondaryBuyPullbackPct < 0 || policy.secondaryBuyPullbackPct > 100)) return "secondaryBuyPullbackPct must be between 0 (off) and 100.";
  if (policy.tuning?.llmDailyTokenBudget !== undefined && (!Number.isFinite(policy.tuning.llmDailyTokenBudget) || policy.tuning.llmDailyTokenBudget < 0)) return "tuning.llmDailyTokenBudget must be a non-negative number (0 = no limit).";
  if (policy.tuning?.llmDailyCostBudgetUsd !== undefined && (!Number.isFinite(policy.tuning.llmDailyCostBudgetUsd) || policy.tuning.llmDailyCostBudgetUsd < 0)) return "tuning.llmDailyCostBudgetUsd must be a non-negative number (0 = no limit).";
  if (policy.atrStops !== undefined && typeof policy.atrStops !== "boolean") return "atrStops must be a boolean.";
  if (policy.brokerTrailingStops !== undefined && typeof policy.brokerTrailingStops !== "boolean") return "brokerTrailingStops must be a boolean.";
  if (policy.brokerStopsForShorts !== undefined && typeof policy.brokerStopsForShorts !== "boolean") return "brokerStopsForShorts must be a boolean.";
  if (policy.exitsReleaseAppStops !== undefined && typeof policy.exitsReleaseAppStops !== "boolean") return "exitsReleaseAppStops must be a boolean.";
  if (policy.optionsTradingEnabled !== undefined && typeof policy.optionsTradingEnabled !== "boolean") return "optionsTradingEnabled must be a boolean.";
  if (policy.eventContractsEnabled !== undefined && typeof policy.eventContractsEnabled !== "boolean") return "eventContractsEnabled must be a boolean.";
  if (policy.kalshiMacroEnabled !== undefined && typeof policy.kalshiMacroEnabled !== "boolean") return "kalshiMacroEnabled must be a boolean.";
  if (policy.riskRules.atrStopPeriod !== undefined && (!Number.isInteger(policy.riskRules.atrStopPeriod) || policy.riskRules.atrStopPeriod < 5 || policy.riskRules.atrStopPeriod > 100)) return "riskRules.atrStopPeriod must be an integer between 5 and 100.";
  if (policy.riskRules.atrStopMultiple !== undefined && (!Number.isFinite(policy.riskRules.atrStopMultiple) || policy.riskRules.atrStopMultiple <= 0 || policy.riskRules.atrStopMultiple > 10)) return "riskRules.atrStopMultiple must be between 0 (exclusive) and 10.";
  if (policy.maxGrossExposurePct !== undefined && (!Number.isFinite(policy.maxGrossExposurePct) || policy.maxGrossExposurePct <= 0 || policy.maxGrossExposurePct > 100)) return "maxGrossExposurePct must be between 0 and 100.";
  if (policy.maxNetExposurePct !== undefined && (!Number.isFinite(policy.maxNetExposurePct) || policy.maxNetExposurePct <= 0 || policy.maxNetExposurePct > 100)) return "maxNetExposurePct must be between 0 and 100.";
  if (policy.maxShortExposurePct !== undefined && (!Number.isFinite(policy.maxShortExposurePct) || policy.maxShortExposurePct <= 0 || policy.maxShortExposurePct > 100)) return "maxShortExposurePct must be between 0 and 100.";
  if (policy.maxShortOrderNotional !== undefined && (!Number.isFinite(policy.maxShortOrderNotional) || policy.maxShortOrderNotional <= 0)) return "maxShortOrderNotional must be positive.";
  if (policy.maxOrderPctOfAdv !== undefined && (!Number.isFinite(policy.maxOrderPctOfAdv) || policy.maxOrderPctOfAdv <= 0 || policy.maxOrderPctOfAdv > 100)) return "maxOrderPctOfAdv must be between 0 and 100.";
  if (policy.maxQuoteAgeSec !== undefined && (!Number.isFinite(policy.maxQuoteAgeSec) || policy.maxQuoteAgeSec < 0)) return "maxQuoteAgeSec must be a non-negative number of seconds (0 or blank disables).";
  if (policy.maxFundamentalsAgeSec !== undefined && (!Number.isFinite(policy.maxFundamentalsAgeSec) || policy.maxFundamentalsAgeSec < 0)) return "maxFundamentalsAgeSec must be a non-negative number of seconds (0 or blank disables).";
  if (policy.volPanicVixThreshold !== undefined && (!Number.isFinite(policy.volPanicVixThreshold) || policy.volPanicVixThreshold < 0)) return "volPanicVixThreshold must be a non-negative number.";
  if (policy.volPanicVvixThreshold !== undefined && (!Number.isFinite(policy.volPanicVvixThreshold) || policy.volPanicVvixThreshold < 0)) return "volPanicVvixThreshold must be a non-negative number.";
  if (policy.volPanicSkewThreshold !== undefined && (!Number.isFinite(policy.volPanicSkewThreshold) || policy.volPanicSkewThreshold < 0)) return "volPanicSkewThreshold must be a non-negative number.";
  if (policy.permittedOrderTypes !== undefined) {
    const validTypes = ["market", "limit", "stop_market", "stop_limit"];
    if (!Array.isArray(policy.permittedOrderTypes) || policy.permittedOrderTypes.some((t) => !validTypes.includes(String(t)))) {
      return "permittedOrderTypes must be a subset of market, limit, stop_market, stop_limit.";
    }
  }
  if (policy.universeFloor !== undefined) {
    for (const key of ["minPrice", "minMarketCapUsd", "minDollarVolume"] as const) {
      const v = policy.universeFloor[key];
      if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) return `universeFloor.${key} must be a non-negative number.`;
    }
  }
  if (policy.riskRules.takeProfitTrimPct !== undefined && (!Number.isFinite(policy.riskRules.takeProfitTrimPct) || policy.riskRules.takeProfitTrimPct <= 0 || policy.riskRules.takeProfitTrimPct > 100)) return "riskRules.takeProfitTrimPct must be between 0 (exclusive) and 100.";
  if (policy.riskRules.maxDrawdownPct !== undefined && policy.riskRules.maxDrawdownPct > 100) return "riskRules.maxDrawdownPct must be between 0 and 100.";
  if (policy.riskRules.trailingStopPct !== undefined && policy.riskRules.trailingStopPct > 100) return "riskRules.trailingStopPct must be between 0 and 100.";
  if (policy.maxDailyOrders <= 0) return "maxDailyOrders must be positive.";
  if (policy.marketScanCandidateLimit !== undefined) {
    if (normalizeMarketScanCandidateLimit(policy.marketScanCandidateLimit) !== policy.marketScanCandidateLimit) {
      return `marketScanCandidateLimit must be an integer between ${MIN_MARKET_SCAN_CANDIDATE_LIMIT} and ${MAX_MARKET_SCAN_CANDIDATE_LIMIT}.`;
    }
  }
  if (policy.marketScanOutlierReserve !== undefined) {
    const candidateLimit = normalizeMarketScanCandidateLimit(policy.marketScanCandidateLimit);
    if (
      normalizeMarketScanOutlierReserve(policy.marketScanOutlierReserve, candidateLimit) !== policy.marketScanOutlierReserve ||
      policy.marketScanOutlierReserve > candidateLimit
    ) {
      return `marketScanOutlierReserve must be an integer between ${MIN_MARKET_SCAN_OUTLIER_RESERVE} and ${Math.min(MAX_MARKET_SCAN_OUTLIER_RESERVE, candidateLimit)}.`;
    }
  }
  if (policy.runCadenceMinutes < 1) return "runCadenceMinutes must be at least 1 minute.";
  if (policy.proposalExpiryMinutes !== undefined && (!Number.isFinite(policy.proposalExpiryMinutes) || policy.proposalExpiryMinutes < 0)) return "proposalExpiryMinutes must be 0 (off) or a positive number of minutes.";
  if (policy.proposalRevalidateCadenceHours !== undefined && (!Number.isFinite(policy.proposalRevalidateCadenceHours) || policy.proposalRevalidateCadenceHours < 0)) return "proposalRevalidateCadenceHours must be 0 (off) or a positive number of hours.";
  if (policy.staleLimitOrderMinutes !== undefined && (!Number.isFinite(policy.staleLimitOrderMinutes) || policy.staleLimitOrderMinutes < 0)) return "staleLimitOrderMinutes must be 0 (off) or a positive number of minutes.";
  if (Object.values(policy.scoringWeights).some((value) => !Number.isFinite(Number(value)) || Number(value) < 0)) return "scoring weights must be non-negative numbers.";
  if (Object.values(policy.sectorCaps).some((value) => !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100)) return "sector caps must be between 0 and 100.";
  if (policy.riskRules.drawdownBreakerAction !== undefined && !["advisory", "close_only", "halt"].includes(policy.riskRules.drawdownBreakerAction)) return "riskRules.drawdownBreakerAction must be advisory, close_only, or halt.";
  if (policy.riskRules.accuracyBreakerAction !== undefined && !["advisory", "close_only"].includes(policy.riskRules.accuracyBreakerAction)) return "riskRules.accuracyBreakerAction must be advisory or close_only.";
  // drawdownBreakerAction/accuracyBreakerAction are string enums (validated above), so exclude them from the numeric sweep — an
  // enum value like "close_only" is NaN under Number(...) and would otherwise reject the whole save (and
  // then every subsequent save, since it is merged from `...current.riskRules`).
  if (Object.entries(policy.riskRules).some(([key, value]) => key !== "drawdownBreakerAction" && key !== "accuracyBreakerAction" && value !== undefined && (!Number.isFinite(Number(value)) || Number(value) < 0))) return "risk rules must be non-negative numbers.";
  if (policy.taxSettings) {
    const { shortTermRatePct, longTermRatePct, washSaleMinLossUsd, washSaleHandling, iraWashSaleHandling } = policy.taxSettings;
    if (!Number.isFinite(shortTermRatePct) || shortTermRatePct < 0 || shortTermRatePct > 100) return "shortTermRatePct must be between 0 and 100.";
    if (!Number.isFinite(longTermRatePct) || longTermRatePct < 0 || longTermRatePct > 100) return "longTermRatePct must be between 0 and 100.";
    if (washSaleMinLossUsd !== undefined && (!Number.isFinite(washSaleMinLossUsd) || washSaleMinLossUsd < 0)) return "taxSettings.washSaleMinLossUsd must be a non-negative dollar amount (blank = every loss; optional).";
    if (washSaleHandling !== undefined && !["block", "ask", "auto"].includes(washSaleHandling)) return "taxSettings.washSaleHandling must be block, ask, or auto.";
    if (iraWashSaleHandling !== undefined && !["block", "auto", "disregard"].includes(iraWashSaleHandling)) return "taxSettings.iraWashSaleHandling must be block, auto, or disregard.";
  }
  if (policy.llmFallbackModels !== undefined && (!Array.isArray(policy.llmFallbackModels) || policy.llmFallbackModels.some((m) => typeof m !== "string"))) {
    return "llmFallbackModels must be an array of model-id strings.";
  }
  if (policy.redTeamFallbackModels !== undefined && (!Array.isArray(policy.redTeamFallbackModels) || policy.redTeamFallbackModels.some((m) => typeof m !== "string"))) {
    return "redTeamFallbackModels must be an array of model-id strings.";
  }
  if (policy.tuning) {
    // tuning.redTeamConvictionThreshold was removed 2026-07-07 (single-adversary consolidation O2:
    // the Red Team reviews EVERY risk-adding opening — no conviction gate). Stale values in stored
    // tuning JSON are ignored by the runtime; nothing to validate for it here.
    const { shrinkPrior, minClosedLotsForWeightShift, sizingFloorPct, sizingCeilingPct, crisisMaxOpeningExposurePct, bearVetoFcfYieldFloorPct, bearVetoDebtToEquityCeiling, skipNegativeExpectancy, skipNegativeExpectancyEdgePct, gateOnRationaleCollapse, marketableLimitBufferBps, volTargeting, riskReceipts, targetPortfolioVolPct, portfolioHeatBudgetPct } = policy.tuning;
    if (shrinkPrior !== undefined && (!Number.isFinite(shrinkPrior) || shrinkPrior < 0 || shrinkPrior > 100)) return "tuning.shrinkPrior must be between 0 and 100.";
    // Zero/negative would INVERT the marketable exit/entry price (a SELL limit above the quote rests
    // unfilled); >500 bps (5% through the quote) is a typo/units mistake. The exit path also clamps
    // already-stored values (validatedMarketableLimitBufferBps); this keeps new saves honest at the
    // source. Enforced only when the REQUEST sets/changes the field (see the PUT handler) so a stale
    // stored value never blocks unrelated policy saves.
    if ((options.enforceMarketableLimitBufferRule ?? true) && marketableLimitBufferBps !== undefined && (!Number.isFinite(marketableLimitBufferBps) || marketableLimitBufferBps <= 0 || marketableLimitBufferBps > 500)) return "tuning.marketableLimitBufferBps must be greater than 0 and at most 500 (bps).";
    if (minClosedLotsForWeightShift !== undefined && (!Number.isFinite(minClosedLotsForWeightShift) || minClosedLotsForWeightShift < 1 || minClosedLotsForWeightShift > 1000)) return "tuning.minClosedLotsForWeightShift must be between 1 and 1000.";
    if (sizingFloorPct !== undefined && (!Number.isFinite(sizingFloorPct) || sizingFloorPct < 0 || sizingFloorPct > 100)) return "tuning.sizingFloorPct must be between 0 and 100.";
    if (sizingCeilingPct !== undefined && (!Number.isFinite(sizingCeilingPct) || sizingCeilingPct < 1 || sizingCeilingPct > 100)) return "tuning.sizingCeilingPct must be between 1 and 100.";
    if (sizingFloorPct !== undefined && sizingCeilingPct !== undefined && sizingFloorPct > sizingCeilingPct) return "tuning.sizingFloorPct must not exceed sizingCeilingPct.";
    if (crisisMaxOpeningExposurePct !== undefined && (!Number.isFinite(crisisMaxOpeningExposurePct) || crisisMaxOpeningExposurePct < 0 || crisisMaxOpeningExposurePct > 100)) return "tuning.crisisMaxOpeningExposurePct must be between 0 and 100.";
    if (bearVetoFcfYieldFloorPct !== undefined && (!Number.isFinite(bearVetoFcfYieldFloorPct) || bearVetoFcfYieldFloorPct < -100 || bearVetoFcfYieldFloorPct > 100)) return "tuning.bearVetoFcfYieldFloorPct must be between -100 and 100.";
    if (bearVetoDebtToEquityCeiling !== undefined && (!Number.isFinite(bearVetoDebtToEquityCeiling) || bearVetoDebtToEquityCeiling < 0)) return "tuning.bearVetoDebtToEquityCeiling must be a non-negative number.";
    if (skipNegativeExpectancy !== undefined && typeof skipNegativeExpectancy !== "boolean") return "tuning.skipNegativeExpectancy must be a boolean.";
    if (gateOnRationaleCollapse !== undefined && typeof gateOnRationaleCollapse !== "boolean") return "tuning.gateOnRationaleCollapse must be a boolean.";
    if (skipNegativeExpectancyEdgePct !== undefined && (!Number.isFinite(skipNegativeExpectancyEdgePct) || skipNegativeExpectancyEdgePct < -100 || skipNegativeExpectancyEdgePct > 100)) return "tuning.skipNegativeExpectancyEdgePct must be between -100 and 100.";
    // Vol-targeting / heat-budget sizing tapers + risk receipts (guardrails UI fields, 2026-07-28).
    if (volTargeting !== undefined && typeof volTargeting !== "boolean") return "tuning.volTargeting must be a boolean.";
    if (riskReceipts !== undefined && typeof riskReceipts !== "boolean") return "tuning.riskReceipts must be a boolean.";
    if (targetPortfolioVolPct !== undefined && (!Number.isFinite(targetPortfolioVolPct) || targetPortfolioVolPct < 0 || targetPortfolioVolPct > 100)) return "tuning.targetPortfolioVolPct must be between 0 (off) and 100.";
    if (portfolioHeatBudgetPct !== undefined && (!Number.isFinite(portfolioHeatBudgetPct) || portfolioHeatBudgetPct < 0 || portfolioHeatBudgetPct > 100)) return "tuning.portfolioHeatBudgetPct must be between 0 (off) and 100.";
  }
  // Per-account event-trigger settings (2026-07-28): every sub-key optional; unset = global env.
  if (policy.triggerSettings !== undefined) {
    if (typeof policy.triggerSettings !== "object" || policy.triggerSettings === null || Array.isArray(policy.triggerSettings)) return "triggerSettings must be an object.";
    const { enabled, mode, fallbackIntervalMinutes, eventRunMode } = policy.triggerSettings;
    if (enabled !== undefined && typeof enabled !== "boolean") return "triggerSettings.enabled must be a boolean.";
    if (mode !== undefined && !["interval", "event", "both"].includes(mode)) return "triggerSettings.mode must be interval, event, or both.";
    if (fallbackIntervalMinutes !== undefined && (!Number.isFinite(fallbackIntervalMinutes) || fallbackIntervalMinutes < 1)) return "triggerSettings.fallbackIntervalMinutes must be at least 1 minute (blank = no cadence fallback).";
    if (eventRunMode !== undefined && !["full", "close_only"].includes(eventRunMode)) return "triggerSettings.eventRunMode must be full or close_only.";
  }
  if (policy.notificationSettings.webhookUrl?.trim() && (options.enforceWebhookUrlRule ?? true)) {
    // Full SSRF egress check (protocol + DNS + private/loopback/link-local/metadata address
    // rejection) — see src/lib/egress-guard.ts. Re-run again immediately before every send in
    // src/lib/notifications.ts, so this save-time check is a fast-fail UX nicety, not the sole
    // line of defense.
    const check = await validateWebhookUrl(policy.notificationSettings.webhookUrl.trim());
    if (!check.ok) return check.error ?? "webhookUrl is not allowed.";
  }
  if (policy.systemState === "active" && !policy.accountNumber) return "Select an account before enabling autonomy.";
  if (policy.systemState === "active" && policy.includedIndices.length === 0 && policy.additionalSymbols.length === 0) return "Select at least one base index or additional watchlist symbol before enabling autonomy.";
  if ((options.verifySelectedAccount ?? true) && policy.systemState === "active" && policy.accountNumber) {
    // Don't let a transient broker/network failure here surface as an unhandled 500 (which renders as a
    // raw error page) — return a clean, actionable message instead.
    try {
      const accounts = await getBrokerGateway(policy, userId).getAccounts();
      const account = accounts.find((item) => item.accountNumber === policy.accountNumber);
      if (!account) return "Selected account is not available.";
      if (!account.agenticAllowed) return "Selected account is not agentic_allowed.";
    } catch {
      return "Could not verify the selected account right now. Please try again in a moment.";
    }
  }
}

function normalizeSectorCaps(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, raw]) => [key.trim(), Number(raw)] as const)
      .filter(([key, cap]) => key.length > 0 && Number.isFinite(cap))
  );
}

function isNotificationEvent(value: unknown): value is NotificationEventType {
  return NOTIFICATION_EVENT_TYPES.includes(value as NotificationEventType);
}
