# Stop-loss, exits & downside-risk controls

Canonical reference for every mechanism that closes a position, caps a loss, or
restricts opening risk. Grouped by layer. For each: what it does, the controlling
policy field / env flag, default, sync/async, broker scope, and status.

> **All money-path risk knobs are policy-driven** (`TradingPolicy` /
> `TradingPolicy.riskRules` in `src/lib/types.ts`, defaults in `src/lib/defaults.ts`,
> validated in `app/api/policy/route.ts`). None require an env var.

## Quick reference

| Mechanism | Field | Default | Layer | Status |
|-----------|-------|---------|-------|--------|
| Fixed % stop-loss | `riskRules.stopLossPct` | 8% | Per-position | Shipped |
| Stop-loss notional | `riskRules.stopLossNotional` | off | Per-position | Shipped |
| Take-profit % | `riskRules.takeProfitPct` | 20% | Per-position | Shipped |
| Take-profit notional | `riskRules.takeProfitNotional` | off | Per-position | Shipped |
| Trailing stop | `riskRules.trailingStopPct` | 0 (off) | Per-position | Shipped |
| Short stop-loss | `riskRules.shortStopLossPct` | required for shorts | Per-position | Shipped |
| **Beta-scaled stops** | `betaScaledStops` | **on** (since 2026-07-07) | Per-position | Shipped |
| **ATR-based stops** | `atrStops` + `riskRules.atrStop{Period,Multiple}` | **on** (since 2026-07-07) | Per-position | Shipped |
| Alpaca OCO brackets | `brokerBracketsEnabled` | on (Alpaca) | Order | Shipped |
| Robinhood broker stops | `robinhoodBrokerStops` | off (opt-in) | Order | Shipped |
| **Broker-held trailing stops** | `brokerTrailingStops` | on (inert until `trailingStopPct`>0) | Order | **Shipped (new 2026-07-10)** |
| Synthetic trailing monitor | (auto when `trailingStopPct`>0) | — | Order | Shipped |
| Marketable-limit entries | `marketableLimitEntries` | off | Order | Shipped |
| Max drawdown breaker | `riskRules.maxDrawdownPct` | off | Account | Shipped |
| Daily-loss breaker | `riskRules.maxDailyLossNotional` | off | Account | Shipped |
| Vol panic brake (VIX/VVIX/SKEW) | `volPanicBrakeEnabled` | on (tails) | Account | Shipped |
| System state machine | `systemState` | halted | Account | Shipped |
| Wash-sale guard (§1091) | `taxSettings.washSaleGuard` | on | Compliance | Shipped |
| Pre-trade gates | (many — see §D) | varies | Pre-trade | Shipped |

---

## A. Per-position exits

These set when an *individual* holding is trimmed or closed. The deterministic
**proactive risk-exit generator** (`generateProactiveRiskProposals`,
`src/lib/strategy.ts`) runs each cycle *before* the LLM and emits market SELL
(long) / COVER (short) proposals when a stop/take-profit is breached. The same
distances feed the pre-trade gate (`riskRuleReason`, `policy.ts:445`) and the
bracket/synthetic placement.

### Fixed % stop-loss — `riskRules.stopLossPct`
Closes (or blocks adding to) a long down more than `stopLossPct` from entry.
Default **8%**. Sync gate + async proactive exit. `types.ts:202`, `defaults.ts:22`,
`policy.ts:461`, `strategy.ts:~2499`. The `…Notional` sibling (`stopLossNotional`)
does the same in dollars; default off.

### Take-profit — `riskRules.takeProfitPct` / `takeProfitNotional`
Trims a long up ≥ `takeProfitPct` (default **20%**) — a target, not a stop, so it
is **never** widened by beta/ATR. `types.ts:204`.

### Trailing stop — `riskRules.trailingStopPct`
A high-water-mark trail: exits when price falls `trailingStopPct` below the
running peak (long) / rises above the trough (short). Default **0 (off)**; async
(the synthetic monitor, `src/lib/synthetic-stops.ts`). Since 2026-07-10 a
configured trail also becomes **broker-held** where the broker supports it — see
"Broker-held trailing stops" in §B. Runs IN ADDITION to the fixed/ATR stop: both
are armed, whichever triggers first exits.

