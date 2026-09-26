/** Guardrails field metadata (labels + honest one-liners + loosening
 *  direction). Pure data, split out of the page component so the
 *  LOOSER/TIGHTER classification over these defs is unit-testable.
 *
 *  looserWhen semantics (drives the typed-CONFIRM friction on LIVE):
 *  - "up"/"down": which numeric direction loosens the cage.
 *  - "on": ENABLING the toggle loosens (e.g. short selling, extended hours).
 *  - "off": DISABLING the toggle loosens — used for protective switches
 *    (panic brake, broker-held brackets), where turning protection off is
 *    the risk-increasing move. */

import { ADVISORY_NOTE } from "@/lib/guardrail-copy";
import { SUPPORTED_INDEX_UNIVERSES, indexUniverseLabel } from "@/lib/index-universes";
import type { IndexUniverse, OrderType } from "@/lib/types";
import type { FieldDef } from "../lib/policy-diff";

/** Consistent one-sentence framing for the consequential protection/authority rows below —
 *  the same guardrails philosophy the two circuit breakers already spelled out in their own
 *  words (Daily loss stop, Max drawdown stop), applied uniformly so equally-consequential
 *  settings never read as "safer" or "scarier" than one another based on which one happened
 *  to get a longer hint. Decision: session lead, UI-audit sweep. */
export const ESSENTIALS: FieldDef[] = [
  { path: "maxOrderNotional", label: "Max per order", kind: "money", optional: true, looserWhen: "up", hint: "Hard dollar cap on any single order.  The effective cap never exceeds current buying power/NAV.  Blank = no per-order dollar cap (the % of portfolio cap below still applies)." },
  { path: "maxOrderPctOfNav", label: "Max per order (% of portfolio)", kind: "pct", optional: true, looserWhen: "up" },
  { path: "maxDailyNotional", label: "Max spend per day", kind: "money", optional: true, looserWhen: "up", hint: "Opening orders only — protective exits never consume this cap.  The effective cap never exceeds current buying power/NAV." },
  { path: "maxDailyPctOfNav", label: "Max spend per day (% of portfolio)", kind: "pct", optional: true, looserWhen: "up", hint: "Opening orders only.  This account-relative mode rises and falls with current portfolio value." },
  { path: "maxDailyOrders", label: "Max opening orders per day", kind: "int", looserWhen: "up" },
  { path: "riskRules.maxDailyLossNotional", label: "Daily loss stop", kind: "money", optional: true, looserWhen: "up", hint: `Advisory circuit breaker: if the account loses this much in a day, it logs a receipt and tells the agent — which decides how to react (default: advisory, no auto-halt).  Hard enforcement (auto-close positions or a full trading halt on breach) is a separate account-level setting.  Blank = off.  ${ADVISORY_NOTE}` },
  { path: "riskRules.maxDrawdownPct", label: "Max drawdown stop", kind: "pct", optional: true, looserWhen: "up", hint: `Advisory circuit breaker on the fall from the account's high-water mark.  On breach it logs a receipt and surfaces the drawdown to the agent, which decides (default: advisory, no auto-halt).  ${ADVISORY_NOTE}` },
  { path: "riskRules.accuracyBreakerConsecutiveLosses", label: "Consecutive-loss breaker", kind: "int", optional: true, looserWhen: "up", hint: `Accuracy breaker — the drawdown stops bound the bleed; this one notices the account being WRONG.  Fires after this many consecutive matured trades all closed at a loss, which can happen long before a drawdown shows it.  Default response is advisory (receipt + one notification per degradation; the agent decides).  Hard close-only enforcement is a separate account-level setting.  Blank = off.  ${ADVISORY_NOTE}` },
  { path: "riskRules.accuracyBreakerWindow", label: "Hit-rate window", kind: "int", optional: true, looserWhen: "up", hint: `Optional second accuracy trigger: the rolling window of matured decisive outcomes (won/lost/flat on real trades) the hit-rate floor below is measured over.  Only evaluates once a full window exists — never fires on a tiny sample.  Blank = off.` },
  { path: "riskRules.accuracyBreakerMinHitRatePct", label: "Min hit rate", kind: "pct", optional: true, looserWhen: "down", hint: `Fires the accuracy breaker when the win rate over the hit-rate window drops below this floor.  Needs the window above set.  Blank = off.` },
  { path: "riskRules.accuracyBreakerRecoveryWins", label: "Breaker recovery streak", kind: "int", optional: true, looserWhen: "down", hint: `Once degraded, the accuracy-breaker marker clears after this many most-recent outcomes show no loss (default 2).  Recovery clears the marker and notifies — it never flips a close-only account back on its own; you re-arm.` },
  { path: "riskRules.symbolCooldownMinutes", label: "Per-symbol cooldown", kind: "int", optional: true, looserWhen: "up", hint: `Minutes after a close before the same symbol can be re-entered.  Blank = off.  ${ADVISORY_NOTE}` },
  { path: "riskRules.symbolLosingStreakLimit", label: "Per-symbol losing streak", kind: "int", optional: true, looserWhen: "up", hint: `Writes a symbol lock after this many consecutive losing closes on that name.  Blank = off.  ${ADVISORY_NOTE}` },
  {
    path: "riskRules.symbolLockAction",
    label: "Symbol-lock response",
    kind: "select",
    optional: true,
    options: [
      { value: "advisory", label: "Advisory — default" },
      { value: "close_only", label: "Block new entries (overridable)" }
    ],
    looseRank: { advisory: 1, close_only: 0 },
    hint: `What a per-symbol lock does.  Advisory (default) is a receipt the agent can override.  Block still honors autonomyOverride — never a hard cage.`
  },
  { path: "runCadenceMinutes", label: "Run every", kind: "minutes" },
  { path: "runDuringExtendedHours", label: "Run during extended hours", kind: "bool", looserWhen: "on", hint: "Allows the system to run scheduled or event-triggered strategy scans during extended hours (pre-market 4:00 AM – 9:30 AM ET and after-hours 4:00 PM – 8:00 PM ET)." },
  { path: "permitExtendedHours", label: "Allow extended-hours orders", kind: "bool", looserWhen: "on", hint: "Permits the agent to place orders configured to fill outside regular market hours (pre-market 4:00 AM – 9:30 AM ET, after-hours 4:00 PM – 8:00 PM ET)." }
];

