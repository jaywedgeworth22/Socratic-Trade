# API Surface Review — Socratic-Trade (app/api/**, app/admin/**)

Repo: /Users/jay/apps/trading-deepseek @ 41a7a438d (origin/main, clean). READ-ONLY review.
Known items not duplicated (per brief): 28996d82, 009b99f0, d97c8726, d2094c78, ecda4b71,
23f0ca01, cf888f3e, 6c36b9be, 937c3b0a, 5d9f6340, e116e375, 0706c22a, 830c892f, 2ca6ce08,
89249c60, a3ccc8a9, 57f94f95, fa8dc319, 30a5e1ba, 620ef423, 3b343933, 923df16c.

## Summary

The API surface is in unusually good shape for its size: auth is a single trusted-header model
(middleware strips client-supplied identity, sets a verified email; handlers use
`resolveRequestUserId`), every admin route calls `requireAdmin`, the peer-read market routes and
webhooks use constant-time bearer/HMAC checks, and the iOS decoders are defensively written. The
real problems are consistency and completeness rather than holes: error envelopes are NOT uniform
(three shapes coexist, plus plain-text errors), several broker-backed GET routes and two money
paths throw uncaught into Next's generic 500, malformed JSON bodies 500 instead of 400 on three
routes, and the only *public, unauthenticated* I/O route (`/api/health`) is unthrottled. No P0/P1
defects found.

## Findings

### P3 | Error envelope is inconsistent across routes: `{error}`, `{ok:false,error}`, and plain text all coexist
Evidence:
- `{ok:false,error}`: `app/api/market/quotes/route.ts:26,38`, `app/api/market/intraday/[symbol]/route.ts:26,38,41`, `app/api/webhooks/congress/route.ts:28,34,46,48,58,65,94`, `app/api/webhooks/tradingview/route.ts:43,47,61,63,68,74,92`, `app/api/admin/securities/import/route.ts:42,49,88`, `app/api/mobile/push/register/route.ts:56,70,74`
- `{error:...}` (no `ok`): `app/api/chat/route.ts:92,100,111,133,161,185`, `app/api/proposals/from-draft/route.ts:45,48,140,144,152,164`, `app/api/quote/route.ts:59,111`, `app/api/alerts/route.ts:25,42`, `app/api/watchlist/route.ts:28,34,43`, `app/api/keys/route.ts:290,349,409,442,447`, `app/api/strategy/*`, `app/api/overlays/*`, `app/api/socratic/*`
- Plain text/HTML where a JSON API is being served: `app/api/orders/route.ts:12` ("No selected account."), `app/api/portfolio/route.ts:12`, `app/api/positions/route.ts:12`, `app/api/policy/route.ts:48,54,58,71,74,159,206,224`, `app/api/proposals/[id]/approve/route.ts:39-40`, `app/api/proposals/[id]/reject/route.ts:14,27`, `app/api/orders/cancel/route.ts:29`, `app/api/connected-accounts/[id]/route.ts:11,14,25,31`, `app/api/strategy/enable/route.ts:13,14,19,22,23`, `app/api/strategy/pause/route.ts` (no error paths at all), `app/api/learned-context/[id]/route.ts:16,22`
What's wrong: A consumer cannot rely on a single error shape; `fetch` code must special-case text-vs-JSON and `{error}`-vs-`{ok:false,error}`. Web console wrappers and any future client must hand-mirror all three. There is no shared error responder.
Suggested fix: Add a shared `jsonError(status, code, message, extra)` helper in `src/lib/` and migrate the plain-text `new NextResponse(msg, {status})` sites; pick ONE envelope (`{ok:false,error,code?}`) for 4xx/5xx. Effort: M.

### P3 | Broker-backed GET routes throw uncaught → Next generic 500 (non-JSON) when the broker is down
Evidence:
- `app/api/orders/route.ts:13` — `NextResponse.json(await getBrokerGateway(...).getEquityOrders(...))`, no try/catch
- `app/api/portfolio/route.ts:13`, `app/api/positions/route.ts:13`, `app/api/accounts/route.ts:10` — same pattern
- `app/api/watchlist/route.ts:20` — `getEquityQuotes` uncaught
- `app/api/orders/cancel/route.ts:31` — `throw error;` after only handling `OrderCancelPreconditionError` (a timeout/5xx from the broker escapes as a generic 500)
What's wrong: When Alpaca/Tradier errors (which has happened in prod), these emit Next's default 500 page (HTML in dev, plain text in prod) instead of the JSON envelope, breaking any client that parses JSON and hiding the broker reason. Compare `app/api/orders/replace-market/route.ts:79-90` and `app/api/proposals/from-draft/route.ts:158-165`, which map broker failures to structured 400/409/502.
Suggested fix: Wrap each in try/catch and return `{ok:false,error}`/`{error}` with a 502 and a bounded broker message (the codebase already has `messageFromUnknownError` / `appendErrorCause`). Effort: S.

