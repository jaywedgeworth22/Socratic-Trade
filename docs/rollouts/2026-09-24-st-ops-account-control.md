# 2026-09-24 CLAUDE — Ops-Token Account Control (Lane F1, Board 687a5fb4, PR #3754)

## 1. Context & Objective

The owner asked an agent to cancel the four open orders on the Tradier Sandbox connected account
(`becad9f1-c80e-4d31-abc9-2d57152e519c`, broker `tradier`, `systemState: halted`,
`isActive: false`) and restart its automation.  No agent could: every mutating route
(`/api/orders/cancel`, `/api/strategy/enable`, `/api/strategy/pause`, `/api/policy`) is
session-gated and acts on the user's *selected* account, and agents hold only
`OPS_DIAGNOSTIC_TOKEN`.  Running app code in a side process is unsafe (the broker mutation lease,
in-memory caches, and Infisical-injected credentials live only in the server process).

Objective: an ops-token route that acts on an explicit `connectedAccountId` — never the selected
account — through the console's own code paths.

## 2. Changes Made

- **New `POST /api/ops/account-control`** (ops-token gated, 16 KiB bounded JSON body), actions
  `list_working_orders`, `cancel_working_orders` (optional `orderIds`, `dryRun`), and
  `set_system_state` (`active | close_only | halted`, `dryRun`).  Every call that resolves an
  account is audited as `ops_account_control` with `actor: "ops-token"`.
- **`cancelWorkingOrder` accepts an explicit `connectedAccountId`** (and `source: "ops"`).  When
  set, the policy resolves from that account; an id that is not this user's is refused (404),
  never re-pointed.  The console and mobile paths are byte-for-byte the same behaviour (wording of
  two error strings is only parameterised for the explicit case; the console receipt shape is
  unchanged).
- **Arming checks extracted** from `POST /api/strategy/enable` into
  `verifyAutonomyArmingPreconditions` (`src/lib/autonomy-arming.ts`); the enable route and the ops
  route both call it, so the checks cannot drift.  Messages and statuses unchanged.
- **`nextEligibleRun`** in every `set_system_state` response: the scheduler's own gate order
  evaluated for that account, with `willRun`, `at`, `atCentral`, `reason`, `blockers`, `notes`.
- **Operator wrapper** `scripts/ops/account-control.sh` (ASCII-only, bash 3.2 safe; token read from
  the environment and sent via a process-substitution header file, never in argv; mutating
  commands require `--dry-run` or `--execute`).
