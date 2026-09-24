# Socratic-Trade — Security, Reliability, and Disaster-Recovery Audit

**Date:** 2026-08-17  
**Tree:** `4980322b` (`main` at audit start; live `/api/health` release sha matched)  
**Method:** Read-only static review of auth, secrets, isolation, spend, logging, CI, Docker, Litestream, deploy, and alerting paths, plus a sanitized production probe of public `/api/health` and token-gated `/api/ops/snapshot`.  No secret values, account numbers, emails, or user IDs are reproduced here.  
**Roles applied:** application security, SRE, incident command, compliance review, chaos/resilience.  
**Scope:** this repository and the production Coolify app on the single Hetzner host.  No host SSH, no Infisical dump, no secret files opened.

This is a **report-only** audit.  It does not change runtime behavior.

---

## 1. Executive summary

The money-path and tenant-isolation story is substantially stronger than the 2026-06-29 / 2026-07-01 audits.  Prior P0s (timing-unsafe admin compare, chat/scan rate limits, RH OAuth plaintext, `decryptValue` plaintext fallback, identity-header IDOR, NODE_ENV-based auth fail-open) are **closed in code**.  Production is armed (`AUTH_SECRET` present — anonymous `/api/*` is 401; live health is 200 with Litestream `replicating`).

The residual risk that still matters is **operational, not an open internet IDOR**:

1. **Disaster recovery is unrehearsed on the current topology.**  Litestream writes to Backblaze B2.  The in-repo restore drill still targets Mac paths and historic R2.  `docs/litestream.md` still says restore has never been exercised.  A restored DB is useless if `ENCRYPTION_KEY` no longer decrypts broker/LLM rows — that check is not in any recorded drill.
2. **Single-host SPOF.**  ST + CT + UM + Coolify share `<PROD_ORIGIN_IP>`.  Oracle suspension (2026-08-06) already produced fleet-wide 522s.  There is no hot standby.
3. **Rolling-deploy dual Litestream writer** remains the structural cause of L2/L3 wedges.  Detection is live and currently green (`litestreamTiersDegraded: false`, five tiers observed).  The next rolling deploy can re-break compaction.
4. **Shared static tokens have a wide blast radius.**  Ops snapshot falls back to `ADMIN_REINDEX_TOKEN` when `OPS_DIAGNOSTIC_TOKEN` is unset.  One leaked value is both a paid-admin bypass and a cross-tenant diagnostic dump (includes account numbers).
5. **Health 200 is not a trading SLO.**  Scheduler staleness, storage degradation, OpenRouter credits, and trading-liveness never flip `/api/health` to 503 (by design, to avoid restart-halt loops).  External monitors that only watch HTTP 200 will miss a silent autonomy stop.
6. **Spend ceilings default OFF.**  Per-user LLM daily budgets exist but are infinite unless policy/env sets them.  There is no global operator ceiling.

**Verdict:** not “unauthenticated trading as another user.”  The realistic incident is **host loss or untested restore**, **token leak → cross-tenant ops data**, or **autonomy running on delayed quotes / failed Green Team while health stays green**.

---

## 2. Severity and exploitability rubric

| Severity | Meaning |
|----------|---------|
| **P0** | Unauthenticated or single-misconfig path to act as the primary operator, place orders as another tenant, or lose the only recoverable copy of the trading DB without detection. |
| **P1** | High blast radius that needs an owner action (DR drill, deploy strategy, token split, alert that actually pages).  Exploit needs a leaked token, admin session, or a real outage. |
| **P2** | Defense-in-depth, compliance drift, spend, or reliability gap with a working compensating control. |
| **P3** | Hygiene, documented-by-design fail-open, or residual from a closed finding. |

| Exploitability | Who can trigger it |
|----------------|--------------------|
| Unauth internet | No session |
| Auth user | Any signed-in tenant |
| Admin session | `ADMIN_USER_EMAILS` / primary + verified provenance |
| Token leak | `OPS_DIAGNOSTIC_TOKEN` / `ADMIN_REINDEX_TOKEN` / webhook secrets |
| Misconfig | Missing `AUTH_SECRET` + CF flag, or Infisical drift |
| Insider / host | Root container, volume, or Infisical identity |
| Reliability | No attacker — crash, deploy, vendor, or disk |

---

## 3. Threat model

### 3.1 Assets

| Asset | Why it matters | Where it lives |
|-------|----------------|----------------|
| Broker API keys / RH OAuth tokens | Place real orders | SQLite `connected_accounts` / settings, AES-256-GCM via `ENCRYPTION_KEY` |
| LLM / data-provider keys | Spend and research integrity | `user_api_keys` (encrypted) + Connections UI; Infisical must not hold runtime LLM keys |
| Session JWT (`AUTH_SECRET`) | Account takeover | Auth.js cookie, HS256 |
| Trading DB (proposals, fills, policy, audit) | Money-path truth + learning | `/app/data/app.db` on one Hetzner volume (~5.16 GB live) |
| Vector corpus (Pinecone + local FTS) | Decision context | Tenant-scoped private namespaces + shared operator corpus |
| Ops snapshot | Cross-tenant autonomy + account numbers | `GET /api/ops/snapshot` behind a static token |
| Deploy webhook HMAC | Whether `main` actually reaches prod | Coolify `manual_webhook_secret_github` |

### 3.2 Actors

- Unauthenticated internet (Cloudflare-proxied origin is reachable; CF Access email header is **not** trusted alone).
- A second allowed user (`ALLOWED_EMAILS`) — isolation must hold.
- Compromised admin email session.
- Holder of a leaked static token (ops / admin / webhook / ingest).
- Compromised agent workstation or CI (gitleaks + fork-PR refusal mitigate repo leaks).
- Vendor (OpenRouter, Alpaca, Pinecone, B2, R2).
- The box itself (single host, container as root).

### 3.3 Trust boundaries

```
Browser / iOS
    │  Auth.js cookie  OR  Apple JWT  OR  CF Access JWT (JWKS + aud)
    ▼
middleware.ts  — strip identity headers, CSRF on /api mutations, fail-closed if auth armed
    │  x-authenticated-user-email + provenance
    ▼
Route handlers  — resolveRequestUserId ignores body/query userId
    │
    ├─ requireAdmin / authorizeOpsRequest / webhook HMAC
    ├─ AES-GCM credential decrypt (fail-closed to "")
    └─ SQLite (user_id predicates) + Pinecone tenant_scope
           │
           ├─ Litestream → B2 (active PITR)
           ├─ Weekly R2 cold snapshot (retain 1)
           └─ Host 6h sqlite .backup + Hetzner image (~24h)
```

