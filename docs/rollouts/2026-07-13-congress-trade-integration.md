# Congress.Trade Integration Rollout

## Summary
Updated `.env.example` to fix the `CONGRESS_TRADE_AUTOFORWARD` to `CONGRESS_SHARE_ENABLED` variable mismatch, reflecting the true environment variable name used in the codebase.
Prepared Infisical flag changes to enable the bidirectional Congress.Trade (App A) <-> Socratic-Trade (App B) integration.

### Autofix Round 2
Addressed 4 additional Codex P2 threads:
- **EFFORT-LOG.md completeness** — added missing `CONGRESS_SHARE_FUNDAMENTALS_ENABLED` variable and stream subscription prerequisites (`CONGRESS_STREAM_SUBSCRIPTION_ID`+`_TOKEN` or `CONGRESS_STREAM_AUTO_SUBSCRIBE`) to the effort row.
- **Files touched** — updated rollout doc to list all 4 files changed, not just `.env.example`.
- **Verification commands** — replaced narrative verification with actual `tsc --noEmit` / `npm test` / `npm run build` commands run and their results.
- **Price mode ordering** — moved price-adjustment resolution to step 1 of the follow-up list (before `CONGRESS_SHARE_ENABLED`), because the nightly share job activates with the flag and would seed wrong prices without the price-mode decision settled.

### Autofix Round 3
Addressed the final 4 remaining Codex P2 threads (third review batch):
- **`.env.example` fundamentals flag** — added `CONGRESS_SHARE_FUNDAMENTALS_ENABLED` env var alongside `CONGRESS_SHARE_ENABLED` with doc comment explaining the separate gate for fundamentals/analyst arrays in the outbound scan-hook push.
- **Bearer token prerequisite** — added `CONGRESS_TRADE_TOKEN` as an explicit prerequisite at the top of the Infisical activation list (step 2), noting that without it both automatic sharing and the manual backfill are no-ops.
- **Backfill ordering vs reads** — moved `CONGRESS_TRADE_READS_ENABLED` into a new post-backfill step (step 4) so the backfill runs first; documented that enabling reads before the backfill could cause `fetchDailyOHLC` to short-circuit on App A's own partial series.
- **Current-feed verification** — added a prerequisite note on `CONGRESS_TRADE_AS_CONGRESS_SOURCE` requiring verification that App A's `/api/transactions` feed carries current disclosures before flipping (avoids replacing working scrapers with stale data).

### Autofix Round 4
Addressed the 3 remaining open Codex P2 threads (fourth review batch):
- **Shared lane for local fallback keys** (`src/lib/db-api-keys.ts:343`) — the shared-operator-infra fallback to the `local` user's stored key was returning `source: "user"`, which caused downstream cache-scoping code to treat it as a per-user credential with private cache scope. Changed to `source: "env"` so it's recognized as an operator-level fallback with shared cache scope.
- **Alpha Vantage local fallback** (`src/lib/db-api-keys.ts`) — `resolveAlphaVantageKeyPool` was missing the `local` user fallback that `resolveApiKeyWithSource` had. Added the same shared-operator-infra fallback pattern so that when no env var is set, the `local` user's stored Alpha Vantage key serves tenants/background callers.
- **Infisical activation contradiction** (`STATUS.md`) — resolved the contradictory statements where line 8 claimed flags were "applied across dev, staging, and prod" while line 11 said prod access was unavailable. Changed dev/staging/prod to dev/staging only, consistent with the "manual owner action needed for prod" note.

### Autofix Round 5 (Middleware Fix)
- **`middleware.ts` 401 bug** — added a bypass for `/api/admin/` routes that carry the `x-admin-token` header, allowing ops traffic (like the backfill script) to reach the route handler's `requireAdmin()` gate instead of being blocked with a 401 Unauthorized by the fail-closed Edge middleware.
- Ensured `x-authenticated-user-email` is explicitly cast to an empty string when `trustedEmail` is null to prevent header-setting errors.

### Updated files
- `src/lib/db-api-keys.ts` (2 changes: local fallback source + Alpha Vantage local fallback)
- `test/key-resolution-tiering.test.ts` (updated test expectations for new source classification)
- `STATUS.md` (fixed prod contradiction)
- `middleware.ts` (fixed 401 bug on admin bypass)
- `docs/rollouts/2026-07-13-congress-trade-integration.md` (this entry)

