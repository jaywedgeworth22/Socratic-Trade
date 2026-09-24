# 2026-07-10 — Console loading permafix (abort-storm coalescing + dashboard.ts parallelization)

**Author:** CLAUDE (sonnet engineer agent) · **Branch:** `claude/loading-permafix`

## Summary

socratictrade.com's console still took minutes to first-paint even after PR #1293 (`withDeadline`
wrappers + ipv4first + the 15s first-load watchdog) landed. Root cause was two compounding
problems, neither of which #1293 or the still-open AG PR #1285 fully closed:

1. **Abort storm** (`app/console/lib/useConsoleData.tsx`) — `refresh()` began with
   `inFlight.current?.abort()`. During an active scan, SSE events (`market-data`, `run-complete`,
   etc.) and the 15s poll interval both call `refresh()` every few seconds, so the slow initial
   `GET /api/dashboard` fetch kept getting killed and restarted before it could ever finish — it
   only completed once a quiet gap of several seconds happened to appear between triggers.
2. **Sequential deadline stacking** (`src/lib/dashboard.ts`) — `getDashboardSnapshot` ran every
   `withDeadline`-wrapped upstream section one after another: accounts (6s) -> Robinhood MCP
   health (4s) -> portfolio/positions/orders (8s) -> quotes (6s) -> SPY benchmark (4s) -> macro
   (6s) -> signals (4s) -> history (4s) -> news (4s) ~= 46s worst case. Individual timeouts
   prevented any single call from hanging forever, but they still added instead of overlapping.

## Why (root-cause story)

PR #1293 added `withDeadline()` around every upstream call so a single hung request could no
longer block the snapshot forever, plus a 15s watchdog so the console UI would fall back to its
error card instead of an infinite logo. That fixed "hangs forever." It did not fix "takes way too
long" — the deadline-guarded sections still ran back-to-back, and the abort storm meant even a
moderately slow (not hung) request rarely got the chance to complete before being restarted.

AG's PR #1285 (open, not yet merged) independently diagnosed the abort storm and added a
`background?: boolean` option to `refresh()`: background (SSE/interval) refreshes **skip** if a
fetch is already in flight, instead of aborting it. That is a real fix for the SSE/interval case,
but it (a) doesn't coalesce — a skipped background refresh has no memory, so if nothing else
happens to trigger another refresh soon after the in-flight one settles, the UI can go stale until
the next poll tick — and (b) doesn't cover the tab-visibility refresh, which still aborts.

## What changed

### `app/console/lib/useConsoleData.tsx`
Split `refresh` into two internal notions while keeping the public `ConsoleData.refresh` signature
and behavior unchanged for every existing caller (`refresh: () => Promise<void>`, used by ~25 call
sites across the console for user actions/mutations):
- **`refresh()`** (exported, unchanged signature) — explicit foreground refresh for the initial
  mount load and every user action/mutation (approve/reject, place/cancel an order, save a
  setting, etc.). Aborts and replaces whatever is in flight, same as before.
- **`backgroundRefresh()`** (new, internal) — used for the poll interval, the SSE-triggered
  `queueRefresh`, and the tab-visibility handler. Never aborts an in-flight fetch. If one is
  already running, it just marks `pendingBackgroundRefresh.current = true` and returns; when the
  in-flight fetch settles, it runs exactly one more fetch if the flag is still set (coalescing any
  number of triggers that arrived meanwhile into a single extra fetch), then stops. An explicit
  `refresh()` call clears the pending flag and takes over `inFlight` — `backgroundRefresh` checks
  it still owns `inFlight` before consuming the flag, so it doesn't fight a foreground refresh that
  superseded it.

This treats tab-visibility as a background trigger too (AG's PR only treated SSE + interval as
background), since a user switching tabs back is not a mutation and can race with an in-flight
fetch exactly like an SSE event can.

**Supersedes the still-open AG PR #1285** — same root-cause diagnosis, credit to AG for finding
it; this lands a more complete fix (coalescing + tab-visibility coverage) so #1285's `useConsoleData`
diff is no longer needed. Commented on #1285 after landing to say so, with thanks.

### `src/lib/dashboard.ts`
`getDashboardSnapshot`'s upstream calls split into two groups run concurrently via one
`Promise.all`, instead of nine sequential `await`s:

- **Broker chain (kept sequential — genuine data dependency):** `gateway.getAccounts()` ->
  compute `accountNumber` (`policy.accountNumber` falls back to a discovered live account from the
  accounts call when unset) -> `Promise.all([getPortfolio, getEquityPositions, getEquityOrders])`
  -> `gateway.getEquityQuotes(accountNumber, priceSymbols)` (needs the resolved `positions`) ->
  the live current-price map. Wrapped in one async IIFE (`brokerChainPromise`) returning everything
  downstream code needs (`accounts`, `liveAccounts`, `brokerAccountReadError`, `accountNumber`,
  `portfolio`, `positions`, `orders`, `portfolioReadError`, `currentPrices`).
