# Model catalog refresh and concise account labels

## Context & Objective

Refresh the web app's provider choices against current offerings and remove repeated paper-account explanations from the header.  Preserve explicit account/model selections and historical model aliases.

## Changes Made

- Add GPT-6 Astra/Astra Pro, MiniMax M3/M2.7, Meta Muse Spark 1.3/Glimmer 30B, and Llama 4 Maverick/Scout.
- Update Fable to 5.1, Grok to 4.6, Gemini Flash batch to 3.8, and DeepSeek V4 OpenRouter routes to the latest stable snapshots; correct Mistral wire IDs and Anthropic native IDs.
- Add MiniMax credential, endpoint, picker, and attribution support with ordinary pay-as-you-go API credentials.
- Render only `PAPER TRADING  •  broker-provided practice account` in the paper banner.  Use `PAPER` pills, omit dropdown practice-account explanations, and show a single collapsed account-name row with three spaces before an em dash and the final four account characters.

Exact touched files:

- `PLAN.md`
- `STATUS.md`
- `app/api/chat/providers/route.ts`
- `app/api/keys/route.ts`
- `app/api/policy/route.ts`
- `app/console/components/chrome.tsx`
- `app/console/lib/derive.ts`
- `app/console/lib/models.ts`
- `app/ui/llm-model-catalog.ts`
- `docs/EFFORT-LOG.md`
- `docs/manager-model-options.md`
- `src/lib/chat/llm.ts`
- `src/lib/db-api-keys.ts`
- `src/lib/llm-call.ts`
- `src/lib/llm-errors.ts`
- `src/lib/llm-model-catalog.ts`
- `src/lib/llm-provider.ts`
- `src/lib/llm-request.ts`
- `src/lib/llm-usage.ts`
- `src/lib/model-reasoning-recommendations.ts`
- `src/lib/model-rotation.ts`
- `src/lib/provider-tier-plan.ts`
- `src/lib/sentry-gen-ai.ts`
- `src/lib/usage-budget.ts`
- `test/chat-openrouter-routing.test.ts`
- `test/console-models.test.ts`
- `test/llm-call.test.ts`
- `test/llm-errors.test.ts`
- `test/llm-model-catalog.test.ts`
- `test/llm-provider.test.ts`
- `test/llm-request.test.ts`
- `test/model-rotation.test.ts`
- `test/openai-model-catalog.test.ts`
- `test/sentry-gen-ai.test.ts`
- `docs/rollouts/2026-09-09-model-catalog-account-labels.md`

## Decisions & Trade-offs

The live OpenRouter model feed was fetched on 2026-09-09 from https://openrouter.ai/api/v1/models.  Moving family aliases remain persisted identities; historical aliases remain accepted.  No account settings, model defaults, provider priority, subscription, or trading permissions are changed.  Save/rotation eligibility now follows the same OpenRouter-first/native-fallback credential resolution as execution, allowing a native MiniMax key to be selected.

MiniMax's Token Plan supports compatible developer tools but targets individual interactive development and recommends pay-as-you-go for production.  The app therefore exposes standard API credentials, without promising that a coding subscription covers automated application usage.

Sources:
- https://developers.openai.com/api/docs/models/gpt-6-astra
- https://platform.claude.com/docs/en/models/overview
- https://docs.x.ai/developers/models/grok-4.6
- https://ai.google.dev/gemini-api/docs/models
- https://platform.minimax.io/subscribe/token-plan
- https://platform.minimax.io/subscribe/token-plan?tab=api-enterprise
- https://platform.minimax.io/docs/api-reference/text-openai-api

The screenshot request concerns the web console; native iOS screens are outside this change.

## Verification State

In progress; no passing full gate or deployment claim.

- `npm ci --ignore-scripts`: registry connection resets/timeouts; stopped.
- Independent copy of integration `node_modules` completed; one truncated Zod file was recopied from the intact source after ESLint detected its syntax error.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint`: stopped after 13 minutes under severe shared-Mac load; incomplete.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx --no-install tsc --noEmit`: stopped after 13 minutes under severe shared-Mac load; incomplete.
- `git diff --check`: passed.
- Live OpenRouter feed: all added catalog wire IDs verified present.

Observed Mac load reached 603.  The draft branch is being published to run `.github/workflows/ci.yml` on GitHub-hosted infrastructure (lint, typecheck, tests, build in order); this is validation of unfinished work, not a completed landing or a bypass of required merge checks.

Hosted CI run `34326303260`: lint passed; typecheck found a MiniMax-only option accidentally copied into the Anthropic path.  Removed that option and the unrelated family predicate from Anthropic before rerunning.  Tests/build were skipped by the failed typecheck.

