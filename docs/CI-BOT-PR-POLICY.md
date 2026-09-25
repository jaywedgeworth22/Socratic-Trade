# Bot-authored pull requests

Same-repository PRs triggered by `cursor[bot]`, `dependabot[bot]`, `sentry[bot]`,
and `codex[bot]` may run CI, Playwright Smoke, and gitleaks. They remain subject
to ordinary required checks and reviews; no bot work is automatically trusted
as correct. The gate reads the event `github.actor`, not a permanent PR-author
identity. Unknown `[bot]` actors are held until the owner updates the allowlist.
Fork PRs remain blocked before checkout.

The hosted CI installation is tokenless (`npm ci` over public HTTPS). No
private-repo deploy key is used by `verify-hosted` or Playwright Smoke; older
error messages claiming otherwise were stale. If a future workflow introduces
secrets or privileged writes, review that workflow's admission boundary before
expanding its allowlist.

The same bot-actor policy is reflected in `.github/workflows/ci.yml`,
`.github/workflows/e2e.yml`, `.github/workflows/security.yml`, and the parked
copy `ci-pending/e2e.yml`. Keep those lists in sync when the owner changes
the approved set.
