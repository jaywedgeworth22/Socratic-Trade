# 2026-08-17 — Alert-noise leftover: retired FilingAPI + soft-limit ops + live boot pages

## Context & Objective

Owner All Messages screenshot at 4:23–4:38pm CT (2026-08-17) stacked connection-failed,
budget, Litestream, and UptimeRobot cards.  Live evidence at 21:42Z showed Socratic-Trade
healthy after the 21:35:38Z Coolify restart of `5f9b4aaf`.  Goal: stop leftover FilingAPI
401s and expected-limit 429s from looking like outages, and stop the live boot window from
paging every probe that 5xxs during a deploy.

## Changes Made

- `getServiceHealthSummaries` now stamps `intentionalOff` for retired vendors (FMP / Quiver /
  Unusual Whales / FilingAPI) and clears STOPPED.  Leftover `api_health_log` 401s after the
  2026-08-17 FilingAPI retire no longer appear as a live dependency failure.
- Ops snapshot `ok` matches `/api/health`: only a hard 5-streak fails.  Soft "no success this
  hour" / expected-limit 429s stay diagnostic (`lastFailure`) without `ok: false`.
- Public `/api/health` omits retired vendors from `checks.dependencies`.
- `alertConnectionFailure` is silent for the first 5 minutes when `DB_BOOTSTRAP=live` (Coolify
  production).  Tests and local/dev are unchanged.  Override:
  `HEALTH_ALERT_STARTUP_GRACE_SECONDS`.

Touched files:

- `src/lib/db-health.ts`
- `src/lib/ops-snapshot.ts`
- `app/api/health/route.ts`
- `test/health-lane-cap.test.ts`
- `test/ops-snapshot.test.ts`
- `test/health-alert-noise-gate.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- this note

## Rematch onto current main (2026-08-20)

#2799 and #2800 already landed FilingAPI omit from public health and hard-stop-only ops `ok`
plus `pineconeIngest`.  This PR's unique leftover is the 5-minute `DB_BOOTSTRAP=live`
connection-alert mute and stamping `intentionalOff` inside `getServiceHealthSummaries` so
leftover 401 rows cannot paint retired vendors STOPPED.

Conflicts in `app/api/health/route.ts` and `src/lib/ops-snapshot.ts` were resolved by keeping
both: skip retired lanes via `intentionalOff` **or** `isIntentionalOffHealthService`, use
`isHardStoppedHealthSummary` (kind check, not the consecutive-failures string), and keep
main's `pineconeIngest` block.  Duplicate `isHardStoppedHealthSummary` after the auto-merge
was dropped; the kind-based copy from #2800 remains.

## Decisions & Trade-offs

- Did not raise Pinecone / Anthropic / Alpha Vantage budgets.  Those cards are working
  fuses, not outages.
- Did not treat the 1-minute congress.trade UptimeRobot blip as a product bug.  It lined up
  with the Coolify restart; CT `/api/health` is 200 again.
- Did **not** treat a stored OpenRouter "files-endpoint prepaid minimum" string as live
  billing truth.  Owner has OpenRouter credit; that halt was leftover.  Congress.Trade is
  a private repo and is not fixed from this checkout.
- Did not rotate Alpaca keys.  Trading liveness shows 2 Autopilot accounts; the env-lane 401
  in the screenshot is consistent with boot probes against a stale Infisical env key while
  Connections user keys still trade.
- Startup grace is live-only so the existing hard-streak tests keep paging.
- Did not call a write skip an "expected ingest park."  The 15-WU / 1-text skip was a
  deadlock (#2800), already live.
- Boot-grace reads `process.uptime()` instead of `runtimeReleaseIdentity()`.
  `runtime-health` imports `node:fs` / `node:http`; `db.ts` re-exports this
  module, and the old head failed `verify-hosted` on webpack
  `UnhandledSchemeError`.

## Verification State

Commands actually run after the 2026-08-20 rematch (`d84e2cac`):

```bash
npm run lint          # exit 0 (warnings only)
npx tsc --noEmit      # exit 0
./node_modules/.bin/vitest run test/health-alert-noise-gate.test.ts \
  test/health-lane-cap.test.ts test/ops-snapshot.test.ts \
  test/retired-direct-vendors.test.ts test/connections-health-route.test.ts
# 5 files / 38 passed
npm run build         # exit 0 — webpack UnhandledSchemeError gone
```

Full `npm test` in this cloud VM collected unrelated env failures (Yahoo OHLC,
usage-monitor fetch, vector-db receipt mocks, strategy 30s timeouts) while still
running after 20+ minutes.  Not used as the gate.  GitHub `verify` on this head
is the authority.

## Next Steps & Blockers

- Merge #2798 when `verify` is green.  Auto-merge was armed on the pre-rematch head.
- After merge: leftover Infisical `FILINGAPI` can stay unused.  Do not buy Plus.
- Owner (Usage Monitor, not this repo): Anthropic monthly $120 / $100 and the
  forecast/restart/cooldown provider budget cards.
- Congress.Trade stall is **not** an OpenRouter prepaid-minimum issue.  Last live note:
  extraction_provider quiet for 24h with a review backlog.  CT is private; cannot fix
  from this checkout.
- ST Litestream L2+L3 remaining wedged is a Coolify dual-writer / B2 ops issue, not this PR.

## Zero-Code Findings

Live at 2026-08-17T21:42Z (`/api/health` + ops snapshot):

| Card in the screenshot | Verdict |
|---|---|
| Litestream L1 stale / L2+L3 empty / state unreachable | Boot.  All five tiers known, not degraded, L0 age 0s. |
| congress.trade 502 + UptimeRobot down 1m | Deploy gap.  CT health 200; pipeline still stalled on billing. |
| nasdaq-quote / vix / polymarket / apify / alpaca-broker 5xx/401/404 | Probe failures during the 21:35:38Z restart of `5f9b4aaf`.  Lanes ok after. |
| vix-yahoo "not ok" on ops snapshot | Expected-limit HTTP 429 + soft "no success in 60 min".  CBOE-first VIX is fine. |
| filingapi HTTP 401 | Retired vendor.  Leftover health rows only.  No live HTTP. |
| Pinecone WU daily fuse / monthly 2M | App fuse at trial cap.  Retrieval still works.  Do not raise.  **Correction 2026-08-20:** trial is usage-billed (#2799); the 15-WU skip was a daily-fuse deadlock (#2800), now live. |
| Alpha Vantage 25/day pool exhausted | Expected free-tier cap. |
| Siliconflow RAG embed-budget | Was a write-budget skip, not a success.  #2800 unstuck the fuse. |
| Anthropic $120 / $100 | Usage Monitor budget, not Socratic-Trade. |
| Scheduler / Autopilot | Ticking.  2 Autopilot accounts.  Market closed. |
