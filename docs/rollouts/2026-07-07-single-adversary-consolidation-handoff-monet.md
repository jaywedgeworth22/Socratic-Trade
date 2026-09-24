# HANDOFF → MONET: Single-Adversary Consolidation (full ownership)

> **RECONCILED + EXECUTED 2026-07-07 (MONET, Cowork desktop session).** Everything below is done
> except the macOS `npm run build` + `land.sh` push (delegated to the Mac-side Claude helper — the
> Cowork sandbox can neither push nor run a >45s process). Reconciliation notes vs this doc:
> the "uncommitted edits in the owner's main worktree" had already been preserved as draft
> **PR #1035** (`claude/single-adversary-consolidation-wip`); that branch's single commit was
> cherry-picked CLEANLY onto current `origin/main` (none of the 22 drift commits touched the
> Stage-1a files — the §1 "#1014 refactored the SAME llm/stream layer" warning was a false alarm;
> #1014 refactored the congress stream client). #1035 is SUPERSEDED by
> `monet/single-adversary-consolidation`. All §4 stages implemented; every §5 gotcha checked
> (usage-budget tolerates "", no policy-route import cycle, key-less fixtures updated,
> CHAT_LLM_MODEL tests updated, zero DEFAULT_OPENAI_MODEL stragglers, R15 handled via db migration
> v15). Gate on Linux x64: tsc 0 / eslint 0 errors / 2,888 tests pass. Full record:
> `docs/rollouts/2026-07-07-single-adversary-consolidation-impl.md` ("MONET completion record").

**Date:** 2026-07-07 · **From:** Claude (Cowork desktop session) · **To:** MONET (cloud lane) ·
**Status:** OWNER HANDED OFF ENTIRELY TO MONET. Monet now owns this end-to-end: reconcile the
authored-but-unverified edits, finish the remaining stages, run the verify gate, land via
`land.sh` + PR, and deploy per the owner's standing auto-deploy directive.

> Read these first, in order: this doc → `docs/single-adversary-consolidation.md` (the spec +
> **⚠️ OWNER REVISION 2026-07-07** banner at top, which GOVERNS) →
> `docs/rollouts/2026-07-07-single-adversary-consolidation-impl.md` (what was touched).

---

## 0. Why this exists (one paragraph)

The single-adversary consolidation was fully designed, all §9 decisions RESOLVED 2026-07-01,
Codex-reviewed — and **never implemented** (both adversarial passes still run; none of
`approve-at-half` / `adversaryUnavailable` / `extractJsonPayload` / `fetchLlmWithRetry` existed
in `src`). The owner rediscovered this on 2026-07-07, revised the independence design, and had the
Cowork Claude session start it. Cowork **cannot run the verify gate** (Linux/arm64 vs macOS-compiled
`better-sqlite3`/`vitest`/rolldown native bindings won't load) and is on a `main` worktree **12
commits behind `origin/main`**, so the work is handed to you (a gate-capable lane) to verify + land.

## 1. CRITICAL constraints before you touch anything

- **The authored edits are UNVERIFIED** — no `tsc`/`lint`/`test`/`build` was run. Treat them as a
  reviewed starting diff, not known-good. Re-verify everything.
- **They live UNCOMMITTED in the owner's `~/Code/Socratic-Trade` `main` worktree, on a stale base
  (12 behind `origin/main`).** Do NOT land them from there. Start a fresh branch off **current
  `origin/main`**, re-apply the changes (this doc describes each precisely so you can reproduce them
  even if the raw diff doesn't transfer cleanly — anchors have drifted), then verify.
- **The spec's file:line anchors predate the console port.** The approval UI is now
  `app/console/components/approval-card.tsx` (NOT `app/dashboard-client.tsx`); settings model UI is
  `app/console/settings/models.tsx`. Re-grep by symbol before editing; don't trust old line numbers.
- **This is the real-money trade gate.** Fail-closed everywhere; never leave a half-wired adversary.

## 2. Authoritative design — owner's revised decisions (OVERRIDE spec §3.8/§8/O4/R12–R14)

1. **No model default for anything, ever.** No hardcoded default, no env fallback, no red→green
   fallback, no cross-family auto-default.
2. **Green (`llmModel`) and Red (`redTeamLlmModel`) are BOTH mandatory and explicitly chosen.** It
   must be impossible to *run* without both (Settings UI requires them; strategy fails closed at
   runtime if somehow unset).
3. **Only providers the user holds a key for are selectable** in Settings.
4. **Same model for both is ALLOWED** if chosen. No hard same-model prohibition, no write-time
   independence enforcement, no auto-different-provider. Independence is a **non-blocking Settings
   hint**, never a gate. (Matches repo philosophy: guardrails are adjustable, not a cage.)
5. **One adversarial LLM call** doing everything both calls did; **kill `RED_TEAM_LLM_PROVIDER`**;
   keep the §4 reliability + §5–§7 visibility work (R1–R20).

Everything else in `docs/single-adversary-consolidation.md` (§3.1 build on the post-sizing
`debateProposal` site; §3.3 three-verdict `approve`/`approve-at-half`/`reject`; §3.5 exits never
reviewed; §3.6 all-openings coverage; §3.7 never-silent failure; §4 reliability; §5–§7 visibility)
still applies **as amended by the five points above**.

## 3. DONE by Cowork Claude (UNVERIFIED — reconcile + verify, don't redo)

All are the "no model defaults anywhere" foundation + the first reliability primitive. Files and
exact changes:

| File | Change |
|------|--------|
| `src/lib/llm-request.ts` | `resolveOpenAiModel` returns `""` when `llmModel` unset (dropped `OPENAI_MODEL` env + `DEFAULT_OPENAI_MODEL` fallbacks). **Deleted the `DEFAULT_OPENAI_MODEL` const entirely** (zero users after chat de-default). |
| `src/lib/llm-provider.ts` | `resolveRoleModel(policy, role)` — Red = explicit `redTeamLlmModel` or `""` (no green fallback, no cross-family default); Green/support = `resolveOpenAiModel` or `""`. **Removed** `CROSS_FAMILY_RED_TEAM_DEFAULT` + `defaultCrossFamilyRedTeamModel` + the `userId` param. Updated the `resolveLlmEndpoint` call site. |
| `src/lib/chat/llm.ts` | `getLLM` de-defaulted: requires `CHAT_LLM_MODEL` (no `DEFAULT_OPENAI_MODEL`/`"claude-opus-4-8"` fallback), else MockLLM. Import trimmed. |
| `app/api/chat/route.ts` | `llmFromProvider` de-defaulted (same rule; returns null without an explicit model). Import removed. |
| `app/api/policy/route.ts` | Stopped silently deleting a blank Red model (no implicit fallback). Added server-side **keyed-provider backstop**: a chosen Green/Red model's provider must have a key. Same-model allowed. Imports `resolveLlmCredential` + `llmModelFamily`. |
| `src/lib/llm-call.ts` | **New** `extractJsonPayload(text)` (R9): strips code fences + returns the first *balanced* JSON block (string/escape-aware; not greedy; never fabricates valid JSON). |
| `test/llm-request.test.ts` | Rewrote the resolution test to the new `""`-unconfigured contract; removed `DEFAULT_OPENAI_MODEL` import. |
| `test/llm-provider.test.ts` | Rewrote the 3 cross-family/fallback tests → Red unset resolves to `""` (never Green), no auto-default even with a 2nd-provider key, same-model-for-both allowed. Fixed the empty-policy test to assert model `""`. |
| `test/llm-call-json-payload.test.ts` | **New** unit tests for `extractJsonPayload` (fences, prose, nested, braces-in-strings, non-greedy, truncated → still throws on parse). |

Docs/tracking already updated: `AGENTS.md` (new "Design-vs-implementation drift — FLAG IT" rule),
`docs/single-adversary-consolidation.md` (status + owner-revision banners), `docs/EFFORT-LOG.md`
(rows), `docs/rollouts/2026-07-07-single-adversary-consolidation-impl.md`. Announced in `#agent-sync`.

## 4. REMAINING work (staged; you own all of it)

**Stage 1b — finish model rules**
- **Strategy runtime fail-closed backstop:** when a resolved Green/Red model is `""` (unconfigured),
  the strategy run must skip / route to human with a clear reason — never send an empty-model
  request. Wire where `resolveLlmEndpoint(...,"green")` / `(...,"red")` results are consumed in
  `src/lib/strategy.ts` (and the adversary path). This is the runtime half of "impossible to run
  without both."
- **Settings UI `app/console/settings/models.tsx`:** both Green + Red **required** (no save with
  either blank); dropdowns **disable non-keyed providers** (data already available via
  `GET /api/chat/providers` — the file annotates today, make them truly non-selectable); **allow the
  same model for both**; **drop the empty `<option value="">` "same as Green"** idiom. Add a
  non-blocking independence *hint* when Green === Red or same provider.
- Consider the **migration consequence**: existing users with unset models now fail closed. Either a
  one-time normalization that forces re-pick, or a Settings gate on first run. Owner accepts the
  consequence; make it legible, not silent.

**Stage 2 — the one adversary** (the heart; `src/lib/strategy.ts` + `src/lib/red-team.ts`)
- **Delete the in-flow Bear LLM** inside `proposeTrades` (`strategy.ts` ~`4406`, `step:"bear"`):
  remove the bear system/schema/userContent/`resolveLlmEndpoint(...,"red")`/fetch/parse and return
  the Bull output — **but KEEP `deterministicBearFilter`** (model-free vetoes) and the
  `bearReviewUnavailable` fail-closed *semantics* now fed by the single adversary.
- **Rewrite `debateProposal`** (`red-team.ts`) as the SINGLE reviewer, told to do **both** jobs: the
  in-flow Bear's fact-check of candidate evidence (fundamentals/technicals/smart-money/macro) **and**
  the finalized-size critique. Three-verdict output `approve`/`approve-at-half`/`reject` (spec §3.3;
  half must re-check placeability per R1/R2 — route to human if 0.5× is unplaceable, never up-size).
- **Remove the escalated second-call duplication:** today `strategy.ts:1262` loops and calls
  `debateProposal` again (gated by `shouldRunRedTeamDebate`) on top of the inline Bear. Collapse to
  ONE call per opening. Exits (`sell`/`cover`, and net-risk-reducing buys/shorts) are **never**
  reviewed (§3.5, R5).
- **Kill `RED_TEAM_LLM_PROVIDER`:** delete `redTeamProvider()`, the env reads, the Anthropic
  special-case branch, and any hardcoded model in `red-team.ts`. The reviewer's provider comes from
  the user's chosen `redTeamLlmModel` (resolved via `role:"red"`), nothing else.

**Stages 3–4 — reliability + visibility (R1–R20 in the spec §12)**
- Apply `extractJsonPayload` at **every** LLM parse site (R10 — incl. the Green/Bull parser).
- `fetchLlmWithRetry` (bounded 1–2 retries on 429/5xx, capped under timeout); failover only to an
  explicit backup model (R11 — no hidden fallback).
- Validate parsed shape; unknown/missing verdict → fail-closed (R? §4.4).
- Persist `adversaryUnavailable` + reason on the proposal `decision` (R19), on BOTH the propose-mode
  and requiresHumanReview inserts (R18); amber badge in `app/console/components/approval-card.tsx`;
  notification payload flag (§5.2). Record Red-Team **rejections** as rows before dropping (R8).
- Pass the resolved account-scoped `policy` into the reviewer (R17); update `ops-snapshot.ts` red
  resolution to `role:"red"` (R16).

**Stage 5 — tests + verify + handoff docs.**

## 5. Verify-items / gotchas (things that will bite)

- `src/lib/usage-budget.ts:376` now gets `greenModel === ""` — confirm it tolerates empty (cost
  estimate only; should not throw).
- `app/api/policy/route.ts` now imports `@/lib/llm-provider` — confirm **no import cycle**
  (`policy route → llm-provider → db`); if one appears, import `llmModelFamily` from a leaf module.
- Existing tests/fixtures that PUT a policy with a model but **no matching provider key** will now
  `400` — update fixtures to seed a key or use a keyed model.
- Chat env-default path now needs `CHAT_LLM_MODEL` set; `.env.example` / ops docs may reference the
  old behavior — update.
- Confirm `DEFAULT_OPENAI_MODEL` deletion left no stragglers (`grep -rn DEFAULT_OPENAI_MODEL`).
- Spec §8/R15: deployments running `RED_TEAM_LLM_PROVIDER=anthropic` with a blank
  `redTeamLlmModel` will flip to fail-closed once the env override is deleted — seed the first-class
  Red setting from the env value before removing the reads, and clean `.env.example`.

## 6. Definition of done (per `AGENTS.md`)

Gate (in order): `npx tsc --noEmit` → `npm run lint` → `npm test` → `npm run build`. Land via
`scripts/land.sh` (own worktree/branch; PR **ready, not draft**; merge `--squash --auto`). Update
`STATUS.md`, `docs/EFFORT-LOG.md` (+ `/Users/jay/apps/TRADING-EFFORT-LOG.md`), `PLAN.md`,
`docs/phase-7-strategy.md:65` (flip to IMPLEMENTED), the spec banner (→ IMPLEMENTED), and this
handoff note (mark reconciled). Deploy per the owner's standing auto-deploy directive after merge.
Announce progress in `#agent-sync`.
