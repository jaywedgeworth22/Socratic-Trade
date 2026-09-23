# 2026-08-03 — R2 kill-switch resume + Class A throttle (GROK takeover from KIMI)

## Summary

Kimi hit max-plan usage mid-flight while rotating the UM Cloudflare analytics
token and diagnosing the Socratic-Trade R2 kill-switch. GROK took over.

### What fired the kill-switch

Marker `/app/data/.litestream-r2-disabled` written at **2026-08-03T19:57:06Z**:

- Reason: Socratic-Trade Class A ops projected **73.16%** of free tier (pace basis, 0.2 elapsed floor)
- Absolute Class A was only **14.63%** MTD
- Storage latest was **~4.86 GiB (48.6%)** — under the 70% absolute storage threshold
- App correctly booted **without** litestream while the marker existed

### Ops executed

1. **Resumed ST replication**: deleted marker + `docker restart socratic-app` →
   `litestream replicate` is parent of `next-server` again; health ok.
2. **CT Class A throttle**: host `/etc/litestream/congress.yml` `sync-interval`
   **10s → 30s**, restarted `litestream-congress` (active, replicating).
3. **Infisical (ST prod)** updated via machine identity (values not logged):
   - `CLOUDFLARE_JAY_API_TOKEN` (working analytics bearer)
   - `CLOUDFLARE_JAY_ACCOUNT_ID=3a9368057468d0909cafaa85df12d1b7` (Usage.Jays.Services)
   - `CLOUDFLARE_ST_*` / `CLOUDFLARE_CT_*` token+account pairs for multi-account monitor
4. **Local secrets**: fixed corrupt `CLOUDFLARE_ACCOUNT_ID` (was 3 chars) and account ID keys in `~/.secrets/global-api-keys.env`.
5. **Code**: `litestream.coolify.yml` sync-interval 10s → 30s (this PR) so future
   deploys keep the lower Class A rate.

### Could not complete (owner)

- **Mint a brand-new** Cloudflare API token: Global API Key + known emails returned
  HTTP 403; existing `CLOUDFLARE_JAY_API_TOKEN` still verifies **active** and GraphQL
  works on all four accounts. Recommend owner rotate from the CF dashboard if a
  net-new token is required beyond Infisical re-sync of the working bearer.

### Live free-tier snapshot at takeover (latest per-bucket readings)

| Account | Storage | Class A MTD | Class A pace@0.2 floor |
|---------|---------|-------------|------------------------|
| ST | 4.86 GiB (48.6%) | 14.6% | ~73% (pre-kill) |
| CT | 5.83 GiB (58.3%) | 24.0% | ~120% (pre-throttle) |
| UM | 5.57 GiB (55.7%) peak / receipts tiny | 5.0% | ~25% |

## Verification

- `docker top socratic-app` shows `litestream replicate ... -exec next start`
- No `.litestream-r2-disabled` on `/app/data`
- `systemctl is-active litestream-congress` = active; logs show `sync-interval=30s`
- Infisical get lengths: tokens 53 chars, account IDs 32 chars
