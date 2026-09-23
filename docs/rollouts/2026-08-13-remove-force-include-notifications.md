# Remove the banned force-include notification pattern

## Context & Objective

Owner ruling, 2026-08-12: **"ALL toggles must be real"** — no force-included
notification events, no silent overrides of any user-visible setting, ever
("why would we have settings just to secretly do otherwise"). Ten call sites
across eight files injected a specific `NotificationEventType` into that
send's *effective* `notificationSettings.enabledEvents` at send time,
regardless of what the user had actually stored — so a user who had (or later
set) that event switched OFF in Settings still received it, forever. This PR
removes every one of those sites and replaces the pattern with what their own
comments said they actually wanted: a one-time migration that backfills the
affected event types into any legacy stored `enabledEvents` array that
predates them, after which the Settings toggle is genuinely the user's.

## Changes Made

### Migration (the real fix)

- `src/lib/db.ts`:
  - New `FORCE_INCLUDE_BACKFILL_EVENT_TYPES` constant — the eight event types
    that used to be force-included: `provider_degraded`, `storage_warning`,
    `autonomy_halted_on_boot`, `budget_alert`,
    `earningscalls_entitlement_blocked`, `signal_health`, `lookahead_leak`,
    `risk_advisory`.
  - New `backfillNotificationEnabledEventsRows(database, eventTypes)` helper —
    mirrors the existing `migrateLegacyDailyOpeningCapRows` (v26) 4-store
    sweep (`account_strategy_state`, `strategy_profiles`, `user_settings`,
    `settings`). For each row, if `notificationSettings.enabledEvents` is
    present as an explicit array, unions in any of `eventTypes` not already
    there. Rows with **no** `notificationSettings`/`enabledEvents` key at all
    are left untouched — `mergePolicy`'s `DEFAULT_POLICY` fallback already
    gives those every current event type, so touching them would be a no-op
    at best. Defensively skips a target table that doesn't exist (only
    relevant to test fixtures that build a deliberately minimal schema — a
    real boot always runs `migrate()`'s baseline DDL first, so all four
    tables exist by the time versioned migrations run).
  - New migration **version 78** (`notification_enabled_events_backfill`)
    calling that helper once. This is the new schema HEAD
    (`SCHEMA_BASELINE` unchanged; `getSchemaVersion` now returns 78 on a
    fresh boot).
  - A future `NotificationEventType` that needs the same one-time treatment
    should get its own versioned migration calling
    `backfillNotificationEnabledEventsRows` with the new type(s) — never a
    resurrected force-include-at-send-time site. Said explicitly in the
    migration's comment so the next agent doesn't reach for the old pattern.

### Call sites converted (real `policy` passed through, no override)

- `src/lib/lookahead-audit.ts` — `notifyLookaheadMismatch` (`lookahead_leak`)
- `src/lib/signal-health.ts` — `notifyDriftAlarms` (`signal_health`)
- `src/lib/db-health.ts` — `alertConnectionHealth` (2 sites,
  `provider_degraded`) and `alertStorageWarning` (`storage_warning`)
- `src/lib/scheduler.ts` — `notifyAutonomyHaltedOnBoot`
  (`autonomy_halted_on_boot`)
- `src/lib/earningscalls-transcripts.ts` — `tripEntitlementBlock`
  (`earningscalls_entitlement_blocked`)
- `src/lib/usage-limit-alerts.ts` — `alertUsageLimitHit` (`budget_alert`);
  deleted the now-unused `forcedBudgetAlertPolicy` helper entirely
- `src/lib/broker-health.ts` — `applyBrokerOrderPlacementPause` auto-resume
  path (`risk_advisory`) — **not in the task's original list**, found via
  `grep -rn forcedPolicy`
- `src/lib/strategy.ts` — three `risk_advisory` sites: the drawdown-breaker
  advisory, the accuracy-breaker recovery notice, and the accuracy-breaker
  advisory — **also not in the original list**, same grep

Every site now does `getPolicy(...)` (or uses the `policy` already in scope)
and passes it straight to `sendNotification({ ... }, { policy, ... })` with
no `notificationSettings` override. Comments at each site explain the new
contract and point back to migration 78.

