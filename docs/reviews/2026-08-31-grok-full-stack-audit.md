# Socratic-Trade top-to-bottom audit — 2026-08-31 (Grok)

Tree: `~/apps/trading-grok-full-audit` @ `grok/full-stack-audit` tracking `origin/main` `ff7a562d9`.  Board: `52592a4d`.  Report-only.  No product code in this lane.

This is a re-audit of the live desk at every size the owner uses: desktop `/console`, phone-width `/console`, native iOS (iPhone / iPad / Mac Catalyst), and the Node backend that places real orders.  Nine specialist scanners plus orchestrator file:line verification.  Prior catalogs remain the baseline: Cursor 2026-08-23 (`docs/reviews/2026-08-23-cursor-full-stack-review.md`, GH #3056–#3067) and DeepSeek 2026-08-20 (`docs/reviews/2026-08-20-deepseek-full-review.md`).  Items below marked **still open** were re-read in this tree, not copied from those docs.

## Executive summary

The money path still has three unfixed P0s from 2026-08-23.  Protective stops can send Alpaca a type it rejects.  An Alpaca MCP timeout still falls through to REST and can double-submit a live order.  Any broker `client_order_id` still counts as app-placed, so owner GTC stops can be cancel-replaced.  The website still freezes on last-good data after a 401.  iOS still has a `Dictionary(uniqueKeysWithValues:)` trap on duplicate command ids.  Dashboard "recent fills" still take the oldest 500, and the snapshot loads every fill unbounded on a 15s poll.

Several earlier findings are **fixed** in this tree: Guardrails Discard now clears the Universe-group draft; `/mobile` redirects to `/console`; iOS defaults to light; gather abort + last-good tape is in `strategy-gather.ts`; `pendingDeepLink` is singular.

Fix order is money-wire first, then owner-visible tape and crashes, then session freeze, then polish.

## Counts (this catalog)

| Surface | P0 | P1 | P2 | P3 |
|---|---:|---:|---:|---:|
| Money path | 3 | 1 | 0 | 0 |
| Jobs / ops | 1 | 2 | 1 | 0 |
| Web desktop | 0 | 2 | 3 | 1 |
| Web phone / tablet | 0 | 1 | 3 | 1 |
| iOS native | 0 | 2 | 3 | 1 |
| Backend / API | 0 | 2 | 2 | 0 |
| Security / auth | 0 | 1 | 1 | 0 |
| Copy / a11y / theme | 0 | 1 | 2 | 1 |

Prior-audit rows that are still open are counted once.  New findings from this pass are marked **new**.

## Must-fix now (top 15)

1. **P0 still open `d4cb5e75` / #3056** — Alpaca write sends `type: "stop_market"`.  Alpaca REST wants `stop`.  `src/lib/alpaca.ts:836` (REST) and `:900` (MCP args).  Read mapper `mapAlpacaOrderType` converts `stop` → `stop_market` on the way in; there is no write mapper.  The unit test pins the bug: `test/alpaca-limit-stop-price-guard.test.ts` expects `lastCreateOrderOpts.type` to be `"stop_market"`.  Protective stops call `type: "stop_market"` at `src/lib/broker-protective-stops.ts:1532`.
2. **P0 still open `ef0dccb3` / #3058** — `AlpacaBrokerGateway.callMcp` catches every failure, including `AbortSignal.timeout`, and always calls `fallbackFn()` (`src/lib/alpaca.ts:425-428`).  If MCP accepted the place and the HTTP body timed out, REST places a second live order under a new attempt.  Protective-stop intent rows try to paper over lost replies; MCP place does not.
3. **P1 still open `d36c2233` / #3064, money-adjacent** — `isAppPlacedBrokerOrder` is "any non-empty `clientOrderId`" (`src/lib/order-provenance.ts:12-14`).  Owner GTC stops placed at the broker with a client id look app-placed and can be cancel-replaced.  Prefix helper `isAppManagedProtectiveStopClientOrderId` exists (`protstop-` / `sstop-`) and is not used for this gate.
4. **P0 process `bdc2b662`** — merge to `main` auto-deploys runtime trees.  Weekday RTH latch delays the image, it does not add human review.  Still true.
5. **P0 in progress `06df80cf` (Claude)** — gather still has a hard 8-minute wall (`STRATEGY_GATHER_DEADLINE_MS` in `src/lib/strategy-gather.ts:14`).  Abort + last-good tape is now present (`:92-154`).  Internal time budget inside the scan/enrichment walk is the remaining hole; do not duplicate Claude's lane.
6. **P1 still open `79daff38` / #3059** — unified fills sort ascending then `slice(0, 500)` (`src/lib/dashboard.ts:936-939`).  The Activity tape shows the oldest 500, not the newest.
7. **P1 new (related)** — those fills are loaded with `listFillEvents(..., undefined)` (`src/lib/dashboard.ts:705-706`), which is the unbounded ASC query in `src/lib/db-fills.ts:367-369`.  Every 15s dashboard poll hydrates the entire fill history into Node for PnL and then throws most of it away for the feed.
8. **P1 still open `3b3df6ca` / `d9f81e44`** — `Dictionary(uniqueKeysWithValues: commands.map { ($0.id, $0) })` in `ios/SocraticTrade/MobileStore.swift:46`.  Duplicate command ids from a server query crash the app.
9. **P1 still open `30809a0c` / #3062** — `fetchDashboard` throws on any non-OK (`app/console/lib/api.ts:129-132`) with no 401 branch.  `useConsoleData` keeps the last snapshot.  Middleware already 401s APIs (`middleware.ts:476-481`) and redirects pages to `/login`.  The SPA never follows.
10. **P1 still open `9f875d62` / #3057** — SEC ingest still returns `skipped: true` with `ok: true` on several 8-K / filings paths (`src/lib/web-sources/sec8k.ts:581,619` and siblings).  Re-verify the embed-400 → "budget exceeded" classifier in the same files before closing the board row; do not treat skip-as-success as green coverage.
11. **P1 still open `41fba175`** — query embed 400/429/connection returning null so retrieval looks like an empty corpus.  Not re-traced line-by-line in this pass; still open on the board; do not close without a code proof.
12. **P1 new** — ticker logos SSR-default to dark (`app/console/ui/ticker-logo.tsx:21`) and, when `data-theme` is unset, follow `prefers-color-scheme` (`:28`).  Product default is light.  Console theme `system` leaves `data-theme` unset (`app/console/lib/useConsoleTheme.ts:60-64`), so logos go dark on a dark Mac even when the console is on the light tokens.
13. **P1 still open `64413d84`** — `tradingLiveness` degraded / oldest completed run age.  Ops, not a code edit in this PR.  Pair with the hung scheduler-tick watchdog already in progress (`grok/hung-scheduler-tick-watchdog`).
14. **P2 new** — iOS `project.yml` still advertises `MARKETING_VERSION: "1.0.8"` / `CURRENT_PROJECT_VERSION: "202608132022"` while PLAN records hosted TestFlight 1.0.69.  The ship script overrides on the xcodebuild line (comment in the file says so), so "what version is this repo at?" is a lie until someone hand-syncs.
15. **P2 new** — web phone bottom bar is capped at four of fifteen destinations (`MOBILE_TABS_MAX = 4` in `app/console/lib/mobile-tabs.ts:19`).  Defaults are Home / Proposals / Activity / Orders.  Scan, Coach, Guardrails, Connections live behind More.  iOS already got an adaptive tab bar; the website phone shell did not.

## Full catalog

### Money path

| Sev | Status | ID | Evidence | Issue | Fix |
|---|---|---|---|---|---|
| P0 | still open | `d4cb5e75` | `src/lib/alpaca.ts:836,900`; `src/lib/broker-protective-stops.ts:1532`; `test/alpaca-limit-stop-price-guard.test.ts` | REST and MCP send internal `stop_market` on the wire.  Alpaca rejects it.  Tests lock the wrong word. | Add `toAlpacaOrderTypeWrite`: `stop_market` → `stop`.  Flip the test.  Keep the read mapper. |
| P0 | still open | `ef0dccb3` | `src/lib/alpaca.ts:387-428` | MCP timeout/error always REST-falls-back.  Place is not idempotent across that hop unless the same `client_order_id` is reused **and** 409 is treated as success. | Do not REST-place after an uncertain MCP place.  Reuse `refId`.  Treat 409 duplicate as the first order. |
| P1 | still open | `d36c2233` | `src/lib/order-provenance.ts:12-14` | Any client id ⇒ app-placed. | Gate auto-replace on `protstop-` / `sstop-` (helper already exists) plus ST's own ref prefix. |
| P2 | note | Tradier | `src/lib/tradier.ts:172,814` | Tradier maps `stop_market` → `stop` on write.  Alpaca does not.  The two brokers drifted. | Copy the Tradier write map into Alpaca. |

### Jobs / ops

| Sev | Status | ID | Evidence | Issue | Fix |
|---|---|---|---|---|---|
| P0 | in progress (Claude) | `06df80cf` | `src/lib/strategy-gather.ts:14,92-154` | 8-minute gather deadline remains.  Abort + last-good is in.  Internal budget inside the walk is Claude's. | Do not steal the lane.  Re-check after Claude lands. |
| P1 | still open | `64413d84` | health JSON / scheduler | Oldest completed run age / liveness degraded. | Pair with hung-tick watchdog.  Age-gate against the session calendar, not wall-clock since boot. |
| P1 | still open | `a9676caf` | board | Container restart loops destroy forensics. | Alert + persist logs outside the dying container. |
| P2 | still open | `512444e3` | board | TestFlight / Playwright / freshness CI flakes. | Keep as CI hygiene, not a money-path block. |

### Web desktop

| Sev | Status | ID | Evidence | Issue | Fix |
|---|---|---|---|---|---|
| P1 | still open | `30809a0c` | `app/console/lib/api.ts:121-134`; `app/console/lib/useConsoleData.tsx` | 401 does not route to `/login`.  Last-good snapshot stays. | On 401, `window.location.href = "/login"`.  Do not keep trading chrome up for an expired session. |
| P1 | still open | `79daff38` | `src/lib/dashboard.ts:705-706,936-939` | Oldest-500 fills + unbounded load. | `listFillEvents(..., 500)` (already newest-then-ASC when limited) and slice the **newest** for the feed.  Keep full history only for PnL if needed, or compute PnL in SQL. |
| P2 | new | dashboard cost | `FETCH_DEADLINE_MS = 35s`; sequential broker chain ~24s | First paint and every poll pay the broker walk.  iOS already parallelized options vs portfolio in #3117; the website snapshot is still heavy. | Keep last-good (already).  Bound fill fetch.  Do not abort below 24s (comment in useConsoleData is correct). |
| P2 | new | page width | `app/console/lib/page-width.ts` | `max-w-5xl` is the standard.  Scan/orders still `overflow-x-auto` at that width. | Keep horizontal scroll on dense tables.  Do not shrink to 768px. |
| P2 | new | 15-item rail | `app/console/components/nav.tsx:54-72` | Desktop rail is long.  Fine at ≥1024.  Crowded in the 1024–1280 band with the account chip. | Accept, or collapse Settings/Usage/Lessons under a overflow group at `<1280`. |
| P3 | new | theme toggle | `useConsoleTheme` cycle light → dark → system | System follows OS dark, which the owner did not want as a first-visit default.  Cycle is fine once chosen. | Keep.  First visit is already light. |

### Web phone / tablet

| Sev | Status | ID | Evidence | Issue | Fix |
|---|---|---|---|---|---|
| P1 | new | buried Scan | `app/console/lib/mobile-tabs.ts:19-28`; Playwright #3097 | Phone bar holds 4 tabs.  Scan is behind More.  Smoke already tripped on hidden desktop "Scan" text. | Raise default pins to include Scan, or raise `MOBILE_TABS_MAX` on tablet widths (768–1023).  iOS already does capacity-by-width. |
| P2 | ok | card vs table | watchlist/orders/positions/scan `lg:hidden` cards | Phone lists are cards; desktop is tables.  Good. | Keep. |
| P2 | ok | `/mobile` | `app/mobile/page.tsx` | Redirects to `/console`.  PWA stays retired. | Do not rebuild a PWA. |
| P2 | new | brand row | `app/console/components/shell.tsx:357` | Extra wordmark row on phone during intro, then slides away.  Can eat first-paint height on 375pt. | Confirm on a 375pt screenshot; shorten `MOBILE_BRAND_HOLD_MS` if it still covers Proposals. |
| P3 | new | tap targets | nav tab bar | Bottom bar exists.  Spot-check 44px on More sheet rows. | Measure in browser at 390pt. |

### iOS native

| Sev | Status | ID | Evidence | Issue | Fix |
|---|---|---|---|---|---|
| P1 | still open | `3b3df6ca` | `ios/SocraticTrade/MobileStore.swift:46` | `uniqueKeysWithValues` traps on duplicate ids. | `Dictionary(commands.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })`. |
| P1 | new | auth crash | `ios/SocraticTrade/LoginView.swift:638` | `preconditionFailure("No UIWindowScene available for auth presentation")` kills the process instead of a recoverable error. | Return a dummy / show an alert.  Never `preconditionFailure` on a production auth path. |
| P2 | new | version lie | `ios/project.yml:33-34` vs PLAN 1.0.69 | Repo `MARKETING_VERSION` is 1.0.8.  Ship script overrides. | Hand-sync to the last TestFlight.  Or have the ship script write `project.yml`. |
| P2 | ok | light default | `SocraticTradeApp.swift:41` | `.preferredColorScheme(.light)`.  Correct. | Keep. |
| P2 | ok | OAuth / decode | PR #3124 | Return-to-app + `date`/`timestamp` alias landed. | Keep.  Do not re-open. |
| P2 | ok | deep link | `SocraticTradeApp.swift:68`; `MobileControlView.swift:354-357` | Single `pendingDeepLink`.  Duplicate-binding merge bug is gone. | Keep. |
| P3 | new | device family | `project.yml` `TARGETED_DEVICE_FAMILY: "1,2,6"` | `6` is visionOS.  Unproven here. | Confirm intended.  Drop `6` if Vision is not a product. |

### Backend / API

| Sev | Status | ID | Evidence | Issue | Fix |
|---|---|---|---|---|---|
| P1 | still open | `9f875d62` | `src/lib/web-sources/sec8k.ts` skip/ok mix | Skip counted as success; embed failures can look like budget. | Classify 400/connection separately from daily budget.  `ok: false` when `error` is set. |
| P1 | still open | `41fba175` | board | Null embed → empty retrieval. | Fail closed with an explicit "retrieval unavailable", not an empty list. |
| P2 | ok | identity | `src/lib/request-user.ts`; `middleware.ts:476-481` | Middleware fail-closed 401.  Strips client `x-user-id`.  Approve uses `resolveRequestUserId(request, body)` and ignores body `userId`. | Keep.  This is the IDOR fence. |
| P2 | ok | TradingView | `app/api/webhooks/tradingview/route.ts` | Shared secret + optional IP allowlist (off by default).  No orders. | Keep.  Do not enable IP allowlist behind the tunnel without thinking. |
| P2 | new | `userId: "local"` | `src/lib/market-realtime.ts:276` | Peer Robinhood historicals use `"local"` on the operator peer path.  Comment says env token is not a live bypass. | Confirm the operator gate cannot read another user's Robinhood.  Leave unless proven. |

### Security / auth / copy / theme

| Sev | Status | ID | Evidence | Issue | Fix |
|---|---|---|---|---|---|
| P1 | new | logo theme | `app/console/ui/ticker-logo.tsx:21,28` | SSR dark; unset theme follows OS. | Default state `"light"`.  Unset `data-theme` → light, not `mq.matches`. |
| P2 | ok | html theme | `app/ui/theme.tsx:18` | Inline script defaults light.  Correct. | Keep. |
| P2 | ok | sentence gap | `SENTENCE_GAP` in approvals/orders/scan | Wired in several console strings.  Not universal. | Keep adding at copy touch sites.  Do not mass-rewrite. |
| P3 | new | LoginView colorScheme | `LoginView.swift:7,271` | Reads `colorScheme` even though the app forces light.  Harmless. | Ignore. |

### Fixed since the 2026-08-20/23 audits (do not re-file)

- Guardrails Discard clears Universe-group draft (`app/console/guardrails/universe-draft.ts:59-64`; `page.tsx:213`).  Board `c53ad066` should be re-verified then closed.
- `/mobile` → `/console`.
- iOS light default; website `themeInitScript` light default.
- Gather abort controller + last-good tape (remaining work is internal budget, Claude).
- Duplicate `@Binding pendingDeepLink` merge wreckage is gone.
- iOS OAuth return-to-app + equity-curve `date` alias (#3124).

## Surfaces walked

Web: `app/console/**` (Home, Proposals, Lessons, Activity, Scan, Watchlist, Macro, Orders, Coach, Strategy, Guardrails, Connections, Results, Usage, Settings), login, admin, `/mobile`.  Phone vs `lg:` card/table splits.  Nav rail vs 4-tab bar.

iOS: 39 Swift files under `ios/SocraticTrade`, `ios/project.yml`, auth, snapshot decode, tabs, commands.

Backend: `app/api/**` (dashboard, proposals approve, orders, mobile commands, webhooks, auth), `src/lib/alpaca.ts`, broker protective stops, order provenance, dashboard/fills, strategy-gather, request-user, middleware.

## Suggested fix order (implementation, not this PR)

1. Alpaca write map `stop_market` → `stop` + test flip (`d4cb5e75`).
2. MCP place: no REST fallback on uncertain timeout; 409 = success (`ef0dccb3`).
3. Provenance prefix for auto-replace (`d36c2233`).
4. Fills: limited newest-500 + stop loading the whole table (`79daff38`).
5. iOS uniqueKeys + LoginView `preconditionFailure`.
6. Web 401 → `/login`.
7. Ticker logo light default.
8. SEC skip/error honesty + embed-null retrieval.
9. Phone tab capacity / Scan pin.
10. `project.yml` version sync.

Do not implement in this docs PR.  Claim each board row before a code lane.  Claude owns `06df80cf`.  Do not HOTFIX during weekday RTH.

## Verification this session

- `git -C ~/apps/trading-grok-full-audit log -1 --oneline` → `ff7a562d9`
- Grep/read: `stop_market`, `callMcp` catch, `uniqueKeysWithValues`, `listFillEvents`, dashboard slice, `isAppPlacedBrokerOrder`, `fetchDashboard` 401, ticker-logo SSR, Guardrails `discardAllDrafts`, `/mobile` redirect, `preferredColorScheme(.light)`
- Board list ST P0/P1; prior review `docs/reviews/2026-08-23-cursor-full-stack-review.md`
- No `xcodebuild`.  No Coolify mutate.  No browser session against production auth.
