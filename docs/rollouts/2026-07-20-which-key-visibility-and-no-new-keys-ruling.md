# 2026-07-20 — Which-key visibility on Connections + the "agents never create API keys" ruling

## Summary

Owner-triggered by two questions: *"show the beginning and end of the API key in connection
settings"* and *"why does Socratic Trade say no credits or failed API key?"*, plus a standing
ruling: **no agent may ever create a new API key.**

Three things changed:

1. **`maskApiKeyPreview` is now the canonical key mask** (`src/lib/db-api-keys.ts`, next to
   `keyFingerprint`): first 8 characters + `...` + last 4, `undefined` for an absent key or one too
   short to elide. `llm-usage.ts`'s pre-existing `maskApiKey` now delegates to it instead of
   duplicating the same slicing, so the admin ledger and the Connections page can never drift.
2. **`GET /api/keys` returns `preview`** — the masked form of the key that *actually resolves* for
   the caller, on both the list and the `?service=` responses. Your own stored key is always
   previewable to you; the operator's env credential is previewable only to an operator/admin
   (`checkAdmin(request, { allowToken: false })`), so a tenant riding the shared key still sees
   *that* one is serving them but learns nothing about it. Token-based admin is deliberately
   excluded: this is an interactive, identity-bound disclosure.
3. **The Connections UI renders it** — `/console/connections#api-keys` shows e.g.
   `sk-or-v1...cdef` next to each row's source chip.

Plus the ruling itself, codified in `AGENTS.md` → "Don't" and broadcast to #agent-sync.

## Why

The per-user key store is write-only by design (a key is written once and thereafter only
described). That is right for secrecy and wrong for identification: when several keys exist for one
provider — which is exactly what happened, because agents on multiple platforms minted their own
OpenRouter keys for Socratic-Trade and Congress.Trade rather than using the single key the owner had
deliberately configured spend caps and guardrails on — the UI could not answer *"which key is
serving me?"* at all. A first-8/last-4 elision answers it without ever exposing a usable value.

The ruling exists because the workaround agents reached for (mint another key) is precisely the
action that routes production spend around the owner's guardrails and destroys the audit trail.

## Diagnosis: where "no credits / API key failed" on a strategy run can come from

