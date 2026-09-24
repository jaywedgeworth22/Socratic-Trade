# 2026-07-22 — Approval Busy, red-team availability, and UptimeRobot diagnosis

## Summary

Added two narrow correctness/operability improvements:

- Single proposal approvals now retry the server's side-effect-free `busy` result for a bounded
  period while the per-account strategy lock clears, then show a specific Busy message if the run
  is still active.
- Rotation now filters the credential-resolvable curated pool through OpenRouter's account-filtered
  `GET /api/v1/models/user` endpoint. A disabled model is skipped when rotation is enabled; an
  availability-check failure fails rotation closed rather than selecting an unknown model. Explicit
  model choices are unchanged and still fail closed without an implicit fallback.

## Why

The live screenshot's `Result: Busy` is produced by the approval route when `executeProposal` cannot
acquire the same per-user/per-account strategy lock used by autonomous runs. Removing that lock would
reintroduce cap/account TOCTOU risk. The client had no retry and surfaced the raw status immediately.

Live approvals also showed distinct Red failures: `anthropic/claude-fable-5` was unavailable on the
OpenRouter account, `gpt-5.6-sol` timed out, and `deepseek/deepseek-v4-pro` returned a malformed/no
response. The existing no-fallback behavior is correct for explicit Red choices: no model is claimed
to have critiqued a trade when it did not.

## UptimeRobot diagnosis

Read-only production checks on 2026-07-22:

| Target | Result | Meaning |
|---|---:|---|
| `https://socratictrade.com/` | 307 → `/login` | Public unauthenticated root redirects; not a good monitor target if it expects 200. |
| `https://socratictrade.com/api/health` | 200 | Public liveness endpoint; also 200 with `User-Agent: UptimeRobot/2.0`. |
| `https://socratictrade.com/api/ready` | 401 | Authenticated readiness endpoint; not suitable for an unauthenticated monitor. |
| `https://socratictrade.com/api/ready?strict=1` | 401 | Same auth boundary. |

The monitor should target `https://socratictrade.com/api/health` and assert HTTP 200. Existing rollout
documentation already specifies a Keyword monitor for the low-credit substring on this endpoint. No
UptimeRobot API credential was present in the sanctioned secret locations, so the actual monitor
configuration could not be inspected or changed from this session.

The live page and `/api/health` were available during the check. The site's imperfect behavior is
consistent with failed Red reviews and a recently stale-swept strategy run, not an HTTP outage.

## Files

- `app/console/lib/api.ts` — bounded Busy retries for single approvals.
- `app/console/components/approval-card.tsx` — explicit exhausted-Busy toast.
- `app/api/strategy/run/route.ts` — async rotation eligibility precheck and actionable failure.
- `src/lib/llm-provider.ts` — shared OpenRouter model-ID normalization.
- `src/lib/openrouter-model-availability.ts` — account-model fetch/cache/filter helpers.
- `src/lib/model-rotation.ts` — async account-availability intersection and fail-closed audit.
- `src/lib/strategy.ts` — await availability-aware rotation resolution.
- `src/lib/llm-required.ts` — rotation availability error copy.
- `test/model-rotation.test.ts` — async rotation assertions.
- `test/openrouter-model-availability.test.ts` — account-list normalization and fail-closed tests.
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, `docs/manager-model-options.md` — state and design
  documentation.

## Verification

- `npx tsc --noEmit` — passed after the fresh worktree's shared-package `dist/` dependency was
  restored; the initial run was blocked by that missing generated package artifact.
- `npx vitest run test/model-rotation.test.ts` — 20/20 passed after rebuilding `better-sqlite3`.
- `npx vitest run test/openrouter-model-availability.test.ts test/model-rotation.test.ts` — 22/22
  passed.
- `npx vitest run test/console-api-html-error.test.ts test/openrouter-model-availability.test.ts
  test/model-rotation.test.ts` — 27/27 passed.
- `npm test` — 436 files / 5,071 tests passed.
- Production read-only checks: `/api/health` 200, UptimeRobot user-agent `/api/health` 200, root
  307 to login, `/api/ready` and strict readiness 401.

Ordered lint/tsc/test/build gate completed under GROK pickup (see handoff close-out below).

## Follow-ups

- ~~Update the UptimeRobot monitor to `/api/health`~~ **Done / already correct (2026-07-22 GROK):** both live monitors already target `https://socratictrade.com/api/health` and are UP — HTTP `socratictrade.com` (id 803542994) and Keyword `OpenRouter credits low` (id 803542990).
- Re-enable any desired OpenRouter model in the account or choose an available explicit Red model;
  rotation will skip models absent from the account-filtered list once deployed.
- DeepSeek V4 Pro's malformed response and GPT-5.6 Sol timeout are provider/model reliability
  incidents, not availability-proof signals; continue to show them as failed reviews until a future
  model-health policy is explicitly chosen.

## Handoff close-out — 2026-07-22 (GROK pickup of CODEX)

- Worktree: `/Users/jay/.codex/worktrees/trade-approval-redteam-uptime-20260722`
- Branch: `codex/trade-approval-redteam-uptime-20260722`
- Base SHA investigated: `315c91e506633c7b458d736c7ba7f97af05236ec`
- Coordination: CODEX authored the implementation; GROK claimed the unfinished gate/landing on `#agent-sync` and owns the remaining land path.
- Focused tests (CODEX): 27/27 passed.
- Full tests (CODEX): `npm test` passed, 436 files / 5,071 tests.
- Lint (CODEX): `npm run lint` passed with the pre-existing 597-warning backlog and 0 errors.
- TypeScript (CODEX): `npx tsc --noEmit` passed.
- Build: completed successfully after handoff — `.next/BUILD_ID` present (`YPTET9gaoJq-MlXdoYCCf`), static-generation/export traces complete, no residual build process. `git diff --check` clean. Land path re-runs tsc/test/build via `scripts/land.sh` after merge of `origin/main`.
- UptimeRobot: both Socratic monitors already on `/api/health` and UP; no dashboard change required.

Do not approve a live proposal during validation. The live account showed four pending proposals and
failed Red receipts; the code intentionally does not silently substitute Green for an unavailable Red
model.

## Landing — 2026-07-22 (GROK)

- PR: https://github.com/jaywedgeworth22/Socratic-Trade/pull/1902
- Local land gate: `npx tsc --noEmit` clean; `npm test` 443 files / 5199 tests; `npm run build` clean.
- Pushed branch `codex/trade-approval-redteam-uptime-20260722` after merging latest `origin/main`.
- UptimeRobot: no change required (already `/api/health`).
- Hosted verify + merge remain; Coolify auto-deploys on merge to `main`.
