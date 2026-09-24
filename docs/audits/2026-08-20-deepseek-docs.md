# Docs audit — Socratic-Trade ops/deploy accuracy vs code + topology (commit 41a7a438d, origin/main)

Auditor: review subagent (read-only). Ground truth: AGENTS.md (repo root), code at HEAD, docs under audit.

## Summary
deployment.md, the health runbook, and the newest rollouts are largely current and internally consistent; the runbook's JSON fields/thresholds/token headers match app/api/health/route.ts and src/lib/ops-auth.ts exactly. The stale material clusters in three places: (1) docs/deployment.md still frames Litestream replication as R2-based, when B2 is the live replica and R2 is the weekly cold snapshot; (2) docs/ops-observability-security.md "Production Notes" still describes a Mac PM2 litestream sidecar and a 2026-07-01 "restore not exercised" status, contradicting docs/litestream.md and its own earlier bullet; (3) deployment.md's "no self-hosted Mac runner labels" claim ignores the live macOS xcode26 runner used by iOS CI. No stale host IPs/UUIDs (Oracle <ORACLE_IP_RETIRED>, old Hetzner, m1os7ij...) appear in live (non-rollout) docs, and no env var the docs name is unread by code (spot-audit of ~40 README/deployment/runbook env names all resolve in src/scripts/app).

## Findings

### P1 | deployment.md "Secrets and persistence" still says Litestream replicates to R2
- Evidence: docs/deployment.md:80-81 "Litestream → R2 when enabled; free-tier kill-switch and B2 offsite are covered in fleet ops rollouts."
- What's wrong: The live Litestream replica is Backblaze B2 bucket jays-socratic-trade-eu (litestream.coolify.yml:6-9 "Continuous SQLite backup to Backblaze B2"; docs/litestream.md:6-7 "active replica is Backblaze B2 EU Central"; rollout 2026-08-07-litestream-b2-backup.md). R2 (socratic-trade-bucket) is the weekly cold-snapshot DR lane only (cold-snapshots/, R2_COLD_SNAPSHOT_DEFAULT_RETAIN=1). The doc even lists "B2 offsite" as a separate thing while B2 IS the Litestream target — a reader doing backup ops will act on the wrong target, which is exactly the endpoint-confusion footgun litestream.coolify.yml:19-24 warns about.
- Fix: Rewrite to "Litestream → Backblaze B2 (live replica, jays-socratic-trade-eu); R2 holds the weekly cold snapshot (cold-snapshots/, retain=1). The R2 free-tier kill-switch is R2-era only — scripts/coolify-prod-start.sh ignores it once AWS_S3_ENDPOINT is B2."
- Effort: S

### P1 | docs/ops-observability-security.md "Production Notes" still describes a Mac PM2 litestream sidecar and an unexercised restore
- Evidence: docs/ops-observability-security.md:132-138 "Litestream runs under PM2 (`litestream` sidecar) next to production `next start` … **Status as of 2026-07-01 (G9a audit item): restore has not yet been exercised** — only replication is verified live (`docs/rollouts/2026-06-21-litestream-r2-live.md`)."
- What's wrong: (a) Production Litestream runs inside the Coolify container via litestream.coolify.yml + scripts/coolify-prod-start.sh; the Mac PM2 lane is retired rollback-only (AGENTS.md; docs/litestream.md:16,25-27). (b) B2 restore to scratch IS verified (docs/litestream.md:106-115, rollout 2026-08-17-litestream-restore-drill.md) — the 2026-07-01 status is 6 weeks stale and directly contradicts this doc's own lines 52-55 ("production WAL replication runs in the Coolify container … The Mac PM2 litestream sidecar … is retired"). The 2026-08-20-stale-hosting-docs.md sweep claimed to fix this doc but this block remains.
- Fix: Delete/replace lines 132-138 with the current container topology + "B2 restore verified 2026-08-18 — see docs/litestream.md"; drop the "restore not exercised" line.
- Effort: S