Traced from `app/api/strategy/run/route.ts`. Production routes **every** model through the single
OpenRouter credential (`llm-provider.ts:42-44`, universal routing, #1703), so all of these converge
on one key. Ranked by how well each fits the observed symptom:

1. **App-internal budget caps that read like provider exhaustion — the top suspects.**
   - `usage-budget.ts` (the separate "Usage Monitor" microservice, `USAGE_MONITOR_BASE_URL` +
     `USAGE_BUDGET_ENFORCE`, both default off): when the provider is over its *operator-configured
     monthly dollar budget* and the model is already the cheapest tier, `strategy.ts:655-663`
     finishes the run with `status: "completed"` and the summary *"Strategy run skipped — over usage
     budget."* Because the status is `completed`, the console's `classifyRunFailure` never sees it —
     it surfaces as a plain toast that reads exactly like a credits failure while OpenRouter is fine.
   - `llm-budget.ts` per-user/day ceiling (`policy.tuning.llmDailyTokenBudget` /
     `llmDailyCostBudgetUsd`, or `TRIGGER_LLM_DAILY_*`) and `LLM_SPEND_CEILING`: normally a *silent*
     skip, but on a concurrent-run race `assertWithinLlmBudget` throws `LlmBudgetExceededError`,
     whose message contains "budget" and renders as *"The daily LLM budget is used up."*
2. **A genuine provider response**, humanized by `llm-errors.ts:98-117` — 401 → *"OpenRouter rejected
   the API key. Add or update the OpenRouter key in Connections."*; 429 / `credit balance` /
   `payment required` → *"…hit a rate limit or is out of quota/credits."* Only shown after every
   model in the failover chain fails; `llm-provider-cooldown.ts` tags a billing failure as a hard
   60-minute cooldown of the whole credential lane, so one 402 can keep the lane dark well after the
   underlying cause clears.
3. **No credential at all** → 412 *"Connect an LLM provider in Settings to run a strategy session."*
   Note `LLM_OPERATOR_FALLBACK` defaults to **false** outside tests (`db-api-keys.ts:525-532`), and
   LLM keys are `per-user-only` tier (no env fallback for anyone, including `local` —
   `db-api-keys.ts:354-358`), so a user without a stored key fails closed here.

**Evidence against a real OpenRouter exhaustion at the time of writing:** production `/api/health`
reports `openrouterCredits: {ok: true, remainingUsd: 33.71, usedUsd: 41.29}` and
`dependencies.openrouter.ok: true`. That check resolves through the same `resolveLlmCredential` path
as the primary user's strategy runs, so the key `local` calls with had credit. That points at (1) —
an app-internal cap — or at a *different* user id resolving a *different* key, which is exactly what
the new preview makes visible.

**The shadowing trap (confirmed in code, worth knowing regardless):**
`migrateLocalEnvCredentials` (`db-api-keys.ts:625-640`) seeds the primary user's key store from env
**only when no row exists**, and `resolveLlmCredential` reads the DB row **before** env
(`db-api-keys.ts:552-554`). So once a key is stored for `local`, rotating `OPENROUTER_API_KEY` in
Infisical and redeploying changes nothing — the stale DB row keeps winning until it is replaced via
Connections ("Replace") or deleted. Any agent that ever wrote a key into that store pinned the app
to it.

## Files

- `src/lib/db-api-keys.ts` — new `maskApiKeyPreview` + `PREVIEW_HEAD/TAIL/MIN_LENGTH`.
- `src/lib/llm-usage.ts` — `maskApiKey` delegates to `maskApiKeyPreview`; import updated.
- `app/api/keys/route.ts` — `preview` on both GET shapes; `checkAdmin` gate for env-sourced keys.
- `app/console/settings/lib.ts` — `preview?: string` on `ApiKeyEntry`.
- `app/console/settings/api-keys.tsx` — renders the preview chip; header/blurb copy updated.
- `test/api-key-preview.test.ts` — new (5 tests).
- `AGENTS.md` — "Don't": the no-new-API-keys ruling.
- `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md`, `STATUS.md`, this note.

## Verification

```
npx tsc --noEmit                          # clean
npm run lint                              # clean (exit 0)
npx vitest run test/api-key-preview.test.ts test/key-resolution-tiering.test.ts   # 38 passed
npm test                                  # 4897 passed, 3 failed — ALL THREE PRE-EXISTING (below)
npm run build                             # clean
curl -s https://socratictrade.com/api/health   # openrouterCredits.ok=true, remainingUsd=33.71
```

Note: `test/key-resolution-tiering.test.ts` asserts the admin ledger's existing masked strings and
still passes unchanged — confirming the delegation preserved `maskApiKey`'s behavior for every key
longer than 12 characters.

**The 3 failures are not from this change**, verified two ways — re-run with this change stashed
(`git stash -u`), and re-run in a throwaway worktree at `origin/main`:

| Test | Fails on `origin/main` | Fails on this branch | Verdict |
| --- | --- | --- | --- |
| `chat-draft-policy` — "does not stage a wash-sale-blocked buy draft" | yes | yes | broken on `main` |
| `llm-provider-cooldown` — "run 2 skips straight to the fallback" | yes | yes | broken on `main` |
| `account-deletion-coverage` — "DELETE_TABLES_BY_USER_ID covers every user-scoped table" | **no** | yes | regression from THIS branch's stop-intent work |

The third is a real defect in the branch this work sits on, not a flake:
`broker_stop_placement_intents` (the v53 placement-intent table) is user-scoped but absent from
`DELETE_TABLES_BY_USER_ID`, so those rows would **survive account deletion**. It must be fixed
before `claude/stop-intent-idempotency` lands. It is out of scope for this change and untouched here.

## Follow-ups

- **Blocking for this branch:** add `broker_stop_placement_intents` to `DELETE_TABLES_BY_USER_ID`
  (or the outside-loop allowlist, if it is genuinely not user-scoped). Until then `verify` cannot go
  green on `claude/stop-intent-idempotency`.
- **Fleet-level:** `chat-draft-policy` and `llm-provider-cooldown` are failing on `origin/main`
  itself, so the required `verify` check is red for everyone. Owner/fleet call, not this change.
- **Production, unrelated but urgent (found while answering "why does UptimeRobot say the site is
  down"):** `/api/health` is returning 503 because the liveness-critical `pinecone` lane has
  hard-failed, and prod is being SIGTERM'd and restarted every ~2.75 minutes (14:42→14:47→14:50→
  14:53→14:58→15:01 …), almost certainly by `socratic-watchdog.service` reacting to that 503. The
  site itself serves (`/` → 307). Pinecone's own index reports `Ready`, so the fault is in the app's
  calls. Candidate fix: drop `pinecone` from `criticalServices` in `app/api/health/route.ts:165` —
  the same reasoning that made Voyage non-critical on 2026-07-18, since a 503 there invites exactly
  this restart loop. Not changed here; awaiting owner direction.

- **Owner decision needed:** whether the observed error was an app-internal budget cap. The
  Usage-Monitor monthly budget and `llmDailyCostBudgetUsd` are configured *outside* the provider, so
  they can starve runs while OpenRouter shows credit. If that is what happened, the fix is to raise
  or clear that cap — not to touch any key.
- **Worth doing:** make the over-budget skip stop masquerading as a normal completion —
  `strategy.ts:655-663` returns `status: "completed"`, which is why it reaches the user as an
  ordinary toast rather than a classified "blocked" card. Not changed here (out of scope, and it is
  a behavior change on the money path).
- The preview only shows keys the app can resolve. A key that exists in a provider console but is
  not attached to the app remains invisible by construction — auditing *those* is a provider-console
  task for the owner, and now explicitly not an agent task.
