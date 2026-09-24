# 2026-09-18 — Strict Infisical, no `.env` files anywhere

## Context & objective

Owner directive 2026-09-18: **Infisical is the sole source of truth for every secret.** No
`.env` files anywhere — not `.env`, `.env.local`, `.env.production`, `.env.*`, `.env.yml`, or
`.env.yaml`.  Operator knobs, feature flags, provider keys, broker credentials, RAG fuses, and
per-lane budgets move to Infisical (shared / shared-at-ct / app projects), per-user Settings, or
in-code defaults.  This PR lands the structural enforcement so a future contributor cannot
silently resurrect a `.env.local` path.

## Why now

The 2026-06-25 cutover already made prod Infisical-only (`scripts/coolify-prod-start.sh`
phase-2 re-exec under `scripts/infisical-run.mjs` + `scripts/infisical-app-child.mjs`, both
stamp `SECRETS_SOURCE=infisical` and mask bootstrap names from the app so a stale `.env.local`
cannot restore a machine credential).  What was **missing** was:

1. The fail-closed **arming** — `REQUIRE_SECRETS_MANAGER=1` was wired through
   `src/lib/secrets-source.ts` + `instrumentation.ts:51` since 2026-06-25 but never set in prod
   Infisical, so the guard was inert.  This PR exports `REQUIRE_SECRETS_MANAGER=1` from the
   boot script's phase-2 re-exec so the policy is visible at the shell level, not buried in
   Infisical config.
2. The **shape** of `.env.example` — it had drifted back to ~210 lines of operator knobs,
   feature flags, and provider keys, contradicting the documented "bootstrap-only" contract.
   This PR shrinks it to bootstrap-only.
3. The **dev ergonomic** — `scripts/cloud-setup.sh:47-50` still seeded `.env.local` from
   `.env.example`, and `src/lib/db-api-keys.ts:32-60` still read it for `npm run dev`.  This PR
   deletes the `.env.local` path while keeping the `~/.secrets/global-api-keys` handoff paths
   (that file is the documented owner-side identity store, NOT an `.env` file — deleting it
   would force every cloud agent onto an Infisical round trip and contradict the
   "no LLM runtime keys in Infisical" rule).
4. The **regression guard** — no CI check that a future PR won't quietly add a dotenv import or
   re-add a `.env.local` resolver.  This PR adds `test/no-env-loader-or-dotenv-yaml.test.ts` as a
   CI gate.

## Changes Made

**Source:**
- `src/lib/db-api-keys.ts` — deleted the `.env.local` loader path. Kept the two
  `~/.secrets/global-api-keys[.env]` paths (the documented owner-side handoff file, NOT an
  `.env` file). Removed the now-unused `path.resolve` import.
- `src/lib/secrets-source.ts` — updated header comment + error message to reflect the new
  contract (Infisical runner required; no `.env` files; escape hatch is `unset
  REQUIRE_SECRETS_MANAGER`).
- `scripts/coolify-prod-start.sh` — phase-2 re-exec now exports `REQUIRE_SECRETS_MANAGER=1` so
  prod visibly arms the fail-closed boot guard from the shell. Escape hatch is the same
  unset/rebuild.
- `scripts/cloud-setup.sh` — stopped seeding `.env.local` from `.env.example`. Final echo now
  points operators at `npm run dev:secrets` (Infisical runner). Plain `npm run dev` is for
  tests-only.
- `scripts/predev-check.mjs` (new) — `npm run dev` pre-hook that prints a one-time notice
  when no Infisical identity is in scope. Never fails the boot (tests and pure-UI work must
  still start), but tells the operator the canonical start path.
- `package.json` — added `predev` hook. `dev:secrets` and `start:secrets` already existed; they
  become the canonical start paths.

**Tests:**
- `test/no-env-loader-or-dotenv-yaml.test.ts` (new) — CI guard that grep-asserts no
  `src/` or `app/` file (a) imports `dotenv`/`dotenv-flow`/`dotenv/config`, (b) parses a
  `.env.yml`/`.env.yaml`/`.env.json` credential file, (c) calls `resolve(process.cwd(),
  '.env.local')`, (d) string-literals `.env.local` anywhere. Fails the build on regression.