Actual header component browser fixture: `node /tmp/st-ui-qa-20260909/check.cjs` passed desktop paper/live and mobile paper checks, exact banner text/spacing, one-row trigger, PAPER chips, Escape dismissal, no horizontal overflow, and no page errors.  Fixture uses test accounts and does not establish production connectivity.

Focused verification: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx --no-install vitest run test/llm-model-catalog.test.ts test/llm-provider.test.ts test/llm-request.test.ts test/llm-call.test.ts test/chat-openrouter-routing.test.ts test/console-models.test.ts test/llm-errors.test.ts test/model-rotation.test.ts test/sentry-gen-ai.test.ts`: 7 suites / 126 tests passed; catalog/provider suites failed their 60-second setup hooks (16 tests skipped) under shared-Mac load.  This is not a passing targeted gate.

Reran the two timed-out suites with `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx --no-install vitest run test/llm-model-catalog.test.ts test/llm-provider.test.ts --maxWorkers=1 --hookTimeout=120000`: 2 suites / 16 tests passed.  Corrected the native Grok expectation from 4.5 to 4.6 to match the refreshed alias.  Across focused runs all 142 tests passed.

Apple Notes living note updated successfully in Coding; pin shortcut unavailable.

Hosted run `34327205131`: lint/typecheck passed; full suite reported 7,884 passed, 51 skipped, and two stale expectations (native Grok 4.5 and the pre-Astra OpenAI list).  Both fixtures are corrected; rerun pending.  No runtime test failure remained in the report.  Separate read-only provider review found no concrete remaining P1/P2 issue.

Astra Pro is also included through its verified OpenRouter route (`openai/gpt-6-astra-pro`); native routing is disabled because its native API model page returned 404.  Catalog entries can explicitly require OpenRouter.

Final provider cross-check identified Muse Spark 1.3 (Meta announcement 2026-09-02) and Glimmer 30B in the live OpenRouter feed; added both.  Meta is explicitly OpenRouter-only in this app: the prior native fallback had no Meta endpoint and would send a stored Meta key to OpenAI.  Eligibility, strategy, chat, and provider availability now fail closed without OpenRouter.  Added request-headroom and credential-boundary regression coverage.  Sources: https://ai.meta.com/llama and https://openrouter.ai/api/v1/models.

Exact-lockfile local reinstall also failed with `ETIMEDOUT`.  Hosted verification remains required.

GitHub review correctly identified native `claude-opus-5` missing from the adaptive-thinking matcher.  Added Opus 5 matching and a native chat transport regression; all native Anthropic chat calls now use the shared 4,096-token minimum.  Grok 4.5/4.6 match current reasoning controls (no off switch, xhigh on 4.6); Gemini 3.8 matches mandatory low/medium/high thinking.  Sources: https://docs.x.ai/developers/model-capabilities/text/reasoning and https://ai.google.dev/gemini-api/docs/thinking.

## Initial blockers (historical)

PR #3196 is in review pending the final gate.  `PATH=/opt/homebrew/opt/node@24/bin:$PATH bash scripts/land.sh --draft` passed worktree/hook/stale-overlap checks (main already current) and failed local typechecking because the copied dependency tree lacks `@sentry/profiling-node` and has an empty `@types/node/url.d.ts`.  Hosted lint/typechecking passed.  Reinstalling the exact lockfile using `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm ci --ignore-scripts --prefer-offline`; do not alter source to accommodate damaged dependencies.  Hosted run `34327205131` validates commit `2a9519912`.  No merge or deployment claim.

## Zero-Code Findings

Documentation search results lagged the live OpenRouter catalog for several September releases.  Exact API identifiers and provider-native spellings were cross-checked before changing the catalog.

## Review follow-up

Hosted lint, typecheck, and tests passed on `aec6c040a`; build is pending.  Auto-merge is disabled until follow-up fixes are validated.

- Chat availability and API preflight follow tenant-scoped OpenRouter-first/native-fallback execution, including OpenRouter-only models.
- Budget enforcement and preview use the credential service actually selected for the user, ignoring unrelated provider spend.
- MiniMax structured requests include their schema in the system prompt on native and OpenRouter routes.  OpenRouter retains its advertised structured-output format; native-only `reasoning_split` is not sent through OpenRouter.
- `scripts/infisical-secrets-safe.sh` rejects `MINIMAX_API_KEY` writes.  Verified with `bash scripts/infisical-secrets-safe.sh set MINIMAX_API_KEY=placeholder` (expected refusal).
- Updated the on-demand helper row in `/Users/jay/apps/MAC-LOCAL-PROCESSES.md` and refreshed/pinned the existing Coding note `⭐️ Background Jobs Master List`.  No daemon was created.
- Learning-review selections and audit metadata use current catalog identities while retaining saved aliases; request resolution and provider-reported serving identity remain distinct.

Additional touched files: `app/api/chat/route.ts`, `app/console/assistant/chat.tsx`, `app/console/settings/learning-review.tsx`, `src/lib/learning-review.ts`, `src/lib/usage-budget.ts`, `src/lib/llm-call.ts`, `scripts/infisical-secrets-safe.sh`, and focused regression tests.  Final hosted gate pending.

Hosted run `34332320089` on `5f0d07ba6`: lint/types passed; 7,902 tests passed, 51 skipped, and four failures in `test/usage-budget-strategy-integration.test.ts`.  Those fixtures stored an OpenRouter key while reporting OpenAI budget spend; correcting the payload provider to OpenRouter preserves their intended enforcement/advisory tests under the actual-route budget fix.  Updated the advisory assertion accordingly.  No runtime change was needed.  Full gate rerun pending; auto-merge disabled until validation.

Hosted run `34334232951` on `84e77c064` passed `npm run lint`, `npx tsc --noEmit`, `npm test` (7,906 passed / 51 skipped), and `npm run build`.  Additional asynchronous review threads then identified explicit OpenRouter-qualified credential routing, env-default OpenRouter model normalization, Grok 4.6 / Muse downgrade mappings, and a missing native MiniMax Datadog host.  Merge is blocked by the repository rule requiring resolved review threads; no bypass used.  These fixes are being batched and audited before another full gate.

## Final provider edge audit

- Explicit `openrouter/` model IDs now require OpenRouter across the API preflight, picker, policy eligibility, and endpoint resolution.  Operator OpenRouter models use catalog wire normalization, and `CHAT_LLM=minimax` explicitly uses the tenant native MiniMax key and native model ID.
- Grok 4.6 and new catalog aliases follow the existing downgrade chain; Muse Spark 1.3 can downgrade to Muse Glimmer 30B.  Historical explicit tier mappings remain intact.  MiniMax M3 and M2.7 have identical listed input/output prices in the verified feed, so no false cheaper-tier mapping was added.
- Native MiniMax is included in Datadog's provider-host guard without changing the existing span cap or enabling settings.
- MiniMax documents nonzero `base_resp.status_code` errors inside HTTP 200 responses.  Both `llmFetch` and `llmFetchCapturing` normalize these before tracing, retries, usage, or parsing; retain original response details; preserve successful/non-MiniMax/streaming responses.  Insufficient balance is HTTP 402: no same-endpoint retry, but eligible for the user's configured fallback chain.
- Sources: https://platform.minimax.io/docs/api-reference/text-chat-openai and https://platform.minimax.io/docs/api-reference/errorcode.
- `/opt/homebrew/opt/node@24/bin/node /tmp/st-pure-budget-check-20260909.mjs`: 13 checks passed against the actual source function/catalog using Node type stripping.
- `/opt/homebrew/opt/node@24/bin/node /tmp/st-pure-minimax-response-check-20260909.mjs`: 10 checks passed against the actual source response normalizer.  These do not replace the required hosted gate.
- Added regression coverage for explicit/OpenRouter/native operator routing, provider error envelopes, failover-only 402, Datadog attribution, and budget aliases.  `git diff --check` passed; full hosted gate pending.
- One worker briefly targeted `src/lib/usage-budget.ts` in the integration tree by mistake, then removed exactly its own hunks with `apply_patch`.  No reset/checkout/clean was used; parent verified the integration tree has no tracked changes and retains its pre-existing untracked iOS directory.

Additional exact files in this batch: `app/api/chat/route.ts`, `app/console/assistant/chat.tsx`, `src/lib/chat/llm.ts`, `src/lib/llm-provider.ts`, `src/lib/llm-request.ts`, `src/lib/llm-errors.ts`, `src/lib/datadog-llmobs.ts`, `src/lib/usage-budget.ts`, `test/chat-openrouter-routing.test.ts`, `test/chat-route-model-availability.test.ts`, `test/console-chat-model-availability.test.ts`, `test/llm-provider.test.ts`, `test/llm-request.test.ts`, `test/llm-errors.test.ts`, `test/datadog-llmobs.test.ts`, `test/usage-budget.test.ts`, `docs/manager-model-options.md`, and required status/plan/effort/rollout documents.

## Proposal, cooldown, and timeout review follow-up

Review on `13c2b4cab` identified three remaining integration gaps.  Native MiniMax omits provider schema enforcement, so its syntactically valid proposals now pass the existing completeness gate before sanitization/sizing.  OpenRouter MiniMax retains its advertised structured-output enforcement.  MiniMax insufficient balance enters the billing cooldown path, and MiniMax/Muse default reasoning participates in the wider strategy timeout.

Touched files in this batch: `src/lib/strategy.ts`, `test/strategy-hardening.test.ts`, `src/lib/llm-provider-cooldown.ts`, `test/llm-provider-cooldown.test.ts`, `src/lib/llm-request.ts`, `test/llm-request.test.ts`, `docs/manager-model-options.md`, `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, and this rollout.  Full hosted gate rerun required after the batch; local dependency repair remains blocked by registry timeouts.  Auto-merge is disabled until fixes are pushed and review replies resolved.

