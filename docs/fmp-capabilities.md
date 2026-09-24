# Financial Modeling Prep (FMP) capability and routing map

> **RETIRED for direct use in Socratic-Trade (owner 2026-08-04).** This app must
> **never** call `financialmodelingprep.com`. **Fundamentals** come from the
> multi-provider cascade (Yahoo, Finnhub, ROIC, SEC XBRL, Tiingo, …). **Congressional**
> disclosures/analytics come from **Congress.Trade**. Choke points:
> `src/lib/retired-direct-vendors.ts`, `requestFmp`, enrichment registration.
> The historical endpoint map below is retained for archaeology and for operators
> looking at the **shared** FMP dashboard (which may still show Congress.Trade
> latency/probe traffic).

This was the source of truth for what Socratic-Trade used to call.

## Dashboard attribution

The FMP credential is shared with Congress.Trade, so endpoint counts in FMP's
dashboard are not Socratic-Trade-only telemetry. In particular,
`historical-price-eod/dividend-adjusted`, `profile`, `house-latest`, and
`senate-latest` are used by Congress.Trade. At the time of the screenshot,
Socratic-Trade's call-volume view aggregated by provider/credential rather than
attributing each durable dispatch to an endpoint.

## Production Socratic-Trade endpoints

`FmpEnrichmentProvider` uses the stable base URL and sends the API key in the
`apikey` header so credentials do not appear in URLs or error logs.

- `/stable/profile`: company name, sector, industry, beta, dividend yield, and
  52-week range.
- `/stable/ratios-ttm`: P/E, P/B, debt/equity, ROE, ROA, gross margin, and
  dividend yield. The provider consumes the useful fields already returned by
  this endpoint instead of retaining only P/E.
- `/stable/grades-consensus`: source-attributed analyst vote and counts.
- `/stable/insider-trading/search`: recent insider buy/sell sentiment. Expected
  entitlement failures degrade without breaking the cascade.
- `/stable/price-target-consensus`: numeric price targets when
  `FMP_PRICE_TARGETS_ENABLED` is explicitly enabled.

The prior `/api/v4/insider-trading` and `/api/v4/senate-trading` calls were
legacy routes. The Senate call was also the wrong ownership boundary:
Congress.Trade is the system of record for House/Senate disclosures and sends
normalized congressional signals to Socratic-Trade. Duplicating that feed per
symbol wastes the shared quota and creates inconsistent truth.

FMP requests remain covered by the shared 290-request/minute credential quota,
six-hour enrichment cache, circuit breaker, health receipts, and per-field
provenance. Coverage hints can skip redundant ratios/consensus calls when fresh
Congress.Trade facts already identify those exact upstream fields.
Crash-durable provider-dispatch events carry the scrubbed stable operation name
(`enrichment-profile`, `enrichment-ratios-ttm`, and so on) in addition to
provider/credential scope, so Socratic-Trade's endpoint mix is distinguishable
without exposing API keys.

PR #1616 also landed typed capability adapters for FMP quote/index/ETF,
macro/treasury/economic, calendar/news/congressional, DCF, financial-score, and
historical-grade routes. They now share header authentication, the same durable
credential-wide request reservations, and `capability-<endpoint>` outcome
labels. These adapters are callable infrastructure and a manual entitlement
probe—not evidence that the production scheduler consumes every dataset.
Production integration should wire only non-duplicative fields into a durable
point-in-time store on the cadence below; calling wrappers merely to increase
the vendor dashboard count is explicitly not utilization.

## Scan versus ingestion

Endpoint count is not a utilization goal. A cold 150-symbol scan previously
waited for every provider: Finnhub alone enqueued up to 750 paced requests, and
FMP admitted a large per-symbol fan-out. The interactive route timed out after
25 seconds without cancelling that work, so retries multiplied the queue.

Interactive Market Scan now returns real screener/broker data plus persisted
web signals without starting the deep enrichment cascade. It accepts only a
completed strategy scan from the last 24 hours, reuses only genuinely slow
facts, and always replaces price, spread, change, volume, VWAP, timestamps, and
event-sensitive signals. Identical refreshes share one in-flight scan. If the
Nasdaq request is unavailable, the last strategy scan is returned with explicit
stale attribution instead of a blank table. Full strategy/scheduler runs retain
deep enrichment, and opening any ticker performs bounded, coalesced on-demand enrichment.

## Expansion plan by data shape

Structured, point-in-time data should be persisted and refreshed on its natural
cadence, then read locally by scans:

1. Company profile and identifiers: daily/weekly plus on-demand refresh.
2. Ratios, key metrics, statements, financial scores, and owner earnings:
   refresh after new filings/earnings; retain period and filing date.
3. Analyst estimates, revisions, grades, targets, earnings and surprises:
   scheduled daily/provider-cycle ingestion with revision history.
4. Earnings, dividend, and split calendars: market-wide scheduled ingest with
   local event flags.
5. Insider trades: scheduled latest/search ingest with issuer statistics; do
   not refetch the same history on every scan.
6. Press releases and material stock news: URL/content-hash dedupe; retain
   structured event facts and embed only decision-useful narrative.

Narrative artifacts such as earnings transcripts and material releases belong
in the RAG corpus. Quotes, statements, ratios, estimates, ownership, calendars,
and macro series remain structured and time-indexed.

## Entitlement boundary

The current FMP subscription does not entitle earnings transcripts: the stable
transcript request returns HTTP 402. The generic `src/lib/fmp-gamma.ts` adapter
is reached only by the manual capability probe, not an app ingestion path; the
three calls visible in the screenshot were test or manual attempts. PR #1586
has since added a separate stable, durable, rights-gated producer, but every
ingestion/backfill flag remains default-off until the owner upgrades the plan
and confirms corpus/storage/display rights.

FMP currently lists transcripts, ETF/mutual-fund holdings, 13F datasets, and
bulk/batch delivery under its Ultimate plan. Premium unlocks broader statement
and corporate-calendar coverage. Capability discovery should record
`available`, `not_entitled`, or `retired` with a negative TTL; it must not retry
an unavailable endpoint for every symbol.

## Deliberate non-duplication

- Broker/Alpaca remains the execution-adjacent quote authority; Nasdaq, Massive,
  and Yahoo remain quote/history fallbacks. FMP can fill gaps but should not
  create a second execution-price truth.
- SEC remains authoritative for filing bodies and raw XBRL.
- Congress.Trade remains authoritative for congressional disclosures.
- Vendor technical indicators are not fetched when the app computes the same
  signal from source OHLC.
- Crypto, forex, and commodities remain out of scope until those instruments
  are supported by policy and execution.

Measure fill rate, freshness, ingestion lag, entitlement/success state,
provenance, and decision value—not the number of endpoints called.
