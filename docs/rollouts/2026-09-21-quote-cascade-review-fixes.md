# 2026-09-21 — Quote cascade review-findings sweep (PR #3448, MUSE fleet)

## Context & Objective

PR #3448 (`ag/quote-cascade-freshness-performance`) repaired quote-cascade freshness and
eliminated the SEC/RAG event-loop stall class.  Sentry and Codex review threads on the PR
identified eleven further defects in the repaired code — stale non-Yahoo fills overwriting
newer Yahoo prices, the live cascade blocking the bounded Yahoo floor, delayed tapes
masquerading as real-time via fresh fetch stamps, crossed books accepted as live NBBO,
per-fetch timestamps stamped at cascade start, a duplicate broker call in the dashboard
fallback, RTH admitted once per SEC tick instead of per task, and `prevClose` falling back
to the current price.  This round implements all eleven findings, records the changed
approach in `PLAN.md` (Codex P2), and runs the full `npm test` the rollout note previously
claimed without evidence (Codex P2).

## Changes Made

- **Freshness model (`src/lib/quotes-cascade.ts`):**
  - `isTwoSidedLiveNbbo` now rejects crossed books (`bid > ask`) — a malformed book is
    never a live NBBO (Codex P2).
  - New `isVerifiedRealtimeBook` gate: only verified real-time two-sided broker books may
    age by `fetchedAt`.  Delayed tapes — Yahoo cascade providers and secondary
    Tradier-paper books tagged `venueDelayedTape` — age by market `asOf`, so a fresh
    local fetch stamp can never promote ~15m-delayed data to live (Codex P1 x2).  Both
    `isQuoteFresh` and `quoteAgeSecForStalenessGate` use the gate.
  - Each provider response is stamped with `fetchedAt` when its fetch *completes*
    (`stampIngest`), not when the cascade started — a quote obtained after a slow broker
    wait no longer arrives already aged by that wait (Codex P2).
  - `fetchFreshQuotesCascade` accepts `{ signal, skipActiveBroker }`.  The cascade abort
    signal is passed to broker gateway calls and the ROIC fetch (Sentry HIGH: the abort
    is now plumbed end-to-end; gateway implementations adopt the optional signal
    incrementally — the parameter is backward compatible).
  - Secondary connected accounts: a Tradier paper/sandbox book is tagged
    `venueDelayedTape` — kept for fallback, never promoted to real-time, and never
    stops the cascade ahead of Alpaca/Yahoo (Codex P1).  The *active* execution venue
    keeps `venuePriceAuthoritative`, which still stops the cascade by owner ruling.
- **Single quote route (`app/api/quote/route.ts`):**
  - The live cascade no longer blocks the bounded Yahoo floor.  Once the chart resolves,
    the cascade gets only a `LIVE_CASCADE_OVERLAY_GRACE_MS` (1.5s) overlay window via
    `Promise.race` instead of `Promise.all`; if the cascade has not resolved by then,
    the floor returns and the cascade is aborted so scarce providers stop spending
    (Codex P1 / Sentry HIGH — a slow broker could otherwise hold the response past its
    16s first wait / 30s I/O deadline).
  - Overlay candidates are validated with `isQuoteFresh`, not the Yahoo-only
    `delayedFallback` flag — stale non-Yahoo fills (e.g. `session-close`) can no longer
    overwrite a newer Yahoo price (Codex P2).  If Yahoo fails, the route still waits
    for the cascade.
- **Dashboard & watchlist (`src/lib/dashboard.ts`, `app/api/watchlist/route.ts`):**
  - Missing-price detection uses freshness, not positivity — a stale-but-positive
    broker quote (e.g. a `session-close` fill) now falls back to the cascade instead of
    sizing at yesterday's close during RTH (Codex P1).
  - The dashboard cascade fallback passes `skipActiveBroker` so a broker that already
    timed out the direct gateway call is not issued a duplicate call while degraded
    (Codex P1).
- **SEC ingest worker (`src/lib/rag/sec-ingest-worker.ts`):**
  - RTH is rechecked before *each* task and immediately before the heavy synchronous
    `parseFilingHtml` parse — a tick admitted just before 09:30 ET no longer chains
    long tasks or enters a multi-second parse once regular hours begin (Codex P1).
