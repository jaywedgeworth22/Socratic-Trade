# 2026-09-18 - propose-trades-live-vix-fallback

## Context & Objective

PR #3392 (`feat/live-vix-macro-trends-green-red`, `3b33f8ec`) switched
`proposeTrades` from 24h `fetchMacroData` to `fetchMacroDataWithLiveVix`.
Hosted `verify` / `verify-hosted` then failed six lock-loss integration tests
because that suite (and the vol-brake site) treat a missing live overlay as
`undefined`.  `pruneMacro` does `Object.entries(current)` and threw
`Cannot convert undefined or null to object`, aborting the money path before
the ownership-lost summary could be recorded.

## Changes Made

`proposeTrades` still prefers the live-VIX overlay.  If the overlay is missing
or rejects, it fail-opens onto the existing 24h `fetchMacroData` snapshot
instead of throwing.  Wiring source-pin updated.  Lock-loss fixture comment
records the contract.

Files touched:

- `src/lib/strategy.ts` — live overlay `.catch(() => undefined)` then `?? fetchMacroData`
- `test/strategy-macro-prompt-wiring.test.ts` — pin the fail-open assignment
- `test/strategy-lock-loss-integration.test.ts` — comment on the undefined mock
- `STATUS.md` / `PLAN.md` / `docs/EFFORT-LOG.md` — handoff rows
- `docs/rollouts/2026-09-18-propose-trades-live-vix-fallback.md` — this note

## Decisions & Trade-offs

Did not change the lock-loss mock to return a full `MacroData` object.  The
undefined overlay is a real fail-open contract shared with the vol-brake path
(`fetchMacroDataWithLiveVix(userId).catch(() => undefined)`).  Production
`fetchMacroDataWithLiveVix` already returns `MacroData` on a live-VIX miss
(it keeps the cached VIX); the crash was the unguarded `pruneMacro` call.

Did not skip the tests.  This was a bug introduced on `3b33f8ec`, not flake.

## Verification State

Commands run:

```bash
npm run lint          # 0 errors, 814 grandfathered warnings
npx tsc --noEmit      # clean after typing macro as MacroData & { vixAsOf?: string }
npx vitest run test/strategy-lock-loss-integration.test.ts test/strategy-macro-prompt-wiring.test.ts
                      # 2 files, 15 passed
```

Full `npm test` / `npm run build` left to the fix-PR hosted gate (same suite
that failed on #3392).  Extra-ship no.  No Coolify Deploy.

## Next Steps & Blockers

Merge this tip into `feat/live-vix-macro-trends-green-red` so #3392 can go
green.  Do not merge #3392 from this tip (Jay: no merge / no extra-ship).

## Zero-Code Findings

`verify` itself only failed because `verify-hosted` failed.  The six red tests
were all `strategy-run ownership loss across broker awaits` in
`test/strategy-lock-loss-integration.test.ts`.
