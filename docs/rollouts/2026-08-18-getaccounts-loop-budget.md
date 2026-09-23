# 2026-08-18 — getAccounts 6s abort vs live p95 + ftsMirrorSlice loop pin

## Context & Objective

ASC discarded the hung-sidecar / MCP hypothesis.  There is no Alpaca sidecar.  The gateway is in-process on `socratic-app` (live `581467e1`, pid 2701530, started 4:12pm CT).  Paper / Roth are REST `alpaca`, not `alpaca-mcp`.

Trading Ops receipts, same process:

- Exact log, 11 times since 4:12pm CT: `gateway.getAccounts timed out after 6000ms — serving degraded snapshot` then `Failed to fetch accounts… 6000ms.`
- Same window also aborted portfolio/positions/orders at 8s and `getEquityQuotes` at 6s.
- alpaca-broker 500/500 ok, 0 failures, min 97ms / avg ~3085ms / max 14416ms, 191/500 ≥6000ms.
- Latest ~4:40pm CT 98–413ms ok; ~30s earlier several ok at 6570–6600ms.  The SDK finished AFTER the 6s abort.
- Event loop loaded (`ftsMirrorSlice` 6–12s).  `/api/health` 200 but ~4.2s.

That is a race: 6s (and 8s) `withDeadline` aborts vs a slow in-process loop.  The promise is not cancelled; alpaca-broker still logs ok after the UI has already degraded.

After #2847 (`4abfb7fa`) the request lock was gone: Roth Manual Run once wrote `b3b83913` at 23:13:25Z.  That run sat ~17m with llm=0 and never reached Green.  Live crumbs on the same process:

- `roic-transcript-refresh` in-flight since 23:11:45Z (before the click), RJF 2024Q2→2022Q4
- embed over-limit 8193 tokens (do not reopen #2840); last embed 23:29:11Z, Pinecone upsert 23:29:26Z 22/22
- FTS: 78 `ftsMirrorSlice` since the run, 6–13s each
- Broker: `getEquityQuotes` 6s ×28; alpaca-broker 6.5–7.4s; tradier 6.2–13s

Bounding the FTS tick is not enough if ROIC refresh still owns the loop for the whole run.

## Changes Made

Investigated first (ops snapshot `asOf` 2026-08-18T22:31:35Z + ASC + code):

- Paper `PA33IDTHMFK9` and Roth `294709855` are `broker: alpaca`.
- `accountReadinessForSnapshot` fail-closes Manual Run once on `brokerAccountReadError` **or** `portfolioReadError`.
- Recoverable issues still show `dashboard.getAccounts · … after 6000ms` through 22:03:01Z.  After #2845 (`d4299bec`), portfolio still timed out at 22:10:15Z (`after 8000+7000ms`).  The 15s combined retry is still tighter than live max 14s plus a 6–12s FTS pin.
- `FTS_MIRROR_TICK_BUDGET_MS` was 6000 — the same number as the getAccounts first abort.  The planner used `Math.max(1, floor(remaining/msPerChunk))`, so 1ms remaining still started a chunk.  `insertDocumentChunkFtsBatch` started at an 8-row group; the 250ms stretch only adapts **after** that group finishes.  That is the 6–12s `ftsMirrorSlice` pin.

Fix:

- First wait 16s (above live max 14416ms) on dashboard getAccounts, portfolio bundle, Alpaca `getAccount`, `getEquityQuotes`, and option positions.  Retry remains for a hung pending getAccounts/portfolio call.  Credential / 401 throws still fail immediately.  Timeout strings stay honest (`16000+8000ms`).
- FTS tick budget 2s, max 6 chunks, inner group 1.  Batch helper starts at 1 row.  Planner returns 0 chunks when remaining budget is below expected ms/chunk.
- Do not start `roic-transcript-refresh` or claim SEC ingest / FTS work while any `strategy_runs` row is `running` or any `strategy_run_requests` row is `queued`/`running`.  An in-flight ROIC walk yields between symbols/periods and pauses (cursor kept) when a run starts.  This is process-wide so one user's Manual Run once is not starved by another user's background RAG.
- Rebased onto `origin/main` `4abfb7fa` (#2847).

- `src/lib/inflight-deadline.ts`
- `src/lib/dashboard.ts`
- `src/lib/alpaca.ts`
- `src/lib/rag/fts-mirror-bound.ts`
- `src/lib/db-learning.ts`
- `src/lib/db-execution.ts`
- `src/lib/web-sources/roic-transcripts.ts`
- `src/lib/scheduler.ts`
- `src/lib/rag/sec-ingest-worker.ts`
- `test/inflight-deadline.test.ts`
- `test/alpaca-mcp.test.ts`
- `test/stale-running-runs.test.ts`
- `test/sec-ingest-worker.test.ts`
- `test/roic-transcripts.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-08-18-getaccounts-loop-budget.md`

## Decisions & Trade-offs

- Did not invent a sidecar or bounce Coolify.
- Did not hide the failure with copy.  Run once still fail-closes if the combined budget expires or the broker throws.
- Did not touch strategy pick / #2841 / #2840 / #2812.  Did not reopen the embed-pack / 8193 HOLD.
- Did not hide the embed "OpenRouter embed connection failed" / 8193 error with copy.
- Did not rewrite other long scheduler lanes (`synthetic-stop-monitor` avg 7.2s, `stale-limit-scan` avg 5.9s).
- FTS ingest will take more ticks (6 vs 20 chunks) and ROIC walks will pause mid-universe when a run starts.  That is the cost of letting Green start.
- The getAccount retry test mocks a short first-call budget.  Live `ALPACA_ACCOUNT_READ_FIRST_MS` stays 16s.  Fake-timer + 16s + a never-settling first promise hung verify-hosted 60s.
- Stale-run sweep compares `started_at` to process boot.  Same-process 30m stall (Roth `b3b83913`, `processStartedAt` 23:10:43Z) is `stalled_no_progress`, not "Process restarted mid-run".

## Verification State

verify-hosted: 7010 passed, 1 failed at `test/alpaca-mcp.test.ts:214` (60s).  That test now mocks a short `alpacaAccountReadBudgetMs` and uses real timers.  The test is kept.

Local on `f6bf7b86`:

```bash
npx vitest run test/alpaca-mcp.test.ts test/inflight-deadline.test.ts test/stale-running-runs.test.ts
# 3 files, 30 passed, 4.36s
npx vitest run test/alpaca-mcp.test.ts -t "retries getAccount"
# 1 passed, 2.83s (no 60s hang)
npx vitest run test/sec-ingest-worker.test.ts test/roic-transcripts.test.ts test/dashboard-agentic-fallback.test.ts
# 51 passed
npx tsc --noEmit   # exit 0
```

PR: https://github.com/jaywedgeworth22/Socratic-Trade/pull/2848

## Next Steps & Blockers

- Do not merge or deploy from this seat.
- After merge, confirm a Manual Run once can reach Green while a ROIC walk is mid-universe, and that `ftsMirrorSlice` does not claim during that run.

## Zero-Code Findings

#2845's retry is live (portfolio message format `8000+7000ms` at 22:10:15Z) and still lost.  After #2847, the leftover request lock is gone (`b3b83913` wrote) but Green still waited behind ROIC + FTS on the same event loop.
