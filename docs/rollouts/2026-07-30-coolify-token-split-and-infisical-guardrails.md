# 2026-07-30 — Coolify token split + Infisical agent guardrails

## Context
Agents mixed Coolify tokens and dumped Infisical secret *values* via `infisical secrets` (default list prints values). Owner: keep full-permission `COOLIFY_AGENTS` separate from read-only `COOLIFY_SERVER_STATS`, put both in Infisical, and block future agent footguns.

## Token roles (binding)
| Key | Role | Where |
|-----|------|--------|
| `COOLIFY_SERVER_STATS` | **Read-only** Coolify API (servers/resources for UI stats) | Infisical app env; website/server-metrics |
| `COOLIFY_AGENTS` | **Full** Coolify API (deploy/admin) | Infisical (ops); GH Actions deploy only; agent ops |
| `COOLIFY_API_TOKEN` | **Legacy alias** for apps that still read this name | Infisical **must** equal `COOLIFY_SERVER_STATS` never `COOLIFY_AGENTS` |

## Infisical
Set on Socratic-Trade + Congress.Trade `prod` `/`:
- `COOLIFY_SERVER_STATS`, `COOLIFY_AGENTS`, `COOLIFY_API_TOKEN` (= stats), `COOLIFY_SERVER_UUID`, `COOLIFY_HOST`, `SERVER_METRICS_TARGET_ENVIRONMENT`

## Code
- `app/api/admin/server-metrics/route.ts` prefers `COOLIFY_SERVER_STATS` over `COOLIFY_API_TOKEN`.

## Agent rules
- Never run bare `infisical secrets` (lists values).
- Use `scripts/infisical-secrets-safe.sh` for set/has/names.
- Canonical rules: `/Users/jay/apps/AGENT-SYNC.md` Secret handoff + Infisical section; `secret-safety` skill.

## Verification
- Stats token cannot deploy (403 missing deploy permission); agents token can.
- Infisical verify by **key presence + value length only**, never dump values.
