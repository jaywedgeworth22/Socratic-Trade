# Socratic-Trade — Improvement Review (2026-07-07)

Review artifact (uncommitted, not part of `docs/`). Findings are grounded in the
actual code as of `main` @ `add1bd29`; each cites file:line. Most are **CONFIRMED**
(read directly); a few are **SUSPECTED** (need a runtime profile) and marked so.

Two independent audits (performance + UI) plus spot-verification of the headline
claims. Nothing here has been changed — this is analysis only. Because this session
runs on the `main` integration worktree, per `AGENTS.md` I did not edit code; route
implementation to an `agent/*` lane via `scripts/land.sh`.

---

## TL;DR — the five highest-leverage moves

1. **Cache the dashboard snapshot server-side.** `getDashboardSnapshot()` is fully
   recomputed on every 15s poll, every SSE event, every open tab, and every mobile
   refresh — with zero memoization. One short TTL cache collapses the app's single
   biggest recurring cost. *(Perf #1)*
2. **Compute FIFO P&L once per request, not 4–5×.** *(Perf #2)*
3. **Reconcile nav labels with page headings.** "Evidence→Scan", "Decisions→Approvals",
   "Journal→Activity" etc. is the #1 reason the app feels unintuitive. *(UI #1)*
4. **Add a first-run checklist.** A new user with no broker + no LLM key lands on a
   dashboard of empty cards with no guided path to their first proposal. *(UI #2)*
5. **Progressive-disclosure the approval card + de-jargon it.** The one action that
   matters (approve/reject) is buried under 8+ dense quant sub-sections. *(UI #3)*

Quick wins that are nearly free: `Promise.all` the 4 serial macro fetches; virtualize
the scan table (dep already present); delete the dead `motion` dependency.

---

## Functional / performance

Priority = impact × recurrence. Effort S/M/L.

| # | Finding | Impact | Effort |
|---|---------|--------|--------|
| 1 | Dashboard snapshot recomputed every poll — no server cache | High | M |
| 2 | FIFO P&L replayed 4–5× per request on the same fills | High | M |
| 3 | Macro board awaits 4 independent network calls serially | High | S |
| 4 | Two LLM red-team passes on live/high-stakes openings (inline Bear + escalated debate) — likely-unintended redundancy; consolidate | Med | M |
| 5 | Scan table renders ~100×13 cells unvirtualized | High | M |
| 6 | `/api/scan` runs a full scan synchronously per request, uncached | High | M |
| 7 | Whole console re-renders on every tick — zero `React.memo` | Med-High | M |
| 8 | `console/page.tsx` runs ~15 `derive*()` calls unmemoized | Low-Med | S |
| 9 | Per-screen REST polls duplicate data the SSE already pushes | Med | M |
| 10 | `/api/mobile/snapshot` pays full desktop cost, ships a subset | Med | S-M |
| 11 | `listAudit` JSON-parses ~100 blobs/poll, then ships `payload:null` | Med | M |
| 12 | `react-markdown`+`remark-gfm` on the dashboard critical path | Med | S |
| 13 | Budget-ledger double-aggregates on the LLM hot path (only when a ceiling is set) | Med | M |
| 14 | `listLearnedContextForDecision` full-table scan + JS filtering | Med | S |
| 15 | `dailyExecutionStats`/`notionalInLastMinutes` re-parse `proposal` JSON per row | Med | S |

### Detail on the top items

**1 — Dashboard snapshot has no server-side cache.** `getDashboardSnapshot()`
(`src/lib/dashboard.ts`) is called by `/api/dashboard` (`app/api/dashboard/route.ts:15`,
`dynamic="force-dynamic"`) and `/api/mobile/snapshot/route.ts`, polled every 15s per
tab (`app/console/lib/useConsoleData.tsx:22,98`) *and* on every SSE event. Per call it
runs ~8 DB list queries + FIFO replays + feed rebuilds + several awaited network
fetches. Nothing is memoized → 2 tabs = 2× everything.
**Fix:** short per-`(userId, accountNumber)` in-memory TTL cache (~10s) for the whole
snapshot; SSE already fires on real changes so you can invalidate on write. This single
change also neutralizes #10 and #11. Highest leverage in the codebase.

**2 — FIFO P&L replayed 4–5× per request.** `getPerformanceSummary`,
`getThesisScorecard` (`src/lib/performance.ts:493`), `getRegimeScorecard` (`:508`),
`getSectorScorecard` (`:536`) and `getTaxSummary` each independently call
`calculatePnl()` — an O(fills) lot-matching pass over up to 1000 fills
(`performance.ts:359-478`) that re-parses `fill.raw` JSON per fill — on the *same*
prefetched rows. Rows are fetched once (good); the CPU replay is not.
**Fix:** compute `calculatePnl(liveFills)`/`calculatePnl(paperFills)` once in
`getDashboardSnapshot`, thread `closedLots` in via an optional `prefetchedPnl?` param
(mirrors the existing `prefetched?: PrefetchedFills` pattern). Pure win, independent of #1.

**3 — Macro board is a 4-deep waterfall.** `src/lib/dashboard.ts:456,496,498,499`:
`fetchMacroData` → `getMarketSignals` → `fetchMacroHistory` → `fetchMassiveNews` are
each `await`ed one at a time inside the `macroBoard` object literal, with no data
dependency between them. **Fix:** `Promise.all` them (keep the per-call `.catch()`
fallbacks). ~3–4× macro latency cut, trivial, low risk. Best effort:impact ratio here.

**4 — Two LLM red-team passes on live/high-stakes openings (redundancy, not latency).**
*Verified on `origin/main`. The critic role has ONE identity — "Bear" and "Red Team" are
the same reviewer (`strategy.ts:1095,1255,4408`), not two critics.* The adversarial stack
has three layers:
- (i) `deterministicBearFilter` — model-free hard rules (phantom exits, momentum/regime
  vetoes), `strategy.ts` ~2270. No LLM.
- (ii) **REQUIRED inline Bear** inside `proposeTrades()` (`strategy.ts:4406`, role `"red"`),
  on every opening; sequential after Bull by necessity (critiques Bull's output). Fail →
  `bearReviewUnavailable` → fail-closed to human review.
- (iii) **CONDITIONAL escalated `debateProposal()`** (`red-team.ts:81`) in the loop
  `for (const proposal of sizedProposals)` (`strategy.ts:1262`), gated by
  `shouldRunRedTeamDebate` (`:2206`). That gate returns true for confidence ≥ threshold,
  notional ≥ threshold, **`isLiveOpening` (ANY live opening)**, override request, or
  escalation regime.

Because `isLiveOpening` alone trips the gate, **every live opening is critiqued by the LLM
red team twice** (ii + iii). This is almost certainly unintended redundancy (the escalated
pass was believed removed). **Model choice is NOT stakes-based:** both (ii) and (iii)
resolve via `resolveRoleModel` (`llm-provider.ts:55-74`) → your `redTeamLlmModel` setting
if set; else a cross-family default (OpenAI Bull → `claude-haiku-4-5`, *only if an Anthropic
key exists*, `:41-73`) to avoid a same-model echo chamber; plus an off-by-default
`RED_TEAM_LLM_PROVIDER` env override (`red-team.ts:77`). Nothing routes to Anthropic
because a trade is "high stakes."

**Fix (if intent = one LLM red team on the user's chosen family):** remove the escalated
`debateProposal` call (iii) or fold its triggers into the inline Bear (ii); optionally make
the unset red-team default follow the user's family instead of cross-family. Do NOT
parallelize (ii)'s Bull→Bear — Bear consumes Bull's output. *(Supersedes the earlier
"parallelize the debate loop" framing — the real issue is duplication, not latency.)*

**5 — Scan table isn't virtualized.** `app/console/scan/scan-table.tsx:260` maps up to
100 candidates × 13 columns → ~1,300 cells reconciled on every scan update. `react-virtuoso`
is already a dependency and already used (`dashboard-client.tsx` via `TableVirtuoso`).
**Fix:** wrap this table in `TableVirtuoso`. Zero new deps.

**6 — `/api/scan` recomputes per request.** `app/api/scan/route.ts:40-68` calls
`scanMarket()` + live `getEquityQuotes` + `fetchRecentGroupedBarsRest` on every GET.
Inner screener/enrichment caches help, but the merge/enrich/quote assembly + a live
broker quote round-trip run each time; only a per-user rate limit protects it.
**Fix:** 30–60s in-memory cache of the assembled scan keyed by `(userId, policy-hash)`;
let only the broker-quote merge refresh at ~15s.

**7/8 — No render memoization.** `React.memo` count across all of `app/console` is
**zero**. Every 15s poll / SSE event creates a new `snapshot` object
(`useConsoleData.tsx:75`) and new context value; the `stream` health object updates on
*every* SSE event (`:137`), so the whole subtree re-runs each tick.
`console/page.tsx:38-58` compounds it with ~15 unmemoized `derive*()` calls plus an
inline `deriveDissentRows(...)` in JSX (`:219`). **Fix:** (a) split `stream`/freshness
into its own context; (b) wrap heavy leaf cards (`PositionsCard`, `EquityChart`,
`ScanTable`, `ApprovalCard`) in `React.memo`; (c) `useMemo` the derive block. Do 7 before 8.

**9 — Redundant polls over the SSE bus.** `nav.tsx:47` polls
`/api/learned-context/pending` every 60s though `useConsoleData` already listens to the
`pending-learned-change` SSE event (`:159`); `watchlist/page.tsx:76` polls
`/api/watchlist`+`/api/alerts` every 30s; `approvals/learned-context.tsx:226` polls
every 60s. On the approvals screen that's up to 3 timers + the SSE push on overlapping
endpoints. **Fix:** route through the SSE bus / a shared provider count; keep one 120s
safety net per resource, not per component. Several of these also lack `AbortController`.

**12 — Markdown on the critical path.** `app/ui/markdown.tsx:6-7` static-imports
`react-markdown`+`remark-gfm`, pulled onto the dashboard via `dashboard-client.tsx →
AssistantView → Markdown` (~100 KB gzip on first load even if the assistant is never
opened). **Fix:** `next/dynamic(() => import("./markdown-impl"), {ssr:false})` and dedupe
the two near-identical markdown components. *(Charts and `@xyflow/react` are already
lazy-loaded — leave them.)*

**Already-good (do NOT "optimize" these):**
- Enrichment cascade (`data-providers.ts`) is fully parallel (`Promise.all` at `:899`,
  per-provider `CONCURRENCY=5`, `Promise.allSettled` per symbol) with consent-aware TTL
  caching. Not N+1.
- SSE (`app/api/events/stream/route.ts`) is an in-process event bus + 25s heartbeat, not
  per-client DB polling.
- DB indexing has a deliberate `performance_indexing_fixes` migration (`db.ts:196-220`);
  dashboard batches proposal lookups and prefetches fills once.
- LLM prompts are actively compacted; embeddings are LRU+TTL cached and de-duped;
  Anthropic prompt-caching is on. `lightweight-charts` + `@xyflow/react` already
  `next/dynamic({ssr:false})`.

---

## UI / UX (intuitiveness)

| # | Finding | Impact | Effort |
|---|---------|--------|--------|
| 1 | Nav labels ≠ page headings ≠ URLs (renamed abstractions) | High | S |
| 2 | No first-run onboarding — empty dashboard, no guided path | High | M |
| 3 | Approval card is an 8-section wall; approve/reject buried | High | M |
| 4 | Approval jargon is quant-only; defs hidden in `title=` tooltips (invisible on touch) | High | M |
| 5 | Settings buries "connect broker" + "add API key" below tax/model settings | High | S |
| 6 | 13 flat nav destinations, no grouping; wrong 3 are mobile-primary | Med | M |
| 7 | `if (!snapshot) return null` blanks whole pages on load (no skeleton) | Med | M |
| 8 | Shared-snapshot fetch errors invisible on most pages | Med | M |
| 9 | `/mobile` is a divergent second app (own tokens/logic), undiscoverable | Med | L |
| 10 | "Test / Local Mock Paper Account" contradicts the removed-simulation philosophy | Med | S |
| 11 | Touch targets < 44px in the mobile "More" sheet + small buttons | Med | S |
| 12 | `decisions/[id]` reachable only by deep link, dead-ends to `/console` | Med | S |
| 13 | Watchlist etc. use one global `busy` flag freezing all controls | Med | S |
| 14 | `usage` page doesn't use the console design system | Med | M |
| 15 | Duplicate `<h1>` + name flip (Coach vs Assistant) | Low | S |

### Detail on the top items

**1 — Nav labels break the mental model (the #1 intuitiveness issue).**
`app/console/components/nav.tsx:80-91` renames every route to an abstract word that
diverges from both the URL and the page's own `<h1>`: `/console/scan`→"Evidence" (page
title "Scan"), `/console/approvals`→"Decisions" (title "Approvals"),
`/console/activity`→"Journal", `/console/macro`→"Regime", `/console/strategy`→"Framework",
`/console/guardrails`→"Mandates", `/console/results`→"Outcomes". A user clicks "Evidence"
and lands on "Scan." **Fix:** pick ONE vocabulary. Either use the plain task labels in
nav (matching headings), or, if "Thesis/Evidence/Journal" is intentional branding,
rename each page `<h1>` to match. Low effort, high clarity payoff.

**2 — No first-run onboarding.** `components/shell.tsx:63-97` branches only on
`loading`/`!snapshot`; a new user with no broker and no LLM key sees empty cards and
must intuit that Settings is where you fix that. The whole value prop (get a proposal)
is unreachable without those two steps, and nothing points there. **Fix:** when
`snapshot.connectedAccounts.length === 0 || snapshot.llmConfigured === false`, render a
first-run checklist in `<main>` with two CTAs deep-linking to
`/console/settings#brokers` and `#api-keys` (the state + deep-link scroll handler
already exist — `settings/page.tsx:50-56`).

**3 — Approval card overload.** `components/approval-card.tsx:213-482` stacks green-team
model+confidence, red-team verdict, a 9-row sizing-provenance `<dl>`, reward:risk bar,
RAG citations, "since proposed", "last re-check", policy gate, and a three-outcomes
block — all before the Reject/Approve footer. On a phone that's a very long scroll per
card. **Fix:** show a compact summary by default (verb + symbol + size + thesis +
confidence + R:R + one-line critic verdict + actions); collapse provenance / citations /
policy internals behind a "Show reasoning" expander.

**4 — Quant jargon, tooltip-only definitions.** "green team / red team", "ADV cap",
"Sizer band", "entry drift", "projected symbol exposure", "notional" are explained only
via `title=` attributes (`approval-card.tsx:219,272,…`) — which don't appear on touch
and aren't keyboard-accessible, so on mobile the entire explanatory layer is
unreachable. This pattern recurs app-wide (macro tiles, guardrail hints, scan headers).
**Fix:** rename to plain language in the visible label ("AI proposer" / "AI critic");
promote load-bearing defs to visible helper text or a tappable info-popover.

**5 — Settings ordering fights the new user.** `settings/page.tsx:64-115` renders THIS
ACCOUNT (tax, models) *above* ALL ACCOUNTS (broker connections, API keys); the "No
brokerage connected yet" empty state (`brokers.tsx:216`) is the 2nd card down. **Fix:**
float Broker connections + API keys to the top when nothing is configured.

**6 — Nav sprawl + wrong mobile primaries.** 13 flat destinations (`nav.tsx:105-128`);
mobile shows `DESTINATIONS.slice(0,3)` = Thesis/Decisions/Journal, so Scan, Orders,
Results, Watchlist, Settings all hide behind "More" (`nav.tsx:131`). **Fix:** group the
rail (Act / Understand / Configure); make Decisions + Thesis + Scan + Orders the mobile
primaries (the act/monitor loop), not Journal.

**10 — "Local Mock Paper Account" contradicts the philosophy.** `chrome.tsx:159-161`,
`brokers.tsx:151-166,238-242` offer a "Local Mock Paper Account — simulated fills" as a
peer broker, but `AGENTS.md` states the local-simulation path was deliberately removed
and `TestBrokerGateway` is test-infra only. A newcomer picks the "safe" mock to try it
and hits a dead end. **Fix:** hide "Add Test Account" from the console (keep the adapter
for tests). *Confirm intent — flagged in case it's deliberate.*

**Already-good (preserve, don't duplicate):**
- Risk friction is well-calibrated: paper approve = 1 click; live requires a
  server-authoritative typed `APPROVE LIVE <SYMBOL>` with paste disabled
  (`approval-card.tsx:520-617`); bulk-approve skips live. Matches "harden correctness,
  not obedience."
- Mutation feedback is thorough: console toasts with pos/neg/warn tones + "takes effect
  next run" follow-ups; buttons gate on `busy` and relabel ("Approving…", "Scanning…").
  Coach keeps failed messages with a Retry that reuses the idempotency key.
- The `--con-*` design token system, consistent `fmtMoney/fmtPct/fmtQty`, green-up/red-down
  `SignedText`, and the P/E "n/a" vs "-" distinction are a mature, coherent asset.
- Watchlist (`watchlist/page.tsx:185-223`) is the reference implementation for
  loading-vs-empty-vs-error + toast — pattern the `return null` pages after it.
- Accessibility foundations are above-average: `role="switch"`+`aria-checked`,
  `aria-live` toasts, visible focus outline, `useDirtyGuard` for unsaved forms.

---

## Suggested sequencing

1. **Perf #1 (snapshot TTL cache)** — collapses per-poll + multi-tab + mobile recompute
   in one stroke; also neutralizes #10, #11.
2. **Perf #2 (compute P&L once)** + **#3 (Promise.all macro)** — independent, low-risk.
3. **UI #1 (nav labels)** + **UI #5 (settings order)** — both High/S, ship together.
4. **UI #2 (first-run checklist)** + **UI #3/#4 (approval card disclosure + de-jargon)**
   — the biggest comprehension wins.
5. **Perf #4 (parallel debates)**, **#5 (virtualize scan)**, **#6 (scan cache)**.
6. **Perf #7/#8 (memo boundaries)**, then Med/Low cleanups + dead `motion` dep removal.

## Quick wins (small effort, real payoff)
- `Promise.all` the macro fetches (Perf #3).
- Virtualize the scan table with the already-present `react-virtuoso` (Perf #5).
- Remove the dead `motion` dependency (0 imports in `app`/`src`).
- Reconcile nav labels ↔ headings (UI #1).
- Reorder Settings for unconfigured users (UI #5).
- Add `AbortController` to the focus/interval fetches in `nav.tsx`, `watchlist/page.tsx`,
  `assistant/chat.tsx`.
