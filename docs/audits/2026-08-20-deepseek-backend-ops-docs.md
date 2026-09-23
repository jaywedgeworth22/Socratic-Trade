# Socratic-Trade — Backend / API / Ops / Docs Review (deepseek lane)

Reviewed: /Users/jay/apps/trading-deepseek @ origin/main 41a7a438d (clean checkout, verified `git status` empty).
Date: 2026-08-21. Read-only review; scratch artifacts only in /tmp.

Method: personal deep-dive of the scheduler/liveness/deadline/middleware/money-path/DB files, plus three
parallel subagents covering (a) the full app/api/** surface, (b) scripts/**.sh + **.ts + .github/workflows
against the AGENTS.md production contract, (c) docs accuracy vs code + AGENTS.md topology. All claims below
were verified by reading the cited lines. Known open board findings (ids listed in the brief) were NOT
re-filed; where this review found something in the same family, it is marked "deepens <id>" with new
file:line evidence.

## Summary

The backend is in unusually good shape for a real-money app: the exit-code contract, the admin gate, the
identity chain, the scheduler's lease/lane guards, and the broker-I/O deadline discipline all hold under
direct inspection, and test coverage of the new safety modules is strong. No P0 defects and no unguarded
money-path bugs were found. The real problems are monitoring honesty and stale documentation: the RTH
evening drain exits 0 when it cannot nudge Coolify (a green job that can silently leave prod behind — the
2026-08-06 silent-freeze class), the deploy-freshness watchdog pages on every deliberately latched weekday
merge, several docs still describe the retired Mac/pm2/R2 topology as live, and the API surface has
consistency gaps (three error envelopes, uncaught broker errors, a few unthrottled high-value routes).

## Strengths (verified, do not "fix")

- **Exit-code contract holds end to end.** `scripts/coolify-prod-start.sh` re-tags spontaneous clean exits
  to 40 (line 154-155), invokes `node_modules/.bin/next` directly, never `npm run` (lines 132-135, 167,
  223), forwards signals by `kill -TERM "$APP_PID"` (140-141), and no `process.kill(process.pid)` re-raise
  exists anywhere in src/scripts (0 grep hits). `src/lib/exit-guard.ts` re-tags signal-less `exit(0)` to 43.
- **Admin gate holds.** Every one of the 26 `app/api/admin/**` route files has an explicit gate
  (25 × `requireAdmin`/`isAdminEmail`, 1 × `verifySecuritiesImportToken` bearer model for
  /api/admin/securities/import, script-verified zero gaps); the `/admin` page tree is gated once at the
  edge (middleware.ts:460) with the same predicate; `app/admin/**` pages no longer ship chrome to
  non-admins (2026-08-20 fix verified in place).
- **Identity chain is fail-closed and provenance-marked.** middleware.ts strips client-supplied identity
  headers (strip-identity.ts), resolves CF-Access only after JWKS+audience verification (middleware.ts:240-
  283), refuses the local fallback under live bootstrap, and `src/lib/request-user.ts` ignores body/query
  userId hints entirely (old IDOR vectors closed), with account-generation fencing on tombstoned identities.
- **Scheduler safety is layered.** Single-leader CAS lease with TTL+steal and fail-closed acquire
  (scheduler-lease.ts:70-106); per-lane in-flight guards (stopMonitor/staleExit) released by the REAL work,
  never by the 15s race loser (scheduler.ts:917, 947 — the 28996d82 duplicate-launch fix holds); whole-tick
  re-entrancy guard; boot autonomy interlock (reconcileAutonomyOnBoot); heartbeat-failure abdication;
  optional Sentry Crons dead-man's-switch.
- **Broker I/O discipline is structural.** Placement/cancel/replace pass NO AbortSignal (alpaca.ts:295-311
  trackHealth: "Order placement, cancel, and replace deliberately pass no signal" — verified), so an aborted
  placement can never be mis-reconciled; idempotent reads route through awaitWithFirstCallRetry with
  abortable controllers (inflight-deadline.ts:159-217); the stale-run sweep gives a 30-min threshold plus an
  audit-activity liveness guard (db-execution.ts:549-604).
- **P&L accounting handles shorts/cover and unmatched exits honestly.** performance.ts:649-733 FIFO matches
  only same-side lots, cover vs short uses the correct sign, unmatched closing fills are counted and
  disclosed rather than vanished, open lots are signed, and no synthetic equity-curve baseline is fabricated
  (performance.ts:579-594).
- **market-realtime.ts is feed-honest**: ok-vs-unavailable discrimination on intraday (route 502 vs
  confirmed-empty 200), per-symbol upstream `at` timestamps, `delayed: true` flags on the Yahoo fallback,
  Robinhood 15Min→30minute mapping called out as the nearest COARSER honest match (market-realtime.ts:218),
  and FMP deliberately absent.
- **R2 cold snapshot is prefix-scoped and budget-guarded**: list/prune only under `cold-snapshots/` with a
  key-pattern filter (r2-cold-snapshot.ts:244-246, 400), retain hard-capped at 1, so the dead `trading-live/**`
  objects and the LIVE B2 replica can never be touched by this lane.
- **Migration runner is crash-safe**: BEGIN IMMEDIATE + atomic user_version bump per migration
  (db.ts:3277-3300), documented 2026-08-12 deploy crash-loop fix; FTS index migration (v85) is idempotent.
- **Scripts are secret-clean**: no bare `infisical secrets`, no `set -x`/`curl -v` with tokens, tokens only
  in 0600 config files or headers; ASCII violations are all non-$VAR-adjacent (latent).
- **Coverage**: 659 test files; dedicated tests for trading-liveness, scheduler-lease, exit-guard,
  rth-deploy-latch, market-realtime (incl. the 403-vs-empty discrimination), health-route exposure,
  middleware auth, csrf, ops-snapshot, live-route.

## Findings

### P1

1. **P1** | **rth-deploy-drain.sh exits 0 when it cannot nudge — a failed drain is silently green**
   | scripts/rth-deploy-drain.sh:136-139 (`if [ "$nudge_ok" -eq 0 ]; then ...; exit 0; fi`), wired by
   .github/workflows/rth-deploy-latch.yml:66-71 (drain job) | The scheduled after-close recovery job reports
   SUCCESS even when nothing was nudged. The gh-redeliver path (drain.sh:105-125) almost always fails with
   GITHUB_TOKEN (lacks admin:repo_hooks; the script itself logs "GITHUB_TOKEN often cannot write hooks"), so
   the only working path is the `COOLIFY_DEPLOY_WEBHOOK_URL` secret (drain.sh:127-134) — if unset, the drain
   can never nudge and always exits 0. Alerting is then blind: freshness Slack de-dupe
   (alert-deploy-freshness.sh:110-117) and Sentry fingerprinting group the earlier staleness into one alert,
   so nothing new fires and prod stays behind with every automation green — the 2026-08-06 silent-freeze
   class. | Fix: `exit 1` when `nudge_ok=0` (fail the job → Sentry pages), and fail loudly at startup if
   neither a gh hook nor `COOLIFY_DEPLOY_WEBHOOK_URL` exists. | S

2. **P1** | **deployment.md says Litestream replicates to R2; the live replica is B2 and R2 is a
   destructive-footgun target** | docs/deployment.md:80-81 ("Litestream → R2 when enabled; free-tier
   kill-switch and B2 offsite are covered in fleet ops rollouts") and :70-71 ("runs Litestream (when R2 is
   enabled)") | The live replica is Backblaze B2 `jays-socratic-trade-eu` @ s3.eu-central-003.backblazeb2.com
   (litestream.coolify.yml:6-20; docs/litestream.md:6-8). R2 `socratic-trade-bucket` holds only the weekly
   `cold-snapshots/` lane (retain=1). Both buckets share the identical object path `trading-live/app.db` —
   the config's own FOOTGUN (litestream.coolify.yml:16-24) — so a doc that mislabels the active replica as
   R2 can drive an operator to prune/restore the wrong endpoint and destroy the active backup. | Rewrite:
   "Litestream → Backblaze B2 (live replica); R2 holds only the weekly cold snapshot (retain=1)." | S

### P2

3. **P2** | **deployment.md:91 "no self-hosted Mac runner labels" is false for the iOS lane**
   | docs/deployment.md:91 vs .github/workflows/ios-build.yml:45 and ios-ship.yml:51
   `runs-on: [self-hosted, macOS, ARM64, xcode26]` | AGENTS.md (2026-08-13 correction) documents exactly one
   registered runner, the Mac `mac-xcode26-socratic`, used by iOS build/ship. The blanket claim can make an
   agent treat the macOS runner as retired; the retirement applies to fleet/web CI runners only. | Qualify
   the sentence to name the iOS exception. | S

4. **P2** | **Deploy-freshness watchdog pages STALE on deliberately RTH-latched merges** |
   scripts/alert-deploy-freshness.sh:202-217 (no RTH awareness; verified zero `isMarketOpen`/latch/HOTFIX
   references) vs the Dockerfile latch (assert-rth-deploy-latch.ts before npm ci) | The 2026-08-18 latch
   intentionally refuses weekday-RTH image builds, so a 10:00 ET merge is legitimately undeployed until the
   16:00 close; the 2026-08-06 watchdog cannot distinguish "latch refused the build" from "webhook silently
   died" and pages at the 1h mark for every weekday-RTH merge. False pages in exactly the class the watchdog
   exists for train agents/owner to ignore the real ones. | Have the watchdog consult the latch decision
   (market-calendar isMarketOpen) and treat a latched gap as in-flight. | M

5. **P2** | **runner-availability.sh still operates the RETIRED Mac self-hosted runner + pm2 `trading` lane**
   | scripts/runner-availability.sh:3,18-19,30-32,34,55-56,161-173 | The script's whole purpose is
   publishing VERIFY_RUNNER_STATE for ci.yml routing to a self-hosted Mac runner, but ci.yml:11-22 already
   removed that apparatus (verify runs on ubuntu-latest) and AGENTS.md is binding: Mac runner deleted
   2026-07-21, "DO NOT EVER START, RE-REGISTER, OR REFERENCE ... `trading-live` RUNNER LABELS AGAIN". Dead
   code whose instructions would violate the rule if followed. | Delete with a rollout note, or mark
   ROLLBACK-ONLY and strip runner/pm2 references. | S

6. **P2** | **ops-observability-security.md still documents a Mac PM2 litestream sidecar and an
   unexercised restore** | docs/ops-observability-security.md:132-138 ("Litestream runs under PM2
   (litestream sidecar) ... Status as of 2026-07-01 (G9a audit item): restore has not yet been exercised") |
   Production Litestream runs inside the Coolify container (litestream.coolify.yml + coolify-prod-start.sh);
   the Mac pm2 lane is retired rollback-only; B2 restore to scratch is VERIFIED (docs/litestream.md:106-115,
   rollout 2026-08-17-litestream-restore-drill.md). Contradicts this same doc's lines 52-55 and was missed
   by the 2026-08-20 stale-hosting sweep (which claimed to fix this file). | Replace lines 132-138 with the
   container topology + "B2 restore verified 2026-08-18"; drop the 2026-07-01 status. | S

### P3

7. **P3** | **checkBrokerHealth is awaited INLINE in the per-account loop with no tick-level deadline — one
   slow broker stalls every account's scheduling** | src/lib/scheduler.ts:971 (`const healthSignals = await
   checkBrokerHealth(...)` inside the per-account loop) and src/lib/broker-health.ts:38-39 (Promise.all of
   getAccounts + getPortfolio) + :97 (probeOrderCapability) | Every lane (stale-limit, stop-monitor, drain)
   is wrapped in withDeadline, but the health gate that runs BEFORE each account's strategy decision is not.
   It is bounded per account (~16+8s first/retry budgets via inflight-deadline) but serial — two accounts on
   a slow broker can consume nearly the whole 60s tick, delaying strategy runs and compounding with the
   tick re-entrancy skip. Deepens 28996d82 (lane latching) with a NEW site: the health gate itself. | Wrap
   checkBrokerHealth in withDeadline (SCHEDULER_BROKER_TIMEOUT_MS) or run it fire-and-forget per account
   with a shared result cache. | S

8. **P3** | **GET /api/market/quotes stamps top-level `asOf` = serve time while quotes may be older — the
   009b99f0 footgun on the NEW peer route** | app/api/market/quotes/route.ts:45 (`asOf: new
   Date().toISOString()`) | Each quote carries the honest upstream `at` (and `delayed: true` on the Yahoo
   fallback), but the top-level asOf is "now" regardless — a consumer doing point-in-time capture could read
   it as quote freshness, exactly the fabrication class 009b99f0 flags for the internal pipeline. New route
   (2026-08-20, #2953), so this is a fresh instance, not a duplicate. | Either name it `servedAt`/`fetchedAt`
   or omit it; keep the honest per-quote `at`. | S

9. **P3** | **Error envelope is inconsistent: `{ok:false,error}` vs `{error}` vs plain text all coexist**
   | `{error}` / text: app/api/orders/route.ts:12, portfolio:12, policy:48,206, proposals/from-draft:45,
   proposals/[id]/approve:39-40; `{ok:false,error}`: app/api/webhooks/congress/route.ts:28,94,
   market/quotes:26, admin/securities/import:42; plain-text 403/401 bodies also from middleware
   (middleware.ts:425,444) | Consumers (web + iOS) must special-case three shapes and text-vs-JSON; the
   native iOS decoders currently survive via defensive decodeIfPresent (89249c60), but every new consumer
   re-learns the mess. | Add one shared jsonError(status, code, message) helper and migrate the plain-text
   sites; pick one envelope. | M

10. **P3** | **Broker-backed GET routes throw uncaught → Next generic 500 (non-JSON) on broker failure**
    | app/api/orders/route.ts:13, portfolio:13, positions:13, accounts:10, watchlist:20, orders/cancel:31
    (uncaught `throw error`) | A live Alpaca/Tradier outage renders as Next's default 500 page instead of a
    JSON error with the broker reason; the iOS app shows a generic failure and the web console logs an
    opaque stack. | try/catch → 502 `{ok:false,error}` with a bounded message (pattern already in
    from-draft/route.ts:158-165). | S

11. **P3** | **Malformed JSON bodies 500 instead of 400 on three routes** | app/api/orders/cancel/route.ts:20,
    app/api/policy/route.ts:46 (uncaught `request.json()`), app/api/keys/route.ts:337,431-432 (caught but
    mapped to 500) | Client serialization bugs become opaque 500s; most routes already use
    `.catch(() => ({}))` or a SyntaxError→400 branch (chat/route.ts:83, mobile/auth/apple/route.ts:67). | Add
    the catch/branch on the three sites. | S

12. **P3** | **POST /api/proposals/from-draft has NO rate limit; every sibling proposal path is limited**
    | app/api/proposals/from-draft/route.ts (no limiter anywhere; broker portfolio+positions reads at
    :155-165, DB writes at :270-291) vs approve/route.ts:18, retry-red-team/route.ts:15,
    bulk-approve/route.ts:85 (all charge RATE_LIMITS.orders) | The chat→staged-proposal money path is the
    unguarded entry into the proposal pipeline; a loop bypasses the 20/min orders limiter. | Add
    `enforceRateLimit(userId, "proposals/from-draft", RATE_LIMITS.orders)`. | S

13. **P3** | **/api/health is public, unthrottled, and does network + disk + IPC I/O per request**
    | middleware.ts:57 (PUBLIC_PREFIXES), app/api/health/route.ts:310 (OpenRouter fetch up to 1.5s on cache
    miss), :357 statfs, :364-403 litestream IPC read + log scan; no rate limit anywhere in the handler |
    Anonymous hammering drives repeated outbound provider calls and disk scans against the same probe
    UptimeRobot/Coolify hit constantly; /api/live exists precisely to be the cheap probe. | IP/global
    limiter (fail-open) in the handler, or point external monitors at /api/live. | S

