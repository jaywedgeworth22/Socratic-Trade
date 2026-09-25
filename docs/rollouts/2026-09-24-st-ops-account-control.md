# 2026-09-24 CLAUDE — Ops-Token Account Control (Lane F1, Board 687a5fb4)

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
  book is skipped and never sent.  If the order book is unreadable, the default "cancel all" does
  nothing (502); explicit ids still go out (cancelling is the emergency lever, and each cancel is
  scoped to that account's own broker login), marked `verified: false`.
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

Results: see the "Gate Results" section below (filled in at commit time).

## 5. Next Steps & Blockers

1. After merge and deploy, run for the Tradier Sandbox account:
   `scripts/ops/account-control.sh list becad9f1-c80e-4d31-abc9-2d57152e519c`, then
   `cancel ... --dry-run`, `cancel ... --execute`, `state ... active --dry-run`,
   `state ... active --execute`, and read `nextEligibleRun`.
2. Console Stop (`POST /api/strategy/pause`) does not clear the broker-health auto-pause marker, so
   a console Stop issued while the broker gate owns the halt is auto-resumed on recovery.  Small
   fix for the broker-health owner (lane B).
3. Decide whether mutating ops calls should also send an owner notification (not added; the
   console path sends none for these actions).

## 6. Zero-Code Findings

- `isActive` is not a scheduling input (see Decisions).
- A deploy halts every armed account unless `autoResumeOnBoot` is on for the user
  (`reconcileAutonomyOnBoot`), so an ops re-arm must be repeated after each deploy; the response
  says so.
- Tradier's `probeOrderCapability` is a `preview: true` order and places nothing.
