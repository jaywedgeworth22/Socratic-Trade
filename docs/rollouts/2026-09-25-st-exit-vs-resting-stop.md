# 2026-09-25 — Approved Exits Release The App's Own Resting Protective Stop (Lane G2)

Seat CLAUDE, board `687a5fb4` (umbrella), branch `claude/st-exit-vs-resting-stop`, worktree
`~/apps/claude-st-exit-vs-resting-stop`.  PR held with the `do-not-automerge` label.

## Context & Objective

The trading-performance analysis (2026-09-24) found that about 62 of Alpaca Paper's 115 blocked
proposals in 120 days were discretionary exits blocked by `evaluateBrokerHeldExitAvailability`:
the app's own resting GTC protective stops (`broker_protective_stops` — BAC 24, KO 14, PYPL 30,
BRK-B 2 on 2026-09-24) reserved the whole position at the broker (`held_for_orders`), so the
available quantity was 0 and those positions could only ever leave through the stop.  The
objective: an approved exit (autopilot or human-approved; a sell of a long or a cover of a short)
that needs shares held only by the app's OWN stop cancels that stop, places the exit, and
re-places a stop for anything left, without ever touching owner or external orders and without
leaving a position unprotected silently.

## Changes Made

**Planner (`planExitStopRelease`).**  Runs where the old block ran (autopilot loop in
`strategy.ts`, approval path in `strategy-execution.ts`).  A held exit is releasable only when
every share it needs is held by orders that (a) are tracked by a `broker_protective_stops` row with
the same broker order id, (b) `isAppPlacedBrokerOrder` says the app placed, (c) are not a
bracket/OCO leg (`isContingentOrderLeg`, broker evidence only), and (d) are not mid-fill
(`partially_filled`).  Anything else holding needed shares keeps the old block.  With the toggle
off the old block stands and the reason now points at the toggle.

**Release sequence (`placeExitReleasingOwnStops`).**  Wraps the single `placeEquityOrder` call in
both lanes, so it runs inside the account placement lease, after the fresh system-state fence:

1. Re-plan from a fresh broker position + order read (the pre-lease plan can be minutes old; the
   reconciler may have cancel-replaced the stop, or the owner may have placed an order).  Nothing
   holding now means a plain placement; an owner/external holder means blocked, nothing cancelled.
2. Persist a durable intent (`exit_stop_release:<user>:<account>:<SYMBOL>` in `settings`, phase
   `releasing`), cancel each stop, and poll with the stale-exit replacement's multi-poll settle
   helper (`pollCancelSettlement`, now exported: 2 s interval, 10 s ceiling).
3. Per stop: `cancelled` (row deleted), `filled` (row deleted and the fill booked atomically with
   the broker-held stop marker, idempotent on replay), `still_active` / `unknown` (row kept; the
   exit aborts and the stop stays in charge).
4. Re-read the position.  Zero left means the stop closed it during the race: the exit is moot and
   never sent.  Otherwise re-check that nothing else holds the shares, mark the intent `released`,
   and place the exit with `verifiedPositionQuantity` set to the position just read.  The #3759
   invariant at the placement choke point still clamps a sell to the shares actually held.
5. Restore (always, in a `finally`): mark the intent `exit_submitted` and run the normal
   `reconcileBrokerProtectiveStops` with a fresh read (same inputs the stop-monitor tick builds).
   It is coverage-aware: a still-working exit order counts as coverage, so the stop comes back
   for the uncovered remainder now, and for the rest once the exit fills or dies.  Restore only
   runs while the lease is still owned; a lost lease hands it to the next protective-stop pass.

**Reconciler (`broker-protective-stops.ts`).**  The exported `reconcileBrokerProtectiveStops` is
now a thin wrapper over the unchanged core.  It loads intents that owe a restore (`exit_submitted`,
`restore_pending`, or `releasing`/`released` older than 90 s — an abandoned sequence), seeds the
tracked extreme from a released trailing stop so a replacement trail is never looser, lets a halted
account place those symbols like a right-size replacement (never looser than the released fixed
trigger), and after the pass resolves each intent: `position_closed`, `stop_in_place`,
`covered_by_live_exit_orders`, `no_broker_stop_configured`, or `synthetic_monitor_covers`.
Otherwise it stays `restore_pending` with a deduped `exit_stop_release_restore_pending` audit.
New `settleReleasedProtectiveStop` does the row-delete plus fill-booking pair.

**Owner toggle.**  `TradingPolicy.exitsReleaseAppStops` (default `true`), Guardrails ->
Protective stops, label "Exits release the app's own stop", validated in `app/api/policy`, and
accepted by the iOS `policy.patch` boolean list.

