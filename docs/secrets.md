# Secrets: source of truth

> Owner directive 2026-09-18: **Infisical is the sole source of truth for every secret.** No `.env`
> files anywhere — not `.env`, `.env.local`, `.env.production`, `.env.*`, `.env.yml`, or
> `.env.yaml`. The committed `.env.example` is bootstrap-only (Infisical machine identity +
> `ENCRYPTION_KEY` + the optional `REQUIRE_SECRETS_MANAGER` arming flag); every other operator
> knob, feature flag, provider key, broker credential, RAG fuse, and per-lane budget moved to
> Infisical (shared / shared-at-ct / app projects), per-user Settings, or in-code defaults.
> See `docs/rollouts/2026-09-18-strict-infisical-no-env-files.md` for the migration and
> `test/no-env-loader-or-dotenv-yaml.test.ts` for the regression guard.

## Three secrets homes

| Layer | Provider | What's there | Examples |
|---|---|---|---|
| Bootstrap (the box) | `~/.secrets/global-api-keys` (chmod 600) + `process.env` | Infisical machine identity only — Client ID + Client Secret (universal auth) | `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `INFISICAL_TOKEN`, `INFISICAL_PROJECT_ID`, `INFISICAL_ENV`, `ENCRYPTION_KEY` |
| Shared fleet | Infisical `shared` project | Coordination keys shared across ST/CT/UM | `AGENT_SYNC_*`, Slack bot token, shared Coolify read-only stats token |
| App runtime | Infisical `Socratic-Trade` `prod` `/` (via runner) | Broker creds, provider keys, RAG fuses, feature flags, telemetry tokens | `ALPACA_*`, `FINNHUB_*`, `MASSIVE_*`, `SENTRY_DSN`, `RAG_*`, `EARNINGSCALLS_*` |
| Per-user | User Settings (`user_settings` row + `user_api_keys` table) | User-scoped runtime data | per-account LLM model, per-user LLM key, per-account policy, per-user Data source opt-ins |

**LLM runtime keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) are NOT Infisical secrets for this
app** — they belong on the user's Connections page (`user_api_keys`). Deleted from Infisical
2026-08-15 (GEMINI/DEEPSEEK were the last remaining); `scripts/infisical-secrets-safe.sh set`
refuses those names. The owner keeps exactly one key per provider per app, with spend caps
deliberately configured; agent provisioning is a fleet rule (see AGENTS.md "NEVER create a new
provider API key").

## How it works

`npm run start:secrets` starts `scripts/infisical-run.mjs`. In the normal non-watch path, the runner
authenticates, calls `infisical export` with a minimal CLI-only environment, merges the exported
values over the app's ambient environment, and starts the requested command through
`scripts/infisical-app-child.mjs`. Shared-overlay mode exports both projects the same way and lets
the app project win overlaps. `INFISICAL_WATCH=true` is the exception: the Infisical CLI owns its
watch loop and starts the same final wrapper after each injection. Every path sets
`SECRETS_SOURCE=infisical` before Next boots.

Exports use the CLI's JSON format rather than reparsing dotenv text, preserving multiline values,
quotes, backslashes, and whitespace exactly. Pinned Infisical CLI v0.43.98 emits a JSON array of
secret records; the runner copies only each record's validated string `key` and `value` and ignores
metadata. Non-array shapes, malformed or duplicate entries, invalid environment keys, and NUL bytes
fail with raw CLI output suppressed.

**Auth (per project):** the runner authenticates the machine identity with its **Client ID + Client
Secret** (universal auth, long-lived) — set `INFISICAL_CLIENT_ID` + `INFISICAL_CLIENT_SECRET` and it
exchanges them for a fresh access token on every launch via `infisical login --method=universal-auth
… --plain`, then passes that token only to the required `export` or watch operation (nothing expires
between deploys). A pre-minted `INFISICAL_TOKEN` (a short-lived JWT) is still accepted as a fallback.
**The Client Secret is not the access token** — pasting a 64-char Client Secret into
`INFISICAL_TOKEN` is the "malformed token" 403; use the Client ID + Secret pair instead. Within one
precedence source, a complete Client ID + Secret pair wins over a stale token.

### Local machine-identity bootstrap

`scripts/infisical-run.mjs` must authenticate before Next starts, so it resolves its own small
bootstrap set first. Precedence is explicit process environment, then the owner-local
`~/.secrets/global-api-keys` file (chmod 600, fixed path, not overridable). The bootstrap handoff
file is the documented identity store for cloud-agent seats that boot without an Infisical round
trip; it is NOT a `.env` file and is not blocked by `test/no-env-loader-or-dotenv-yaml.test.ts`.

Only recognized Infisical bootstrap assignments are parsed as inert dotenv data; quote state
prevents key-looking lines inside unrelated multiline values from being reinterpreted; indented /
unrelated one-line data and provider/API keys are ignored and never copied into `process.env` or
child processes. The file is an assignment store, not a shell program: multiline shell blocks and
heredocs fail closed rather than being approximately parsed.

The generic runner names remain `INFISICAL_CLIENT_ID` + `INFISICAL_CLIENT_SECRET` for the app and
`INFISICAL_SHARED_CLIENT_ID` + `INFISICAL_SHARED_CLIENT_SECRET` for the shared overlay when supplied
through the process environment. The shared machine file is narrower: it accepts only
`INFIISICAL_ST_*` (the owner-provided extra-I spelling) or corrected `INFISICAL_ST_*` for this app,
and `INFISICAL_CT_SHARED_*` for the shared project. It does not import generic app/shared names,
tokens, project IDs, runtime controls, provider keys, or cross-app credentials from that broad file.
The resolver normalizes the selected pair in memory only, never prints/copies a value, and refuses a
higher-precedence half-pair instead of combining fields across files.

The runner snapshots the selected identity, immediately removes every bootstrap credential from its
own long-lived `process.env`, and clears each auth object after its synchronous token mint/copy. The
CLI probe/login/export environment is a small OS/network allowlist plus only the credential needed by
that operation; ambient provider, GitHub, Slack, broker, and cross-app secrets never transit the
Infisical CLI. Raw login/export failure output is suppressed because a CLI could echo its
environment. Normal and overlay application children still receive their ambient app environment
directly from the trusted runner plus Infisical exports. Watch mode intentionally receives only the
small runtime allowlist plus Infisical-managed values, so credentials needed by a watched app must be
stored in Infisical rather than inherited from the shell. `INFISICAL_DOMAIN` is retained explicitly
for EU/self-hosted routing while remaining masked from the final app.

Before starting the Node final wrapper, `/usr/bin/env` removes `NODE_OPTIONS`, `BASH_ENV`, and `ENV`
so injected preload hooks cannot execute before bootstrap masking. The wrapper then restores the
intended `NODE_OPTIONS` only after installing every empty mask, preserves command argv without shell
evaluation, and forwards termination signals through the process chain. Normal export mode safely
restores the manager-winning `NODE_OPTIONS`; watch mode cannot inspect dynamic injected values before
the CLI spawns its child, so it deliberately discards an Infisical-injected `NODE_OPTIONS` and
restores only the pre-Infisical host value after masking.

The global path is fixed at `~/.secrets/global-api-keys`; an ambient `GLOBAL_API_KEYS_FILE` override
is ignored and scrubbed (tests can dependency-inject a temporary path directly into the resolver).
Before reading, the resolver checks `lstat`, opens with no-follow semantics, and verifies the opened
descriptor still identifies the same current-user-owned regular file. It rejects live/broken
symlinks, directories/devices/FIFOs, group/other permission bits, duplicate managed assignments, and
files over 1 MiB. Managed assignments are parsed with Node's dotenv parser as inert data; quotes,
command substitutions, backticks, semicolons, and other shell-looking text are never sourced or
evaluated.

The Socratic-Trade project defaults to `39d93bb7-76f9-498c-8b50-a7def52e072f`. The shared project
defaults to `18f563a3-9c88-454c-96eb-28fc9678f3ba` only when shared credentials are actually present
(or an operator explicitly sets `INFISICAL_SHARED_PROJECT_ID`), so app-only setups do not
accidentally enable an inaccessible overlay. A shared overlay without an explicit app identity/token
fails before either project is fetched. `scripts/cloud-setup.sh` runs a value-free bootstrap check
after seeding local defaults; a missing identity remains valid for keyless local UI work, but
any recognized incomplete pair fails closed before an Infisical CLI call.

### Primary-account Usage Monitor bridge (default off)

The optional writer in `src/lib/st-primary-bridge-writer.ts` is separate from
the app/bootstrap and shared-overlay identities above. It reads API-key rows
only for the compile-time primary user `LOCAL_USER` (`local`, the owner's
`mail@jays.services` account) and only the canonical `gemini` and `deepseek`
services. No request, manifest, environment variable, or route body can select
another user or add another provider.

Its destination is also fixed in code: Socratic-Trade project
`39d93bb7-76f9-498c-8b50-a7def52e072f`, environment `prod`, path
`/usage-monitor/st-primary/v1`. Enablement requires all three runtime values:

```bash
INFISICAL_ST_PRIMARY_WRITER_ENABLED=true
INFISICAL_ST_PRIMARY_WRITER_CLIENT_ID=...
INFISICAL_ST_PRIMARY_WRITER_CLIENT_SECRET=...
```

Use a dedicated project-managed identity: project membership role `no-access`,
then an identity-specific additional privilege scoped to exactly `prod` and
`/usage-monitor/st-primary/v1` with only secret `read`, `readValue`, `create`,
and `edit`. Do not grant delete, broader paths, project administration, or
identity administration. API Usage Monitor needs a separate identity with only
`read` and `readValue` on that same exact path. The writer identity pair is an
application feature credential (not a runner bootstrap alias) and may be stored
as managed production runtime secrets; it is never accepted from a browser or
from the broad local global-key bootstrap parser.

The writer publishes exactly `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, and a strict
`BRIDGE_MANIFEST_V1`. Active values are written and read-back-verified before
the manifest is committed last. The manifest carries only SHA-256
fingerprints, a monotonic sequence, and active/revoked status; it never carries
the key values. Revocation is a keyless manifest tombstone, not a remote secret
delete, matching the writer's intentionally delete-free privilege. Invalid,
partial, replayed, rolled-back, unexpected-path, or concurrently changed state
fails closed so the monitor retains its last-known-good complete generation.
The scheduler reconciles every five minutes while enabled, retries failures
after one minute, and key changes for the primary Gemini/DeepSeek rows queue an
immediate best-effort reconciliation.

