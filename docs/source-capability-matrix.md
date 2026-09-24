# Source × data-point capability matrix (Socratic-Trade)

**Canonical lookup for agents and humans.** When you need one fundamental, quote field,
calendar fact, narrative artifact (e.g. earnings-call transcript), or macro series —
look it up here first. Every row lists **all** sources that can supply that data point,
with strategic notes (delay, quality, quota conservation).

| | |
|---|---|
| **Code registry** | `src/lib/source-capability-matrix.ts` — `sourcesFor(dataPoint)`, `DATA_POINTS`, `listDataPoints()` |
| **Companion pricing** | `docs/market-data-provider-pricing.md` |
| **Free-tier research** | `docs/market-data-free-tier-research-2026-08-02.md` |
| **FMP archaeology** | `docs/fmp-capabilities.md` (FMP is **retired** for ST product use) |
| **Congress consume** | `docs/congress-trade-consume.md` |
| **Last deep pass** | 2026-08-05 (GROK data-sources overhaul) |

Update this file **and** the TypeScript registry together whenever a provider gains/loses
a field or a quota reality changes.

---

## 0. Policy (binding)

| Vendor / path | Socratic-Trade (ST) | Congress.Trade (CT) |
|---|---|---|
| **FMP** (direct, RapidAPI FMP, FMP transcripts) | **Forbidden** for product enrichment. Do not call. Admin health should show **OFF** (grey), not STOPPED red. | Latency race / probe + CT-owned enrichment where CT already uses FMP |
| **QuiverQuant** | **Remove / disconnect** — no registration, no keys, no settings | CT may keep for its own products if licensed |
| **Unusual Whales** | Banned (never a prod ST producer) | CT latency only if wired |
| **Congress.Trade App A** | Disclosures + analytics default ON; fundamentals from App A default OFF (local multi-source cascade) | System of record for congressional disclosures |

Choke points in ST: `src/lib/retired-direct-vendors.ts`, cascade registration in
`src/lib/data-providers.ts`.

---

## 1. How to choose a source (strategic ranking, not “best number one”)

Preference is **quota-aware and role-aware**, not a single global ranking.

1. **Keyless / unlimited-enough floor first** for fields they cover well  
   (Yahoo, SEC EDGAR/XBRL, Nasdaq delayed quote/screener host, Cboe CDN for VIX, FINRA files).
2. **Broker-bundled** when the user already has a connected account  
   (Alpaca snapshot/news, Robinhood fundamentals/options, Tradier history).
3. **Generous free keyed** next  
   (Finnhub free 60/min for news/profile/metrics it still unlocks; Tiingo free for IEX + EOD history).
4. **Paid but non-scarce** for unique or higher-quality fields  
   (Massive short interest + history; ROIC individual plan for deep fundamentals/transcripts).
5. **Quota-scarce / RapidAPI monthly** only as **wave-C gap fill**  
   (`quotaScarce` providers: Mboum, YH Finance 15, AV RapidAPI, Insiders RapidAPI, Twelve RapidAPI, YH ApiDojo, Real-Time Finance, Seeking Alpha RapidAPI, FilingAPI). Never burn these on symbols wave A already filled.
6. **Never spend scarce quota** on a field that a cheaper source already owns for that symbol **if** the scarce source’s remaining budget is needed for fields only *it* can supply (see per-row “preserve quota” notes).
7. **Narrative / RAG artifacts** use separate producers and rights gates — not the quote cascade.

Cascade mechanics (implementation): free-first waves + `quotaScarce` + `suppliesFields` in
`CascadingEnrichmentProvider` (`src/lib/data-providers.ts`).

---

## 2. Provider inventory (ST-relevant)

