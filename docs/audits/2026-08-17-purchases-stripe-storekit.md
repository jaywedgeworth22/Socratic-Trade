# Socratic-Trade purchases audit — Stripe + StoreKit (2026-08-17)

**Status:** report only.  No code, Stripe sessions, StoreKit purchases, or card charges.

**Auditor:** Cursor Cloud.  Base: `origin/main` at `87a91a8f` (this branch adds docs only).
**Method:** repo grep + file reads + `gh` issue/PR inventory.  GitHub MCP was down; `gh` was the issue/PR path.  No Infisical, Coolify, or App Store Connect writes.  No live Stripe/StoreKit calls.

## Verdict

**PASS as the product that exists today: invite-only, no user-facing SKU.**
Every requested purchase control is **absent**, not broken.  There is no half-built checkout to finish.

**FAIL only if the expected state was a live paid funnel.**  That funnel is not implemented on web or iOS.  Do not treat this as a missing-bugfix of an existing system.

Congress.Trade already owns the fleet's live Stripe + IAP stack ($5/mo, $50/yr, 14-day trial, ASC products `trade.congress.premium.*`).  Do not copy that work into Socratic-Trade from this audit.

## Scope and non-duplication

Open 2026-08-17 audit/PWA/iOS PRs that are **not** this work:

| PR | Topic | Overlap |
|----|--------|---------|
| #2808 | Trading-outcomes validation | None |
| #2807 | Architecture / backend | None |
| #2806 | Security / reliability | None (no billing attack surface here) |
| #2805 | Brokers + data cascade | None |
| #2804 | Web / mobile-web / iOS parity | UI only; no purchase claims |
| #2803 | RAG / learning / recall | None |
| #2801 | Retire leftover PWA | Dead `/mobile` client — not a live purchase surface |
| #2794 | iOS release-readiness #2560 | Privacy manifest / console handoffs; no IAP |
| #2717 (merged) | Monet ASC / CT trial leftovers | Documents **CT** Stripe + IAP, not ST |

No open Grok / Claude / Monet ST branch implements Stripe checkout or StoreKit.  Effort-board "do not charge Stripe" rows are about **not buying FilingAPI Plus** on the owner's merchant account, not about an ST customer checkout.

PWA / `app/mobile/mobile-pwa-client.tsx` is leftover.  `app/mobile/page.tsx` redirects to `/console`.  Middleware sends `mobile.socratictrade.com` to `/console`.  **Not counted as a live surface.**

## Product facts (why there is no checkout)

| Fact | Evidence |
|------|----------|
| Access is allowlist + mailto, not a paywall | `src/lib/auth/identity.ts` `isEmailAllowed`: primary email always; if `ALLOWED_EMAILS` is unset, everyone else is denied.  `/welcome` CTA is `mailto:mail@jays.services?subject=Socratic%20Trade%20access`.  Copy: "Private operator build." |
| Marketing lists price $0 | `/welcome` JSON-LD `SoftwareApplication.offers` is `{ price: "0", priceCurrency: "USD" }`. |
| No Stripe SDK or env | `package.json` has no `stripe` / `@stripe/*`.  `.env.example` has no `STRIPE_*`.  `package-lock.json` has no stripe package. |
| No billing routes or tables | No `app/api/**/checkout`, `/billing`, `/subscribe`, or Stripe webhook.  Webhooks on disk are `congress` and `tradingview` only.  `src/lib/db.ts` has no `stripe_customer` / subscription / entitlement table. |
| No StoreKit | Zero `StoreKit` / `Product.` / `Transaction.` in `ios/**`.  Entitlements are APNs + Sign in with Apple + `applinks:socratictrade.com`.  `ios/project.yml` has no IAP capability.  No `.storekit` file. |
| Privacy / terms do not sell a plan | `/privacy-policy` and `/terms-and-conditions` cover accounts, brokers, SMS.  No payment, subscription, or IAP language. |
| Adjacent App Review surface that **does** exist | In-app account deletion (web + iOS) with vitest + XCTest coverage.  That is Guideline 5.1.1(v), not a purchase. |