### 3.4 Assumptions this audit does **not** independently prove

- Production `AUTH_SECRET` is set (strongly implied: unauthenticated API is not the primary-user fallback; Apple/session login works in the field).
- `ENCRYPTION_KEY` is a stable 64-hex value (prod refuses boot otherwise; process is up).
- Coolify webhook HMAC currently matches GitHub (live sha equals `main` HEAD at probe time — deploy path worked for this commit).
- `SENTRY_CRONS_ENABLED` on or off (not visible on public health).

---

## 4. Live production snapshot (2026-08-17 ~23:45Z)

Sanitized.  No tenant identifiers.

| Signal | Value | Meaning |
|--------|-------|---------|
| `GET /api/health` | HTTP 200, `ok: true` | Liveness green |
| Release sha | `4980322b48b797d88c8e1de7226fb50f680c45a9` | Matches audited `main` |
| Process uptime | ~1.5 h at probe (started 22:18Z) | Recent deploy |
| Scheduler age | 1–24 s | Tick alive |
| Trading liveness | 2 active / 2 autopilot / `degraded: 0` | Market closed; oldest completed run ~9.1 h |
| Litestream | `replicating`, age 22 s, `tiersDegraded: false`, 5 tiers observed, remote inventory `ok` | Backup **write** path healthy *right now* |
| R2 weekly | `cold-snapshots/app-2026-08-16.db`, age ~1.8 d | Last Sunday snapshot present |
| OpenRouter credits | `ok: true` vs $3 threshold (USD omitted on public view) | Credits probe not alarming |
| SQLite | ~5.16 GB DB, **~149 MB WAL**, ~52 GB free of ~161 GB | WAL is large; disk not tight |
| Tenancy (ops) | 2 users, 7 accounts, 2 `active`+`decide` | Multi-tenant is real, not theoretical |
| Recent runs (ops, n=5) | 4 failed / 1 completed | Green Team OpenRouter 400s + one stale-run sweep after restart |
| Retired FilingAPI | Still `ok: false` / HTTP 401 on **ops** dependency map | Leftover `provider_health` row; public health no longer lists it as a 503 lane |

**Incident-command read:** the platform is up, backups are streaming, and autonomy is armed.  Recent run failures are model/vendor 400s and a mid-run restart, not an auth breach.  WAL ~149 MB and untested restore remain the reliability debt.

---

## 5. Findings

### 5.1 Auth and session

#### CTRL-AUTH-1 — Auth fail-closed when armed (control, not a bug)

**Severity:** — (positive)  
**Evidence:** `middleware.ts:163-167`, `:384-418`.  `isAuthConfigured()` is `AUTH_SECRET` **or** `CF_ACCESS_TRUST_EMAIL_HEADER`, deliberately **not** `NODE_ENV` (Next inlines `NODE_ENV` at build time on the edge — the old IDOR).  Missing identity → 401 `/api/*` or `/login`.  
**Exploitability:** Misconfig only.

#### F-AUTH-1 — Unarmed production maps every request to the primary operator

**Severity:** P0 (latent / misconfig)  
**Exploitability:** Unauth internet, only if **both** `AUTH_SECRET` and CF Access trust are unset.  
**Evidence:** `middleware.ts:384-388` sets `trustedEmail = PRIMARY_EMAIL` (default `mail@jays.services`) with source `local-fallback`.  `src/lib/auth/identity.ts` maps that to userId `local`.  
**Failure mode:** A Coolify env wipe or a “dev-like” image without secrets makes the public origin the owner’s trading desk.  
**Mitigations already in tree:** admin **email** path rejects `local-fallback` (`src/lib/auth/admin.ts:96-99`); production refuses boot without `ENCRYPTION_KEY` (`src/lib/db-api-keys.ts:103-110`).  Admin **token** still works if `ADMIN_REINDEX_TOKEN` is set.  
**Fix:** Boot-refuse in production when `!isAuthConfigured()` (mirror the encryption-key assert).  Alert if `identitySource=local-fallback` is ever seen in prod logs.

#### CTRL-AUTH-2 — Cloudflare Access header is never trusted alone

**Severity:** — (positive)  
**Evidence:** `middleware.ts:170-254`.  Requires flag + team domain + audience + verified `Cf-Access-Jwt-Assertion` + email match.  Any failure ignores the header.

#### CTRL-AUTH-3 — Client identity headers cannot spoof a user

**Severity:** — (positive)  
**Evidence:** `src/lib/auth/strip-identity.ts`; applied on public and authed paths (`middleware.ts:306-310`, `:422-428`).  `resolveRequestUserId` ignores body `userId` (`src/lib/request-user.ts:50-56`).  Tombstoned accounts cannot be re-entered with a stale JWT (`user-write-fence.ts` via `resolveAuthenticatedAccountGeneration`).

#### F-AUTH-2 — CSRF fail-open when the browser sends no origin signals

**Severity:** P3 (by design)  
**Exploitability:** Not a classic browser CSRF (no cookies attached without a browser).  Server-to-server / curl / old clients allowed.  
**Evidence:** `src/lib/auth/csrf.ts:95-97`.  Fail-closed on positive `Sec-Fetch-Site: cross-site` or Origin/Referer mismatch.  
**Note:** Public prefixes return **before** CSRF (`middleware.ts:306-310`), which is correct for webhooks.

#### F-AUTH-3 — Apple mobile login skips CSRF (login CSRF)

**Severity:** P2  
**Exploitability:** Unauth internet + attacker-controlled Apple identity that `isEmailAllowed` accepts.  Victim visits a page that POSTs the attacker’s Apple token to `/api/mobile/auth/apple`; victim’s browser stores the attacker’s session cookie.  
**Evidence:** `/api/mobile/auth/apple` is in `PUBLIC_PREFIXES` (`middleware.ts:80`).  Handler verifies Apple JWKS then sets the session cookie (`app/api/mobile/auth/apple/route.ts`).  Contrast: `/api/mobile/auth/exchange` is **not** public and **does** run CSRF (`middleware.ts:335-341`).  
**Fix:** Require `Sec-Fetch-Site: same-origin` (or a one-time state) on the Apple POST, same as exchange.

