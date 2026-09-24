# Socratic-Trade full-stack review — 2026-08-23 (Cursor)

Live probe of `https://socratictrade.com/api/health` at 2026-08-23T21:03Z: `ok: true`, live sha `2de5856fd00f9b828a0a02f8aa55468de2118a29`, scheduler lease healthy, `tradingLiveness.degraded: 1`, `oldestCompletedRunAgeSeconds: 262029` (~3 days), `marketOpen: false`. Pinecone configured. Embed provider OpenRouter. Massive/Polygon history-cap 403 on a 2.5y window (free-tier probe, not today's tape).

This is a filing review.  Code fixes are not in this PR.  Do not duplicate the 2026-08-20 DeepSeek outline; these items were re-checked against current `origin/main` and live Sentry.

## P0

| Board | Issue | Finding |
|---|---|---|
| `d4cb5e75` | #3056 | Alpaca write path sends `stop_market`; Alpaca requires `stop`. Protective stops + tests pin the wrong word. |
| `9f875d62` | #3057 | SEC ingest dead-letters embed 400s / connection failures as "budget exceeded" then requeues them. Sentry SOCRATIC-TRADE-27 (350) + SOCRATIC-TRADE-1X. |
| `ef0dccb3` | #3058 | MCP place timeout always REST-falls-back and can double-submit. |

## P1

| Board | Issue | Finding |
|---|---|---|
| `79daff38` | #3059 | Dashboard recent fills take the oldest 500 (`slice(0, 500)` after ascending sort). |
| `3cbfcbef` | #3060 | Incremental SEC refresh counts `skipped` before `error`. Coverage looks green while retrieval is empty. |
| `3b3df6ca` | #3061 | iOS `Dictionary(uniqueKeysWithValues:)` traps on duplicate command ids. Pairs with existing `d9f81e44`. |
| `30809a0c` | #3062 | Web 401 never routes to login; desk freezes on last-good data. |
| `64413d84` | #3063 | Prod `tradingLiveness` degraded; oldest completed run ~3d. Age-gate against the session calendar. |
| `d36c2233` | #3064 | Any `client_order_id` counts as app-placed. Owner GTC cancel-replace risk. |
| `41fba175` | #3065 | Query embed failure returns null; retrieval looks like empty corpus. |

## P2

| Board | Issue | Finding |
|---|---|---|
| `512444e3` | #3066 | iOS TestFlight ship CI (Sentry FLEET-INFRA-BN 221), Playwright smoke (BR 87), deploy freshness (BS 41). |
| `6e10da30` | #3067 | Session close prints stamped Delayed Quote. |

## Also true, already on the board (not re-filed)

- `06df80cf` gather has no internal time budget (P0 in progress, Claude).
- `f7ffb62f` RAG document types / local full files / Pinecone light (P1 in progress, Cursor pickup).
- `b88b6675` stock data cascade still falls to Yahoo.
- `1e3df744` Litestream L2/L3 (Claude ops heal 2026-08-22; confirm health JSON after next inventory).
- DeepSeek 2026-08-20 handoff clusters still open on the board (Guardrails Discard, CSP report-only, legal CDN cache, etc.).

## Suggested fix order

1. Alpaca `stop` wire map (#3056) — protective exits.
2. Ingest error classification (#3057) — stops the paid retry storm.
3. MCP place reconcile (#3058) — double-submit.
4. Recent fills slice (#3059) — owner-visible tape.
5. iOS uniqueKeys (#3061) — crash.
6. Embed null vs empty (#3065) + skip/error honesty (#3060).
7. Web 401 (#3062), provenance prefix (#3064), liveness calendar (#3063).
8. CI / Delayed Quote labels.

## Verification this session

- `curl https://socratictrade.com/api/health`
- Sentry `jays-services` unresolved, freq-sorted, 7d
- Code grep on `~/apps/trading-cursor` for `stop_market`, budget throw, `slice(0, 500)`, `uniqueKeysWithValues`
- Board search for embed / integrity / TestFlight before filing
