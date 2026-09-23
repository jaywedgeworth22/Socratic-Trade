# 2026-07-18 — Protective-stop placement intent + atomic recovered-fill booking (CLAUDE)

Branch: `claude/stop-intent-idempotency` (off `2aa53e15`, isolated worktree
`/Users/jay/Code/Socratic-Trade/.claude/worktrees/agent-aec1758ee2b7636e0`). Committed, NOT pushed
(per task instruction).

## Summary

Two money-path correctness fixes in the broker protective-stop reconciler (Codex findings, items
5 and 6 of the backlog batch):

1. **Item 5 — durable pre-network placement intent.** `reconcileBrokerProtectiveStops` section 4
   called `gateway.placeEquityOrder` with NO persisted state beforehand. If the broker accepted the
   order but the reply was lost (crash/timeout), the next tick had no record a request was ever
   sent and would place a SECOND full-size stop — two resting sell stops for the same shares, an
   over-sell if both fire. Now a durable intent row (new table `broker_stop_placement_intents`,
   keyed by the stable `client_order_id`/refId we submit) is written BEFORE the network call and
   deleted on every definite outcome (synchronous reject, no-order-id, success). A call that
   THROWS deliberately leaves the row; the next tick reconciles it against the caller's freshly
   fetched order list by `clientOrderId` and ADOPTS the already-accepted live order (recording its
   real order id, tracked/cancellable) instead of duplicating. Evidence rules: adopt on a live
   clientOrderId match; clear the intent only when a REAL fetch (`ordersListed`) shows no match;
   skip the symbol entirely when the order list is unavailable (ambiguous — never guess). This
   mirrors the approval-execution pattern (`claimProposalForExecution` status `placing` + refId +
   `flagStalePlacingIntents` broker-truth-first recovery in strategy-execution.ts/db-proposals.ts).

2. **Item 6 — atomic + idempotent recovered stop-fill booking.** Every recovery path that found a
   tracked broker stop order already executed did `deleteBrokerProtectiveStop(...)` THEN
   `bookBrokerHeldStopFill(...)` as two separate statements — a crash between them lost the fill
   forever (tracking gone, nothing left to signal a retry). All 8 delete+book sites now go through
   one `getDb().transaction(...)` wrapper (`deleteAndBookBrokerStopFill`) so both writes land
   together or not at all. Additionally, these recovered fills carry NO `proposalId`, so migration
   16's partial UNIQUE fill index (which requires `proposal_id NOT NULL`) never covered them — a
   replayed recovery could double-book. A new partial UNIQUE index now covers exactly this class,
   and `insertFillEvent` treats its violation as an idempotent no-op returning the already-booked
   fill (same contract as the migration-16 handler).

## Why the new fill index is scoped to `raw.brokerHeldProtectiveStop = 1`

The first cut indexed ALL proposal-less fills on (user_id, account_number, broker_order_id) and
broke a load-bearing test: `test/order-replacement.test.ts` "does not let another tenant/account
fill with the same broker order id suppress recovery". order-replacement.ts deliberately books
multiple proposal-less rows that can share the SAME broker_order_id within one (user, account) —
its idempotency key is `raw.replacementRefId`, because broker order ids are not assumed globally
unique there. The index is therefore a JSON-conditioned partial index scoped to the one writer
that needs it (`bookBrokerHeldStopFill` tags its inserts `brokerHeldProtectiveStop: true`), and
`insertFillEvent`'s catch handler checks the same marker before treating a violation as replay.

Final DDL (migration v54):

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_fill_events_no_proposal_broker_order
 ON fill_events (user_id, account_number, broker_order_id)
 WHERE proposal_id IS NULL AND broker_order_id IS NOT NULL
   AND json_extract(raw, '$.brokerHeldProtectiveStop') = 1