### Short stop-loss — `riskRules.shortStopLossPct`
**Mandatory** on any short proposal (`policy.ts:112` rejects a short without it).
Short loses when price rises; covers on a breach.

### Beta-scaled stops — `betaScaledStops` (default off)
Scales the stop *distance* by the name's beta, clamped **0.5×–2.0×**: high-beta
names get wider stops (fewer noise stop-outs), low-beta tighter (cut losers
sooner). Beta comes from the market scan; names without a beta are unaffected.
`betaScaledStopPct()` in `policy.ts:518`. Sync (beta is precomputed in the scan).

### ATR-based stops — `atrStops` (default off) **[new 2026-06-25]**
A volatility-aware stop driven by the name's **own realized daily range** instead
of beta. When `policy.atrStops` is on, the per-position stop *distance* becomes:

```
stopPct = clamp( atrStopMultiple × ATR(atrStopPeriod) ÷ entryPrice × 100, 1%, 50% )
```

- `riskRules.atrStopPeriod` (default **14**, bounded 5–100) — ATR lookback in bars.
- `riskRules.atrStopMultiple` (default **2.0**, bounded 0–10) — ATR multiplier.
- Pure math: `trueRange`, `atr`, `atrStopPct` in `src/lib/indicators.ts`.
- Wiring: the async strategy loop precomputes an ATR stop-% per open position from
  `fetchDailyOHLC` bars and passes it into the (sync) proactive generator —
  mirroring the `betaBySymbol` precompute (`strategy.ts`). It applies only when
  `stopLossPct > 0` (it sets the *distance* of the configured stop) and **falls
  back to the fixed/beta stop whenever bars are unavailable** — a position is
  never left unprotected. **ATR takes precedence over beta-scaling** when both are
  on (it's the more direct, per-name volatility read).

**Why three modes?** Fixed % is simple and predictable. Beta-scaled adapts to a
name's *market* sensitivity (needs a beta). ATR adapts to a name's *realized*
range and needs only its own bars — useful when a beta is missing or a name's
idiosyncratic volatility differs from its market beta.

### Per-position stop PLANS — `TradeProposal.stopPlan` **[new 2026-07-10]**
The account-wide settings above (fixed %, beta-scaled, ATR, trailing) are the *default
precedence* every position follows. The LLM can instead pin **one specific position** to a
chosen stop **type** at open time — `stopPlan: { style: "fixed"|"atr"|"trailing"|"none", rationale? }`
(distinct from `bracketStopLoss`, a per-trade stop *price*) — persisted for the position's life in
`position_stop_plans` (committed on fill, cleared on close, same pattern as the take-profit band
ratchet in §below). All four enforcement layers honor the SAME plan for that symbol:
- `"fixed"`/`"atr"` PIN the distance the proactive generator and any Alpaca bracket use for that
  position, ignoring the account's own ATR/beta toggles for it — using `STOP_PLAN_FALLBACK_STOP_PCT`
  (8%) when the account has no stop-loss % configured at all.
- `"trailing"` makes the synthetic monitor register a trail for that position even when the
  account's own `trailingStopPct` is 0 (same 8% fallback), and skips the fixed/ATR exit for it.
- `"none"` is a genuine, owner-accepted no-stop choice for that one position — never hard-blocked
  (real trading, owner's risk), but never silent either: it tears down any existing broker-held or
  synthetic registration for that symbol and is surfaced on the Positions table and approval card.
- Absent/`"default"` — no behavior change; the position follows the account's own precedence.

Every style is genuinely available for every symbol regardless of the account's own
configuration (a plan-only account still gets real protection via the fallback %), and a
broker-held stop resolver only *narrows* which of the account's enabled lane(s) apply to a
plan-pinned symbol — it never invents a broker capability the account doesn't otherwise have; the
always-on synthetic monitor is what actually guarantees the plan works on any broker. See
`docs/rollouts/2026-07-10-per-position-stop-plans.md` for the full design/implementation record.

---

## B. Order-level protection (survives app downtime / fills at the broker)

### Alpaca OCO brackets — `brokerBracketsEnabled` (default on, Alpaca only)
On an opening Alpaca order, attaches a stop-loss + take-profit OCO pair at
`entry × (1 ∓ pct/100)`. Computed in `enrichOpeningProposal` (`strategy.ts:~2393`).
Non-bracket brokers get a transparency note + the synthetic monitor fallback.

### Robinhood broker-held stops — `robinhoodBrokerStops` (default off, opt-in)
Places a resting **GTC stop-market SELL** at `stopLossPct` below entry for each
open RH **live** long, cancels on close / synthetic-exit. `broker-protective-stops.ts`,
`broker_protective_stops` table. Enabled only when `robinhoodBrokerStops` +
`broker/live` + `activeBroker==="robinhood"` + `stopLossPct>0`. Opt-in because the
exact RH MCP stop semantics should be live-verified first; the synthetic monitor
stays the always-on fallback.

### Broker-held trailing stops — `brokerTrailingStops` (default on; inert until `trailingStopPct`>0) **[new 2026-07-10]**
When a trailing % is configured, the protective-stop reconciler
(`broker-protective-stops.ts`) maintains a broker-held trailing stop per open
long instead of the fixed broker stop (shares can only back ONE resting sell):

- **Alpaca REST (paper + live):** a TRUE native `trailing_stop` order
  (`EquityOrderInput.trailPercent` → `trail_percent`) — the broker trails the
  high-water mark itself, even while the app is down. Whole shares only
  (fractional remainders stay on the synthetic monitor); refuses
  trailing+bracket combos. `alpaca-mcp` accounts (possibly endpoint-only, no
  REST keys) take the ratcheted lane below through their MCP transport instead.
- **Robinhood (live, additionally gated on `robinhoodBrokerStops`):** the RH MCP
  has **no verified native trailing parameter**, so the reconciler places a
  resting GTC stop-market at the trail distance below the high-water mark and
  **ratchets it upward** (cancel-replace, churn-guarded ≥$0.02 & ≥0.1%, never
  down) each scheduler tick. Between ticks the broker holds a real stop;
  the trail catches up on the app's cadence. `toMcpOrder` throws on
  `trailPercent` (fail closed) — translate there if RH adds a native peg.

Placement is coverage-aware: a position already fully covered by another live
exit-side order (an Alpaca bracket stop leg, a manual GTC sell) is skipped.
Rows live in `broker_protective_stops` with `kind='trailing'` + `trail_percent`.
Longs only (Alpaca short trails = follow-up). Off-switch: `brokerTrailingStops:
false` keeps trailing purely app-managed.

### Synthetic trailing-stop monitor (all brokers)
`runSyntheticStopMonitor` (`synthetic-stops.ts:86`) ticks each cycle: tracks a
high/low-watermark, ignores >10% bad ticks, and fires a market exit on a breach.
Atomically claims a stop before placing (no double-fire) and cancels any orphaned
broker stop. Skips a symbol that already has a broker-held stop. When the system is
not "running" it audits `synthetic_stop_would_trigger` but does **not** place.

### Marketable-limit entries — `marketableLimitEntries` (default off)
Converts a deterministic opening *market* order into a marketable-limit through the
quote by `tuning.marketableLimitBufferBps` (default 15 bps) so a fast tape can't
fill arbitrarily far. Protective *exits* stay market for fill certainty.

---

## C. Account-level circuit breakers (flip `systemState`)

### Max drawdown — `riskRules.maxDrawdownPct`
Trailing drawdown from the cash-flow-aware equity high-water mark ≥ cap →
advisory (default) or `systemState` → `close_only`/`halt` when opted in.
`risk-breaker.ts` evaluates at run start. Deposits raise HWM by the dollars
added; withdrawals scale HWM by remaining/prior equity so a cash-out is not a
false drawdown. Persisted at `risk:hwm:${userId}:${accountNumber}:${source}`.
Stuck marks (historical deposits/withdrawals before this recorder) are healed
by ops `POST /api/ops/hwm/recompute`. Default off.

### Daily-loss — `riskRules.maxDailyLossNotional`
Single-day equity loss from the day's start ≥ cap → `close_only`. Same module.
Default off.

### Volatility panic brake — `volPanicBrakeEnabled` (default on)
Any of VIX ≥ 40 / VVIX ≥ 150 / SKEW ≥ 160 (thresholds configurable) → `close_only`.
`macro.ts:308`, async fetch at run start. A missing gauge is skipped (never
false-trips).

### System state machine — `systemState` (default `halted`)
`active` (opens+exits) · `halted` (all blocked) · `close_only` (exits only) ·
`liquidating` (exits only, stricter). Gate at `policy.ts:55`. Breakers and the
operator drive transitions.

---

## D. Pre-trade risk gates (prevent over-sizing / correlated risk)

Not stops, but they bound downside before a position exists (all in `policy.ts`
unless noted): `maxSymbolExposurePct`, `maxGrossExposurePct` / `maxNetExposurePct`
(default 100%), `sectorCaps`, `maxPortfolioBeta`, `maxAvgCorrelation` (opt-in
cluster gate, `correlation.ts` + `strategy.ts:~860`), `skipNegativeExpectancy`
(opt-in), the deterministic **bear veto** (`bearVetoFcfYieldFloorPct` /
`bearVetoDebtToEquityCeiling`, opt-in), `maxDailyNotional`/`maxDailyOrders`
(500/10), `maxHourlyNotional` (reverts `decide`→`propose` on breach),
the **PDT**/margin path (`MARGIN_MINIMUM_EQUITY` = $2,000 on live margin;
`db-execution.ts` day-trade counting), `maxEntryDriftPct` (default 10% — rejects a
stale opening order whose price drifted), `maxOrderPctOfAdv` (default 5% market-impact
cap), and `crisisMaxOpeningExposurePct` (crisis-regime notional ceiling).

---

## E. Tax / compliance exits

### Wash-sale guard — `taxSettings.washSaleGuard` (default on)
Blocks rebuying a symbol closed at a loss within 30 days (IRC §1091). A **taxable**
loss locks the symbol across **all** accounts (including IRAs, whose replacement buy
would destroy the disallowed basis); losses *inside* an IRA create no lock.
`policy.ts:236`, `tax.ts:99`.

---

## F. Deferred / future

- **Broker-held short buy-stops (Alpaca)** — shipped 2026-08-13. `reconcileBrokerProtectiveStops`
  now includes open shorts when `shortSellingEnabled` and `brokerStopsForShorts` (default on)
  and the venue is Alpaca. Places a GTC buy-stop (cover) above entry. Native trailing is
  side-aware. Robinhood/Webull stay out of this lane.
- **Short-specific take-profit notional** — not yet a field (shorts use
  `takeProfitPct`).

---

## How they compose

1. **Each cycle, before the LLM:** circuit breakers + vol brake evaluate (may flip
   `systemState`); the proactive generator emits deterministic stop/take-profit
   exits; pre-trade gates will block any over-sized/over-correlated *opens*.
2. **At order placement:** Alpaca attaches OCO brackets; opening market orders may
   become marketable-limit.
3. **Continuously:** the synthetic monitor is the always-on trailing fallback;
   Robinhood broker stops (opt-in) and Alpaca brackets are broker-held and survive
   app downtime.

**Choosing a per-position stop:** *fixed %* = simplest/most predictable; *beta-scaled*
= volatility-aware via the name's market beta; *ATR* = volatility-aware via the name's
realized daily range (adapts per-name, no beta needed). Take-profit always stays flat.

_Last verified: 2026-07-10 (per-position stop plans added; broker-held trailing stops + defaults correction: ATR/beta ON since 2026-07-07)._
