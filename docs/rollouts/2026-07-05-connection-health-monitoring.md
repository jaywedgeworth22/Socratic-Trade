# Rollout Note — Connection Health Monitoring and Failure Routing

## Summary
Implemented connection health monitoring and backend-failure routing logic to distinguish operator-level global dependency failures from tenant-specific key failures. Also added disk and database headroom monitoring (disk free bytes, DB + WAL size, and Litestream last-sync age) to both `/api/health` and the diagnostic operational snapshot.

## Why
1. A failing health probe that unconditionally returns `200` hides backend outages (e.g. database locks, RAG provider outages), which could lead to critical system issues in live trading.
2. Global outages (Database, Pinecone, or Voyage being down) require immediate administrative intervention and should trigger Sentry warnings and Resend emails to the operator fallback email, while user-key failures should only trigger in-app user notifications.
3. Disk/DB/WAL growth and Litestream sync ages were unmonitored on the host Mac, raising risk of silent replication failures (RPO growth) or disk capacity exhaustion.

## Files Touched
- [src/lib/db.ts](file:///Users/jay/Code/Socratic-Trade/src/lib/db.ts) (exported `databasePath`)
- [src/lib/db-health.ts](file:///Users/jay/Code/Socratic-Trade/src/lib/db-health.ts) (implemented `alertConnectionFailure` and `alertStorageWarning`, hooked into `logApiHealth`)
- [app/api/health/route.ts](file:///Users/jay/Code/Socratic-Trade/app/api/health/route.ts) (surfaced global dependency health, added storage/WAL/Litestream monitors, and failed with `503` on critical global outages)
- [src/lib/ops-snapshot.ts](file:///Users/jay/Code/Socratic-Trade/src/lib/ops-snapshot.ts) (integrated connection health summaries and storage metrics into the operational snapshot)
- [test/connection-health-routing.test.ts](file:///Users/jay/Code/Socratic-Trade/test/connection-health-routing.test.ts) (NEW unit tests)

## Verification
Ran all verification commands locally:
1. Compilation check:
   ```bash
   npx tsc --noEmit
   ```
   *Result*: Compilation completed successfully with no errors.
2. Target unit tests:
   ```bash
   npx vitest run test/connection-health-routing.test.ts
   ```
   *Result*: 5 tests passed successfully.
3. Full test suite:
   ```bash
   npm test
   ```
   *Result*: All 2454 tests across 252 files passed successfully.
4. Next.js build:
   ```bash
   npm run build
   ```
   *Result*: Build completed successfully with zero compile errors.

## Follow-ups / Risks
- Litestream sync age relies on `<dbPath>-litestream` local directory modification times. If Litestream uses a custom config path or the state directory isn't located adjacent to the database path, sync age calculations will fallback to `null` and not alert.