- **Yahoo (`src/lib/yahoo-finance.ts`, `src/lib/market.ts`, `src/lib/on-demand-quote.ts`,
  `app/api/quote/route.ts`):**
  - `yahooQuoteFromChartMeta` no longer falls back `prevClose` to the current price;
    `prevClose` is `undefined` when Yahoo omits `chartPreviousClose`, so no fabricated
    0% intraday change (Sentry review).  Consumers narrow the optional before use.
- **Tests:** new cases for crossed-book NBBO rejection, delayed-tape market-time aging
  (Yahoo + Tradier paper), verified real-time fetch-time aging, and `prevClose`
  omission; updated gateway-call assertions for the new `{ signal }` options arg and the
  quote-route mock to keep the real `isQuoteFresh`.
- **Docs:** `PLAN.md` top entry recording the changed approach (Codex P2); this note;
  `STATUS.md` snapshot; `docs/EFFORT-LOG.md` round note.

## Decisions & Trade-offs

- **Fetch-time aging is a privilege, not a default.**  The original repair let any
  two-sided book age by fetch time; review showed that silently promoted delayed tapes
  (Yahoo's ~15m delay, Tradier paper) to live whenever the fetch was fresh.  The
  `venueDelayedTape` marker plus the Yahoo-provider exclusion close that hole while
  keeping the quiet-name behavior (real-time NBBO, stale last print) intact.
- **Bounded floor over full cascade.**  The route previously awaited the entire cascade
  beside Yahoo; with broker timeouts the response could exceed its own 16s/30s
  deadlines.  The 1.5s overlay window keeps the Yahoo floor's latency bound while still
  letting a fast cascade improve the price; when Yahoo is down, the cascade remains the
  full wait.
- **Abort signal is plumbed but not enforced inside gateways.**  `getEquityQuotes` now
  accepts `{ signal }` and the cascade passes its budget signal, but individual broker
  gateway HTTP calls do not yet wire the signal to their clients — that is follow-up
  work per gateway, not part of this round.
- **SEC parse stays synchronous when admitted.**  The finding that yielding around
  `parseFilingHtml` cannot unblock the parse itself is correct; moving Cheerio parsing
  off the serving event loop (worker thread / child process) is a larger architectural
  change left as follow-up.  This round narrows the exposure: RTH is rechecked at every
  task boundary and immediately before entering the parse, so a long parse can only
  start outside RTH.
- **Tradier paper as active venue is unchanged.**  Only *secondary* Tradier-paper books
  are demoted to delayed tape; the active execution venue's `venuePriceAuthoritative`
  behavior (stops the cascade, sizes against the venue) is untouched by owner ruling.

## Verification State

- Four-gate sequence in mandated order on the merged tree:
  - `npm run lint` — 0 errors, 4 warnings (all pre-existing `no-explicit-any`; verified
    identical on the unmodified tree).
  - `npx tsc --noEmit` — clean.
  - `npm test` — **8181 passed / 51 skipped / 0 failed** (747 files passed, 1 skipped), `EXIT=0`, duration 1278s.  Full run, not a subset — this closes the Codex P2 that the rollout docs claimed a full run without evidence.
  - `npm run build` — **EXIT=0** (Sentry integration import warnings are pre-existing; build succeeds).
- Targeted suites before the full run: `test/quotes-cascade.test.ts`,
  `test/yahoo-finance-fundamentals.test.ts`, `test/quote-route.test.ts` — 49/49 pass.
- `verify`, `verify-ios`, `verify-hosted`, `gitleaks`, `check-pin` re-run on push;
  auto-merge (squash) armed per the standing owner rule once green.

Touched files:
- `src/lib/quotes-cascade.ts`
- `src/lib/types.ts`
- `src/lib/quote-cascade-budget.ts`
- `app/api/quote/route.ts`
- `app/api/watchlist/route.ts`
- `src/lib/dashboard.ts`
- `src/lib/market.ts`
- `src/lib/on-demand-quote.ts`
- `src/lib/rag/sec-ingest-worker.ts`
- `src/lib/yahoo-finance.ts`
- `test/quotes-cascade.test.ts`
- `test/quote-route.test.ts`
- `test/yahoo-finance-fundamentals.test.ts`
- `PLAN.md`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-09-21-quote-cascade-review-fixes.md`