- **Runbook** `docs/runbooks/ops-account-control.md`.
- **Repo hygiene:** removed the tracked `node_modules` symlink accidentally committed by
  b583b2c65 (#3452) (`git rm --cached node_modules`; `.gitignore` already ignores it).

Files:

- `app/api/ops/account-control/route.ts` (new)
- `src/lib/ops-account-control.ts` (new)
- `src/lib/autonomy-arming.ts` (new)
- `src/lib/order-cancel.ts`
- `app/api/strategy/enable/route.ts`
- `scripts/ops/account-control.sh` (new)
- `test/ops-account-control.test.ts` (new)
- `test/strategy-enable-route.test.ts` (new)
- `docs/runbooks/ops-account-control.md` (new)
- `docs/rollouts/2026-09-24-st-ops-account-control.md` (this note)
- `STATUS.md`, `docs/EFFORT-LOG.md`
- `node_modules` (tracked symlink removed)

## 3. Decisions & Trade-Offs

- **Security trade-off (owner should see this).**  The diagnostic token can now cancel working
  orders and change any connected account's trading state.  It still cannot place orders, move
  money, read credentials, or edit guardrails.  Mitigations: token-only constant-time auth, an
  audit row on every resolvable call, the console's own arming checks, masked output.  Rotating
  `OPS_DIAGNOSTIC_TOKEN` revokes it.
- **What `isActive` means.**  `connected_accounts.is_active` is only the console's
  selected-account pointer.  The scheduler (`tickInner`) iterates *every* connected account and
  runs each one whose own `systemState` is `active`.  So arming a non-selected account needs no
  selection change, and the route deliberately never touches `isActive` (changing it would move
  the owner's console view).
- **Account-scoped write path.**  State writes use `setPolicy(policy, userId, connectedAccountId)`,
  the same writer the console's targeted `PUT /api/policy`, the scheduler's broker-health
  auto-halt/auto-resume, and the boot reconcile use.  The write re-reads the policy inside one
  SQLite transaction and changes only `systemState` (plus `enabled: false` on halt, mirroring the
  console Stop), so a concurrent console edit is not lost, and an account deleted during the
  broker check is refused (409) instead of falling through to user-level storage.
- **`halted` clears the broker-health auto-pause marker.**  Without that, the next healthy tick
  would auto-resume an account the operator just halted.  The console Stop has the same latent gap
  and was left unchanged (it belongs to the broker-health owner's lane); see Next Steps.
- **`dryRun` makes no broker mutation.**  It still performs the read-only lookups needed to say
  what would happen (order book for cancel; `getAccounts` and the health probe for `active`).
  `close_only` and `halted` make no broker call at all.
- **Explicit `orderIds` are membership-checked.**  An id not working in the named account's order
  book is skipped and never sent.  If the order book is unreadable, nothing is cancelled (502),
  explicit ids included (review-stage change on this PR).  The per-order re-check in
  `cancelWorkingOrder` fails closed only for this route, via the ops-only
  `failClosedWhenUnverified` flag; the mobile lane keeps its fail-open behaviour (a first cut made
  `requireWorkingOrder` itself fail closed, which changed the mobile lane and broke
  `test/mobile-order-cancel.test.ts`).  Set-state reads use `peekPolicy`, so a refused arming leaves
  no seeded `account_strategy_state` row (review-stage change).
- **Events.**  Cancels emit exactly what a console cancel emits.  State changes emit what the
  console emits (the `policy_change` audit and snapshot-cache invalidation inside `setPolicy`)
  plus one `dirty` dashboard event so an open console refreshes after an out-of-band change.
- **`role` per order** was not added: `src/lib/order-role.ts` does not exist on main (lane E1 may
  add it).  `protectiveStop` covers the decision the owner needs today.

## 4. Verification State

Commands run in `~/apps/trading-claude-st-ops-account-control` (Node 24):

```bash
npx vitest run test/ops-account-control.test.ts test/strategy-enable-route.test.ts
npx vitest run test/mobile-order-cancel.test.ts test/orders-cancel-dust-risk-route.test.ts \
  test/order-provenance-guard.test.ts test/route-strategy-pause.test.ts \
  test/broker-health-auto-pause.test.ts test/ops-hwm-recompute.test.ts
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Results (shared dev box at load average 250 to 735 from parallel lanes):

- Targeted: `ops-account-control` 24/24, `strategy-enable-route` 4/4.
- Adjacent suites 31/31 (three first-test 60s timeouts under load re-ran green with
  `--testTimeout=400000`).
- `npm run lint`: exit 0, 0 errors, 830 warnings (repo backlog, none from this diff).
- `npx tsc --noEmit`: clean.
- `npm test`: 8299 passed, 51 skipped, 1 failed — `test/nasdaq-calendar-provider.test.ts`
  "retries a failed date after its (short) negative-cache TTL elapses", a timing test untouched by
  this diff that passes 15/15 when re-run alone.  Load flake.
- `npm run build`: exit 0; `/api/ops/account-control` present in the route table.
- `scripts/land.sh`: tsc clean, but its `npm test` step ended with no vitest summary (the process
  died mid-run under load), so the branch was pushed and PR #3754 opened directly; CI `verify` is
  the binding gate.
- `scripts/ops/account-control.sh`: `bash -n` clean, pure ASCII, exercised under `/bin/bash` 3.2
  against a local echo server (token header delivered, body correct, exit 0 on 2xx, 2 on 409,
  1 on usage errors).

## 5. Next Steps & Blockers

1. After merge and deploy, run for the Tradier Sandbox account:
   `scripts/ops/account-control.sh list becad9f1-c80e-4d31-abc9-2d57152e519c`, then
   `cancel ... --dry-run`, `cancel ... --execute`, `state ... active --dry-run`,
   `state ... active --execute`, and read `nextEligibleRun`.
2. Console Stop (`POST /api/strategy/pause`) does not clear the broker-health auto-pause marker, so
   a console Stop issued while the broker gate owns the halt is auto-resumed on recovery.  Small
   fix for the broker-health owner (lane B).  The review round (section 7) closed the related
   in-flight-tick race for every writer, but not this stale-marker case, which needs the console
   Stop itself to clear the marker as `set_system_state` now does.
3. Decide whether mutating ops calls should also send an owner notification (not added; the
   console path sends none for these actions).

## 7. Review Round (2026-09-25)

Independent reviewers raised five findings on #3754.  Each was checked against the code; all five
were real and all five are fixed test-first on the same branch (10 new regression tests, each seen
failing before its fix).

Fixed:

1. **P1: an ops cancel refused whenever the broker took more than 2.5s to confirm the order.**
   The ops path sets `requireWorkingOrder` + `failClosedWhenUnverified`, but the pre-cancel
   orders+positions read inside `cancelWorkingOrder` kept the console's 2.5s advisory budget.
   Tradier walks its order pages one request at a time and Robinhood reads go through MCP, so on
   those brokers every ops cancel came back 502 even though the route's own order-book read allows
   15s.  Fix: `CancelWorkingOrderInput.lookupTimeoutMs` (optional; console and mobile keep 2.5s),
   and the ops route passes its 15s `BROKER_READ_TIMEOUT_MS`.  The race timer is now also cleared
   when the read answers.  Tests: a 3s-slow broker cancels (was 502), and a fail-open lane without
   the option still gives up at 2.5s.
2. **P2: an ops halt or close_only could be undone by a scheduler tick already in progress.**  The
   scheduler reads a policy snapshot, awaits `checkBrokerHealth` (up to about 30s), then called
   `applyBrokerOrderPlacementPause`, which decided and wrote on that stale snapshot.  An operator
   halt or close_only during the probe became an auto-resumable halt; a close_only on an
   auto-halted account was resumed to active; `setPolicy(snapshot)` also overwrote any console edit
   made during the probe.  Fix (both halves the reviewer proposed): `applyBrokerOrderPlacementPause`
   re-reads the durable policy (no await between that read and its writes), decides on it, writes
   only `systemState` onto the fresh read, and syncs the caller's snapshot so the rest of the tick
   (including "do not launch a run unless active") sees it; and `set_system_state` now clears the
   broker auto-pause marker for ANY explicit operator state, inside the same write transaction.
   This closes the race for the console Start/Stop too, since the scheduler side is shared.
   Tests: four in `test/broker-health-auto-pause.test.ts` plus one ops test.
3. **P2: `describeNextEligibleRun` reported blockers in a different order than the scheduler.**
   `tickInner` checks the test broker, then `!policy.accountNumber -> continue`, and only then
   `isDraining`, so a draining account with no account number is never wound down.  The account
   number blocker now comes first.  Test added.
4. **P2: `active` did not re-check the arming preconditions inside the write transaction.**  The
   universe or account number could change while the broker check was in flight and the account
   was still armed.  Fix: the synchronous half of the console Start checks is now
   `checkAutonomyArmingPolicyPreconditions` (same messages, same order, still used by
   `verifyAutonomyArmingPreconditions`), and the transaction re-runs it against the fresh policy
   and refuses (409) if the account number differs from the one the broker verified.  Tests:
   universe emptied mid-call, account number replaced mid-call.
5. **P2: bulk `cancel_working_orders` had no wall-clock bound.**  Each order gets its own fresh
   check and cancel, and up to 100 ids (or every working order) could hold the request for
   minutes, past the edge proxy's 100s limit.  Fix: `OPS_CANCEL_BATCH_BUDGET_MS` (45s from the
   start of the call).  Once spent, no further cancel is started; the rest come back as
   `notAttempted: true` with nothing sent, `summary.notAttempted` counts them, and `ok` is false so
   a re-run finishes the job.  An in-flight cancel is never abandoned.  Test added.

Declined: none.

Files touched this round: `src/lib/order-cancel.ts`, `src/lib/ops-account-control.ts`,
`src/lib/autonomy-arming.ts`, `src/lib/broker-health.ts`, `test/ops-account-control.test.ts`,
`test/broker-health-auto-pause.test.ts`, `docs/runbooks/ops-account-control.md`, this note,
`STATUS.md`, `docs/EFFORT-LOG.md`.

Verification this round (worktree `~/apps/claude-st-ops-account-control`, Node 24, load average
280 to 400):

```bash
npx vitest run test/broker-health-auto-pause.test.ts test/ops-account-control.test.ts \
  test/transient-network-resilience.test.ts test/strategy-enable-route.test.ts
npx vitest run test/mobile-order-cancel.test.ts test/scheduler-tick-reentrancy.test.ts \
  test/account-mutation-pr2-strategy-loop.test.ts
npm run lint
npx tsc --noEmit
```

Results are recorded in the PR comment for this round; CI `verify` is the binding gate.

## 6. Zero-Code Findings

- `isActive` is not a scheduling input (see Decisions).
- A deploy halts every armed account unless `autoResumeOnBoot` is on for the user
  (`reconcileAutonomyOnBoot`), so an ops re-arm must be repeated after each deploy; the response
  says so.
- Tradier's `probeOrderCapability` is a `preview: true` order and places nothing.
