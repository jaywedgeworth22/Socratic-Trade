# 2026-07-10 — Coolify server base URL and IP migration

## Summary

- The Coolify server dashboard and API endpoint moved to `host.jays.services` (previously `jays.services`).
- The base URL references in the repository configuration (`AGENTS.md`) have been updated to target `https://host.jays.services`.
- Verified that the production application `socratictrade.com` remains fully healthy and active under the new infrastructure.

## Why

- The owner relocated the Coolify control plane from the apex domain `jays.services` (which now CNAMEs to the Mac Cloudflare tunnel) to `host.jays.services` to avoid routing loops and offload traffic.
- Fleet coordination and deploy scripts require updating to query `https://host.jays.services/api/v1` for deployment actions.

## Files

- [AGENTS.md](file:///Users/jay/Code/Socratic-Trade/AGENTS.md) — updated the dashboard URL reference to `https://host.jays.services`.

## Verification

- Checked that the production health endpoint `/api/health` at `https://socratictrade.com` is responsive (`ok: true`, db ok, scheduler ticking under 10 seconds age).
- Verified that local typechecking (`npx tsc --noEmit`), linter (`npm run lint`), and unit tests (`npx vitest run test/model-stats.test.ts`) are completely clean and green.
