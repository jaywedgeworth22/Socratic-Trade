# 2026-08-07 — Docs + GitHub surface refresh

## Context
User-facing repo text was stale: README still read as "local-only" and only named
Robinhood + Alpaca; deployment doc pointed at old Coolify uuid / Hetzner-as-historical
confusion / Nixpacks; GitHub About lacked homepage and broker list; paper/live language
still used "Test/Paper/Brokerage" framing in places.

## Changes
- **README.md** — Socratic-Trade product blurb; broker table (Alpaca / Tradier / Robinhood);
  ask-first vs autopilot; production Coolify + Hetzner; paper/sandbox vs live without Test mode.
- **docs/deployment.md** — uuid `socratic-app`, Hetzner host, dockerfile, manual webhook auto-deploy.
- **docs/strategic-framework.md** — paper/sandbox + live brokers include Tradier.
- **GitHub** — description + homepage `https://socratictrade.com`.
- **STATUS.md** — current snapshot line.

## Out of scope
Full rewrite of every historical PLAN/EFFORT/rollout paragraph (archival). Code paths for
Tradier already exist; this is documentation honesty only.
