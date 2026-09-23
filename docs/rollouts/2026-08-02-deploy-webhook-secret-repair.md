# 2026-08-02 — Deploy pipeline repair: webhook HMAC secret mismatch (MONET)

Branch `monet/deploy-webhook-repair`. Ops repair + docs; the only repo changes are docs.

## 1. Context & Objective

During the 2026-08-01 Codex-review remediation, production stopped advancing: live health
stayed on one SHA while `main` accumulated 5+ merged commits, and
`processUptimeSeconds` showed no restart — meaning no deploy ever *started*. Auto-deploy on
merge is the owner-directed standing protocol, so the pipeline itself was broken. Objective:
find the exact failure point and restore the standing state, without hand-triggering any
deploy.

## 2. What was found (receipts)

1. **Coolify's deployment queue was EMPTY** (`GET /api/v1/deployments` → 0 running/queued).
   Not a wedged build — merges never created deployments at all.
2. **GitHub was delivering fine.** Both repo webhooks showed fresh `push` deliveries with
   HTTP 200. The 200 is misleading: it is the transport status, not the outcome.
3. **The delivery response bodies told the real story.** For every push to
   `refs/heads/main`, on BOTH hooks, Coolify answered:
   `[{"status":"failed","message":"Invalid signature."}]` — HMAC mismatch between the
   GitHub hook's secret and the app's `manual_webhook_secret_github`. Branch pushes
   returned "Nothing to do" (they match no app), which is why the breakage was invisible
   except on main.
4. **The one deploy of 2026-08-01 (`23d7b9cd`, process start 23:29Z) was the owner's
   manual dashboard click**, not the pipeline — its own webhook delivery had failed
   signature like all the rest.
5. **AGENTS.md's app uuid was stale.** `GET /api/v1/applications/m1os7ijf31bg3fanil152e4b`
   returns a bare `{"message":...}`; the app list shows the real app is uuid
   **`socratic-app`** (name "Socratic-Trade", branch `main`, dockerfile build pack, SSH
   deploy-key source). The deploy-key source is why the manual webhook endpoint (with HMAC
   validation) is in play rather than the GitHub-App integration described in the old
   stanza.
6. There were **two duplicate hooks** (same URL
   `https://host.jays.services/webhooks/source/github/events/manual`, same `push` event),
   both with wrong secrets.

## 3. Repair performed (2026-08-02 ~04:06Z)

1. Read `manual_webhook_secret_github` from the Coolify app via API into a shell variable
   (never printed; all command output piped through inline redaction per the secret-safety
   protocol).
2. `PATCH /repos/jaywedgeworth22/Socratic-Trade/hooks/658815433` — set `config.secret` to
   that value (url/content_type/insecure_ssl re-sent unchanged).
3. Deleted duplicate hook `658869484`. Proof it was a pure duplicate: once hook 1 carried
   the corrected config, patching hook 2 to the same config failed GitHub validation as an
   exact-duplicate hook. Keeping it would log a spurious "Invalid signature" on every push
   forever and poison the next diagnosis. Re-creating it takes seconds if ever wanted
   (URL above; secret in the Coolify app).
4. **Redelivered** the newest `refs/heads/main` push delivery (commit `19dfd51b`) through
   the repaired hook — a re-send of an event GitHub already emitted, exercising the
   standing auto-deploy path; NOT a manual deploy trigger.
5. **Proof of repair:** Coolify immediately created a real deployment —
   `Socratic-Trade | in_progress | commit 19dfd51b` — after a full day in which zero
   deployments were created. A background watch
   (`scripts/verify-deploy-sha.sh 19dfd51b`, 55-min window) is confirming the cutover.

Nothing else was mutated: no deploy button, no app config change, no Cloudflare change, no
secret value created or rotated (the existing Coolify-side secret became the single source
of truth).

## 4. Decisions & Trade-offs

- **Sync GitHub → Coolify, not the reverse.** GitHub hook secrets are write-only, so the
  Coolify value is the only recoverable truth; inventing a fresh secret on both sides was
  unnecessary surface.
- **Redelivery as verification.** The alternative — wait for the next organic merge — left
  prod frozen 6+ commits behind on an untested repair. Redelivery re-enacts the exact
  standing path; if the repair were wrong it fails exactly like before, changing nothing.
- **Duplicate hook deleted rather than "fixed".** GitHub refuses two hooks with identical
  config, and a permanently-failing hook is diagnostic poison.
- Diagnosis and repair used `gh` (owner-authenticated) and the sanctioned
  `COOLIFY_AGENTS` token from `~/.secrets/global-api-keys.env`. Gotchas for the next agent,
  learned the annoying way: the secrets env file exports a `GITHUB_TOKEN` that overrides
  `gh`'s own auth with a weaker credential (`Bad credentials` on writes) — `unset
  GITHUB_TOKEN GH_TOKEN` after sourcing; and the file is `global-api-keys.env`, not the
  `global-api-keys` path some older notes use.

## 5. Verification State

- `GET /api/v1/deployments` before: 0; after redelivery: 1 (`in_progress`, `19dfd51b`).
- Hook delivery log after repair: redelivery accepted (no "Invalid signature").
- `bash scripts/verify-deploy-sha.sh 19dfd51b` — **PASS at ~04:47Z**:
  `live 19dfd51bfea23d335fe99fa2be33be49189d07fe contains 19dfd51b...` — production cut
  over to main HEAD ~40 min after the redelivery (fresh `processUptimeSeconds: 182` at
  probe time; the brief non-JSON window mid-watch was the container restart). The repair
  is proven end-to-end: merge -> webhook -> deployment -> live.
- Post-deploy spot-check of finding 27 (health-route minimization) in prod: unauthenticated
  `/api/health` no longer returns `openrouterCredits.remainingUsd/totalUsd/usedUsd` or the
  raw `storage.*Bytes` fields (payload ~4KB -> 2.2KB). Residual: `schedulerLease.owner`
  (a `pid:uuid` identifier) is still public — small follow-up filed.
- No repo code changed in this effort; docs only (`STATUS.md`, `AGENTS.md`, this note,
  effort boards). Gate = docs-only CI fast path.

## 6. Next Steps & Blockers

- If future main pushes stop deploying again with green 200s on the hook page, **read the
  delivery response body first** (`.response.payload`) — that is where Coolify says what it
  actually did.
- Open question for the owner: why the secrets drifted. If the app recreation (uuid
  `socratic-app`) regenerated `manual_webhook_secret_github` while the hooks kept the old
  secret, this will recur on any future app recreation — re-sync the hook secret as part of
  the app-recreate recipe.
- Remaining from the remediation effort: npm 11.16 `EALLOWSCRIPTS` durable fix; owner
  decisions on FMP/Massive plans.