### P2 | deployment.md deploy-flow step 4 says Litestream runs "(when R2 is enabled)"
- Evidence: docs/deployment.md:70-71 "Boot injects Infisical secrets, restores SQLite when the marker-guarded bootstrap requires it, and runs Litestream (when R2 is enabled) around Next.js."
- What's wrong: Under DB_BOOTSTRAP=live the container runs `litestream replicate` by default, only bypassed by the generic .litestream-disabled marker or the R2 kill-switch marker (which scripts/coolify-prod-start.sh:194-203 explicitly ignores when the endpoint is B2). Replication state is not "R2 enabled" — the replica is B2. Same stale frame as finding 1.
- Fix: "…and runs Litestream replication around Next.js (replica = B2; disabled only by the .litestream-disabled marker)."
- Effort: S

### P2 | deployment.md "CI … no self-hosted Mac runner labels" is false for the iOS lane
- Evidence: docs/deployment.md:91 "CI: GitHub-hosted `ubuntu-latest` only (no self-hosted Mac/Oracle runner labels)." vs .github/workflows/ios-build.yml:45 and ios-ship.yml:51 `runs-on: [self-hosted, macOS, ARM64, xcode26]`.
- What's wrong: AGENTS.md (2026-08-13 correction) states "ST has exactly one registered runner, the Mac mac-xcode26-socratic" — a real, current self-hosted runner used by the iOS build and TestFlight ship workflows. The blanket "no self-hosted Mac runner labels" reads like the macOS runner is retired too and could cause an agent to remove/avoid it. The retirement applies to fleet/web CI runners (socratic-ci, oracle-ci, fleet-ci-*, trading-live-mac), which is how AGENTS.md words it ("Fleet CI = GitHub-hosted only").
- Fix: Qualify: "Fleet/web CI: GitHub-hosted ubuntu-latest only (no self-hosted runner labels; the sole exception is the iOS macOS runner `[self-hosted, macOS, ARM64, xcode26]`)."
- Effort: S

### P3 | docs/EFFORT-LOG.md board mirror tail marks merged work as IN PROGRESS / IN PR
- Evidence: docs/EFFORT-LOG.md:106-109 (health JSON monitors, "IN PROGRESS … PR #2816") and :110-115 (RTH latch, "IN PR #2817") and :254 (B2 migration, "IN PROGRESS / landing") — while #2816 (85cbda190) and #2817 (2f597eaa8) are merged on main and B2 is live (litestream.coolify.yml). No COMPLETED/MERGED row follows these in the file (contrast :116 restore drill "COMPLETED/MERGED #2823").
- What's wrong: The repo mirror of the effort board drifts from merged state; per AGENTS.md a COMPLETED (merged to main) row should have been appended when each landed.
- Fix: Append COMPLETED (merged) rows for the #2816/#2817/B2 efforts (append-mostly; do not delete prior rows).
- Effort: S

### P3 | scripts/fetch-prod-ops-snapshot.sh comment still points the token at the retired Mac lane
- Evidence: scripts/fetch-prod-ops-snapshot.sh:5 "The same token must be set on trading-live (see docs/rollouts/2026-06-29-ops-diagnostic-snapshot.md)."
- What's wrong: trading-live is the retired Mac pm2 lane (AGENTS.md: "Mac pm2 lane retired (rollback only)"; .cursor/rules/ops-diagnostics.mdc and AGENTS.md both say set OPS_DIAGNOSTIC_TOKEN on production Coolify socratic-app, "Do not pm2 restart trading"). The script's own error text correctly says production/Infisical; only the header comment is stale.
- Fix: Change comment to "The same value must be set on production (Infisical, Coolify socratic-app) and in Cursor Cloud Secrets."
- Effort: S

### P3 | docs/ops-observability-security.md references a deployment.md section that does not exist
- Evidence: docs/ops-observability-security.md:127 "see `docs/secrets.md` and `docs/deployment.md` → "Configuration & secrets"" — grep shows deployment.md has no "Configuration & secrets" heading (its section is "Secrets and persistence", line 76).
- Fix: Point at deployment.md "Secrets and persistence".
- Effort: S