#### F-AUTH-4 — Session lifetime is Auth.js default (no explicit `maxAge`)

**Severity:** P3  
**Exploitability:** Stolen cookie usable until Auth.js default expiry (typically 30 days) unless the account is tombstoned.  
**Evidence:** `src/lib/auth/auth.ts:104-123` — JWT strategy, cookie flags only when `AUTH_COOKIE_DOMAIN` is set (`httpOnly`, `sameSite: lax`, `secure` in prod).  No `session.maxAge`.  Production cookie name `__Secure-authjs.session-token` when domain override is used.  
**Fix:** Set an explicit `maxAge` and document idle vs absolute timeout.  Confirm host-only cookie flags when `AUTH_COOKIE_DOMAIN` is unset (NextAuth defaults — not pinned in-repo).

#### F-AUTH-5 — Auth.js still on beta

**Severity:** P2  
**Exploitability:** Supply-chain / missing patch velocity.  
**Evidence:** `package.json` `next-auth: ^5.0.0-beta.31`.  Open since 2026-06-29 audit #27.  
**Fix:** Track Auth.js stable; pin and upgrade when the v5 stable line exists.

#### CTRL-AUTH-4 — Robinhood OAuth callback is state-bound

**Severity:** — (positive)  
**Evidence:** Start is session-gated + rate-limited.  Callback is public but bound to a server-side OAuth `state` row (`app/api/auth/robinhood/callback/route.ts`).  Tokens encrypted at rest (`src/lib/mcp-oauth.ts`).

---

### 5.2 Permissions and public surface

#### F-PERM-1 — Ops snapshot is a cross-tenant dump behind one static token

**Severity:** P1  
**Exploitability:** Token leak (env, transcript, mis-sent header).  Unauth internet if the token is known.  
**Evidence:** `/api/ops` is a public prefix (`middleware.ts:56`).  `authorizeOpsRequest` (`src/lib/ops-auth.ts:17-37`) accepts `x-ops-token`, legacy `x-admin-token`, or Bearer.  If `OPS_DIAGNOSTIC_TOKEN` is unset, **`ADMIN_REINDEX_TOKEN` is sufficient**.  Snapshot includes every user, account numbers, autonomy, run summaries (`src/lib/ops-snapshot.ts:55-83`, `:308-386`).  Unset token → fail-closed 401.  
**This audit used the token and confirmed 2 users / 7 accounts / account-number fields present in the schema.**  Values are not published here.  
**Fix:** Require `OPS_DIAGNOSTIC_TOKEN` exclusively in production (no admin-token fallback).  Drop `accountNumber` from the default snapshot or hash it.  Rotate both tokens if they have ever been equal.

#### F-PERM-2 — Admin email is enough for most `/api/admin/*` in production

**Severity:** P2  
**Exploitability:** Compromised admin session (no second factor on the route).  
**Evidence:** `requireTokenInProd: true` only on cost/side-effecting backfills: `sec-ingest`, `reindex-8k`, `reindex-10k`, `reembed`, `earningscalls`.  Server metrics, knobs, llm-usage, learning-ledger, rag-coverage, r2-usage, backup-status, congress-share, backtest-ic, data-catalog, emit-test, robinhood-probe, etc. accept verified admin email **or** the static token (`src/lib/auth/admin.ts:81-104`).  
**Mitigation:** Email path requires verified CF/Auth.js provenance, not `local-fallback`.  Token compare is constant-time (`timingSafeEqualStr`).  
**Fix:** Split “read admin” vs “mutate admin.”  Put knobs / emit-test / congress-share behind `requireTokenInProd` or a WebAuthn/step-up.

#### F-PERM-3 — Middleware does not validate admin or ingest tokens

**Severity:** P3 (documented)  
**Evidence:** `middleware.ts:401-411` lets bearer/`x-admin-token` through to `/api/admin/*` and two market-price paths.  Handlers call `requireAdmin` / `verifySecuritiesImportToken`.  Safe if every handler remembers; a new admin route that forgets `requireAdmin` is an unauthenticated sink.  
**Fix:** A test that every `app/api/admin/**/route.ts` calls `requireAdmin` (partially exists: `test/admin-operation-route-wiring.test.ts` for guarded ops).  Expand to all admin files.

#### CTRL-PERM-1 — Webhooks fail closed without secrets

**Severity:** — (positive)  
**Evidence:** TradingView shared-secret in JSON body, constant-time, reject if unset (`src/lib/technical.ts` + `app/api/webhooks/tradingview/route.ts`).  Congress HMAC or Bearer, reject if `CONGRESS_WEBHOOK_SECRET` unset (`app/api/webhooks/congress/route.ts:25-58`).  TV cannot do HMAC (vendor limit) — P3 residual.

#### CTRL-PERM-2 — Public `/api/health` projection is tight

**Severity:** — (positive)  
**Evidence:** `app/api/health/route.ts:68`, `:323-325`, `:411-412`.  USD balances, disk byte counts, and raw lease PID need the ops token.  Public view still exposes Litestream state, scheduler age, trading-liveness **counts**, and R2 weekly key name — acceptable for UptimeRobot.

#### F-PERM-4 — Marketing/framework routes are public by design

**Severity:** P3  
**Evidence:** `PUBLIC_PREFIXES` includes `/strategy`, `/framework`, `/api/framework`.  Framework content requires UA + `x-framework-viewer` + same-origin fetch metadata.  Prose only.

---

### 5.3 Tenant isolation

#### CTRL-ISO-1 — Proposal / order / account mutations are user-scoped

**Severity:** — (positive)  
**Evidence:** `getProposal(id, userId)`, `getProposalsByIds(..., userId)`, SQL `AND user_id = ?` (`src/lib/db-proposals.ts`).  Approve/reject/bulk-approve resolve session user first.  Order cancel uses `getPolicy(userId)` and account mismatch guards.  `connectedAccountId` query params are filtered through `getConnectedAccount(id, userId)` (e.g. strategy tune).

#### CTRL-ISO-2 — Pinecone private namespace is hashed per user

