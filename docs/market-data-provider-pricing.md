# Market-data provider pricing & tier facts (canonical)

Single source of truth for what each market-data provider costs, what each tier
actually unlocks, and the traps we have already misread once. **Update this file
whenever a plan changes or a price is re-verified — cite the source and date.**
The live subscription state (what we actually pay) belongs in the API-Usage-Monitor
app; this doc records the *vendor facts* so agents stop re-deriving (and
re-misinterpreting) them.

Verified 2026-07-10 against live vendor pages (headless-rendered where noted),
plus owner corrections. **Re-verified plan-tier quotas 2026-08-06** from live
vendor pages (ROIC, Twelve Data `pricing.md`, Marketstack, Massive, Alpha
Vantage premium ladder, Tiingo matrix) after owner note that agents often invent
worse quota facts than the public docs — see "2026-08-06 plan-tier research"
below. Trading-app integration facts verified against this repo and prod
`api_health_log` evidence the same day.

**Scope, extended 2026-07-10:** the table directly below covers the seven core
quote/fundamentals/history vendors. Everything past the "Upgrade cheat-sheet"
table covers every OTHER external data source the app touches: secondary keyed
fallbacks with real paid tiers (marketstack, tradier, logo.dev, fintech
studios, FRED), keyless/broker-bundled sources (yahoo, the nasdaq screener,
webull, SEC, alpaca, robinhood, stooq), the owner's own sibling app
(congress.trade), usage-billed LLM/RAG spend (pointer to API-Usage-Monitor, not
priced here), and budget alternatives that were researched but are NOT
integrated. Same rule applies to all of it: cite the source and date, correct
in place when a fact changes.

## Quick comparison — cheapest useful tier

| Provider | Free tier reality | Cheapest paid | Annual option | What paid unlocks (for us) |
|---|---|---|---|---|
| **Tiingo** | 50 req/hr, 1,000/day, 500 unique symbols/mo; **News API not included** (every news call 403s) | **Power $30/mo** | **$300/yr (2 months free)** — owner-verified 2026-07-10; the $499/yr on their site is the separate *commercial* license | 10,000 req/hr, 100,000 req/day, News API. **Fundamentals are NOT included** — separate contact-sales add-on on every tier |
| **Massive** (ex-Polygon, rebranded 2025-10-30) | 5 calls/min, EOD only, 2 yr history | **Stocks Starter $29/mo** — **we already pay this** | $288/yr ($24/mo effective) | Unlimited API calls, 15-min delayed, 5 yr history, WS aggregates. Real-time + trades/quotes + financial ratios = Advanced $199/mo |
| **FMP** | 250 calls/day, EOD | **Starter $22/mo billed annually** ($264/yr) — **our active plan** | Premium $59/mo annual; Ultimate $149/mo annual | Starter: 300 calls/min, 20 GB/30d, real-time US quotes, annual-only fundamentals. Premium: quarterly/full fundamentals, 750/min, 50 GB. **Earnings-call transcripts require Ultimate** (3,000/min, 150 GB); display/redistribution also requires a separate agreement |
| **Twelve Data** | 8 credits/min, 800/day | Grow **from $29/mo** (55 credits) | Annual −17% | Grow SKUs: 55 / 144 / 377 credits/min (no daily). Pro from $99 (610+). Ultra from $329 (2,584+). Credits = endpoint weight × symbols (fundamentals cost 100 credits/symbol — poor value for us). Full WS starts at Pro |
| **Finnhub** | 60 calls/min (generous), US-only | **All-In-One $3,500/mo** — annual-only ($42,000/yr) | n/a | No affordable paid step exists. Stay free |
| **Alpha Vantage** | Nominally 25 req/day — **but enforced PER IP**, so key rotation from one box is useless (proven in prod 2026-07-10: exactly 25 OKs, then all 6 pool keys instantly rejected) | $49.99/mo (75 req/min) | $499/yr ($41.58/mo, "2 months off") | Higher rate limits, no daily cap. Total overlap with FMP+Finnhub for us. Skip |
| **Yahoo Finance** | Keyless, free, no SLA — unofficial endpoints, can throttle/block anytime | n/a | n/a | Floor of the cascade, never a contract |

Sources: tiingo.com/pricing (+ owner-verified annual), massive.com/pricing (Stripe
plan payload embedded in page), site.financialmodelingprep.com/pricing-plans
(rendered; monthly toggle would not switch), twelvedata.com/pricing +
**twelvedata.com/pricing.md** (agent-readable ladder, 2026-08-06), finnhub.io/pricing
(rendered), alphavantage.co/premium (+ /support for the 25/day statement — per-IP
enforcement is NOT documented there; it is our own prod-observed fact),
**roic.ai/pricing** (2026-08-06), **marketstack.com/pricing** (2026-08-06).

## 2026-08-06 plan-tier research (Connections dropdowns)

Owner direction: plan tiers must be researched on each site's docs; owner often
finds better quota facts than agents assume. Do **not** invent daily caps when the
vendor publishes per-minute or monthly units. Code map:
`src/lib/provider-tier-plan.ts` + free-safe `RATE_QUOTAS` in `provider-rate-limit.ts`.

| Provider | Verified tiers (2026-08-06) | Free-safe app default | Notes / traps corrected this pass |
|---|---|---|---|
| **ROIC** | Free: **5 req/min**, 2 transcript quarters, 2 yr history · Individual **$29**: **300 req/min**, **20** transcript quarters · Professional **$89**: unlimited RPM, all quarters · Enterprise custom | **5/min** (was wrongly 300/day then 10k/day) | No public "Starter" SKU — removed invented tier. Transcript depth 2/20/all (app caps "all" at 40/symbol/run). Source: https://www.roic.ai/pricing |
| **Twelve Data** | Basic free 8/min + 800/day · Grow 55 ($29) / 144 ($49) / 377 ($79) · Pro 610 ($99) / 987 ($149) / 1597 ($229) · Ultra 2584 ($329) / 4181 ($499) / 10946 ($999) | 8/min + 800/day | Family ids `grow`/`pro`/`ultra` map to **floor** of that family; exact SKUs `grow_377` etc. for what you actually pay. Source: https://twelvedata.com/pricing.md |
| **Marketstack** | Free 100/mo · Basic 10k/mo ($9.99) · Professional 100k/mo ($49.99) · Business 500k/mo ($149.99) | **100 / 30d** rolling | Was approximating ~3/day — use monthly window matching vendor. Source: https://marketstack.com/pricing |
| **Massive** | Stocks Basic free 5/min · Starter $29 unlimited · Developer $79 unlimited · Advanced $199 unlimited | 5/min | Added Developer tier. Source: https://massive.com/pricing |
| **Alpha Vantage** | Free 25/day (per-IP observed) · Premium 75 / 150 / 300 / 600 / 1200 per min ($49.99…$249.99 monthly; annual 2 mo off) | 25/day | Full ladder in dropdown; `premium` = entry 75/min. Source: https://www.alphavantage.co/premium/ |
| **Tiingo** | Free 50/hr 1k/day · Power 10k/hr 100k/day ($30 or $300/yr individual) · commercial contact-sales | free windows | Unchanged; commercial not a self-serve RPM ladder on the public matrix. Source: tiingo.com/about/pricing |
| **Finnhub** | Free **60/min** (app paces 50) · All-In-One ~$3.5k/mo only jump | 50/min | **Do not invent** paid RPM (e.g. 900/300) without dashboard/docs receipt — `all_in_one` tier is unlimited in map; set env when confirmed |
| **FilingAPI / Marketaux / FintechStudios / EarningsCalls / RapidAPI** | Partial | free-safe placeholders | Not fully re-fetched this pass — hints say re-verify; paid = env override, no invented high daily |