### Test pinning the OLD (banned) behavior, rewritten

- `test/guard-enablement.test.ts` — `"delivers even when the stored
  enabledEvents list predates risk_advisory (force-inject regression)"`
  explicitly asserted the force-include worked (built a policy with
  `enabledEvents: ["fill", "block"]`, ran the drawdown breaker, and asserted
  the `risk_advisory` notification was NOT recorded as "skipped"). Renamed to
  `"does NOT deliver when the user has risk_advisory switched off — real
  toggle, no force-include (owner ruling 2026-08-12)"` and the assertion
  flipped to expect `status: "skipped"` / `error: "Notification type is
  disabled."` — this is now a genuine post-migration opt-out (the fixture
  DB has already run migration 78 by the time the test's `setPolicy` call
  writes the exclusion), so it must stick.

### New/extended regression tests

- `test/db-migration-notification-backfill.test.ts` (new) — seeds a raw
  pre-migration SQLite file with a legacy `user_settings.policy` row (
  `enabledEvents: ["fill", "block", "kill_switch"]`, missing all eight
  backfilled types) and a legacy global `settings.policy` row, then boots
  `getDb()` to run the real migration chain. Verifies: existing array members
  and other `notificationSettings` fields (`webhookUrl`) survive untouched,
  all eight types are present with no duplicates, a row with no
  `notificationSettings` key is left alone, and — closing the loop — turning
  `signal_health` off via `setPolicy` after the backfill sticks across a
  second `getPolicy` read (no re-union; migration is version-gated to run
  once).
- `test/signal-health.test.ts` — new test: a user with `signal_health`
  removed from `enabledEvents` still gets the drift alarm computed/tracked
  internally, but `listNotificationEvents` shows the resulting event as
  `status: "skipped"`, `error: "Notification type is disabled."` — never
  delivered.
- `test/lookahead-audit.test.ts` — same shape for `lookahead_leak`: a leaked
  decision still classifies as a mismatch and `runLookaheadAuditPass` still
  reports `notified: true` (the *attempt* is made; `sendNotification` never
  throws for a disabled type), but the resulting notification event is
  `"skipped"` with the disabled-type error.

## Decisions & Trade-offs

- **Whitelist, not "union every `NOTIFICATION_EVENT_TYPES` member missing
  from the array."** `FORCE_INCLUDE_BACKFILL_EVENT_TYPES` is the exact set of
  types that used to be force-included, not every type. A blanket union would
  also silently re-enable any event a user had genuinely, deliberately turned
  off before this PR for reasons unrelated to the banned pattern (e.g.
  `fill` or `kill_switch`) — that's a different, much larger blast radius
  than what this PR is authorized to fix.
- **Accepted, acknowledged limitation:** a genuine pre-migration opt-out of
  one of the eight affected types (a user who deliberately turned
  `budget_alert` off before this PR shipped) is indistinguishable in stored
  JSON from "legacy row predating the type" — both are just "not in the
  array." The migration runs once and will restore such a row to "on." This
  happens at most once, for a narrow set of at-most-eight types, and matches
  exactly what the task described as the acceptable trade-off (a one-time
  backfill, not a permanent override) — after this migration the toggle is
  unconditionally real going forward.
- **Defensive table-existence check in the new helper.** Not strictly needed
  for production (baseline DDL always runs before versioned migrations), but
  several existing `persistence-hardening.test.ts` fixtures build deliberately
  minimal raw schemas and invoke `applyVersionedMigrations` directly,
  skipping `migrate()`'s baseline. Without the check, migration 78 would
  throw `no such table: account_strategy_state` against those fixtures.
- **No changes to `NotifyPrefs`-level channel fallback logic**
  (`usage-limit-alerts.ts`'s `forcedPrefs` in `notifyOperatorEmailFallback`,
  and the analogous `additionalDelivery` lanes in `db-health.ts`). Those pick
  a delivery *channel* (e.g. an operator email fallback when the user has no
  usable email preference) for a send that has *already* passed the
  `enabledEvents` type gate — a different concept from force-including an
  event *type*, and out of scope for this ruling.
