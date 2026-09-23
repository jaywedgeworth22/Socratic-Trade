# 2026-07-31 — Hetzner servers deleted (ci-cpx32 + old prod box): formal retirement

## Context & Objective

The owner deleted **both Hetzner servers** on 2026-07-31: the CI build box
`ci-cpx32` (`77.42.35.209`, Coolify server uuid `<CI_COOLIFY_SERVER_UUID>`) and
the original prod host (`<HETZNER_OLD_IP_RETIRED>`, already retired in the July Oracle
migration). This note is the formal in-repo retirement so no agent wastes time
SSHing into, monitoring, or referencing dead boxes.

## Changes Made

- **Deleted `scripts/monitor-coolify-runners.sh`** — its whole purpose was
  watching ci-cpx32's systemd runners + the Hetzner prod host. Fleet CI is
  GitHub-hosted (`ubuntu-latest`) for this repo since 2026-07-29; runner
  health is now `gh run list` / `gh api repos/.../actions/runners`.
- **Deleted `scripts/ops/fleet-site-watchdog.sh`** — ran as a systemd unit on
  the deleted Hetzner box. (The recurring Coolify-container-name/Caddy 502 it
  indirectly papered over is now handled on the Oracle box by
  `/usr/local/bin/socratic-caddy-alias.sh` + cron — see
  `docs/rollouts/2026-07-30-oracle-deploy-path-repair.md` follow-ups.)
- **`scripts/sync-provider-knobs.sh`** — defaults now `ubuntu@<ORACLE_IP_RETIRED>`
  + `~/.ssh/id_ed25519`, with an explicit NOTE that the remote read/apply path
  needs rework: on Oracle there is no `/data/coolify` tree; the app env lives
  encrypted in Coolify's Postgres (`environment_variables`) — use the
  artisan-tinker `Crypt::encrypt` pattern from
  `docs/rollouts/2026-07-30-oracle-deploy-path-repair.md`. `--apply` should be
  considered unsafe until that rework lands.
- **`AGENTS.md`** — added a "Hetzner servers DELETED (owner directive,
  2026-07-31)" stanza; replaced the "run monitor-coolify-runners.sh often"
  section with GitHub-API-based guidance.
- **`ci-pending/sentry-ci-report.yml`** — refreshed the stale ci-cpx32 /
  `socratic-ci` comment (the live workflow still says it; the push token has
  no `workflow` scope, so the file is staged for owner activation:
  `gh auth refresh -s workflow && cp ci-pending/sentry-ci-report.yml .github/workflows/`).

## GitHub-side verification (nothing to clean up)

- `gh api repos/jaywedgeworth22/{Socratic-Trade,Congress.Trade,API-Usage-Monitor,Congress-Trading-Shared}/actions/runners`:
  no registrations from the deleted boxes remain. The only runners are the
  fleet's Oracle-hosted `oracle-{socratic,congress,usage,shared}-ci` (ARM64,
  online) used by the *other* repos — this repo's workflows are all
  `ubuntu-latest`.
- DNS: `host.jays.services` / `jays.services` are Cloudflare-proxied to the
  current infrastructure; no records point at the deleted IPs.
- `/Users/jay/apps/AGENT-SYNC.md` + `~/apps/README.md`: no ci-cpx32/Hetzner
  references — no edits needed there.

## Verification State

- `git rm` + doc edits only; no application code touched.
- Nothing in `src/`, `test/`, `package.json`, or `.github/` referenced the two
  deleted scripts (grep-verified before deletion).

## Next Steps & Blockers

- Owner: activate `ci-pending/sentry-ci-report.yml` (comment-only refresh;
  zero behavior change) when convenient — same for the older
  `ci-pending/e2e.yml` + `ci-pending/effort-issues-sync.yml` stagings.
- `scripts/sync-provider-knobs.sh --apply` needs the Coolify-DB rework noted
  above before use against prod.
