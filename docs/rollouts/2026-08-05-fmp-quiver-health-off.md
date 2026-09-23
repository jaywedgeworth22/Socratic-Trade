# 2026-08-05 — FMP/Quiver intentional OFF on Connections health + FMP policy defaults off

## Context & Objective

Direct FMP / QuiverQuant / Unusual Whales are already banned for Socratic-Trade
product use (`retired-direct-vendors.ts`, #2398). Admin Connections health still
painted historical FMP failure rows as red **STOPPED**, and Settings still
defaulted FMP policy toggles **ON**, which read as product bugs rather than
intentional retirement. This work makes retirement visible and calm: muted **OFF**,
defaults false, catalog retired, Quiver fully disconnected.

## Changes Made

1. **Connections health intentional OFF**
   - `isIntentionalOffHealthService` / `intentionalOffHealthReason` on
     `retired-direct-vendors.ts` (FMP + variants, Quiver, UW).
   - `ServiceHealthSummary.intentionalOff` on `db-health.ts`.
   - `/api/admin/connections-health` annotates retired lanes: `intentionalOff: true`,
     clears `stoppedWorking`, sets retirement reason. Expected `fmp` placeholder
     always present as OFF.
   - Admin client: muted Dot, **OFF** chip, excluded from "N stopped" / "N degraded"
     header counts; sort rank last.

2. **Policy defaults**
   - `DEFAULT_POLICY` `fmpRealTimeDataEnabled` / `fmpMacroDataEnabled` /
     `fmpEventsDataEnabled` / `fmpFundamentalsDataEnabled` → **false**.

3. **Settings UI**
   - FMP Features card: retired copy pointing at Congress.Trade; toggles disabled OFF.

4. **Connections API keys**
   - FMP catalog row `retired: true` (CT-only); POST rejects retired services.
   - Intro copy notes FMP/Quiver retired; hide Add/get-key for retired rows.
   - Quiver remains uncatalogued; `resolveQuiverApiKey` stays undefined (no cascade).

### Files touched

- `src/lib/retired-direct-vendors.ts`
- `src/lib/defaults.ts`
- `src/lib/db-health.ts` (`intentionalOff`)
- `app/api/admin/connections-health/route.ts`
- `app/admin/connections/connections-health-client.tsx`
- `app/console/settings/page.tsx`
- `app/api/keys/route.ts` (POST reject retired; catalog retired flag coexists with plan-tier work)
- `app/console/settings/api-keys.tsx`
- `src/lib/provider-tier-plan.ts` (`isRetiredMarketDataService` includes fmp/quiver/uw)
- Tests: `test/retired-direct-vendors.test.ts`, `test/connections-health-route.test.ts`,
  `test/health-lane-cap.test.ts`, `test/defaults-fmp-retired.test.ts`
- `docs/EFFORT-LOG.md`, this rollout

## Decisions & Trade-offs

- Keep FMP visible in Connections as **Retired · CT-only** rather than hard-deleting
  the catalog row (archaeology + matches concurrent plan-tier UI). Product cannot
  POST a new FMP key.
- Soft/expected-limit health failures (429, daily cap) are a sibling change on the
  same branch in `db-health.ts`; intentional OFF is independent and always wins for
  retired vendors.

## Verification State

```bash
npx vitest run \
  test/retired-direct-vendors.test.ts \
  test/connections-health-route.test.ts \
  test/health-lane-cap.test.ts \
  test/defaults-fmp-retired.test.ts \
  test/quiver-provider.test.ts
# 5 files, 30 passed
```

## Next Steps & Blockers

- Land with rest of `grok/data-sources-overhaul` (matrix, ROIC scheduler, plan-tier UI).
- Optional: purge historical `api_health_log` FMP rows in prod (UI already OFF without purge).