**Severity:** — (positive)  
**Evidence:** `vectorTenantScope` → `private:<sha256(userId)>` or shared `shared:operator` (`src/lib/vector-db.ts` ~2122-2127, query filters ~6690+).  Shared/managed corpus is intentional operator-wide research data, not another user’s broker book.

#### CTRL-ISO-3 — Learned-context share is opt-in fact-tier

**Severity:** — (positive)  
**Evidence:** `contributeShared` writes `scope='shared'` for fact-tier only; reads honor `includeShared`; delete is `id + user_id`.

#### F-ISO-1 — Shared RAG corpus is cross-tenant by design

**Severity:** P3 (product)  
**Exploitability:** Auth user can retrieve operator-shared filings/transcripts.  They cannot read another user’s private namespace or broker keys.  
**Note:** Do not “fix” this by isolating 10-Ks per user — that would multiply Pinecone WU spend.  Document it in the privacy policy (currently omitted).

---

### 5.4 Secrets and encryption

#### CTRL-SEC-1 — Production refuses to boot without a valid `ENCRYPTION_KEY`

**Severity:** — (positive)  
**Evidence:** `assertEncryptionKeyConfiguredInProduction` (`src/lib/db-api-keys.ts:103-110`), called from `instrumentation.ts`.  AES-256-GCM, `v1:iv:tag:ct` envelope, 12-byte IV.  `decryptValue` returns `""` on non-envelope or auth failure (P0-5, 2026-08-05).  Legacy plaintext is re-encrypted at boot, not returned to callers.

#### F-SEC-1 — Dev/test mint a per-process random key

**Severity:** P2 (dev footgun; prod blocked)  
**Evidence:** `src/lib/db-api-keys.ts:71-91`.  Credentials written in a mis-set staging env become unreadable after restart.  
**Fix:** Refuse boot in any `DB_BOOTSTRAP=live` / Coolify image, not only `NODE_ENV=production`.

#### CTRL-SEC-2 — Infisical safe-set refuses LLM runtime names

