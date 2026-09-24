# Production Deployment

Production is **[socratictrade.com](https://socratictrade.com)** on Coolify app
**uuid `socratic-app`** (name "Socratic-Trade", branch `main`, dockerfile build pack).

**Host (current):** Coolify on the production fleet box (see private
`jaywedgeworth22/fleet-ops:ATTACK-MAP.md`; dashboard/API `https://host.jays.services`).

**Auto-deploy:** every push to `main` triggers Coolify via the repo webhook to
Coolify's **manual** GitHub webhook endpoint
(`https://host.jays.services/webhooks/source/github/events/manual`), not the
GitHub-App integration alone.  HMAC must match the app's
`manual_webhook_secret_github`.  Do **not** post deploy claims or manually
trigger deploys (ANNOUNCE-THEN-DEPLOY is retired).

**Coolify `watch_paths` (already live, 2026-08-18):** ASC applied the list
on `socratic-app` (see `fleet-ops:ATTACK-MAP.md`).  App stayed healthy.  No
bounce.  Do **not** re-apply from a PR.  Watched: `Dockerfile`,
`.dockerignore`, `package.json`, `package-lock.json`, `next.config.mjs`,
`postcss.config.mjs`, `tsconfig.json`, `middleware.ts`,
`instrumentation.ts`, `instrumentation-client.ts`,
`sentry.server.config.ts`, `sentry.edge.config.ts`,
`litestream.coolify.yml`, `src`, `src/**`, `app`, `app/**`, `public`,
`public/**`, `scripts`, `scripts/**`.  Omitted: `docs/**`, `STATUS.md`,
`PLAN.md`, `docs/rollouts`, `ios/`, `test/`.  Auto-deploy stays on.
Stop-old-first stays.  `health_check_start_period` stays 60.

**Weekday RTH latch:** Coolify still receives the webhook.  The Dockerfile
refuses the **image build before `npm ci`** during regular US equity hours
(Mon–Fri 09:30–16:00 ET, 09:30–13:00 ET on NYSE early-close days) unless
`HOTFIX=1` or `RTH_DEPLOY_OVERRIDE=1`.  `watch_paths` does not know about
market hours.  A refused build must not swap the named container.

Keep consistent container names and **stop-old-first**; do **not** enable
rolling / zero-downtime (two Litestream writers).  Docker HEALTHCHECK is
`GET /api/live` (process + SQLite).  Do not point Coolify HTTP health at
`/api/health` — that probe can 503 or exceed 15s while Next is up, which
is `running:unhealthy` and Cloudflare `no available server` (7:22–7:43pm
CT after #2810 on 2026-08-17).  Do not add the latch to
`scripts/coolify-prod-start.sh`.  Do not `FORCE_RESTORE`.  Do not bounce
the live box from an agent.  This repo does not PATCH live Coolify.

Canonical detail:

- `docs/rollouts/2026-07-10-auto-deploy-on.md`
- `docs/rollouts/2026-08-18-rth-deploy-latch.md` (weekday RTH build latch)
- `docs/rollouts/2026-08-07-hetzner-fleet-cutover.md` (and ops follow-up notes)
- `docs/rollouts/2026-08-02-deploy-webhook-secret-repair.md` (webhook signature drift)
- `AGENTS.md` → production / Coolify stanzas

## Deployment flow

1. A pull request passes the required `verify` check and merges to `main`
   (prefer `gh pr merge <n> --squash --auto`).
2. GitHub delivers the push to Coolify's manual webhook (HMAC-validated).
3. Coolify serializes builds (`concurrent_builds` pinned to **1**) and builds
   with the app's **Dockerfile** pack.  The first app step (before `npm ci`)
   is `tsx scripts/assert-rth-deploy-latch.ts`.  Unwatched paths (docs /
   STATUS / PLAN / ios / test) do not start a deploy (`watch_paths` already
   live).  Weekday RTH on a watched path exits 2 unless `HOTFIX=1` /
   `RTH_DEPLOY_OVERRIDE=1`.  A refused build must keep the last healthy
   named container.  Otherwise Coolify **stop-old-first** (consistent name,
   one Litestream writer) and starts `scripts/coolify-prod-start.sh` with
   `DB_BOOTSTRAP=live`.
   Traefik must see Docker `healthy` via `/api/live` once the process is
   up — a finished deploy must not sit `running:unhealthy` for extra
   minutes.
4. Boot injects Infisical secrets, restores SQLite when the marker-guarded
   bootstrap requires it, and runs Litestream around Next.js.  Live replica is
   Backblaze B2 (`jays-socratic-trade-eu`); R2 holds only the weekly
   `cold-snapshots/` DR object (`app-YYYY-MM-DD.db.gz` since #3135).

The retired Mac/PM2 publish path and Coolify PR previews are gone. Do not start
Mac `pm2` `trading` while Coolify runs `DB_BOOTSTRAP=live` (dual schedulers).

## Secrets and persistence

- Infisical is authoritative for production secrets.
- SQLite lives on the Coolify persistent volume at `/app/data`.
- Litestream → Backblaze B2 (live replica, `jays-socratic-trade-eu`).  Cloudflare
  R2 (`socratic-trade-bucket`) holds only the weekly `cold-snapshots/` DR lane
  (gzipped `app-YYYY-MM-DD.db.gz` since #3135; restore needs gunzip first).  The
  R2 free-tier kill-switch is R2-era only and does not apply once `AWS_S3_ENDPOINT`
  is B2.  `ENCRYPTION_KEY` must remain stable or stored credentials become
  undecryptable.

## Verify after merge

```bash
bash scripts/verify-deploy-sha.sh   # live sha contains your commit
curl -sS https://socratictrade.com/api/health
```

CI: GitHub-hosted `ubuntu-latest` only (no self-hosted Mac/Oracle runner labels).

## Deploy freshness (silent-freeze watch)

`verify-deploy-sha.sh` is the post-merge assertion (polls up to 25 min).  It does
not watch the pipeline afterwards.  On 2026-08-06 five Coolify deploys died
mid-build (SSH exec stream exit 255) while webhooks returned 200 and
`/api/health` stayed green on the old sha for ~14h.

`.github/workflows/deploy-freshness.yml` runs `scripts/alert-deploy-freshness.sh`
every 20 minutes.  It fails (Sentry fleet-infra + optional `#agent-sync`) when
the oldest commit on `origin/main` that is not live is older than 1 hour.
Unreachable health is not this class (UptimeRobot pages site-down).  The
workflow never deploys and never calls Coolify.

Manual one-shot:

```bash
bash scripts/alert-deploy-freshness.sh origin/main
```

## Shared-box OCR isolation

ST, Congress.Trade, and Usage Monitor still share the Hetzner cx43 (8 vCPU).
CT OCR / `scan-cpu-worker` batches on that box were the 2026-08-06 contention
correlate.

**Advised OCR ceiling: 5.0 of 8 vCPUs** (`--cpus=5`, cpu-shares 256).  That is
as high as is reasonably advisable: unconstrained OCR peaked at 2.83 cores, so
5.0 does not throttle normal work, and 3 cores stay free for Coolify SSH, ST
(including `next build`), UM, and CT web.  6.0+ is too high -- that is the
class that starved the Coolify exec stream.  CT compose today still pins the
worker at 2.0, which *does* throttle below the measured peak; raise
`scan-cpu-worker.cpus` to `5.0` there for the durable cap.

```bash
bash scripts/isolate-shared-box-batch.sh                  # dry-run; default 5 cpus
ISOLATE_SHARED_BOX_APPLY=1 bash scripts/isolate-shared-box-batch.sh --apply
```

The script never restarts a container and never matches Socratic-Trade, Coolify,
or Usage Monitor.  `--apply` requires the env latch.  `docker update` CPU limits
are ephemeral: the next CT Coolify recreate overwrites them unless compose
carries `cpus: '5.0'` on `scan-cpu-worker`.

**Remaining host constraint (this repo cannot lift it):**

- Durable isolation is that CT compose `cpus: '5.0'` (or the matching Coolify
  CPU limit) on `scan-cpu-worker`.  `congress-app` stays at 2.0.
- If OCR is in-process inside `congress-app-live`, this script finds no worker.
  `--include-app` caps the whole CT app (also caps CT web).
- Coolify has no job-level retry-on-exit-255 that this repo can set.  Do not
  take prod down to experiment.
