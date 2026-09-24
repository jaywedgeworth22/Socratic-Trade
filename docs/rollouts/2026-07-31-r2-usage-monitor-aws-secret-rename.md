# R2 free-tier usage monitor + AWS_* secret-name unification (2026-07-30/31)

## Context & objective

Owner directives (2026-07-30):
1. The app must monitor Cloudflare R2 usage against the monthly free tier
   (10 GiB storage, 1M Class A ops, 10M Class B ops) and alert whenever usage
   is *on pace* to exceed 70% of any metric — "never be on pace to use over
   70% of it for a month ever."
2. Unify the R2/S3 Infisical secret names between Socratic-Trade
   (`LITESTREAM_S3_*`) and Congress.Trade (`AWS_*`), renaming whichever side
   is cheaper — including code changes where needed.
3. Backups should move to the new `socratic-trade-bucket` on the
   SocraticTrade.com Cloudflare account (94ec35cf8b40d3bf9710c0e3320b2e79,
   token env `CLOUDFLARE_ST_API_TOKEN`) — the old account's R2 is
   `403 NotEntitled` since 2026-07-29 00:16 UTC.

## Changes made

**Code (this PR):**
- `src/lib/r2-usage.ts` (new) — R2 free-tier monitor. Pure, testable helpers
  (`classifyR2Action`, `r2MonthWindow`, `assessR2Usage`, `r2AlertTransitions`)
  plus the IO runner. Scheduler lane `r2-usage-check` (default every 6h,
  leader-only, watermark-first, self-guarded) queries the Cloudflare GraphQL
  Analytics API (`r2StorageAdaptiveGroups` latest-per-bucket,
  `r2OperationsAdaptiveGroups` MTD sums split into billing classes), projects
  month-end usage linearly, persists a snapshot (`r2usage:lastSnapshot`),
  and `notify()`s on threshold *transitions* only (crossed / recovered — no
  steady-state spam). Audits `r2_usage.check` every run.
  Env: `CLOUDFLARE_ST_API_TOKEN` + `CLOUDFLARE_ST_ACCOUNT_ID` (unset =
  disabled silently), `R2_USAGE_MONITOR_INTERVAL_HOURS` (6),
  `R2_USAGE_ALERT_THRESHOLD_PCT` (70), `R2_USAGE_BUCKET_FILTER` (optional).
- `src/lib/scheduler.ts` — lane registration next to `provider-tier-check`.
- `app/api/admin/r2-usage/route.ts` (new) — admin API returning the persisted
  snapshot (no live Cloudflare call on page load).
- `app/admin/page.tsx` — "R2 Storage Usage" card: per-metric meter bars with
  MTD % and projected month-end %, threshold annotation, last-check time.
- `test/r2-usage.test.ts` (new) — 18 tests: class mapping, month window,
  pace projection, alert transitions (crossed/steady/recovered), GraphQL
  parsing with mock fetch, full check run with mock notify.
- **Rename `LITESTREAM_S3_*` → Congress's `AWS_*` convention**:
  `LITESTREAM_S3_BUCKET`→`AWS_S3_BUCKET_NAME`,
  `LITESTREAM_S3_REGION`→`AWS_REGION`,
  `LITESTREAM_S3_ENDPOINT`→`AWS_S3_ENDPOINT`,
  `LITESTREAM_S3_ACCESS_KEY_ID`→`AWS_ACCESS_KEY_ID`,
  `LITESTREAM_S3_SECRET_ACCESS_KEY`→`AWS_SECRET_ACCESS_KEY`.
  Touched: `litestream.coolify.yml`, `litestream.yml`,
  `scripts/litestream-restore.sh`, `scripts/litestream-restore-drill.sh`,
  `scripts/coolify-prod-start.sh` (comment), `.env.example`, `docs/litestream.md`.

**Infisical ST prod (project 39d93bb7-76f9-498c-8b50-a7def52e072f):**
- Added the 5 `AWS_*` keys + `CLOUDFLARE_ST_ACCOUNT_ID` alongside the old
  `LITESTREAM_S3_*` set (transition safety — delete old set only after the
  new pipeline is verified working).