export const SOCRATIC_OVERRIDE: FieldDef[] = [
  {
    path: "socraticOverrideMode",
    label: "Socratic override",
    kind: "select",
    options: [
      { value: "off", label: "Off" },
      { value: "propose", label: "Propose only" },
      { value: "execute", label: "Execute in Decide mode" }
    ],
    looseRank: { off: 0, propose: 1, execute: 2 },
    hint:
      `Lets Socratic Trade challenge owner-preference gates with a structured thesis.  Broker, account, tax-hard, and integrity refusals still block.  ${ADVISORY_NOTE}`
  },
  {
    path: "socraticOverrideMaxPctOfNav",
    label: "Override cap (% of portfolio)",
    kind: "pct",
    optional: true,
    looserWhen: "up",
    hint: "Maximum notional for a single Socratic override. 100% allows an all-available-cash thesis when buying power permits."
  }
];

export const EXPOSURE: FieldDef[] = [
  { path: "maxSymbolExposurePct", label: "Max in one stock (%)", kind: "pct", optional: true, looserWhen: "up" },
  { path: "maxSymbolExposureNotional", label: "Max in one stock ($)", kind: "money", optional: true, looserWhen: "up" },
  { path: "maxGrossExposurePct", label: "Max gross exposure (%)", kind: "pct", optional: true, looserWhen: "up", hint: "Total market exposure — every position's size added up (longs + shorts) as a % of portfolio.  Caps how much of the book is deployed vs held in cash.  Risk-reducing exits always pass." },
  { path: "maxNetExposurePct", label: "Max net exposure (%)", kind: "pct", optional: true, looserWhen: "up", hint: "Directional exposure — longs minus shorts as a % of portfolio.  Bounds net market risk; equals gross for a long-only book.  Risk-reducing exits always pass." },
  { path: "maxPortfolioBeta", label: "Max portfolio beta", kind: "int", optional: true, looserWhen: "up", hint: "Risk-reducing trades always pass." },
  { path: "maxAvgCorrelation", label: "Max avg correlation (0–1)", kind: "int", optional: true, looserWhen: "up", hint: "Skips opening a name too correlated with current holdings.  Never blocks exits." },
  { path: "maxOrderPctOfAdv", label: "Max order vs daily volume (%)", kind: "pct", optional: true, looserWhen: "up", hint: "Market-impact cap: an opening order may not exceed this share of the name's recent daily dollar volume." }
];

