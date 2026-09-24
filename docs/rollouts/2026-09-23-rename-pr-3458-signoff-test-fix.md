# 2026-09-23 — Rename PR #3458 CI fix: email sign-off test assertions

## 1. Context & Objective
PR #3458 (`mm/rename-socratic-trade-2026-09-23`, head `320f7bf9`) renames in-repo
references `Socratic.Trade` -> `Socratic-Trade`. Its required `verify` check went red:
`verify-hosted` failed at the `npm test` step and the `verify` gate then failed closed.
Goal: clear the rename-mechanics miss so the rename PR can go green.

## 2. Changes Made
The rename updated `NOTIFY_EMAIL_SENT_BY` in `src/lib/notify.ts` to
`(sent by Socratic-Trade)` but missed three test assertions written as regexes with an
escaped dot (`/\n\(sent by Socratic\.Trade\)$/`), invisible to a plain `Socratic.Trade`
search/replace. All three now expect the new sign-off.
- `test/notify.test.ts`
- `test/persistence-notification.test.ts`
- `test/usage-limit-alerts.test.ts`
- `STATUS.md`, `docs/EFFORT-LOG.md`, `docs/rollouts/2026-09-23-rename-pr-3458-signoff-test-fix.md` (this note)

## 3. Decisions & Trade-offs
Assertions updated to the new name (the rename's intent), not the constant reverted.
Remaining `Socratic.Trade` literals in the tree are intentional: historical
`docs/EFFORT-LOG.md` rows, a historical rollout note, and the
`docs/branding/logo-concepts/a-full-stop.svg` wordmark whose concept is the full stop.
No production behavior change; the sign-off string itself shipped in the rename commit.

## 4. Verification State
- Failure reproduced pre-fix: `npx vitest run test/notify.test.ts test/persistence-notification.test.ts test/usage-limit-alerts.test.ts` -> 3 failed assertions, matching the CI annotations on run 35923420885 job 107392707307 exactly (same files, same lines).
- Post-fix: same command -> 32 passed / 3 files passed.
- Full local gate (`npm run lint`, `npx tsc --noEmit`, `npm test`) re-run on the fixed tree; CI re-runs on push regardless. The lint annotations on the failed run (unused vars, unescaped entities) are warnings only — eslint exits non-zero on errors only, and the failed step was `npm test`.

## 5. Next Steps & Blockers
Push this commit to `mm/rename-socratic-trade-2026-09-23`; CI `verify` should go green.
The PR body's "green test run on the same commit SHA in main" claim checks out (CI runs
35918695896 push + 35922250600 schedule on main `b5f4281b` both succeeded, including
`verify-hosted`) — but it covers the pre-rename tree only, which is why this miss
slipped through.
