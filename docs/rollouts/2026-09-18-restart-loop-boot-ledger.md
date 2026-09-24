# 2026-09-18 - restart-loop-boot-ledger

## Summary

- The production app now keeps a durable boot/exit ledger (`boot-ledger.jsonl`) on the persistent data volume and raises a loud alert when it boots 3 or more times inside 45 minutes.
- `exit-guard` gained an optional `receipt` hook so the ledger keeps the `process.exit` call-site stack that used to live only in the dying container's logs.
- Board `a9676caf` (P1, open since 2026-08-31): "Container restart loops have no alert and destroy their own forensics (new container per restart)".  This is the part of it that lives in repo code; the host/Coolify half is listed under Follow-ups.

## Why

- Coolify replaces the container on every restart, so the previous container's `docker logs`, including the exit-guard receipts (exit code, signal, call-site stack), vanish before anyone looks.  The 2026-08-28 RTH loop (~15 minutes) killed every run that day and left no trail.
- Each boot looks healthy in isolation, so nothing alerted on the loop itself.  PR #3201 (wider healthcheck) removed one cause of restarts but neither of the two things this row asks for.
- `/app/data` is the one path that survives a container replacement (SQLite DB, `litestream-runtime.log`, `.bin`), so the evidence goes there.

## Files

- `src/lib/boot-ledger.ts` (new) - `recordBoot()` appends a boot line and arms an `exit` receipt; `assessRestartLoop()` (pure) counts boots in a trailing window and classifies the predecessor as clean/killed; `reportRestartLoop()` logs, sends a Sentry `fatal` message (fingerprint `boot-ledger/restart-loop`) and calls `alertStorageWarning("restart_loop", ...)` (12h cooldown owned by that function).
- `src/lib/exit-guard.ts` - new optional `receipt` callback, invoked with `{ code, signal?, callSite? }` right before the real exit; a throwing receiver is swallowed.
- `instrumentation.ts` - `recordBoot()` immediately after the exit guard is installed (before anything can crash), `reportRestartLoop()` fire-and-forget right after Sentry init.
- `test/boot-ledger.test.ts` (new, 19 tests, including the receipt hook) and the existing `test/exit-guard.test.ts` (9, unchanged and green).

## Behaviour

- Ledger line per boot: `{t:"boot", ts, bootId, pid, node, release?}`.  Per exit: `{t:"exit", ts, bootId, code, uptimeSec, signal?, callSite?}`.  Read it on the box with `tail -n 20 /app/data/boot-ledger.jsonl`.
- A boot whose predecessor has no `exit` line means the predecessor never reached the process `exit` event: SIGKILL, OOM kill, a healthcheck kill or a host restart.  The next boot's message says so (`NO exit receipt`), which is itself the forensic receipt for that class.
- Loop = `bootsInWindow >= threshold` where the window includes the current boot.  Defaults: 45 minutes, 3 boots.  Tunables: `RESTART_LOOP_WINDOW_MINUTES` (min 1), `RESTART_LOOP_BOOT_THRESHOLD` (min 2).
- Active only when `NODE_ENV=production` or `BOOT_LEDGER=on`; `BOOT_LEDGER=off` is the kill switch; `BOOT_LEDGER_PATH` overrides the location.  Default location is the directory of `DATABASE_URL`, the same rule `runtime-health.ts` uses for `litestream-runtime.log`.
- The ledger is trimmed to its newest 400 lines once it passes 256 KiB.

## Decisions & Trade-offs

- **Counts every restart, deliberate or not.**  Three Coolify redeploys inside 45 minutes also trip it.  That is intended: the 2026-09-08 "15-min Coolify API redeploy loop" produced the same 503s as a crash loop, and the alert text carries each predecessor's exit code (143 + SIGTERM reads as a deliberate stop) so the reader can tell which it is.  It is rate-limited to one admin alert per 12h.
- **Reuses `alertStorageWarning`, so the admin push is titled "Storage Warning: restart loop".**  A dedicated notification type would have to be added to `NOTIFICATION_EVENT_TYPES`, the `db.ts` list, the dashboard/settings labels, `ops-snapshot.ts` and `strategy-run-failure.ts`, and would collide with the `liveness_warning` type PR #3380 is adding to the same code.  The Sentry `fatal` message is the primary signal; the push is a backstop.  Promote to its own type in a follow-up if the wording bothers the owner.
- **Unprefixed `fs` / `path` / `crypto` imports** (not `node:`), matching `db.ts` and `db-api-keys.ts`.  `instrumentation.ts` is also compiled for the edge runtime and PR #3313 just failed `next build` on an unresolvable `module` builtin reached the same way; `node:dns` is the one `node:` import there and needed `webpackIgnore`.  `next build` in CI is the check for this.
- **No new DB table.**  A migration would collide with #3344's v89 and put a write on the boot path; a JSONL file beside the DB needs neither.
- Nothing here changes what the app does; every code path is wrapped so a ledger failure cannot affect boot or shutdown.

## Verification State

- `npx vitest run test/boot-ledger.test.ts test/exit-guard.test.ts` - 28 passed (19 + 9).
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` - clean.
- `npx eslint` on the four touched files - 0 errors (1 pre-existing `any` warning in instrumentation.ts).
- Full `verify` (including `next build`) runs in CI on the PR.

## Follow-ups

- Host side, NOT done here (no host changes in this task): a Coolify/Sentry-side container restart-count monitor, and confirming the Coolify volume mount for `/app/data` keeps the ledger across redeploys (it must, the DB lives there).
- Related open rows: `4ca246e5` (fleet-health-recover watchdog restart-loop, blocked on the owner) and BF-DEPLOYER's 15-minute redeploy loop.  This change gives both a durable trail; it does not fix either cause.
- Optional: expose `bootsInWindow` / `prevUnclean` in `/api/health` so a JSON-path monitor sees the loop without Sentry.  Left out to avoid conflicting with the open health-route PRs.