export const ENTRY_QUALITY: FieldDef[] = [
  { path: "maxEntryDriftPct", label: "Max entry drift (%)", kind: "pct", optional: true, looserWhen: "up", hint: "Rejects a stale opening order whose price moved this far from where the idea was priced." },
  { path: "secondaryBuyPullbackPct", label: "Secondary entry pullback (%)", kind: "pct", optional: true, hint: "Scorecard display only: overrides the built-in ATR-derived secondary entry with this exact % beyond the entry anchor.  Blank keeps the automatic ATR-based distance (never traded from either)." },
  { path: "maxQuoteAgeSec", label: "Max quote age", kind: "seconds", optional: true, looserWhen: "up", hint: "Opening orders blocked on stale quotes.  Blank = gate off.  Missing timestamps count as stale when on." },
  { path: "maxFundamentalsAgeSec", label: "Max fundamentals age", kind: "seconds", optional: true, looserWhen: "up" },
  { path: "marketableLimitEntries", label: "Marketable-limit entries", kind: "bool", hint: "Converts opening market orders to tightly-priced limits so a fast tape can't fill arbitrarily far past the quote." }
];

/** One consolidated group for EVERY per-position exit rule (owner ask, 2026-07-10): the base
 *  stop-loss % used to live alone in Essentials while ATR/beta/trailing/broker plumbing hid in the
 *  Advanced rulebook — so nothing on screen said that with ATR on (the default) the flat % is only
 *  the FALLBACK distance. These now render together under the stop-flow diagram (stop-flow.tsx),
 *  ordered the way the flow reads: distance rules, then the trailing overlay, then who enforces. */
