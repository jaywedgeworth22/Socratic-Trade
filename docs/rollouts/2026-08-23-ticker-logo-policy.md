# 2026-08-23 ticker logo policy (shared order)

## Summary
`/api/logos/ticker` walks congress-trading-shared `sourceOrderFor` after disk cache, with GitHub-first fallback for ungraded names.  `local` is skipped.  Cache files are per symbol, theme, and source so a later jury row can change provider.

## Why
Congress.Trade and Socratic-Trade should honor the same A/B/C/D grades without flipping ST's default cascade.

## Files
- `app/api/logos/ticker/route.ts`
- `package.json` pin (v2.6.0 / matching SHA)

## Verify
```
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/ticker-logos.test.ts test/ticker-logo-policy.test.ts
```

## Follow-ups
Retarget the pin from a branch SHA to tag `v2.6.0` after the shared release.