14. **P3** | **GET /api/history collapses total failure into 200 + empty array + `note`**
    | app/api/history/route.ts:46-48 (`{symbol, bars: [], note: "price history fetch failed"}`, status 200)
    vs quote/route.ts:111 (502) and market/intraday:50-51 (502) | Chart consumers cannot distinguish "no
    history exists" from "provider failed" without string-matching the note; an outage renders as an empty
    chart. | Return 502 `{error}` on failure; keep 200 only for genuine no-data. | S

15. **P3** | **guardrail-copy.ts claims iOS mirrors its sentences in DeskCopy — it does not**
    | src/lib/guardrail-copy.ts:5-6 ("iOS mirrors the same sentences in DeskCopy
    (ios/SocraticTrade/DeskModels.swift) — keep them in sync") | DeskCopy (DeskModels.swift:562+) is a fully
    separate copy (taxation helpers, scan messages, etc.); none of guardrail-copy.ts's exported strings
    (ADVISORY_NOTE, GUARDRAILS_HEADER_SUFFIX, REGIME_*) exists in the Swift file (grep-verified). The
    "keep them in sync" instruction is unenforceable because the two copy sets don't correspond 1:1, so
    guardrail-copy drift is unguarded — the same class as 30a5e1ba (copy claims) on the sync-mechanism side. | Either
    make DeskCopy derive from a shared source of truth, or reword the comment to "web-only; iOS copy is
    maintained separately in DeskCopy". | S

16. **P3** | **Mac-side litestream restore/drill scripts still target the DEAD R2 replica; litestream.yml
    pins R2-only `region: auto`** | scripts/litestream-restore.sh:2,9; scripts/litestream-restore-drill.sh:2,10,20;
    litestream.yml:19-25 | litestream.coolify.yml documents B2 as LIVE and R2 as dead/prunable with the
    identical object-path footgun; the Mac rollback/drill scripts still claim R2 is the source, and
    `region: auto` is invalid for B2 (needs cluster id `eu-central-003`). If the Mac .env.local is R2-era the
    rollback restores from a dead bucket; if B2-era, `region: auto` breaks. | Update comments + region, echo
    endpoint+bucket before any restore/delete, and guard against the R2 bucket for writes. | S

17. **P3** | **run-litestream.sh loads LITESTREAM_* vars but litestream.yml consumes AWS_* vars**
    | scripts/run-litestream.sh:13 (`grep -E '^LITESTREAM_'`) vs litestream.yml:19-25 (`${AWS_S3_BUCKET_NAME}`,
    `${AWS_S3_ENDPOINT}`, `${AWS_ACCESS_KEY_ID}`, `${AWS_SECRET_ACCESS_KEY}`) and litestream-restore.sh:19
    (`^AWS_`) | If .env.local stores AWS_* (as restore.sh assumes), run-litestream.sh loads nothing and the
    Mac rollback replicator starts credential-less; the two helpers disagree on the var family. Neither
    helper is on MAC-LOCAL-PROCESSES.md (binding rule). | Align the var family and add the registry rows. | S

18. **P3** | **EFFORT-LOG board mirror marks merged work as IN PROGRESS / IN PR** | docs/EFFORT-LOG.md:106-115
    (health monitors "IN PR #2816", RTH latch "IN PR #2817") | #2816 and #2817 are merged on main and B2 is
    live (litestream.coolify.yml), but no COMPLETED/MERGED row follows. A live coordination doc saying the
    opposite of reality. | Append COMPLETED (merged) rows (append-mostly, never delete another agent's row). | S

19. **P3** | **Restore drill was proven with a different litestream binary than prod pins**
    | docs/litestream.md:111 and docs/rollouts/2026-08-17-litestream-restore-drill.md:38 ("Host litestream
    0.5.16") vs scripts/coolify-prod-start.sh:36 (`LITESTREAM_VERSION="0.5.12"`) | The B2 restore proof (the
    basis for unblocking the R2 prune) ran a host 0.5.16 binary never run in the container. | Add one line
    disclosing the version skew and re-drill with the pinned version. | S

20. **P3** | **ASCII-only rule violated in 7 scripts + githooks (latent, none $VAR-adjacent)**
    | scripts/coolify-prod-start.sh:197, effort-orphan-report.sh:55, fetch-prod-ops-snapshot.sh:10,
    infisical-secrets-safe.sh:2,50,67, land.sh:2,11,28,35,... (incl. U+26A0), run-litestream.sh:4-5,
    scripts/githooks/pre-commit:13 (emoji), pre-push:11,29,39-41,48,76 — verified with perl scan +
    hexdump; the `$VAR`-adjacency pattern has ZERO matches | AGENTS.md mandates pure ASCII; the violations
    are em dashes/arrows/box-drawing/emoji. Nothing breaks today, but one future edit can create the fatal
    bash-3.2.57 adjacency. | Replace with ASCII; add `grep -P '[^\x00-\x7F]' scripts/*.sh` to the verify
    gate. | S

21. **P3** | **infisical-prod-cutover.sh operates the retired Mac pm2 production lane** |
    scripts/infisical-prod-cutover.sh:97,273-275,286 (`pm2 delete` / `pm2 start npm -- ... -- run
    start:secrets` / "Check 'pm2 logs $APP'") | AGENTS.md retires the Mac pm2 `trading` lane (rollback-only);
    boot is Coolify + infisical-run.mjs. A historical tool still driving the old lane; its `npm run`
    exec-chain is the retired class (on the Mac, not the container — no contract violation today). Secret
    values verified to go to a chmod-600 file under umask 177, never stdout. | Mark ROLLBACK-ONLY/historical
    in the header, or delete. | S

22. **P3** | **scripts/ops/fleet-watchdog.service references the deleted fleet-site-watchdog.sh** |
    scripts/ops/fleet-watchdog.service (`ExecStart=/usr/local/bin/fleet-site-watchdog.sh`) | AGENTS.md says
    the script was deleted 2026-07-31, but the systemd unit that launches it is still committed; if installed
    it would restart-fail, and as repo content it contradicts the documented deletion. | Delete the unit (with
    a rollout note) or point ExecStart at a current watchdog. | S

### P4

23. **P4** | **/api/admin/reindex-10k POST returns 200 with embedded `ok:false` on partial failure** |
    app/api/admin/reindex-10k/route.ts:174 | Backfill with errors is a 200; status-code monitoring can't
    alarm. Operator-only, so low severity. | `status: errors.length === 0 ? 200 : 502`. | S

24. **P4** | **Rate limits absent on several high-value paths** | app/api/strategy/run/route.ts (LLM-funded
    kicker; deduped via strategy-run-requests.ts:80-95 but no limiter vs tune/route.ts:46), GET
    orders/portfolio/positions/accounts/watchlist, app/api/events/stream/route.ts:41 +
    mobile/events/route.ts:41 (no SSE connection cap), notifications/test/route.ts:11-21 (real SMS/push per
    call), mobile/auth/apple/route.ts (public, remote JWKS verify per call) | Inconsistent with the limited
    reads (scan, quote, symbol-desk). | Add limits to strategy/run, per-user SSE caps, limits on
    notifications/test + mobile/auth/apple. | S-M

25. **P4** | **No Cache-Control on quote/intraday/history EOD routes (missed caching, not stale-serving)** |
    cache headers exist only on logos/ticker (public 1d), server-metrics/backup-status (private no-store),
    SSE (no-cache), framework/content (no-store); missing on quote, history, market/prices|quotes|intraday|spx,
    scan, watchlist. Next's force-dynamic default no-store prevents stale-serving, so nothing is wrong today —
    but EOD routes re-fetch providers per hit and /api/quote re-runs a 3-4 provider cascade per drilldown. |
    `public, max-age=3600, stale-while-revalidate=86400` on history/prices/spx; short `max-age=15` on quote. | S

26. **P4** | **Stale comments referencing retired self-hosted runners** | .github/workflows/security.yml:25,
    sentry-ci-report.yml:80-83, e2e.yml:8,146, ci.yml:11-22, scripts/sync-effort-issues.py:329 (comments only;
    runs-on verified ubuntu-latest everywhere) | Misleading for future readers; no functional impact. | Clean
    up comments. | S

27. **P4** | **fetch-prod-ops-snapshot.sh:4 and land.sh:171-172 carry retired-lane guidance** |
    fetch-prod-ops-snapshot.sh:4 ("The same token must be set on trading-live") and land.sh:171-172 (pm2
    preview restart hint) | OPS_DIAGNOSTIC_TOKEN lives on Coolify prod; previews are retired. Comment/hint
    only. | Update comments; reword the land.sh hint. | S

28. **P4** | **sync-provider-knobs.sh defaults to usage.jays.services (UM API) — verify it still resolves** |
    scripts/sync-provider-knobs.sh:11,41,51 | Not on the retired preview list, but the apex and *.jays.services
    wildcard records were deleted 2026-07-09; a per-app record must still exist for this default to work.
    Verify-only. | Confirm DNS/route or pin the current endpoint. | S

29. **P4** | **Dead cross-reference + README phrasing** | docs/ops-observability-security.md:127 ("see
    docs/deployment.md → 'Configuration & secrets'") — no such heading (the section is "Secrets and
    persistence"); README.md:242 ("production behind the Cloudflare tunnel" — prod is Coolify on Hetzner
    behind the CF proxy; the Mac tunnel is rollback-only). | Point at the real heading; reword the README
    line. | S

## Quick wins (top 5)

1. `scripts/rth-deploy-drain.sh`: `exit 1` on `nudge_ok=0` (P1, S).
2. `docs/deployment.md:70-81`: rewrite the R2/B2 framing (P1, S).
3. `app/api/proposals/from-draft/route.ts`: add the orders rate limit (P3, S).
4. `app/api/history/route.ts:46-48` + broker-backed GETs: 502 `{error}` on failure instead of 200/500 (P3, S).
5. `scripts/alert-deploy-freshness.sh`: skip the stale verdict inside the RTH window (P2, M).

## Test-coverage notes

- Strong: trading-liveness (9), scheduler-lease (9), exit-guard (20), rth-deploy-latch (23),
  market-realtime (incl. 403-vs-empty), health-route-exposure, middleware-auth, csrf, ops-snapshot,
  live-route, admin-gate.
- Gaps worth a line: no dedicated unit tests for `src/lib/ops-auth.ts` or `src/lib/securities-import-auth.ts`
  (constant-time token compares; currently only covered indirectly via ops-snapshot/import route tests), and
  no test for `rth-deploy-drain.sh`'s nudge-failure exit semantics (finding #1 would have been caught by
  one).

## Verification notes (exact commands run)

- `git -C /Users/jay/apps/trading-deepseek log -1 --oneline` → 41a7a438d = origin/main; `git status --short`
  → empty (verified twice; the scripts subagent's "locally modified EFFORT-LOG.md" note is a false alarm).
- `board list --app socratic-trade --status open` → 242 open; known ids cross-checked, none re-filed.
- Read in full (read tool): middleware.ts, src/lib/{execution-mode,market-realtime,rth-deploy-latch,
  inflight-deadline,exit-guard,ops-auth,trading-liveness,scheduler,scheduler-lease,broker-health,
  safety-maintenance,on-demand-quote,guardrail-copy,account-mutation,request-user,rate-limit,alpaca
  (place/cancel/probe),db.ts (getDb, runMigrations, FTS v85)}, app/api/health, live, market/{quotes,intraday,
  spx,prices}, quote, proposals/from-draft, scripts/{assert-rth-deploy-latch.ts,rth-deploy-drain.sh,
  coolify-prod-start.sh,fetch-prod-ops-snapshot.sh}.
- Greps: `grep -nP '[^\x00-\x7F]'` (via LC_ALL=C `[^ -~]`) over scripts/*.sh → 7 files, none $VAR-adjacent
  (adjacency pattern 0 hits); `process.kill(process.pid` → 0 hits; stale IPs/UUIDs
  (<ORACLE_IP_RETIRED>/<HETZNER_OLD_IP_RETIRED>/77.42.35.209/m1os7ijf31bg3fanil152e4b) → only archival framing;
  `runs-on` in ios-build.yml:45 + ios-ship.yml:51 → `[self-hosted, macOS, ARM64, xcode26]`;
  `enforceRateLimit|Cache-Control` over app/api → gap map; requireAdmin loop over all 26 admin routes → 0 gaps.
- Subagent reports (independently re-verified where noted): /tmp/deepseek-review-api-routes.md,
  /tmp/deepseek-review-scripts.md, /tmp/deepseek-review-docs.md.
- Read-only throughout: no repo file modified.