export const PROTECTIVE_STOPS: FieldDef[] = [
  { path: "riskRules.stopLossPct", label: "Stop-loss (base %)", kind: "pct", optional: true, looserWhen: "up", hint: "Base stop distance below entry — and the always-on FALLBACK when the per-symbol rules below can't price a name (no bars for ATR, no beta).  Wider = looser protection.  ATR/beta set the distance OF this stop.  Clearing the field resets it to the shipped 8% default — it does not turn stops off." },
  { path: "atrStops", label: "ATR-based stops", kind: "bool", looserWhen: "off", hint: "First choice for the stop distance: the name's own realized daily range (ATR multiple × ATR ÷ entry).  Falls back to beta-scaled/fixed when bars are unavailable." },
  { path: "riskRules.atrStopPeriod", label: "ATR period", kind: "int", optional: true, hint: "Lookback (daily bars) for the ATR read.  Default 14." },
  { path: "riskRules.atrStopMultiple", label: "ATR multiple", kind: "int", optional: true, hint: "Stop distance = this many ATRs below entry.  Default 2." },
  { path: "betaScaledStops", label: "Beta-scaled stops", kind: "bool", looserWhen: "off", hint: "Second choice: the base % scaled by the name's beta (clamped 0.5–2.0×) — wider for high-beta names, tighter for low-beta.  Used when ATR has no bars; names without a beta fall through to the flat base %." },
  { path: "riskRules.trailingStopPct", label: "Trailing stop", kind: "pct", optional: true, looserWhen: "up", hint: "An extra high-water-mark exit: triggers when price falls this far from its best level since entry.  Blank/0 = off.  Becomes broker-held where supported (see Broker-held trailing below).  Honest limit: shares already committed to a resting broker exit (e.g. Alpaca bracket stop/take legs) can't also back a trail — those positions keep their bracket exits and the trail applies to unbracketed ones." },
  { path: "riskRules.takeProfitPct", label: "Take profit at", kind: "pct", optional: true, hint: "Profit target (always a flat % — never widened by ATR/beta)." },
  { path: "riskRules.takeProfitTrimPct", label: "Take-profit trim", kind: "pct", optional: true, hint: "How much of the position to sell when take-profit triggers (100 = full exit)." },
  { path: "brokerBracketsEnabled", label: "Broker-held brackets", kind: "bool", hint: `Stop/take-profit legs rest at the broker (where supported) so protection survives app downtime.  Turning this OFF is looser.  ${ADVISORY_NOTE}`, looserWhen: "off" },
  { path: "brokerTrailingStops", label: "Broker-held trailing stops", kind: "bool", looserWhen: "off", hint: `With a trailing % set: on Alpaca REST, a native trailing_stop order (the broker moves the trigger itself, even while the app is down); an Alpaca MCP-endpoint account instead gets the SAME app-ratcheted resting stop as Robinhood (MCP has no native trailing parameter, so the trigger only moves on the app's own tick cadence, not continuously); on Robinhood a resting stop the app ratchets upward each cycle (needs Robinhood resting stops ON).  Turning this OFF keeps trailing app-managed only.  ${ADVISORY_NOTE}` },
  { path: "robinhoodBrokerStops", label: "Robinhood resting stops", kind: "bool", looserWhen: "off", hint: "Opt-in true broker-side stop for Robinhood positions (Robinhood cannot hold OCO brackets).  Also the gate for broker-held trailing on Robinhood." },
  { path: "exitsReleaseAppStops", label: "Exits release the app's own stop", kind: "bool", hint: "When an approved sell or cover is blocked only because the app's own resting broker stop holds the shares, cancel that stop, place the exit, then re-place a stop for any shares left.  Owner and external orders are never touched.  While the exit order is working it holds the shares itself, so the stop comes back once it fills or is cancelled.  Off keeps the old behavior: the exit is blocked and the position can only leave through its stop.  Default on." },
  { path: "allowExtendedHoursSyntheticStops", label: "App stops in extended hours", kind: "bool", looserWhen: "on", hint: "Continues monitoring and executing synthetic stop-losses during extended hours (pre-market 4:00 AM – 9:30 AM ET and after-hours 4:00 PM – 8:00 PM ET)." },
  { path: "riskRules.protectWhileHalted", label: "Protect while halted", kind: "bool", looserWhen: "off", hint: "Allows synthetic stops to continue monitoring and executing protective exits even while trading is halted." }
];

export const PANIC_BRAKE: FieldDef[] = [
  { path: "volPanicBrakeEnabled", label: "Volatility panic brake", kind: "bool", looserWhen: "off", hint: `A rare tail-extreme reading on VIX/VVIX/SKEW flips the system to Exit-only automatically.  Turning OFF is looser.  ${ADVISORY_NOTE}` },
  { path: "volPanicVixThreshold", label: "VIX threshold", kind: "int", optional: true, looserWhen: "up" },
  { path: "volPanicVvixThreshold", label: "VVIX threshold", kind: "int", optional: true, looserWhen: "up" },
  { path: "volPanicSkewThreshold", label: "SKEW threshold", kind: "int", optional: true, looserWhen: "up" }
];

export const SHORTS: FieldDef[] = [
  { path: "shortSellingEnabled", label: "Short selling", kind: "bool", looserWhen: "on", hint: `Also requires the broker to allow shorting on this account.  Shorts are Alpaca-only.  Every short must carry a short stop-loss.  Turning off short selling blocks opening new short positions; existing shorts remain protected.  ${ADVISORY_NOTE}` },
  { path: "brokerStopsForShorts", label: "Broker-held short buy-stops", kind: "bool", looserWhen: "off", hint: `On Alpaca, rest a GTC buy-stop above the market for each open short so a cover survives app downtime.  Default on.  Off keeps shorts on the app monitor only.  ${ADVISORY_NOTE}` },
  { path: "maxShortOrderNotional", label: "Max short order", kind: "money", optional: true, looserWhen: "up" },
  { path: "maxShortExposurePct", label: "Max short exposure (%)", kind: "pct", optional: true, looserWhen: "up" },
  { path: "riskRules.shortStopLossPct", label: "Short stop-loss", kind: "pct", optional: true, looserWhen: "up", hint: "Defaults to 8%.  Every short carries a stop — a short without one is rejected." }
];