### P3 | Malformed JSON request bodies 500 instead of 400 on three routes
Evidence:
- `app/api/orders/cancel/route.ts:20` — `const { orderId } = await request.json();` uncaught (SyntaxError → 500)
- `app/api/policy/route.ts:46` — `const rawBody: unknown = await request.json();` uncaught (same)
- `app/api/keys/route.ts:337` — `await request.json()` inside try, but the catch maps everything to `status: 500` with `"Failed to save API key"` (line 431-432), so a garbage body is a 500, not a 400
What's wrong: Client-side serialization bugs become opaque 500s; contrast with `app/api/chat/route.ts:83` and `app/api/mobile/commands/route.ts:30` which use `.catch(() => ({}))`, and `app/api/mobile/auth/apple/route.ts:67-68` which explicitly maps SyntaxError → 400.
Suggested fix: `.catch(() => ({}))` or a SyntaxError → 400 branch on the three sites. Effort: S.

### P3 | POST /api/proposals/from-draft has no rate limit, while every sibling proposal path is limited
Evidence: `app/api/proposals/from-draft/route.ts` — no `enforceRateLimit`/`rateLimit` import or call anywhere in the file (read in full); it does broker `getPortfolio` + `getEquityPositions` reads and DB writes per call (lines 155-165, 270-291). Siblings that DO charge the limiter: `app/api/proposals/[id]/approve/route.ts:18`, `app/api/proposals/[id]/retry-red-team/route.ts:15`, `app/api/proposals/bulk-approve/route.ts:85` (per proposal).
What's wrong: The "chat draft → staged proposal" money path is the one unguarded entry into the proposal pipeline; a loop bypasses the 20/min orders limiter that protects the adjacent approve rail and drives repeated broker round-trips.
Suggested fix: `enforceRateLimit(userId, "proposals/from-draft", RATE_LIMITS.orders)` after `resolveRequestUserId` (line 42). Effort: S.

