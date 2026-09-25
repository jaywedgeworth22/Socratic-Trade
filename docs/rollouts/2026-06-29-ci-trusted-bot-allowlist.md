# 2026-06-29 — CI trusted-bot allowlist for cursor[bot] PRs

## Summary
- Updated the self-hosted PR guard in CI, Playwright Smoke, and Security to allow
  trusted same-repo bots (`cursor[bot]`, `dependabot[bot]`) while still blocking
  fork PRs and other bots.

## Why
- PR #249 failed all three required checks (`verify`, `smoke`, `gitleaks`) at the
  "Refuse untrusted PR source" step with `actor="cursor[bot]"`.
- The guard was added 2026-06-29 to keep untrusted fork/bot PRs off the
  production Mac runner, but it also blocked Cursor Cloud agent pushes on
  same-repo `cursor/*` branches.
- First CI run on the PR passed when triggered by `jaywedgeworth22`; subsequent
  `cursor[bot]` pushes failed before checkout.

## Files
- `.github/workflows/ci.yml`
- `.github/workflows/e2e.yml`
- `.github/workflows/security.yml`
- `STATUS.md`
- `docs/rollouts/2026-06-29-ci-trusted-bot-allowlist.md`

## Verification
- Bash allowlist logic: `cursor[bot]` passes, `evil[bot]` blocked (quoted case patterns).
- `npm run lint`, `npx tsc --noEmit`, `npm test` — run before push.

## Follow-ups
- Re-run PR #249 checks after push; expect all three jobs to proceed past the guard.

## Policy update — 2026-09-25

The current same-repository PR workflow actor allowlist is `cursor[bot]`,
`dependabot[bot]`, `sentry[bot]`, and `codex[bot]` in CI, Playwright Smoke,
and Security. A bot-authored PR does not need another bot to copy it under a
human identity: these actors run the ordinary required checks and review rules.
The workflows check `github.actor` for the event, not an immutable PR-author
field. Fork PRs still fail before checkout, and unknown `[bot]` actors remain
blocked until the owner adds them deliberately.

The 2026-06-29 rationale above describes the historical self-hosted runner.
Today `verify-hosted` and smoke use GitHub-hosted runners, and the dependency
install is tokenless `npm ci`; congress-trading-shared resolves over public
HTTPS. The old "private-repo deploy key secret" error text was stale for these
workflows and has been removed from the active and parked copies. This change does not remove secret scanning,
required checks, or review requirements.