export const OPTIONS: FieldDef[] = [
  { path: "optionsTradingEnabled", label: "Options trading", kind: "bool", looserWhen: "on", hint: `Place and cancel single-leg option orders.  ${ADVISORY_NOTE}` },
  { path: "eventContractsEnabled", label: "Event contracts", kind: "bool", looserWhen: "on", hint: `Kalshi event-contract sleeve.  ${ADVISORY_NOTE}` },
  { path: "kalshiMacroEnabled", label: "Kalshi macro data", kind: "bool", hint: "Use Kalshi data for macro/industry/company outlook.  Does not require a Kalshi broker connection." }
];

export const HYGIENE: FieldDef[] = [
  { path: "maxProposalsPerRun", label: "Max ideas per run", kind: "int", looserWhen: "up" },
  { path: "maxHourlyNotional", label: "Max spend per hour", kind: "money", optional: true, looserWhen: "up", hint: "Rolling 60-minute ceiling.  Breaching it auto-demotes the account back to Ask-first." },
  { path: "proposalExpiryMinutes", label: "Proposal expiry", kind: "minutes", optional: true, hint: "Pending proposals older than this auto-expire.  0/blank = no hard expiry." },
  { path: "proposalRevalidateCadenceHours", label: "Re-validate pending ideas every (hours)", kind: "int", optional: true, hint: "0 = every run." },
  { path: "staleLimitOrderMinutes", label: "Stale limit-order alert (minutes)", kind: "int", optional: true },
  {
    path: "brokerMinimumHandling",
    label: "Sub-minimum orders",
    kind: "select",
    options: [
      { value: "bump", label: "Bump to broker minimum — default" },
      { value: "skip", label: "Skip (block pre-flight)" }
    ],
    // skip -> bump is looser: bump places MORE notional than the strategy sized (raised to the
    // broker floor); skip places nothing.
    looseRank: { skip: 0, bump: 1 },
    hint:
      "What happens when a fractional/dollar order lands below the broker's minimum order size (e.g. Robinhood's $1 floor) — " +
      "typically a %-of-NAV-clamped trim on a small account. " +
      "Bump (default): the order is raised to the floor and placed, audited with its before/after size; sells never exceed the held position, " +
      "and the bumped order still goes through every policy check.  Skip: it is blocked before the broker's guaranteed reject (one alert per day per symbol)."
  }
];