| Source id | Auth | Cost / quota reality | Role in ST | Notes |
|---|---|---|---|---|
| `yahoo-finance` | none | Unofficial; can 429 / block DC IPs | **Floor** for most scan scalars | ToS-gray; harden, don’t expand surface |
| `nasdaq-quote` | none | Delayed; same host family as screener | Free quote/name | License caution on bulk AI use (owner-accepted for screener) |
| `nasdaq-calendar` | none | Earnings/dividend/IPO calendars | Free calendar | Same host/ToS caution |
| `sec-xbrl` | none | EDGAR fair-access ~10 r/s | Authoritative fundamentals | Filing lag; commercial-clean |
| `sec-8k` / `sec-filings` | none | EDGAR | Event RAG | Web-source producers |
| `finra-short` | none / free API | SI 2×/month | Short interest origin | Better than daily refresh fantasy |
| `vix-cboe` / `vix-yahoo` | none | Cboe CDN preferred | Macro VIX | Cboe first (DC-friendly) |
| `treasury-par-yield` | none | Unlimited XML | Curve slope | Keyless macro |
| `bls` | free key optional | 25–500/day | CPI/labor | Cache-friendly vs FRED |
| `fred` | free key | ~120/min | Macro | **No durable DB cache** (ToU); memory only |
| `alpaca-snapshot` / `alpaca-news` | user/env keys | Plan-dependent | Broker quotes/news | Free options greeks indicative |
| `robinhood-fundamentals` / options | connected session | Retail ToS | Fundamentals + NTM IV | Opt-in enrichment |
| `tiingo` | key | Free: 50/hr, 1k/day; Power: news | Quotes + **EOD history** | Free news 403s — drop news on free |
| `finnhub` | key | Free 60/min; paid $3.5k/mo | News + light fundamentals | Stay free; never budget paid |
| `twelvedata` | key | Free 8 credits/min; fund. expensive | Quote/profile | Fundamentals poor value at free credits |
| `alpha-vantage` | key | **25/day per IP** (not per key) | Prefer calendars over quotes | Pool rotation does not multiply quota |
| `roic` | key | Individual plan (owner) | Deep fund. + **transcripts** | Prefer for unique depth; don’t waste on Yahoo-covered PE alone |
| `massive` | paid Starter | Unlimited API; 15m delayed quotes | History + short interest + breadth | Not primary real-time quotes |
| `marketstack` | key | Free ~100/mo | History failover | Scarce — last resort |
| `tradier` | connected broker | Sandbox vs live | History | Prefer over marketstack when connected |
| `filingapi` | optional key | Paid if present | Profile/calendar/insider | `quotaScarce`; missing/401 skips (ROIC + EDGAR cover) |
| `filingapi` | — | **Retired on `main` 2026-08-17 (#2787)** | Do not call on this HEAD | ROIC.ai + SEC EDGAR cover this class. No Plus checkout. Open #2792 (owner reversal) keeps the lane and soft-skips missing/401 keys. Audit: `docs/audits/2026-08-17-brokers-data-cascade.md`. |
| `fintechstudios` | key | Paid | News/events | Niche |
| `marketaux` | key | Free 100/day | News sentiment | Scarce |
| `wisesheets` / `simfin` | key | Free tiers | SEC-derived fund. second opinion | Behind Yahoo/SEC quality gate |
| RapidAPI pack (`mboum-finance`, `yahoo-finance15`, `alpha-vantage-rapidapi`, `insiders-rapidapi`, `twelvedata-rapidapi`, `yh-finance-apidojo`, `real-time-finance-data`, `seeking-alpha-rapidapi`) | shared RapidAPI key | Often **monthly** caps | Wave-C failover only | Shared key → one budget across hosts |
| `congress.trade` | partner token | App A | Congressional trades/analytics; optional fund. | Default: congress ON, fund. OFF |
| `earningscalls` | key / RapidAPI | Free may be **preview-only** (250 chars) | Transcript producer | Preview guard blocks poison cache |
| `roic-earnings-transcript` | ROIC key | Plan capacity | Transcript producer | **Library exists; scheduler wire was missing as of 2026-08-05** |
| `fmp` / `fmp-rapidapi` / `fmp-earnings-transcript` | — | — | **ST: retired** | CT latency only |
| `quiverquant` | — | — | **ST: remove** | Specialty counts unmapped to App A |

---

## 3. Scan / enrichment scalars (`SymbolEnrichment` / `EnrichmentSourcedField`)

For each field: **sources that can supply it**, ordered as **strategic first → last**.
Ranks are relative within the field (1 = try / accept first when healthy).

Legend for notes: **Q** = quota conservation · **D** = delay/staleness · **L** = license/ToS · **Qly** = quality.

### 3.1 Price / tape

| Data point | Sources (strategic order) | Notes |
|---|---|---|
| **price** (last) | 1. Connected broker snapshot (Alpaca / RH when enrichment on) · 2. `nasdaq-quote` (delayed) · 3. `yahoo-finance` · 4. `tiingo` IEX · 5. `twelvedata` · 6. `roic` · 7. RapidAPI quote hosts (scarce) · ~~FMP~~ | **D**: Nasdaq/Yahoo often 15m delayed. Prefer broker for trading decisions. **Q**: do not spend AV or RapidAPI monthly budget on price alone. |
| **bid / ask** | 1. Broker snapshot · 2. Yahoo (when present) · 3. Tiingo IEX | Spreads for execution UX; free delayed sources often missing. |
| **intradayChangePct** | Yahoo, Nasdaq, broker, Tiingo, RapidAPI quote hosts | Same delay notes as price. |
| **volume** | Yahoo, Nasdaq, broker, Finnhub, Tiingo, Twelve, RapidAPI | Session volume; confirm as-of with quote timestamp. |
| **vwap** | Alpaca dailyBar primarily | Do not invent from delayed OHLC. |
| **asOf** (quote timestamp) | Every live quote path should stamp | Required provenance; never fabricate. |

### 3.2 Identity & classification

| Data point | Sources | Notes |
|---|---|---|
| **companyName** | Yahoo, Nasdaq, Finnhub, Tiingo, ROIC, Twelve, FilingAPI, SEC profile paths, RapidAPI | Stable; cache hard. **Q**: once filled free, skip paid profile calls for name alone. |
| **sector / industry** | Yahoo, Finnhub, ROIC, Twelve, FilingAPI, SteadyAPI modules, RapidAPI | GICS-ish labels vary by vendor — do not treat as identical. SEC/Wisesheets more filing-true. |

### 3.3 Valuation & profitability ratios

| Data point | Sources | Notes |
|---|---|---|
| **peRatio** | Yahoo, Finnhub, ROIC, Twelve, FilingAPI, RapidAPI, ~~FMP ratios-ttm~~ | **Qly**: negative EPS → display `n/a` not fake PE. Yahoo/Finnhub fine for scan; ROIC when depth needed. **Q**: never burn scarce RapidAPI only for PE if Yahoo filled it. |
| **pbRatio** | Yahoo, ROIC, FilingAPI, YH ApiDojo | Less universally filled than PE. |
| **eps** (TTM) | Yahoo, Finnhub, ROIC, Twelve, SEC XBRL, RapidAPI | **Qly**: SEC XBRL is point-in-time filing truth; Yahoo is convenience TTM. Prefer SEC when strategy depends on restatement-safe numbers. |
| **epsGrowth** | Yahoo, ROIC, Twelve, SEC-derived | Often missing on free tiers — accept null. |
| **dividendYield** | Yahoo, Finnhub, ROIC, Tiingo meta, FilingAPI, ~~FMP~~ | Annualized %; confirm trailing vs forward when both exist. |
| **beta** | Yahoo, Twelve, SteadyAPI, RapidAPI | Model-dependent across vendors. |
| **debtToEquity** | Yahoo, ROIC, Twelve, SEC XBRL, ~~FMP~~ | **Qly**: SEC when making capital-structure decisions. |
| **returnOnEquity / returnOnAssets** | ROIC, FilingAPI, Yahoo (sometimes), ~~FMP ratios~~, Twelve | Prefer provider-reported ROE over crude NI/equity rebuild (`derived-metrics.ts`). |
| **revenueGrowth** | Yahoo, Twelve, SEC, ROIC | Filing cadence. |
| **fcfYield / freeCashFlowYield** | Yahoo (derived), ROIC, ~~FMP~~ | Naming: both fields exist historically — treat as same economic idea when merging. |
| **grossProfitMargin** | ROIC, Twelve, ~~FMP~~, SEC | Often paid-path. |
| **sharesOutstanding** | Yahoo, SEC XBRL, Finnhub | Float vs diluted confusion — document which. |

### 3.4 Range & risk

| Data point | Sources | Notes |
|---|---|---|
| **fiftyTwoWeekHigh / Low** | Yahoo, SteadyAPI, Twelve RapidAPI (scarce gate for 52w only), YH ApiDojo | **Q**: Twelve RapidAPI is intentionally scarce and gated to 52w gaps only. |
| **shortPercentOfFloat** | 1. Yahoo (primary takeScalar) · 2. Massive/FINRA secondary for disagreement · 3. ROIC sometimes | **D**: FINRA bi-monthly. Massive Starter: short interest product. Disagreement bulletin when primary vs secondary diverge. **Do not** invent daily SI. |
| **institutionOwnershipPct** | Yahoo major holders, Massive sometimes, ROIC | Stale 13F-ish; not real-time. |

### 3.5 Analyst

| Data point | Sources | Notes |
|---|---|---|
| **analystRating / analystScore / analystBySource** | Finnhub recommendations, Yahoo recommendation, FilingAPI, YH ApiDojo, ~~FMP grades-consensus~~ | **Blend multi-source** in cascade (`analystBySource`). Free Finnhub is valuable here — preserve for news+recs, not candles (premium). |
| **targetMean / High / Low / Median** | YH ApiDojo, ~~FMP price-target-consensus (retired ST)~~ | Forward targets mostly paid-only industry-wide. Expect gaps after FMP retirement. |

### 3.6 Sentiment, news, events

| Data point | Sources | Notes |
|---|---|---|
| **sentiment** (0–100 news) | Finnhub news, Alpaca news, Marketaux, AV NEWS_SENTIMENT, Real-Time Finance RapidAPI | **Q**: AV 25/day — prefer AV for calendars if choosing; Finnhub free is better for continuous news. |
| **headlines** | Same news providers | Store with first-seen + source. |
| **insiderSentiment** | Finnhub insider (free), Insiders RapidAPI (scarce), FilingAPI, SEC Form 4 (web), ~~FMP insider~~ | **Q**: Insiders RapidAPI only when still empty after free paths. |
| **daysToEarnings** | Yahoo calendarEvents, Nasdaq calendar, AV EARNINGS_CALENDAR, FilingAPI, Finnhub calendar | **Q**: Prefer Nasdaq/Yahoo free; save AV calendar horizon budget for IPO/dividends bulk. Never fabricate 0. |
| **senateTrades / congress activity** | **Congress.Trade only** (not Quiver) | ST must not call Quiver/FMP house-senate. Counts may lag; App A is SoR. |

### 3.7 Options (opt-in)

| Data point | Sources | Notes |
|---|---|---|
| **nearTheMoneyIv / putCallRatio** | Robinhood options enrichment (opt-in), Alpaca options snapshot (indicative) | **Qly**: not OPRA full; greeks may be missing. |

### 3.8 Quiver-only specialty (ST: remove)

| Data point | Former source | Replacement |
|---|---|---|
| `congressTradesQuiver`, `insiderTradesQuiver`, `govContractsQuiver`, `lobbyingQuiver`, `patentsQuiver` | QuiverQuant | Congress.Trade for congressional; USAspending (future) for contracts; else empty |

---

## 4. Non-scan data types (narratives, history, macro, web sources)

These are **not** `EnrichmentSourcedField` but still need full source maps.

### 4.1 Earnings-call transcripts (full text → RAG `doc_type: earnings-transcript`)

| Source | ST allowed? | Entitlement / quality | Cadence & wiring | Strategic notes |
|---|---|---|---|---|
| **ROIC.ai** `roic-earnings-transcript` | Yes | Owner individual plan; full text via `/v2/transcript/{symbol}/{year}/{quarter}` | `src/lib/web-sources/roic-transcripts.ts` — **fetch+ingest helpers exist; scheduler integration was missing (2026-08-05)** so zero auto saves | **Prefer for bulk holdings transcripts** when key present. High capacity vs EarningsCalls free. Min length 200 chars. |
| **EarningsCalls.dev** (direct or RapidAPI) | Yes | Free tier often **preview 250 chars only** — hard entitlement probe + preview guard refuse poison cache | Scheduler: `refreshEarningsCallsTranscriptsIfDue` · `earningscalls-transcripts.ts` · ~200 req/mo free | Use for **coverage breadth** if full-text entitled; else blocked durable until plan upgrade. Smart picker: holdings > recency > scan rank. |
| **FMP transcripts** | **No (retired)** | Ultimate plan + rights flags; 402 common on Starter | Producer default-off; `requestFmp` hard-denies | Do not re-enable on ST. CT may probe latency only. |
| Seeking Alpha RapidAPI | Partial | Article-ish, not reliable full transcript pipeline | Enrichment only today | Not a transcript SoR. |

**Why “no transcripts saved” (common causes):**

1. FMP retired / default-off / not entitled (402).  
2. EarningsCalls free = previews → durable `preview_blocked`, zero rows written.  
3. ROIC path never scheduled (library-only).  
4. RAG spend ceiling / lease / missing Voyage-Pinecone blocks `storeDocument`.  
5. Rights gates on FMP-derived namespace (does not apply to ROIC/EarningsCalls managed namespace the same way).

### 4.2 SEC filings & 8-K narrative

| Data type | Sources | Notes |
|---|---|---|
| 10-K / 10-Q body | SEC EDGAR (`sec-filings`, RAG ingest) | Primary. Budget via `SEC_FILING_RAG_MAX_PER_RUN`. |
| 8-K material events | `web-sources/sec8k.ts` | Default ON; full body optional flag. |
| Company facts (XBRL) | `sec-xbrl` enrichment + companyfacts | Free, authoritative. |

### 4.3 Daily OHLCV history

| Source | Order of preference (typical) | Notes |
|---|---|---|
| Massive | Early when key + enabled | Starter history depth; REST paced |
| Tradier | When broker connected | Live vs sandbox base URL |
| Tiingo EOD adjusted | Strong free/Power | Shares quota with enrichment — **Q** |
| Marketstack | Last resort | Tiny free monthly |
| Yahoo chart | Keyless failover | Unofficial |
| ~~Stooq~~ | Unavailable | PoW wall — do not integrate |
| Congress.Trade price cache | Opt-in only | Avoid Massive echo waste |

### 4.4 Macro / regime

| Data type | Sources | Notes |
|---|---|---|
| **VIX** | 1. `vix-cboe` CDN · 2. `vix-yahoo` | Cboe first (no DC 429). |
| **Treasury yields / curve** | Treasury.gov XML keyless; FRED DGS* | FRED no DB cache. |
| **CPI / labor** | BLS API (prefer cacheable); FRED | |
| **Fama-French / CFTC** | `market-signals/*` modules | Research/regime, not scan cells |

### 4.5 Economic / earnings calendars (market-wide)

| Data type | Sources | Notes |
|---|---|---|
| Earnings calendar | Nasdaq calendar, Yahoo per-symbol, Finnhub `/calendar/earnings`, AV EARNINGS_CALENDAR | AV scarce — batch horizon, not per-symbol spam |
| Dividends / splits / IPO | Nasdaq, AV DIVIDENDS/SPLITS/IPO_CALENDAR | AV better spent here than on quotes |
| Economic calendar | Was FMP — **empty after retirement** until non-FMP source wired | Do not call FMP |

### 4.6 Congressional disclosures & analytics

| Data type | Source | Notes |
|---|---|---|
| House/Senate STOCK Act trades | **Congress.Trade** | Only SoR for ST |
| Member skill / clusters / conviction | Congress.Trade analytics flags | Default ON |
| Quiver congress counts | Removed | |

### 4.7 Short interest (structured, non-scan)

| Source | Notes |
|---|---|
| FINRA free files / API | Origin; 2×/month |
| Massive short interest | Paid convenience over FINRA |
| Yahoo `shortPercentOfFloat` | Convenience primary in scan |

### 4.8 News / press

| Source | Notes |
|---|---|
| Finnhub company news | Free workhorse |
| Alpaca news | Broker key |
| Marketaux | 100/day scarce |
| Alpha Vantage NEWS_SENTIMENT | Burns global 25/day |
| Fintech Studios | Paid niche |
| Tiingo news | **403 on free** — Power only |

---

## 5. Provenance requirements (every data point)

Every value that enters scans, caches, or RAG should carry:

| Field | Meaning |
|---|---|
| `source` / provider id | Who produced the value (e.g. `yahoo-finance`, `roic-earnings-transcript`) |
| `asOf` / event time | Economic time of the fact when known (filing date, call date, bar date) |
| `fetchedAt` / observed time | When **we** first/last successfully observed it |
| Optional `fieldObservations` | Multi-source receipts already on enrichment cascade |

Implementation anchors:

- Enrichment: `sources`, `fieldObservations`, `fieldDates` on `SymbolEnrichment`
- Durable per-field store: `symbol_field_latest` (PR #2503 era)
- Transcripts: `source` + `published_at` on `storeDocument`; fetch-once caches with negative TTL

**Gap to close:** not every history/macro/web-source path stamps both event and fetch times uniformly — treat any missing stamp as a bug when touching that path.

---

## 6. Settings / tier awareness (product)

API keys in Connections/Settings declare **plan tier** (free / starter / power / …) so the app:

- Applies correct quota windows without Infisical-only knobs (`src/lib/provider-tier-plan.ts` → `resolveProviderQuota`)
- Can later gate endpoints by entitlement (e.g. Tiingo news on Power, FMP transcripts on CT only)
- Marks **FMP** as **Retired · CT-only** in the key catalog (ST product never calls it)

**UI:** Connections → API keys — plan dropdown beside optional market-data keys. Default `free`/`unknown` for existing keys. Persist: `user_api_keys.plan_tier`. Env `PROVIDER_QUOTA_*` still wins over declared tier.

Mandatory always-on infra keys (Pinecone, embed provider, OpenRouter/LLM) stay outside “optional tier” UX.

---

## 7. Admin health semantics (STOPPED vs yellow vs OFF)

| UI | Meaning |
|---|---|
| Green / OK | Recent success, not hard-stopped |
| Yellow **DEGRADED** | Soft stop: active this hour but no success yet / no success in 60m (`stoppedReasonKind` soft) — often cold start or flaky, not “dead forever” |
| Red **STOPPED** | Hard: last 5 consecutive calls failed — circuit may trip enrichment |
| Grey **OFF** (target) | Intentionally disabled / retired (FMP, Quiver) — **must not** look like an outage |

Yellow is **not** “second-class source quality”; it is **health of the call lane**.

---

## 8. Quick lookup recipe for agents

```
1. Identify data point id (section 3–4 or listDataPoints() in code).
2. Read sourcesFor(id) / table row — all candidates + notes.
3. Filter ST-allowed (no FMP/QQ).
4. Prefer free/keyless covering sources if quality note allows.
5. If spending paid/scarce, confirm the symbol still needs a field ONLY that source supplies
   OR quality note demands it (SEC for restatement-safe eps, etc.).
6. Always write source + fetchedAt (+ asOf when known).
7. If transcripts: check entitlement (EarningsCalls preview block) and scheduler wiring (ROIC).
```

---

## 9. Maintenance

- When adding a provider field parser: update `suppliesFields` **and** this matrix **and** `source-capability-matrix.ts`.
- When retiring a vendor: mark `stAllowed: false`, remove cascade registration, health **OFF**.
- Re-verify quota numbers against `docs/market-data-provider-pricing.md` dates.

---

## 10. Related rollouts

- `docs/rollouts/2026-08-04-retire-direct-fmp-quiver-uw.md`
- `docs/rollouts/2026-08-05-symbol-field-latest-store.md`
- `docs/rollouts/2026-07-19-earningscalls-burst-smart-daily.md` (if present)
- This overhaul: `docs/rollouts/2026-08-05-data-sources-overhaul.md` (when landed)
