# 2026-08-17 — Architecture & backend audit (docs-only)

## Context & Objective

Owner asked for a top-to-bottom read-only audit of Socratic-Trade's framework, API, state machines, queues, persistence, caching, concurrency, failure recovery, scalability, latency, and production durability.  Goal: an evidence-based report that does not restate already-fixed June–August incidents, and a PR that contains no product fixes.

## Changes Made

Docs-only.  No runtime, schema, or test behavior changed.

- `docs/audits/2026-08-17-architecture-backend.md` — full findings catalog (F1–F26), strengths, false alarms, issue/PR cross-check.
- `STATUS.md` — current snapshot pointer.
- `PLAN.md` — scope note (audit only).
- `docs/EFFORT-LOG.md` — in-progress row for this audit.
- This rollout note.

## Decisions & Trade-offs

- **No product fixes in this run**, including the highest-confidence new gap (F3: stale `strategy_run_requests` sweep).  Implementing it here would mix audit and change.
- **No new diagnostic tests.**  Characterization tests that freeze today's stuck-`running` behavior would fight the follow-up fix.  The report lists the exact SQL/repro instead.
- **GitHub MCP was down**; issue/PR state came from `gh issue list` / `gh pr list` on 2026-08-17.
- **Did not fetch a live ops snapshot.**  Litestream L2/L3 (F1) is treated as a tracked residual from #2709 / #2697, not re-probed.
- Older reviews (`docs/audit-2026-06-29.md`, `docs/reviews/2026-06-20-failure-mode-brainstorm.md`, `docs/architecture-blueprint.md`) are cited only as historical; current `main` code wins.

## Verification State

```text
git rev-parse HEAD   # branch cursor/architecture-backend-audit-6186 on top of 4980322b
```

Not run (docs-only, no product change): `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`.

Issue/PR cross-check run:

```bash
gh issue list --repo jaywedgeworth22/Socratic-Trade --state open --limit 80
gh issue list --repo jaywedgeworth22/Socratic-Trade --search "architecture OR sqlite OR litestream OR scheduler OR queue OR concurrency OR durability" --state all --limit 40
gh pr list --repo jaywedgeworth22/Socratic-Trade --state open --limit 30
```

## Next Steps & Blockers

Follow-up implementation (separate PR, not this one), in the order from the audit §8:

1. Owner: Litestream fencing + B2 L1 cleanup (F1) — already tracked #2697 / #2776.
2. Agent: `markStaleRunningStrategyRunRequests` (F3); transactional `audit()` (F8); scheduler tick coalesce (F9); rate-limit `/api/strategy/run` and `/api/strategy/enable` (F13).
3. Owner calls: delayed-quote fail-closed vs annotate (F5); production auth boot guard (F6).

Blocker: none for landing this docs PR.

## Zero-Code Findings

See `docs/audits/2026-08-17-architecture-backend.md`.  Headline: no active P0 in current code; highest new code gap is F3 (durable Run-once rows can stick `running` with no sweep); highest residual ops risk is F1 (Litestream L2/L3 wedge, detection shipped).