export const TAX_RULES: FieldDef[] = [
  {
    path: "taxSettings.washSaleHandling",
    label: "Taxable-account wash-sale rebuys",
    kind: "select",
    options: [
      { value: "block", label: "Block (strict)" },
      { value: "ask", label: "Ask me (priced approval)" },
      { value: "auto", label: "Auto (proceeds, priced) — default" }
    ],
    // block -> ask -> auto is strictly looser: each step lets a tax-costly rebuy get closer to
    // executing. Moving down this ladder on a brokerage account costs the typed word.
    looseRank: { block: 0, ask: 1, auto: 2 },
    hint:
      "What happens when the strategy wants to rebuy a stock sold at a loss in the last 30 days (wash sale). " +
      "Auto (default): the rebuy proceeds — the forfeited tax deduction (loss × your short-term rate) is priced and shown in the rationale/receipt, but it's the strategy's own call, not a hard block. " +
      "Ask: it becomes a pending approval showing the tax deduction you'd forfeit — your call.  Block: refused outright (a stricter opt-in). " +
      "Rebuying inside an IRA while a taxable-account loss is locked is governed by the separate IRA setting below."
  },
  {
    path: "taxSettings.iraWashSaleHandling",
    label: "IRA taxable-loss rebuys",
    kind: "select",
    options: [
      { value: "block", label: "Block (strict)" },
      { value: "auto", label: "Auto — weigh it, then proceed" },
      { value: "disregard", label: "Ignore (default)" }
    ],
    // block -> auto -> disregard is strictly looser.
    looseRank: { block: 0, auto: 1, disregard: 2 },
    hint:
      "What happens when this IRA wants to rebuy a stock a TAXABLE account of yours sold at a loss in the last 30 days. " +
      "Under Rev. Rul. 2008-5 that replacement purchase permanently destroys the loss deduction — the IRA never gets a basis adjustment. " +
      "Ignore (default) does not constrain this IRA.  Auto lets Green weigh the priced forfeited deduction, then proceeds. " +
      "Block refuses the rebuy.  The optional minimum-loss floor below (blank = every loss) applies to Auto and Block."
  },
  {
    path: "taxSettings.washSaleMinLossUsd",
    label: "Wash-sale lockout: minimum loss",
    kind: "money",
    optional: true,
    looserWhen: "up",
    hint:
      "Optional.  Only losses at least this large count as a wash-sale lockout.  Blank = every loss is in play (taxable and IRA).  This loosens only THIS APP's guardrail — the IRS applies the wash-sale rule to losses of any size, and the tax report still counts them."
  }
];

export const UNIVERSE_FLOOR: FieldDef[] = [
  { path: "universeFloor.minPrice", label: "Min share price", kind: "money", optional: true, looserWhen: "down", hint: "The penny-stock gate.  Held positions and your explicit symbols are always exempt; exits never affected." },
  { path: "universeFloor.minMarketCapUsd", label: "Min market cap", kind: "money", optional: true, looserWhen: "down" },
  { path: "universeFloor.minDollarVolume", label: "Min daily dollar volume", kind: "money", optional: true, looserWhen: "down" }
];

/** Volatility-targeting sizing tapers + risk receipts (policy.tuning, guard enablement 2026-07-28).
 *  All four are tapers/receipts — none can block an opening or touch an exit. */
export const VOL_TARGETING: FieldDef[] = [
  { path: "tuning.volTargeting", label: "Volatility-target sizing", kind: "bool", looserWhen: "off", hint: "Tapers an opening order's size down when the name's realized volatility runs hotter than your target (never sizes up, floors at the exploratory minimum).  Turning this OFF is looser — wild names get full size." },
  { path: "tuning.targetPortfolioVolPct", label: "Vol target (%)", kind: "pct", optional: true, looserWhen: "up", hint: "Annualized realized-volatility target per position.  A higher target means less tapering (looser).  Blank = revert to the default 25% taper.  Enter 0 to disable the vol taper (the heat budget below can still apply)." },
  { path: "tuning.portfolioHeatBudgetPct", label: "Portfolio heat budget (%)", kind: "pct", optional: true, looserWhen: "up", hint: "The book's total distance-to-stop dollar risk as a % of equity.  An opening order's incremental risk is tapered to fit the remaining budget — advisory, never a hard block.  Blank = revert to the default 10% taper.  Enter 0 to disable the heat taper." },
  { path: "tuning.riskReceipts", label: "Risk receipts", kind: "bool", hint: "Appends a correlation profile and a pre-trade stress-scenario note to every opening proposal's rationale (inform-only — never changes size or blocks a trade).  Costs a few extra price-bar fetches per candidate." }
];

/** Per-account event-trigger settings (policy.triggerSettings, 2026-07-28). Every field falls back
 *  to the global TRIGGER_ENGINE/TRIGGER_MODE env when unset — "Use global" is the honest default. */
