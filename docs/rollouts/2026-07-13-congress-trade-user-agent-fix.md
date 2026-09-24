# 2026-07-13: Congress.Trade User-Agent Block Fix

## Summary
Fixed an issue where Socratic-Trade prod server's automated background tasks were failing to fetch latest congressional trades from Congress.Trade (App A) since July 7th.

## Why
On July 11th, a `botDefense.ts` middleware was added to Congress.Trade's `/api/v1/transactions` endpoint to rate-limit and block common bot user agents (including `node-fetch` and `undici`). Because Socratic-Trade's node `fetch` was not sending a custom User-Agent, it fell under this blocklist and continually received an HTTP 403. As a result, the `dataset.fetchedAt` timestamp failed to advance, and the site became stuck showing trades from June. Also applied the IPv6 blackhole fix to `congress-scout.mjs` in Congress.Trade.

## Files
- `src/lib/api-clients/congress.ts` (Socratic-Trade): Appended a custom `"User-Agent": "SocraticTrade/1.0"` to the `fetch` options.
- `scout/congress-scout.mjs` (Congress.Trade): Applied IPv6 DNS fix.

## Verification
- Sent a manual node `fetch` mimicking the Socratic-Trade background task to verify it successfully receives trades since June when the 403 is avoided.
- Checked `pm2 logs` for `congress-scout` in App A to ensure the residential scout isn't blocked.
- Ran `npx tsc --noEmit` locally.

## Follow-ups
None
