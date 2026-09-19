import { describe, expect, it } from "vitest";
import { isHardGateReason } from "../src/lib/policy";

/**
 * Owner guardrail philosophy (2026-07-05): the agent may self-override ANY policy block with a logged
 * `autonomyOverride` thesis EXCEPT a hard gate — the account boundary or a physical / broker /
 * regulatory / accounting impossibility. `isHardGateReason` (policy.ts) is the single source of truth
 * for that split; `socratic-runtime.overrideableReason` is now just `!isHardGateReason`. This test pins
 * the split against the ACTUAL reason strings produced by evaluateTradeProposal, so a future gate edit
 * that changes a reason's wording (or a refactor that reverts the denylist) fails here.
 *
 * The critical property is the DEFAULT: an unrecognized / newly-added reason must classify as a
 * PREFERENCE (overridable), not hard — the inverse of the old allowlist, which silently made any
 * unlisted gate un-overridable.
 */

// Real reason strings (or exact substrings) emitted by src/lib/policy.ts.
const HARD_REASONS: Array<[string, string]> = [
  // 2026-09-18 (#3380 venue-normalization takeover): production switched from the
  // broker-specific "No Robinhood account is selected." to the broker-agnostic
  // "No broker account is selected." (the venue-normalization refactor made the policy
  // message match the consolidated cross-broker story). Updated here to match.
  ["account boundary", "No broker account is selected."],
  ["symbol not tradable", "AAPL is not tradable right now."],
  ["insufficient buying power", "Order of $7000.00 exceeds available buying power $6000.00."],
  ["sell exceeds holdings", "Sell quantity exceeds current AAPL holdings."],
  ["cover exceeds shorts", "Cover quantity exceeds current TSLA short holdings."],
  ["malformed exit", "AAPL exit must specify a quantity or dollar amount."],
  ["margin minimum (FINRA 26-10 / PDT successor)", "margin_minimum: this LIVE margin account's equity $1000.00 is below the $2,000 margin minimum."],
  ["broker cannot short (capability)", 'Order side "short" rejected: the connected account does not support short selling.'],
  ["fractional outside regular hours", "Fractional or dollar-based orders must be regular-hours only."],
  ["generic broker rejection", "broker rejected the order: insufficient settled funds."],
  ["IRA wash-sale lockout", "NVDA is in a 30-day wash-sale lockout. Rebuying it inside this IRA would PERMANENTLY destroy the loss."]
];