export const TRIGGERS: FieldDef[] = [
  {
    path: "triggerSettings.enabled",
    label: "Event-triggered runs",
    kind: "select",
    options: [
      { value: "", label: "Use global (env)" },
      { value: "true", label: "On" },
      { value: "false", label: "Off" }
    ],
    optionValues: { "": null, "true": true, "false": false },
    // Off/global-off = 0, On = 1: opting an account INTO event-driven autonomous runs loosens.
    looseRank: { "": 0, "false": 0, "true": 1 },
    hint: "Let material events (8-K filings, regime flips, technical signals) fire a strategy run for this account instead of waiting for the fixed interval.  Off opts this account out even when the deployment's engine is on.  Note: On only opts this account IN — it cannot power the engine by itself when the deployment-level TRIGGER_ENGINE env is off.  Events are deduped, debounced, and rate-capped."
  },
  {
    path: "triggerSettings.mode",
    label: "Run mix",
    kind: "select",
    options: [
      { value: "", label: "Use global (env)" },
      { value: "interval", label: "Interval only" },
      { value: "event", label: "Event only" },
      { value: "both", label: "Both" }
    ],
    optionValues: { "": null },
    hint: "Interval = fixed-cadence runs only.  Event = runs fire only on material events (pair it with a fallback interval below so a quiet tape can't strand the account).  Both = events plus the normal cadence."
  },
  {
    path: "triggerSettings.fallbackIntervalMinutes",
    label: "Event-mode fallback interval",
    kind: "minutes",
    optional: true,
    hint: "Event-only mode: still run the fixed cadence at least this often as a safety floor.  Blank = never (a silent event feed means no runs at all)."
  },
  {
    path: "triggerSettings.eventRunMode",
    label: "Event run scope",
    kind: "select",
    options: [
      { value: "", label: "Full run (default)" },
      { value: "full", label: "Full run" },
      { value: "close_only", label: "Exit-only" }
    ],
    optionValues: { "": null },
    // close_only is strictly tighter than full: exits only, no new risk on an event.
    looseRank: { "": 1, "full": 1, "close_only": 0 },
    hint: "What an event-fired run may do.  Full = a normal run (opens + exits).  Exit-only = the run manages exits and safety maintenance but every new opening is rejected at the policy gate — for this run only; your stored state is never changed."
  }
];

/** Per-account Kalshi event-contract settings */
export const KALSHI_EVENT_DEFS: FieldDef[] = [
  { path: "eventContractsEnabled", label: "Event contracts trading", kind: "bool", looserWhen: "on", hint: `Permits autonomous and proposed trading of binary event contracts on Kalshi.  ${ADVISORY_NOTE}` },
  { path: "maxOrderNotional", label: "Max per order ($)", kind: "money", optional: true, looserWhen: "up", hint: "Maximum dollar spend on any single event-contract order." },
  { path: "maxDailyNotional", label: "Max daily spend ($)", kind: "money", optional: true, looserWhen: "up", hint: "Maximum cumulative dollar spend across all event contracts per calendar day." },
  { path: "maxDailyOrders", label: "Max opening orders per day", kind: "int", looserWhen: "up", hint: "Caps the maximum number of new Yes/No event contract positions opened per day." },
  { path: "runCadenceMinutes", label: "Scan cadence (minutes)", kind: "minutes", hint: "How frequently the agent evaluates Kalshi prediction markets." },
  { path: "kalshiMacroEnabled", label: "Kalshi macro intelligence", kind: "bool", hint: "Ingest Kalshi event odds into macro outlook analysis." }
];

export const ALL_DEFS: FieldDef[] = [
  ...ESSENTIALS,
  ...SOCRATIC_OVERRIDE,
  ...EXPOSURE,
  ...ENTRY_QUALITY,
  ...PROTECTIVE_STOPS,
  ...PANIC_BRAKE,
  ...SHORTS,
  ...OPTIONS,
  ...KALSHI_EVENT_DEFS,
  ...HYGIENE,
  ...TAX_RULES,
  ...UNIVERSE_FLOOR,
  ...VOL_TARGETING,
  ...TRIGGERS
];

export const INDICES: Array<{ id: IndexUniverse; label: string }> = SUPPORTED_INDEX_UNIVERSES.map((id) => ({
  id,
  label: indexUniverseLabel(id)
}));

export const ORDER_TYPES: OrderType[] = ["market", "limit", "stop_market", "stop_limit"];
