# 2026-07-21 — Retire and Delete `trading-live-mac` Self-Hosted Runner

## Summary
Owner directive: permanently stop, uninstall, and delete the Mac self-hosted runner (`trading-live-mac`). All CI workflows updated to route to Coolify Linux runners (`[self-hosted, Linux, X64]`) or `ubuntu-latest`. `AGENTS.md` updated with an explicit binding fleet directive banning any future use or re-registration of Mac self-hosted runners.

## Changes Made
1. **Runner Process & Service Cleanup:**
   - Stopped and uninstalled the macOS LaunchAgent service `actions.runner.jaywedgeworth22-Socratic-Trade.trading-live-mac`.
   - Killed all running `Runner.Listener` processes.
2. **GitHub Repository Runner Deletion:**
   - Deleted runner ID `22` (`trading-live-mac`) from `jaywedgeworth22/Socratic-Trade`.
   - Deleted runner ID `687` (`trading-live-mac-ci`) from `jaywedgeworth22/Congress.Trade`.
3. **Workflow Routing Updates:**
   - Updated `.github/workflows/ci.yml`, `security.yml`, `cleanup-caches.yml`, `sentry-ci-report.yml`, `_merge-shepherd-impl.yml`, `shared-package-pin-check.yml`, `e2e.yml`, `codex-autofix.yml`, and `effort-issues-sync.yml` to use `runs-on: [self-hosted, Linux, X64]`.
4. **Agent Rules & Governance:**
   - Added explicit rule stanza in `AGENTS.md` under "Hosting & dev servers" prohibiting any agent from ever starting, re-registering, or referencing `trading-live-mac` or `trading-live` runner labels.

## Verification
- Verified runner list via `gh api repos/jaywedgeworth22/Socratic-Trade/actions/runners` returns `[]`.
- Verified `grep -rn "trading-live" .github/workflows` returns zero active runner label references.
- `npx tsc --noEmit` and `npm test` verified locally.
