# 2026-09-01 — Money-path orders: MCP write idempotency, Alpaca `stop` wire, provenance

## Context & Objective

Owner 2026-09-01: thoroughly fix Socratic-Trade trading and order issues.  Cursor's 2026-08-23 review filed three live-order bugs (#3152 / boards efd2a783, ef0dccb3, d4cb5e75, d36c2233).  No live order placement from this Mac.

## Changes Made

Three money-path fixes in one PR on `grok/money-path-orders`.

1. **P0 — MCP timeout no longer double-submits.**  `callMcp` used to REST-fallback on any failure, including the 8s abort.  Writes (`place_*`, `cancel_order`) now REST-fallback only on definite tool-not-found / 4xx-before-send.  Timeouts, aborts, 5xx, 409/429, and network errors reconcile by `client_order_id` (place) or order id (cancel) and throw `AlpacaMcpWriteAmbiguousError` instead of sending again.  Reads still REST-fallback.

2. **P0 — Alpaca wire type `stop`.**  REST and MCP writes map our union `stop_market` to Alpaca `stop`.  `stop_limit` is unchanged.  Read-back still maps Alpaca `stop` to `stop_market`.

3. **P1 — owner GTC UUIDs are not app-placed.**  `isAppPlacedBrokerOrder` no longer treats any nonempty `clientOrderId` as ours.  App-placed requires prefix `protstop-` / `sstop-` or a tracked row (`trade_proposals.ref_id`, stop placement intent, synthetic-stop last attempt, replacement ref, protective-stop broker id).  Auto-remediation skips the rest.  Manual replace still allows owner-placed orders (`allowOwnerPlaced`).

Touched files:

- `src/lib/alpaca.ts`
- `src/lib/order-provenance.ts`
- `src/lib/order-replacement.ts`
- `test/alpaca-mcp.test.ts`
- `test/alpaca-limit-stop-price-guard.test.ts`
- `test/alpaca-order-mapping.test.ts`
- `test/order-provenance.test.ts`
- `test/order-provenance-guard.test.ts`
- `test/order-replacement.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-09-01-money-path-orders.md`

## Decisions & Trade-offs

- Fail closed on ambiguous MCP writes: missing reconcile does not REST-place.  The existing placement-intent / `refId` sweep recovers a live order, or retries when the broker list is authoritative and empty.
- Cancel after an ambiguous MCP timeout reconciles first.  Already-canceled/filled (or 404) is treated as success so we do not hammer `cancelOrder`.  Still-live cancels are not REST-retried from `callMcp` itself; the caller can retry the same id.
- Strategy entries still mint UUID `refId`s.  Those stay app-placed via the `trade_proposals.ref_id` row, not a new prefix (prefixing every proposal is a follow-up, not required to stop owner-GTC cancel-replace).
- Manual `replaceStaleLimitOrderWithMarket` sets `allowOwnerPlaced` so the owner can still cancel-replace their own GTC from the UI.  Auto-remediation does not.

## Verification State

Node v24.20.0 (`/opt/homebrew/opt/node@24/bin`).

Targeted:

```
npx vitest run test/alpaca-order-mapping.test.ts test/alpaca-limit-stop-price-guard.test.ts \
  test/alpaca-mcp.test.ts test/order-provenance.test.ts test/order-provenance-guard.test.ts \
  test/order-replacement.test.ts test/alpaca-brackets.test.ts test/alpaca-tif-normalization.test.ts
```

101 passed / 8 files.

Full gate via `PATH=/opt/homebrew/opt/node@24/bin:$PATH bash scripts/land.sh`.

No live orders.  No Coolify bounce.

## Next Steps & Blockers

- Land PR, auto-merge, weekday RTH latch may defer the image until after the cash close.
- Optional follow-up: mint strategy `refId`s with a dedicated prefix so provenance does not depend on a proposal row surviving.
- Optional follow-up: recover any protective stops that 422'd on `type=stop_market` and are still missing at the broker (reconcile existing rejected attempts; do not place from this Mac).

## Zero-Code Findings

None.  All three bugs were code defects with tests pinning the old behavior.
