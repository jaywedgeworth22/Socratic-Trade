import { NOTIFICATION_EVENT_TYPES } from "./types";
import type { NotificationSettings, RiskRules, ScoringWeights, TaxSettings, TradingPolicy } from "./types";
import { DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT, DEFAULT_MARKET_SCAN_OUTLIER_RESERVE } from "./scan-settings";

export const DEFAULT_TAX_SETTINGS: TaxSettings = {
  washSaleGuard: true,
  // Owner decision (2026-07-03): the wash-sale gate is advisory, not a hard block, by default.
  // "auto" always proceeds — an earlier deterministic edge-vs-tax-cost veto was removed because it
  // re-arithmetized the LLM's own outputs (confidenceScore, bracketTakeProfit) rather than adding
  // independent judgment. The priced tax cost still rides the decision as receipt telemetry and is
  // threaded into the strategist prompt so the model weighs it against conviction itself. "block"
  // and "ask" remain valid, stricter opt-ins (see policy.ts) for anyone who wants the old hard-stop
  // or a priced approval prompt.
  washSaleHandling: "auto",
  // IRA-replacement rebuys (Rev. Rul. 2008-5) default to "disregard" for the same reason: brokers
  // do not report cross-account IRA wash sales to the IRS, so the permanent-loss-forfeiture rule
  // only bites under audit — the owner treats that as their call, not a hard system stop. Every
  // disregarded purchase is still annotated + audited ("Wash Sale (Technically, but IRA purchase
  // unreported to IRS)"); "block" remains available as a stricter per-account opt-in.
  iraWashSaleHandling: "disregard",
  shortTermRatePct: 24,
  longTermRatePct: 15
};

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  liquidity: 1.4,
  momentum: 1.2,
  value: 0.8,
  quality: 0.8,
  volatility: 0.8,
  sentiment: 0.6,
  positioning: 0.8,
  diversification: 1
};

export const DEFAULT_RISK_RULES: RiskRules = {
  stopLossPct: 8,
  takeProfitPct: 20,
  // Take partial profit at the target and let the rest ride (laddered per take-profit band).
  takeProfitTrimPct: 50,
  trailingStopPct: 0,
  // Mandatory for any short (see policy.ts's short-selling gate) — mirrors the long stopLossPct
  // default so a short-enabled policy isn't rejected out of the box for lacking a stop.
  shortStopLossPct: 8,
  // Account-level drawdown breaker (owner-approved guard enablement 2026-07-28,
  // docs/guard-enablement-proposal-2026-07-28.md row 8): a 15% trailing drawdown from the equity
  // high-water mark breaches the breaker. ADVISORY only — `drawdownBreakerAction` stays unset
  // (advisory), so a breach writes a receipt, notifies once per day, and injects the drawdown
  // into the strategist's prompt as decision context; the agent decides whether to de-risk.
  maxDrawdownPct: 15
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  webhookUrl: "",
  enabledEvents: [...NOTIFICATION_EVENT_TYPES]
};

