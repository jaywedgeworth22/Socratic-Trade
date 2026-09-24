# RTH drain actually nudges Coolify (2026-08-21)

## Summary

Socratic-Trade production sat on `e0a4959a73a7` (2026-08-20 17:53 UTC) while
`main` moved 39 commits ahead.  Coolify received the GitHub push webhooks
(HTTP 200) and started image builds.  The Dockerfile RTH latch correctly
refused every weekday-hours build (`rth-blocked`, keep last healthy
container).  The 21:20 UTC after-close drain then reported success without
ever nudging Coolify, so the latched HEAD never shipped.

## Why the drain was a no-op

`scripts/rth-deploy-drain.sh` tried GitHub hook redeliver with `GITHUB_TOKEN`
(no `admin:repo_hooks`) and `COOLIFY_DEPLOY_WEBHOOK_URL` (secret was not
set).  On failure it `exit 0`.  Deploy-freshness then paged STALE, grouped
into one Sentry fingerprint, and stopped alerting.  Same silent-freeze
class as #2545.

## What changed

- Drain uses `secrets.GH_PAT` for hook redeliver.
- Fallback: `POST /api/v1/deploy?uuid=…` with `secrets.COOLIFY_DEPLOY`
  (deploy-only token, never `COOLIFY_AGENTS`).
- `nudge_ok=0` now `exit 1` so a failed evening drain is a red check.
- Repo secrets set this session: `COOLIFY_DEPLOY`, `COOLIFY_ST_APP_UUID`.

The latch itself is unchanged.  Do not set `HOTFIX=1` / `RTH_DEPLOY_OVERRIDE=1`
to jump the queue during cash hours.

## Verify

```bash
# script contract
rg -n "exit 1" scripts/rth-deploy-drain.sh
npx vitest run test/rth-deploy-latch.test.ts

# after 21:20 UTC weekdays, or workflow_dispatch after 16:00 ET
curl -fsS -A 'Mozilla/5.0 (compatible; fleet-coolify/1.0)' \
  https://socratictrade.com/api/health \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["checks"]["release"]["sha"][:12])'
git -C ~/apps/trading-grok rev-parse origin/main
```

## Follow-ups

- Rotate ST Coolify `manual_webhook_secret_*` (github/gitea/gitlab/bitbucket)
  — they appeared in a 2026-08-21 debug dump.  Then paste the new GitHub
  secret onto hook `662359267`.
- Teach `alert-deploy-freshness.sh` that an RTH-latched gap is in-flight,
  not STALE (board P2 from the same DeepSeek audit).