The live Stripe prices and `STRIPE_TRIAL_DAYS=14` cited in `docs/rollouts/2026-08-14-monet-audit-owner-decisions.md` are **Congress.Trade** (`app/src/billing/routes.ts` in that repo, ASC app `6798076688`).  Socratic Trade ASC app `6799238379` / bundle `trade.socratic.app` had no subscription group in that 2026-08-14 read.

---

## 1. Web Stripe

Grade: **N/A — not implemented.**  Vacuous **PASS** against "no accidental live checkout."

| Check | Result | Evidence |
|-------|--------|----------|
| Checkout session create | **N/A** | No `checkout.sessions`, no `/api/**/checkout` route, no Stripe client. |
| Customer portal | **N/A** | No `billingPortal` / `customer.portal` code.  Console settings are broker keys, policy, and danger-zone deletion (`app/console/settings/danger.tsx`). |
| Webhook signature + events | **N/A** | No Stripe webhook route.  `app/api/webhooks/congress/route.ts` is HMAC for congress.trade events (unrelated). |
| Entitlement update | **N/A** | Entitlement in this repo means vendor plans (ROIC / EarningsCalls / FMP), not a user paid SKU.  App access is `isEmailAllowed`. |
| Retries / idempotency | **N/A** | No Stripe event store.  Congress webhook documents id-dedup; that is peer ingest, not billing. |
| Failure / cancel / refund | **N/A** | No Checkout, no invoice, no refund handler. |
| Test vs live | **N/A** | No `sk_test_` / `sk_live_` split because there are no keys in the ST app contract. |
| Tests | **PASS (absence)** | `rg` over `test/**` finds no Stripe/checkout/session cases.  False hits were `UIAppFonts`, `hasActiveAccount`, `kalshiApiBase`. |

**Do not** add a Stripe Checkout from the iOS app or from `/mobile`.  If the owner later sells ST on the website only, that is a new product PR (see §5).

---

## 2. Native iOS StoreKit / IAP

Grade: **N/A — not implemented.**  Vacuous **PASS** against "no accidental IAP or web paywall in the binary."

| Check | Result | Evidence |
|-------|--------|----------|
| Product loading | **N/A** | No `Product.products`, no product IDs, no StoreKit config. |
| Purchase | **N/A** | Login is Google / GitHub / Sign in with Apple (`LoginView.swift`).  No Subscribe / Upgrade / Restore. |
| Restore | **N/A** | No `AppStore.sync` / restore-purchases path. |
| Transaction verify / finish | **N/A** | No `Transaction.updates`, no `finish()`, no JWS verify. |
| Entitlement sync | **N/A** | Mobile snapshot has user + accounts + policy.  No plan / `isPlus` field. |
| Subscription status | **N/A** | Account & Settings: identity, connected **broker** accounts, alerts, policy, admin portal, sign-out, delete account (`HomeView.swift` `AccountSettingsView`). |
| Tests | **PASS (absence)** | No StoreKit XCTest.  Account-deletion XCTest in `MobileModelsTests.swift` is the paid-adjacent App Review control. |

Admin portal is a fenced WKWebView to `https://socratictrade.com/admin` only (host + `/admin` / login / session).  Tests pin that `/console` is refused.  There is no `/admin` billing page to leak Stripe into the binary.

---

## 3. App Review compliance

