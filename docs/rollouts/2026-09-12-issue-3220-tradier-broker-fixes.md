# Rollout: Fix Tradier Broker Gateway and Order Cancellations (Issue #3220)

## Context & Objective
Issue #3220 identified several critical bugs in the Tradier broker integration and order cancellation logic:
1. `equityRowsFromTradierOrder` dropped primary entry legs for multi-leg brackets, causing them to be falsely classified as `order_absent_from_listing`. Exit legs were also stamped with the entry leg's tag, causing false matches.
2. `TradierBrokerGateway` lacked `ordersListIncludesTerminal = true`, meaning terminal but recently filled orders were incorrectly categorized as `uncertain` during fallback reconciliation.
3. Tradier HTTP 200 validation envelopes (e.g. `HTTP 422 Unprocessable Entity`) bypassed terminal error classification in `isTerminalBrokerHttpError`.
4. `cancelBracketSiblingLegs` for Alpaca failed silently on MCP accounts.
5. Manual UI cancellations of exit legs didn't tear down sibling brackets (like SL), leaving users exposed to unintended triggers.

## Changes Made
- Modified `src/lib/tradier.ts` to implement a listing-specific mapper inside `getEquityOrders`. This correctly retains the container/entry leg for advanced bracket types while explicitly omitting `tag: o.tag` for the contingent exit legs.
- Added `readonly ordersListIncludesTerminal = true;` to `TradierBrokerGateway` in `src/lib/tradier.ts`.
- Prepend "Tradier HTTP 422: " to Tradier's HTTP 200 validation envelopes inside `this.request()` in `src/lib/tradier.ts`.
- Initialized a `hasRestKeys` boolean property in `AlpacaBrokerGateway` (`src/lib/alpaca.ts`) and added an early-return audit failure for MCP-only accounts attempting to cancel bracket sibling legs.
- Exported `enqueueTeardownForAllOpenBrackets` from `src/lib/db-api-keys.ts` and called it inside `cancelEquityOrder` in `src/lib/order-cancel.ts` whenever an order on a bracketed symbol is manually cancelled, alongside immediately dispatching `reconcilePendingBracketTeardowns` to tear down sibling legs.

- Touched files:
  - `src/lib/tradier.ts`
  - `src/lib/alpaca.ts`
  - `src/lib/db-api-keys.ts`
  - `src/lib/order-cancel.ts`

## Decisions & Trade-offs
- In `getEquityOrders`, rather than risk mutating the shared `equityRowsFromTradierOrder` contract used for live testing coverage, an inline mapper safely strips the `tag` property specifically for the orders-listing context where error reconciliation operates.
- For manual bracket cancellations, if the user manually cancels ANY order on a symbol that currently has open brackets, the backend conservatively queues teardown for all sibling bracket legs on that symbol. This solves the issue without overly complicating `cancelEquityOrder` to guess which leg is a take-profit/stop-loss.

## Verification State
Ran local gating commands:
- `npm run lint` - Passed
- `npx tsc --noEmit` - Passed
- `npm test` - Passed

## Next Steps
Merge to `main` and deploy to production, then continue sequentially down the task board starting with `#3221`.
