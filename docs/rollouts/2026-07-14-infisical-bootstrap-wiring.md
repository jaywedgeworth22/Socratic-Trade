# 2026-07-14 — Local Infisical bootstrap wiring

## Summary

Socratic-Trade's Infisical runner now resolves its machine-identity bootstrap before Next starts,
uses complete identity pairs before same-source stale tokens, and keeps all bootstrap credentials
out of the long-lived runner, third-party CLI helpers, and final application. A final argv-safe
wrapper masks credential names after Infisical injection so Next cannot restore them from
`.env.local`. The change is local bootstrap plumbing only; it does not read or mutate Infisical
secrets.

## Why

`scripts/infisical-run.mjs` previously read `process.env` before Next loaded `.env.local`, so valid
local bootstrap credentials were invisible to the runner. The owner also stores app-scoped machine
identities in `~/.secrets/global-api-keys`, while the runner consumes generic names. Shell-sourcing
that broad file would expose unrelated keys and make shell metacharacters executable.

## Decisions

- Precedence is process environment, then `.env.local`, then `~/.secrets/global-api-keys`.
- App aliases are `INFIISICAL_ST_CLIENT_ID` / `INFIISICAL_ST_CLIENT_SECRET` (the supplied extra-I
  spelling) and corrected `INFISICAL_ST_*`.
- Shared aliases in the global file are only `INFISICAL_CT_SHARED_*`; generic
  `INFISICAL_SHARED_*` remains valid in process env or `.env.local`, not the broad machine file.
- A complete app/shared pair wins over a stale token in the same precedence layer. A token in a
  higher-precedence layer still wins over a pair in a lower layer.
- The resolver uses quote-aware managed-only global parsing, ignores key-looking lines inside
  unrelated quoted/indented data, and never sources the file as shell code. Multiline shell blocks
  and heredocs fail closed instead of being approximately parsed.
- The production global path is fixed at `~/.secrets/global-api-keys`; ambient
  `GLOBAL_API_KEYS_FILE` is ignored/scrubbed and exists only as a dependency-injected unit-test seam.
- Before reading, `lstat` and a no-follow descriptor must identify the same current-user-owned
  regular file with no group/other permission bits and no more than 1 MiB. Live/broken symlinks,
  non-regular paths, unsafe ownership/modes, and duplicate managed assignments are rejected;
  shell-looking dotenv values remain literal and inert.
- A half-pair in the selected higher-precedence layer aborts before any Infisical call. Fields are
  never combined across namespaces or files.
- A shared-only configuration aborts before token minting/export because overlay mode must fetch the
  app project as well.
- Socratic-Trade defaults to project `39d93bb7-76f9-498c-8b50-a7def52e072f`. Shared defaults to
  `18f563a3-9c88-454c-96eb-28fc9678f3ba` only when shared auth is present (or explicitly selected),
  so app-only setups remain single-project.
- Credential aliases are normalized in process memory only. The runner snapshots the selected auth,
  scrubs every bootstrap name from its own environment immediately, and clears each auth object after
  token mint/copy.
- CLI probe/login/export subprocesses get a minimal OS/network environment plus only the credential
  required for that operation; ambient provider, GitHub, Slack, broker, and cross-app secrets do not
  transit the third-party CLI. The configured Infisical domain is explicitly retained for EU or
  self-hosted endpoints. Raw login/export failure output is suppressed.
- Normal and overlay runs export secrets under that minimal environment, then start the app directly
  from the runner. Watch mode gives `infisical run --watch` only allowlisted runtime controls and
  Infisical-managed values. JSON export preserves multiline, quote, backslash, and whitespace data;
  invalid shapes, entries, or NUL bytes fail without raw output.
- Every final command starts through `scripts/infisical-app-child.mjs`. It preserves argv boundaries
  and writes empty masks for all credential and runtime bootstrap names after injection, which actual
  `@next/env` regression coverage proves prevents `.env.local` from restoring them. A trusted
  `/usr/bin/env` boundary removes preload hooks before the Node wrapper starts, then restores the
  intended `NODE_OPTIONS` only after masking. Runner and wrapper forward termination signals.
  Normal mode restores the manager-winning value; watch mode deliberately drops an
  Infisical-injected `NODE_OPTIONS` and restores only the pre-Infisical host value after masking.
- `cloud-setup.sh` performs a value-free readiness check; missing identities remain compatible with
  keyless local UI development.

## Files changed

- `scripts/infisical-bootstrap-env.mjs` — dependency-free dotenv parsing, precedence, mapping,
  defaults, pair validation, and safe readiness CLI.
- `scripts/infisical-run.mjs` — bootstrap resolution before Infisical authentication and expanded
  credential sanitization, minimal CLI environments, and direct non-watch export/launch.
- `scripts/infisical-app-child.mjs` — final post-injection masking and argv-safe process boundary.
- `scripts/cloud-setup.sh` — value-free local bootstrap check with the legacy path override removed.
- `test/infisical-bootstrap.test.ts` — resolver and fake-CLI integration coverage.
- `.env.example`, `docs/secrets.md` — operator contract and supported aliases.
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md` — handoff state.

## Verification

Run under `/opt/homebrew/opt/node@24/bin` (Node `v24.18.0`):

- Fresh disposable-cache `npm ci` — installed the exact lockfile graph; the shared package contains
  `index.js`, `index.mjs`, `index.d.ts`, and `index.d.mts`, and both CJS `require` and ESM `import`
  smokes expose 103 exports. Independent fresh-tag and fresh-current-main installs prove the earlier
  declarations-only state was interrupted local npm staging/cache contamination, not a broken tag.
- `npx vitest run test/infisical-bootstrap.test.ts` — 1 file, 33 tests passed, including proof that
  a shared-only overlay exits before the fake Infisical executable is invoked; live and broken
  symlinks/non-regular/permissive paths fail closed; shell-looking values are not evaluated;
  unrelated broad-file syntax/multiline data/shell-block traps are ignored; pair-before-token and the
  narrow global alias boundary hold; the availability probe receives no credential; unrelated
  ambient secrets do not reach CLI helpers; and actual `@next/env` cannot restore credentials in
  normal or watch mode; JSON values round-trip exactly; CLI domain, argv, signal, and preload behavior
  remain correct; and conflicting aliases/shell blocks/heredocs/NUL bytes fail or stay isolated.
- `npx eslint scripts/infisical-bootstrap-env.mjs scripts/infisical-run.mjs scripts/infisical-app-child.mjs test/infisical-bootstrap.test.ts` — passed with zero errors.
- `npx tsc --noEmit` — passed.
- `node --check scripts/infisical-bootstrap-env.mjs` — passed.
- `node --check scripts/infisical-run.mjs` and `scripts/infisical-app-child.mjs` — passed.
- `bash -n scripts/cloud-setup.sh` — passed.
- `LC_ALL=C rg -n '[^ -~]' scripts/cloud-setup.sh scripts/infisical-run.mjs scripts/infisical-app-child.mjs scripts/infisical-bootstrap-env.mjs` — no output.
- `git diff --check` — passed for tracked changes.
- Exact rebased-tree ordered repository gate: lint 0 errors / 459 inherited warnings, TypeScript,
  full Vitest 369 files / 4,161 tests, and the production Next build with the real TypeScript phase
  and all 32 static pages passed.

## Follow-ups

- Publish through `scripts/land.sh`, require hosted verification, and verify the automatic Coolify
  rollout after merge.
- No production or Infisical configuration change is required for this local bootstrap fix.
