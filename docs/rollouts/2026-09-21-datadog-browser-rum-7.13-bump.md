# 2026-09-21 — Codex-autofix for the @datadog/browser-rum 7.9.0 → 7.13.0 bump (PR #3446)

## Context & Objective

Dependabot bumped `@datadog/browser-rum` from `^7.9.0` to `^7.13.0` (PR #3446, branch
`dependabot/npm_and_yarn/datadog/browser-rum-7.13.0`, commit `4d293a14ba`).  The commit touched only
`package.json` and `package-lock.json`.

Codex review (P1, thread on `package.json:39`) flagged that the commit omits the repo's mandatory
handoff records — `STATUS.md`, the effort log, a `docs/rollouts/` note, and the `PLAN.md` entry — so
the dependency change would be invisible to subsequent agents and to the owner, and its commit
message could not reference the required documentation (AGENTS.md L37–L61, the Pre-Commit / Handoff
Protocol).  This codex-autofix round adds those records so PR #3446 clears the review gate.

## Changes Made

- `STATUS.md` — dated snapshot entry for the bump and this round.
- `docs/EFFORT-LOG.md` — `[codex-autofix]` row (runtime dependency-only; in progress).
- `PLAN.md` — scope note (no roadmap change; runtime dependency-only) per the handoff protocol.
- `docs/rollouts/2026-09-21-datadog-browser-rum-7.13-bump.md` — this note.
- `package.json` / `package-lock.json` — the Dependabot commit `4d293a14ba` itself (authored by
  Dependabot, untouched by this lane apart from the doc additions above).

No production source file changed in this round.  `src/lib/datadog-rum.ts` was read and left as-is;
see Decisions below.

## Decisions & Trade-offs

- **Classified as runtime, not docs-only.**  `package.json` and `package-lock.json` are runtime
  `watch_paths` for the Coolify auto-deploy, so the handoff records call this a runtime
  dependency-only change rather than "no runtime code changed" — the same correction Codex asked for
  on PR #3178 (see `docs/rollouts/2026-09-07-codex-autofix-observability-group-bump.md`).  On merge
  it is image-deploy material: it is subject to the weekday RTH latch and needs no `HOTFIX`.
- **Same-major bump, no code change required.**  All four locked packages move within major 7
  (`@datadog/browser-rum` / `browser-core` / `browser-rum-core` 7.9.0 → 7.13.0; transitive
  `@datadog/js-core` 0.0.10 → 0.0.14).  The only call site is `src/lib/datadog-rum.ts:24`, which
  dynamically imports the module, casts it to a local three-method `RumSdk` type (`init` +
  `addError`), and passes only long-stable `init` options — `applicationId`, `clientToken`, `site`,
  `service`, `env`, `version`, `sessionSampleRate`, `sessionReplaySampleRate`,
  `trackUserInteractions`, `trackResources`, `trackLongTasks`, `defaultPrivacyLevel`,
  `allowedTracingUrls`, `beforeSend`.  No deprecated or removed option is used, so nothing needed
  changing.
- **Failure mode is unchanged and fail-soft.**  `startDatadogRum` is wrapped in `try`/`catch` that
  resets `rumStarted`/`rumSdk` and degrades to a single `console.warn`; `captureRumError` swallows
  everything by design ("Telemetry must never throw").  A bad SDK version therefore cannot take down
  a page render, and the local `RumSdk` cast means a type-level difference in the SDK would not be
  visible to `tsc` — the guard is the runtime catch, not the compiler.
- **No live effect today.**  RUM send stays dark: `DD_RUM_ENABLED=false` in Infisical, and the
  `Socratic Trade` RUM app remains `is_active=false` (STATUS.md, 2026-09-18 GROK — Datadog remaining).
  This bump is therefore inert at runtime until RUM is deliberately switched on, which is why the
  round did not need a deploy-verification step.
- **`@datadog/browser-logs` was not pulled in.**  It appears in the lockfile only as an *optional*
  peer of `browser-rum` (`peerDependenciesMeta.optional: true`); it stays uninstalled, and the app's
  log path remains Sentry + the in-app health pipeline, per the same 2026-09-18 decision.

## Verification State

Run on this lane after `npm install` (which installed `@datadog/browser-rum@7.13.0`, matching the
lockfile):

```bash
npm run lint       # PASS — exit 0, 0 errors / 819 grandfathered warnings
npx tsc --noEmit   # PASS — exit 0
npm test           # 8144 passed / 13 failed / 51 skipped across 746 files (887s)
npm run build      # PASS — exit 0
```

The 13 failures are **pre-existing and unrelated to this change**.  They are all LLM provider
key-routing assertions in `test/chat-llm.test.ts` (2), `test/framework-review.test.ts`,
`test/llm-provider.test.ts` and `test/openrouter-credits.test.ts`, e.g. `expected OpenAILLM{ …(6) }
to be an instance of AnthropicLLM` at `test/chat-llm.test.ts:430`.  They exercise the per-user key
store versus the `LLM_OPERATOR_FALLBACK` precedence path, which is sensitive to which provider keys
are injected into the seat — this cloud seat has `ANTHROPIC_API_KEY` set and no OpenAI key, and the
repo's `verify` CI gate runs without those seat secrets and is authoritative.  This is the same
failure class documented on PR #3178
(`docs/rollouts/2026-09-07-codex-autofix-observability-group-bump.md`).  This lane's diff touches
**zero** files under `src/`, `app/`, `test/` or `ios/`, so it cannot have caused them.

Two pieces of unrelated churn were produced by the local toolchain and deliberately **reverted**
before commit, not shipped:

- `package-lock.json` — `npm install` stripped `libc: ["glibc"]` from ~90 lines of optional
  platform-specific packages (npm-version normalization, not the Dependabot bump).  Reverted to the
  branch tip, so the lockfile in this PR is byte-identical to Dependabot's commit `4d293a14ba`.
- `ios/SocraticTradeTests/Fixtures/policy-contract.json` — the test suite regenerated
  `learningReviewModel` `claude-fable-5` → `claude-fable-latest` (model-catalog drift).  Reverted.

`next-env.d.ts` and `tsconfig.json` were checked after `npm run build` and were **not** modified by
this build, so no restore was needed.

## Files

- `package.json`
- `package-lock.json`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `PLAN.md`
- `docs/rollouts/2026-09-21-datadog-browser-rum-7.13-bump.md`

## Follow-ups

- None.  RUM stays dark by owner decision; do not enable RUM send or mint a second Datadog RUM app
  as part of this bump.

## Blockers

- None.