`/opt/homebrew/opt/node@24/bin/node /tmp/st-pure-proposal-gate-20260909.mjs`: 5 actual-source checks passed, including incomplete native proposals rejected and complete proposals retained.  Worker actual-source classifier check: 5 cases passed.  `git diff --check` passed.  Hosted full lint/typecheck/test/build gate remains required.

## Final verification and merge

PR #3196 merged to `main` as `3aa643cacd25688eb6c948f686e4410b834617ff`.  Final hosted run `34338996582` / job `102425902504` on `9968619e46b6c6ddd1004cc4410b871b3570fa0a` passed, in order:

- `npm run lint`
- `npx tsc --noEmit`
- `npm test`: 719 suites passed, 1 skipped; 7,928 tests passed, 51 skipped.
- `npm run build`

Gitleaks and the aggregate `verify` gate passed.  All 14 review threads were answered after their fixes were pushed and resolved before merge.  No merge bypass, local gate skip flag, or manual production deploy was used.  Local `node_modules` remains incomplete; hosted verification is the full-gate evidence.

`DEPLOY_VERIFY_TIMEOUT_SECONDS=1200 bash scripts/verify-deploy-sha.sh 3aa643cacd25688eb6c948f686e4410b834617ff` is checking automatic production rollout by merge-commit containment.  The initial live SHA was `044a74f26eb8736c59bfb96a097b2d98afdc4659` (behind).  Final result: PASS, live `3aa643cacd25688eb6c948f686e4410b834617ff` contains the merged change; `ok=true`, `db=ok`, scheduler age 19 seconds, process uptime 7 seconds.

