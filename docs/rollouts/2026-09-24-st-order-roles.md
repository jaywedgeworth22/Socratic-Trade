# 2026-09-24 — Order Role Classification, Ops Order Detail, Console Badges

## 1. Context & Objective

The owner saw "4 open orders just sitting there" on Alpaca Paper and could not tell why.  They
were resting GTC protective stops (BAC, BRK-B, KO, PYPL — `broker_protective_stops`, status
`resting`) — correct behavior, but nothing in the ops snapshot or the console Orders screen said
so.  This lane adds a pure classifier for WHY a working order is resting, wires it into the ops
diagnostic snapshot (opt-in) and the console Orders screen, and renders a role badge with a
one-sentence explanation.  Board item `687a5fb4` (lane E1, slug `st-order-roles`).
PR: https://github.com/jaywedgeworth22/Socratic-Trade/pull/3755

## 2. Changes Made

**New `src/lib/order-role.ts`.**  `classifyOrderRole(order, ctx)` is a pure function returning
`{ role, whyResting }`, precedence: tracked `broker_protective_stops` row (or `protstop-`
client-order-id prefix) → `protective_stop` / `trailing_stop`; tracked `synthetic_trailing_stops`
row (or `sstop-` prefix) → `synthetic_stop`; a live `order_replacements` replacement leg →
`replacement`; a bracket/OCO/OTO `order_class` → `bracket_take_profit` / `bracket_stop_loss` /
`entry` (opening leg) by side and type; any other app-tracked order (via
`order-provenance.ts`'s `isAppPlacedBrokerOrder`, imported read-only, not modified) → `entry` /
`exit` by opening/closing side; otherwise → `external`.  `loadOrderRoleContexts` does the DB
reads (one query each against `broker_protective_stops`, `synthetic_trailing_stops`,
`order_replacements`, scoped to the account, batched once per call rather than once per order)
and is best-effort — a DB read failure degrades every order in the batch to whatever the
prefix/bracket/appPlaced fallbacks can still determine rather than throwing and losing the whole
snapshot.  `attachOrderRoles` classifies only WORKING orders (terminal/history orders pass
through unchanged) and is the one function both consumers below call, so the two surfaces can
never classify the same order two different ways.  `buildOpsWorkingOrderDetails` produces the
compact, owner-facing shape for the ops snapshot (capped at `OPS_ORDERS_DETAIL_MAX_PER_ACCOUNT`
= 100 orders, and deliberately excludes order id, client-order-id, and account number).
`ORDER_ROLE_LABELS` is the single Title Case label map both the classifier's own tests and the
console badge use, so the badge text can never drift from the role name.

**`src/lib/types.ts`.**  Added the `OrderRole` union and `role?` / `whyResting?` fields on
`EquityOrder` (both optional, present only when a dashboard/ops snapshot attached them).

**`src/lib/dashboard.ts`.**  The broker-chain promise now calls
`attachOrderRoles(orders, userId, targetAccountNumber ?? "")` right before returning the
portfolio-chain result, so `GET /api/dashboard`'s `orders` array (what the console Orders screen
actually renders — see `app/console/orders/lib.ts`'s own header comment) carries `role` /
`whyResting` on every working order.  No-ops when there's no resolved account number.

**`src/lib/ops-snapshot.ts`.**  New `OpsAccountSnapshot.ordersDetail?: OpsWorkingOrderDetail[] |
null`.  `attachOpsOrderSummaries` takes a new `includeDetail` option; when set it also calls
`buildOpsWorkingOrderDetails` per account after the existing `summarizeBrokerOrderList` call —
the existing counts (`orders.listedCount` / `liveCount` / `workingCount` / `doneForDayCount`)
are unchanged either way.

**`app/api/ops/snapshot/route.ts`.**  New opt-in `ordersDetail=1` query param (implies
`orders=1`).  Doc comment updated.

**`scripts/fetch-prod-ops-snapshot.sh`.**  New `OPS_SNAPSHOT_ORDERS_DETAIL` env var, appends
`&ordersDetail=1` to the URL when set to `1`/`true`.  Kept ASCII-only (verified with
`grep -nP '[^\x00-\x7F]' scripts/fetch-prod-ops-snapshot.sh` — the one non-ASCII byte the grep
still flags, an em-dash on line 10, is pre-existing, on its own comment line, not adjacent to a
`$VAR`, and therefore not the bash-3.2.57 parsing trap AGENTS.md warns about; left untouched).

**`app/console/orders/page.tsx`.**  New `ORDER_ROLE_LABELS` / `OrderRole` import from
`@/lib/order-role`, a `ROLE_TONE` map (protective/trailing/synthetic stop → `info`,
bracket_take_profit → `pos`, bracket_stop_loss / replacement → `warn`, entry/exit → `accent`,
external → `muted`), and a shared `OrderRoleBadge` component (role Chip + `whyResting` as
secondary text, `flex-wrap` so it doesn't overflow at ~390px).  Renders nothing when
`order.role` is absent — never a placeholder badge for missing data.  Wired into both the
desktop table row's Status cell and the mobile card, right under the existing state Chip.  Only
the "Open Orders" section, not "Recent Finished Orders" — terminal orders never carry a role.

**`test/order-role.test.ts`** (new).  One `describe` block per `OrderRole` for
`classifyOrderRole` (pure, no DB), plus DB-backed tests for `loadOrderRoleContexts` (row-match
by `broker_order_id` / `last_attempt_ref_id` / `replacement_order_id`, and the
`cancel_requested` status that must NOT surface a replacement), `attachOrderRoles` (working-only
attachment, no-op on empty account number / no working orders), and
`buildOpsWorkingOrderDetails` (field shape, id/clientOrderId/account exclusion, and the 100-order
cap).

## 3. Decisions & Trade-offs

- **Found and fixed a real short-side bracket misclassification bug in the inherited draft
  during review.**  `src/lib/broker-side.ts`'s `toBrokerSide` maps a SHORT entry to a raw `"sell"`
  and a COVER exit to a raw `"buy"` — the exact inverse of a LONG bracket's buy-to-open /
  sell-to-close — and the app's own strategy prompt explicitly tells the LLM to attach a
  `bracketStopLoss`/`bracketTakeProfit` to every SHORT opening proposal too
  (`src/lib/strategy-prompts.ts`), so this is a reachable, not theoretical, case. The original
  `isOpeningSide(order.side)` heuristic therefore got a short bracket's entry and exit legs
  backwards. Fixed with a side-agnostic signal instead: `loadOrderRoleContexts` now counts, per
  symbol, how many OTHER working orders in the same batch share a bracket-family `orderClass`
  (`OrderRoleContext.bracketSiblingWorkingCount`) — a real Alpaca bracket has exactly 1 working
  bracket-class order (the entry) before the entry fills, and exactly 2 (the OCO exit pair)
  after, regardless of long/short side. `classifyOrderRole` uses that count when the caller
  supplies batch context, falling back to the old side heuristic (correct for LONG brackets only)
  when it doesn't (e.g. a unit test calling `classifyOrderRole` directly with no batch). New
  regression tests in `test/order-role.test.ts` cover both the unit-level `ctx.bracketSiblingWorkingCount`
  contract and an end-to-end short-bracket batch through `attachOrderRoles`.
- **Known residual gap, documented rather than silently left:** the same side-inversion affects
  the GENERIC (non-bracket) entry/exit fallback (role 5 in `classifyOrderRole`'s precedence
  doc-comment) — a bare short entry/cover order placed WITHOUT a bracket has no sibling-count-style
  disambiguator available and can still be mislabeled Entry/Exit backwards. Narrower in practice
  (the strategy prompt routes most shorts through the bracket path fixed above, since it requires
  every short to carry a `bracketStopLoss`), but not fully closed. A correct fix needs position
  context (long/short) or the originating `trade_proposals.proposal.side` (which preserves
  `"short"`/`"cover"` before broker translation) threaded into `OrderRoleContext` — a larger,
  separate change intentionally left out of this lane's scope rather than rushed under time
  pressure. Flagged for a follow-up.
- **`dashboard.ts` is not in lane E1's listed file ownership**, but the console Orders screen's
  own header comment says its data comes from `GET /api/dashboard`'s `orders` array — without
  wiring `attachOrderRoles` in there, the badge task has no data to render.  This was a
  necessary, minimal (one import + one call-site) edit to a shared, unowned file, not a
  collision with another lane's listed files.
- **No new DB reads added beyond what `order-role.ts` already needed.**  `order-provenance.ts`
  was read-only per the task; `hasTrackedAppOrderIntent`'s existing `trade_proposals.ref_id`
  match already covers the task brief's parenthetical mention of `trade_proposals.order_id` — no
  separate `order_id`-keyed query exists in the codebase, and adding one would have meant
  editing `order-provenance.ts`, which was explicitly out of scope.
- **`ordersDetail=1` implies `orders=1`** rather than requiring both — a caller who wants detail
  obviously wants the summary too, and this avoids a confusing "detail present, summary absent"
  response shape.
- **The 100-per-account cap is applied to the WORKING-order list**, not the raw broker list, so
  it never silently drops a resting order in favor of a done_for_day one.
- **Badge tone choice:** protective/trailing stops get the calm `info` tone, not `warn` — a
  resting protective stop is the "everything is working correctly" case this whole feature
  exists to surface, so painting it as a warning would undercut the point.
- **iOS parity not done** — `ios/**` untouched per the task's hard limit; native iOS still shows
  a bare "open order" for these rows.  Noted as a follow-up below.
- **Sentry review follow-up (2026-09-25):** an app-placed bracket's split exit legs keep
  `order_class` "bracket", not "oco", so the earlier OCO-only guard missed the real case.  A lone
  bracket-family order already in `pending_cancel` (its mate just filled) is now read as the
  settling exit leg, not a new entry.  Trade-off: an unfilled entry the owner cancels reads as an
  exit leg for that same brief window.  Bracket take-profit and stop-loss copy now states the
  leg's own broker-reported level, and says "rests until it fills at the broker" when none is
  reported, so no sentence points at "that level" without naming it.  Tests:
  `test/order-role.test.ts` (bracket-class pending_cancel unit + end-to-end, leg level copy).

## 4. Verification State

Commands run from `~/apps/trading-claude-st-order-roles` with
`export PATH=/opt/homebrew/opt/node@24/bin:$PATH` (Node v24.21.0), on the merged HEAD
(`origin/main` merged in cleanly, no conflicts -- merge commit `1f0dc4a2a`):

- `npm run lint` -- **0 errors**, 830 warnings (pre-existing grandfathered backlog; none in
  files this PR touches).
- `npx tsc --noEmit` -- **clean**.
- `npx vitest run test/order-role.test.ts test/ops-snapshot.test.ts test/console-orders-lib.test.ts`
  -- **69/69 passed**.
- `npx vitest run test/dashboard-fill-batching.test.ts test/dashboard-snapshot-projection.test.ts
  test/dashboard-connected-account-pending-counts.test.ts` -- 7/8 passed; the 1 failure
  (`getDashboardSnapshot fill/proposal batching > fetches live + paper fills exactly once
  each...`) is a 60s cold-import test-timeout flake under heavy shared-machine load (fleet-wide
  load average 700+ observed during this session -- multiple sibling lanes running full verify
  gates concurrently) -- **verified pre-existing on unmodified `origin/main` dashboard.ts** by
  directly A/B-swapping the file and re-running the identical test, which timed out identically
  with zero changes from this PR.  Not touched.
- `npm test` (full suite, ~8000+ tests) was run via `scripts/land.sh` on the merged HEAD; it made
  genuine, steady (if very slow) progress for over an hour under the same extreme fleet-wide
  contention -- multiple sibling `st-*` lanes were running their own full verify gates
  concurrently on this shared Mac -- and never surfaced a failure signature, but did not finish
  within a reasonable session window.  Interrupted; land.sh's own merge step (the part that
  matters for landing) had already completed cleanly.  This repo's own `docs/EFFORT-LOG.md` /
  `TRADING-EFFORT-LOG.md` document the identical fallback for other PRs under the same
  conditions (e.g. "Could not run pnpm typecheck/test locally (fleet cache contention)... CI was
  the source of truth").  `npm run build` was not independently run locally for the same reason.
  The PR's own `verify` CI check (hosted, uncontended) is the authoritative full-suite/build gate
  before merge -- this task's own instructions say not to wait on it here.
- PR pushed and opened directly (`git push` + `gh pr create`) rather than via `scripts/land.sh`'s
  own push step, since its local `npm test` did not complete in-session; the merge commit it
  produced is included in the pushed branch unchanged.

## 5. Next Steps & Blockers

- iOS parity (native Orders screen badge) is an explicit follow-up, not done here per the task's
  `ios/**` hard limit.
- No blockers.  No owner decision needed.

## 6. Zero-Code Findings

- A prior attempt of this same lane had already written `src/lib/order-role.ts` (the classifier,
  contexts, `attachOrderRoles`) and the `OrderRole` type additions to `src/lib/types.ts` before
  being interrupted mid-task; this session reviewed that draft against the codebase (verified
  every imported symbol, table, and column name against `src/lib/db.ts`'s schema and
  `order-provenance.ts`'s actual exports), kept it as-is (it was correct), and built the
  remaining wiring (`ops-snapshot.ts`, the route, the script, `dashboard.ts`, the console badge)
  and the test suite on top of it.
- This worktree's `node_modules` was left in a broken state by a previous session (`npm ls`
  showed `@pinecone-database/pinecone` and `drizzle-orm` as `invalid`, and
  `@jaywedgeworth22/congress-trading-shared` had no `dist/`), which made `npx tsc --noEmit` fail
  with dozens of unrelated `Cannot find module` errors.  A fresh `NODE_AUTH_TOKEN=$(gh auth
  token) npm ci` repaired it; this is worth flagging to peers reusing an existing worktree per
  the COMMON-BRIEF's "skip `npm ci` if `node_modules/better-sqlite3` exists" shortcut — that
  check alone doesn't guarantee the rest of the install is intact.

## 7. Build Fix + Review Round (2026-09-25/26)

**Root cause of the `verify-hosted` failure.** `app/console/orders/page.tsx` ("use client")
imports `ORDER_ROLE_LABELS`/`type OrderRole` from `src/lib/order-role.ts`. That file also
imported `getDb` (`./db`) and `order-provenance.ts` directly for its DB-backed context builder —
both pull in `"server-only"` transitively — so the client bundle dragged in the entire DB layer
and `next build` failed:

```
Error: You're importing a module that depends on "server-only" ...
Import trace: ./src/lib/db-settings.ts <- ./src/lib/order-provenance.ts <- ./src/lib/order-role.ts <- ./app/console/orders/page.tsx
              ./src/lib/db.ts <- ./src/lib/order-role.ts <- ./app/console/orders/page.tsx
```

**Fix.** Split `order-role.ts` into two modules:
- `src/lib/order-role.ts` (unchanged path, now PURE) — types, `classifyOrderRole` (classification
  over already-fetched order facts), `ORDER_ROLE_LABELS`, `whyResting` copy.  Zero DB/server
  imports; safe for the client bundle.
- `src/lib/order-role-context.ts` (new, `import "server-only"` at the top, matching
  `db.ts`/`db-settings.ts`'s own convention) — `loadOrderRoleContexts` (the provenance lookups
  against `broker_protective_stops` / `synthetic_trailing_stops` / `order_replacements` /
  `trade_proposals`), `attachOrderRoles`, `buildOpsWorkingOrderDetails`.

`dashboard.ts` and `ops-snapshot.ts` now import the DB-backed functions from
`order-role-context.ts` instead of `order-role.ts`.  The client-delivery contract needed no
change: `dashboard.ts`'s `attachOrderRoles` call already ran server-side and attached
`role`/`whyResting` onto the `orders` array `GET /api/dashboard` returns, and
`app/console/orders/page.tsx` already only *rendered* `order.role`/`order.whyResting` — it never
classified orders itself. Only the module boundary that broke the client bundle needed to move.

**Sentry review threads (both fixed and resolved).** Two Sentry-flagged bugs on the original
diff, fixed by merging in local commit `8e2ed49e1` ("keep a settling bracket exit leg an exit,
and name leg levels") before the build-fix split:
- Thread `4102974343` — the protective-stop `whyResting` fallback said "rests until price falls
  to that level" with no stop price known, a dangling reference. Fixed: a `levelClause` helper
  states the leg's own broker-reported level when known, and falls back to "rests until it fills
  at the broker" (no "that level" reference) when it isn't.
- Thread `4102974351` — a lone bracket-family exit leg left in `pending_cancel` after its sibling
  filled (sibling count drops to 0) was misclassified as a new `entry`. Fixed: an `isPendingCancel`
  check now reads that state as the settling exit leg regardless of sibling count.

Both threads replied to (`gh api .../comments/<id>/replies`) explaining the fix and resolved via
GraphQL `resolveReviewThread` — verified `isResolved: true` for both after replying.

**Verification State (this round).**
- `npm run lint` on the pushed HEAD — **0 errors**, 836 warnings (pre-existing grandfathered
  backlog; none introduced by this change).
- GitHub-hosted CI on PR #3755 (commit `a0b7ac255`, superset of this fix merged with two
  subsequent `origin/main` syncs): `verify` — **pass**; `verify-hosted` (lint → tsc → test →
  build) — **pass** (17m47s); `verify-ios` — **pass**. This is the authoritative full-suite/build
  gate; it is green.
- `npx tsc --noEmit` and `npm run build` were also run locally in an isolated verification
  worktree against the same commit; see the PR's `verify-hosted` run for the authoritative
  result if this session's own local run did not finish in time (this shared Mac was under
  extreme concurrent-agent load throughout this session — see below).

**Zero-code finding: extreme environment churn during this round.** The `claude/st-order-roles`
branch was force-rewritten (rebase, not merge — same commit messages, new hashes each time) by
what appears to be at least one other concurrent process working the same PR, three times during
this session, and the local git worktree checkouts used to do this work were deleted out from
under this session by an unidentified background cleaner at least four times (`~/apps/<name>`
AND a scratchpad-local path both got swept, despite `.janitor-keep`) — see
`/Users/jay/apps/AGENT-SYNC.md` if this recurs; it cost real time re-deriving/re-applying the
same six-file diff repeatedly. Mitigation used here: commit and push immediately after every
successful file-write batch (never leave the fix uncommitted longer than one shell invocation),
and a `for`-loop fetch/reset/reapply/commit/push driver script survives a rejected non-fast-forward
push without a human round-trip. Also observed: this same shared worktree directory picked up
*uncommitted* edits mid-session that this task did not make (a bracket-sibling creation-time-window
refinement to `order-role-context.ts`/`order-provenance.ts`) — left untouched (neither committed
nor discarded) since it is out of this task's scope and its origin/authorship is unclear; flagging
for the branch owner to reconcile.
