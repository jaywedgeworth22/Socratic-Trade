# 2026-07-04 - shared-dep-https-hardening

## Summary

- Switched Socratic-Trade from the GitHub Packages semver dependency to the exact public HTTPS git tag for `@jaywedgeworth22/congress-trading-shared`.
- Removed the old GitHub Packages project `.npmrc` and the bespoke `scripts/npm-ci-with-shared-deps.sh` install helper.
- Returned CI, deploy, e2e, cloud setup, and preview-sync dependency installs to plain `npm ci`.
- Updated the shared-package pin check to compare git dependency refs after `#`.

## Why

- `congress-trading-shared` is now public, but GitHub Packages still requires package auth for npm installs. A public HTTPS git tag removes the package-token requirement.
- The first tokenless migration used a `github:` shortcut that lockfiles resolved as `git+ssh`; this follow-up keeps the committed dependency and lockfile on `git+https` so clean environments do not depend on SSH keys.

## Files

- `.github/workflows/ci.yml`
- `.github/workflows/codex-autofix.yml`
- `.github/workflows/deploy.yml`
- `.github/workflows/e2e.yml`
- `.github/workflows/shared-package-pin-check.yml`
- `.github/workflows/sync-previews.yml`
- `.npmrc`
- `package.json`
- `package-lock.json`
- `scripts/cloud-setup.sh`
- `scripts/npm-ci-with-shared-deps.sh`
- `scripts/sync-preview-lanes.sh`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`

## Verification

- `env -u NPM_TOKEN -u NODE_AUTH_TOKEN -u GITHUB_TOKEN -u GH_TOKEN NPM_CONFIG_USERCONFIG=/dev/null HOME=/tmp/codex-socratic-empty-home GIT_SSH_COMMAND='sh -c "exit 255"' npm ci --ignore-scripts=false --cache /tmp/codex-socratic-npm-cache`
- `npm run lint` — passed with 0 errors and 308 existing warnings.
- `npx tsc --noEmit`
- `npm test` — 253 files, 2457 tests passed.
- `npm run build` — passed with existing Next middleware deprecation and Sentry Edge runtime warnings.
- `npm audit` — still reports the pre-existing `tsx` -> `esbuild` moderate dev-server advisory.
- PR #444 merged to `main` as `1e1a15bc` on 2026-07-04.
- GitHub Actions `Deploy` completed successfully for `1e1a15bc`.
- Production `/Users/jay/apps/trading-live` is at `1e1a15bc`; PM2 `trading` is online.
- `https://socratictrade.com/api/health` returned 200 after deployment.

## Follow-ups

- Paired Congress.Trade HTTPS lockfile hardening landed first as PR #140, so both consumers pin the same exact `v1.2.0` git ref.
- The older `claude/tokenless-git-dep` PR is superseded for the dependency/auth cleanup.
