# 2026-07-10 - Provider-knob sync: API-Usage-Monitor -> Infisical prod

## Summary

Added the Mac-side "provider-knob sync": a script + launchd template that make the
**API-Usage-Monitor app the source of truth** for market-data subscription plans,
syncing each plan's env-knob values into **Infisical prod** (where the trading app
reads all provider quotas/rate-limits, seeded 2026-07-10).

New files:

- `scripts/provider-knob-diff.mjs` - pure, unit-tested diff/plan engine. Turns the
  monitor's `/api/subscriptions` payload into the desired knob map, applies the
  guards, and diffs against current Infisical state. No network / no fs at module
  scope, so it is fully testable.
- `scripts/sync-provider-knobs.sh` - ASCII-only (bash 3.2-safe) orchestrator:
  fetch subscriptions, compute desired, read current from Infisical over the proven
  SSH + universal-auth CLI path, write only diffs, post one `#agent-sync` line per
  applied change.
- `scripts/com.jay.provider-knob-sync.plist` - launchd template (30-min interval,
  `--apply`). **NOT installed** by this change; install command below.
- `test/provider-knob-diff.test.ts` - vitest coverage of the pure engine
  (guards, status semantics, conflicts, diff-only-writes).

## Why

The env knobs that pace/limit each market-data provider (`PROVIDER_QUOTA_*`,
`PROVIDER_RATE_LIMIT_*`, `MASSIVE_*`, `TIINGO_DROP_NEWS`,
`FINNHUB_DROP_RECOMMENDATION`, `ALPACA_DATA_FEED`) were seeded into Infisical prod
2026-07-10 (`docs/market-data-provider-pricing.md`, "Where the dials live"). Which
plan we are actually on - and therefore which knob values are correct - is tracked
in the API-Usage-Monitor. This closes that loop automatically: when a subscription
is bought / canceled / paused in the monitor, the trading app's quotas follow,
without a human hand-editing Infisical.

Knob values are injected at app boot, so a write here takes effect on the next prod
deploy/restart ("rides next deploy").

## Sync-rule semantics (shipped)

Per subscription element (`provider{id,name,displayName}`, `name`, `status`,
`knobEnv`, `freeTierKnobEnv`):

| status | desired knob source |
|---|---|
| `active` | `knobEnv` |
| `canceled` / `paused` | `freeTierKnobEnv` |
| `considering` | skip (not bought) |
| unknown / null map | skip (fail safe) |

- **Write ONLY diffs.** Current Infisical values are read first; a key is written
  only when the desired value differs (or the key is absent -> first-time write).
  Keys present in Infisical but not desired are never touched/removed.
- **Two hard guards** against a buggy or compromised monitor payload:
  1. **Key allow-list** (`ALLOWED_KEY_RE` in the .mjs, re-applied on the box before
     every write): `^(PROVIDER_QUOTA_|PROVIDER_RATE_LIMIT_|MASSIVE_|TIINGO_DROP_NEWS$|FINNHUB_DROP_RECOMMENDATION$|ALPACA_DATA_FEED$)`.
     Anything else (e.g. `OPENAI_API_KEY`) is rejected, never written.
  2. **Value charset** (`^[A-Za-z0-9_.:+/-]+$`, 1..256 chars): quota numbers /
     `true|false` / feed names only; rejects whitespace, quotes, `$`, `;`,
     backticks - defends the value later passed to `infisical secrets set KEY=VALUE`.
- **Conflict policy:** if two plans assert the same key with different values, the
  key is dropped (not guessed) and recorded. Same key + same value is fine.
- **Dry run by default:** with no flag the script prints the diff and exits 0,
  writing nothing and posting nothing. `--apply` performs the writes.
- **On each applied change**, one line to `#agent-sync`:
  `repo: Socratic-Trade | [CLAUDE->FLEET] knob-sync applied: KEY old->new (plan <name> <status>); rides next deploy`

## Infisical write path (mirrors the proven universal-auth flow)

`sync-provider-knobs.sh` reaches Infisical exactly like `scripts/infisical-run.mjs`
/ `scripts/infisical-prod-cutover.sh`:

1. `ssh -i ~/.ssh/hetzner root@<HETZNER_OLD_IP_RETIRED>` to the Coolify box.
2. On the box, read `INFISICAL_CLIENT_ID/CLIENT_SECRET/PROJECT_ID/ENV/PATH` from
   `/data/coolify/applications/m1os7ijf31bg3fanil152e4b/.env` (creds never leave the
   box, never printed).
3. `infisical login --method=universal-auth --plain --silent` (creds passed via
   `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID/SECRET` env, not argv) to mint a short-lived
   token.
4. **Read:** `infisical export --format dotenv | grep <allow-list>` so only the
   allow-listed knob keys ever leave the box (no unrelated secret transits to the Mac).