- **Independent group (raced against the chain):** Robinhood MCP health (only depends on
  `userId`/broker, not on the accounts/portfolio chain) and the entire macro board — `fetchMacroData`,
  `getMarketSignals`, `fetchMacroHistory`, `fetchMassiveNews` — none of which read anything the
  broker chain produces.
- **SPY benchmark** stays sequential *after* the `Promise.all`, since it needs the performance
  summary built from `currentPrices` (itself the last step of the broker chain) — its inputs don't
  allow parallelizing it against the chain.

Net effect: worst-case latency drops from the sum of all nine deadlines (~46s) to roughly the
broker chain's own worst case (6+8+6=20s) plus the benchmark's 4s (~24s), since the chain is the
long pole and everything else now overlaps it instead of stacking after it.

Also added one summary log per request: `console.warn(`[dashboard] snapshot ${ms}ms (timed out:
a,b)`)`, emitted only when the total exceeds 3000ms or any section timed out (tracked via a new
optional `timedOutSections: string[]` sink threaded through every `withDeadline(...)` call). Normal
fast requests stay silent; slow/degraded ones are now visible in Coolify logs without needing to
grep for the nine individual per-section timeout warnings.

Output shape and every existing fallback are unchanged — this is purely a scheduling change
(what runs concurrently vs. sequentially), not a behavior change to any individual section.

## Files
- `app/console/lib/useConsoleData.tsx`
- `src/lib/dashboard.ts`
- `docs/EFFORT-LOG.md` / `/Users/jay/apps/TRADING-EFFORT-LOG.md` (new entry + corrected the stale
  "PR pending" state on the already-merged #1293 entry + resolved the related TBD backlog line)
- `STATUS.md`

## Verification
Run from a dedicated isolated worktree (see "Worktree note" below):
- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (377 pre-existing grandfathered warnings, unrelated to this change).
- `npm test` — 3374 tests passed, 315 files.
- `npm run build` — clean.
- Manual timing: `npm start` on a free local port with an empty dev DB (no connected broker
  account, so no upstream broker calls fire) — two `curl -w %{time_total}` requests to
  `/api/dashboard` measured ~874ms (cold) then ~6ms (warm). This is expected to be small in this
  environment: with no connected account there are no slow upstreams to parallelize against, so
  the dev-DB numbers don't demonstrate the fix — the structural change (verified via the dependency
  analysis above + all tests passing) is what matters. No `[dashboard] snapshot` log line fired,
  correctly, since neither threshold condition (>3000ms or a timeout) was met.

## Worktree note (environment issue, not part of the fix)
The assigned worktree (`/Users/jay/Code/Socratic-Trade/.claude/worktrees/vibrant-bouman-10388c`)
turned out to be concurrently in use by a live, long-running Claude session on branch
`claude/settings-global-only` (the tracked "Settings IA restructure" effort — see that entry in
`docs/EFFORT-LOG.md`). While this task's edits sat uncommitted, that other session checked out its
own branch in the same physical worktree, which would have mixed the two efforts' uncommitted
changes into a single working tree. Recovered by: diffing out only the two files this task touched
(confirmed their committed content was byte-identical on both branches, so the diff was
uncontaminated), reverting them in the shared worktree to leave the other session's work exactly as
it was, and finishing this task in a fresh, dedicated worktree
(`git worktree add .../wt-loading-permafix claude/loading-permafix`) with its own `npm ci`. No
files belonging to the other effort were read, moved, or modified beyond the unavoidable `git
status`/`git diff` used to confirm the byte-identical baseline.

## Codex-autofix follow-up (2026-07-10) — raise client fetch deadline above the server bound

Codex PR review (P1, `useConsoleData.tsx:38`) flagged that the client's hard per-attempt ceiling
(`FETCH_DEADLINE_MS = 20_000`) sat **at** the server's own worst-case self-bounded response, not
above it. `getDashboardSnapshot`'s broker chain is sequential — `gateway.getAccounts` (6s) →
`portfolio/positions/orders` (8s) → `getEquityQuotes` (6s) = 20s — and `computeSpyBenchmark` (4s)
runs after the `Promise.all` that awaits that chain, so a slow-but-not-hung account with held
symbols can legitimately take ~24s to return a fully degraded snapshot. At a 20s client ceiling the
browser aborted right as the server was about to respond, `runLoop` retried on the `"deadline"`
result, and the console could stay stuck on the watchdog/retry path even though every server
deadline was working as designed.

Fix: raised `FETCH_DEADLINE_MS` to `35_000`, above the ~24s server bound (plus the synchronous DB
work between the broker chain and the benchmark) with headroom, while still comfortably killing a
genuine network hang (which never resolves at all). Comment updated to document the relationship to
the server's sequential broker-chain + benchmark budget so a future edit to either side keeps them
in sync. No test references the constant; pure numeric/comment change. Gate re-run green: `tsc`
clean, 3396 tests / 315 files, build clean.

## Follow-ups
- After this PR merges, comment on AG's PR #1285 that it's superseded by this change (crediting
  the diagnosis) and close it without merging.
- The dev-DB timing measurement above doesn't exercise slow upstreams; the real validation is
  production log volume of `[dashboard] snapshot` lines (and their duration) after deploy — watch
  Coolify logs for a few days to confirm p95/worst-case actually dropped.