**Process rule (binding):** before changing a tier number in code, open the vendor
page (or paste owner receipt) and date the citation in this file. Prefer the
vendor's unit (min / hour / month) over converted approximations.

## Traps already hit once (do not re-learn these)

1. **Tiingo News API is paid-only.** On the free key every `/tiingo/news` call
   returns HTTP 403 — that burned a third of our 50/hr budget and made tiingo look
   "down" in health until `TIINGO_DROP_NEWS=true` shipped (2026-07-10). If Power is
   purchased, flip that flag off; note tiingo has historically also required a
   use-case application for news access — confirm it's active before relying on it.
2. **Tiingo Power annual exists ($300/yr)** even though the public pricing matrix
   renders monthly-only — an agent misreported "no annual option" on 2026-07-10;
   owner corrected from the actual billing flow. Verify pricing in the signup/billing
   flow, not just the marketing matrix.
3. **Alpha Vantage caps per IP, not per key.** A 6-key rotation pool from one box
   yields 25 requests/day total. Their site never documents the per-IP behavior.
4. **FMP's displayed prices are annual-billed.** The "$22/mo" Starter is $264
   charged yearly; their monthly-billed price is hidden behind a toggle that may
   not render. Starter fundamentals are **annual statements only** — TTM/quarterly
   depth needs Premium. **A paid, below-quota Starter key is still not entitled to
   transcript endpoints:** the owner's dashboard showed 0/300 calls/min, 3.01/20 GB,
   and 0% over-limit while the stable transcript endpoints returned HTTP 402. FMP's
   current matrix places Earnings Call Transcripts only on Ultimate ($149/mo billed
   annually), and says display/redistribution requires a Data Display and Licensing
   Agreement.
5. **Massive ≠ quotes provider for us.** It's history + full-universe breadth +
   FINRA short interest. Real-time per-symbol quotes on Massive start at $199/mo —
   that job belongs to tiingo/brokers here.
6. **Finnhub has no middle tier.** Free (60/min) then $3,500/mo. Never budget for
   "Finnhub paid".
7. **ROIC free is 5/min, not a daily invent.** Agents previously coded 10k/day then
   300/day free-safe — both wrong. Pricing page is requests/minute + transcript
   quarter depth. Individual is 300/min and 20 quarters, not "10k/day".
8. **Twelve Data Grow is not "377".** 377 is one Grow SKU ($79); the family starts at
   55 credits/min ($29). Using 377 as the default Grow map over-admits lower SKUs.
9. **Marketstack is monthly.** Dividing by 30 for a daily hard default under-uses
   paid plans and mislabels free (100/mo ≠ 3/day in the vendor UI).

## What we run today (2026-07-10)

