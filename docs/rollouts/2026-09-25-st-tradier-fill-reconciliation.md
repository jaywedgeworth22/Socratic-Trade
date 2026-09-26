# 2026-09-25 — Tradier Fill Reconciliation (Lane G1, board 687a5fb4)

Seat: CLAUDE.  Branch: `claude/st-tradier-fill-reconciliation`.  Worktree:
`~/apps/claude-st-tradier-fill-reconciliation`.  PR carries `do-not-automerge`.

## Context & Objective

The Tradier Sandbox account (paper, connected account `becad9f1-...`) had 40 proposals stuck at
"placed" (2026-07-22 to 08-14, Tradier numeric ids such as `35740897`) with only 1 "filled",
17 receipts stuck at `pending_reconciliation` (17 `fill_reconciliation_stalled` audits, last
2026-08-14), and realized P&L plus closed lots reading $0 / 0 — while about $64K of Aug 5 buys
and about $20.8K of broker-side exits actually traded (latest equity $99,259.63 with nine open
positions).  Every scorecard in the 2026-09-25 performance report missed it.  The objective: make
proposal status and `fill_events` converge with Tradier's broker truth, book broker-originated
executions no lane owns, backfill the history safely, and not regress Alpaca or Robinhood.

## Root Cause

1. **The order listing is current-session only.**  Tradier documents
   `GET /accounts/{id}/orders` as "current market session orders".  `reconcilePendingFills`
   could only match a receipt against that listing (`brokerOrders.find(id)`), and the gateway
   interface had no per-order lookup, so a receipt that did not reconcile inside its own session
   (account halted, tick missed, order expired at the close) could never match again.  It was
   classified `order_absent_from_listing`, escalated once, and stayed pending forever.  The
   24-hour terminal-order window added on 2026-08-24 (#3093) narrowed this further for Alpaca-style
   callers but was not the Tradier root cause.
2. **Bracket entries are stored under the CONTAINER id.**  `placeEquityOrder` returns the OTO/OTOCO
   container id and the receipt stores it.  Before #3230 (2026-09-13) the listing dropped every
   container, and since then it keeps one only when it carries a top-level `symbol` plus `side` or
   `tag`; either way the container's own state and execution fields need not be the entry leg's.
   The Aug 5 bracket buys therefore never matched.
3. **Nobody books broker-held bracket exits.**  The take-profit and stop legs of a bracket are
   untagged broker-held orders with their own ids.  No app lane (placement, cancel-and-replace,
   protective stops, synthetic stops) books them, so exits that fired while the account was halted
   never reached `fill_events`.
4. **Cancel-and-replace read as a broker rejection.**  `order-replacement.ts` cancels a stale limit
   order and books the market replacement as a proposal-less fill.  The original receipt then
   reads "canceled", so the proposal would flip to `rejected_by_broker` even though its intent
   executed (and the replacement fill carried no proposal attribution).

Not a cause: id format (both sides use `String(o.id)`), status mapping (`filled`,
`partially_filled`, `expired`, `canceled`, `rejected`, `error` are all classified), account or
environment mismatch (the venue is derived from the connected account's environment), and paging
(the listing already walks up to 50 raw pages).

## Changes Made

- **`BrokerGateway.getEquityOrder` (optional) + Tradier implementation.**
  `GET /accounts/{acct}/orders/{id}?includeTags=true`.  Resolves `undefined` only on a definitive
  not-found (HTTP 404 or an order-not-found envelope); any transport or server failure throws.
  Ids that are not plain alphanumerics are never interpolated into the path.
- **Bracket-aware mapping (`tradierBracketParts`, `tradierOrderLookupFromRow`).**  Handles both
  response shapes in circulation: leg-entry (leg 0 opens, the rest close, leg count matches the
  class) and container-entry (the container is the entry, legs are exits only).  The lookup view
  carries the entry's state and execution under the container's id and tag, plus `entryLegId` and
  the exit legs.
- **`BrokerGateway.listRecentExecutions` (optional) + Tradier implementation
  (`executionsFromTradierRow`).**  The listing with bracket roles kept (`single`, `entry`, `exit`,
  parent id and parent tag).  Rows with an unrecognized side word are dropped instead of defaulting
  to "buy".
- **`reconcilePendingFills` (strategy-execution.ts).**  A receipt whose order is absent from the
  listing, or still reads as working (or final without a price) after 5 minutes, is looked up by
  id — budgeted (12 lookups per pass by default) and throttled per order (10 minutes after found,
  30 after not-found, 5 after an error).  A found lookup replaces the listing row and books any
  executed exit legs.  A canceled receipt that the app's own cancel-and-replace superseded is marked
  canceled with `replacedBy`, its replacement fill is linked to the proposal (`proposal_id` plus
  `raw.proposal` when absent), and the proposal flips to "filled" once the replacement executed.
  Gateways without `getEquityOrder` (Alpaca, Robinhood, the rest) keep the exact listing-only
  behavior.  New optional 5th argument: `{ lookupBudget, ignoreThrottle, summary }`.
- **New `src/lib/fill-reconciliation.ts` — sweeps run after every reconcile pass:**
  - *Bracket exit legs:* booked opening fills placed as a bracket (`raw.proposal.bracketStopLoss`
    or `bracketTakeProfit`) and not yet settled are looked up (every 30 minutes each) and each
    executed exit leg is booked; the entry is marked `raw.bracketLegs.settled` once every exit leg
    is final (or after 3 not-found answers).
  - *Listing ingestion (every 5 minutes per account):* executed, final orders no lane owns are
    booked as broker-originated fills (`raw.brokerOriginated: true`, no proposal): untagged owner
    orders and every bracket exit leg.  App-tagged orders and app bracket entries are skipped
    (their lanes book them), and an execution younger than 2 minutes waits a pass so a lane's own
    receipt always exists first.
  - *Proposal convergence (every 10 minutes per account):* a "placed" proposal whose receipt is
    already final flips to it with no broker call; one whose receipts were all canceled by a
    replacement is linked and flipped; one with no receipt at all is looked up and gets its receipt
    from broker truth (or a pending receipt when the order is still working).
- **Dedupe:** every broker-originated booking and backfilled receipt checks for ANY fill in the
  account carrying that broker order id inside one IMMEDIATE transaction before inserting.  No
  schema migration (open lane #3752 claims the next migration number).
- **Ops backfill route `/api/ops/fill-reconcile`** (`OPS_DIAGNOSTIC_TOKEN`).  `GET ?account=<id>`
  previews counts with no broker calls; `POST ?account=<id>&budget=<n>` runs one pass with up to
  `n` lookups (default 100, max 500) and no throttles, returning before/after counts and a summary.
  The response never carries the broker account number.

Files touched:

- `src/lib/types.ts` — `getEquityOrder?`, `listRecentExecutions?`, `BrokerOrderLookup`, `BrokerExecution`.
- `src/lib/tradier.ts` — raw page walker (`fetchRawOrderRows`, `getEquityOrders` behavior unchanged), `getEquityOrder`, `listRecentExecutions`, bracket helpers.
- `src/lib/strategy-execution.ts` — lookup in `reconcilePendingFills`, replacement linkage, sweeps.
- `src/lib/fill-reconciliation.ts` — new.
- `src/lib/ops-fill-reconcile.ts` — new.
- `src/lib/db-fills.ts` — `findFillEventByBrokerOrderId`, `listBracketOpeningFillsAwaitingLegs`.
- `app/api/ops/fill-reconcile/route.ts` — new.
- `test/tradier-fill-reconciliation.test.ts`, `test/tradier-order-lookup.test.ts`, `test/ops-fill-reconcile.test.ts` — new.
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note.

## Decisions & Trade-offs

- **Lookup, not position inference.**  The existing rule stands: an absent order never flips on
  position arithmetic.  It flips only on the broker's own report for that id.
- **Budget and throttles over a one-shot boot job.**  The backlog drains automatically after deploy
  at 12 lookups per tick (a few minutes for the sandbox's ~40 rows plus bracket fills) without a
  burst against Tradier's rate limit; the ops route drains it immediately with a report.
- **Owner orders now count.**  Untagged executions seen in a Tradier listing are booked, so an
  owner's manual sell closes the app's lot and realized P&L includes it.  A sale of a pre-app
  holding lands as an unmatched close (already disclosed, excluded from realized P&L).
- **Tradier only for lookup and ingestion.**  Alpaca's per-order endpoint exists, but Alpaca already
  reconciles through its listing and trade stream; adding it is a follow-up, not a need.
- **No experience-memory write for broker-originated closes** (no closing proposal).  Proposal-linked
  replacements do get `raw.proposal`, so their normal reconcile path fires it.
- **Response shapes are unverified against a live multi-leg account** (same caveat as the existing
  code).  Both known shapes are handled, and a booking always needs a priced execution on the row
  itself, so a misread shape can at worst leave something unbooked, not invent a fill.

## Verification State

Node 24 (`export PATH=/opt/homebrew/opt/node@24/bin:$PATH`).  Mac load average was very high, so the
full suite and build were left to the required `verify` CI check.

```
npx tsc --noEmit -p .                                                    # clean
npx eslint <changed files>                                               # clean
npx vitest run test/tradier-fill-reconciliation.test.ts test/tradier-order-lookup.test.ts   # 19 passed
npx vitest run test/ops-fill-reconcile.test.ts                           # 2 passed
npx vitest run test/pending-fill-reconcile-refire.test.ts test/reconciliation-risk.test.ts test/tradier.test.ts   # 117 passed
npx vitest run test/synthetic-stops.test.ts test/order-replacement.test.ts test/placement-reconcile-sweep.test.ts test/placement-reconcile.test.ts test/scheduler-tick-reentrancy.test.ts test/set-active-connected-account-draining.test.ts test/stale-limit-orders.test.ts test/broker-protective-stops.test.ts   # 212 passed
```

Test-first check: with `src/lib/strategy-execution.ts` reverted to `origin/main`, 10 of the 12
reconciliation tests fail; the 2 that pass are the no-regression guards (a lookup outage never
flips anything; a gateway without `getEquityOrder` keeps listing-only behavior).

## Next Steps & Blockers

1. After deploy, preview then drain the sandbox:
   `GET /api/ops/fill-reconcile?account=becad9f1-c80e-4d31-abc9-2d57152e519c` (with `x-ops-token`),
   then `POST ...&budget=200`, then compare `GET /api/ops/performance` realized P&L and closed lots.
   A high `lookupNotFound` count would mean Tradier's per-order endpoint does not serve old sandbox
   orders; those receipts then stay pending and escalated as before (nothing is invented).
2. Follow-up (not in this PR): `flagStalePlacingIntents` treats Tradier's listing as authoritative
   (`ordersListIncludesTerminal`) and abandons a stale "placing" intent absent from it.  Across a
   session boundary that absence is not proof.  Worth scoping the flag to same-session intents.
3. Optional: implement `getEquityOrder` for Alpaca (`GET /v2/orders/{id}`) so a GTC order that fills
   after the 24-hour terminal window also reconciles there.
4. Tradier live has an account-history endpoint (not available in sandbox) that could cover owner
   trades from past sessions; not used here.

## Zero-Code Findings

Tradier docs checked on 2026-09-25: the orders listing is current-session only; the single-order
endpoint returns 404 for an unknown id; account history is live-only ("sandbox history not
available").
