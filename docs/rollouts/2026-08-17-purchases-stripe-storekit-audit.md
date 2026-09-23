# 2026-08-17 — Purchases / Stripe / StoreKit audit (report only) [CURSOR]

## 1. Context & Objective

Owner asked for a read-only end-to-end audit of Socratic-Trade purchases (web Stripe + native StoreKit + App Review).  Goal: pass/fail evidence and exact fix PRs, without charging cards, creating Stripe sessions, or performing StoreKit purchases.  Avoid duplicating Grok / Claude / Monet work.

## 2. Changes Made

Report only.  No application, iOS, or env changes.

- Wrote `docs/audits/2026-08-17-purchases-stripe-storekit.md`.
- Handoff: `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this note.

## 3. Decisions & Trade-offs

- Graded the live product as **invite-only / no SKU**.  Every checkout control is absent, not broken.
- Did not propose an implementation PR.  Building Stripe + StoreKit would invent a money path the owner has not asked to sell.
- Did not count leftover PWA client as a live surface (`/mobile` → `/console`; sibling #2801).
- Did not re-open Congress.Trade billing (that repo already has Stripe + IAP).  Did not charge the owner's Stripe merchant for FilingAPI Plus.

## 4. Verification State

```bash
rg -n '"stripe"|@stripe|StoreKit|RevenueCat' package.json package-lock.json ios/project.yml ios/SocraticTrade/SocraticTrade.entitlements
# no matches

rg -l -i 'stripe|storekit|checkout\.sessions|billingPortal|constructEvent|Product\.products|Transaction\.updates' \
  --glob '!docs/**' app src ios test
# no matches

rg -n 'STRIPE_|STOREKIT_|IAP_' .env.example
# no matches

gh pr list --search "purchase OR stripe OR storekit OR billing OR IAP OR checkout" --state open
# FilingAPI / other audits only — no ST purchase implementation PR
```

Docs-only.  Did not run `tsc` / vitest / `next build` (no runtime files touched).

## 5. Next Steps & Blockers

- Merge this report.  No follow-up code PR unless the owner decides to sell ST.
- If they do sell: design PR first (web Stripe + iOS StoreKit 2, no Stripe UI in the binary, new ST SKUs — do not reuse CT prices).
- PWA leftover stays with #2801.

## 6. Zero-Code Findings

Socratic-Trade has no user-facing purchase stack.  Access is email allowlist + mailto "Request access."  Marketing JSON-LD lists price $0.  Native iOS has no StoreKit and no web checkout for digital goods (App Review 3.1.1 PASS).  Account deletion exists and is tested (5.1.1(v), adjacent).  The fleet's live Stripe/IAP product is Congress.Trade.