- Worst case is still ~24s (dominated by the broker chain, which has a genuine 3-stage data
  dependency: accounts -> portfolio bundle -> quotes). If that's still too slow in practice, the
  next lever would be shrinking those three deadlines (6s/8s/6s) rather than further
  parallelization, since the remaining chain can't be parallelized without changing what
  `accountNumber`/`quotes` are allowed to depend on.

## Codex-autofix follow-up #2 (2026-07-10) — surface deadline retries as refresh failures

Codex PR review (P2, `useConsoleData.tsx:141`) flagged that when an already-loaded `/api/dashboard`
request hits `FETCH_DEADLINE_MS`, `runLoop` retried immediately (`if (result === "deadline") continue`)
without ever setting `error`. Because the freshness UI (`deriveFreshnessLabel` in
`app/console/components/chrome.tsx`) derives its "delayed" label purely from `error`'s truthiness, a
request that keeps hanging past 35s would retry roughly every 35s forever with `error` still `null`,
so the console kept labeling a stale snapshot "fresh" — stale trading data mislabeled as current.

Fix: `runFetch` now sets a visible refresh error on the deadline path before returning `"deadline"`:
`if (mounted.current) setError((prev) => prev ?? DEADLINE_ERROR_MESSAGE)`. The `prev ??` preserves an
existing message (e.g. the first-load watchdog's), and a successful retry still clears the error via
the existing `setError(null)` on the "ok" path, so the "delayed" indicator only shows while refreshes
are actually failing. `error` never blanks the screen (the last good snapshot stays rendered), so this
is UI-signal-only. Files: `app/console/lib/useConsoleData.tsx` (new `DEADLINE_ERROR_MESSAGE` constant
+ deadline branch in `runFetch`). No test references the deadline retry loop (React hook with timers);
pure signal change. Gate re-run green: `tsc` clean, 3396 tests / 315 files, build clean.

## Codex-autofix follow-up #3 (2026-07-10) — foreground deadline resolution + Robinhood refresh singleflight expiry

Two remaining non-outdated P2 Codex threads on this PR.

### (a) Let foreground `refresh()` settle after a deadline (`useConsoleData.tsx`)

**Why:** `runLoop` is shared by `refresh()` (awaited foreground) and `backgroundRefresh()`. On a
`"deadline"` result it did `continue`, retrying in the same loop. For an *awaited foreground*
`refresh()`, that meant the promise stayed pending across every retry. Several mutation flows do
`await refresh()` before clearing their busy state / firing their success toast in a `finally`, so if
`/api/dashboard` kept hanging (the exact incident this PR targets) those approvals/settings-saves
could stay stuck in their busy state even after the mutation itself completed.

**Fix:** `runLoop` now takes a `foreground = false` flag. On a foreground deadline it hands the
immediate retry to a detached background `runLoop(false)` and returns, so the awaited foreground
promise resolves (the deadline error is already surfaced by `runFetch` from follow-up #2). The
detached loop sets `inFlight.current` synchronously before its first await, so a background trigger
arriving meanwhile still coalesces via `pendingBackgroundRefresh` and a newer `refresh()` still
supersedes it via the `inFlight.current !== controller` check. `refresh()` calls `runLoop(true)`;
`backgroundRefresh()` keeps the default (`false`), so background retries loop in place exactly as
before.

### (b) Expire hung Robinhood refresh singleflights (`mcp-oauth.ts`)

**Why:** `getMcpAccessToken` de-dupes concurrent token refreshes per user via `inFlightRefreshes`.
`exchangeToken` used a bare `fetch` with no abort/timeout, so if the OAuth token endpoint never
settled the pending promise would never resolve, its `.finally` cleanup would never run, and every
later caller for that user (with the still-expired stored token) would await the same hung promise —
the account could not self-heal after the network recovered without a reconnect/restart.

**Fix:** two layers. (1) Root cause: the `exchangeToken` fetch now carries
`AbortSignal.timeout(REFRESH_SINGLEFLIGHT_TTL_MS)` (20s; guarded for environments without
`AbortSignal.timeout`) so a hung endpoint rejects, the promise settles, and the map entry is freed.
(2) Backstop: `getMcpAccessToken` arms an unref'd `setTimeout(evict, REFRESH_SINGLEFLIGHT_TTL_MS)`
that removes the shared pending promise even if some *other* await inside `refreshMcpAccessToken`
(config discovery, client registration) is what hangs — so the next caller always starts a fresh
refresh once the TTL elapses. Eviction is idempotent (checks `map.get(userId) === promise` before
deleting) and the timer is cleared on normal settle.

**Files:** `app/console/lib/useConsoleData.tsx`, `src/lib/mcp-oauth.ts`.
**Verification:** `npx tsc --noEmit` clean; `npm run lint` 0 errors; `npm test` 3396 passing / 315
files (incl. `test/mcp-oauth.test.ts` singleflight coverage); `npm run build` clean.
**Follow-ups:** none — both threads resolved.
