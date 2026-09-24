# 2026-08-14 — Monet App / Issue Audit owner decisions [GROK]

> **2026-09-22 [MM] archaeology note:** historical reference to the Socratic.Trade bundle ID `trade.socratic.app` and the App Store Connect app `6799238379` is kept verbatim as they were live at audit time.  The bundle ID was renamed on 2026-09-22 to `com.socratictrade.ios` (PR forthcoming); the appleId is unchanged.  See `docs/rollouts/2026-09-22-bundle-id-migration.md`.

## 1. Context & Objective

Finish Monet's App / Issue Audit leftovers that are implementable, and document
the ones that are not.  Four owner decisions were left verbatim.  Also verify
Monet's "all merged and deployed" table against GitHub.

Do not accept TestFlight.  Do not flip Coolify deploy strategy or mint B2 keys.
Do not write App Store Connect.

## 2. Changes Made

- Verified the eight ST PRs Monet listed as merged.
- Verified Congress.Trade trial length (implementable leftover).  User-facing
  copy already matched the 2-week offer; only an operator runbook was stale.
  Landed in Congress.Trade `grok/ct-trial-copy`.
- Read-only App Store Connect GET for all four fleet apps.  Documented exact
  listing / review / EULA / tester gaps below.  No PATCH / POST.

Touched (this ST docs PR):

- `docs/rollouts/2026-08-14-monet-audit-owner-decisions.md` (this note)
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `PLAN.md`

## 3. Decisions & Trade-offs

- **Trial: match copy to the live offer (2 weeks), do not lengthen the offer.**
  Monet's "store copy says one month" was true before Claude #1835.  It is not
  true today.
- **ASC writes stay owner-only.**  Monet held off because they write
  public-facing records.  This pass only reads.
- **Tester-invite nuance.**  Monet said the tester record was INVITED on all
  four apps and never accepted.  That is not uniformly true — see §6.  Still
  owner-only to accept remaining invites.

## 4. Verification State

### Monet merged table (GitHub, 2026-08-14)

All eight are **MERGED**.  None remain open.

