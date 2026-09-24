# Hetzner fleet cutover (Coolify + all apps) — 2026-08-07

## Context & Objective

Oracle Cloud production host was suspended/unreachable (edge 522s). Fleet moved to a new
Hetzner server so Socratic-Trade, Congress.Trade, Usage Monitor, and Coolify run again with
working DNS, backups, and health verification. Hetzner host backups are ON and complement
app-level SQLite snapshots (they are not a substitute for frequent app RPO).

## Changes Made

### Host

- **Public IP:** `<PROD_ORIGIN_IP>` (cx43 NBG1 — 8 vCPU / 16 GB / 160 GB)
- **Tailscale:** `fleet-hetzner-nbg1` / `<TAILSCALE_IP>`
- **Coolify:** `4.1.2` at `https://host.jays.services`
- **Hetzner Backups:** ON (daily window ~14–18 UTC)

### Apps (edge health 200 verified 2026-08-07 ~01:26 UTC)

| App | Domain | Coolify UUID | Notes |
|-----|--------|--------------|-------|
| Socratic-Trade | socratictrade.com (+ www, admin) | `<ST_COOLIFY_APP_UUID>` | Litestream L9 snapshot restored + integrity repair (`task_journal` salvage). Live trading DB. |
| Congress.Trade | congress.trade (+ www) | `<CT_COOLIFY_APP_UUID>` | Fresh local SQLite + `/api/admin/migrate`. **No Oracle CT DB copy** — empty pipeline data until re-ingest / future R2 restore. Runtime container: `congress-app-live` (Traefik labels + coolify network). Compose sqlite-web port conflict avoided (proxy owns :8080). |
| Usage Monitor | usage.jays.services | `<UM_COOLIFY_APP_UUID>` | Booted with `LITESTREAM_EMERGENCY_DISABLE=true` (R2 LTX non-contiguous). Volume perms fixed for uid 1000. Fresh DB schema via migrate-safe. |

### DNS (Cloudflare → Hetzner `<PROD_ORIGIN_IP>`, proxied)

- `socratictrade.com` / www / admin, `host.jays.services` (earlier in cutover)
- `congress.trade`, `usage.jays.services` (this session)

### Backups & verification (host)

| Path | Role |
|------|------|
| `/usr/local/sbin/fleet-sqlite-backup.sh` | Consistent SQLite `.backup` every 6h → `/data/backups/{socratic,congress,usage-monitor}` + sha256 |
| `/usr/local/sbin/fleet-health-verify.sh` | Edge health every 15m (ST/CT/UM + Coolify 302 OK) + backup age |
| `/usr/local/sbin/fleet-backup-verify-weekly.sh` | Sunday 04:30 UTC restore drill (integrity + checksum) |
| `/etc/cron.d/fleet-backups` | Cron install |
| `/var/log/fleet-backup/` | Logs |

**Layers:**

1. **App RPO (~hours):** fleet-sqlite-backup + ST litestream to R2 (when healthy)
2. **Host RPO (~24h):** Hetzner server backups (full disk/image)
3. **Weekly drill:** integrity/sha256 on latest local snapshots

Hetzner backups alone are **not** sufficient for trading RPO (they miss intra-day DB
writes and can capture a corrupt/open file). Use both layers.

### Secrets / Coolify login

- Admin password: server `/root/.coolify-admin-password` and owner file
  `~/.secrets/coolify-login-hetzner.txt` (chmod 600). Not committed.
- CT runtime secrets bulk-loaded from Infisical into Coolify envs (ADMIN_TOKEN etc.).
- UM: Infisical inject at start; litestream restore skipped until R2 chain repaired.

## Decisions & Trade-offs

- **ST:** Prefer L9 (~00:06 UTC Aug 5 / 7:06 PM CDT Houston) over later corrupt LTX layers.
- **CT/UM:** Prefer live empty schema over waiting for perfect R2 restore; re-ingest / restore later.
- **CT compose:** Dropped sqlite-web host bind that conflicted with Coolify proxy :8080.
- **UM:** `LITESTREAM_EMERGENCY_DISABLE=true` until R2 LTX continuity fixed (same class as ST corruption).
- Coolify API `status` can lag; trust edge health + `docker ps`.

## Verification State

```bash
# Edge (all 200)
curl -sS https://socratictrade.com/api/health
curl -sS https://congress.trade/api/health
curl -sS https://usage.jays.services/api/health

# Host
ssh root@<PROD_ORIGIN_IP> '/usr/local/sbin/fleet-health-verify.sh'
ssh root@<PROD_ORIGIN_IP> '/usr/local/sbin/fleet-sqlite-backup.sh'
ssh root@<PROD_ORIGIN_IP> '/usr/local/sbin/fleet-backup-verify-weekly.sh'
```

First weekly drill: all three DBs integrity ok + sha256 ok (ST 1.4G, CT 892K, UM 400K).

## Next Steps & Blockers

1. Re-enable UM (and ST if needed) litestream replication after R2 LTX prune/repair.
2. Optional: restore CT historical data if an Oracle volume or R2 generation is recovered.
3. Reconcile Coolify app status for CT (`congress-app-live` outside stock compose name) and
   clean failed compose siblings (sqlite-web Created).
4. Enable Hetzner delete protection on the server if not already.
5. Optional offsite copy of `/data/backups` to R2/Mac weekly.
6. Update fleet `COOLIFY.md` host table (Hetzner replaces Oracle Tailscale host notes).

## Zero-Code Findings

Oracle account remaining suspended; Hetzner is production origin for all three product
domains plus Coolify UI.