**Severity:** — (positive)  
**Evidence:** `scripts/infisical-secrets-safe.sh` refuses `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `KIMI_API_KEY`, `OPENROUTER_API_KEY`, etc.  `migrateLocalEnvCredentials` honors delete tombstones; Gemini/DeepSeek are not auto-seeded (`src/lib/db-api-keys.ts` ~1067-1126).  
**Residual:** A human can still `infisical secrets set` outside the wrapper.  Owner policy is operational.

#### CTRL-SEC-3 — Repo hygiene

**Severity:** — (positive)  
**Evidence:** `.gitignore` covers `.env*`, `*.p8`, `*.db`, `data/`.  `.gitleaks.toml` + weekly + PR `security.yml` on `ubuntu-latest`; fork PRs refused.  No `curl | bash`.  No production secret literals found in `src/`, `app/`, or `scripts/` (names and test fakes only).  This audit did not open `~/.secrets/` or Infisical.

#### F-SEC-2 — No `ENCRYPTION_KEY` rotation / dual-key unwrap

**Severity:** P2  
**Exploitability:** Insider or backup restore onto a box whose current key is not the key that wrapped rows.  
**Failure mode:** Restore “succeeds” (`PRAGMA integrity_check` OK) while every broker/LLM decrypt returns `""` — autonomy looks “no keys” and cannot trade; owner may re-paste keys into a DB that still holds the old ciphertext.  
**Fix:** Envelope version `v2:` plus a restore-drill decrypt assertion (see F-DR-1).

---

### 5.5 Logging, PII, compliance

#### CTRL-PII-1 — Telemetry redaction defaults are safe

**Severity:** — (positive)  
**Evidence:** `redactForTelemetry` (`src/lib/telemetry-sanitize.ts`) redacts key names and secret-shaped values.  Sentry `sendDefaultPii: false` + `beforeSend` on server/edge/browser.  Langfuse default `LANGFUSE_CAPTURE_IO=summary`.  Session Replay (if enabled) masks text and blocks media.  No production `console.log` of raw key/token/cookie values found.

#### F-PII-1 — `audit()` persists raw JSON, including account numbers and full prompts

**Severity:** P2  
**Exploitability:** DB leak, volume snapshot, or Litestream object read.  User-facing `GET /api/audit` is session-scoped; ops snapshot **sanitizes** returned detail (`src/lib/ops-snapshot.ts:184-212`) but the table still holds the raw payload.  
**Evidence:** `audit()` in `src/lib/db.ts` ~3410-3448 does `JSON.stringify(payload)` with no redaction.  Call sites include account numbers (`post-mortem.ts`, `order-cancel.ts`) and full strategy prompt text on change (`db-profiles.ts` ~618-620).  Tamper-evident hash chain (P0-4) protects integrity, not confidentiality.  
**Fix:** Redact `accountNumber` / credential-shaped keys at write time (reuse `redactForTelemetry`).  Cap prompt payloads.  Account deletion already purges `audit_events` (`src/lib/account-deletion.ts`).

#### F-PII-2 — Privacy policy does not describe in-app deletion or shared RAG

**Severity:** P2 (compliance / accuracy)  
**Evidence:** `app/privacy-policy/page.tsx` §§6–7 say deletion is “by contacting us.”  Product has `POST/DELETE /api/account/deletion` and mobile confirm with typed `DELETE MY ACCOUNT`.  Shared learned-context / operator RAG corpus is not disclosed.  Sentence spacing on legal pages also drifts from the fleet two-space rule (cosmetic).  
**Fix:** Name the self-serve deletion ritual, retention of encrypted backups (B2/R2/host snapshots until TTL), and shared research corpus.

#### F-PII-3 — CSP report may log `document-uri` query strings

**Severity:** P3  
**Evidence:** `app/api/csp-report/route.ts` logs sliced `document-uri` (200 chars).  Body capped at 16 KiB (2026-08-01 DoS fix).  Public unauthenticated POST.

#### F-PII-4 — CSP is report-only / default-off with `unsafe-inline` + `unsafe-eval`

**Severity:** P2  
**Evidence:** `middleware.ts:117-158`.  HSTS, `X-Frame-Options: DENY`, `nosniff`, Referrer-Policy, Permissions-Policy always on.  Enforcing CSP would break Next inline bootstrap until the policy is tightened.  
**XSS sinks:** LLM markdown uses `react-markdown` without `rehype-raw`; images blocked.  `dangerouslySetInnerHTML` is static JSON-LD / theme script only.

---

### 5.6 Supply chain and container

#### F-SUP-1 — Container runs as root

**Severity:** P2  
**Exploitability:** Container escape → root on the shared Hetzner host (ST+CT+UM+Coolify).  
**Evidence:** `Dockerfile:66-73` — `USER root` documented after `USER node` crash-looped on Coolify volume perms.  Secrets are not `COPY`’d; Infisical at runtime.  Base `node:24.14.1-bookworm-slim` pinned.  
**Fix:** When volume ownership allows, run as uid 1000 and keep a root step only for the start-script mkdir.

#### CTRL-SUP-1 — CI does not execute untrusted fork code with secrets

**Severity:** — (positive)  
**Evidence:** `ci.yml` and `security.yml` refuse fork PRs.  `pull_request_target` auto-merge workflows do **not** checkout PR code.  Dependabot weekly on npm (`.github/dependabot.yml`).  Overrides pin `axios ^1.18.0` and `postcss ^8.5.15`.  Lockfile present.

#### F-SUP-2 — Security workflow comment still mentions retired self-hosted runners

**Severity:** P3 (docs drift)  
**Evidence:** `.github/workflows/security.yml:24-25` comment still talks about Coolify `socratic-ci`.  Job actually uses `ubuntu-latest`.  Harmless, but this class of drift already caused fake “healthy runners” in server-metrics (2026-08-13).

---

### 5.7 Fail-open / fail-closed (money path and data)

| Path | Posture | Evidence | Finding |
|------|---------|----------|---------|
| Red Team `debateProposal` | **Fail-closed** → human | `src/lib/red-team.ts:161-167`, `src/lib/red-team-routing.ts:74-87` | Openings always hold.  Exits hold unless `deRiskExitsOnAdversaryUnavailable` (default off). |
| Inline Bear LLM | **Removed** | `src/lib/strategy.ts` ~6286 | 2026-07-01 fail-open is gone. |
| Auth (armed) | **Fail-closed** | `middleware.ts:413-418` | See F-AUTH-1 if unarmed. |
| Credential decrypt | **Fail-closed** → `""` | `db-api-keys.ts:163-181` | Missing key ≠ plaintext leak. |
| Webhooks without secret | **Fail-closed** | TV + Congress routes | — |
| Rate limiter internal error | **Fail-open** | `src/lib/rate-limit.ts:114-116` | F-REL-3 |
| LLM daily budget unset | **Fail-open** (infinite) | `src/lib/llm-budget.ts:10-12`, `:31-36` | F-SPEND-1 |
| Policy read failure inside budget check | **Degrade to env limit** | `llm-budget.ts:55-66` | Bookkeeping must not break LLM — explicit. |
| Pinecone monthly WU marker storage error | **Fail-open** (writes proceed) | `pinecone-wu-breaker.ts:75-76`, `:93-95` | Acceptable; trial window now ignores leftover 2M marker. |
| OpenRouter `/models/user` timeout | **Fail-open** to filtered catalog | `src/lib/model-rotation.ts:232-244` | Known-dead slugs dropped (2026-08-16).  Still not fail-closed. |
| OpenRouter credits read error | **Fail-open** (last good / no page) | `src/lib/openrouter-credits.ts:11-13` | F-ALERT-2 |
| Quote cascade | **Fail-open** to delayed Yahoo | `src/lib/quotes-cascade.ts:302-371` | F-REL-1 |
| `VECTOR_ASOF_STRICT` code default | **Fail-open** (undated chunks admitted) | `src/lib/dormant-features.ts:65-69` | Prod Infisical flipped **on** 2026-08-16 (`STATUS.md`).  Live desk still omits `asOf`. |
| Broker connectivity halt | **Fail-closed** after 3 streaks; OMS fail **immediate** | `src/lib/broker-health.ts:9-11`, `:82-90`, `:230-279` | Good. |
| `/api/health` trading/storage/credits | **Fail-open 200** | `app/api/health/route.ts:86-88`, `:113-118`, `:451-495` | F-ALERT-1 |

#### F-REL-1 — Autopilot can trade on 15–20 minute Yahoo tape

**Severity:** P1 (correctness / money)  
**Exploitability:** Reliability (Alpaca socket death).  
**Evidence:** 2026-08-14 incident — `UND_ERR_SOCKET` on Hetzner keep-alives, cascade to Yahoo delayed ~1200 s (`docs/rollouts/2026-08-14-stale-quotes-origin-timeouts.md`).  Retry + 3-streak halt shipped; delayed-tape trading is still possible between retries.  
**Fix:** Treat quote age above a policy threshold as a halt (owner-adjustable, default honest), not a silent Yahoo win.

#### F-REL-2 — Rate limit is process-local and fail-open on error

**Severity:** P2  
**Evidence:** `src/lib/rate-limit.ts:114-116`.  Admin operation guards are also process-local (`src/lib/admin-operation-guard.ts` header).  Single Next process today; a second replica would double the budget.  
**Fix:** Document “one process” as an SLO assumption.  If Coolify ever scales out, move limits to SQLite.

---

### 5.8 Runaway spend

#### F-SPEND-1 — Per-user LLM/RAG daily ceiling defaults to infinity

**Severity:** P2  
**Evidence:** `src/lib/llm-budget.ts:10-12`.  Enforcement at `withLlmGeneration` / `retrieveContextDetailed` is fail-closed **when a limit is set**.  Chat 30/min, scan 30/min, orders 20/min, oauth 10/min (`src/lib/rate-limit.ts:121-135`).  Admin backfills have per-op 429/409 guards.  
**No global operator USD ceiling** (called out in 2026-07-04 design review; still true).  
**Live:** 1 of 2 users has an LLM key configured; OpenRouter public probe is above the $3 flag.  Recent Green Team failures are 400s (wasted retries, not a runaway success loop).

#### CTRL-SPEND-1 — Pinecone write fuse + monthly breaker exist

**Severity:** — (positive, with residual)  
**Evidence:** Daily WU fuse + monthly breaker (`src/lib/pinecone-wu-breaker.ts`).  Standard trial (through 2026-08-30) correctly ignores the Starter 2M monthly wall (commit `4980322b`).  Breaker fails open on storage errors.  Reads stay up when writes park.

#### F-SPEND-2 — Stripe is not an app control plane

**Severity:** P3 (info)  
**Evidence:** No Stripe charge path in application `src/` / `app/`.  Provider spend is key- and budget-based.  Do not charge ST Stripe for third-party Plus plans (owner rule; FilingAPI retirement).

---

### 5.9 Alerting and incident detection

#### F-ALERT-1 — HTTP 200 is not “trading works”

**Severity:** P1  
**Exploitability:** Reliability — silent autonomy death.  
**Evidence:** DB unreadable or hard-stopped Pinecone/Alpaca/rag-embed/rerank (≥5 consecutive failures) → `ok: false` → 503.  Scheduler stale (>5 min), trading-liveness degraded, `storageDegraded`, OpenRouter credits, data-provider tier mismatch → **flags only**, still 200 (`app/api/health/route.ts:86-88`, `:113-118`, `:294-329`, `:451-495`).  Trading-liveness comment is explicit: a 503 would restart the container and re-halt autonomy (boot interlock).  
**Live:** health 200 while 4/5 recent strategy runs failed and oldest completed run is ~9 h (market closed — expected, but the same shape is “Green Team dead all morning”).  
**Fix:** Dedicated UptimeRobot/Pushover monitors on JSON fields (`schedulerStale`, `tradingLiveness.degraded`, `storage.litestreamTiersDegraded`, `openrouterCredits.ok`) — not HTTP status.  Confirm `SENTRY_CRONS_ENABLED=1` for `scheduler-tick`.

#### F-ALERT-2 — Credits and keyword monitors still couple to `/api/health`

**Severity:** P2 (partially mitigated)  
**Evidence:** 1.5 s credits budget (`app/api/health/route.ts:308-312`).  Deploy 503s historically paired with a “credits low” keyword monitor.  Credits read fail-open on network error.  
**Fix:** Keyword monitors should watch a dedicated `/api/health?probe=credits` or the Usage Monitor, never the liveness URL.

#### F-ALERT-3 — Deploy webhook HMAC drift is invisible to health

**Severity:** P1  
**Evidence:** `docs/rollouts/2026-08-02-deploy-webhook-secret-repair.md` — GitHub delivery **200** + body `Invalid signature` → **zero Coolify deploys** while `main` advanced.  `scripts/verify-deploy-sha.sh` is the after-the-fact check (containment, not equality).  This probe: live sha **equals** `main` HEAD, so the hook worked for `4980322b`.  
**Fix:** A scheduled job that pages if public `.checks.release.sha` is not an ancestor of `origin/main` within N minutes.  Do not hand-trigger Coolify (auto-deploy protocol).

#### CTRL-ALERT-1 — Operator paging exists

**Severity:** — (positive)  
**Evidence:** Pushover preferred over Resend (`src/lib/notify.ts`).  Provider hard-stop → Sentry + Pushover (`src/lib/db-health.ts`).  Storage warnings 12 h cooldown.  Sentry Crons optional (`src/lib/scheduler.ts:224-238`).

---

### 5.10 Backups, Litestream, restore, DR

#### F-DR-1 — Litestream **restore** is still unproven on the current topology

**Severity:** P1  
**Exploitability:** Reliability / disaster.  
**Evidence:** `docs/litestream.md:97-114` — “Restore has NOT yet been exercised.”  `scripts/litestream-restore-drill.sh:23-24` still defaults to `/Users/jay/apps/trading-live` and historic **R2** `litestream.yml`.  Production active replica is **B2** via `litestream.coolify.yml` (`docs/litestream.md:6-10`, `docs/rollouts/2026-08-07-litestream-b2-backup.md`).  Host weekly drill (`fleet-backup-verify-weekly.sh`) checks **local** 6 h snapshots, not Litestream PITR, and does not decrypt `ENCRYPTION_KEY` envelopes.  
**Failure mode:** Replication looks healthy (it did at 23:45Z) while restore, config path, B2 read creds, or key unwrap fail.  RPO claimed ~60 s (`sync-interval: 60s` in `litestream.coolify.yml`) is unverified.  
**Fix (owner, on the box):** restore B2 → scratch, `PRAGMA integrity_check`, compare `max(audit_events.created_at)` vs live, decrypt one stored credential, `audit('backup_restore_drill', {ok, rpoSeconds, integrity, decryptOk})`, write `docs/rollouts/YYYY-MM-DD-litestream-restore-drill.md`.  Then rewrite the drill script for Coolify/B2 paths.

#### F-DR-2 — Rolling deploy can wedge L2/L3 again

**Severity:** P1 (structural) / currently **not firing**  
**Evidence:** `docs/rollouts/2026-08-14-empty-tier-wedge-detection.md` — two Litestream 0.5.12 writers, no fencing, `ltx.IsContiguous` breaks, L2/L3 stay empty.  Detection: `assessLitestreamTierFreshness` + 30 m remote inventory; empty level with a full feeder → `wedged`.  **Live:** `litestreamTiersDegraded: false`, five tiers observed, compaction log failures 0.  Root cause (rolling + no fence) is **not** a code fix in this tree.  
**Fix:** Coolify recreate / stop-old-first (owner).  Keep L9 as restore floor.  Do not “fix” by deleting B2 objects from an agent session.

#### F-DR-3 — R2 weekly retain-1

**Severity:** P2  
**Evidence:** `src/lib/r2-cold-snapshot.ts:9-14` — default retain 1 because one ~4.2–5.2 GB copy is most of the 10 GiB free tier.  Live object `app-2026-08-16.db`.  A corrupt weekly upload leaves **zero** good cold copies.  Not folded into 503.  
**Fix:** If budget allows, retain 2 and accept paid R2, **or** keep the Hetzner 6 h snapshots as the second copy (already exist) and document that retain-1 is acceptable **because** of that layer.

#### F-DR-4 — Marker-guarded boot restore can overwrite live WAL

**Severity:** P2  
**Evidence:** `scripts/coolify-prod-start.sh:170-181` — `DB_BOOTSTRAP=live` + missing `.restored-from-replica` → `litestream restore` then write marker.  Deleting the marker and restarting replaces the volume DB with the replica point.  
**Fix:** Require an explicit `FORCE_RESTORE=1` in addition to a missing marker.

#### F-DR-5 — Single Hetzner host is the availability domain

**Severity:** P1  
**Evidence:** `docs/rollouts/2026-08-07-hetzner-fleet-cutover.md`.  Oracle suspension 2026-08-06 = fleet 522s.  Layers: Litestream B2 (~60 s if healthy), 6 h host sqlite backup, ~24 h Hetzner image.  No automated failover.  Container is root on the same box as Coolify.  
**RTO:** manual Coolify + DNS + restore + `ENCRYPTION_KEY` + broker reconciliation.  Not written as a timed runbook.  
**Fix:** One-page DR runbook with RTO/RPO targets (proposed in §8).  Do not add a second trading scheduler on a standby (dual-writer on broker accounts).

#### CTRL-DR-1 — Exit-0 contract and R2 kill-switch

**Severity:** — (positive / historical)  
**Evidence:** Exit 40/41/42/43 (`scripts/coolify-prod-start.sh`, `src/lib/exit-guard.ts`).  R2 free-tier kill-switch ignored when active replica is B2 (`src/lib/r2-usage.ts:754-756`).  Generic `.litestream-disabled` still stops all replication.

#### F-DR-6 — WAL ~149 MB at probe time

**Severity:** P2  
**Evidence:** Ops snapshot `walSizeBytes: 149094592` against a 5.16 GB DB.  Large WAL increases checkpoint I/O and Litestream L0 churn; a crash before checkpoint loses more than one sync interval of **uncheckpointed** pages if the replica lagged.  
**Fix:** Confirm `PRAGMA wal_autocheckpoint` / busy-timeout; page if WAL exceeds N MB for >T minutes (health already has disk/WAL byte fields behind the ops token).

---

### 5.11 Deploy and rollback

#### F-DEP-1 — Rollback is “owner knows Coolify,” not a script

**Severity:** P2  
**Evidence:** Auto-deploy on `main` (protocol: do not hand-trigger).  `verify-deploy-sha.sh` explicitly must not deploy.  No in-repo “redeploy previous sha” runbook.  Exit-0 / SIGTERM path is solid (`next` invoked directly, not `npm run`).  
**Fix:** Document Coolify previous-deployment click + `verify-deploy-sha.sh` expected ancestor.  Keep rolling-off as part of that doc (F-DR-2).

#### CTRL-DEP-1 — Scheduler single-leader defaults ON

**Severity:** — (positive)  
**Evidence:** `src/lib/scheduler.ts:146-152`.  CAS lease has a documented TOCTOU window (`src/lib/scheduler-lease.ts:7-11`) — P3 if a second replica appears.

---

### 5.12 Reliability SLOs and chaos

#### F-SLO-1 — No production SLO or error budget

**Severity:** P2  
**Evidence:** No committed availability/RPO/RTO numbers.  Aspirational Yahoo-floor SLO in old reviews only.  
**Proposed targets (for owner ratification, not invented as current policy):** see §8.

#### F-CHAOS-1 — Money-path fault injection is thin

**Severity:** P2  
**Evidence:** `test/strategy-money-path-f-g.test.ts` uses TestBroker + mocks.  Reviews (2026-07-04) asked for concurrency / 429-storm / partial-fill injection.  Not present as a harness.  ROIC 714-job crash loop (2026-08-16) was a real chaos event; single-flight is now in tree (`docs/rollouts/2026-08-16-roic-singleflight.md`).

#### F-REL-4 — Green Team vendor 400s while health is green

**Severity:** P2 (live)  
**Evidence:** Ops recent runs: OpenRouter `mistral-small-2603`, `gpt-5.6-terra`, `gpt-5.6-luna` 400s; one `Process restarted mid-run`.  Sibling work on slugs/failover is in flight on other branches.  Not a security hole; it is the current reliability incident shape.

---

## 6. Prior-audit residual tracker

| ID | Finding | Status 2026-08-17 |
|----|---------|-------------------|
| 2026-06-29 #8 | Admin token `===` | **Closed** — `timingSafeEqualStr` |
| 2026-06-29 #9 | Chat no rate limit | **Closed** — 30/min |
| 2026-06-29 #19 | RH OAuth plaintext | **Closed** — encrypt-at-rest; decrypt rejects plaintext |
| 2026-06-29 #27 | Auth.js beta | **Open** — F-AUTH-5 |
| 2026-06-29 #33 | No security headers | **Closed** — CSP still report-only / optional (F-PII-4) |
| 2026-06-30 S-6 | Ops token = admin token fallback | **Open** — F-PERM-1 |
| 2026-07-01 G1–G4 | Rate limit, OAuth encrypt, timing-safe, headers | **Closed** |
| 2026-07-01 Bear fail-open | Inline Bear | **Closed** — removed; Red Team fail-closed |
| 2026-07-01 restore drill | Never run | **Open** — F-DR-1 (script also stale vs B2) |
| 2026-07-01 `allowNonProd` admin bypass | Documented risk | **Closed** — current `admin.ts` has no env/hostname unauthenticated bypass |
| 2026-08-05 P0-4/P0-5 | Audit chain + decrypt reject | **Closed** |
| 2026-08-02 webhook HMAC | Silent freeze | **Control exists, not monitored** — F-ALERT-3 |
| 2026-08-14 L2 wedge | Dual writer | **Detected; root cause open** — F-DR-2 |
| 2026-08-14 delayed Yahoo | Stale tape | **Retry shipped; age-halt not shipped** — F-REL-1 |
| 2026-08-15 Infisical LLM keys | Reseed | **Closed** in code; ops discipline remains |

---

## 7. Prioritized fixes

Owner philosophy: harden **correctness** and **multi-user safety**, not paternal trading cages.  Fixes below are in that spirit.

### P0 — do now if the precondition is true

| ID | Action | Precondition |
|----|--------|--------------|
| F-AUTH-1 | Refuse boot in production when auth is unarmed | Only if `AUTH_SECRET` / CF flag can be absent.  Add the assert even if currently set. |

### P1 — this week, owner-gated where noted

| ID | Action | Who |
|----|--------|-----|
| F-DR-1 | B2 restore drill + `ENCRYPTION_KEY` decrypt receipt + rewrite drill script | Owner on the box |
| F-DR-2 | Coolify stop-old-first / consistent name already on; confirm **no overlapping Litestream writers** | Owner |
| F-DR-5 | One-page DR runbook (RTO/RPO, who clicks Coolify, do not start Mac `pm2 trading`) | Docs + owner |
| F-PERM-1 | Prod: ops token required, no `ADMIN_REINDEX_TOKEN` fallback; rotate if they ever matched | Code + Infisical |
| F-ALERT-1 | Page on `schedulerStale` / `tradingLiveness.degraded` / `litestreamTiersDegraded`, not HTTP 200 | UptimeRobot / Sentry Crons |
| F-ALERT-3 | Cron: live sha must be ancestor of `origin/main` | Script + notify |
| F-REL-1 | Quote-age halt (adjustable) | Code |

### P2 — next pass

| ID | Action |
|----|--------|
| F-AUTH-3 | CSRF/state on Apple mobile login |
| F-AUTH-5 | Auth.js stable track |
| F-PERM-2 | Step-up or token for mutating admin |
| F-PII-1 | Redact audit payloads at write |
| F-PII-2 | Privacy policy = self-serve deletion + backup TTL + shared corpus |
| F-PII-4 | Keep CSP report-only; tighten from reports; then enforce |
| F-SEC-2 | Dual-key unwrap + drill decrypt |
| F-SPEND-1 | Set env daily USD/token ceilings for the operator user; consider a global cap |
| F-SUP-1 | Non-root user when volumes allow |
| F-DR-3 / F-DR-4 / F-DR-6 | Retain-2 or document 6 h host copies; `FORCE_RESTORE`; WAL alarm |
| F-SLO-1 / F-CHAOS-1 | Ratify §8 SLOs; add 429/partial-fill money-path tests |
| F-DEP-1 | Rollback paragraph in `docs/deployment.md` |

### P3 — hygiene

| ID | Action |
|----|--------|
| F-AUTH-2 / F-AUTH-4 | Document CSRF fail-open; pin session `maxAge` |
| F-PERM-3 / F-PERM-4 | Exhaustive admin-route `requireAdmin` test |
| F-ISO-1 | Privacy wording only |
| F-SUP-2 | Delete stale runner comment |
| F-REL-4 | Continue slug/failover work on existing branches — do not duplicate here |

---

## 8. Proposed reliability SLOs (not currently policy)

For owner ratification.  Two spaces after sentences in any user-facing restatement.

| SLO | Proposed target | How to measure | Error-budget idea |
|-----|-----------------|----------------|-------------------|
| Origin liveness | 99.5% HTTP 200 on `/api/health` over 30 d | UptimeRobot | Exclude Coolify deploy windows |
| Scheduler heartbeat | Tick age < 120 s while the process is the leader | `schedulerAgeSeconds` + Sentry Crons | Page at 5 min (already flagged, not 503) |
| Backup freshness | Litestream sync age < 120 s; L2/L3 not `wedged` | Public health + remote inventory | Page on `litestreamTiersDegraded` |
| Restore confidence | Successful drill every 90 d including decrypt | New audit kind `backup_restore_drill` | Failed drill = P1 incident |
| RPO (host loss) | ≤ 5 min if B2 healthy; ≤ 6 h if only host sqlite | Drill `max(created_at)` delta | — |
| RTO (host loss) | ≤ 4 h to health 200 + broker reconcile (manual) | Tabletop + last cutover (2026-08-07) | — |
| Quote freshness (RTH, keyed path) | p95 age < 15 s; never silently > 120 s on autopilot | Cascade telemetry | Halt if over policy |
| LLM spend | Per-user daily cap set; no silent infinite | `llm-budget` + `/admin/llm-usage` | Page at 80% |

---

## 9. Chaos / resilience notes

What production has already taught, without a formal chaos suite:

| Event | Date | Lesson |
|-------|------|--------|
| Oracle account suspension | 2026-08-06 | Single-cloud SPOF is real; cutover to a new host is the DR plan |
| Litestream 0.5.14 tcp_mem | 2026-07-10 | Pin 0.5.12; do not casual-bump |
| Dual-writer L2 wedge | 2026-08-08–14 | Rolling deploy is a backup-integrity event |
| ROIC 714 stacked jobs | 2026-08-16 | Scheduler + ingest can crash the box every ~22 min |
| Alpaca `UND_ERR_SOCKET` | 2026-08-14 | Fail-open cascade ≠ safe tape |
| Webhook HMAC drift | 2026-08-01/02 | GitHub 200 is not “deployed” |
| Clean exit 0 stayed down | 2026-08-02 | `restart: unless-stopped` honors API stop; pid-1 must not fake 0 |
| FilingAPI 401 leftover | 2026-08-17 | Retired vendors still stain ops dependency maps |

Recommended next chaos **tests** (code, not prod): broker 429 storm, mid-approve process kill, Litestream IPC timeout, `ENCRYPTION_KEY` wrong-key decrypt, CSRF cross-site POST, ops token absent.

---

## 10. What we did **not** do

- Did not print, log, or commit any secret, token, account number, or email.
- Did not open `~/.secrets/`, Infisical, or Coolify env dumps.
- Did not SSH to `<PROD_ORIGIN_IP>` or run a restore.
- Did not change application code, flags, or monitors.
- Did not claim Paper/Test-mode safety — there is none; an account is an account.

---

## 11. References

- Prior: `docs/audit-2026-06-29.md`, `docs/reviews/2026-07-01-audit-work-split.md` Chat G, `docs/rollouts/2026-07-01-security-hardening.md`, `docs/rollouts/2026-08-05-p0-security-audit-chain-decrypt.md`, `docs/ops-observability-security.md`, `docs/litestream.md`
- Incidents: `docs/rollouts/2026-08-02-deploy-webhook-secret-repair.md`, `docs/rollouts/2026-08-02-exit0-outage-audit.md`, `docs/rollouts/2026-08-06-ios-login-522-oracle-down.md`, `docs/rollouts/2026-08-07-hetzner-fleet-cutover.md`, `docs/rollouts/2026-08-14-empty-tier-wedge-detection.md`, `docs/rollouts/2026-08-14-stale-quotes-origin-timeouts.md`
- Handoff for this report: `docs/rollouts/2026-08-17-security-reliability-audit.md`
