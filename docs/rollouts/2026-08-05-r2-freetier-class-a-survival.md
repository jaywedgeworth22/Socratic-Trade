# 2026-08-05 — R2 free-tier Class A survival + label alignment [GROK]

## Context & objective

Owner compared R2 free-tier cards on Usage Monitor (`usage.jays.services`) and
Socratic Trade admin (`admin.socratictrade.com`). Goals:

1. Canonical product labels: **Socratic Trade** (space), **Congress.Trade**
   (period, no space), **Usage Monitor** (space).
2. Explain metric discrepancies between the two dashboards.
3. Cut R2 usage with no product benefit so all three free tiers stay safe.

## Live snapshot (2026-08-05 ~23:00 UTC)

| Account | Storage UI | Class A MTD | Class A pace | Write path state |
|---------|------------|-------------|--------------|------------------|
| Socratic Trade | ~5.2 GiB | ~159k / 1M | ~99% (misleading) | **Kill-switch ON since Aug 4** (no litestream) |
| Congress.Trade | ~8.5 GiB | ~410k / 1M | **~256%** | Was **~975 LTX PutObject/hr** despite 5m sync |
| Usage Monitor | ~7.0 GiB live | ~77k / 1M | ~37% | **Kill-switch ON** (storage ≥70%) |

Free tier per account: **10 GiB / 1M Class A / 10M Class B** per calendar month.

### Class A action breakdown (GraphQL MTD)

| Account | Top Class A drivers |
|---------|---------------------|
| ST | ListObjects ~73k, PutObject ~56k, UploadPart ~18k, DeleteObjects ~12k |
| CT | **PutObject ~256k**, ListObjects ~137k, DeleteObjects ~15k |
| UM | ListObjects ~42k, PutObject ~17k, UploadPart ~13k |

CT root cause: Litestream 0.5 L0 uploads **one object per SQLite TXID**. Host
logs showed multi-object Put bursts every second under normal app write load.
`sync-interval: 5m` does **not** collapse L0 object count.

## Why UM vs ST numbers disagree

1. **Storage source**
   - UM (own account): prefer **live S3 ListObjects** → current inventory
     (`usage-monitor-prod-v3` = **7.00 GiB** measured live).
   - ST admin + UM fleet peers: **Cloudflare GraphQL** `r2StorageAdaptiveGroups`
     with `max { payloadSize }` → can report **period peak / lag**, not current
     size (e.g. GraphQL still showed historical `usage-monitor-bucket` ~15 GiB
     while live list is **0 objects**).
2. **Ops counters** are both GraphQL MTD sums; small deltas = different poll times.
3. **Pace projections** are linear MTD extrapolations. They **do not zero out**
   when a kill-switch stops new writes — ST still shows ~99% pace while Class A
   has been essentially flat since the Aug 4 kill.
4. Labels differed: ST used `Socratic-Trade`; UM used `Congress Trade` (space).

## Changes made

### Host (immediate, Oracle)

- **Stopped + disabled** `litestream-congress` (Class A emergency).
  Marker: `/etc/litestream/congress-r2-paused.flag`.
  Resume: `sudo systemctl enable --now litestream-congress` after month reset
  or after confirmed Class A headroom + batched writes.
- Parked config with `sync-interval: 30m` + `snapshot.retention: 24h` for resume.
- ST already paused via `/app/data/.litestream-r2-disabled` (Aug 4).
- UM already paused via `/data/r2-disabled-70pct.flag`.

### Socratic Trade (this PR)

- Account label **Socratic Trade** (space).
- `litestream.coolify.yml` **60s → 15m** when replication is resumed.
- Admin R2 card shows **writes paused** banner when kill-switch marker present
  (explains scary pace while ops are flat).

### Usage Monitor (paired PR)

- Account label **Congress.Trade**.
- Live ListObjects: cache 6h; longer when kill engaged; only list primary
  litestream bucket by default (no hardcode of every historical bucket).

### Congress.Trade

- Host pause only for this turn (no app latency change). Docs + effort board.

## Decisions & trade-offs

- **CT off-site PITR paused** for free-tier survival. Local SQLite volume remains;
  app path unchanged. Acceptable per owner free-tier priority.
- Do not re-enable CT litestream until Class A remaining budget can absorb
  residual app R2 (filings/PDFs) **plus** L0 under write storms — or until
  SQLite write batching lands.
- ST remains kill-switched for now; resume only after deploy of 15m config and
  with eyes on Class A daily delta.

## Verification

```bash
# Host
systemctl is-active litestream-congress   # inactive
pgrep litestream || echo none
docker exec socratic-app test -f /app/data/.litestream-r2-disabled && echo ST_kill_on
docker exec oracle-app-1 test -f /data/r2-disabled-70pct.flag && echo UM_kill_on

# Local
npx vitest run test/r2-usage.test.ts
```

## Next steps

1. Land ST + UM PRs; deploy.
2. Watch Class A daily delta 24–48h (should be near-flat for CT/ST/UM writes).
3. Optional CT storage prune of old `bulk/` snapshots if storage stays >70%.
4. September: resume litestream carefully with 15–30m sync + write batching.
