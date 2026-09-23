# 2026-08-04 — Retire direct FMP / QuiverQuant / Unusual Whales from Socratic-Trade

## Context & Objective

Owner directive: **this app must not access QuiverQuant, Unusual Whales, or FMP at
all** and must get that class of data from **Congress.Trade** (App A). Congress.Trade
already owns congressional disclosures (and runs FMP/Quiver/UW only for its own
latency race where applicable). Socratic was still able to call FMP and Quiver
whenever keys resolved, double-spending shared quota and splitting truth.

## Changes Made

Hard ban with no emergency override, plus default-on App A paths for the data that
replaces those vendors:

1. **Policy module** `src/lib/retired-direct-vendors.ts` — permanent deny for
   `fmp` / `quiverquant` / `unusual_whales` and host detection helpers.
2. **`requestFmp`** (`fmp-common.ts`) — always returns `null`, never opens a socket.
3. **Enrichment cascade** (`data-providers.ts`) — never registers
   `FmpEnrichmentProvider`, `FmpRapidApiEnrichmentProvider`, or
   `QuiverEnrichmentProvider` even when keys are present.
   `FmpEnrichmentProvider.enrich` / Quiver `enrich` are no-ops if constructed.
4. **Quiver** (`quiver-provider.ts`) — `resolveQuiverApiKey()` always `undefined`.
5. **Economic calendar** — `economicCalendarConfigured()` always `false` (was FMP).
6. **FMP transcripts** — `requestFmpJson` hard-returns `access_denied` (flag contract
   retained for rights tooling only).
7. **Provider tier probe** — no longer probes `financialmodelingprep.com`.
8. **`scripts/fmp-hoard.ts`** — exits 1 with retirement message.
9. **Congress.Trade defaults** (`api-clients/congress.ts`):
   - `CONGRESS_TRADE_FUNDAMENTALS_ENABLED` default **OFF** — fundamentals from the
     multi-source cascade (Yahoo, Finnhub, ROIC, SEC XBRL, Tiingo, …), not App A
   - `CONGRESS_TRADE_AS_CONGRESS_SOURCE` default **ON** (disclosures)
   - `CONGRESS_ANALYTICS_ENABLED` default **ON** (composite/clusters)
   - `CONGRESS_TRADE_READS_ENABLED` (price cache-aside) stays default **OFF**
   - Explicit `off`/`0`/`false`/`no` still disables any flag

### Files touched

- `src/lib/retired-direct-vendors.ts` (new)
- `src/lib/fmp-common.ts`
- `src/lib/quiver-provider.ts`
- `src/lib/data-providers.ts`
- `src/lib/api-clients/congress.ts`
- `src/lib/economic-calendar.ts`
- `src/lib/provider-tier.ts`
- `src/lib/web-sources/fmp-transcripts.ts`
- `scripts/fmp-hoard.ts`
- Tests under `test/` (retirement pins; obsolete FMP network suites skipped)
- `docs/fmp-capabilities.md`, `docs/congress-trade-consume.md` (defaults)
- `STATUS.md`, `docs/EFFORT-LOG.md`, this rollout

## Decisions & Trade-offs

- **Unusual Whales** was never a production ST producer; banned so it cannot be
  reintroduced as a direct lane.
- **Fundamentals** are filled by the existing multi-provider cascade (not FMP and
  not Congress.Trade by default). App A fundamentals remain available as opt-in.
- **Quiver specialty fields** (gov contracts, lobbying, patents counts) have no
  App A peer mapping today — they go empty. Congressional trades/analytics come
  from App A instead of Quiver counts.
- **Economic calendar prompt block** goes empty until a non-FMP source is wired.
- **FMP transcript producer** cannot call FMP even if both opt-in flags are set;
  rights inventory/purge tooling remains.
- Price/history peer reads stay opt-in to avoid the known Massive echo waste.

## Verification State

```bash
npx vitest run \
  test/fmp-common.test.ts \
  test/retired-direct-vendors.test.ts \
  test/api-clients-congress.test.ts \
  test/quiver-provider.test.ts \
  test/provider-tier.test.ts \
  test/rapidapi-providers.test.ts \
  test/data-providers.test.ts \
  test/fmp-transcripts.test.ts \
  test/milestone-4-challenger.test.ts
# 9 files: 229 passed | 39 skipped
```

Full gate via `scripts/land.sh` (tsc → test → build).

## Next Steps & Blockers

- Confirm prod Infisical no longer needs `FMP_API_KEY` / `QUIVER_*` on **Socratic**
  (keys may remain for Congress.Trade latency probes only).
- If economic-calendar awareness is needed again, wire a non-FMP source (or App A
  export if/when CT exposes one).
- Optional: strip FMP from Connections catalog / env migration once operator UI is ready.