## Enforcement (fail-closed boot guard)

`src/lib/secrets-source.ts` exposes `assertSecretsManagerIfRequired()`; it's called from
`instrumentation.ts:51` at the top of the `nodejs` boot path, before any other credential is read.
When `REQUIRE_SECRETS_MANAGER=1` is set, the app refuses to boot unless `SECRETS_SOURCE=infisical`
(i.e. it was launched through `start:secrets` or `dev:secrets`).

- **Prod Coolify (`socratic-app`):** armed. `scripts/coolify-prod-start.sh` exports
  `REQUIRE_SECRETS_MANAGER=1` in the phase-2 re-exec under `infisical-run.mjs` (line ~117), so the
  policy is visible at the shell level instead of buried in Infisical config.
- **Local dev / tests / CI:** OFF (default). Plain `npm run dev` still works for tests and
  UI-only development. To load keys, run `npm run dev:secrets`.
- **Escape hatch:** unset `REQUIRE_SECRETS_MANAGER` (Infisical) or comment the export in
  `coolify-prod-start.sh` for a single rebuild during a recovery drill. Document any change in
  `docs/rollouts/`.

## What this means for a fresh cloud seat

`scripts/cloud-setup.sh` is the canonical setup for Claude Code cloud, devcontainers, Codespaces,
and throwaway clones. As of 2026-09-18:

1. `npm ci` (deterministic install).
2. Bootstrap check: `node scripts/infisical-bootstrap-env.mjs` resolves the Infisical machine
   identity from process env OR `~/.secrets/global-api-keys` (if present). Cloud VMs without the
   handoff file silently no-op here — keyless local UI work is fine; any LLM/broker provider needs
   the identity in place.
3. Slack coordination `SETUP` (SessionStart hook) — non-fatal skip on hiccup.
5. Final echo: `npm run dev:secrets   (Infisical runner on :3000)`. Plain `npm run dev` is for
   tests-only; it no longer reads `.env.local`.

A `predev` hook (`scripts/predev-check.mjs`) runs before plain `npm run dev` and prints a one-time
notice when no Infisical identity is in scope — it never fails the boot, because tests and pure-UI
development must still start.

## One-time migration (already complete on main)

This is the historical record of the 2026-06-25 Infisical cutover. Current prod runs Infisical-only
via Coolify. If you are migrating a new environment or a rollback lane:

```bash
brew install infisical/get-cli/infisical   # or: npm i -g @infisical/cli
infisical login                            # -> Infisical Cloud
infisical init                             # link the project + env
# bulk-import your existing local secrets into the prod env:
infisical secrets set --env=prod --path=/ $(grep -vE '^\s*#|^\s*$' .env.local | xargs)
# or: Infisical dashboard -> project -> Secrets -> "Import .env" -> upload .env.local
```