| Check | Result | Evidence |
|-------|--------|----------|
| No Stripe / web checkout for digital goods **inside** native iOS | **PASS** | No checkout URL, no Safari/WKWebView to a pay page, no "Subscribe on the website" CTA.  Login privacy note is session-only. |
| External account-management links / copy | **PASS** | No "Manage subscription" link (none to manage).  "Connect one in Socratic-Trade" is **broker** connect, not a digital-goods circumvention.  Sign-out / deletion stay in-app.  `openURL` uses iOS Settings (push) and `/logout` after deletion. |
| Reader-app / 3.1.3(a) | **N/A** | ST is not selling a digital subscription, so it is not a reader app with an external subscribe button. |
| Account deletion (5.1.1(v)) | **PASS** (adjacent) | Web: `/api/account/deletion`.  iOS: `/api/mobile/account-deletion/{request,confirm}`.  Tests: `test/account-deletion*.ts`, `test/mobile-account-deletion-route.test.ts`, `MobileModelsTests.swift`. |
| Listing vs code | **PASS (last ASC read)** | 2026-08-14 Monet read: ST `1.0.0` `PREPARE_FOR_SUBMISSION`, custom EULA, OAuth-only review notes, **no ST subscription group**.  CT IAP `MISSING_METADATA` is CT's problem. |

**Future trap:** if ST later sells a digital plan, Guideline 3.1.1 requires IAP **inside** the iOS app.  Web Stripe must not be opened from the binary to unlock the same digital goods.  Model that split on Congress.Trade; do not invent a new one here.

---

## 4. PWA / dead code

| Surface | Live? | Count as purchase surface? |
|---------|-------|----------------------------|
| `app/mobile/page.tsx` | Redirects to `/console` | **No** |
| `mobile.socratictrade.com` | Middleware → `/console` | **No** |
| `app/mobile/mobile-pwa-client.tsx` | Leftover client (deletion UI still in file) | **No** — sibling #2801 retires installable PWA |
| Website `/console` at phone width | Live | **No purchase UI** |
| Native iOS | Live | **No purchase UI** |

---

## 5. Exact fix PRs needed

**None required to make purchases correct.**  Implementing Stripe + StoreKit without an owner decision to sell ST would invent a money path.

| If the owner wants… | PR | Notes |
|---------------------|----|-------|
| Keep invite-only (current) | **No code PR** | This report is enough.  Merge as docs. |
| Sell ST later (web + iOS) | **Design PR first**, then split implementation | Web: Stripe Checkout + Customer Portal + signed webhook + idempotent entitlement rows + test/live key split.  iOS: StoreKit 2 products, purchase, restore, verify/finish, server receipt sync.  **No Stripe UI in the iOS binary.**  New ST price IDs and IAP product IDs — do not reuse CT `price_1TlHYB…` / `trade.congress.premium.*`.  Never mint a second Stripe account or IAP key. |
| Docs hygiene only | Optional small docs PR | STATUS / FilingAPI notes still say "ST's merchant account" in one place and "Congress.Trade billing" in another.  The live customer checkout is CT.  Agents must not charge that merchant for FilingAPI Plus.  Not a purchase-stack bug. |
| PWA leftover | Already #2801 | Do not file a second PWA PR from this audit. |

Do **not** open a "wire Stripe checkout" or "add StoreKit" PR from this seat.

## 6. What was not verified (honest gaps)

- Live App Store Connect IAP catalog for `6799238379` was not re-fetched this session (last read 2026-08-14: no ST subscription group).
- Production Infisical was not opened.  Absence of `STRIPE_*` in `.env.example` + no code readers is the contract; a stray unused secret would not create a checkout.
- No card was charged.  No StoreKit sandbox purchase was run.  Both would have been empty exercises.

## 7. Verification commands actually run

```bash
rg -n '"stripe"|@stripe|StoreKit|RevenueCat' package.json package-lock.json ios/project.yml ios/SocraticTrade/SocraticTrade.entitlements
rg -l -i 'stripe|storekit|checkout\.sessions|billingPortal|constructEvent|Product\.products|Transaction\.updates' \
  --glob '!docs/**' app src ios test
rg -n 'STRIPE_|STOREKIT_|IAP_' .env.example
gh pr list --search "purchase OR stripe OR storekit OR billing OR IAP OR checkout" --state open
gh search code "stripe" --repo jaywedgeworth22/Socratic-Trade --limit 20
gh search code "StoreKit" --repo jaywedgeworth22/Socratic-Trade --limit 10
```

All source greps: no matches.  Open-PR search: FilingAPI / ASC / PWA / other audits only.  StoreKit code search: empty.