export const DEFAULT_POLICY: TradingPolicy = {
  systemState: "halted",
  includedIndices: ["sp500"],
  additionalSymbols: [],
  blocklist: [],
  // Penny/illiquid exclusion for the SCANNED universe (explicit symbols + held positions always exempt).
  // No-op for the default S&P-500 universe (every member clears it); it bites only when the universe is
  // broadened to other indexes / the wider screener. Tunable in settings.
  universeFloor: { minPrice: 5, minMarketCapUsd: 100_000_000, minDollarVolume: 1_000_000 },
  strategyAuthority: "propose",
  // Typed confirmation for high-impact live actions is ON by default; the owner can switch it off in
  // Settings → Advanced action confirmation (an adjustable preference, not a hard gate).
  requireTypedConfirmation: true,
  socraticOverrideMode: "execute",
  socraticOverrideMaxPctOfNav: 100,
  sellToFundBuy: "off",
  // NO llmModel / redTeamLlmModel here (owner directive 2026-07-07: no model default for anything,
  // ever). A seeded default here would resurrect the exact silent-default the model layer removed —
  // every new policy would "choose" gpt-5.4-mini without the user ever picking it. Both team models
  // are REQUIRED explicit picks in Strategy → Models; unset fails closed with an actionable
  // message (LLM_MODEL_REQUIRED_STRATEGY_MESSAGE / the Red reviewer's not_configured routing).
  // The PROPOSER's reasoning effort (per-team split 2026-07-10). NO redTeamReasoningEffort default
  // on purpose: absent means "inherit the proposer's" (resolveReviewerReasoningEffort) — seeding a
  // value here would silently break that fallback for every policy.
  llmReasoningEffort: "medium",
  // Daily LLM learning review — default OFF (nothing runs until enabled). When enabled the
  // default mode is "decide" (apply verdicts — remove/expire facts, resolve pending items,
  // each audited; owner-chosen 2026-07-09); "annotate" (audit + notify only, no mutation) is
  // the opt-out. The reviewer model defaults to a real, explicit "claude-fable-latest" value —
  // never a blank that silently means Fable (owner: no hidden model defaults; require a chosen
  // model). User-level (see USER_LEVEL_POLICY_FIELDS): one config for the whole login.
  learningReviewEnabled: false,
  learningReviewMode: "decide",
  learningReviewModel: "claude-fable-latest",
  // Trigger: run when >= 5 new lessons pile up, OR the oldest un-reviewed one is >= 7 days old.
  learningReviewMinNewLessons: 5,
  learningReviewMaxWaitDays: 7,
  // Outcome grading stays on raw side-adjusted returns by default (byte-identical behavior).
  // "alpha" is the opt-in benchmark-relative companion grade — see TradingPolicy.outcomeGradingMode.
  outcomeGradingMode: "raw",
  // spyExcessPct grades against the market (^GSPC/SPY) by default; "sector" is the opt-in
  // per-symbol GICS sector index/ETF grade — see TradingPolicy.benchmarkMode.
  benchmarkMode: "market",
  holdingHorizon: "swing",
  maxOrderPctOfNav: 5,
  // Account-relative by default: four full-sized 5%-of-NAV openings can fit in one day. A user can
  // switch this to a fixed dollar ceiling in Guardrails when that better matches the mandate.
  maxDailyPctOfNav: 20,
  maxSymbolExposurePct: 25,
  maxGrossExposurePct: 80,  // keep ≥20% cash buffer by default; users can raise in policy settings
  maxNetExposurePct: 80,    // consistent with gross; net > gross is impossible for long-only anyway
  maxEntryDriftPct: 10,     // reject a stale opening market/dollar order whose price drifted >10% from the proposed entry
  maxOrderPctOfAdv: 5,      // cap an opening order at 5% of the name's recent daily $-volume (market-impact guard; rarely binds for small accounts/liquid names)
  volPanicBrakeEnabled: true, // flip active→close_only on a rare VIX/VVIX/SKEW tail extreme (defaults below)
  volPanicVixThreshold: 40,
  volPanicVvixThreshold: 150,
  volPanicSkewThreshold: 160,
  brokerBracketsEnabled: true, // attach broker-held stop/take brackets on native-bracket brokers (Alpaca)
  robinhoodBrokerStops: false, // opt-in: true broker-held resting stop on live Robinhood (verify RH MCP stop semantics first)
  // Broker-held trailing stops (inert until riskRules.trailingStopPct > 0): native Alpaca
  // trailing_stop orders; on live Robinhood a tick-ratcheted stop-market, additionally gated on the
  // robinhoodBrokerStops opt-in above. The synthetic monitor stays the always-on fallback.
  brokerTrailingStops: true,
  // Broker-held buy-stops for shorts (Alpaca). Default ON so enabling short
  // selling also arms the designed protection lane. Owner can turn off.
  brokerStopsForShorts: true,
  // Options + Kalshi event contracts:
  optionsTradingEnabled: true,
  eventContractsEnabled: true,
  // Note: Live/Paper flags are removed as UI does not differentiate them for options.
  // Per-symbol stop intelligence ON by default (owner decision 2026-07-07 — no more one-size-fits-all
  // stops). ATR stops scale the protective stop DISTANCE to each name's realized volatility
  // (atrStopMultiple × ATR as a % of entry); beta-scaling widens the stop for high-beta names and
  // tightens it for low-beta. ATR takes precedence over beta for the stop distance when both apply;
  // each falls back to the flat riskRules.stopLossPct when its per-symbol input is unavailable. Both
  // are owner-tunable off-switches in Settings — preferences, not cages.
  atrStops: true,
  betaScaledStops: true,
  maxDailyOrders: 10,
  maxProposalsPerRun: 3,
  // Quote staleness gate (owner-approved 2026-07-28; owner 2026-08-18 delayed Yahoo):
  // age live tape against 120s.  Delayed Yahoo fallback ages the FETCH snapshot, stamps
  // user-facing "Delayed Quote" on the approval card, and KEEP TRADING — never fail-closed.
  // Exits are never gated.  A still-stale fetch converts the opening to a limit; it is
  // not blocked and does not skip Green/Red.
  maxQuoteAgeSec: 120,
  // Owner-approved guard enablement 2026-07-28 (proposal rows 2-4): risk receipts (inform-only
  // correlation + stress notes on every opening), vol-target sizing taper at a generous 25%
  // portfolio-vol target, and a 10%-of-equity portfolio heat budget taper. All are tapers/receipts —
  // none can block an opening or touch an exit. mergePolicy deep-merges these so stored policies
  // inherit them while any explicit per-account tuning key still wins.
  tuning: {
    riskReceipts: true,
    volTargeting: true,
    targetPortfolioVolPct: 25,
    portfolioHeatBudgetPct: 10
  },
  marketScanCandidateLimit: DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT,
  marketScanOutlierReserve: DEFAULT_MARKET_SCAN_OUTLIER_RESERVE,
  proposalExpiryMinutes: 2880,
  proposalRevalidateCadenceHours: 0,
  staleLimitOrderMinutes: 15,
  autoRemediateStaleExits: true, // cancel-replace a stale EXIT limit with a market order so a stop can't strand the position (MU deadlock); owner-tunable, defers to human typed-confirm on live
  brokerMinimumHandling: "bump", // sub-minimum orders are raised TO the broker floor and placed (owner ruling 2026-07-09: bump, not skip); "skip" restores pre-flight blocking
  permittedOrderTypes: ["market", "limit"],
  permitExtendedHours: false,
  runCadenceMinutes: 60,
  runDuringExtendedHours: false,
  scoringWeights: DEFAULT_SCORING_WEIGHTS,
  sectorCaps: {},
  riskRules: DEFAULT_RISK_RULES,
  notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
  taxSettings: DEFAULT_TAX_SETTINGS,
  // FMP direct product use is retired (owner 2026-08-04): defaults OFF so Settings and new
  // policies do not advertise FMP modules as active. ST consumes FMP-class latency via
  // Congress.Trade; these toggles are legacy / no-op for the cascade.
  fmpRealTimeDataEnabled: false,
  fmpMacroDataEnabled: false,
  kalshiMacroEnabled: true,
  fmpEventsDataEnabled: false,
  fmpFundamentalsDataEnabled: false
  // No default broker: a fresh policy is broker-neutral. activeBroker is set when a real broker is
  // connected (see db-profiles.ts). With no connected account the app cannot place orders — there is
  // no local-sim fallback.
};

