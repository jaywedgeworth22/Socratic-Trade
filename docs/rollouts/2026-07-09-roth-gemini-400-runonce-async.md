# 2026-07-09 — Roth Gemini 400 TRUE root cause + async Run-once (MONET)

## Summary

Two owner-reported production bugs, both fixed on `monet/roth-gemini-400-runonce-async`:

1. **Roth IRA Green/Bull Gemini 400 — the REAL root cause** (the 2026-07-09
   schema-dialect fix in #1167 was necessary-looking but NOT the trigger):
   **`maxItems: 8`** (Roth's `maxProposalsPerRun: 8`) on the Bull proposals
   array. Gemini's OpenAI-compat structured-output validator expands the array
   item subtree once per `maxItems` slot against an undocumented internal
   complexity budget; the post-#1036 15-property item schema (the two bracket
   fields pushed it over) overflows at ×8 → generic
   `400 INVALID_ARGUMENT` in ~1s. Proof matrix against the real endpoint with
   the repo's real `buildLlmRequestBody`, on BOTH the operator key and the
   user-stored key (decrypted in-memory, never printed): maxItems 8 + full
   schema → 400 byte-identical to prod; 8 minus the #1036 bracket fields → 200;
   3–7 full → 200; no maxItems (Bear's shape — which is why Bear never failed)
   → 200; post-fix identical request → 200; maxItems re-injected → 400.
   Timeline finally consistent: bulls succeeded through 07-07T23:18Z (13-prop
   items ×8 fit), first failure = first run after the cutover deploy shipped
   #1036 (04:11Z 07-08). The earlier "nullable unions" diagnosis is CORRECTED
   in the code comment — raw type unions were accepted all along.
   **Fix**: `toGeminiJsonSchema` strips `maxItems`/`minItems` from the Gemini
   wire schema and folds the bound into the node description ("Return at most
   N items.") — safe because every consumer truncates app-side
   (`sanitizeProposals`); other providers keep `maxItems`. Plus
   `src/lib/llm-errors.ts`: structured Google-RPC/OpenAI error-envelope
   extraction, full `details` array captured (2000-char cap, was 240), and an
   idempotency guard killing the "Gemini error: Gemini error:" stutter.

2. **Run-once 524 + raw Cloudflare HTML in the error dialog**: the console's
   Run once ran the entire multi-minute strategy inside one HTTP request;
   Cloudflare cuts the connection at ~100s (the owner's 05:20Z manual run DID
   execute server-side — started 05:20:27, failed 05:23:40 on the Gemini bug).
   **Fix A**: `app/api/strategy/run/route.ts` races `runStrategyOnce` against
   a bounded sync window (default 8s, `RUN_ONCE_SYNC_WINDOW_MS`): fast
   pre-flight blocks (lock/no-account/halted — all resolve before the first
   await) still return synchronously; a real run returns
   `202 {status:"started"}` while the detached promise continues (persistent
   Node container; pinned via the codebase's existing globalThis pattern), and
   the `strategy_runs` row (inserted synchronously before the first await) is
   tracked by the console's existing polling. Button shows "Run started —
   check Activity". **Fix B**: the shared console error builder detects HTML
   bodies (header AND leading-bytes sniff) and replaces them with a clean
   status-aware message (524 called out by name) — no dialog can render a raw
   edge page again.

## Process note

The run-once lane's subagent accidentally worked in the integration tree
(`/Users/jay/Code/Socratic-Trade`, branch `main`) — its edits were relocated
into the session worktree, the integration tree fully restored, and the
copies reconciled against the CURRENT main (naive copies would have reverted
#1173's chrome.tsx and #1174's api.ts additions; only the intended hunks were
applied).

## Files

- `src/lib/llm-call.ts` (Gemini maxItems strip + corrected doc history)
- `src/lib/llm-errors.ts` (structured provider-error capture)
- `app/api/strategy/run/route.ts` (async run-once)
- `app/console/lib/api.ts` (HTML-error shield + RunOnceResult "started")
- `app/console/components/chrome.tsx` (Run started toast)
- Tests: `test/llm-call.test.ts` (+5), `test/llm-errors.test.ts` (+4),
  `test/strategy-run-once-async-route.test.ts` (new), `test/console-api-html-error.test.ts` (new)

## Verification

`npm run lint` / `npx tsc --noEmit` / `npm test` / `npm run build` — recorded
in the PR (agent-level: 3135 tests green pre-assembly). Forensics left ZERO
footprint on the box (read-only, all staged files deleted, keys in-memory only).

## Follow-ups

- Gemini grammar budget: min/max + long descriptions still spend it; if the
  schema grows again the same generic 400 can return — the new error capture
  will now record whatever detail Google attaches.
- Deploy required for prod to heal (auto-deploy OFF). The next Roth run after
  deploy is the live proof.