- `AWS_S3_BUCKET_NAME=socratic-trade-bucket`,
  `AWS_S3_ENDPOINT=https://94ec35cf…r2.cloudflarestorage.com`,
  `AWS_REGION=auto`. **NOTE: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
  currently hold the OLD account's R2 keys (hash-identical to the old
  `LITESTREAM_S3_*` values) — placeholders until the owner creates an R2 API
  token on the new account (dashboard → R2 → Manage R2 API Tokens → Object
  Read & Write on `socratic-trade-bucket`).** No API endpoint exists for
  creating permanent R2 tokens (verified against the Cloudflare OpenAPI
  spec — dashboard only).
- Mirrored the 7 new keys into the Coolify app env store (encrypted,
  `is_buildtime=false, is_runtime=true`) matching the 47-var sync pattern
  from the deploy-path repair.

## Decisions & trade-offs

- Renamed Socratic's side, not Congress's: `AWS_ACCESS_KEY_ID`/
  `AWS_SECRET_ACCESS_KEY` are AWS-SDK-standard names that Congress's Deno S3
  client may resolve implicitly; Socratic's usage is 4 litestream yml vars +
  2 shell scripts, fully explicit and safe to rename.
- Class A/B split: known reads (`GetObject`, `HeadObject`, `HeadBucket`,
  `GetBucket*`) → Class B; everything else → Class A. Unknown future action
  types fall to A deliberately (tighter quota, conservative for alerting).
- Storage is pace-projected like ops (linear) — litestream growth is roughly
  linear within a retention window.
- Alerts on transitions only; the admin card always shows current state.
- Old `LITESTREAM_S3_*` keys are intentionally NOT deleted yet (see below).

## Verification state

- `npx tsc --noEmit` clean; `npm run lint` 0 errors (658 inherited warnings);
  `npm test` 5468/5468 (472 files); `npm run build` green.
- Cloudflare GraphQL queries verified live against the new account with the
  ST token (storage + ops datasets both return data).
- NOT yet verified: actual replication into `socratic-trade-bucket` — blocked
  on (a) this PR deploying (prod still runs pre-rename code reading
  `LITESTREAM_S3_*`) and (b) new-account R2 credentials (see above). Prod
  litestream errors today are still `NotEntitled` from the old account.

## Next steps & blockers

1. **OWNER**: create R2 API token on the SocraticTrade.com account (R2 →
   Manage R2 API Tokens → Object Read & Write, bucket `socratic-trade-bucket`)
   and hand over the Access Key ID + Secret (or drop them into Infisical as
   `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` yourself).
2. Then: update the Coolify env store copies, restart the app, verify
   `r2StorageAdaptiveGroups` shows objects > 0 and litestream logs are clean.
3. Only then delete the old `LITESTREAM_S3_*` set from Infisical + Coolify
   (owner already asked for this — gated on step 2 verification).
4. The R2 usage monitor activates automatically on deploy (env already in
   Infisical); first alert state establishes on the first 6h tick.

## Addendum (2026-07-31 ~22:00 UTC): fully resolved, verified live

All blockers above cleared the same day:

1. **Working new-account R2 credentials installed** by Grok in the Coolify
   env store (~20:54 UTC, prod + preview rows); PR #2312 merged 20:38 UTC and
   its deploy finished 21:56 UTC with the new `AWS_*` code path.
2. **Replication verified**: `socratic-trade-bucket` shows 482,344,960 bytes
   (460 MiB) at 21:20 UTC from the first litestream sync; zero
   `NotEntitled`/`InvalidAccessKeyId`/ERROR lines in container logs since.
3. **Old `LITESTREAM_S3_*` keys deleted** from Infisical ST prod (Grok) and
   the Coolify env store; Infisical's placeholder `AWS_ACCESS_KEY_ID`/
   `AWS_SECRET_ACCESS_KEY` values were replaced with the working ones
   (decrypted from the Coolify store, written via Infisical CLI, verified by
   SHA-256 prefix match — values never printed). Infisical and Coolify are
   now consistent, both carrying only the new `AWS_*` + `CLOUDFLARE_ST_*`
   names — matching Congress.Trade's convention.
4. **Monitor live in prod**: first `r2_usage.check` audit event at
   21:30:42 UTC — storage 0 B / 110 Class A / 30 Class B ops at that point,
   `exceeded: []`, `alertsSent: 0`. Snapshot feeds the `/admin` "R2 Storage
   Usage" card; 70%-pace alerts fire via notify() (Pushover etc.) on
   threshold crossings.
