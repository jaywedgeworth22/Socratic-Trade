# 2026-08-17 — Security and reliability audit (report-only)

## Context & Objective

Owner asked for a read-only application-security / SRE / incident-command / compliance / chaos audit of Socratic-Trade boundaries, secrets, auth, permissions, tenant isolation, supply chain, logging/PII, detection, Litestream, deploy/rollback, alerting, fail-open/closed, spend, SLOs, and DR.  Produce an evidence-backed report and a report-only PR.  Never expose secrets.

## Changes Made

Docs only.  No runtime, flag, or monitor changes.

- Added `docs/audits/2026-08-17-security-reliability.md` — threat model, live sanitized probe (2026-08-17 ~23:45Z), findings with severity/exploitability, prior-audit residual tracker, prioritized fixes, proposed SLOs.
- Pointed `docs/ops-observability-security.md`, `docs/phase-11-multi-user.md`, `STATUS.md`, `PLAN.md`, and `docs/EFFORT-LOG.md` at the audit.

Exact files:

- `docs/audits/2026-08-17-security-reliability.md` (new)
- `docs/rollouts/2026-08-17-security-reliability-audit.md` (this note)
- `docs/ops-observability-security.md`
- `docs/phase-11-multi-user.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- Report-only: did not implement P1 fixes (ops-token split, quote-age halt, boot-refuse-if-unarmed, restore-script rewrite).  Those need owner gates (Infisical, Coolify deploy strategy, box-side restore).
- Used production `/api/health` (public) and `/api/ops/snapshot` (token) for live evidence.  The snapshot JSON was parsed for aggregates only; account numbers, emails, and user IDs are not in the report.  Local snapshot file is not committed.
- Did not SSH the Hetzner host or run a Litestream restore.
- Two spaces after sentences in the audit prose.

## Verification State

```bash
# Public liveness (no token)
curl -fsS -o /tmp/health.json -w "%{http_code}\n" https://socratictrade.com/api/health
# 200; ok:true; release sha 4980322b; litestream replicating; tiersDegraded false

# Token-gated snapshot — aggregates only, values not published
OPS_SNAPSHOT_OUT=/tmp/ops-snapshot.json OPS_SNAPSHOT_RUNS=5 OPS_SNAPSHOT_AUDIT=5 \
  bash scripts/fetch-prod-ops-snapshot.sh
# ok:true; schedulerAgeSeconds:1; 2 users; 7 accounts; WAL ~149 MB
```

No `tsc` / test / build required (docs-only).  `npx tsc --noEmit` was not run.

## Next Steps & Blockers

Owner / next agent, in order:

1. B2 restore drill + `ENCRYPTION_KEY` decrypt receipt (F-DR-1).  Rewrite `scripts/litestream-restore-drill.sh` off Mac/R2 defaults.
2. Confirm Coolify does not overlap two Litestream writers (F-DR-2).
3. Split ops diagnostic token from `ADMIN_REINDEX_TOKEN` in production (F-PERM-1).
4. Page on JSON health fields, not HTTP 200 (F-ALERT-1).
5. Optional code follow-ups: boot-refuse if auth unarmed; Apple login CSRF; audit-payload redaction; privacy-policy deletion copy.

## Zero-Code Findings

See the audit §1 and §7.  Headline: isolation and money-path fail-closed are in good shape; the live risk is untested restore, single-host SPOF, static-token blast radius, and health-200 blindness to failed autonomy.