const PREFERENCE_REASONS: Array<[string, string]> = [
  // systemState — owner/breaker-set operational states, overridable per "agent decides, logs everything"
  ["system halted", "System is halted."],
  ["system close-only", "System is close-only. New entries are disabled."],
  ["system liquidating", "System is liquidating. Only close orders allowed."],
  // universe / order-type / hours preferences
  ["not in universe", "TSLA is not in the allowed universe."],
  ["order type not permitted", "bracket orders are not permitted."],
  ["extended hours disabled", "Extended-hours orders are disabled."],
  // RECLASSIFIED from hard -> preference in this change
  ["short-selling disabled in policy (not broker)", 'Order side "short" rejected: short-selling is disabled in policy.'],
  ["short mandatory stop-loss rule", "Short proposals must carry a mandatory stop-loss (policy.riskRules.shortStopLossPct)."],
  ["bracket-order config requirement", 'Bracket orders require "bracket" in permittedOrderTypes or a stopLossPct risk rule.'],
  // sizing / notional / exposure / regime caps
  ["max order notional", "Order of $900.00 exceeds the maximum order limit of $500.00"],
  ["max short order notional", "Order of $900.00 exceeds the max short order limit of $500"],
  ["daily notional cap", "Daily notional limit would be exceeded."],
  ["hourly notional cap", "Hourly notional limit would be exceeded."],
  ["daily order count cap", "Daily opening-order count limit would be exceeded."],
  ["crisis cap", "Opening NVDA exposure 30.00% exceeds crisis/inverted-regime cap 5%."],
  ["symbol exposure cap", "Projected NVDA exposure 40.00% exceeds 25%."],
  ["gross exposure cap", "Projected gross exposure $50000.00 exceeds gross cap $40000.00 (200%)."],
  ["net exposure cap", "Projected net exposure $30000.00 exceeds net cap $20000.00 (150%)."],
  ["short exposure cap", "Projected total short exposure 60.00% exceeds maxShortExposurePct limit of 50%."],
  ["sector exposure cap", "Projected Technology sector exposure 45.00% exceeds sector cap 30%."],
  ["entry drift", "entry_drift: NVDA moved 3.2% from the decision-time reference price."],
  ["staleness", "staleness_gate: NVDA quote is 400s old (max 120s)."],
  ["stop-loss add block", "Stop-loss rule blocks adding to a losing position."],
  ["take-profit add block", "Take-profit rule blocks adding past the profit target."],
  // PRE-POLICY vetoes folded into the sized PolicyDecision as OVERRIDABLE reasons (pre-veto override
  // flow). Both must classify as preferences so an autonomyOverride thesis can pass them on openings —
  // this is the whole mechanism that makes the deterministic-bear filter and approval-time Red Team
  // advisory-overridable without touching policy.ts.
  ["deterministic-bear regime veto", "deterministic_bear_veto: Crisis (Extreme Volatility) regime with below-median scan score (40.0 < median 70.0); risk-on entry too weak"],
  ["deterministic-bear fundamentals veto", "deterministic_bear_veto: Fundamentals veto: FCF yield -3.10% below floor 0% (cash-burning)"],
  ["red-team veto", "red_team_veto: The bull thesis ignores a deteriorating balance sheet and a fresh guidance cut."],
  // Earnings-proximity advisory blackout (lane 3, correlation/event/stress gates): tags an opening
  // within the configured window of its next earnings date via the SAME preVetoReasons fold-in
  // mechanism as the pre-policy vetoes above. Falls through to the denylist default (no special
  // prefix carve-out needed — the free text contains no hard-gate substring) and must classify as an
  // overridable preference so an autonomyOverride thesis can still pass it.
  ["earnings blackout advisory tag", "earnings_blackout: opening within 2 day(s) of earnings (window 3)"],
  // the DENYLIST default: an unrecognized / future gate must be overridable, not hard
  ["novel unlisted future gate", "Some brand-new risk preference gate the agent has never seen would be exceeded."]
];

describe("isHardGateReason — hard gates (never agent-overridable)", () => {
  it.each(HARD_REASONS)("HARD: %s", (_label, reason) => {
    expect(isHardGateReason(reason)).toBe(true);
  });
});

describe("isHardGateReason — risk preferences (agent-overridable with a logged thesis)", () => {
  it.each(PREFERENCE_REASONS)("PREFERENCE: %s", (_label, reason) => {
    expect(isHardGateReason(reason)).toBe(false);
  });
});

describe("isHardGateReason — the short-side broker/policy discrimination", () => {
  it("broker-capability short block is HARD; policy-toggle short block is an overridable preference", () => {
    expect(isHardGateReason('Order side "short" rejected: the connected account does not support short selling.')).toBe(true);
    expect(isHardGateReason('Order side "short" rejected: short-selling is disabled in policy.')).toBe(false);
  });
});

describe("isHardGateReason — pre-veto tags stay preferences even when the free-text payload contains a hard-gate substring (ISSUE 2 regression)", () => {
  // A Red Team veto's reason is unconstrained LLM prose and may coincidentally contain a hard-gate word
  // ("broker", "buying power", "PERMANENTLY", "wash sale"). The `red_team_veto:` / `deterministic_bear_veto:`
  // prefix must classify it as a preference BEFORE the substring scan, or a valid override is silently
  // refused (and the card mislabels the veto as overridden while the trade was actually blocked).
  it.each([
    "red_team_veto: The broker-dealer subsidiary faces a regulatory probe.",
    "red_team_veto: Management is burning buying power on buybacks.",
    "red_team_veto: This looks like permanently impaired capital.",
    "red_team_veto: The thesis relies on a wash sale of the prior lot.",
    "deterministic_bear_veto: over-levered; the broker flagged intraday margin risk."
  ])("PREFERENCE despite an embedded hard-gate substring: %s", (reason) => {
    expect(isHardGateReason(reason)).toBe(false);
  });

  it("does NOT let the prefix mask a genuine hard reason", () => {
    expect(isHardGateReason("Order of $7000.00 exceeds available buying power $6000.00.")).toBe(true);
    expect(isHardGateReason("Sell quantity exceeds current AAPL holdings.")).toBe(true);
  });
});
