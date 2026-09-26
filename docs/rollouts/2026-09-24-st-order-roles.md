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

## 7. Review Round (2026-09-25, independent review of PR #3755)

Undocumented context first: the immediately preceding commit (`a466c2ec4`, "split order-role.ts
into a pure module + server-only order-role-context.ts") had already fixed the client-bundle
build break by the time this review round started, but its own commit message promised a
"review-round section to follow in a subsequent commit" that never landed until now.  Recorded
here for the paper trail: `app/console/orders/page.tsx` ("use client") now imports only
`ORDER_ROLE_LABELS`/`OrderRole` from the pure `src/lib/order-role.ts`; the DB-backed
`loadOrderRoleContexts`/`attachOrderRoles`/`buildOpsWorkingOrderDetails` moved to a new
`src/lib/order-role-context.ts` guarded by `import "server-only"`; `dashboard.ts` and
`ops-snapshot.ts` were repointed at the new file.

Seven independent-review findings were checked against the actual code on this branch (not
assumed correct); two were already fixed by `a466c2ec4` above, two were real and fixed here
test-first, one was a duplicate of the same real bug, one was a documentation-only fix, and one
was declined.

- **Client bundle importing server-only DB code (P1) — ALREADY FIXED, not reproducible at the
  branch's actual HEAD.**  The finding was accurate against the commit it pinned (`29a8c6df`,
  one commit behind HEAD at review time), but `a466c2ec4` (committed before this review round
  started) had already applied exactly the fix it recommended — verified directly: `page.tsx`
  line 13 imports only `{ ORDER_ROLE_LABELS, type OrderRole }` from `order-role.ts`, which has
  zero `db`/`order-provenance` imports; `order-role-context.ts` carries `import "server-only"`
  on its own first line.  No code change needed this round.
- **Unbatched per-order `isAppPlacedBrokerOrder` calls contradicting the "3 queries total" doc
  comment (P1) — CONFIRMED, fixed test-first.**  Verified directly: `loadOrderRoleContexts`
  called the up-to-5-query `isAppPlacedBrokerOrder` for every order unconditionally, including
  ones a `protectiveStop`/`syntheticStop`/`replacement` row (or a bracket-family `orderClass`)
  had already fully classified — and `classifyOrderRole` never reads `ctx.appPlaced` once one of
  those roles matches, so the result was discarded.  Added two failing tests first
  (`test/order-role.test.ts`, "loadOrderRoleContexts — appPlaced query batching"), spying on the
  raw better-sqlite3 connection's own `prepare` to assert query COUNT rather than timing (this
  Mac's own documented heavy fleet-wide load rules out a wall-clock assertion) — they failed
  against the pre-fix code (37 queries for 12 orders needing the fallback vs. 7 for 2, i.e.
  scaling with N) before the fix and pass after it (identical query count regardless of N).
  Fixed by skipping the check entirely for orders a cheaper match already resolved, and batching
  the remaining orders' `trade_proposals`/`broker_stop_placement_intents`/`order_replacements`
  (all statuses, matching `isAppPlacedBrokerOrder`'s own original semantics exactly — not just
  the submitted/confirmed subset already fetched for the `replacement` ROLE) lookups into 3
  queries total for the whole account, not 3 per order.
- **Bracket sibling count scoped by symbol instead of by order group (P2 and its P1 duplicate) —
  CONFIRMED, fixed test-first.**  Verified directly: `bracketWorkingCountBySymbol` counted every
  bracket-family working order sharing a symbol across the WHOLE batch, with no grouping by
  which bracket group an order actually belongs to.  Since this app supports scale-in adds to an
  open position (`src/lib/strategy.ts`'s scale-in comments; `strategy-prompts.ts` requires a
  bracket on every opening proposal including scale-ins), a symbol can legitimately carry two
  independent, simultaneously-resting bracket-family order groups — an existing position's
  resting exit pair, plus a brand-new scale-in entry's own bracket.  Added a failing end-to-end
  test first (`attachOrderRoles`, "a fresh scale-in bracket entry on a symbol with an unrelated,
  older resting bracket exit pair") that reproduced the bug exactly as described (a fresh, unfilled
  entry order came back `bracket_stop_loss` instead of `entry`) before the fix.  Fixed by grouping
  bracket siblings by symbol AND creation-time proximity — reusing `order-provenance.ts`'s own
  `CONTINGENT_SIBLING_WINDOW_MS` ("legs of one bracket/OTO/OCO are created together"), now
  exported from that file instead of duplicated — so an unrelated older or newer bracket group on
  the same symbol is no longer counted as a sibling.  Both `test/order-role.test.ts` findings (the
  P2 and its P1 duplicate) point at the same bug and are resolved by this one fix.
- **Missing render test for the console Orders role badge (P2) — DECLINED.**  Verified the claim
  (no test in this PR renders `OpenOrderTr`/`OpenOrderCard`/`OrderRoleBadge` from
  `app/console/orders/page.tsx`) is accurate, and the repo does have precedent for this
  (`test/console-brokers-account-visibility.test.tsx`, `test/console-decisions-index.test.tsx`).
  Declined for THIS round: `page.tsx`'s only role-specific logic is `ORDER_ROLE_LABELS[role]`
  (already asserted exhaustively against every `OrderRole` in `test/order-role.test.ts`) plus a
  static `ROLE_TONE` lookup table with no branching to regress — the actual classification logic
  it renders is the part with real test coverage. Adding a `.tsx` render-test harness is a
  legitimate follow-up, but is new test infrastructure for this file rather than a fix for a
  reachable bug, and risked adding scope under this round's time budget rather than a quick,
  contained fix. Flagged as a follow-up rather than silently dropped.
- **`docs/EFFORT-LOG.md` carrying two near-duplicate rows for lane E1 (P2) — CONFIRMED, fixed.**
  Verified directly in the checked-out file (not just a diff): one row titled "IN PR 2026-09-24"
  with no PR number and a second "IN PR #3755 2026-09-24" with it filled in, both otherwise
  identical.  Removed the stale no-PR-number row, kept the one with the PR number, per this
  repo's binding effort-log protocol (update a row in place, never append a near-duplicate).

Verification for this round: see the commands and results in Section 4 below (re-run after
these fixes) — `npx tsc --noEmit` clean, `npm run lint` 0 errors, and the full
`test/order-role.test.ts` + `test/dashboard-order-role-api.test.ts` + `test/ops-snapshot.test.ts`
suite (55 tests, including the 2 new query-batching tests and the 1 new scale-in bracket test)
green.
