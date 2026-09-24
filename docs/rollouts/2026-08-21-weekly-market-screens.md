# 2026-08-21 — Native weekly value + momentum screens

## Context & Objective

The owner asked whether to connect a weekly Perplexity ritual (value + momentum screens) into Socratic-Trade.  Option 3 is the product path: rebuild those screens from ST's own quotes, field store, and daily bars, then show them on Macro/Scan.  Perplexity stays an optional human ritual.  This note records the native implementation.

## Changes Made

Native weekly screens live in `src/lib/weekly-market-digest.ts`.  Value keeps liquid large-caps with a trailing P/E ≤ 10 within 10% of the 52-week low.  Momentum ranks the same floor by 5-day return and attaches ROC-14/21, RSI-14, and SMA 20/50/200 when bars exist.  The full scan tape (`quotesBySymbol` + `topCandidates`) is the universe — the ranked cut alone drops deep-value names.  Missing fields exclude the name; nothing is fabricated.

The dashboard read path is sync and I/O-free (cache or value-only).  Grouped-daily ranking plus per-symbol OHLC for leaders runs in the scheduler and on an explicit refresh.  Green sees a compact `weeklyScreens` block as advisory DATA (`agentic-strategy@2.15.0`).  Web cards sit on Macro and Scan.  iOS Scan shows a thin optional card.  No notify event, no scoring/policy/sizing change, no Perplexity key or scrape.

Touched files:

- `src/lib/weekly-market-digest.ts`
- `src/lib/indicators.ts`
- `src/lib/types.ts`
- `src/lib/market.ts`
- `src/lib/dashboard.ts`
- `src/lib/scheduler.ts`
- `src/lib/rate-limit.ts`
- `src/lib/strategy.ts`
- `src/lib/strategy-prompts.ts`
- `src/lib/data-catalog.ts`
- `app/dashboard-types.ts`
- `app/api/scan/weekly-digest/route.ts`
- `app/api/mobile/snapshot/route.ts`
- `app/console/components/weekly-digest-card.tsx`
- `app/console/macro/page.tsx`
- `app/console/scan/page.tsx`
- `ios/SocraticTrade/MobileModels.swift`
- `ios/SocraticTrade/DeskModels.swift`
- `ios/SocraticTrade/ScanView.swift`
- `test/weekly-market-digest.test.ts`
- `test/indicators.test.ts`
- `test/strategy-prompt-safety.test.ts`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `PLAN.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-08-21-weekly-market-screens.md`

## Decisions & Trade-offs

- Do not scrape Perplexity, mint a Perplexity key, or treat that report as quote truth.
- Use the full scan universe, not the momentum-weighted ranked cut.
- Dashboard stays I/O-free.  If grouped daily bars fail, rank a volume-capped per-symbol sample and say so.
- Prompt injection is DATA, not a command.  `STRATEGY_PROMPT_VERSION` moved 2.14.0 → 2.15.0.
- No new notify event (UI-first to avoid alert noise).
- iOS is a thin Scan card only — no new Swift file and no xcodegen.  Linux cannot `xcodebuild`.
- `next-env.d.ts` is left uncommitted.

## Verification State

Ran on this branch:

```bash
npm run lint          # exit 0 (warnings only; grandfathered set-state-in-effect backlog)
npx tsc --noEmit      # exit 0
npx vitest run test/weekly-market-digest.test.ts test/indicators.test.ts test/strategy-prompt-safety.test.ts test/copy-rules-lint.test.ts
                      # 43 passed on the focused files (plus copy-rules extras)
npm run build         # exit 0; route list includes /api/scan/weekly-digest
```

`npm test` (full suite) in this cloud VM hung on outbound HTTP (SEC / Yahoo / Finnhub 404s and 30s strategy timeouts).  That process was stopped by PID.  Those failures are environmental, not this change.  GitHub `verify` is the official full-suite gate.

Merged `origin/main` `86773171` (#3010 deploy-latch CJS fix) so the PR is no longer dirty.  Cloud-proxy pushes do not fire `pull_request` / `synchronize`, so `verify` is kicked with `gh workflow run ci.yml --ref cursor/weekly-market-screens-2b0c`.

## Next Steps & Blockers

- Wait for GitHub `verify` on the post-merge SHA.  Do not merge until that check is green.
- Confirm a live scan + Massive grouped-daily refresh paints both lists on Macro/Scan.
- iOS decode is additive; first compile happens in CI (`ios-build`).  No TestFlight in this change.
- Optional later: opt-in notify when the screens flip, or a settings toggle for the filters.

## Zero-Code Findings

The Aug 21 Perplexity week (value FIS/FISV; momentum COIN/LYB/DOW/CF/CTVA/IQV/DE/CBOE; no overlap) is context only.  It is not a data source and is not hard-coded.
