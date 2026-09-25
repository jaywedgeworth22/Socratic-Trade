# Runbook: Ops-Token Account Control

`POST /api/ops/account-control` lets an operator holding the ops diagnostic token act on ONE
explicitly named connected account: list its working orders, cancel them, and set its
`systemState`.  It exists because every console mutation is session-gated and acts on the
user's *selected* account, while agents hold only `OPS_DIAGNOSTIC_TOKEN`.  Running app code in a
side process is not a substitute: the broker mutation lease, the in-memory caches, and the
Infisical-injected broker credentials live only in the server process.

Route: `app/api/ops/account-control/route.ts`.  Logic: `src/lib/ops-account-control.ts`.
Wrapper: `scripts/ops/account-control.sh` (on-demand helper, not a background job).

## Security Trade-Off (Read First)

Before this route, the ops diagnostic token was read-mostly (snapshot, health projection, HWM
recompute).  With it, **anyone holding `OPS_DIAGNOSTIC_TOKEN` can cancel working orders and arm,
close-only, or halt any connected account's automation**.  It still cannot place an order, move
money, read credentials, or change guardrails.  Mitigations in place:

- Token-only, constant-time compare (`src/lib/ops-auth.ts`); `ADMIN_REINDEX_TOKEN` is never a
  fallback.  If the token is unset in the environment, every call is 401.
- Every call that names a resolvable account writes an `ops_account_control` audit row
  (`actor: "ops-token"`, action, dryRun, per-order results or `from`/`to` state).  Cancels also
  write the console's own `order_cancel` rows with `source: "ops"`.
- Arming (`active`) runs the console Start checks; nothing bypasses them.
- Responses carry no credentials, no raw broker bodies, and only masked account numbers
  (`****9646`).
- Rotating the token (Infisical, then restart the Coolify app) revokes the capability.

## Before You Start

- `OPS_DIAGNOSTIC_TOKEN` exported in your shell from your secret store.  Never paste it into a
  command line; the script reads it from the environment and never prints it.
- The connected account id (a UUID from `connected_accounts.id`).  Get it from
  `bash scripts/fetch-prod-ops-snapshot.sh` (per-account section) — not from the console URL.
- `OPS_HOST` defaults to `https://socratictrade.com`.

## Commands

```bash
ACCT=becad9f1-c80e-4d31-abc9-2d57152e519c   # example: Tradier Sandbox

# 1. See what is working (read-only).
scripts/ops/account-control.sh list "$ACCT"

# 2. Cancel.  Always dry-run first; mutating commands refuse without --dry-run or --execute.
scripts/ops/account-control.sh cancel "$ACCT" --dry-run
scripts/ops/account-control.sh cancel "$ACCT" --execute
#    ...or only some orders:
scripts/ops/account-control.sh cancel "$ACCT" --order 12345 --order 12346 --execute

# 3. Change automation state (active | close_only | halted).
scripts/ops/account-control.sh state "$ACCT" active --dry-run
scripts/ops/account-control.sh state "$ACCT" active --execute
```

Exit status: 0 on HTTP 2xx, 1 on a usage error, 2 on an HTTP error response.

## What Each Action Does

### `list_working_orders`

Reads the named account's order book through its own broker login and returns only working
orders: `orderId, symbol, side, type, quantity, dollarAmount, filledQuantity, limitPrice,
stopPrice, timeInForce, state, createdAt, protectiveStop`.  `protectiveStop` is true for an order
the app tracks or placed as a protective stop (cancelling one writes a do-not-replace tombstone,
exactly as a console cancel does).

### `cancel_working_orders`

- Default: every working order of the named account.  `orderIds` limits it to a subset.
- Each cancel runs `cancelWorkingOrder` (`src/lib/order-cancel.ts`) — THE console cancel path —
  with an explicit `connectedAccountId`, so the lease-interleave receipt, protective-stop
  tombstone, bracket teardown, dust advisory, dashboard event, cache invalidation and audit are
  identical to a console cancel.
- An id that is not working in the named account's order book is **skipped, never sent**.
- If the order book cannot be read, nothing is cancelled (502), even with explicit `orderIds`: an
  unreadable book cannot prove an id is working in this account.  The per-order re-check inside
  `cancelWorkingOrder` also fails closed for this route (`failClosedWhenUnverified`), while the
  console and mobile lanes keep their fail-open emergency-lever behaviour.  Use the console cancel
  when the broker's order list is down but its cancel endpoint works.
- `dryRun: true`: read-only broker calls only (order book, positions); no cancel is sent.
- Per-order results plus `summary: {requested, cancelled | wouldCancel, failed, skipped}`.

### `set_system_state`

- `active`: runs the console Start checks (`src/lib/autonomy-arming.ts`, shared with
  `POST /api/strategy/enable`) against the named account: broker account number present,
  non-empty universe, `getAccounts` reachable, account listed, `agenticAllowed`.  Failures return
  400 with the console's exact message.  It then runs the scheduler's broker health probe once as
  an advisory (`brokerHealthNow`) — Tradier's probe is a `preview: true` order, never a placement.
- `close_only`: systemState only.  No broker call.
- `halted`: mirrors the console Stop (`enabled: false`, `systemState: "halted"`).  It also clears a
  broker-health auto-pause marker when one exists, so the next healthy tick does not auto-resume an
  account the operator deliberately halted (`clearedBrokerAutoPause: true`).
- The write re-reads the account's policy inside one SQLite transaction and changes only
  `systemState`, so a concurrent console edit is not overwritten, and an account deleted mid-call
  is refused (409) instead of falling back to user-level storage.
- It never changes `isActive` (the console's selected-account pointer).
- `dryRun: true` runs the same checks and reports `wouldChange`; nothing is written.

#### `nextEligibleRun`

Every `set_system_state` response states what the scheduler will do next with this account,
evaluated in the scheduler's own gate order (`src/lib/scheduler.ts` `tickInner`): test broker,
draining, account number, broker health gate, systemState, cadence lane, market session, cadence
clock, monthly LLM ceiling.  `willRun`, `at` (ISO), `atCentral`, `reason`, `blockers`, `notes`.

Facts it encodes:

- **`isActive` is not a scheduling input.**  The scheduler iterates every connected account and
  runs each one whose own `systemState` is `active`, selected or not.
- **A restart or deploy halts it again** unless the user's `autoResumeOnBoot` setting (or
  `AUTONOMY_RESUME_ON_BOOT=1`) is on (`reconcileAutonomyOnBoot`).  Re-arm after a deploy.
- A failing broker health gate skips the account every tick, and re-halts an active one if the
  failure persists (`applyBrokerOrderPlacementPause`).

## Verifying

- Audit trail: `bash scripts/fetch-prod-ops-snapshot.sh` and look for `ops_account_control`,
  `order_cancel` (`source: "ops"`) and `policy_change` rows on the account.
- After `active`, the next strategy run appears in the snapshot's recent runs at `nextEligibleRun.at`.

## Known Gaps

- A call naming an unknown account id is refused (404) and not audited (there is no user to
  attribute it to).
- The console Stop (`POST /api/strategy/pause`) does not clear the broker-health auto-pause
  marker; only this route does.  Tracked in the 2026-09-24 rollout note.
