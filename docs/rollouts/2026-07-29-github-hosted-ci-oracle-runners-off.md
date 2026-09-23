# 2026-07-29 — GitHub-hosted CI; shut down Oracle Actions runners

## Context & Objective
Owner: shut down all Oracle GitHub Actions runners and run every repo on GitHub-hosted cloud runners.

## Changes Made
### Socratic-Trade
- All workflows: `runs-on: ubuntu-latest` (was `[self-hosted, socratic-ci]`).
- `ci.yml` classify always routes `hosted` (Mac/self path never schedules).
- `e2e.yml`: `playwright install --with-deps chromium`.
- `.github/actionlint.yaml`: empty self-hosted labels.
- `AGENTS.md`: fleet CI = GitHub-hosted only; prod still Coolify on Oracle.

### Congress.Trade
- `ci.yml`, `security.yml` → `ubuntu-latest`.
- `deploy-oracle.yml` → `ubuntu-latest` + SSH deploy to `ubuntu@<ORACLE_IP_RETIRED>` (requires `ORACLE_SSH_PRIVATE_KEY` secret).
- `scripts/check-actions-runner-policy.mjs` allows only `ubuntu-latest`.

### Host ops
- Stop/disable `oracle-runner-*` Docker containers on `<ORACLE_IP_RETIRED>`.
- Delete offline/online self-hosted runner registrations from GitHub.

## Decisions & Trade-offs
- Deploy for Congress no longer assumes the Actions runner *is* the Oracle box; it SSHs in. Owner must set `ORACLE_SSH_PRIVATE_KEY` if not already present.
- Legacy Hetzner `fleet-ci-*` registrations deleted if still present.

## Verification State
- Local: no remaining `runs-on: [self-hosted` in ST/CT workflows.
- Host: `docker ps` shows no `oracle-runner-*` after stop.
- GitHub: repo runners list empty (or only accidental leftovers).

## Next Steps & Blockers
- Confirm `ORACLE_SSH_PRIVATE_KEY` on Congress.Trade for deploys.
- Optional: remove Coolify "GitHub Actions Runners Fleet" application entirely.
