# 2026-09-24 CLAUDE — Order Correctness: No Accidental Shorts, Clamp Exits, Closing Orders Carry No Brackets

Board umbrella `687a5fb4` (lane D, slug `st-order-correctness`).  Branch `claude/st-order-correctness`.

## 1. Context & Objective

On Alpaca Paper `PA33IDTHMFK9` (long-only mandate) the app opened a 12-share PG short on
2026-07-08 that took 2.5 months to close, and on 2026-09-21 a VZ full exit was refused 403.
The owner directed a fix for the whole class: an app-originated order must never open or
enlarge a position the strategy did not intend, and closing orders must be shaped so the
broker accepts them.

Production timeline (read-only receipts from the prod DB):

- 11:04:00Z — bracket entry BUY limit PG 12 @152.75 day (`d9f77ab8`, proposal `969c4499`) with a
  take-profit leg SELL limit 165 (`c6e5334f`, state `held`, Alpaca-minted client id `1bc35dbf-...`).
- 11:19:32Z — `limit_order_stale` fired for BOTH the unfilled parent and the held leg.
- 11:19:33Z — stale-exit auto-remediation cancelled the HELD leg and placed a standalone MARKET
  SELL 12 PG (`92d9e66d`).  The parent never filled (cancelled 11:20:31Z).
- 13:33:43Z — the market sell filled 12 @149.76: a 12-share SHORT.
- Then: 12 buy-to-cover proposals refused 422 "bracket orders must be entry orders" (side `buy`
  with bracket legs — the entry-only constraint only stripped legs for sell/cover), 2 refused 422
  "market orders require no stop or limit price" (Jul 16, Jul 22), 7 LLM `sell 12` proposals
  blocked by policy (the prompt told a long-only account "Do not propose short or cover").
  Closed 2026-09-24 14:00Z by a broker protective buy-stop filling at 148.98.
- VZ 2026-09-21: position 0.02778376 sh; `sell market dollarAmount 1.34` (full exit); Alpaca 403
  insufficient qty (requested 0.027910851, available 0.02778376) — the broker's dollars-to-shares
  conversion overshot the held quantity.

## 2. Changes Made

**Held / contingent legs are never stale-remediation candidates.**  New
`isContingentOrderLeg(order, siblings)` (`order-provenance.ts`): an order is a bracket/OTO/OCO
member when it is `held` (whatever its order_class), carries a bracket-family order_class, or —
when its row has NO order_class — has a bracket-family sibling in the same broker listing on the
same symbol, opposite wire side, created within 5 s.  `autoReplaceProvenanceSkipReason` takes the
listing and returns `bracket_leg` for all of them; both order-replacement paths (auto enqueue and
the state-machine step, manual and pump) pass the listing.  `listStaleLimitOrders` never guesses an
ACTIVATED leg's age from `createdAt` (that is the parent's placement time): with no `updatedAt`
(activation) it is not listed.  `notifyStaleLimitOrders` suppresses the alert for every contingent
leg, including a class-less one recognised via its sibling.

**Position invariant at the single placement choke point.**  New `src/lib/order-position-invariant.ts`,
composed into `getBrokerGateway` (inside the live preflight, outside the constraint tables).  Every
app-originated placement (autopilot inline placement in `strategy.ts`, the approval lane's
`executeProposal`, stale-exit market replacements, broker protective stops, synthetic stops)
passes through it.  It reads the FRESH broker position and:

- sell with no long -> refused (`sell_without_long`, "would open a SHORT"); sell against a short
  -> refused with the correct verb (`sell_against_short`); sell above the long -> clamped to the
  exact broker quantity (fractional quantities pass through as the broker's own number);
- cover with no short -> refused (`cover_without_short`); cover above the short -> clamped;
- buy of at most a held short -> re-verbed to `cover` (Tradier needs `buy_to_cover`);
- closing orders lose bracket legs; closing MARKET orders lose limit/stop price;
- a dollar exit within 2% of the held market value resolves to the exact held quantity.

Refusals throw `OrderPositionInvariantError` (an `OrderValidationError`, so lanes record the
proposal as `blocked` — nothing reached the broker) and audit `order_position_invariant_refused`;
reshapes audit `order_position_invariant_reshaped` per receipt; read failures audit
`order_position_read_failed`.

**Closing a short is cover.**  `normalizeExitSidesForHeldPositions` rewrites LLM proposals
upstream of sizing, Red Team, and policy (`strategy.ts`, right after `proposeTrades`): a `sell` of a
held short -> `cover` of the held quantity (or the proposal's smaller quantity); a `buy` of at most
the short -> `cover` without legs.  Audited `proposal_exit_side_normalized`.  The approval lane
(`strategy-execution.ts`) applies only the buy -> cover rewrite (same wire direction) against its
fresh positions and persists it; a stored `sell` of a short is not flipped behind the owner's
approval — the choke point refuses it with the correct verb.  The Green prompt now sees
`positions[].side` (`long`/`short`) beside the signed quantity, and both prompt surfaces
(`strategy-prompts.ts`, `venue-contract-pure.ts`) tell a long-only account how to close an
unintended short (`cover`, never `sell`, never a bracketed `buy`).  Prompt version
`agentic-strategy@2.19.0`.

**No market order builder sends a limit/stop price.**  `alpaca.ts` (REST and MCP) sends
`limit_price` only for limit/stop_limit; `tradier.ts` sends `price` only for limit/stop_limit and
`stop` only for stop_market/stop_limit (single-leg and the bracket entry leg).  New audited
constraint rows `alpaca-limit-price-only-on-limit-orders` and
`tradier-limit-price-only-on-limit-orders`.

Files touched:

- `src/lib/order-position-invariant.ts` (new)
- `src/lib/broker.ts`
- `src/lib/broker-order-constraints.ts`
- `src/lib/order-provenance.ts`
- `src/lib/stale-limit-orders.ts`
- `src/lib/order-replacement.ts`
- `src/lib/strategy-execution.ts`
- `src/lib/strategy.ts` (two tight hunks: post-`proposeTrades` normalization, prompt `positions`)
- `src/lib/strategy-prompts.ts`, `src/lib/venue-contract-pure.ts`
- `src/lib/alpaca.ts`, `src/lib/tradier.ts`
- `src/lib/types.ts` (`EquityOrderInput.verifiedPositionQuantity`)
- `src/lib/broker-protective-stops.ts`, `src/lib/synthetic-stops.ts` (one field each: the verified
  position hint)
- `test/order-position-invariant.test.ts` (new), `test/pg-short-replay.test.ts` (new),
  `test/alpaca-limit-stop-price-guard.test.ts`, `test/tradier.test.ts`,
  `test/broker-order-constraints.test.ts`, `test/strategy-prompt-safety.test.ts`
- Tracked `node_modules` symlink removed (accidentally committed by #3452).

## 3. Decisions & Trade-offs

- **Fresh read, no cache.**  A cached snapshot is the hazard itself: two sells of one symbol a
  second apart would both see the pre-fill long and the second would short.  One extra
  `getEquityPositions` per placement (~100-300 ms on Alpaca REST) is cheap next to an unintended
  position.  Robinhood buys skip the read (Robinhood cannot hold a short); intended `short`
  entries are never inspected.
- **Read failure, per side and broker.**  Buys fail open.  Sell/cover on Alpaca (and the test
  broker) fail CLOSED — Alpaca infers open vs close from the position, so an unverified sell can
  silently short — unless the caller passes `verifiedPositionQuantity` from a read it just made
  (protective stops, synthetic stops, stale-exit replacements pass it), so a protective exit of a
  verified quantity is never blocked by a read blip.  Tradier/Robinhood fail OPEN: their wire
  verbs are explicit, so the broker itself refuses a close with nothing to close.
- **Scope.**  Alpaca (REST + MCP), Tradier, Robinhood, and the test broker.  eToro, Public,
  Webull, and Kalshi pass through: their position sign conventions are unverified here, and a
  wrong read would block real exits.
- **2% full-exit tolerance** for dollar exits: the dollar figure was computed from an earlier
  quote; leaving <= 2% dust is never the intent of a near-full exit.  Partial dollar exits are
  untouched.
- **Approval lane does not flip sell -> cover.**  That reverses the wire direction the owner
  approved; the choke point refuses with the correct verb and the next strategy run proposes a
  cover.
- **Sibling inference is conservative.**  A false positive only means the app leaves an order
  alone (no stale alert, no auto cancel-replace).  It never adds an action.
- **Booking.**  The chokepoint reshape is the backstop; the lanes normalize upstream so the
  booked side/quantity matches what is placed.  A choke-point clamp of a lane's quantity is
  audited; the broker fill reconciler books the real fill.
- **Not changed:** open sell orders that reserve shares (`held_for_orders`) are still the
  broker's to refuse (Alpaca 403) — that path cannot open a short.

## 4. Verification State

See the PR body for the exact gate tails.  Commands (Node 24):

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npx vitest run test/order-position-invariant.test.ts test/pg-short-replay.test.ts \
  test/alpaca-limit-stop-price-guard.test.ts test/tradier.test.ts \
  test/broker-order-constraints.test.ts test/stale-limit-orders.test.ts
npm run lint
npx tsc --noEmit
npm test
npm run build
```

## 5. Next Steps & Blockers

- Lead's adversarial money-path review before auto-merge (this lane does not arm it).
- After deploy, watch for `order_position_invariant_refused` / `order_position_read_failed` in the
  audit log; a burst of read failures on Alpaca would mean exits are failing closed and the read
  budget needs attention.
- Optional follow-up: surface choke-point reshapes on the ExecutedOrder so lanes can book the
  reshaped quantity directly instead of relying on the fill reconciler.

## 6. Zero-Code Findings

- Current `main` already skipped `held` legs and bracket-class legs in the auto path, and the
  replacement state machine already re-verified the backing position before placing — the PG
  path as it ran on 2026-07-08 predates those guards (#2882 and later).  The gaps this lane closes
  are the class-less leg, activation-age guessing, and — most importantly — the absence of any
  position check at the single placement choke point for every OTHER lane.
- Alpaca's notional (dollar) sell converts dollars to shares on the broker side; that conversion,
  not the app's, produced the VZ 0.027910851 request.

## 7. Review Round (2026-09-25)

PR #3759 merged to `main` while an independent review was in flight, so the fixes below land as a
follow-up PR from the same branch name (`claude/st-order-correctness`, re-created from the merged
head plus `origin/main`; no force-push).  Each finding was verified against the code first.

**Fixed.**

- **P1 (raised twice): a dollar-sized buy against a held short bypassed the cover reshape.**
  Confirmed: both passes gated the buy -> cover rewrite on `quantity`, and
  `applyDeterministicSizing` (`strategy-risk.ts`) sets `quantity: undefined` +
  `dollarAmount: targetNotional` on every autopilot buy, so the default autopilot buy against a
  short reached the broker as a bracketed `buy` (Alpaca 422, Tradier needs `buy_to_cover`).  Both
  `applyPositionInvariant` and `normalizeExitSideForHeldPosition` now resolve the dollars against
  the short's own per-share value (`|marketValue| / shares`): within 2% of the short -> the full
  short; below it -> that many whole shares (floored; an equity short is always whole shares);
  larger than the short, sub-share, or unpriceable -> unchanged, exactly like a quantity buy above
  the short.  Receipt `dollar_exit_resolved_to_quantity` records the resolution.
- **P2: autopilot flipped an LLM `sell` of a held short into a buy on shorting-enabled venues,
  kept its limit, and grew a dollar sell into a full cover.**  Confirmed.  The sell -> cover flip
  now requires `convertSellToCover: true` (default is now false), and the autopilot passes it only
  on a LONG-ONLY venue (`deriveVenueContract(runPolicy, activeAccount)` has no `short`), where a
  short can only be unintended and `sell` can only mean "exit".  Only a MARKET sell flips (a
  sell's limit/stop is on the wrong side of the market for a buy-to-cover; a stray price field is
  stripped); a dollar sell covers that many whole shares (the whole short only when the dollars
  reach it, within 2%).  On a
  shorting-enabled venue the sell is left for policy (`Sell quantity exceeds`) and the choke point
  (`sell_against_short`) to refuse with the correct verb.
- **P2: the long-only prompt named `cover` but the strict schema enum and the repair filter
  forbade it.**  Confirmed (`venue-contract.ts` sides `["buy","sell"]` -> `side: { enum }` and
  `filterRepairedProposals`).  New `proposalSidesForHeldPositions` adds `cover` to a long-only
  enum only while the account holds a short (policy already permits a risk-reducing cover);
  shorting venues and parked venues are unchanged.  The prompt now also says cover is offered only
  while such a short is held; prompt `agentic-strategy@2.19.1`.
- **P2: a transient position-read failure booked an approved or protective exit as terminal
  `blocked`.**  Confirmed.  `position_unverified` is now retryable: both lanes check
  `isRetryablePositionInvariantError` before the `OrderValidationError` branch and book
  `not_placed` (audit `order_not_placed_position_unverified`, "safe to retry" notification).  The
  approval lane passes the position it read at the start of `executeProposal` (same call, under
  the strategy lock, seconds earlier) as `verifiedPositionQuantity` for sell/cover, so a read blip
  no longer refuses an owner-approved exit.  The refusal text no longer promises a retry that the
  approval lane never made.

**Declined.**

- **P2: an oversized sell on a shorting-enabled account clamps instead of flipping long -> short.**
  The premise is wrong: Alpaca does not reverse a position in one order (a sell above the held
  long is refused "insufficient qty available"; the reversal takes a close then a separate
  short), Tradier's `sell` verb only closes a long (`sell_short` opens one), and Robinhood cannot
  short.  So before #3759 the oversized sell never flipped either; it was refused.  The app's
  vocabulary opens a short with side `short`, and the clamp is audited
  (`order_position_invariant_reshaped` / `quantity_clamped_to_position`) while the broker's order
  echo in `ExecutedOrder.raw` carries the placed quantity.
- **Autopilot position hint from `workingPositions`.**  Part of the P2 read-failure fix proposed
  passing `workingPositions` as the hint for proactive exits.  Not done: that snapshot is read at
  run start, minutes before placement (LLM latency), which is exactly the cached-snapshot hazard the
  fresh read exists to close.  The autopilot instead books the refusal `not_placed`, and the next
  run re-proposes against a fresh read.

**Files touched (review round):** `src/lib/order-position-invariant.ts`, `src/lib/strategy.ts`,
`src/lib/strategy-execution.ts`, `src/lib/strategy-prompts.ts`,
`test/order-position-invariant.test.ts`, `test/order-position-invariant-lanes.test.ts` (new),
`test/strategy-prompt-safety.test.ts`, `STATUS.md`, `docs/EFFORT-LOG.md`, this note.

**Verification (review round, Node 24, load average ~300):**

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npx vitest run test/order-position-invariant.test.ts test/order-position-invariant-lanes.test.ts \
  test/pg-short-replay.test.ts test/strategy-prompt-safety.test.ts test/venue-contract.test.ts
npx tsc --noEmit
npm run lint
```

Results: `tsc` exit 0; `lint` 0 errors (836 existing warnings, none in the touched files); the six
targeted vitest files (the five above plus `test/run-strategy-offline.test.ts`) passed 75/75.
Test-first check: the new unit tests run against the #3759 module gave 10 failed and 29 passed
(the one new case passing there, "oversized or sub-share dollar buy stays unchanged", is behavior
the old code already had).  Full `npm test` + `npm run build` are the required `verify` CI
check.  Follow-up PR: #3792 (hold label `do-not-automerge`; the repo's auto-merge workflow
armed it at creation and it was disabled again).