5. **Write:** `infisical secrets set KEY=VALUE --projectId --env prod --path /` for
   changed keys only, re-guarding the key on the box first.

The usage-monitor Bearer token (`USAGE_INGEST_TOKEN` from
`~/.secrets/usage-monitor.env`) is loaded into a 0600 curl config file, never placed
on argv, and dropped from the shell after the fetch.

## launchd install (owner action - NOT done here)

```bash
# 1. edit paths in the plist if the repo is not at /Users/jay/Code/Socratic-Trade
# 2. (optional) add SLACK_BOT_TOKEN to EnvironmentVariables to enable the Slack post
cp scripts/com.jay.provider-knob-sync.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.jay.provider-knob-sync.plist
# dry-run first to confirm the diff before trusting the writer:
bash scripts/sync-provider-knobs.sh
# logs: ~/Library/Logs/provider-knob-sync.log
```

Uninstall: `launchctl unload -w ~/Library/LaunchAgents/com.jay.provider-knob-sync.plist && rm ~/Library/LaunchAgents/com.jay.provider-knob-sync.plist`.

The job is safe to leave running: monitor-unreachable or in-sync runs exit 0 and
write nothing.

## Files

- `scripts/provider-knob-diff.mjs` (new)
- `scripts/sync-provider-knobs.sh` (new)
- `scripts/com.jay.provider-knob-sync.plist` (new)
- `test/provider-knob-diff.test.ts` (new)
- `STATUS.md`, `docs/EFFORT-LOG.md`, `/Users/jay/apps/TRADING-EFFORT-LOG.md` (boards)

## Verification

- `bash -n scripts/sync-provider-knobs.sh` - clean.
- `node --check scripts/provider-knob-diff.mjs` - clean.
- `grep -nP '[^\x00-\x7F]' scripts/sync-provider-knobs.sh scripts/provider-knob-diff.mjs`
  - shell + mjs code paths pure ASCII (only .mjs comment prose has em dashes, which
  never touch a `$VAR`; no non-ASCII in `scripts/*.sh`).
- `plutil -lint scripts/com.jay.provider-knob-sync.plist` - OK.
- Manual `--plan` / `--desired` runs against a synthetic payload: correct diffs,
  guards reject `OPENAI_API_KEY` + injection value, `considering` skipped, only
  real diffs emitted.
- Full gate via `scripts/land.sh` (tsc -> vitest -> build) under node@24 (the
  homebrew default node is 26; the better-sqlite3 ABI trap means gates must run with
  `/opt/homebrew/opt/node@24/bin` on PATH).
- **NOT run:** the script was never executed with `--apply` against prod, and the
  launchd job was not installed (per task scope).

## Contract assumptions to re-verify once the monitor-side PR merges

The monitor's `GET /api/subscriptions` is api-usage-monitor **PR #83** (up as of
2026-07-10; GET shape reported to match this contract - bare array, `knobEnv` +
`freeTierKnobEnv` per element, Bearer `USAGE_INGEST_TOKEN`). That repo is
**merge-frozen on a pre-existing `migrate-safe.mjs` deploy blocker**, so this sync
stays DRY-RUN until #83 is deployed and one live dry run confirms the real payload.
This code assumes:

1. **Response shape:** bare JSON array; each element has `provider{id,name,displayName}`,
   `name`, `status`, `knobEnv` (object of `ENV_NAME->string`, may be null),
   `freeTierKnobEnv` (object, may be null).
2. **Status vocabulary:** `active` | `paused` | `canceled` | `considering`. Any other
   value is treated as skip (fail safe) - confirm no other statuses drive knobs.
3. **Auth:** `Authorization: Bearer <USAGE_INGEST_TOKEN>` (the read var name in
   `~/.secrets/usage-monitor.env` is `USAGE_INGEST_TOKEN`). If the monitor exposes a
   distinct read-only token var, point `sync-provider-knobs.sh` at it.
4. **Knob key names** the monitor emits must stay inside the allow-list; any new knob
   family (e.g. a new `PROVIDER_QUOTA_*`) is covered by the prefixes, but a brand-new
   non-prefixed knob would be silently rejected until added to `ALLOWED_KEY_RE` (and
   the mirrored grep in the shell). Keep the two in sync.
5. **Box read path:** assumes the `infisical` CLI is resolvable on the Coolify box
   host (the read/write remote snippets probe common locations). If it is only inside
   the container, switch the remote to `docker exec`.

## Follow-ups

- Owner: install the launchd job when ready (command above), after a dry run.
- Once the monitor PR merges, run one dry run end-to-end against the live endpoint to
  confirm the real payload matches the contract, then enable `--apply`.
- `docs/market-data-provider-pricing.md` (now on `main`) has its "Where the dials
  live" note updated by this PR: the Mac-side sync (this change) has shipped and is
  gated on the monitor's `/api/subscriptions` endpoint. Flip it to fully "live" once
  the monitor PR merges and a dry run confirms the real payload.
