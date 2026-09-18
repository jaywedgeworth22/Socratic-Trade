# Post-cancel protective-stop bookkeeping after the #3383 busy_timeout drop

## Context & Objective

`#3383` fixed the ST production event-loop stalls by dropping the serving `better-sqlite3`
`busy_timeout` from 60000ms to `SQLITE_BUSY_PIN_MS` (100ms), so a contended writer can no longer
sleep the Node event loop.  That fix is correct and is live.

It has a second-order cost, though: a synchronous SQLite write that used to **wait** up to 60s now
**throws** after 100ms.  `#3386` already had to repair one instance of that in `synthetic-stops.ts`
("post-claim fire writes"), where an unwrapped `SQLITE_BUSY` left a stop `triggered` with no
`last_attempt_ref_id` and the 15-minute re-arm grace left the position naked.

This note records the same class found in `broker-protective-stops.ts`, which neither `#3383` nor
`#3386` converted, and fixes the sites where the consequence is broker/DB state divergence.

## Changes Made

`cancelBrokerProtectiveStop` previously ran the post-cancel bookkeeping write **inside the same
`try` as the broker call**:

```ts
try {
  await gateway.cancelEquityOrder(accountNumber, row.brokerOrderId);
  deleteBrokerProtectiveStop(row.id, userId);          // unwrapped sync sqlite write
} catch (err) {
  audit("broker_protective_stop_cancel_error", ...);   // mislabels a SUCCESSFUL cancel
  upsertBrokerProtectiveStop({ ...row, status: "pending_cancel" });
}
```

So a `SQLITE_BUSY` on the delete — now reachable after only 100ms — was caught by the broker's
catch, which (a) audited a cancel that **did** succeed as `broker_protective_stop_cancel_error`,
and (b) re-persisted the row as `pending_cancel` for an order that no longer exists at the broker.
The next tick can only resolve that row by 404ing its cancel, which the file's own comments call
out as the "stuck pending_cancel" failure mode.

The fix keeps only the **broker call** inside that `try`, and routes bookkeeping through a new
`settleCancelBookkeeping` helper that uses `sqliteYieldRetry` (restoring the full 60s lock budget
via yields, so the loop stays free for `/api/health`).

- `src/lib/broker-protective-stops.ts` — import `sqliteYieldRetry`; add `settleCancelBookkeeping`;
  split the broker call from bookkeeping at both cancel sites in `cancelBrokerProtectiveStop`
  (the real-ref `pending_replace` branch and the ordinary resting-stop branch); yield-retry the two
  marker deletes in the same function.
- `test/broker-protective-stops-sqlite-busy.test.ts` (new) — two regression cases.

## Decisions & Trade-offs

- **Scoped deliberately to `cancelBrokerProtectiveStop`, not the whole file.**  There are roughly
  55 synchronous protective-stop write call sites in `broker-protective-stops.ts`.  Converting all
  of them mechanically would be a very large diff across dense, heavily-reviewed money-path
  invariants (many carry "Codex review, PR #1331/#1738 round N" provenance), and a sweeping rewrite
  is harder to review, not easier.  This PR fixes the sites where a busy write causes **broker/DB
  divergence after a real broker side effect**.  The remaining inventory is listed under Next Steps
  so it is not lost.
- **Two of those call sites must NOT be wrapped** — `broker-protective-stops.ts:486` and `:496` run
  *inside* the `getDb().transaction(...)` bodies of `deleteAndBookBrokerStopFill` /
  `deleteIntentAndBookStopFill`.  Wrapping a statement inside a sync transaction in an async
  yield-retry would break atomicity.  The correct conversion for those is to yield-retry the
  transaction as a whole at its call sites, which is what `synthetic-stops.ts` does.
- **A failed bookkeeping write is now audited as what it is.**  New event
  `broker_protective_stop_bookkeeping_error`, distinct from `broker_protective_stop_cancel_error`,
  so the two stop being conflated in the audit log.
- **On an exhausted budget the row is left untouched** rather than flipped to `pending_cancel`.
  Leaving it is recoverable: the reconcile loop already handles "tracked order gone at the broker".
  Flipping it to `pending_cancel` is what manufactured the stuck-row retry against a dead order.
- **Error propagation is unchanged in practice.**  The only caller
  (`synthetic-stops.ts:1055`) already wraps the call in `.catch(() => {})`, so the helper swallows
  and audits rather than throwing — a bookkeeping failure stays visible in the audit log instead of
  vanishing into that catch.

## Verification State

- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` — no errors in
  `src/lib/broker-protective-stops.ts`.  (Other output in this worktree is missing `@types` from a
  borrowed `node_modules`; the hosted `verify` gate does a real install.)
- `node node_modules/vitest/vitest.mjs run test/broker-protective-stops.test.ts test/broker-protective-stops-sqlite-busy.test.ts test/synthetic-stops.test.ts test/sqlite-event-loop-stall.test.ts test/protective-exit-routing.test.ts --testTimeout=20000` — **203/203 passed**.
- **Failing-first proven**: with `src/lib/broker-protective-stops.ts` stashed back to `origin/main`
  and the new test file kept, both new cases FAIL (2/2).  They pass only with the fix applied.

## Next Steps & Blockers

- **This PR must not auto-merge.**  It touches protective-stop cancel bookkeeping on the money
  path; per the sweep guardrail it wants a human read before merge.
- Remaining unconverted sync writes in `broker-protective-stops.ts` (post-`#3383`), for a
  follow-up: the `kind === null` disabled-teardown loop (~line 549-598, including the atomic
  `deleteAndBookBrokerStopFill`), and the reconcile sections near lines 737-786, 848-917, 947-970,
  1062-1114, 1157-1169, 1253-1265, 1385-1436, 1553-1580.  The two in-transaction sites (486, 496)
  need the call-site treatment described above, not a direct wrap.
- Worth watching after deploy: NEW `broker_protective_stop_bookkeeping_error` audit rows would mean
  the 60s yield budget is genuinely being exhausted, which would point back at lock contention
  rather than at this fix.

## Zero-Code Findings

Verified while investigating board `e7b49943` (22 recorded RTH hangs): every one of those hang
reports predates the actual root-cause fix.  `#3383` (`2fc699c32`) merged 2026-09-17 19:57Z, about
2h45m AFTER the 22nd and last recurrence at 17:13Z; `#3386` (`7bc03cb67`) merged 20:35Z.  Both are
ancestors of live sha `16fb6f39`.  Today's production restart at 11:01:42Z was the **deploy** of
`#3319` (committed 10:52:46Z), not a hang, and uptime climbed normally across repeated probes.  The
open work on that row is therefore the watch `#3383`'s own rollout note asks for — one full RTH with
zero `event_loop_stall` attribution — not further restarts.  Recorded on the board row rather than
reclaiming it, since BF-FIXER is the live owner there.
