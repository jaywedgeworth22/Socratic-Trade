# 2026-08-19 — iOS Scan keeps last-good on a 503 refresh

> **2026-09-22 [MM] archaeology note:** historical reference to the Socratic.Trade bundle ID `trade.socratic.app` and the App Store Connect app `6799238379` is kept verbatim as they were live at rollout time.  The bundle ID was renamed on 2026-09-22 to `com.socratictrade.ios` (PR forthcoming); the appleId is unchanged.  See `docs/rollouts/2026-09-22-bundle-id-migration.md`.

## Context & Objective

Jay's signed-in web `/console/scan` on live `4abfb7fa` clicked Refresh scan once (not Run once).  Fresh refresh showed “Market scan failed (503). Showing the last good scan from Aug 18, 2026, 7:25:13 PM.”  The fallback cache still had the universe: Market scan (70), Smart money (20), 5069 quotes / 50 ranked + 5 held + 15 outliers / 5073 scanned, names including BRK-B / GOOG / BRK-A.  Testers on TestFlight 1.0.68 (#2830 ScanView) still saw iOS Market Scan as empty or broken.  iOS is a different surface and did not keep last-good.

## Changes Made

Live 503 reason: after an empty Nasdaq screener, interactive `/api/scan` Yahoo-priced the whole allowed set (~5073 names, concurrency 4).  That cannot finish inside the 35s budget, and the request often dies as generic 503 HTML (web copy `Market scan failed (503).` is the no-JSON fallback).  The last-good seed web already shows was applied only after that Yahoo work.  `marketScanQuotesFromAudit` also used all-or-nothing validation, so one bad row in a 5k map voided the seed.

iOS only called `GET /api/scan`.  `/api/mobile/snapshot` had no `latestScan`.  A 503 body with `topCandidates: []` replaced any in-memory table.  The client timeout was 25s vs a 35s server budget.

- `src/lib/market.ts` — `recoverQuotesWhenScreenerEmpty` uses last-good seed before Yahoo whole-set
- `src/lib/scan-singleflight.ts` — keep valid `quotesBySymbol` rows
- `src/lib/mobile-scan.ts` — compact last-good scan (names + counts; no 5k map)
- `app/api/mobile/snapshot/route.ts` — emit `latestScan`
- `app/api/scan/route.ts` — comment matches seed-first order
- `ios/SocraticTrade/MobileModels.swift` — decode optional `latestScan`
- `ios/SocraticTrade/DeskModels.swift` — `keepingLastGood` + last-good banner copy
- `ios/SocraticTrade/ScanView.swift` — seed from snapshot; keep names on failed refresh
- `ios/SocraticTrade/MobileAPIClient.swift` — 50s client wait
- `ios/SocraticTradeTests/DeskModelsTests.swift`, `MobileModelsTests.swift`, `UserFacingCopyTests.swift`
- `test/scan-empty-screener.test.ts`, `test/scan-singleflight.test.ts`, `test/mobile-scan.test.ts`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, `docs/phase-4-market-data-scoring.md`

## Decisions & Trade-offs

- Last-good on iOS is the same dashboard seed web already paints.  A 505/0/0 abort is still not last-good.
- Snapshot sends ranked names only.  The 5k `quotesBySymbol` map is too large for the mobile snapshot.
- iOS banner names the miss in ordinary language and appends the last-good stamp.  It does not print `503`.
- Client wait is 50s so a late 200/seed is not dropped while the server is still inside 35s.
- Yahoo whole-set remains when there is no usable seed (existing empty-screener tests).
- Did not merge, deploy, bounce Coolify, start a second TestFlight, click Manual Run, or touch #2848 / #2849 / #2841 / #2840.

## Verification State

```bash
npm run lint            # pass
npx tsc --noEmit        # pass
npx vitest run test/scan-empty-screener.test.ts test/scan-singleflight.test.ts test/mobile-scan.test.ts
# 28 passed (also after rebase onto c55c2e64)
npm run build           # pass
```

Linux VM cannot compile Swift.  No TestFlight.  Full `npm test` still hits leftover network 404s / provider timeouts unrelated to this scan path.

## Next Steps & Blockers

Rebased onto `origin/main` `c55c2e64` (#2848) 2026-08-19.  Seed-first `/api/scan` and iOS last-good both kept.  Did not rewrite #2848.

Do not merge from this seat.  Do not start a second TestFlight.  Do not bounce.  Do not touch #2848 / #2849 / #2841 / #2840.

1.0.68 will show names only after live `/api/scan` returns a 200 with `topCandidates` (backend seed-first in this PR).  The iOS `latestScan` snapshot path does not exist on `581467e1` and cannot help that binary.

## Zero-Code Findings

ASC: testers are on ST TestFlight 1.0.68 (`202608182121`), ASC `6799238379` / `trade.socratic.app`, sha `581467e1`.  That binary is `#2831` on top of `#2830` (`13b60747`).  iOS Scan files are identical on `581467e1` and `4abfb7fa`.  This is not a pre-#2830 client.

Verified on `581467e1`:
- `ScanView` only loads `GET /api/scan` (same refresh as web).  It does not read snapshot last-good.
- `MobileSnapshot` has no `latestScan` key.
- `marketScan()` waits 25s.  Structured 503 is used only when JSON decodes and `scannedSymbols > 0` or warnings exist.  Otherwise `requireSuccess` → `serverError` / network timeout.  `scan` stays nil.
- On structured 503 it assigns the empty `topCandidates: []` body.  Still no 70-name universe.

Verified against current live API (2026-08-19T00:51Z):
- `GET /api/health` `checks.release.sha` = `c55c2e64275b41fd8afc38e28bc026c62914d2ab` (`#2848`).  Contains `4abfb7fa`.  `#2850` is not live.
- `#2848` did not touch `src/lib/market.ts`, `app/api/scan/route.ts`, `app/api/mobile/snapshot/route.ts`, or iOS Scan files.
- `nasdaq-delayed-screener` / `yahoo-finance` health `ok`.  Ops audit kinds omit `market_scan` / `market_scan_failed`.
- Public `GET /api/scan` is 401 in 0.14s (session required).  Not the iOS break.
- Live `4abfb7fa` scan path: empty Nasdaq → Yahoo whole-set (~5k) inside 35s **before** seed.  Snapshot route emits no `latestScan`.
- Owner web Refresh on that API: `Market scan failed (503).` (no-JSON fallback) then last-good from dashboard snapshot.  Web `fetch("/api/scan")` has no 25s cap.

So 1.0.68 fails because live `/api/scan` still does not return names, and that client has no other seed.  Not because testers lack #2830.
