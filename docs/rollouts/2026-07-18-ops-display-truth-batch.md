# 2026-07-18 — Ops/display truth batch (Codex review items 33/38/43/45/46)

Branch: `claude/ops-display-truth-batch` (worktree
`/Users/jay/Code/Socratic-Trade/.claude/worktrees/agent-a063b6c5961d64b43`).
Batch of small display/ops honesty fixes from the Codex app review. Dedup pass ran
first against PR #1733, #1737, and merged #1708 (MONET visual-tour wave); mid-batch
a coordinator heads-up flagged CODEX's in-flight `codex/socratic-infra-panel-reliability`
lane (commit `28eb3b84`) for a server-metrics collision.

## Per-item disposition

| Item | Disposition | Detail |
|------|-------------|--------|
| 33 — server-metrics 502 → 200 degraded | **SKIPPED — duplicate (in-flight CODEX lane)** | Implemented first (200 + `degraded` + per-provider status, client chips, tests), then REVERTED before commit: CODEX commit `28eb3b84` (`codex/socratic-infra-panel-reliability`, landing via PR) is a full route rewrite that covers the 502→200-degraded change and more (always-200, `stale` flag, last-successful-snapshot cache, per-configuration states, 232 test lines). Nothing of item 33 remains in this branch. |
| 38 — coordination audit checks wrong live-board filename | **FIXED (outside the repo)** | Repo-wide grep (`scripts/`, `.github/`, `src/`, `app/`, `docs/`, full-tree + all-branch `git log -S`) found ZERO occurrences of `SOCRATIC-TRADE-EFFORT-LOG` — the bug is not in this repo. The real source is the machine-shared script `/Users/jay/apps/codex-coordination-audit.py` (not git-tracked): its `--repo` fallback derived `/Users/jay/apps/SOCRATIC-TRADE-EFFORT-LOG.md` from the app name instead of using the registered canonical `TRADING-EFFORT-LOG.md`. Fixed in place: the fallback now prefers `APP_REGISTRY[app]["board"]` and only guesses a derived name for unregistered apps. Verified: `python3 /Users/jay/apps/codex-coordination-audit.py --repo /Users/jay/Code/Socratic-Trade` now reports `OK coordination wiring present` (previously false-failed on the missing live board). No repo files changed for this item. |
| 43 — orders page copy + executed qty (minimal slice) | **PARTIAL: copy defect not found; executed display FIXED** | The reported `Latest 20finished orders` missing space does not exist at HEAD — `app/console/orders/page.tsx:471` already reads `Latest {history.length} finished orders, …` and `git log -S "20finished"` finds no history of it (likely a review-render artifact). The display-only executed-quantity/notional slice WAS added: finished orders now show `N sh · $X executed` (from `filledQuantity` × `averagePrice`, both already in the `EquityOrder` payload) under the Size cell (desktop table) and Size tile (mobile card); nothing renders when nothing filled, so rejected/expired orders never show a false `0 sh`. No filters/pagination/grouping (tracked follow-up, per brief). |
| 45 — OpenRouter-routed models branded as OpenAI / raw IDs | **FIXED** | `app/console/lib/models.ts`: `providerForModel` + `modelDisplayName` now strip the OpenRouter vendor-routing prefix (`anthropic/`, `x-ai/`, `google/`, `mistralai/`, `deepseek/`, legacy `openrouter/...`) via the SHARED canonicalizer `canonicalModelId` (`src/lib/model-identity.ts`, consolidated by #1736 from the #1703/#1716 model-identity work — reused, not re-derived, per brief). `x-ai/grok-4.3` now brands xAI/"Grok 4.3" instead of OpenAI/raw id. New `isOpenRouterRouted()` exposes transport separately; `ModelBadge` (`app/console/ui/provider-logo.tsx`) surfaces "via OpenRouter" in the tooltip and in the `showProvider` suffix — vendor brand and transport never conflated. Not covered by #1733/#1737 (those fix wire-request/cooldown/rotation, not console display). |
| 46 — copy slice (4 sub-items, none in MONET's #1708) | **FIXED (all four)** | (a) "Nasdaqcomposite Universe": `src/lib/market.ts` emits dynamic-universe source tags as camelCase `${universe}-universe` (`nasdaqComposite-universe`); `SOURCE_LABELS` in `src/lib/dashboard-ui.ts` keyed a hyphenated `nasdaq-composite-universe` that never matched, so `titleizeSource` garbled it. Keys now match the emitted ids verbatim + added missing `nyseComposite`/`ftWilshire5000` labels. (b) Dirty ADR names: sanitizer added at the Nasdaq-screener→quote boundary (`toMarketQuote` in `src/lib/market.ts`) stripping only UNFILLED `(Representing - )` placeholder fragments; genuinely populated annotations (e.g. `(Representing 2 Ordinary Shares)`) are kept — real data, not dirt. (c) Doubled `..` after Red Team errors: the Red-Team-unavailable approval summary in `src/lib/strategy.ts` hard-appended `.` after `redTeamResult.reason`, which always already ends with a period (red-team.ts `unavailable()` / `humanizeLlmError` messages) — new `appendSentence` helper adds the period only when missing. (d) RAG coverage label soup: `app/admin/rag-coverage/rag-coverage-client.tsx` summary tiles renamed to say which system each count comes from — "Tickers with coverage" / "Chunks (local ledger)" / "Vectors (Pinecone index)" / "App-recorded RAG spend" — with tooltips explaining the local-ledger vs Pinecone distinction (#1708 only converted this page's fetch-error copy; labels untouched there). |

## Why

Every item is a truth-in-display defect: wrong vendor branding, garbled/raw labels,
placeholder junk shown as data, punctuation artifacts in operator-facing error copy, and
ambiguous counts mixing three different systems. Item 33's motivation (Cloudflare swallowing
degraded-JSON 502s) is real but owned by the CODEX infra-panel lane.

