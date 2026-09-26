# 2026-09-25 — Data-source egress via residential proxy (per-user + operator default)

## Summary

Market-data/provider egress (quote cascade, enrichment providers, screeners,
Yahoo floor, VIX/macro feeds, price history) can now exit through a residential
HTTP CONNECT proxy instead of the datacenter IP, which upstream anti-bot
filters (Jay observed data sources failing from the datacenter IP) block or
degrade. The pattern mirrors Congress.Trade's
`app/src/shared/proxyFetch.ts` (Deno) — same env contract, same Mango
WireGuard default, same fail-soft fallback — ported to Node/undici.

Two layers:

1. **Operator default (env)** — `RESIDENTIAL_PROXY_URL` / host+parts, falling
   back to the Mango proxy `http://10.99.0.2:8888` on the WireGuard mesh when
   nothing is configured (CT parity: a missed env var must not silently run
   provider traffic datacentred). `RESIDENTIAL_PROXY_URL=off` disables
   proxying entirely.
2. **Per-user settings** — Settings → Data sources → "Data-source proxy"
   (`PUT/GET/DELETE /api/settings/proxy`). When a user has a proxy configured
   and enabled, THAT user's data-source traffic uses it. Stored in
   `user_proxy_settings`; password encrypted with the same ENCRYPTION_KEY
   machinery as API keys. The API returns only a masked view.

## What is proxied (and what never is)

Proxying is opt-in per call site through `dataSourceFetch()`
(src/lib/data-source-fetch.ts). Patched call sites: `fetchWithRetry` (the
central provider boundary in data-providers.ts — covers Finnhub, Tiingo,
Twelve Data, Massive, Alpaca market data, Nasdaq, Polymarket, ROIC, SimFin,
Wisesheets, MarketAux, Quiver, earnings transcripts, etc.), the Yahoo
cookie/crumb handshake (cached per effective proxy URL — creds are issued to
the egress IP), `yahoo-finance.ts` keyless chart/quote batch, `macro.ts` VIX
lanes, `history.ts` Yahoo bars.

Never proxied, structurally: qdrant, litestream, localhost/loopback/RFC1918
targets (bypassed in `isInternalFetchTarget` even if a call site opts in),
APNs, Sentry, OpenRouter/LLM calls, broker order/trade APIs (they don't use
`dataSourceFetch`), and the `usage-monitor` push (our own infra — exclusion
list in data-source-fetch.ts).

## Failure behavior (explicit)

Per user setting or `RESIDENTIAL_PROXY_FAILURE_MODE`:

- **fail_soft** (default, CT parity): a proxy-LEG transport error
  (ECONNREFUSED/timeout/reset reaching the proxy itself) logs a rate-limited
  warning and retries that request on direct egress. A dead home proxy
  degrades data identity/freshness, never app availability.
- **fail_closed**: the error propagates; the provider reads as down and the
  cascade moves on. Nothing ever leaves from the datacenter IP.

A proxy that ANSWERS with an HTTP error (e.g. tinyproxy 502 because the
upstream is down) is not a proxy failure — the response is returned as-is.
Direct egress would get the same upstream answer and only re-expose the
datacenter IP.

## Operator setup (Coolify)

Nothing is strictly required — the Mango default applies with zero config —
but set the env explicitly so the config is detectable in diagnostics:

```
RESIDENTIAL_PROXY_URL=http://10.99.0.2:8888
# optional, default shown:
RESIDENTIAL_PROXY_FAILURE_MODE=fail_soft
```

Host-side prerequisite (already true for congress-app on the same box): the
Coolify host's WireGuard interface (`wg-ct`) must be up and able to reach the
Mango peer. Verify FROM THE ST CONTAINER after deploy:

```
docker exec <socratic-app-container> node -e \
  "fetch('https://api.ipify.org',{dispatcher:new (require('undici').ProxyAgent)({uri:'http://10.99.0.2:8888'})}).then(r=>r.text()).then(console.log)"
# expect the residential egress IP (99.44.91.248 at time of writing)
```

If the Mango address ever changes, only `RESIDENTIAL_PROXY_URL` changes.

In-app verification: Settings → Data sources → Data-source proxy → "Test
egress" shows the egress IP data-source traffic currently exits as, live.

## Env var reference

| Var | Meaning |
|---|---|
| `RESIDENTIAL_PROXY_URL` | Full proxy URL, or `off`/`none`/`direct` to disable |
| `RESIDENTIAL_PROXY_HOST`/`_PORT`/`_USERNAME`/`_PASSWORD`/`_PROTOCOL` | Same, as parts |
| `HTTPS_PROXY` / `HTTP_PROXY` | Last env fallback (CT parity) |
| `RESIDENTIAL_PROXY_FAILURE_MODE` | `fail_soft` (default) / `fail_closed` |

## Files

- `src/lib/proxy-fetch.ts` — env resolution, undici ProxyAgent cache,
  proxied-fetch wrapper, proxy-leg error classification (Node port of CT's
  proxyFetch.ts).
- `src/lib/data-source-fetch.ts` — the single egress decision point:
  per-user → env → default resolution, internal-target and excluded-service
  bypass, fail_soft/fail_closed behavior.
- `src/lib/user-proxy-settings.ts` — per-user CRUD + validation + cached
  resolution. DDL in `src/lib/db.ts` (`user_proxy_settings`).
- `app/api/settings/proxy/route.ts` — GET/PUT/DELETE (masked).
- `app/api/settings/proxy/test/route.ts` — live egress canary (rate-limited).
- `app/console/settings/proxy.tsx` + `settings/lib.ts` + `settings/page.tsx` —
  the Settings card.
- Call-site patches: `src/lib/data-providers.ts`, `src/lib/yahoo-finance.ts`,
  `src/lib/macro.ts`, `src/lib/history.ts`, `app/api/quote/route.ts`.
- `package.json` — adds `undici` (run `npm install` to regenerate the
  lockfile); `next.config.mjs` — undici in serverExternalPackages, stubbed out
  of client/edge bundles.
- Tests: `test/proxy-fetch.test.ts`, `test/data-source-fetch.test.ts`,
  `test/user-proxy-settings.test.ts`.

## Differences from CT's implementation (deliberate)

- Node/undici ProxyAgent instead of Deno.createHttpClient.
- No hardcoded `/health` probe against the proxy: the retired Mac daemon
  served /health; tinyproxy does not. Health is the live canary
  (`/api/settings/proxy/test`) instead.
- Opt-in per call site instead of "all server-side scraping" — ST has live
  broker/APNs/LLM egress that must never traverse a residential proxy.
- Proxy-leg failure detection via undici error-code chain instead of blanket
  catch-and-fall-back.

## Verification

```
npm install            # picks up undici, regenerates package-lock.json
npm run typecheck      # if defined; otherwise: npx tsc --noEmit
npm test -- --run proxy-fetch data-source-fetch user-proxy-settings
npm test               # full suite before PR
```