- Removed the `as any` casts that existed only because `forcedPolicy` objects
  built with `Array.from(new Set([...]))` widened past `NotificationEventType[]`.
  The real `TradingPolicy` returned by `getPolicy()` needs no cast.
- **Migration version collision with `monet/apns-push` (#2681), resolved by
  renumbering.** This branch forked when `main`'s highest migration was 76
  (`fundamental_revisions`), so the new backfill migration was authored as
  version 77. `#2681` had forked earlier still (its own branch had
  `device_push_tokens` at version 75) and merged to `main` first — landing
  `device_push_tokens` at version 77 after its own rebase. By the time this
  branch's first `land.sh` run pushed and opened PR #2682, GitHub reported
  `mergeStateStatus: DIRTY` against the now-updated `main`. Resolution: merged
  `origin/main` into this branch, resolved the resulting `src/lib/db.ts`
  conflict by keeping `device_push_tokens` at version 77 (already live on
  `main`, unchangeable) and renumbering `notification_enabled_events_backfill`
  to version **78**, then swept every reference to "migration 77" across the 8
  source files, 3 test files, `STATUS.md`, `docs/EFFORT-LOG.md`, and this note
  to say 78 (`grep -rn "migration 77"` before/after to confirm the sweep was
  complete). No behavioral change — only the version number and its
  in-code/doc mentions moved.

## Verification State

Node 24 pinned (`export PATH="/opt/homebrew/opt/node@24/bin:$PATH"` — the
Homebrew default is v26 and mass-fails the suite on a better-sqlite3 ABI
mismatch). All four gates run to completion and their summary lines read:

```
npx tsc --noEmit    # clean, no output
npm run lint        # ✖ 757 problems (0 errors, 757 warnings) — grandfathered warnings only
npm test            # Test Files  564 passed | 1 skipped (565)
                     # Tests  6522 passed | 51 skipped (6573)
npm run build       # ✓ Compiled successfully; ✓ TypeScript finished; ✓ static pages generated
```

(Numbers above are from the pre-rebase run against the exact code that
ultimately landed — no source changes occurred between that full run and the
commit, only the post-#2681 migration renumbering described above, which
`land.sh`'s own re-run of tsc → test → build re-verified clean a second time
after the rebase, including the retargeted `test/persistence-hardening.test.ts`
assertions now expecting schema version 78.)

Targeted runs before the full suite (all green): `test/signal-health.test.ts`,
`test/lookahead-audit.test.ts`, `test/db-migration-notification-backfill.test.ts`,
`test/usage-limit-alerts.test.ts`, `test/broker-health-auto-pause.test.ts`,
`test/scheduler-boot-halt-notify.test.ts`,
`test/earningscalls-transcripts.test.ts`, `test/persistence-hardening.test.ts`
(bumped 12 hardcoded schema-version assertions, 76 -> 77 -> 78 across the two
rounds above), `test/db-migration-old-schema.test.ts`,
`test/db-migration-busy.test.ts`, `test/guard-enablement.test.ts` (rewritten
test, see above), `test/strategy-moneypath-drawdown-flip.test.ts`,
`test/strategy-active-protection-wiring.test.ts`,
`test/account-mutation-pr2-strategy-loop.test.ts`,
`test/notification-status-truth.test.ts`, `test/dashboard-feed.test.ts`,
`test/alert-center-incident-grouping.test.ts`, `test/notify-push-sanitize.test.ts`,
`test/policy-notification-events.test.ts`, `test/llm-provider-cooldown.test.ts`,
`test/provider-tier.test.ts`, `test/local-db-fault-classification.test.ts`,
`test/connection-health-routing.test.ts`, `test/alert-mutes.test.ts`,
`test/vector-db-backlog-c-integration.test.ts`.

## Next Steps & Blockers

Landed: PR https://github.com/jaywedgeworth22/Socratic-Trade/pull/2682,
opened ready (not draft), auto-merge armed (squash) — merges automatically
once the `verify` CI check goes green on the post-rebase commit. Nothing
else known outstanding.