**Audit trail.**  `exit_stop_release_started`, `exit_stop_release_cancel_results`,
`exit_stop_released`, `exit_stop_release_moot`, `exit_stop_release_aborted`,
`exit_stop_release_restored`, `exit_stop_release_restore_pending`,
`exit_stop_release_restore_deferred`, `exit_stop_release_remainder_unprotected`,
`exit_stop_release_not_needed`, `exit_stop_release_replan_blocked`,
`exit_stop_release_replan_unavailable`, `exit_stop_release_restore_error`,
`exit_stop_release_bookkeeping_error`.  The blocked-exit audits now carry `appStopOrderIds`.

Files touched:

- `src/lib/exit-stop-release.ts` (new)
- `src/lib/exit-stop-release-intents.ts` (new)
- `src/lib/broker-protective-stops.ts`
- `src/lib/order-replacement.ts` (export `pollCancelSettlement` and its defaults)
- `src/lib/strategy.ts` (autopilot held-exit check and placement call)
- `src/lib/strategy-execution.ts` (approval held-exit check and placement call)
- `src/lib/types.ts`, `src/lib/defaults.ts`, `src/lib/mobile-api.ts`
- `app/api/policy/route.ts`, `app/console/guardrails/field-defs.ts`
- `test/exit-stop-release.test.ts` (new), `test/exit-stop-release-approval.test.ts` (new)
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note

## Decisions & Trade-offs

- **No schema migration.**  The intent lives in the key/value `settings` table (the owner-cancel
  tombstone pattern).  Open lane PR #3752 already takes migration 92; a second PR taking 93 and
  merging first would make prod skip 92 forever (`runMigrations` skips versions at or below
  `user_version`).
- **Cancel, not reduce.**  One protective stop exists per symbol; re-sizing it goes through
  cancel then re-place on every venue, so the sequence always cancels and the reconciler re-places
  the right size.  That keeps all sizing, trailing-extreme, halted and owner-tombstone rules in one
  place (the reconciler) instead of a second copy.
- **A working exit holds the shares.**  At Alpaca a resting sell limit for the whole position and a
  stop cannot both hold the same shares.  While a non-marketable exit rests, the position is
  protected by that exit order (and the stale-limit remediation), and the stop comes back when it
  fills or is cancelled.  The toggle hint says so.
- **Broker scope.**  Only Alpaca (REST native trailing and MCP) and opt-in live Robinhood rest app
  protective stops, so only they can release one.  Tradier, eToro, Public, Webull and Kalshi carry
  no `broker_protective_stops` rows: their held exits stay blocked exactly as before.  Robinhood's
  order list is not authoritative for terminal orders, so an accepted cancel whose order vanishes
  counts as cancelled and the fresh position read decides the exit size.
- **Bracket legs are out of scope.**  An Alpaca OCO bracket stop-loss leg is contingent; cancelling
  one leg cancels its sibling.  Those still block and are left alone.
- **Uncertain placements still restore.**  If the exit placement throws after the broker may have
  accepted it, the restore still runs (protection over dedup, the reconciler's standing doctrine).
  A duplicate stop is refused by Alpaca for insufficient quantity; the next pass settles it.
- **Halted accounts.**  Placement is blocked while halted, so the inline path never runs halted.
  A restart-recovered intent may still restore while halted because it restores existing
  protection, never new protection.

## Verification State

Commands (Node 24: `export PATH=/opt/homebrew/opt/node@24/bin:$PATH`), Mac load average 270-370:

```bash
npx tsc --noEmit -p tsconfig.json          # clean (no output)
npx vitest run test/exit-stop-release-approval.test.ts   # RED on origin/main's strategy-execution.ts:
#   2 failed | 1 passed — "Existing open sell order(s) already hold 24 of 24 BAC shares ... STOPBAC."
npx vitest run test/exit-stop-release.test.ts test/exit-stop-release-approval.test.ts \
  test/broker-protective-stops.test.ts test/broker-held-orders.test.ts    # 4 files, 99 passed
```

Final gate numbers for the last commit are in the PR body.  `npm run build` was not run locally
(no route or client/server boundary change; the required `verify` CI job runs the full suite and
the build).

## Next Steps & Blockers

- Review, then remove `do-not-automerge` and merge (a review stage owns that).
- After deploy, watch `exit_stop_release_*` audits on Alpaca Paper and the blocked-proposal count
  (`GET /api/ops/performance`); the 62-exit class should move from `blocked` to placed.
- If `exit_stop_release_restore_pending` shows up persistently for a symbol, check whether the
  reconciler is skipping it (trailing not armable, order list failing) — the synthetic monitor
  should be covering it.

## Zero-Code Findings

- Alpaca Paper's resting stops in the evidence are `broker_protective_stops` rows (fixed or native
  trailing), not bracket legs, so this lane covers the measured class.
- `evaluateBrokerHeldExitAvailability` is the only held-exit gate; it runs in exactly two places
  (autopilot loop and approval path), both of which now plan a release first.