### P3 | Restore drill was proven with litestream 0.5.16, but the production container pins 0.5.12
- Evidence: docs/litestream.md:111 "(litestream 0.5.16, 107s, exit 0, 4.9G)" and docs/rollouts/2026-08-17-litestream-restore-drill.md:38 "Host litestream 0.5.16" vs scripts/coolify-prod-start.sh:36 LITESTREAM_VERSION="0.5.12" (AGENTS.md: 0.5.14 rolled back to 0.5.12 2026-07-10).
- What's wrong: The B2 restore proof (the basis for pruning the R2 replica) exercised a host-installed 0.5.16 binary, a version never run in the container. Not a code problem, but docs should say the drill used a host binary version different from the container pin, and the next drill should use the pinned 0.5.12 (the doc already says "repeat after a version bump").
- Fix: Add one line in docs/litestream.md: "Drill used host litestream 0.5.16; the container pins 0.5.12 — re-drill with the pinned version."
- Effort: S

### P4 | README "production behind the Cloudflare tunnel" phrasing
- Evidence: README.md:242 "For production behind the Cloudflare tunnel, see the definitive Robinhood Connection Guide".
- What's wrong: Production is Coolify on Hetzner behind Cloudflare proxy; the Mac Cloudflare tunnel is the rollback path (AGENTS.md). The linked guide is current and even says "You do NOT need SSH tunnels" — the README teaser is loose but not wrong enough to misdirect; flagged for consistency only.
- Fix: Reword to "For production connections on socratictrade.com…".
- Effort: S

## Verified-correct (checked, not stale)
- Runbook docs/runbooks/uptime-health-json-monitors.md: all JSON fields exist and match app/api/health/route.ts — schedulerStale (route:99/104, 5min threshold route:92), tradingLiveness.degraded (route:146), tradingLivenessDegraded (route:147), storage.litestreamTiersDegraded (route:424, 512-514), openrouterCredits (route:319), "ok" first key (route:77/518). 503 set matches criticalServices = pinecone + alpaca-broker (route:215, 284) incl. the env-lane-vs-user-key caveat (configuredLaneHealthy, route:243-266). Token contract matches src/lib/ops-auth.ts (x-ops-token, legacy x-admin-token, Authorization: Bearer; OPS_DIAGNOSTIC_TOKEN only, ADMIN_REINDEX_TOKEN never a fallback).
- deployment.md: host <PROD_ORIGIN_IP> / host.jays.services / manual webhook endpoint / watch_paths list incl. uuid <ST_COOLIFY_APP_UUID> / RTH latch semantics (src/lib/rth-deploy-latch.ts + Dockerfile RUN tsx scripts/assert-rth-deploy-latch.ts before npm ci, exit 2) / HEALTHCHECK /api/live (Dockerfile:97-99, app/api/live/route.ts) / concurrent_builds=1 / freshness workflow cron every 20 min (.github/workflows/deploy-freshness.yml:18) / stale-threshold 3600s (scripts/alert-deploy-freshness.sh:43) / verify-deploy-sha 25-min poll (script header) — all match code and AGENTS.md.
- Exit-code contract (40/41/42/43/130/143) implemented in scripts/coolify-prod-start.sh:122-142; no audited doc contradicts it.
- No stale host IPs/UUIDs in live docs: grep for <ORACLE_IP_RETIRED> / <HETZNER_OLD_IP_RETIRED> / 77.42.35.209 / m1os7ijf31bg3fanil152e4b / jays.services/api/v1 outside docs/rollouts returns only archival rows (EFFORT-LOG, status-archive) or correct "decommissioned"/"prior host" framing; scripts/sync-provider-knobs.sh already updated to Hetzner (<PROD_ORIGIN_IP>, /data/coolify/applications/<ST_COOLIFY_APP_UUID>/.env) — AGENTS.md's "defaults point at the old Oracle host" note is itself now stale.
- README env block: every one of ~40 env names (MARKET_SCAN_*, HISTORY_TTL_MS, WEB_SOURCE_*, VOYAGE/PINECONE/VECTOR_*, ALPACA_PAPER_*, MASSIVE_*, FMP/FINNHUB/FRED/ALPHAVANTAGE, ROBINHOOD_*, INFISICAL_ST_PRIMARY_WRITER_*, etc.) has at least one reference in src/scripts/app.
- Newest rollouts (2026-08-20-*): no "IN PR" claims about code that actually landed; 2026-08-20-ios-web-parity.md:68 correctly marks HomeView "Max Order"/"Daily Cap" labels as pending ("after #2794 lands") — still pending at HEAD (ios/SocraticTrade/HomeView.swift:893-894).
- docs/ops-diagnostics.md does not exist; the ops-diagnostics contract lives in .cursor/rules/ops-diagnostics.mdc, which is current and correct (OPS_DIAGNOSTIC_TOKEN required, ADMIN_REINDEX_TOKEN not a fallback, "Do not pm2 restart trading").

