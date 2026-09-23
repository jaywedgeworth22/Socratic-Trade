# 2026-07-09 — Shared-dep proper-usage cleanup refresh (CODEX)

## Summary
Refreshed dirty Cursor PR #1105 onto current `origin/main` using a Codex replacement branch,
without editing Cursor's branch. Tightened Socratic-Trade's use of
`@jaywedgeworth22/congress-trading-shared` so remaining local duplicates of the cross-app
contract are gone. PR #1171 merged to `main` as `54b6d722`.

## Why
An audit found the app was largely migrated, but still had a hardcoded event-type list,
a parallel outbound payload interface, and unused shared imports that suggested incomplete
adoption.

## Files
- `src/lib/congress-trade-events.ts` — `isCongressEventType` uses `CONGRESS_EVENT_TYPES` (+ `trade.new` alias)
- `src/lib/congress-share.ts` — `CongressSharePayload` derived from shared `SharePayload`
- `src/lib/congress-trade-client.ts` — removed unused `API_PATHS` / `MAX_REFS_BATCH` imports
- `docs/EFFORT-LOG.md` — reserved In Progress row
- `STATUS.md` — snapshot note
- `PLAN.md` — no-roadmap-change note

## Verification
- `npm ci` — completed; existing audit/install-script approval warnings only.
- `npm run lint` — passed with 0 errors / 351 existing warnings.
- `npx tsc --noEmit` — clean.
- `npm test` — 301 files / 3101 tests passed.
- `npm run build` — passed; existing Next/Sentry Edge-runtime warning only.
- `git diff --check` — clean.

## Follow-ups
- After shared `v1.4.2` tags (project + subscription telemetry fields), bump the pin when
  App B starts sending `project` attribution.
- Optional: validate App A rows with `CongressTransactionSchema` in `coerceCongressTrade`.
