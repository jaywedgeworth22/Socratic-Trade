# Rollout: Issue #3222 — LLM Observability & Red Team Failover Resilience

## Context & Objective
Resolves issue #3222 by eliminating duplicate billable provider calls on LLM execution errors in Datadog LLM Observability, guaranteeing Red Team fallback model chains continue past HTML/non-JSON HTTP 200 responses, tagging HTTP provider errors across Datadog and Sentry GenAI spans, and capturing token usage directly before span finalization.

## Changes Made
- **`src/lib/datadog-llmobs.ts`**:
  - Decoupled `llmobs.wrap` tracer setup from wrapper execution. If `fn()` rejects during execution, it throws directly to callers rather than falling back to uninstrumented retries that double-bill providers on timeouts, rate limits, and 500 errors.
  - Added `moonshot.cn` and `api.moonshot.cn` to `LLM_HOST_HINTS`.
  - Added HTTP status annotation and error tagging to spans when responses are non-2xx.
- **`src/lib/sentry-gen-ai.ts`**:
  - Annotated span status with error codes and `HTTP <status>` messages on non-ok responses.
  - Intercepted `response.json()` inside `withGenAiSpan` so `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` are populated on the active span prior to resolution.
  - Extended `setGenAiUsageOnActiveSpan` to fall back to the most recent GenAI span within a 30-second window if `getActiveSpan()` has already concluded.
- **`src/lib/red-team.ts`**:
  - Wrapped `await response.json()` in safe try/catch block to prevent unhandled `SyntaxError` from terminating the fallback reviewer sequence when proxies or upstream endpoints return HTML error pages with HTTP 200.
  - Added `err instanceof SyntaxError` to retryable error classification in the attempt loop.
- **`instrumentation.ts`**:
  - Used dynamic module path resolution for `@sentry/profiling-node` to avoid Next.js compile errors in environments without prebuilt native binaries.
- **`test/red-team-empty-failover.test.ts`**:
  - Added unit tests for HTML proxy response failover and chain exhaustion.

### Touched Files
- `src/lib/datadog-llmobs.ts`
- `src/lib/sentry-gen-ai.ts`
- `src/lib/red-team.ts`
- `instrumentation.ts`
- `test/red-team-empty-failover.test.ts`
- `docs/EFFORT-LOG.md`
- `STATUS.md`

## Decisions & Trade-offs
- **Decoupled Tracer Setup vs Invocation**: `withDatadogLlmObs` previously caught errors during `await wrapped()` and retried `return fn()`. Because `wrapped()` runs the actual LLM network request, any downstream rejection (network partition, rate limit, provider 500) caused an immediate second call. Setup is now isolated in try/catch; invocation is un-caught within the wrapper.
- **`response.json()` Interception**: In Next.js/Node fetch, the promise returned by `fetch` resolves as soon as HTTP headers are received. If token usage is recorded during body parsing, Sentry spans that close on fetch completion lose token metrics. Intercepting `response.json()` guarantees token attributes attach before the body stream finishes and span closes.

## Verification State
- `npm run lint` -> Passed (0 errors, 816 warnings grandfathered).
- `npx tsc --noEmit` -> Passed cleanly (0 errors).
- `npx vitest run test/datadog-llmobs.test.ts test/sentry-gen-ai.test.ts test/red-team-empty-failover.test.ts` -> Passed (3 test files, 16 tests passed).

## Next Steps & Blockers
- Commit and push `ag/issue-3222-llm-observability-resilience`, open PR, and arm auto-merge.
- Resolve dirty merge state on PR #3282 (issue #3221).
- Move to Issue #3223 (Qdrant write spend fuses, cosine metric assertions, and SEC FTS tokenization offloading).