The board is Deployed with the merge and production containment receipts.  A docs-only closeout updates this rollout, `STATUS.md`, `PLAN.md`, and `docs/EFFORT-LOG.md` from an owned branch based on the merged `origin/main`; runtime files are unchanged.

Closeout validation: `git diff --check` passed; only the four documentation files above changed.  The existing CI documentation-only path validates the closeout PR; runtime verification remains the full passing run documented above.  No product work remains.

## Next Steps & Blockers

No remaining product or release work.  This owned lane still needs a successful exact-lockfile dependency installation before future local full-suite work; registry timeouts prevented it during this task.  Hosted CI provided the required passing gate.

## Correction (2026-09-18)

Two rows this PR added did not survive the 2026-09-18 catalog cleanup (`docs/rollouts/2026-09-18-model-catalog-cleanup.md`): **MiniMax M2.7** (same $0.30/$1.20 price as MiniMax M3, one-fifth the context) and **Llama 4 Maverick / Llama 4 Scout** (no reasoning support, dominated cross-family by the same-priced-or-cheaper MiniMax M3 and Muse rows this PR also added).  GPT-6 Astra Pro's `openRouterOnly: true` flag and its underlying reasoning-mode explanation from this PR (line 94 above) are still accurate and unchanged — only its dropdown label text changed, from "GPT-6 Astra Pro — via OpenRouter" to "gpt-6-astra-pro — GPT-6 Astra in pro reasoning mode (more thinking per call)", to stop implying a transport distinction that does not exist (every catalog row routes through OpenRouter whenever a credential is configured).  This note is left in place rather than edited in place, per `AGENTS.md`'s instruction to leave a paper trail when a later change supersedes part of an earlier rollout.

Docs closeout landing attempt: `PATH=/opt/homebrew/opt/node@24/bin:$PATH bash scripts/land.sh --draft` passed lane/stale-overlap checks but stopped at typechecking: the missing local TypeScript binary caused npx to resolve the unrelated `tsc@2.0.4` package, which exits with “This is not the tsc command you are looking for.”  No skip flag was used.  The docs-only PR uses the existing hosted path-classified gate; the runtime gate already passed in full before deployment.
