# 2026-09-18 - pruneMacro vixAsOf keyof (CI autofix)

## Context & Objective

PR #3392 commit `7eb15e57` (`fix(macro): keep vixAsOf out of pruneMacro omitted list`)
broke hosted verify.  `pruneMacro` iterates `keyof MacroData`, then compared
`key === "vixAsOf"`.  The stamp existed only as `MacroData & { vixAsOf?: string }`
on the live-VIX overlay, so TypeScript reported TS2367 (no overlap).  `verify`
is the ruleset gate and fails closed when `verify-hosted` fails.

## Changes Made

Added optional `vixAsOf?: string` on `MacroData` so the Instinct skip is a real
key, not a dead comparison.  Runtime behavior is unchanged: `pruneMacro` still
continues past the stamp so an unchanged 10-minute cache hit cannot appear in
`omitted` / `unchangedSinceLastRun`; `proposeTrades` still re-applies it.

- `src/lib/macro.ts`
- `docs/phase-7-strategy.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-09-18-prunemacro-vixasof-keyof.md`

## Decisions & Trade-offs

Typed the stamp on `MacroData` instead of widening only `pruneMacro`'s
parameter.  The object is already persisted via `setInternalSetting` and read
back as `MacroData`, so the intersection-only field was a lie at the cache
boundary.  Did not add `vixAsOf` to `MACRO_ALWAYS_KEEP` — the continue still
owns that key.  Did not retarget main; this PR lands on
`feat/live-vix-macro-trends-green-red`.

## Verification State

```
npm run lint          # exit 0 (errors only; grandfathered warnings remain)
npx tsc --noEmit      # exit 0 — TS2367 at src/lib/macro.ts:623 gone
npx vitest run test/macro.test.ts test/macro-live-vix.test.ts \
  test/strategy-macro-prompt-wiring.test.ts test/regime-watch.test.ts
                      # 4 files / 48 tests passed
npm test              # 711 files passed; 20 files / 38 tests failed
                      # (vector-db / voyage-vs-siliconflow / history cache /
                      #  strategy-lock / notify-creds).  Unrelated to the
                      #  optional MacroData field.  Hosted CI failed on tsc.
npm run build         # Next.js 16.3.4 webpack build succeeded
```

## Next Steps & Blockers

Merge into #3392 so hosted verify can go green.  Do not squash this onto main
alone.  No Coolify.  Extra-ship no.

## Zero-Code Findings

`verify` job `105521693228` is a 3-second Evaluate-gate fail-closed on
`needs.verify-hosted.result`, not a second root cause.  Warnings on
`positions.tsx` / `approval-card.tsx` / unused imports are grandfathered and
unrelated.
