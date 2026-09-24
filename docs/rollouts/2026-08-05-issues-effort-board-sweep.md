# 2026-08-05 — Issues + effort-board sweep (GROK)

## Context & Objective
Owner asked to work all GitHub issues and effort-log issues for Socratic-Trade (they should
mirror each other). Most open issues were effort-board mirrors of already-landed work.

## Changes Made
1. **Unstuck open PRs** (phantom CONFLICT after main moved):
   - #2445 iOS Sign-In + SSE — rebased onto main, auto-merge armed
   - #2443 Tradier sandbox venue quotes — rebased onto main, auto-merge armed
   - #2489 activity-audit P2.7+P2.8 — already MERGEABLE, auto-merge armed (verify-hosted)
2. **Residual code** (this branch):
   - Full UX B4 Settings sticky TOC (`SettingsToc` with intersection observer + full section list)
   - `runCongressDailyShareIfDue` outer single-flight (defense in depth; `activeDailySharePromise` already on `runCongressDailyShare`)
   - evidence_age_anomaly LRU key includes `timestamp` (first-sight per id+assertedAt)
3. **Board hygiene** (`/Users/jay/apps/TRADING-EFFORT-LOG.md` + `docs/EFFORT-LOG.md`):
   - In Progress = only open PRs + this residual
   - Planned: removed completed/superseded activity-audit and merged UX rows so mirrored issues close
   - Completed: logged #2459/#2488/#2450/#2429/#2413/#2398/#2442 + topCandidates + Insights rename

## Decisions & Trade-offs
- Did **not** re-implement owner-gated items (#1324 owner decisions, dormant feature flips,
  SEC/RAG corpus writes, Exit Strategy Phase B/C money-path design).
- Hetzner CF whitelist OPS half of P2.4 is **retired** (servers deleted 2026-07-31).
- One-time `'undefined'` fill_events flip deferred (insertion fixed long ago; confirm prod count first).

## Verification State
- `npx vitest run test/congress-share.test.ts test/strategy-prompt-safety.test.ts` — 53 pass
- land.sh gate (tsc/test/build) on land

## Next Steps & Blockers
- Wait for #2489/#2445/#2443 verify-hosted green → auto-merge → auto-deploy
- Mirror job should close effort issues once Planned no longer lists them
- Owner: ASC API key for TestFlight upload if still needed
- Remaining Planned: backtest-integrity suite, exit-strategy Phase B/C, SEC/RAG P1 residual,
  owner-decision buckets, older P0–P3 program lists (need separate prioritization)

## Files
- `app/console/settings/page.tsx`
- `src/lib/congress-share.ts`
- `src/lib/strategy.ts`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-04-ux-b4-settings-toc.md`
- `docs/rollouts/2026-08-05-issues-effort-board-sweep.md`
