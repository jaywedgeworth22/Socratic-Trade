# 2026-08-20 — Cross-app coordination follow-ups (ST slice)

## Context & Objective

Audit #2802 (`docs/audits/2026-08-17-cross-app-coordination.md`) listed
portfolio fixes.  This branch implements the Socratic-Trade slice of §7 so
the pin triangle, Infisical merge order, congress docs, peer-serving Massive
label, and call-volume durability stop rotting as "next agent" notes.

## Changes Made

- Rewrote the shared-package pin check for vendor-era CT (UM npm pin + CT
  `VENDOR-PROVENANCE.md`; fail if CT is unreadable or reintroduces the npm
  dep).  Still not a required merge check.
- Persist call-volume windows to `settings` on drain; ACK after a successful
  POST; replay leftover windows after a crash.  The ~2s in-memory aggregate
  can still be lost.
- Tag peer-serving OHLC cache misses with `label: congress-read`.
- Infisical merge-order runbook in `AGENTS.md`.
- Refresh consume/share docs, FEATURE-ENABLEMENT Quiver row, events comment.

Touched:

- `.github/workflows/shared-package-pin-check.yml`
- `scripts/check-shared-package-pin.mjs`
- `test/shared-package-pin-check.test.ts`
- `src/lib/usage-monitor-push.ts`
- `src/lib/usage-monitor-replay.ts`
- `src/lib/history.ts`
- `src/lib/market-read.ts`
- `src/lib/congress-trade-events.ts`
- `test/usage-monitor-push.test.ts`
- `test/usage-monitor-replay.test.ts`
- `AGENTS.md`
- `docs/congress-trade-consume.md`
- `docs/congress-trade-share.md`
- `docs/FEATURE-ENABLEMENT-BACKLOG.md`
- `docs/audits/2026-08-17-cross-app-coordination.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-20-cross-app-coordination-followups.md` (this file)

## Decisions & Trade-offs

- No schema v85.  Call-volume durability uses `setInternalSetting` so
  parallel persistence PRs do not fight a migration bump.
- Did not promote the pin-check to a required merge check (audit item 9).
- Did not mint a second Massive key.
- Did not collapse union-merge STATUS/PLAN.
- Peer PRs opened: Congress.Trade #2064, Usage-Monitor #1245, FLEET #44,
  CTS #278, DealDex #93 (pointer only).  This cloud seat cannot write Mac
  live boards.

## Verification State

```bash
npm run lint          # 0 errors (grandfathered warnings)
npx tsc --noEmit      # clean
npx vitest run test/history.test.ts test/market-read-routes.test.ts \
  test/shared-package-pin-check.test.ts test/usage-monitor-push.test.ts \
  test/usage-monitor-replay.test.ts
                      # 105 passed after expecting usageLabel on the
                      # peer-serving SPY call
```

Full `npm test` in this VM is contaminated by injected provider keys
(`ROIC_API_KEY`, `TIINGO_API_KEY`, …) and is not the CI signal.
`npm run build` follows.

## Next Steps & Blockers

1. Review/merge peer PRs: CT #2064, UM #1245, FLEET #44, CTS #278, DD #93.
2. Promote pin-check to required only after ST+UM+CT are a matched pair.
3. Mac-seat live-board mirrors remain owner/Mac-only.

## Zero-Code Findings

None beyond the audit.  This PR implements the ST follow-ups.