**Repo config:**
- `.env.example` — shrunk from ~210 lines to bootstrap-only (Infisical client identity +
  `ENCRYPTION_KEY` + `REQUIRE_SECRETS_MANAGER` arming flag + a redirect to the three
  alternative homes for everything else). Header explains the new contract.

**Docs:**
- `docs/secrets.md` — rewrote the "Local machine-identity bootstrap" section to drop `.env.local`
  from the precedence list (process env + handoff file only). Added the new "What this means for
  a fresh cloud seat" section that points at `npm run dev:secrets`.
- `AGENTS.md` — added a binding rule for the strict-Infisical cutover. Updated six existing
  `npm run dev` references to `npm run dev:secrets`. Added the cloud-specific instruction.

**Coordination:**
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` — Planned row added at top of file for this PR.
- `docs/EFFORT-LOG.md` (mirror) — to be updated at commit time per the handoff protocol.

## Decisions & trade-offs

- **Keep `~/.secrets/global-api-keys` handoff paths.** They are NOT `.env` files — they are
  the documented owner-side identity store (chmod 600, fixed path, never overridable). Deleting
  them would force every cloud-agent seat onto an Infisical round trip, contradicting the
  "no LLM runtime keys in Infisical" rule (AGENTS.md — LLM runtime keys live on the user's
  Connections page).
- **`predev` warns, doesn't fail.** Plain `npm run dev` must still work for tests and pure-UI
  development (no credentials needed). A noisy-but-non-fatal `predev` hook is the right shape.
- **No `dotenv` install/uninstall.** `dotenv` is not in `package.json` `dependencies` or
  `devDependencies`; the loader in `db-api-keys.ts:32-60` was a hand-rolled parser, not a
  `require("dotenv")`. Deleting it removed the only consumer. If a future contributor adds
  `import "dotenv"`, the CI guard catches it.
- **No new test for `secrets-source.ts`.** The pure `secretsManagerProblem()` function is
  covered by existing tests; the CI guard already proves `.env.local` can't be loaded by
  source code. The new behavior is "the boot script arms the flag" + "the runtime reads it" —
  covered by reading the script diff.
- **`scripts/infisical-prod-cutover.sh` (Mac rollback lane) is unchanged.** It still reads
  the bootstrap from a deploy-env file; that's a deliberate exception for the rollback-only
  pm2 lane documented in AGENTS.md.

## Verification State

Run on `~/apps/trading-cursor` worktree off `origin/main`:

- `npm run lint` — _pending_
- `npx tsc --noEmit` — _pending_
- `npm test` — _pending_
- `npm run build` — _pending_

Will fill in after the run.

## What does NOT change

- Prod Infisical values. No secret rotation is required by this PR — the keys already live
  in Infisical; this PR only stops `.env` files from being a parallel source.
- Per-user Settings, Connections page, broker account linking. The "user is the source of
  truth for their own keys" story is untouched.
- The Infisical runner (`scripts/infisical-run.mjs`) itself. The boot-guard arming moves to
  the parent script (`coolify-prod-start.sh`) so the runner stays untouched and reusable.
- The dotenv-loader test surface. The loader is deleted; tests that depended on it must use
  `process.env.X = "..."` directly (which they already do — see the temp-file pattern in
  `test/backup-status-route.test.ts:20`, etc.).

## Next Steps & Blockers

- Open PR (no merge), reference `docs/secrets.md` + this rollout.
- Once merged, every cloud-agent seat's `npm run dev` will refuse to start; seats must switch
  to `npm run dev:secrets`. Slack #agent-sync notice will be sent at PR-open.
- Owner-side follow-up (NOT this PR): the existing per-account `~/.config/agentic-trading/
  deploy.env` and `~/.secrets/global-api-keys` files on the Mac do not change. They were never
  `.env.local`.
- Option B (the deferred "migrate every `.env.example` knob into Infisical as blank rows")
  is a follow-up project. This PR moves the contract; the data migration is its own PR.