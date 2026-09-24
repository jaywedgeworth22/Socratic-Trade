# 2026-09-12 Full-Stack Codebase Audit & System Diagnostics

## 1. Context & Objective
Executed a top-to-bottom architectural and vulnerability review of Socratic-Trade across all four major system domains: (1) Trading Engine, Scheduler, & Database Persistence; (2) Next.js API Routes, Auth, & Secrets Management; (3) AI Strategy Engine, Multi-Model LLM Orchestration, RAG Retrieval, & Telemetry; and (4) Web Console UI & iOS SwiftUI Client.  The objective was to identify latent critical bugs, event-loop starvation drivers, security vulnerabilities, and high-value system improvements, triaging them into actionable GitHub issues and the central effort log.

## 2. Changes Made & Logged Issues
No production application code was mutated in this diagnostic pass; all findings were triaged and logged into GitHub issues and the shared effort ledger:
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (live board updated with audit completion and 8 planned remediation units)
- `docs/EFFORT-LOG.md` (repo mirror updated)
- `docs/rollouts/2026-09-12-codebase-full-audit.md` (this audit record)
- Created 8 dedicated GitHub issues:
  - **Issue #3220:** `fix(broker): Tradier bracket entry dropped from order listing, missing ordersListIncludesTerminal, and HTTP 200 rejection misclassification`
  - **Issue #3221:** `perf(scheduler): Main-thread event loop stalls from synchronous api_health_log pruning and watchdog re-entrancy race`
  - **Issue #3222:** `fix(ai): Datadog LLMObs duplicate LLM calls on error, Red Team failover abort on non-JSON 200, and telemetry error masking`
  - **Issue #3223:** `enhancement(rag): Ingestion spend fuses for Qdrant vector backend, distance metric assertions, and FTS indexing worker`
  - **Issue #3224:** `sec(api): Sanitize callbackUrl open redirect, rate-limit public mobile auth and money-path routes, and guard JSON parsing`
  - **Issue #3225:** `fix(console): Duplicate strategy runs from dual RunOnceButton event listeners, deadline retry spin loop, and unhandled 401s`
  - **Issue #3226:** `fix(ios): Resilient lossy array decoding in MobileSnapshot, dynamic Sentry environment tagging, and OAuth error visibility`
  - **Issue #3227:** `chore(db): Implement retention pruning for portfolio_snapshots, add missing compound indexes, and automated B2 restore drill`

## 3. Decisions & Trade-offs
- **Domain-Grouped GitHub Issues:** Rather than generating 40+ granular micro-issues, findings were grouped into 8 cohesive, subsystem-specific issues with exact file line references, reproduction mechanics, and concrete remediation steps.  This preserves context and prevents issue tracker noise.
- **De-escalated False Positives:** We investigated potential race conditions in broker status polling and verified that the existing `reconcilePendingFills` ledger properly enforces state transitions, with the sole exception of the missing Tradier entry leg (#3220).

## 4. Verification State
- `AGENT_TAG=AG /usr/bin/python3 /Users/jay/apps/agent-sync-poll.py`: Clean pass (27 messages skimmed, 0 unaddressed fleet directives).
- `npx vitest run test/admin-gate.test.ts`: Passed (17/17 tests passing).
- `npm run lint`: Passed (0 errors, 809 grandfathered warnings).
- `git status`: Clean worktree in designated agent lane `~/apps/trading-antigravity`.

## 5. Next Steps & Actionable Roadmap
The next agent(s) can immediately pick up any of the planned units according to priority:
1. **P0 Money Path (Issue #3220):** Implement Tradier entry order retention in `equityRowsFromTradierOrder` and set `ordersListIncludesTerminal = true` on `TradierBrokerGateway`.
2. **P0 Event Loop Stability (Issue #3221):** Decouple `logApiHealth` insertion from synchronous FIFO subquery deletion to prevent SQLite write lock contention from stalling the main V8 thread.
3. **P0 Token & Cost Protection (Issue #3222 & Issue #3225):** Fix `withDatadogLlmObs` duplicate invocation in `src/lib/datadog-llmobs.ts` and consolidate `RunOnceButton` window event listeners in `app/console/components/shell.tsx`.
4. **P1 Security Hardening (Issue #3224):** Sanitize `callbackUrl` against `//` protocol-relative targets in `app/login/page.tsx` and rate-limit public mobile auth endpoints.
5. **P1 Client Resilience (Issue #3226):** Implement lossy array decoding in iOS `MobileModels.swift` to prevent malformed collection items from locking out mobile users.

## 6. Zero-Code Findings Summary
- **Broker Integrations:** Tradier bracket orders lose their entry leg during row mapping (`src/lib/tradier.ts:1156`), causing valid fills to be misclassified as absent orders.  Tradier HTTP 200 rejection envelopes bypass `isTerminalBrokerHttpError` regexes.
- **Scheduler & Persistence:** Synchronous SQLite deletions in `logApiHealth` on every outbound API call are the primary driver of main-thread event loop freezes.  `portfolio_snapshots` table grows unbounded with no pruning policy.
- **AI & RAG:** `withDatadogLlmObs` executes underlying LLM calls twice on failure because `await wrapped()` rejects inside the setup try block and invokes `return fn()` in catch.  Red Team reviewer failover aborts on non-JSON HTTP 200 responses.
- **UI & Clients:** Desktop and mobile `RunOnceButton` instances mounted simultaneously register duplicate event listeners and fire parallel `POST /api/strategy/run-once` calls on shortcut `R`.  iOS `MobileSnapshot` uses non-lossy collection decoding, locking out mobile users if a single order or position fails decoding.