```

## Migration numbering (v53 / v54) — landing operator MUST re-verify

- `broker_stop_placement_intents` = **v53**; `fill_events_no_proposal_broker_order_unique_index`
  = **v54**.
- Basis at commit time: latest versioned migration on `origin/main` is **v51** (PR #1738 merged
  but added its `option_alert_reservations` table in the `migrate()` baseline, not as a versioned
  migration); open PR #1735 (armed to auto-merge) claims **v52** (SEC RAG table recovery).
- **The landing operator must re-verify numbering against `main` at merge time** — if another lane
  lands v53/v54 first, renumber before merging (grep `version:` in `src/lib/db.ts`).

## PR #1738 relationship (per task: no overlap with its hunks)

Read `gh pr diff 1738` in full before editing; it MERGED into `main` (`4e3694a5`) mid-task.
- Neither of my items was fixed there: #1738's adopt/ref-reuse logic covers only the
  HALTED-right-size retry lane (`pending_replace` markers, `persistHaltedRightSizeRetry`); the
  ordinary section-4 placement still had no pre-network intent. Its delete/book recovery paths
  remained two separate statements. So both items were still real on top of #1738.
- My edits were placed to avoid #1738's hunks (new helper after `bookBrokerHeldStopFill`, new CRUD
  appended to db-api-keys.ts, new migrations appended to the MIGRATIONS array). BUT since my
  branch forked from `2aa53e15` (pre-#1738), `broker-protective-stops.ts` and the shared test
  files WILL need a real merge at land time — section 4 in particular (its rewrite added
  `haltedProtectOnly` gating and its own marker-adoption block adjacent to where my intent check
  now sits). `scripts/land.sh` will refuse the auto-merge (both branches touched the same files);
  manual reconciliation is expected and correct here. Semantic note for the merger: my Item-5
  intent check and #1738's `pending_replace` adoption are complementary (different lanes, different
  storage) and should BOTH survive; my intent check sits right after the `pos.averageCost` guard,
  before coverage/qty computation, deliberately — an untracked accepted order would otherwise be
  miscounted as "other coverage" and short-circuit before adoption.

## Files

- `src/lib/db.ts` — migrations v53 (`broker_stop_placement_intents` table) + v54 (partial UNIQUE
  fill index, duplicate collapse first, same approach as migration 16).
- `src/lib/db-api-keys.ts` — `BrokerStopPlacementIntent` interface +
  `upsertBrokerStopPlacementIntent` / `getBrokerStopPlacementIntent` /
  `deleteBrokerStopPlacementIntent` (appended; the module that owns broker_protective_stops CRUD).
- `src/lib/db-fills.ts` — `insertFillEvent` catch handler: idempotent-replay fallback for the new
  index, gated on `!proposalId && brokerOrderId && raw.brokerHeldProtectiveStop === true`.
- `src/lib/broker-protective-stops.ts` — `deleteAndBookBrokerStopFill` transaction wrapper wired
  through all 8 recovery sites; section-4 intent persist/adopt/clear logic.
- `test/broker-protective-stops.test.ts` — 3 new regressions (see Verification).
- `test/fill-events-no-proposal-unique-index.test.ts` — NEW (9 cases incl. all four OrderSides).
- `docs/rollouts/2026-07-18-stop-intent-idempotency.md` — this note.

## Verification (exact commands)

- `npx tsc --noEmit` — clean (run repeatedly through development; final run after renumbering).
- `npx vitest run test/broker-protective-stops.test.ts test/fill-events-no-proposal-unique-index.test.ts
  test/fill-events-dedupe-index.test.ts test/synthetic-stops.test.ts test/broker-side.test.ts
  test/account-delete-cleanup.test.ts test/order-replacement.test.ts test/performance.test.ts`
  — final counts recorded in the commit message / handoff reply. The order-replacement
  tenant-suppression test FAILED against the first (too-broad) index draft and passes against the
  scoped one — that failure is what drove the `brokerHeldProtectiveStop` scoping.
- New regressions:
  - "Item 5: does not double-place when the broker accepts an order but the reply is lost —
    adopts it on a later tick instead" (throw-after-accept via a capturing TestBroker-style fake
    gateway; asserts exactly ONE broker placement call across both ticks + adoption of the real
    order id + intent cleared).
  - "Item 5: clears a confirmed-dead intent and places fresh" (real fetch shows no match → intent
    cleared, fresh placement, never stuck).
  - "Item 6: a recovered stop fill is booked exactly once even on a replayed recovery" (delete+book
    atomicity + unique-index replay no-op returning the original fill id).
  - fill-events-no-proposal-unique-index.test.ts (9 cases): replay idempotency for marker-tagged
    recovery fills, triple-key scoping, NULL broker_order_id unconstrained, UNMARKED proposal-less
    fills sharing a broker_order_id NOT constrained (locks in order-replacement's design),
    proposal-carrying rows unaffected, and per-side (buy/sell/short/cover) replay checks — the
    changed path is side-agnostic and behaves identically for all four.
- Full suite/build NOT run (explicit task instruction).

## Round 2 — manual merge of origin/main + adversarial MUST-FIX (2026-07-18, same day)

The adversarial verifier confirmed the lane (v54 partial-index risk ruled out; all transaction
sites atomic; complementary to merged #1738) with one demonstrated MUST-FIX, and origin/main
(`b4dd8a54`, includes #1735's v52 and #1738's section-1 marker-lane rework) required a manual
merge. Both done on this branch:

### Merge resolution (git could not auto-merge; resolved per the verifier's map)
- `db.ts` migration-array tail: main's **v52** (`sec_rag_tables_recovery`) kept first, then this
  branch's **v53/v54** — numbering confirmed correct, no renumber. Stale "v51 latest" comment
  updated.
- `broker-protective-stops.ts` section 4: **both mechanisms kept** — the placement-intent lane
  (this branch) and the halted `pending_replace` marker lane (#1738). The intent check stays
  BEFORE coverage/qty computation; main's `const priorRef = haltedRetryRefFor(sym)` kept; the
  client id composes as `refId = priorRef ?? fresh` and `upsertBrokerStopPlacementIntent` stores
  that possibly-reused ref (both lanes reconcile against the same id). Reject/no-id paths run BOTH
  `deleteBrokerStopPlacementIntent` AND `persistHaltedRightSizeRetry` (no ref — a rejected
  client-order-id must not be reused); the catch path audits, persists the marker WITH the ref,
  and leaves the intent row for next-tick reconciliation.

### MUST-FIX — intent order visible-but-TERMINAL with fills (demonstrated fill-loss + over-sell)
The intent lane handled adopt-if-LIVE and confirmed-dead-by-ABSENCE but not the third outcome:
the accepted order is visible in the fetched list and already terminal WITH executed quantity
(accepted after the crash, filled before the next tick — exactly when stops fill). Pre-fix it fell
into the confirm-dead lane: the fill was never booked and section 4 immediately re-placed a
full-size stop sized off the stale pre-fill snapshot. Fixed by mirroring the section-1 marker
lane's book-if-filled pattern: a new `deleteIntentAndBookStopFill` transaction (delete intent +
book the fill with the `brokerHeldProtectiveStop` marker, keyed by the REAL broker order id, in
one transaction) plus `filledRecoverySymbols` deferral so placement waits for a fresh position
read. Only a terminal order with ZERO executed quantity is confirmed dead and places fresh.

### 9th transaction site
Main's section-1 marker lane book-if-filled (its `bookBrokerHeldStopFill(row, matched)` +
`deleteBrokerProtectiveStop`) was the one remaining non-atomic delete/book pair after the merge —
now routed through `deleteAndBookBrokerStopFill` like the other 8.

### Round-2 verification
- `npx tsc --noEmit` — exit 0 on the merged tree.
- Same 8-suite vitest command — **8 files / 250 tests pass, 0 fail** (count grew from 227: main's
  new tests + 2 folded adversarial regressions).
- The verifier's adversarial test was folded into `test/broker-protective-stops.test.ts` as
  "Item 5+6: intent reconciliation when the accepted order already FILLED before the next tick"
  (both original assertions, original order: no stale-sized replacement this tick AND the fill
  booked exactly once) plus a companion "visible-but-terminal with ZERO executed quantity is
  confirmed dead" case. Both pass individually and in the full suite.

## Follow-ups / risks

- ~~Land-time merge with #1738's rewrite~~ — DONE in round 2 (see above); the branch now contains
  origin/main `b4dd8a54`.
- ~~Migration numbers v53/v54 depend on PR #1735 landing as v52~~ — RESOLVED: #1735's v52 is on
  main and merged into this branch; v53/v54 confirmed.
- `bookBrokerHeldStopFill` books `side: "sell"` unconditionally; the reconciler is long-only today
  (liveLongs filter), so buy/short/cover never reach it — the new index/handler are side-agnostic
  (verified by test) if shorts are ever added.
- The intent table is not yet wired into account-deletion sweeps (`DELETE_TABLES_BY_USER_ID`) —
  rows are keyed by user_id and self-clean on every definite outcome; at worst an orphaned row for
  a deleted account is inert (its symbol never appears in liveLongs). Flagged rather than done to
  keep this diff off account-deletion.ts, which #1738 also touched.
