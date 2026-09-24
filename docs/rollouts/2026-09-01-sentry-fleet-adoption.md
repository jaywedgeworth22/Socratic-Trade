# 2026-09-01 — Sentry fleet adoption remainder (GROK, `grok/sentry-fleet-adoption`)

## Context & Objective

AG already merged PR #3146: `enableLogs`, Replay defaults 0.01 session / 1.0 on error,
`tracesSampleRate` 0.2, dropped `automaticVercelMonitors`, `tracePropagationTargets`
already include congress.trade and usage.jays.services.  This unit finishes the remaining
Socratic-Trade items from `sentry-fleet-adoption-report-2026-09-01.md`.

Board: `d64e1bebd8be4789bfe7671bcf01699f`.

## Changes Made

- **Browser tunnel.**  `next.config.mjs` `tunnelRoute: "/monitoring"`.  `middleware.ts`
  matcher excludes `monitoring`; `/monitoring` is also a public prefix so auth cannot 401
  the rewrite.
- **iOS DSN + Replay + release health.**  `SentryTelemetry.swift` reads `SENTRY_DSN` from
  Info.plist only.  Missing, empty, or unsubstituted `$(SENTRY_DSN)` skips init.  Cocoa
  Session Replay at 1% session / 100% on error with `maskAllText` / `maskAllImages`;
  `attachScreenshot` stays false.  `releaseName` / `dist` from
  `CFBundleShortVersionString` / `CFBundleVersion`.  `ios/project.yml` + Info.plist carry
  `SENTRY_DSN: $(SENTRY_DSN)` (empty unless xcodebuild/CI injects it).
- **Server continuous profiling.**  `@sentry/profiling-node` `nodeProfilingIntegration`
  on `sentry.server.config.ts` only, `profileLifecycle: "trace"`,
  `profileSessionSampleRate` default 1 (override via `SENTRY_PROFILE_SESSION_SAMPLE_RATE`).
  Native-addon load is try/catch so a missing binary cannot take down Sentry.init.  No
  browser UI profiling.
- **Sparse structured logs.**  Converted 10 health `console.warn`/`console.error` paths to
  `Sentry.logger.warn`/`error` via `src/lib/sentry-metrics.ts`: scheduler tick error /
  overrun / cron check-in, RAG embed batch / query embed / malformed query embedding,
  disclosure-rag embed, search-fusion MMR embed, Kalshi broker call, Alpaca MCP fallback,
  placing-sweep broker unreachable.  Datadog remains the log warehouse; this is not an
  access-log firehose.
- **Application Metrics.**  Existing `src/lib/sentry-metrics.ts` now dynamic-imports the
  SDK (scheduler inertness) and is wired into those real paths:
  `scheduler.tick` / `scheduler.overrun`, `rag.rejected`, `embed.failed`, `broker.call`.
- **AI / LLM observability.**  Official `@sentry/nextjs` OpenAI / Anthropic / Google /
  Vercel AI / LangChain integrations stay registered.  Fetch-based OpenRouter / Voyage
  embed / earningscalls HTTP is wrapped in `gen_ai.*` spans (`src/lib/sentry-gen-ai.ts`);
  Pinecone query is a `db` span.  Token counts attach to the active span from
  `recordLlmUsage`.  Prompt/message contents are never recorded.
- **Replay stays opt-in in code.**  `NEXT_PUBLIC_SENTRY_REPLAY_ENABLED` must be the
  string `"true"` (or 1/on/yes).  Coolify must set it at **build time**.

### Touched Files

- `next.config.mjs`
- `middleware.ts`
- `sentry.server.config.ts`
- `package.json` / `package-lock.json` (`@sentry/profiling-node`)
- `src/lib/sentry-metrics.ts`
- `src/lib/sentry-gen-ai.ts`
- `src/lib/llm-request.ts`
- `src/lib/llm-usage.ts`
- `src/lib/scheduler.ts`
- `src/lib/vector-db.ts`
- `src/lib/web-sources/disclosure-rag.ts`
- `src/lib/web-sources/index.ts`
- `src/lib/rag/search-fusion.ts`
- `src/lib/kalshi-broker.ts`
- `src/lib/alpaca.ts`
- `src/lib/strategy-execution.ts`
- `src/lib/earningscalls-transcripts.ts`
- `ios/SocraticTrade/SentryTelemetry.swift`
- `ios/SocraticTrade/Info.plist`
- `ios/project.yml`
- `test/sentry-metrics.test.ts`
- `test/sentry-gen-ai.test.ts`
- `test/sentry-tunnel-middleware.test.ts`
- `docs/ops-observability-security.md`
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `docs/rollouts/2026-09-01-sentry-fleet-adoption.md`

## Decisions & Trade-offs

- **No hardcoded iOS DSN.**  The previous Swift fallback is gone.  Until TestFlight
  ship injects `SENTRY_DSN`, Cocoa init is a no-op.  That is intentional.
- **Replay not defaulted on.**  Financial UI.  Coolify build-time flag is required.
- **Profiling Node-only.**  UI profiling stays off on the trading console.
- **gen_ai spans via fetch wrap, not a new OpenAI SDK client.**  Call sites already
  speak OpenRouter over `llmFetch`.  Official SDK integrations remain registered for
  any future SDK path.

## Verification State

- `npx tsc --noEmit` — clean
- `npx vitest run test/sentry-inert.test.ts test/sentry-metrics.test.ts test/sentry-gen-ai.test.ts test/sentry-tunnel-middleware.test.ts` — 23/23 passed
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH bash scripts/land.sh` — tsc + full vitest + next build, then PR

## Next Steps & Blockers

- Coolify: set `NEXT_PUBLIC_SENTRY_REPLAY_ENABLED=true` (build-time) if web Replay
  should actually emit.  Not done in this PR.
- iOS ship: pass `SENTRY_DSN` as an xcodebuild build setting.  Not done in this PR.
- Confirm Sentry UI shows logs, a profile, a `gen_ai.*` span, and (after Coolify flag)
  a Replay after the next production deploy.