| PR | State | Merged (UTC) | Squash SHA | Title |
|---|---|---|---|---|
| [#2680](https://github.com/jaywedgeworth22/Socratic-Trade/pull/2680) | MERGED | 2026-08-13T19:49:36Z | `caffa2fd1361` | adaptive FTS-mirror batching |
| [#2681](https://github.com/jaywedgeworth22/Socratic-Trade/pull/2681) | MERGED | 2026-08-13T20:22:06Z | `72361e54add7` | APNs push |
| [#2682](https://github.com/jaywedgeworth22/Socratic-Trade/pull/2682) | MERGED | 2026-08-13T21:19:26Z | `f4a0f5df03d8` | real-toggle backfill |
| [#2684](https://github.com/jaywedgeworth22/Socratic-Trade/pull/2684) | MERGED | 2026-08-13T21:46:28Z | `77bbb77fe641` | honest server stats |
| [#2685](https://github.com/jaywedgeworth22/Socratic-Trade/pull/2685) | MERGED | 2026-08-13T23:01:18Z | `eda339fc99d8` | litestream compaction loud |
| [#2687](https://github.com/jaywedgeworth22/Socratic-Trade/pull/2687) | MERGED | 2026-08-14T04:09:14Z | `637939af0edb` | stop bot-merge zero-workflow |
| [#2709](https://github.com/jaywedgeworth22/Socratic-Trade/pull/2709) | MERGED | 2026-08-14T05:38:12Z | `a8f3ad8660ba` | empty compaction level = wedge |
| [#2712](https://github.com/jaywedgeworth22/Socratic-Trade/pull/2712) | MERGED | 2026-08-14T09:06:55Z | `f218f7e39ee2` | local gate compiles no Swift |

Merge to `main` auto-deploys (`docs/rollouts/2026-07-10-auto-deploy-on.md`).
This pass did not re-verify each live container SHA.

```bash
gh pr view 2680 2681 2682 2684 2685 2687 2709 2712 \
  --repo jaywedgeworth22/Socratic-Trade \
  --json number,state,mergedAt,mergeCommit
```

### Congress.Trade trial (implementable)

| Source | Finding |
|---|---|
| Infisical prod `STRIPE_TRIAL_DAYS` | classified **14** (len=2, hash-only; value not printed) |
| Code default `app/src/billing/routes.ts` | `DEFAULT_TRIAL_DAYS = 14` |
| Stripe live prices | $5/mo `price_1TlHYBEUQUPhZj0SEzG2Qx68`, $50/yr `price_1TlHYCEUQUPhZj0SpNVoPb3Z`; `trial_period_days: null` (applied at checkout) |
| ASC intro offer monthly `trade.congress.premium.monthly` | `FREE_TRIAL` / **`TWO_WEEKS`** from 2026-08-12, no end |
| ASC intro offer annual `trade.congress.premium.annual` | `FREE_TRIAL` / **`TWO_WEEKS`** from 2026-08-12, no end |
| ASC en-US listing description | "Pricing: 2-week free trial, then $5/month or $50/year…" |
| In-app / ToS / dashboard | already 2 weeks via #1835 |

CT follow-up: `docs/rollouts/2026-08-14-trial-copy-matches-offer.md` on
`grok/ct-trial-copy` (stale `wave4-auth-billing.md` only).

## 5. Next Steps & Blockers

Owner-only list (agents must not do these):

1. Accept remaining TestFlight invites (see §6 testers).
2. Disable Coolify rolling replacement for `socratic-app` + write-capable B2
   credentials for one-time Litestream L1 cleanup.  Root cause of the L2 wedge
   is still two writers on one B2 prefix during rolling deploys
   (`docs/rollouts/2026-08-14-empty-tier-wedge-detection.md`).
3. Fill ASC public records (EULA + beta review details) — exact gaps in §6.
   Do not have an agent write them.

## 6. Zero-Code Findings

### Decision 1 — TestFlight invite (OWNER ONLY)

Monet: tester record `INVITED`, never accepted, all four apps.

Read 2026-08-14 via `GET /v1/betaGroups/{id}/betaTesters` (emails masked):

| App | Internal group | INSTALLED | Still INVITED |
|---|---|---|---|
| Congress.Trade | Testers | Jay Wedgeworth (`ma…jays.services`) | Mark Stimac, Sergio Sosa, Jay Hammond |
| Congress.Trade | App Testers | Jay Wedgeworth; John Wedgeworth (`jo…comcast.net`) | — |
| Socratic Trade | Socratic Trade Testers | John Wedgeworth (`jo…comcast.net`) | Jay Hammond, Sergio Sosa, John Wedgeworth (`ma…jaywedgeworth.com`), Mark Stimac |
| Usage Local Monitor | Internal Testing | John Wedgeworth (`jo…comcast.net`) | Sergio Sosa, Jay Hammond, Mark Stimac, John Wedgeworth (`ma…jaywedgeworth.com`) |
| Usage Client Monitor | Testers | John Wedgeworth (`jo…comcast.net`) | Sergio Sosa, John Wedgeworth (`ma…jaywedgeworth.com`), Mark Stimac, Jay Hammond |

The owner's `ma…jays.services` seat is INSTALLED on Congress.Trade only (not on
ST / UM groups in this listing).  Several other testers remain `INVITED` on all
four apps.  Accepting those is still owner-only — an agent must not click
Accept in TestFlight.

### Decision 2 — Litestream repair (OWNER ONLY)

Unchanged.  Agents must not:

- flip Coolify deploy strategy off rolling replacement for `socratic-app`
- mint or rotate write-capable B2 credentials
- delete B2 LTX objects unless the owner has authorized that specific cleanup
  in the current conversation

Health already grades an empty L2 as wedged (#2709).  The wedge itself is still
the owner's repair.

### Decision 3 — Congress.Trade trial (IMPLEMENTED / already true)

Copy already matches the 2-week offer.  Confirmed ASC intro offers are
`TWO_WEEKS`.  Claude's 2026-08-13 "owner follow-up: confirm ASC is 2 weeks" is
closed.

### Decision 4 — App Store listings (DO NOT WRITE ASC)

Read 2026-08-14.  Four apps, team `CC8UTF7ATG`:

| App | ASC id | Bundle | Version state | Custom EULA | betaAppReviewDetails |
|---|---|---|---|---|---|
| Socratic Trade | `6799238379` | `trade.socratic.app` | `1.0.0` PREPARE_FOR_SUBMISSION | **yes** (`endUserLicenseAgreements` `6e6ecf7e-…`, agreementText len 848) | **filled**: contactFirstName Jay, contactLastName Wedgeworth, demoAccountRequired false, notes explain OAuth-only / no demo account |
| Congress.Trade | `6798076688` | `trade.congress.ios` | `1.0` INVALID_BINARY | **none** (`endUserLicenseAgreement` null) | record exists but **empty names/notes**: contactFirstName/LastName/notes/demoAccountRequired all null (contact email + phone present) |
| Usage Client Monitor | `6799230435` | `services.jays.usage.client.monitor` | `1.0.0` INVALID_BINARY | **none** | same empty names/notes/demo fields |
| Usage Local Monitor | `6799230729` | `services.jays.usage.local.monitor` | `1.0.0` INVALID_BINARY | **none** | same empty names/notes/demo fields |

Additional listing gaps (not Monet's original four, still public-facing, still
do not write from this seat):

- What's New (`whatsNew`) is empty on all four current versions.
- Congress.Trade / both Usage apps are `INVALID_BINARY` / appInfo `REJECTED`.
- Congress.Trade IAP products are `MISSING_METADATA`.
- No custom EULA on CT / UM Client / UM Local — Apple standard EULA would apply
  if submitted as-is.

Exact GET used (read-only):

```
GET /v1/apps?fields[apps]=name,bundleId,sku
GET /v1/apps/{id}?include=betaAppReviewDetail,endUserLicenseAgreement,appInfos
GET /v1/apps/{id}/appStoreVersions
GET /v1/appStoreVersions/{id}/appStoreVersionLocalizations
GET /v1/apps/6798076688/subscriptionGroups
GET /v1/subscriptionGroups/22287016/subscriptions
GET /v1/subscriptions/{id}/introductoryOffers
GET /v1/betaGroups/{id}/betaTesters
```
