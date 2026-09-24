# 2026-08-17 — Cross-app coordination audit (report only)

## Context & Objective

Owner asked for a portfolio audit of coordination among Socratic-Trade,
Congress.Trade, Usage-Monitor, congress-trading-shared, DealDex, and the
fleet / effort-board protocols.  Focus: shared contracts and version drift,
health lanes, data ownership, duplication, event/SSE, alert routing,
CI/deploy, secrets/identity, Mac/runner contention, cascade boundaries, and
independent failure.  No fixes.

## Changes Made

Docs only.  New audit at `docs/audits/2026-08-17-cross-app-coordination.md`.

Touched:

- `docs/audits/2026-08-17-cross-app-coordination.md` (new)
- `docs/rollouts/2026-08-17-cross-app-coordination-audit.md` (this file)
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- Read peer repos via `gh` (GitHub MCP was down).  Did not clone them into
  this worktree.
- Did not open secrets files or call production Infisical.
- Did not add effort-board rows in CT/UM/CTS/FLEET/DD (cloud session; those
  live boards are Mac-side).  After merge, a Mac seat should pointer-row them.
- Left union-merge STATUS/PLAN/EFFORT-LOG as prepend-only.

Headline: CTS pins currently match `v2.5.2`, but ST's pin-check still reads
CT `app/package.json` dependencies — a field CT now forbids.  The gate is a
no-op.  ST trades if CT or UM dies.  ST/CT/UM share Hetzner fate.
CT Senate ingest still needs the Mac.

## Verification State

```bash
# docs-only; no tsc/test/build required for this report
test -f docs/audits/2026-08-17-cross-app-coordination.md
```

Peer evidence collected 2026-08-17 via `gh api` / `gh search code` /
`gh run list` against `jaywedgeworth22/{Congress.Trade,Usage-Monitor,congress-trading-shared,DealDex,ai-fleet-coordinator}`.

## Next Steps & Blockers

See audit §7.  First code follow-up (separate PR, not this one): rewrite
ST `shared-package-pin-check.yml` for vendor-era CT and include UM.

## Zero-Code Findings

Full write-up in `docs/audits/2026-08-17-cross-app-coordination.md`.