## Files

- `app/console/lib/models.ts` — routing-prefix-aware provider/display normalization + `isOpenRouterRouted`.
- `app/console/ui/provider-logo.tsx` — "via OpenRouter" transport signal in `ModelBadge`.
- `app/console/orders/page.tsx` — `executedText` helper; executed qty/notional on finished orders (desktop + mobile).
- `src/lib/dashboard-ui.ts` — camelCase dynamic-universe source label keys (+ NYSE/FT Wilshire).
- `src/lib/market.ts` — `sanitizeCompanyName` (unfilled `(Representing - )` strip) at `toMarketQuote`.
- `src/lib/strategy.ts` — `appendSentence` helper; single-period Red-Team-unavailable summary.
- `app/admin/rag-coverage/rag-coverage-client.tsx` — explicit per-system count labels + tooltips.
- `test/console-models.test.ts` — NEW: providerForModel/modelDisplayName/isOpenRouterRouted routed-id suite.
- `test/dashboard-ui.test.ts` — camelCase universe-tag label regression.
- `test/market-dynamic-universe.test.ts` — ADR placeholder strip vs populated annotation kept.
- `test/redteam-failure-routing.test.ts` — no-`..` + summary-content assertions on the held-opening receipt.
- `/Users/jay/apps/codex-coordination-audit.py` — (outside repo) registry-first board resolution for `--repo`.

Merged `origin/main` (through `614ad0f9`) into the branch mid-batch: #1736 landed the shared
`src/lib/model-identity.ts`, so item 45 imports the canonical helper instead of the
`model-merge` alias (initial commit `a487738c` used the alias; the follow-up commit switches
to `@/lib/model-identity`). Only overlap (`src/lib/strategy.ts`, #1738) auto-merged cleanly.

## Verification

- `npx tsc --noEmit` — exit code recorded in this note's final commit message. (First attempt
  wrote to the shared session scratchpad and was clobbered by a sibling session's tsc writing
  the same path — the stray `test/apple-auth-route.test.ts` error in that log belongs to the
  sibling worktree; the file does not exist in this one. Second attempt was killed by a host
  reboot mid-run. Final run wrote to a unique path.)
- `npx vitest run test/console-models.test.ts test/dashboard-ui.test.ts test/market-dynamic-universe.test.ts test/usage-model-merge.test.ts test/openai-model-catalog.test.ts` — 5 files, 31/31 passed (post-merge tree).
- `npx vitest run test/redteam-failure-routing.test.ts` — 10/13 passed; the 3 failures are
  30s-per-test timeouts (`}, 30_000)` hardcoded in the file) under load-average ~60 (a dozen
  concurrent sibling-agent gates on the shared box). **Verified pre-existing:** the identical 3
  tests fail with identical timeouts on a clean detached `origin/main` worktree with zero
  changes from this branch. The failing set fluctuates between runs (3→2→3), including tests
  this branch does not touch. Expect green in CI (dedicated runner); re-run there if it flakes.
- `python3 /Users/jay/apps/codex-coordination-audit.py --repo /Users/jay/Code/Socratic-Trade` — `OK coordination wiring present`.
- Commit author email verified as the GitHub noreply address.

## Follow-ups

- Item 33 lands via CODEX's `codex/socratic-infra-panel-reliability` PR — verify after merge that
  the Cloudflare-error-page symptom is gone in production.
- Orders-page filters/pagination/grouping remain a tracked follow-up (explicitly out of scope here).
- The `redteam-failure-routing` 30s per-test caps are too tight for a loaded shared box —
  candidate for the same treatment as the approval-lock 20s-timeout fix (2026-06-21) if it
  keeps flaking in CI.
- `test/console-models.test.ts` asserts display behavior for ids like
  `anthropic/claude-3.5-sonnet` (uncatalogued → bare-id fallback); if the curated catalog gains
  these ids, update the expected display names.
