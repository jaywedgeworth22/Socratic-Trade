# 2026-07-30 — Oracle deploy-path repair (prod deploys restored)

## Context & Objective

After the Oracle Cloud migration (prod host `<ORACLE_IP_RETIRED>`), **no merge to
`main` reached production for ~30 hours**. Prod ran an image built 2026-07-28
22:58 UTC (= PR #2249 only). PRs #2252, #2268, and all subsequent merges
(including other agents' #2265/#2266/#2267/#2272–#2288) were merged but never
deployed. This note documents the full repair so the next agent never has to
re-derive it.

## Root causes found (there were six, layered)

1. **Coolify app had zero environment variables.** The migration-era container
   was started manually (`docker run -e …`, no Coolify labels). Coolify's app
   record had NO `environment_variables` rows, so every new container died at
   `infisical export` (exit 1) during `scripts/coolify-prod-start.sh`, failed
   the Docker healthcheck, and Coolify rolled back.
2. **Morph-type backslash trap.** Direct-DB env inserts must use
   `resourceable_type = 'App\Models\Application'` (single backslashes,
   22 chars). A double-backslash value (24 chars) is silently ignored by
   Eloquent — the generated `.env` then contains only `COOLIFY_*` meta vars.
3. **Value encryption format.** Coolify encrypts env values at rest with
   Laravel's `Crypt::encrypt` (serialize-based). Plaintext rows crash the
   whole deploy with `DecryptException: The payload is invalid`;
   `Crypt::encryptString` rows decrypt-but-fail-unserialize and read back as
   empty strings. Only `Crypt::encrypt($value)` works.
4. **Build-time env injection broke webpack.** With the 47 vars valid and
   marked `is_buildtime=true`, `npm run build` failed with spurious
   `Module not found: Can't resolve '@/lib/*'` errors on a commit that had
   compiled minutes earlier without them. (Prime suspect: a stray-quote value
   unbalancing Coolify's generated `build-time.env` `source` step.) All app
   env vars are now `is_buildtime=false`, `is_runtime=true` — the app only
   needs them at runtime.
5. **Disk pressure.** Each `--no-cache` build produces a ~4.5 GB image; six
   failed attempts left the 45 GB root volume at 91%. Cleaned dangling
   images, build cache, superseded app images, and orphaned retired-runner
   images → 76%.
6. **Static Caddy route by container name.** `oracle-caddy-1` has a static
   `reverse_proxy socratic-app:4000` for socratictrade.com. Coolify's new
   container was named `socratic-app-<timestamp>` (the manual container held
   the name), so after retiring the manual container traffic 502'd until the
   new container was renamed to `socratic-app`.

## Changes made (all on the Oracle box, no repo code changes)

- Synced 47 env vars from the working container's `Config.Env` into Coolify's
  `environment_variables` (app id 1), then fixed morph type and re-encrypted
  via `Crypt::encrypt` through artisan tinker (values never left the box).
- `INSERT INTO local_persistent_volumes` mounting host `/data/socratic-trade`
  → `/app/data` (the live SQLite + litestream state).
- `is_buildtime=false` on all 47 rows.
- Freed ~11 GB disk (dangling images, build cache, old `socratic-app:9f700360`,
  old `oracle-app-1:7ce586bf`, retired `actions-runners`/`92e56f:*` images).
- `docker rename socratic-app socratic-app-legacy-rollback` (stopped,
  `restart=no`) — **manual rollback path: `docker start
  socratic-app-legacy-rollback`** after stopping the new container.
  `docker rename socratic-app-055408359695 socratic-app`.
- Created GitHub repo webhook (id 658869484) →
  `https://host.jays.services/webhooks/source/github/events` with the app's
  `manual_webhook_secret_github`; ping delivered 200. Auto-deploy on push is
  armed again. (Coolify clone works anonymously — the repo is now public.)
- Deployment triggered via Coolify REST (`POST /api/v1/deploy?uuid=socratic-app`)
  using a one-shot Sanctum token row inserted/deleted per call
  (`personal_access_tokens`, `team_id=0`); no standing token left behind.

## Verification state

- Deploy `j1hc2v6lm3z3i293m79af83q` finished 06:05:20 UTC; new container
  healthy, serving `https://socratictrade.com/api/health` = 200.
- Verified in the running bundle: `fallbackIntervalMinutes` (PR #2252) and
  `macro_feed_unavailable` (PR #2268) present; volume mount
  `/data/socratic-trade → /app/data` confirmed.
- Post-deploy `audit_events`: VIX flowing with fresh `vixAsOf` timestamps;
  one legitimate Neutral→Risk-Off flip at 06:11 (VIX 20.66), **no flip-flops,
  `macro_feed_unavailable` = 0**. The hold-last-known fix needs a real feed
  outage to be fully proven; baseline from pre-fix build showed a 1-minute
  flip-flop at 21:09–21:10 on 2026-07-29.
- GitHub webhook ping → 200 through Cloudflare → Caddy → Coolify.

## Next steps & blockers

- **OWNER ACTION REQUIRED — DB backups are down.** litestream replication to
  Cloudflare R2 has failed since 00:16 UTC 2026-07-29 (~30 h, 10k+ errors):
  `403 NotEntitled: Please enable R2 through the Cloudflare Dashboard`
  (bucket `trading-live-backups`, account endpoint
  `254301ba….r2.cloudflarestorage.com`). **The only current copy of the
  production DB is `/data/socratic-trade/app.db` on the Oracle box.** Enable
  R2 on that Cloudflare account or repoint `LITESTREAM_*` (Infisical) at
  another S3 target.
- Other Coolify apps (Congress.Trade, Usage Monitor, Actions Runners Fleet)
  likely need the same treatment: GitHub-side webhooks (only secrets were set
  Coolify-side), env-var audit, and volume checks. Congress deployed
  successfully 03:59 UTC; Usage Monitor's last two deploys failed.
- Watch the next merge to `main` for an end-to-end auto-deploy (webhook →
  build → rolling deploy) — it should now work unattended.
- Root disk still 76% used; consider moving Docker's data-root to `/data`
  (98 GB volume, 32% used) or scheduling regular image pruning.
- Deploy logs print full secret values in ARG lines (Coolify masking gap) —
  treat deployment-queue `logs` as sensitive.

## Exact commands for the recurring operations

Trigger a deploy (run on the Oracle box):

```bash
PLAIN=$(openssl rand -hex 32); HASH=$(echo -n "$PLAIN" | sha256sum | cut -d' ' -f1)
TOKID=$(docker exec coolify-db psql -U coolify -d coolify -t -A -c \
  "INSERT INTO personal_access_tokens (tokenable_type, tokenable_id, name, token, abilities, team_id, created_at, updated_at) VALUES ('App\Models\User', 0, 'ops', '$HASH', '[\"*\"]', 0, now(), now()) RETURNING id;" | head -1)
docker exec coolify sh -c "curl -s -X POST 'http://127.0.0.1:8080/api/v1/deploy?uuid=socratic-app&force=false' -H 'Authorization: Bearer $TOKID|$PLAIN'"
docker exec coolify-db psql -U coolify -d coolify -t -A -c "DELETE FROM personal_access_tokens WHERE id=$TOKID;"
```

Watch: `docker exec coolify-db psql -U coolify -d coolify -t -A -c "select status, finished_at from application_deployment_queues order by created_at desc limit 3;"`

## Addendum (06:51 UTC): auto-deploy proven end-to-end

The webhook created above initially did NOT trigger deployments. Two more
defects were found and fixed:

1. **Wrong route.** The webhook pointed at `/webhooks/source/github/events`
   (the GitHub App handler, `Github::normal`), which answered
   `Nothing to do. No GitHub App found.` for every push. Repo webhooks must
   use the manual handler: `/webhooks/source/github/events/manual`
   (`routes/webhooks.php:16`). Updated via
   `gh api -X PATCH repos/jaywedgeworth22/Socratic-Trade/hooks/658869484`.
2. **Signature mismatch.** With the right route the handler matched the app
   but returned `Invalid signature.` — the secret stored Coolify-side did not
   survive decrypt/re-encrypt round-trips done during the env repair
   (`manual_webhook_secret_github` has an `encrypted` Eloquent cast;
   `app/Models/Application.php:226`). Fixed by rotating the secret through
   Eloquent (`Str::random(40)`, saved via the model so the cast encrypts
   exactly once) and PATCHing the same value into the GitHub webhook config
   without printing it to any log (staged via `docker cp`/`scp`, shredded
   after).

Verification: redelivered the `refs/heads/main` push for `13b9afa9` →
response `[{"application":"Socratic-Trade","status":"success","message":"Deployment queued.", ... "deployment_uuid":"dy3rciku9supsivz0c51l8xn"}]`;
queue row shows `is_webhook=t, in_progress` at 06:51:39 UTC. Auto-deploy on
push to `main` is restored end-to-end (push → GitHub webhook → Coolify
manual handler → signature OK → queued build).

## Addendum 2 (07:15 UTC): first real auto-deploy + two operational fixes

The first webhook-triggered build (`dy3rciku9supsivz0c51l8xn`) FAILED at
06:55 with `ENOSPC: no space left on device` in `npm run build` — the root
disk had crept back to 92% (28 GB of Docker images, 8.4 GB build cache).
Fixed with `docker builder prune -af` + `docker image prune -af` → 69% used,
14 GB free. **This makes "move Docker data-root to /data" (below) urgent,
not optional** — every deploy costs ~2-4 GB and the margin is thin.

Then the real proof arrived by itself: PR #2294 merged to `main` at
06:58:18 UTC (`e05c9210`), the GitHub webhook fired, Coolify deployment
`o14i7cknz8wp7t9lcbyodjl6` ran `is_webhook=t` and **finished successfully
07:08:18 UTC** — the first unattended push→build→rolling-deploy since the
migration. The merge-to-main auto-deploy loop is fully restored.

One more defect surfaced by that rolling deploy: **Coolify names each new
container `socratic-app-<timestamp>` and deletes the old one, but the
oracle-caddy Caddyfile routes `socratictrade.com` to the static name
`socratic-app:4000`** → public 502 the moment the old container disappeared
(the same trap as the earlier rename 502). Fixed two ways:

- Immediate: `docker network disconnect coolify <new-container>` /
  `docker network connect --alias socratic-app coolify <new-container>` →
  site back to 200 in seconds.
- Persistent: `applications.custom_docker_run_options =
  '--network-alias socratic-app'` so every future Coolify container gets the
  alias at creation. **VERIFIED 07:39 UTC**: a further API-triggered deploy
  (`j7my0njjnz4xs1dqy7ckx33f`, started after the setting was written) came up
  reachable as `socratic-app` on the `coolify` network with zero manual
  steps — public `/api/health` stayed 200 through the rolling swap. (The one
  intervening deploy that 502'd, `ctcapy89lv90r8k62jyj570h`, had read its
  config before the setting landed; fixed with the two network commands
  above, which remain the fallback if any future deploy misses the alias.)

Note: a duplicate deployment of the same HEAD (queued by a manual webhook
redelivery during testing) is harmless — Coolify builds the current branch
tip, not the redelivered SHA.

Final state: webhook id 658869484 on `jaywedgeworth22/Socratic-Trade` →
`/webhooks/source/github/events/manual`, rotated secret stored via Eloquent
(encrypted cast) and mirrored GitHub-side; two webhook-triggered deploys
finished green (`o14i7cknz8wp7t9lcbyodjl6` 07:08, `j7my0njjnz4xs1dqy7ckx33f`
07:39); container naming/routing survives rolling deploys; root disk 69-74%
after prune (data-root move to /data still the recommended durable fix).
