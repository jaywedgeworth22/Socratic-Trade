# Rollout Note: 2026-07-28 Data Cascade Provider Error Handling & Diagnostics

## 1. Context & Objective
Investigated provider failures and missing data points across the data cascade for July 27–28, 2026. Diagnosed root causes for provider error logs (FMP 403, ROIC 404/429, Tiingo 404, Usage Monitor collisions) and updated keyless provider error suppression so expected non-fatal statuses do not falsely mark provider lanes as unhealthy.

## 2. Changes Made
- **`src/lib/data-providers.ts`**:
  - Added `suppressHealthStatuses: [404, 429]` to `RoicAiEnrichmentProvider`'s `fetchWithRetry` calls.
  - Added `suppressHealthStatuses: [404]` to `TiingoEnrichmentProvider`'s `fetchWithRetry` call for unknown ticker queries.
- **Root Cause Findings**:
  - **FMP 403**: Diagnosed that the `FMP_API_KEY` in environment returns `403 Account suspended` ("Please contact info@financialmodelingprep.com"). This caused fundamental data calls to fall back to Yahoo Finance.
  - **Usage Monitor**: Usage-Monitor telemetry PR #823 on Usage-Monitor repo was opened to address idempotency key validation and Cloudflare managed challenge issues.

## 3. Decisions & Trade-offs
- Preserved fallback cascades to Yahoo Finance and Finnhub so key fundamental fields (`peRatio`, `eps`, `sector`, `industry`, `beta`, `52-week ranges`) continue to populate automatically when FMP or ROIC are suspended or rate-limited.

## 4. Verification State
- `npm run lint` (0 errors, 652 warnings)
- `npx tsc --noEmit` (passed with 0 errors)
- `npm test` (passed)
- `npm run build` (passed)

## 5. Next Steps & Action Items
- Renew / reactivate the FMP API subscription or update `FMP_API_KEY` in Infisical (`Socratic-Trade` project ID `<ST_INFISICAL_PROJECT_ID>`) once the FMP account is unsuspended.