export const DEFAULT_STRATEGY_PROMPT = `OBJECTIVE
Maximize risk-adjusted total return on this equity account. Compound gains by rotating capital toward the strongest opportunities in the allowed universe each session.

SELECTION LOGIC
Use the market scan's topCandidates as your primary opportunity set — they are pre-ranked by a composite score of volume, momentum, and portfolio underweight. Apply judgment on top of that ranking:

  1. Prioritize candidates with strong intraday momentum (intradayChangePct > 0) AND above-average volume. High volume confirms conviction behind a move.
  2. Among equally ranked candidates, prefer sectors not already represented in the portfolio. Concentration in one sector amplifies risk without improving expected return.
  3. Avoid stocks showing a sharp single-day spike (>8%) with no prior momentum — these often revert. Prefer steady climbers over one-day wonders.
  4. Give meaningful weight to names already held that are continuing to trend — adding to a winner within position limits is higher conviction than buying something new.

SELL AND TRIM RULES
  - Trim any position that has grown above maxSymbolExposurePct. Rebalancing into other opportunities is better than letting a single name dominate.
  - Sell a held position if it is down more than 8% intraday with no sector-wide explanation. Cut losers early; the opportunity cost of staying in a falling stock is real.
  - If a held stock ranks near the bottom of the current scan while another candidate ranks highly, propose a rotation: sell the laggard, fund the leader.

SIZING AND LIMITS
  - Choose a fresh advised size for every proposal from the trade's risk/reward, conviction, liquidity, diversification, and account context. maxOrderNotional is a hard safety cap, not the default target.
  - Respect remainingDailyOrders — if it is low, concentrate on the single best trade rather than spreading across several mediocre ones.
  - Use market orders for stocks with marketCap >= $5B. Use limit orders for stocks with marketCap < $5B or where marketCap is unknown.
  - If a candidate includes an ask price, a buy limit may be priced near or slightly below ask. If no ask price is provided, do not invent one; use market orders for liquid names or current price-based limits for smaller names.
  - Dollar-amount orders must use regular_hours.

OUTPUT
Return a JSON proposals array. Each entry requires: symbol, side, type, dollarAmount or quantity, timeInForce (gfd), marketHours, and a rationale. The rationale must be specific — name the signal (e.g. "ranked #2 in scan, +2.1% on 3× average volume, no sector overlap" or "position exceeded 26% allocation, trimming to fund higher-ranked scan candidates"). Vague rationales like "looks good" are not acceptable.`;