## Verification notes (commands run)
- git log -1 --oneline (HEAD = 41a7a438d); ls docs/ docs/runbooks/ docs/rollouts/ (tail)
- read docs/deployment.md, docs/runbooks/uptime-health-json-monitors.md, docs/ops-observability-security.md, docs/litestream.md, docs/secrets.md, README.md, .cursor/rules/ops-diagnostics.mdc
- read docs/rollouts/2026-08-20-stale-hosting-docs.md, 2026-08-20-r2-historic-prune-unblocked.md, 2026-08-20-intraday-provider-fail-502.md, 2026-08-20-drain-adopt-live-heartbeat.md, 2026-08-18-rth-deploy-latch.md (watch_paths section)
- sed -n app/api/health/route.ts:40-110 & 176-300; read app/api/ops/snapshot/route.ts; read src/lib/ops-auth.ts; read app/api/live/route.ts; read src/lib/rth-deploy-latch.ts
- cat litestream.coolify.yml; sed -n scripts/coolify-prod-start.sh:110-205; grep LITESTREAM_VERSION scripts/coolify-prod-start.sh (=0.5.12); cat Dockerfile (HEALTHCHECK /api/live, latch before npm ci)
- grep -rn env names: COOLIFY_SERVER_STATS/COOLIFY_API_TOKEN/COOLIFY_AGENTS (app/api/admin/server-metrics/route.ts), OPS_DIAGNOSTIC_TOKEN/ADMIN_REINDEX_TOKEN (src/lib/ops-auth.ts, src/lib/auth/admin.ts), APP_B_INGEST_TOKEN (src/lib/securities-import-auth.ts), DB_BOOTSTRAP, REQUIRE_SECRETS_MANAGER/SECRETS_SOURCE (src/lib/secrets-source.ts), R2_COLD_SNAPSHOT_* / R2_ARCHIVE_KEEP_GENERATIONS (src/lib/r2-cold-snapshot.ts)
- for-loop grep of ~40 README env names against src/scripts/app (zero orphans)
- grep for stale IPs/UUIDs: <ORACLE_IP_RETIRED>, <HETZNER_OLD_IP_RETIRED>, 77.42.35.209, m1os7ijf31bg3fanil152e4b, jays.services/api/v1, host.jays.services (live docs only)
- grep -rn "runs-on" .github/workflows/*.yml (ios-build.yml:45 / ios-ship.yml:51 = [self-hosted, macOS, ARM64, xcode26])
- git log --all --grep for #2816 (85cbda190 merged), #2817 (2f597eaa8 merged), #2794 (not found at HEAD)
- grep HomeView.swift:893-894 ("Max Order"/"Daily Cap" still present — pending note is accurate)
- docs/EFFORT-LOG.md:106-115, 254, 116 (board-tail drift)
- Read-only: no repo files modified; scratch notes at /tmp/deepseek-review-docs.md
