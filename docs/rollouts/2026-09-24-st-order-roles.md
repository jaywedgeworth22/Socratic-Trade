# 2026-09-24 — Order Role Classification, Ops Order Detail, Console Badges

## 1. Context & Objective

The owner saw "4 open orders just sitting there" on Alpaca Paper and could not tell why.  They
were resting GTC protective stops (BAC, BRK-B, KO, PYPL — `broker_protective_stops`, status
`resting`) — correct behavior, but nothing in the ops snapshot or the console Orders screen said
so.  This lane adds a pure classifier for WHY a working order is resting, wires it into the ops
diagnostic snapshot (opt-in) and the console Orders screen, and renders a role badge with a
one-sentence explanation.  Board item `687a5fb4` (lane E1, slug `st-order-roles`).

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

## 4. Verification State

Commands run from `~/apps/trading-claude-st-order-roles` with
`export PATH=/opt/homebrew/opt/node@24/bin:$PATH` (Node v24.21.0):

```
npm run lint
npx tsc --noEmit
npx vitest run test/order-role.test.ts
npm test
npm run build
```

Results: <FILL_IN_BEFORE_LANDING>

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
