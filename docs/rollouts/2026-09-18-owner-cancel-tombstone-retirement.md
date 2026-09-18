# Owner-cancel tombstone must not outlive the position it was written for

**Date:** 2026-09-18  ·  **Seat:** CLAUDE  ·  **Area:** money path (protective stops)

## What was wrong

`recordOwnerCancelledProtectiveStop` (`src/lib/order-provenance.ts`) writes a permanent
tombstone when the owner manually cancels an app-managed protective stop for a symbol.  The
reconciler reads it at `src/lib/broker-protective-stops.ts` and skips placing a protective stop
for that symbol, auditing "not re-placing until policy changes".

Nothing ever cleared it.  Before this change the repo contained exactly two references to the
tombstone key — the writer and the reader — and no delete path of any kind.  The audit line's
"until policy changes" was never implemented.

So the tombstone outlived the position it described.  Owner cancels AAPL's stop, later sells
AAPL, later buys AAPL again: that new position was never un-protected by anyone, but the
reconciler still refuses to arm a stop for it, forever, leaving it naked with only an audit line
to explain why.

## The fix

Retire the tombstone when its position is flat.  The reconciler now sweeps the tombstones for
the user + account at the top of a reconcile pass and clears any whose symbol is no longer held,
auditing `owner_cancelled_protective_stop_cleared`.

Two things make the sweep safe:

- **A flat symbol is positive evidence, not a failed read.**  The only caller
  (`src/lib/synthetic-stops.ts:250-255`) returns early when `getEquityPositions` throws, so
  reaching the reconciler means the snapshot came back successfully.
- **Flatness is read off the raw `positions` array, not `livePositions`.**  `livePositions`
  omits shorts when the account has `brokerStopsForShortsEnabled` off, so an open short would
  otherwise look flat and silently lose its tombstone.

A tombstone whose position is still open is untouched — the owner's decision stands for as long
as the position they made it about.

## Not to be confused with

The Seer HIGH finding on PR #3319 (manual replacement permanently blocked) is a *different*
site and is already fixed on main: `src/lib/order-replacement.ts:368-370` lets an explicit
manual replace (`allowOwnerPlaced === true`, set unconditionally by
`replaceStaleLimitOrderWithMarket` at `:108`) bypass `owner_cancelled_stop`, with a regression
test at `test/order-replacement.test.ts:68`.  That bypass fixed the replacement path and left
the placement path in `broker-protective-stops.ts` untouched — which is what this change
repairs.

## Verification

`test/order-provenance-guard.test.ts`:

- "retires the owner-cancel tombstone once the position is flat, so a re-entry is protected
  again" — fails before the fix at the first assertion, because no clear path existed.
- "keeps the owner-cancel tombstone while the un-protected position is still open" — guards the
  other direction.

## Merge gate

Money path.  Auto-merge is deliberately NOT armed.  A human merges this.