- **Paying:** Massive Stocks Starter ($29/mo — annual would save $60/yr), FMP
  (Starter-equivalent, key responds paid; the app's tier probe alerts if it lapses).
- **Free:** tiingo (news dropped), Twelve Data (window-gated to 8 credits/min),
  Finnhub, Yahoo, Alpha Vantage (effectively dead — per-IP cap).
- **Under consideration:** tiingo Power ($30/mo or $300/yr) — fixes the enrichment
  quote bottleneck + news; FMP Premium ($59/mo-annual) — only if quarterly-fresh
  ratios prove necessary after tiingo relieves cascade pressure; FMP Ultimate
  ($149/mo-annual) only if transcript value plus the required content license justify it.

**Tiingo is now ALSO a history-cascade source, added 2026-08-02.** Previously
`TiingoEnrichmentProvider` only called `/iex` (quote) and `/tiingo/daily/{ticker}`
(latest-price metadata) — never the actual `/tiingo/daily/{ticker}/prices` EOD
history endpoint, so a configured Tiingo key delivered NONE of the "30+ years
split/dividend-adjusted history" value this doc's research pass promised.
`history.ts`'s `fetchDailyOHLC` now calls that endpoint too, seated after
Tradier and before Marketstack (its free tier's real 1,000/day cap comfortably
beats Marketstack's 100/month), sharing the SAME account-wide `"tiingo"`
`RATE_QUOTAS` budget as the enrichment provider via `admitProviderRequests` so
the two call sites can't together exceed the real 50/hour vendor cap.

## Where the dials live

Every quota/pacing/tier flag is an env var in **Infisical prod** (seeded with
code defaults 2026-07-10; boot-time injection ⇒ changes apply on the next deploy):
`PROVIDER_QUOTA_{TIINGO,TWELVEDATA,FMP}_PER_{MIN,HOUR,DAY}`,
`PROVIDER_DISPATCH_{VOYAGE,PINECONE}_PER_MIN`,
`PROVIDER_DISPATCH_{VOYAGE,PINECONE}_MAX_COST_USD_PER_DAY`,
`PROVIDER_QUOTA_AUTHORITY_ID`,
`PROVIDER_RATE_LIMIT_{FINNHUB,ALPHA_VANTAGE,YAHOO_FINANCE,TWELVEDATA}_*`,
`TIINGO_DROP_NEWS`, `FINNHUB_DROP_RECOMMENDATION`, `ALPACA_DATA_FEED`,
`MASSIVE_{HISTORY,SHORT_INTEREST}_ENABLED`, `MASSIVE_REST_MAX_CALLS_PER_MINUTE`.
Resolution logic: `src/lib/provider-rate-limit.ts`. Subscription→knob automation
(API-Usage-Monitor as source of truth): the **Mac-side sync shipped 2026-07-10** —
`scripts/sync-provider-knobs.sh` + `scripts/com.jay.provider-knob-sync.plist` GET the
monitor's `/api/subscriptions`, map each plan's status to knobs (active→`knobEnv`,
canceled/paused→`freeTierKnobEnv`, considering→skip), and write only the diffs into
Infisical prod via the proven universal-auth CLI path (allow-listed keys only). It is
**gated on the monitor's `/api/subscriptions` endpoint** (parallel PR) and dry-runs by
default; the launchd job is not installed yet. See
`docs/rollouts/2026-07-10-provider-knob-sync.md`.

Socratic-Trade now also commits one durable provider-attempt reservation before each actual FMP,
Voyage, or Pinecone boundary and replays deterministic outcomes (`succeeded`, `failed`, or crash-
reconciled `unknown`) through API Usage Monitor. The FMP enrichment and transcript paths therefore
share the same credential-wide quota inside this app. This does **not** yet prove cross-app quota
authority: the same `PROVIDER_QUOTA_AUTHORITY_ID` in two separate SQLite databases still yields two
independent ledgers. Transcript activation remains blocked until every app using the shared FMP
credential reserves against one transactional authority.

**Known gap, updated 2026-08-02** (the original 2026-07-10 version of this note
said `HARD_DEFAULTS` had "exactly four" entries — that count went stale as
more providers were added since and is corrected here): `provider-rate-limit.ts`'s
`HARD_DEFAULTS` pacing map now covers 13 providers — `finnhub`, `alpha-vantage`,
`yahoo-finance`, `nasdaq-quote`, `twelvedata`, `mboum-finance`, `yahoo-finance15`,
`alpha-vantage-rapidapi`, `yh-finance-apidojo`, `real-time-finance-data`,
`seeking-alpha-rapidapi`, `filingapi`, and (added 2026-08-02) `roic`. The
SEPARATE `RATE_QUOTAS` windowed-budget map (see the RapidAPI section above for
why the nine RapidAPI-hosted lanes use their own, third, budget mechanism
instead) now covers six: `twelvedata`, `tiingo`, `fmp`, and (added 2026-08-02)
`filingapi` (45/day), `roic` (**5/min** free-safe, 2026-08-06 vendor verify —
was briefly 200/day then 300/day invents), `marketstack` (**100 / 30d month**
window, not 3/day). For `filingapi`/`roic` this cap is ACTIVE immediately —
see trap #12 above: both providers already called `admitProviderRequests`
believing a quota existed, so defining one here closes a real enforcement gap.
`marketstack` is different: `history.ts`'s `fetchMarketstack` doesn't call
`admitProviderRequests` at all (it goes through `politeFetchJson`, unrelated
to this module) — the entry defines the correct budget shape for whenever that
call site is wired, but does not by itself throttle marketstack calls today.

**`tradier`, `fred`, `fintechstudios`, and `logodev` still have NEITHER a
`HARD_DEFAULTS` pacing entry NOR a `RATE_QUOTAS` budget entry.** Nothing
throttles these four today besides the generic `fetchWithRetry` 429 backoff.
`resolveProviderLimiterConfig`/`resolveProviderQuota` still let an operator add
either ad hoc via the generic `PROVIDER_RATE_LIMIT_<NAME>_{PER_MIN,MIN_INTERVAL_MS,CONCURRENCY}`
/ `PROVIDER_QUOTA_<NAME>_PER_{MIN,HOUR,DAY}` env vars (both fall through to env
even with no hard default) — but that's an unused escape hatch, not a
documented knob. Don't describe a pacing/budget behavior for these four that
isn't there; if one starts 429ing in prod, wiring a `HARD_DEFAULTS`/
`RATE_QUOTAS` entry (or at minimum setting the env override) is the fix, not
something already handled.

### Upgrade cheat-sheet

| You bought | Set in Infisical |
|---|---|
| tiingo Power | `PROVIDER_QUOTA_TIINGO_PER_HOUR=10000`, `PROVIDER_QUOTA_TIINGO_PER_DAY=100000`, `TIINGO_DROP_NEWS=false` |
| FMP Starter / Premium | `PROVIDER_QUOTA_FMP_PER_MIN` (default **290**; FMP Starter = 300/min, 290 leaves headroom) — raise it on a higher plan, set `0` to remove the minute cap. `PROVIDER_QUOTA_FMP_PER_DAY` is UNSET (no daily cap) by default; set it (e.g. `240`) only on the free 250/day tier. `FMP_MAX_SYMBOLS` remains the separate symbols/scan throttle applied before the quota. |
| Twelve Data Grow | `PROVIDER_QUOTA_TWELVEDATA_PER_MIN=377`, remove/raise `_PER_DAY` |
| Massive → free downgrade (don't) | `MASSIVE_REST_MAX_CALLS_PER_MINUTE=5` |
| Alpaca SIP feed | `ALPACA_DATA_FEED=sip` |
| Marketstack Basic ($9.99/mo, 10,000 req/mo) | `PROVIDER_QUOTA_MARKETSTACK_PER_DAY=333` (10,000/30) — raise further on Professional/Business |
| FilingAPI.dev higher tier (once confirmed) | `PROVIDER_QUOTA_FILINGAPI_PER_DAY=<new cap>` — the built-in 45/day assumes the ~50/day free tier |
| ROIC.ai confirmed limit / paid tier | `PROVIDER_QUOTA_ROIC_PER_DAY=<confirmed cap>` — the built-in 200/day is a conservative placeholder, not a vendor-confirmed number |
| tradier / fred / fintechstudios / logodev upgrade | No knob exists yet — set `PROVIDER_RATE_LIMIT_<NAME>_PER_MIN` by hand if 429s show up (see gap note above) |

## Secondary / fallback sources — keyed, integrated, lower stakes

These are wired into the app the same way as the core seven (keyed, cascade
position matters, `shared-operator-infra` cred tier — see
`src/lib/db-api-keys.ts`), but each plays a smaller/fallback role, so they get a
lighter table. Verified 2026-07-10 against live vendor pages (direct `curl`/fetch
of raw HTML, not just AI-summarized) plus this repo's own source.

| Provider | Role in this app | Free tier reality | Cheapest paid | Annual option | What paid unlocks (for us) |
|---|---|---|---|---|---|
| **Marketstack** (`MARKETSTACK_API_KEY`) | 3rd (last) keyed daily-OHLC history fallback, after Massive and Tradier — `src/lib/history.ts:22,64-65,98-99,232-237` | 100 req/mo, EOD only, 1yr history, HTTPS included (see trap #7 below). `provider-rate-limit.ts`'s `RATE_QUOTAS` now approximates this as a 3/day budget (see trap #12/Known gap above) — the budget shape is defined but not yet wired into `fetchMarketstack`'s call site | **Basic $9.99/mo** | **$8.99/mo billed yearly** (~10% off) | 10,000 req/mo, IEX intraday data, 10yr history. Professional ($49.99/mo, $43.99/mo annual) adds sub-15-min real-time + commodities; Business ($149.99/mo, $127.99/mo annual) adds financial statements/ratios + 15yr+ history |
| **Tradier** (connected broker account, Settings -> Accounts — NOT a separate API key as of 2026-07-16) | 2nd keyed daily-OHLC history source — code comment at `history.ts` calls it "brokerage-grade, generous rate limits. Best primary source"; credential now resolved from the connected Tradier broker account via `resolveTradierHistoryCredential`/`getActiveConnectedAccountByBroker`, not a stored key | No separate market-data pricing exists — data access is bundled with ANY brokerage account signup, including the **$0/mo Lite** trading plan | n/a — nothing to buy for data alone | n/a | Real-time equities/options/indices/hourly-Greeks — but ONLY on a **production** token from a real (even $0/mo) brokerage account. A **sandbox** token gets 15-min-delayed equities/options, no indices, no Greeks at all |
| **Logo.dev** (`LOGO_DEV_TOKEN`, `LOGO_DEV_SECRET_KEY`) | Ticker/company logo images — `src/lib/ticker-logos.ts:37-70`, `app/api/logos/ticker/route.ts` | **500,000 req/mo free** (Community), commercial use requires a visible link-back; free-tier cap is a **hard stop** — requests fail once exceeded | **Startup $280/yr** (~$23.33/mo effective; no separate monthly price was found on the live page — may be a JS-toggle we didn't render) | Annual-only pricing as fetched | 1,000,000 req/mo, no attribution requirement. Pro ($1,260/yr) adds the Brand API + self-hosting/caching + priority support; unlike free, paid tiers are **soft-enforced** (service keeps running over cap; Logo.dev reaches out about upgrading rather than cutting access) |
| **Fintech Studios / PowerIntell** (`FINTECH_STUDIOS_API_KEY`, alias `powerintell`) | Enrichment cascade provider — `src/lib/data-providers.ts:768,2810-2828`, `costTier: "paid"`, base `studio.fintechstudios.com/api/v1` | Free plan exists ($0/mo) on the marketing site | **Ambiguous — see trap #10 below.** Self-serve Pro tiers ($20/mo–$120/mo, 2.5K–15K credits, ~20% off annual) are published, but for the consumer **PowerIntell** app, not confirmed as the same product as the `studio.fintechstudios.com/api/v1` endpoint this app actually calls | Pro tier has an annual ~20% discount | Unclear for our integration — the endpoint we call looks institutional; Enterprise (the tier that would plausibly cover bulk API/data-feed access) is contact-sales-only, no published price |
| **FRED** (`FRED_API_KEY`) | Macro/econ series (rates, CPI, unemployment) driving the Macro tab + market-regime signal — `src/lib/macro.ts`, `src/lib/macro-history.ts` | **Completely free** — sign up at fred.stlouisfed.org for a key, no plan tiers exist at all | n/a — no paid tier exists | n/a | n/a. Fed's own docs state a 429 rate-limit exists but do **not** publish the exact number (see traps #11-12) — the commonly-cited "120 req/min" is third-party, not FRED's own documentation |
| **FilingAPI.dev** (`FILINGAPI`, aliases `FILINGAPI_KEY`/`FILING_API_KEY`) | Optional enrichment cascade, wave-C/scarce — company sector/industry, earnings-calendar `daysToEarnings`, insider-sentiment summary. Missing / invalid / 401 keys skip the lane (ROIC + SEC EDGAR cover the class) and do not fail health. Do not buy Plus from this app. — `src/lib/data-providers.ts` (`FilingApiEnrichmentProvider`) | This app's own code comment states **~50 req/day**; not independently vendor-verified against filingapi.dev's own pricing page this pass. **Now actually enforced at 45/day** via `RATE_QUOTAS` in `provider-rate-limit.ts` (added 2026-08-02; see trap #12) | Not vendor-verified. Do not charge Stripe / do not do Plus checkout from this repo. | Not vendor-verified | Not vendor-verified — no filingapi.dev pricing page fetch on record in this doc |
| **ROIC.ai** (`ROIC_API_KEY`) | Enrichment cascade — company profile (sector/industry/dividend yield/short-%-of-float/price) plus best-effort financial ratios (peRatio/pbRatio/eps/ROE/debtToEquity — the ratios endpoint has historically 404'd on free keys, profile alone still fills the rest) — `src/lib/data-providers.ts:3531-3608` (`RoicAiEnrichmentProvider`) | **No published free-tier request cap found.** This app now applies a conservative **200/day placeholder** via `RATE_QUOTAS` (added 2026-08-02; see trap #12) — tighten with `PROVIDER_QUOTA_ROIC_PER_DAY` once the real vendor limit is confirmed | Not vendor-verified | Not vendor-verified | Not vendor-verified — no roic.ai pricing page fetch on record in this doc |

Sources: marketstack.com/pricing + marketstack.com/faq (fetched 2026-07-10, raw
HTML), tradier.com/individuals/pricing + docs.tradier.com/docs/market-data +
docs.tradier.com/docs/rate-limiting (fetched 2026-07-10 — rate-limiting page
gives exact per-minute numbers: standard/market-data endpoints 120/min
production vs 60/min sandbox, trading endpoints 60/min both), logo.dev/pricing + logo.dev/docs/platform/rate-limits
(fetched 2026-07-10), fintechstudios.com/pricing (fetched 2026-07-10),
fred.stlouisfed.org/docs/api/api_key.html + /fred/errors.html +
/terms_of_use.html (fetched 2026-07-10 via curl --http1.1 — WebFetch 403'd this
host outright regardless of protocol; note this if a future agent's fetch tool
also fails here, it's the host, not the tool).

### Traps for the newly-added secondary providers

7. **Marketstack's free tier is NOT HTTP-only — that belief is out of date.**
   marketstack.com/faq states plainly: *"All data transmitted to and from the API
   is secured with 256-bit HTTPS encryption, which is available on both free and
   paid plans."* This app's own `fetchMarketstack` already calls
   `https://api.marketstack.com/v1/eod` (`history.ts:236`). If this repo or an
   older note ever claimed marketstack free-tier is HTTP-only, that's stale —
   don't re-assert it without re-checking.
8. **Tradier's sandbox token silently degrades data quality, not just rate
   limits.** Sandbox = 15-min-delayed equities/options, **zero** index data,
   **zero** Greeks. Only a production token — which requires an actual
   brokerage account (even the $0/mo Lite plan qualifies) — gets real-time data.
   As of 2026-07-16 the credential comes from the connected Tradier BROKER
   account's own `environment` (Settings -> Accounts), not a separate stored
   key — if that connected account is `paper` (sandbox), every Tradier-sourced
   history bar in the cascade is 15-min-delayed, not live.
9. **Fintech Studios pricing is genuinely ambiguous for our integration** — the
    published self-serve numbers ($20–$120/mo) are for the consumer PowerIntell
    app; this app's `FintechStudiosEnrichmentProvider` hits
    `studio.fintechstudios.com/api/v1`, which reads as a separate,
    institutional-looking surface with no published price (Enterprise/contact-sales
    territory). Don't assume the Pro consumer tier buys access to the endpoint
    this app actually calls without confirming with the vendor directly.
10. **FRED's own docs never publish a numeric rate limit** — only that exceeding
    it returns `429 Too Many Requests` and that FRED wants distinct API keys per
    application ("Developers should request a distinct API key for each
    application they build"). The "~120 req/min" figure that circulates
    (including in third-party summaries) is not sourced to FRED's own docs;
    treat it as a working assumption, not a documented ceiling.
11. **`fred.stlouisfed.org` blocks naive fetchers.** Every FRED docs URL
    returned HTTP 403 to a standard WebFetch and to plain `curl` — it only
    succeeded once forced to `--http1.1`. If FRED facts ever need re-verifying,
    expect this friction again; it's the host, not a broken link.
12. **FilingAPI.dev and ROIC.ai were both wired to call `admitProviderRequests`
    with NO matching `RATE_QUOTAS` entry — real code, fake enforcement.** Both
    providers' `enrich()` methods have called `admitProviderRequests("filingapi"
    | "roic", credKey, misses.length)` since they were added, with a doc comment
    at the FilingAPI call site claiming "~50/day free tier — admit at most one
    symbol-bundle per reservation unit." But `RATE_QUOTAS` in
    `provider-rate-limit.ts` had no entry for either name, so
    `resolveProviderQuota` returned `undefined` (unlimited) and `admit()` always
    granted the full request — the comment described a budget that did not
    exist. Fixed 2026-08-02 (filingapi 45/day, roic 200/day placeholder pending a
    confirmed vendor cap). **Lesson: a call to `admitProviderRequests`/
    `withProviderLimit` is not itself proof a provider is throttled — check
    `RATE_QUOTAS`/`HARD_DEFAULTS` has a matching entry, don't trust the call
    site's comment alone.**
13. **`TIINGO_API_KEY` (and `TWELVEDATA_API_KEY`) are NOT a live env fallback —
    they are `per-user-only` credential tier** (`db-api-keys.ts` `API_KEY_TIER`;
    tiingo/twelvedata are absent from the `shared-operator-infra` list that
    Massive/FMP/Finnhub/Marketstack/AlphaVantage/ROIC/FilingAPI/FRED all sit in).
    Setting the env var only reaches `resolveApiKeyWithSource` via the ONE-TIME
    `migrateLocalEnvCredentials` startup migration into the **"local" user's**
    Connections-stored key row — the exact same trap `AGENTS.md`'s "Don't"
    section already documents for `OPENROUTER_API_KEY`. Rotating/adding the env
    value after that migration already ran (or on a redeploy where the DB row
    already exists) changes nothing; the reliable path is pasting the key
    directly on the Connections page. **This was verified 2026-08-02 while
    investigating why a configured `TIINGO_API_KEY` might not be reaching the
    cascade** — confirmed live against `db-api-keys.ts`'s `API_KEY_TIER` map and
    an existing test (`api-keys-env-purge.test.ts`) that deliberately asserts
    per-tenant isolation for tiingo/twelvedata ("tenants without stored keys fail
    closed"), so this reads as an intentional per-user/BYOK design for these two
    vendors, not an oversight to "fix" by moving them to shared-operator-infra —
    do not reclassify without an explicit owner decision.

## RapidAPI-hosted lanes (shared marketplace account, combined daily budget)

Nine enrichment providers ride ONE shared RapidAPI marketplace credential
(`RAPIDAPI_KEY`) rather than their own vendor key — `alpha-vantage-rapidapi`,
`fmp-rapidapi`, `insiders-rapidapi`, `mboum-finance`, `real-time-finance-data`,
`seeking-alpha-rapidapi`, `twelvedata-rapidapi`, `yahoo-finance15`, and
`yh-finance-apidojo`. Because it's one shared account, the binding quota
mechanism for these lanes is a SEPARATE module from `provider-rate-limit.ts`'s
`RATE_QUOTAS` — `src/lib/rapidapi-quota.ts` — which enforces TWO ceilings per
reservation, whichever is lower: each lane's own persisted daily cap, AND one
COMBINED daily cap shared across all nine (owner's explicit instruction: "stay
under the 1000 calls safely like 900 max just to avoid runaway overage though
it is cheap"). `provider-rate-limit.ts`'s `HARD_DEFAULTS` additionally paces
most of these lanes in time (burst safety, independent of the daily budget) —
the same pacing-vs-quota split used everywhere else in this doc.

| Lane | Host | Own daily cap (code default) | Cap env override | `HARD_DEFAULTS` pacing |
|---|---|---|---|---|
| **mboum-finance** | mboum-finance.p.rapidapi.com | 16/day (~500/mo ÷ 30) | `PROVIDER_QUOTA_MBOUM_PER_DAY` | 1100ms interval, concurrency 1 |
| **yahoo-finance15** | yahoo-finance15.p.rapidapi.com | 3/day (Basic ~100/mo ÷ 30 — deliberately this small) | `PROVIDER_QUOTA_YAHOO_FINANCE15_PER_DAY` | 1100ms interval, concurrency 1 |
| **alpha-vantage-rapidapi** | alpha-vantage.p.rapidapi.com | 500/day (real, published) | `PROVIDER_QUOTA_ALPHA_VANTAGE_RAPIDAPI_PER_DAY` | 5/min, concurrency 1 — a separate credential/quota shape from the native Alpha Vantage 25/day-per-IP pool above; the two never share one budget |
| **twelvedata-rapidapi** | twelve-data1.p.rapidapi.com | 100/day | `PROVIDER_QUOTA_TWELVEDATA_RAPIDAPI_PER_DAY` | none |
| **fmp-rapidapi** | financial-modeling-prep.p.rapidapi.com | 50,000/day | `PROVIDER_QUOTA_FMP_RAPIDAPI_PER_DAY` | none |
| **insiders-rapidapi** | insiders.p.rapidapi.com | 100/day | `PROVIDER_QUOTA_INSIDERS_RAPIDAPI_PER_DAY` | none |
| **real-time-finance-data** | real-time-finance-data.p.rapidapi.com | 50/day (Basic tier, kept small until confirmed) | `PROVIDER_QUOTA_REAL_TIME_FINANCE_DATA_PER_DAY` | 500ms interval, concurrency 1 |
| **yh-finance-apidojo** ⚠ | yh-finance.p.rapidapi.com | 16/day (Basic tier, kept small until confirmed) | `PROVIDER_QUOTA_YH_FINANCE_APIDOJO_PER_DAY` | 1100ms interval, concurrency 1 |
| **seeking-alpha-rapidapi** ⚠ | seeking-alpha.p.rapidapi.com | 20/day (Basic tier, kept small until confirmed) | `PROVIDER_QUOTA_SEEKING_ALPHA_RAPIDAPI_PER_DAY` | 1100ms interval, concurrency 1 |

Combined ceiling across all nine: **900/day** by default
(`PROVIDER_QUOTA_RAPIDAPI_COMBINED_PER_DAY`). Both counters persist via
`getInternalSetting`/`setInternalSetting` (`rapidapi_combined_call_budget`
row) so a mid-day Coolify redeploy can't forget the day's usage and quietly
re-grant an already-burned budget. Numbers per `src/lib/rapidapi-quota.ts`'s
`DEFAULT_PER_PROVIDER_DAILY_CAP`/`DEFAULT_COMBINED_DAILY_CAP` — none of the
nine RapidAPI hub prices/tiers were independently re-verified against the live
RapidAPI marketplace pages for this doc pass; treat the caps above as this
app's own conservative code defaults, not vendor-confirmed limits.

**⚠ Candidates for removal (delisted marketplace hubs):** `yh-finance-apidojo`
and `seeking-alpha-rapidapi` both carry an in-code comment ("Hub listing
currently API-not-found (delisted); host still answers 403 if unsubscribed" —
`data-providers.ts` right above each provider class), matching this effort's
recon that both lanes' connections-health check currently reports `ok:false`
(not independently re-checked for this doc pass — see the code comment for the
part confirmed by reading source). A 403-not-404 means the
host itself still answers, so an already-subscribed key might still work, but
the marketplace listing being gone means a NEW subscription can't be created
if the current one ever lapses. Per this lane's scope, flagging only — the
provider classes and their `rapidapi-quota.ts`/`HARD_DEFAULTS` entries are
left in place; removing the dead code is a separate decision for the owner.

## Keyless & broker-bundled sources

No API key at all, or riding an existing broker credential rather than a
separate paid data subscription. Verified 2026-07-10 against this repo.

| Source | Role in this app | Cost reality |
|---|---|---|
| **Yahoo Finance** (`yahoo-finance`) | Final keyless tier in the enrichment cascade (`data-providers.ts:1732,791`) + free fallback in the history cascade (`history.ts` `fetchYahoo`) | Free, unofficial, no SLA. Paced (`minIntervalMs: 400, concurrency: 2` in `provider-rate-limit.ts:42`) because the prod egress IP gets HTTP 429 on unpaced bursts |
| **NASDAQ Delayed Screener** (`nasdaq-delayed-screener`) | PRIMARY market-scan universe source (~8,000 rows) — `src/lib/market.ts:88-90`, hits `api.nasdaq.com/api/screener/stocks` | Free, public, unauthenticated — "no user API key is consumed, so this single shared cache is safe to serve to all users" (code comment). No rate-limit knob wired in `provider-rate-limit.ts` |
| **Webull unofficial** (`webull-unofficial`) | Opt-in quote bridge shelling out to `scripts/webull_unofficial_quote.py` (community `tedchou12/webull` package, no login) — `data-providers.ts:1140-1146` | Free but unofficial/ToS-gray-area. Default **OFF** (`WEBULL_UNOFFICIAL_ENABLED`); capped at 20 symbols / 8s timeout by default (`WEBULL_UNOFFICIAL_MAX_SYMBOLS`, `WEBULL_UNOFFICIAL_TIMEOUT_MS`) |
| **SEC XBRL** (`sec-xbrl`) | Fills `debtToEquity` (+ `revenueGrowth`, added 2026-08-02: fiscal-YoY from annual-duration 10-K `Revenues`/`RevenueFromContractWithCustomerExcludingAssessedTax` facts, restricted to true ~365-day spans so a same-concept quarterly/YTD duration is never mistaken for the full year) from audited 10-K/10-Q filings via the public companyfacts API this provider already fetches per symbol — `data-providers.ts` `parseCompanyFacts` | Free, keyless, public `data.sec.gov`. Default **OFF** (`SEC_XBRL_ENRICHMENT_ENABLED`); 300ms polite inter-symbol delay + 8s wall-clock scan budget, per SEC fair-access guidance |
| **SEC EDGAR** (`sec-edgar`) | Insider-sentiment sourcing (`market.ts:348-349`) + RAG filings corpus ingestion (`vector-db.ts:1381`) | Free, keyless besides a required `SEC_EDGAR_USER_AGENT` string — a UA SEC requires, not a secret (`db-api-keys.ts` comment: "one per app") |
| **Alpaca news + snapshot** (`alpaca-news`, `alpaca-snapshot`) | Headlines/sentiment (`data-providers.ts:1444-1503`) + real-time price/bid/ask/volume/vwap (`:1592+`) | Rides the SAME broker API key/secret already used for order execution — not a separate subscription (`resolveAlpacaMarketData`: own key → operator's paper key for background/shared passes). Defaults to the free **IEX** feed; **SIP** (full consolidated tape) needs the paid Algo Trader Plus subscription below — configurable via `ALPACA_DATA_FEED=iex\|sip\|otc`, and SIP without the subscription returns HTTP 403 |
| **Robinhood quotes + fundamentals** (`robinhood-quotes`, `robinhood-fundamentals`) | Position quote fallback (`robinhood.ts:239,350`, `provider: "robinhood"`) + delayed fundamentals — pe_ratio, 52wk hi/lo, avg volume, sector/industry (`data-providers.ts:1379-1420`) | Rides the user's own Robinhood MCP/OAuth broker connection — not a separate data subscription. Per-user; fails closed with no user in scope (never borrows the operator's `'local'` token for a shared/background pass) |
| ~~Stooq~~ (`stooq`) | **REMOVED from the history cascade 2026-08-02** — `parseStooqCsv` stays exported (pure/tested) but nothing calls `fetchDailyOHLC`'s old Stooq tier anymore | Its daily-CSV endpoint now sits behind an Anubis-style JS proof-of-work bot wall (live-confirmed 2026-08-01/02) — not merely rate-limited. Circumventing it would mean defeating bot protection, so the tier was removed rather than kept as permanently-dead code |
| **US Treasury par-yield curve** (`treasury-yield`, `src/lib/market-signals/treasury.ts`) | Keyless fallback for `dgs3moTreasury`/`dgs2Treasury`/`dgs10Treasury` (+ the `curve3m10y`/`curve2s10s` metrics computed from them) when no FRED key is configured — `macro.ts`'s `fetchVixOnlyFallback`, added 2026-08-02 | Free, keyless, public domain (home.treasury.gov's legacy Atom/XML feed — NOT on the fiscaldata.treasury.gov REST API, which 404s for this dataset). Requires a browser-like User-Agent (a bare `curl`-default UA times out) |
| **Cboe VIX9D** (`market-signals/cboe.ts`) | Added alongside the existing SKEW/VVIX keyless quotes 2026-08-02 — completes the near-term vol term structure (VIX9D vs VIX vs VIX3M) | Free, keyless, same `cdn.cboe.com` delayed-quote CDN as SKEW/VVIX |

**congress.trade (App A)** — not a vendor. `CONGRESS_TRADE_TOKEN` +
`CONGRESS_SHARE_ENABLED` (outbound) / `CONGRESS_TRADE_READS_ENABLED` (inbound)
gate a bidirectional data-sharing arrangement with the owner's OWN sibling app
(`src/lib/congress-share.ts`, header comment at lines 1-16). Both apps consume
FMP under a shared quota, so this app forwards company-reference + daily-close +
S&P-500 data it already has to App A's import endpoint, and (separately,
inbound) can read App A's FMP-sourced closes to save its own history-cascade
calls. Internal, not commercial — no pricing entry, just an access-flag note.

## Usage-billed (not subscription) providers

A separate class from everything above: providers billed per-token/per-call
rather than a flat monthly plan, so a static price table doesn't apply. This
covers the LLM providers behind the agentic loop and model picker (OpenAI,
Anthropic, DeepSeek, Gemini, Mistral, xAI — `API_KEY_ENV_MAP` in
`src/lib/db-api-keys.ts`) and the RAG stack (Pinecone, Voyage — same file,
`shared-operator-infra` tier). Live spend, per-model rates, and usage tracking
for all of these already live in the **API-Usage-Monitor** app (see
`docs/slack-coordination.md`'s topic-tag table) — that app, not this doc, is the
source of truth for what we're actually spending on LLM/RAG usage. Don't
duplicate per-token pricing tables here; if a rate looks stale in
API-Usage-Monitor, fix it there.

## Cheap alternatives — evaluated, not integrated

Owner-directed survey (2026-07-10) of budget market-data providers NOT wired
into this app, to check whether any beats what we already pay for: Tiingo Power
($30/mo or $300/yr, quotes+news), FMP (~$22/mo-annual, fundamentals), Massive
Stocks Starter ($29/mo, history+breadth). None of these are integrated — this
is research, not a roadmap item. Verified 2026-07-10 against live vendor pricing
pages; cited per-row.

| Provider | Cheapest useful tier | Annual option | Covers | Verdict vs. our incumbent |
|---|---|---|---|---|
| **alphastocks.app** (owner-named) | $3.33/mo ($40/yr) | yes | A consumer stock-**scoring/screener** web app (Buffett/Graham/Piotroski/Lynch/Greenblatt composite scores over ~1,500 US equities, sourced from SEC EDGAR + Alpaca) — no developer API surface at all | **Not a candidate.** Nothing to integrate against; several features still marked "coming soon"; reads as a thin, new retail product, not infrastructure |
| **EODHD** (eodhd.com) | $19.99/mo (EOD, All World); $59.99/mo (Fundamentals) | $199/yr; $599.90/yr | EOD history (30+ yrs), fundamentals, corporate calendar, ALL-IN-ONE bundle at $99.99/mo ($999.90/yr) | Fundamentals tier costs MORE than FMP for comparable coverage; EOD tier is close to Massive on price but EOD-only (no intraday/breadth at that tier) |
| **marketdata.app** | $12/mo (billed annually; $30/mo month-to-month) | yes — annual IS the cheap price | Stock + options quotes, 5yr history | Cheaper than Massive nominally, but real-time is explicitly licensed "non-professional subscribers only" — a real commercial-use risk for an app placing live orders, not just a pricing footnote |
| **Finazon** (finazon.io) | $19/mo (`sip_non_pro` US equities dataset) | not published | US equities — but only 3-5% of intraday volume (3 minor venues), 100% coverage only after-close via EOD synthesis | Same non-pro/pro licensing gate as marketdata.app, PLUS thin intraday coverage. Pro-tier licensing runs $2,000-2,500/mo + exchange fees if commercial use requires it |
| **Finage** (finage.co.uk) | $599/mo (Delayed Global Stocks) — confirmed live on the pricing page | unclear | Real-time/historical global stocks, unlimited API calls | Confirmed price floor is not competitive. Third-party summaries reference a much cheaper ~$8.99/mo tier, but it did **not** render on the live pricing page fetched (possibly a JS-gated toggle) — flagging as unconfirmed rather than asserting it exists |
| **StockData.org** | $24-29/mo (Basic, ~17% off annual) | yes | Quotes, intraday, news (2,500 req/day, 10 symbols/request, 1yr history at Basic) | Price-comparable to Tiingo Power, but much thinner limits — a real capability downgrade, not a clean swap |
| **Databento** (databento.com) | $179/mo flat (Standard, live data) + $/GB usage-priced historical | annual contracts only at the $1,500-4,000/mo Plus/Unlimited tiers | Institutional tick-level data (Level 2/3, packet captures, redistribution rights) | Wrong shape and wrong price point entirely — built for firms consuming raw tick data at scale, not a watchlist/screener app |
| **financialdatasets.ai** | $200/mo (Build, 100K req/mo) or $20 one-time pay-as-you-go (1,000 light requests) | none found | Financial statements/fundamentals, explicitly LLM/AI-agent-oriented | ~9x FMP's price for comparable fundamentals coverage. The pay-as-you-go credits could suit occasional bursts, but not as a standing subscription |
| **Alpaca Algo Trader Plus** | **$99/mo** | not found | Full SIP (consolidated-tape) real-time equities + real-time OPRA options, unlimited API rate + WebSocket symbols, vs. the free IEX-only/200-calls-min/15-min-delayed Basic plan | **Not a Tiingo/FMP/Massive replacement — a different layer.** This is an add-on to Alpaca infra we already hold for order execution, not a new vendor relationship. The one item here that's a genuinely well-scoped next spend if execution-grade real-time pricing becomes a real gap |
| **IEX Cloud** | — | — | — | **Defunct.** Shut down permanently (announced retirement May 2024, fully discontinued August 31, 2024). Don't re-suggest it |

Sources: alphastocks.app + alphastocks.app/pricing, eodhd.com/pricing,
marketdata.app/pricing, finazon.io/pricing + finazon.io/dataset/sip_non_pro,
finage.co.uk/pricing (live-fetched; cheaper-tier figures from third-party AI
search summaries only, unconfirmed on the live page), stockdata.org/pricing,
databento.com/pricing + databento.com/docs/faqs/usage-pricing-and-data-credits,
financialdatasets.ai/pricing, alpaca.markets/data +
docs.alpaca.markets/us/docs/market-data-faq, IEX Cloud shutdown per Databento's
and Alpha Vantage's public migration-guide posts (all fetched 2026-07-10).

**Switch calculus:** price alone doesn't clear the bar. Every new provider needs
a real `SymbolEnrichment` wiring pass — the interface, the
`EnrichmentSourcedField` union, `takeScalar(...)` calls in
`CascadingEnrichmentProvider.enrich`, the `EMPTY_SOURCED` marker map, the
matching `MarketQuote`/`MarketQuoteSummary` fields in `types.ts`, and the merge
in `src/lib/market.ts` (the per-field enrichment checklist in this repo's
`AGENTS.md`) — plus a cred-tier entry, cascade-position decision, and (per the
gap above) probably a new rate-limit knob. That's real engineering time and a
new long-term maintenance surface, not a config change. None of the alternatives
surveyed above clear that bar today: several carry the same non-professional
real-time licensing gate current incumbents don't have to worry about, one
(EODHD fundamentals) is outright more expensive than FMP, and the only
unambiguous win (Alpaca Algo Trader Plus) isn't a swap at all — it's additive
spend on infrastructure already integrated. A future alternative needs to beat
an incumbent by a real margin — meaningfully cheaper AND at-least-as-capable, or
capable of something the cascade can't currently do at any price — not $5/mo.

## 2026-08-02 Round 2/3 — new free sources + existing-provider hardening

Continuation of the 2026-08-02 hardening pass above, implementing the free-tier research doc's
remaining §1/§2 recommendations. Owner-directed; licensing caveats waived (sole-user, BYOK — "each
user puts their own keys"). Verified live against each vendor on 2026-08-02 before writing code.

**New enrichment providers (all standalone files, `resolve<Name>ApiKey()` reads only their own env
var — no `db-api-keys.ts`/credential-tier involvement, mirroring `quiver-provider.ts`'s posture):**

| Provider | Free tier (live-verified 2026-08-02) | Fields filled | Cascade position |
|---|---|---|---|
| **Wisesheets** (`WISESHEETS_API_KEY`) | 5,000 req/mo, 200/min, 5y history, ~10,412 US stocks. Launched 2026-07-24 — no track record yet. Bearer-header auth against `api.wisesheets.io/v1/` | price, peRatio, eps, companyName, volume, fiftyTwoWeekHigh/Low, intradayChangePct, asOf, dividendYield, grossProfitMargin, revenueGrowth | `quotaScarce=true`, registered behind every established source given zero track record |
| **SimFin** (`SIMFIN_API_KEY`) | **Corrects the original research doc**: "500 credits/mo" is a separate in-app backtesting feature, NOT the REST API's real cap — the API itself is **2 req/sec, no monthly ceiling** (confirmed at simfin.readme.io/reference/rate-limits.md; docs moved off simfin.com/api/v3/documentation/, which now 404s). `Authorization: api-key <KEY>` against `backend.simfin.com/api/v3` | companyName, sector, industry, grossProfitMargin, returnOnEquity, returnOnAssets, revenueGrowth, debtToEquity (deliberately omits eps/peRatio/dividendYield/beta — those need live share-price data this provider doesn't fetch) | Not `quotaScarce`; first-wins by registration order, seated near Wisesheets |
| **Marketaux** (`MARKETAUX_API_KEY`) | 100 req/day, capped at 3 articles/request regardless of requested limit. **ToS re-verified clean** — the original research pass 403'd on the wrong URL (marketaux.com/terms-of-service) and flagged it unverifiable; the real ToS lives at marketaux.com/tos and has no API-specific commercial restriction | headlines, sentiment (genuine per-article model score, not a keyword proxy) | `quotaScarce=true`; registered right after Alpha Vantage's model-based NEWS_SENTIMENT, ahead of the keyword-proxy tiers |
| **Nasdaq calendar** (keyless) | No cap observed; cost scales with distinct calendar DATES scanned (not symbols), cached module-wide. `api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD` | daysToEarnings (backfill only) | Registered unconditionally (self-gates via `NASDAQ_CALENDAR_ENRICHMENT_ENABLED`, default ON), positioned after Yahoo as a free-wave backfill |
| **BLS API v2** (`BLS_API_KEY`, optional) | **Works keyless**: 25 req/day, 25 series/query, 10y/query. Registering (free) raises it to 500/day, 50 series/query, 20y/query. Verified live against `api.bls.gov` (the `www.bls.gov` host 403s bots, but the actual data API does not) | Macro only (cpiInflation, unemploymentRate, nonfarmPayrollsChangeK) via `macro.ts`'s keyless fallback — not a `MarketEnrichmentProvider` | Same tier as Treasury.gov (see the 2026-08-02 section above): keyless macro floor, only evaluated when no FRED key/fetch succeeded |
| **S&P 500 constituents mirror** (keyless) | github.com/datasets/s-and-p-500-companies, still PDDL/ODC-PDDL-1.0-licensed, real edits every 1-3 weeks | N/A — reference list (`{symbol,name,sector}`), not per-symbol enrichment | **No consumer wired yet.** This app's scan universe still uses the static hand-generated list in `src/lib/sp500.ts` ("Generated from Wikipedia on 2026-06-14"); this module is infrastructure for a future refresh, not a live replacement — converting `index-universes.ts` from a compile-time static array to a runtime-fetched one is a bigger, separate architectural decision |

**USAspending.gov — investigated, NOT implemented (mirrors FINRA short-interest's disposition in
Round 1).** The award-search API itself is free, keyless, real, and well-maintained (confirmed live:
`POST api.usaspending.gov/api/v2/search/spending_by_award/` for contract totals, `GET
.../api/v2/recipient/{id}/` for UEI/DUNS). The blocker is the OTHER side of the bridge: there is no
free, reliable recipient-name/UEI/DUNS → ticker/CIK crosswalk anywhere. SEC's own `company_tickers.json`
(this app's only free ticker↔CIK source) carries no DUNS/UEI field at all, so the only path left is
fuzzy company-name matching — live-verified to be genuinely unreliable even for famous defense primes
(e.g. Lockheed Martin's own USAspending recipient record lists "GENERAL DYNAMICS CORPORATION" as an
alternate name; a "Boeing" search returns 15 distinctly-named entities). A narrow, hand-curated
allowlist of ~50-150 well-known tickers would work with zero fuzzy matching, but was deliberately not
built this round — it's a product-scope call (is a defense-primes-only field worth shipping and
maintaining?) for the owner, not something to ship unilaterally. Also noted in passing:
`govContractsQuiver` (the only existing gov-contracts field) has zero UI references anywhere in
`app/` today — grepped for "govContractsQuiver"/"Gov Contracts"/"Quiver" and found nothing — so
"repurposing" that Quiver-named field for a different source is a live option, not a hard blocker, if
this is ever revisited.

**Existing-provider hardening (edits in place, no new files):**
- **Yahoo Finance**: live-verified the crumb+cookie requirement is real but NARROWER than assumed —
  `v8/finance/chart` (the endpoint `history.ts`/`macro.ts` actually use) works with a browser UA alone,
  no crumb needed; only `v7/finance/quote`/`v10/finance/quoteSummary` (used by
  `YahooFinanceEnrichmentProvider` in `data-providers.ts`) require it, and that provider already
  implemented the handshake correctly before this pass touched anything. What WAS missing: dedicated
  HTTP 429 exponential backoff on the two `v8/finance/chart` call sites (`history.ts`'s `fetchYahoo`,
  `macro.ts`'s `fetchVixLane` — the latter also covers the Cboe VIX lane incidentally, since both
  lanes share one helper). Added, 4 new tests, zero behavior change on any non-429 failure mode.
- **Alpha Vantage**: added a free `EARNINGS_CALENDAR` fallback for `daysToEarnings`, reusing the SAME
  scarce 23-25/day budget as `NEWS_SENTIMENT` (no new quota). Live-verified the endpoint returns CSV
  (not JSON, even on error) and that calling it with NO `symbol` param returns the WHOLE market's
  upcoming earnings in one call — so this costs at most ~1 reservation per ~24h, not one per symbol.
  Gated by the cascade's existing `EnrichmentContext.coveredFields` hint so it skips symbols a
  cheaper free source (e.g. the new Nasdaq calendar provider) already covered.
- **Finnhub**: added the equivalent free `/calendar/earnings` fallback (Finnhub's free tier is a
  generous 60/min, not scarce like AV's). Same market-wide-single-call design. Finnhub's registration
  order is unchanged — it already precedes Yahoo/AV in the cascade, so first-wins naturally prefers it
  when it has data. **Correction to the original research doc**: its claim that Finnhub's
  insider-transactions endpoint "has more headroom than drawn" was checked against the current
  `FinnhubEnrichmentProvider` and found factually wrong — that class has ZERO insider-transactions
  logic today (insiderSentiment comes from FMP/InsidersRapidApi/FilingApi only), so there is no
  existing "draw" to add headroom to; a Finnhub insider source would be a new feature, not a bounded
  tweak, and was correctly left out of this pass's scope.

**Known gap this round did NOT close:** neither Wisesheets nor SimFin exposes `debtToEquity`/
`returnOnEquity` confirmation without a live API key to probe their metrics catalogs (SimFin's docs
only literally demonstrate `revenue`/`net_income`/`gross_margin` as example metric keys; Wisesheets'
`/v1/metrics/` catalog endpoint itself requires a real key to call). Both providers ship with the
subset of fields their PUBLIC docs pages demonstrate; extending coverage needs a real key in hand,
which per fleet policy no agent may provision — an owner action, not a code gap.
