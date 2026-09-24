# 2026-07-11 — PR #1331 round 10: Codex thread triage + Codex-Autofix DeepSeek cherry-pick

## Summary

- Cherry-picked `ed5caf7` (PR #1373, merged to `main`) onto `claude/stop-loss-preset-options-f1jygn`
  as `45bb477`: routes the `codex-autofix.yml` fixer bot through DeepSeek's Anthropic-compatible
  endpoint (`DEEPSEEK_API_KEY` secret, `https://api.deepseek.com/anthropic`, model
  `deepseek-v4-flash`) instead of the deleted `ANTHROPIC_API_KEY`.
- Triaged all 35 open Codex review threads on PR #1331 against the branch's current code (not just
  GitHub's `isOutdated` flag, which several threads didn't trip even though the underlying code had
  moved). 32 were already fixed by rounds 5-9; 2 more fixed this round (`72ec8d1`); 1 left open with
  a PR comment explaining why. Resolved 34 threads via the GraphQL `resolveReviewThread` mutation —
  they'd never been resolved because the autofix bot (which normally does this) had been down.

## Why

The Codex Autofix workflow started failing ~2026-07-10T23:00Z (missing Anthropic credential),
silently accumulating unaddressed review threads across this PR and its stacked follow-on (#1371,
27 threads — separate follow-up). Investigated the CI failure, traced it to the credential change in
PR #1373, and picked up the bot's normal job manually per its own protocol (read `codex-autofix.yml`'s
prompt): separate outdated from live threads, fix clear correctness bugs, leave ambiguous ones open
with a comment, verify, commit, push, resolve threads.

Most of the "still open" threads turned out to already be fixed — this codebase's stop-loss
reconciliation code (`broker-protective-stops.ts`, `synthetic-stops.ts`, `broker-side.ts`) had already
absorbed 9 rounds of adversarial Codex review with extensive inline comments documenting each fix's
reasoning, so reading the current code against each thread's description was usually enough to confirm
resolution without writing new code.

## Files

- `.github/workflows/codex-autofix.yml` — cherry-picked DeepSeek routing (commit `45bb477`)
- `src/lib/broker-protective-stops.ts` — book fills discovered in the disabled-teardown path before
  clearing rows (both the successful-cancel and failed-cancel-but-broker-terminal branches), signal
  `filledRecoverySymbols` from there (commit `72ec8d1`)
- `src/lib/synthetic-stops.ts` — fold `justPlacedPartialBrokerStopQty` into the auto-registration
  coverage check, not just the fire path (commit `72ec8d1`)
- `STATUS.md` — round-10 summary appended to the existing PR #1331 entry
- This file (new)

## Verification

```
npx tsc --noEmit   # clean
npm test           # 316 files / 3438 tests passed
npm run build      # clean
```

## Follow-ups

- **Left open, not guessed at:** "Require shared OCO identity before pairing legs" — see the PR
  comment on #1331 (https://github.com/jaywedgeworth22/Socratic-Trade/pull/1331#issuecomment-4942042410).
  `liveExitOrderCoverage`'s bracket-leg pairing uses `orderClass` (a family string) + exact quantity,
  not a true group/parent id — neither Alpaca transport (REST or MCP) exposes one on individual leg
  orders today. Needs either a broker API change (nested-order fetch + parent correlation) or an
  owner-accepted tradeoff.
- **Branch is `mergeable_state: dirty` against `main`** — main has moved ~20 commits since this PR's
  base (`12062c8` → `b57b9b7`). Needs a `git merge origin/main` + conflict resolution before it can
  land; not done this round (time-boxed to the Codex triage). `EFFORT-LOG.md`/`STATUS.md` are the most
  likely conflict points per the standard multi-agent pattern.
- PR #1371 (stacked on this branch) has its own 27 open Codex threads — separate pass, tracked
  independently.