Then create a **Machine Identity** (Project -> Access Control) with the **Universal Auth** method and
copy its **Client ID** (UUID — not secret) and a **Client Secret** (64-char string — secret, never
committed). App secrets live in the **`Socratic-Trade`** project (slug `socratic-trade`); shared
App-A/B (congress-trade) secrets live in **`shared-at-ct`**
(`18f563a3-9c88-454c-96eb-28fc9678f3ba`). To pull both, give the runner a SECOND identity via
`INFISICAL_SHARED_CLIENT_ID` + `INFISICAL_SHARED_CLIENT_SECRET` (and optionally
`INFISICAL_SHARED_PROJECT_ID`): the runner fetches both projects with `infisical export` and merges
them with the **app project winning** any overlapping key (shared is the fallback).

On the box set the bootstrap:

```bash
export INFISICAL_CLIENT_ID='<machine-identity Client ID>'          # a UUID; identifier, not a secret
export INFISICAL_CLIENT_SECRET='<machine-identity Client Secret>'  # the 64-char secret; never committed
export INFISICAL_PROJECT_ID='39d93bb7-76f9-498c-8b50-a7def52e072f' # Socratic-Trade (slug: socratic-trade)
export INFISICAL_ENV='prod'
export REQUIRE_SECRETS_MANAGER=1     # arm the fail-closed boot guard (prod only)
```

The **Client Secret is not an access token** — the runner exchanges the Client ID + Secret for a
short-lived token at each launch, so nothing in `deploy.env` expires. (A pre-minted `INFISICAL_TOKEN`
is accepted as a fallback, but it expires — see the identity's Access Token TTL.)

Once Coolify's boot script picks the bootstrap up, verify:
- the app boots and reads its keys (and that, with `REQUIRE_SECRETS_MANAGER=1`, a plain
  `next start` now refuses to boot);
- `cat .env.example` is bootstrap-only (Infisical identity + `ENCRYPTION_KEY` +
  `REQUIRE_SECRETS_MANAGER`) — if not, this PR's `.env.example` isn't on your tree yet;
- `npx tsc --noEmit && npm test && npm run build` are green;
- `git grep -nE '"\.env\.local"|resolve\(process\.cwd\(\), *["'"'"']\.env\.local' src app`
  returns zero hits (the CI guard `test/no-env-loader-or-dotenv-yaml.test.ts` enforces this).