## Verification
Three required gates (all passed):
```bash
npx tsc --noEmit
npm test
npm run build
```
Each autofix round ran the full gate trio. Round 1 and 2 had lint skipped as doc-only; Round 3 confirms lint passes.
Round 5 verification:
```bash
npm run lint      # 0 errors, 448 warnings (all grandfathered)
npx tsc --noEmit  # clean
npm test          # 3934/3934 pass
npm run build     # clean
```
App B already contained the infrastructure to share (EOD, insider, etc.) and consume (congress trades, scores, analytics) data from App A, but they were gated behind feature flags. The goal of this rollout is to turn these flags on in the production environment. We also fixed a documentation mismatch in `.env.example`.

## Files Touched
- `.env.example`
- `STATUS.md`
- `middleware.ts`
- `src/lib/db-api-keys.ts`
- `test/key-resolution-tiering.test.ts`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-13-congress-trade-integration.md` (this file)

## Follow-ups
1. **Price Adjustments:** Resolve the outstanding price-adjustment discrepancy between App A (FMP-adjusted closes) and App B (raw closes) before enabling any flags that trigger automatic data sharing. The current data plan (`docs/congress-trade-data-plan.md`) marks this as a prerequisite: mixing adjusted and raw closes corrupts return math across splits/dividends. Decide whether to consume App A's adjusted data as-is, apply a fallback, or use a dedicated import mode that avoids the mismatch. **This must be resolved first** because `CONGRESS_SHARE_ENABLED` activates the nightly scheduler that posts closes to App A — running it with unresolved price modes seeds wrong prices through the automatic path, not just the explicit backfill.
2. **Infisical Updates (pre-backfill):** Once the price-adjustment decision is settled, set the following variables to `on` in Infisical. **Prerequisite:** Ensure `CONGRESS_TRADE_TOKEN` (the App A bearer token) is set first — without it, both automatic sharing and the manual backfill are no-ops (`isCongressShareAutoEnabled` and the admin route both gate on the token).
   - `CONGRESS_SHARE_ENABLED`
   - `CONGRESS_TRADE_AS_CONGRESS_SOURCE` — **prerequisite:** verify App A's `/api/transactions` feed carries current congressional disclosures before flipping; otherwise this replaces the working Senate/Apify/Capitol scrapers with App A's data, which may be stale or seed-only until the backfill runs.
   - `CONGRESS_ANALYTICS_ENABLED`
   - `CONGRESS_TRADE_FUNDAMENTALS_ENABLED` (ensure App A PR #46 is merged first)
   - `CONGRESS_SHARE_FUNDAMENTALS_ENABLED` (also requires App A PR #46 — enables fundamentals/analyst in the outbound scan-hook push; without this, `shareScanRefs` skips the fundamentals/analyst arrays even when the share master switch is on)
   - `ENRICHMENT_SHORT_CIRCUIT_ENABLED`
   - `CONGRESS_STREAM_ENABLED`
   - For the stream to actually work, one of the following subscription pre-requisites must also be configured:
     - Set `CONGRESS_STREAM_SUBSCRIPTION_ID` + `CONGRESS_STREAM_SUBSCRIPTION_TOKEN` (e.g. a pre-arranged webhook secret pair), **or**
     - Set `CONGRESS_STREAM_AUTO_SUBSCRIBE=on` to auto-discover via the App A API.
     Without one of these, `resolveSubscription` returns null and the stream never activates.
3. **Backfill:** With the pre-backfill flags above active, seed App A's database. **Important:** run the backfill before enabling `CONGRESS_TRADE_READS_ENABLED` — if App A reads are on, `fetchDailyOHLC` may short-circuit on App A's own partial series (even 2 closes) and post those back instead of using App B's deeper providers to fill gaps. Note that `POST /api/admin/congress-share {"fullHistory": true}` only backfills `collectMonitoredSymbols()` (the app's monitored universe), which may miss some congressional tickers not in the watchlist. For full coverage, specify an explicit `symbols` array or pass `"allIndexes": true` to also include major-index members.
4. **Post-backfill:** After the backfill completes, enable the remaining flags:
   - `CONGRESS_TRADE_READS_ENABLED` — turn this on after the backfill to avoid read-tier short-circuit issues. With the backfill complete and the read tier active, App A can serve price history directly for future scan candidates without re-fetching from upstream providers.