### P3 | /api/health is public, unthrottled, and performs network + disk + IPC I/O on every request
Evidence: `middleware.ts:57` lists `/api/health` in `PUBLIC_PREFIXES`; `app/api/health/route.ts:310` awaits `getOpenRouterCreditStatus(..., {maxWaitMs: 1_500})` (a real outbound fetch on cache miss), `:357` `statfsSync`, `:364-370` litestream IPC read, `:401-403` runtime log file scan. No `enforceRateLimit` anywhere in the route.
What's wrong: An anonymous hammer can drive repeated outbound OpenRouter API calls, disk statfs, and litestream IPC reads against a liveness probe — exactly the route UptimeRobot and Coolify hit constantly. `app/api/live` is the cheap probe by design (live/route.ts:16-18: "Cheap on purpose"); `/api/health` is the expensive one and is equally public.
Suggested fix: Add a small IP-keyed or global limiter (e.g. 60/min, fail-open like the existing limiter's policy) in the handler, or point external monitors at `/api/live` and require `x-ops-token` for the rich probe. Effort: S.

### P3 | GET /api/history collapses total failure into 200 with an empty array and a `note` string
Evidence: `app/api/history/route.ts:46-48` — `catch { return NextResponse.json({ symbol, bars: [], note: "price history fetch failed" }) }` (200). Contrast `app/api/quote/route.ts:111` which returns 502 `{symbol, error}` on total failure, and `app/api/market/intraday/[symbol]/route.ts:50-51` which returns 502 on provider failure.
What's wrong: The chart consumer cannot distinguish "symbol has no history" (legit empty) from "provider failed" except by string-matching the `note`; a provider outage renders as an empty chart with no error path.
Suggested fix: Return 502 with `{error: "price history fetch failed"}` and let the client keep the last-good chart; keep 200 only for genuine no-data. Effort: S.

### P4 | /api/admin/reindex-10k POST returns 200 with an embedded `ok:false` on partial failure
Evidence: `app/api/admin/reindex-10k/route.ts:174` — `return NextResponse.json({ ok: result.errors.length === 0, result, vectorStore: stats, clearedCache: clearCache })` with default 200 even when `result.errors.length > 0`.
What's wrong: A backfill with errors is a 200 `ok:false`; an operator polling status (or a script) must inspect the body, and monitoring can't alarm on status codes. Operator-only route, so low severity.
Suggested fix: `status: result.errors.length === 0 ? 200 : 502` (or 422) while keeping the same body. Effort: S.

### P4 | Rate limits absent on several high-value/live paths
Evidence (all files read):
- `app/api/strategy/run/route.ts:20-99` — POST kicks an LLM-funded full strategy run; no limiter (compare `app/api/strategy/tune/route.ts:46` which uses `RATE_LIMITS.strategyTuning`). Dedup in `src/lib/strategy-run-requests.ts:80-95` (one open queued/running request per user) limits stacking, but each accepted call spends operator LLM budget.
- `app/api/orders/route.ts:13`, `app/api/portfolio/route.ts:13`, `app/api/positions/route.ts:13`, `app/api/accounts/route.ts:10`, `app/api/watchlist/route.ts:20` — live broker round-trips with no limiter (only cancel/replace/approve/scan/quote/chat/symbol-desk/tune/mobile-* carry limits; see `src/lib/rate-limit.ts:121-136` for the classes that DO).
- `app/api/events/stream/route.ts:41` and `app/api/mobile/events/route.ts:41` — no cap on concurrent SSE connections; each holds an in-process event-bus subscription plus a 25s heartbeat interval (session-gated, but a client can open unbounded streams).
- `app/api/notifications/test/route.ts:11-21` — POST triggers real outbound channel sends (Pushover/Twilio SMS/webhook) per call, no limiter.
- `app/api/mobile/auth/apple/route.ts:12-72` — public endpoint (middleware.ts:83), remote Apple JWKS verification per call, no limiter.
What's wrong: None of these is a P0/P1 in a single-operator, fully-authenticated app, but the pattern is inconsistent — the very classes the brief calls "high-value" (orders, proposals, ops-adjacent, live, SSE) are partially unguarded while lower-value reads (scan, symbol-desk, quote) are limited.
Suggested fix: Add `enforceRateLimit` to strategy/run (reuse `RATE_LIMITS.strategyTuning` or a new 5/min class), a modest per-user SSE connection cap, and a rate limit on notifications/test and mobile/auth/apple. Effort: S–M.

### P4 | No Cache-Control on any quote/intraday/history route (missed caching, not stale-serving)
Evidence (grep for cache-control in app/api): only `app/api/logos/ticker/route.ts:73,91,110,121` (public max-age 1d), `app/api/admin/server-metrics/route.ts:727` + `app/api/admin/backup-status/route.ts:97` (private no-store), `app/api/events/stream/route.ts:69` + `app/api/mobile/events/route.ts:68` (no-cache), `app/api/framework/content/route.ts:41` (no-store). Missing on: `app/api/quote/route.ts` (fans out to 3–4 providers per call, lines 68-90), `app/api/history/route.ts` (provider fetch), `app/api/market/prices/[symbol]/route.ts`, `app/api/market/quotes/route.ts`, `app/api/market/intraday/[symbol]/route.ts`, `app/api/market/spx/route.ts`, `app/api/scan/route.ts`, `app/api/watchlist/route.ts:10-22`.
What's wrong: Nothing *wrong* — no route sets a long max-age that could serve stale intraday prices, and no public quote route is no-store'd into uselessness (peer routes are token-gated; session routes are user-scoped). But the EOD routes (`/api/history`, `/api/market/prices`, `/api/market/spx`) are highly cacheable and each hit re-fetches from providers; `/api/quote` re-runs the whole cascade on repeat drilldown. This is the "cache freshness freeze" cousin without any of the freeze.
Suggested fix: `Cache-Control: public, max-age=3600, stale-while-revalidate=86400` on `/api/history` + `/api/market/prices` + `/api/market/spx` (EOD data), and a short `max-age=15` on `/api/quote` to absorb drilldown re-fetches. Effort: S.

## Verified and found sound (not listed as findings)

- **Admin gate holds**: all 25 `app/api/admin/**` route files call `requireAdmin` (script-verified — zero admin routes without a gate); `/api/admin/securities/import` uses its own constant-time `APP_B_INGEST_TOKEN` bearer model and is default-closed (`securities-import-auth.ts:19-28`); the `/admin` page tree is gated in `middleware.ts:460` via the same `isAdminEmail` allowlist; `requireTokenInProd` strengthens the cost-side-effecting reindex routes (`admin.ts:82-85`).
- **Identity model**: `middleware.ts:337,465-466` strips client-supplied identity headers and re-sets a verified `x-authenticated-user-email`; `request-user.ts:49-74` ignores body/query `userId` hints; only `app/api/admin/learning-ledger/route.ts:44` reads the header directly, for audit attribution after `requireAdmin` passes. No route trusts a client-supplied identity header.
- **Ops**: `/api/ops/snapshot` is token-only (`OPS_DIAGNOSTIC_TOKEN`, no `ADMIN_REINDEX_TOKEN` fallback, constant-time; `ops-auth.ts:38-47`), and `/api/health`'s detailed projection is gated on the same token; `/api/live` exposes only `{ok, probe}`.
- **Webhooks** (congress + tradingview): HMAC/bearer with bounded streaming bodies and 401/403/413/422/500 mapping; never throw into the app.
- **Peer market routes**: token-verified, `enforceRateLimit("peer-app","peer-read",120/min)`, bounded symbol count (quotes: MAX_SYMBOLS=200), 8-day intraday range cap.
- **Rate limits present**: chat (30/min), scan (30/min), quote (60/min), symbol-desk (60/min), mobile/commands (60/min), mobile/push/register (30/min), strategy/tune (10/min), robinhood OAuth start/callback (10/min), proposals approve/retry-red-team/bulk-approve (20/min), orders cancel/replace-market (20/min).
- **iOS shape stability**: `/api/mobile/snapshot`, `/api/quote`, `/api/symbol-desk`, `/api/scan`, `/api/mobile/commands` all project stable key sets; Swift decoders (`MobileModels.swift`, `DeskModels.swift`) use `decodeIfPresent` + defaults throughout; no NEW drift found beyond the known item 89249c60.

## Verification notes (exact commands run)

- `find /Users/jay/apps/trading-deepseek/app -name "route.ts" -o -name "route.tsx" | sort` — enumerated 137 route files.
- `ls -R app/admin/` — enumerated admin page tree.
- `grep -rn "enforceRateLimit|rateLimit(" app/` — mapped rate-limited routes.
- `grep -rn "Cache-Control|cache-control|max-age|no-store|s-maxage" app/api` — mapped cache headers.
- `grep -rn 'headers.get("x-authenticated-user-email")' app/api` — direct identity-header reads (1 hit: learning-ledger audit attribution).
- `for f in $(find app/api/admin -name route.ts); do grep -q requireAdmin ...` — verified every admin route has a gate (zero gaps).
- Read in full (file-by-file): middleware.ts, health, live, ops/snapshot, orders(+cancel,+replace-market), proposals(approve, reject, bulk-approve, retry-red-team, from-draft), market(prices, quotes, intraday, spx, flatfile), quote, scan, history, dashboard, mobile(snapshot, events, commands, commands/[id], push/register, consent, auth/apple, auth/exchange, auth-redirect, bootstrap, account-deletion request/confirm), notifications(+ack,+mute,+test), alerts, watchlist, chat(+cancel,+providers), chat-history, policy, keys, strategy(run, tune, enable, pause), connected-accounts(+, /[id], activate, import-settings, performance), webhooks(congress, tradingview), admin(reindex-10k, securities/import, backup-status, server-metrics, connections-health, transcript), settings(auto-resume, llm-budget), account/deletion, audit, csp-report, framework/content, learned-context(+[id]), memory, overlays([id]), socratic/decisions/[id], llm-usage(+model-stats), plus targeted sed/grep on ~15 more.
- Auth libs read in full: src/lib/auth/admin.ts, src/lib/request-user.ts, src/lib/securities-import-auth.ts, src/lib/ops-auth.ts, src/lib/rate-limit.ts, src/lib/provider-rate-limit.ts, src/lib/strategy-run-requests.ts (dedup logic).
- iOS consumers read: ios/SocraticTrade/MobileAPIClient.swift (endpoints), MobileModels.swift (decoders), DeskModels.swift (MarketScanResponse).

No repo files were modified; all scratch notes are in /tmp.
