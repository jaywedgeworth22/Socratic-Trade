# Rotating `ENCRYPTION_KEY`

`ENCRYPTION_KEY` (AES-256-GCM) protects everything in `user_api_keys`, `connected_accounts`
(broker API keys/secrets), `notification_prefs` (Pushover/Twilio tokens), and the Robinhood MCP
OAuth token blob in `settings`. It has no built-in key versioning — `decryptValue()` only ever
tries the *current* key. Swapping the env var without re-encrypting first makes every stored
credential silently undecryptable (fail-closed, returns `""`), which on this app means broker
order placement breaks with no error, for every account with a stored key.

**Never just generate a new key and swap the env var.** Use `scripts/rotate-encryption-key.ts`.

## Why this is inert until you run it

This script does nothing on its own — it's not called from app boot, a cron, or CI. It only runs
when explicitly invoked with `OLD_ENCRYPTION_KEY`/`NEW_ENCRYPTION_KEY` set and `--dry-run` or
`--apply` passed. Safe to have merged to `main`.

## Before you start: stop the app

Production is Coolify on `fleet-hetzner-nbg1`, not Mac pm2 (`docs/deployment.md`).  **Stop the
`socratic-app` deployment in Coolify (Application → Stop) before step 1.**  Two independent
reasons, both real on a live account:

- `data/app.db` is a live SQLite file the running app has open via `better-sqlite3`.  Rewriting
  every row in place (step 4) while the app is still serving traffic races the app's own writes —
  a proposal or order-status update landing mid-rotation can be silently lost or, worse, read back
  half-migrated.
- Litestream is continuously streaming this same file's WAL to Backblaze B2 (`docs/litestream.md`).
  A bulk in-place rewrite while Litestream is live is exactly the kind of large single-transaction
  write that a mid-stream disconnect can leave the replica out of sync with.  Stopping the app also
  stops Litestream's write side cleanly; it resumes on its own once the app redeploys in step 5.

Trading (autopilot, scheduled runs, broker I/O) is paused for the duration — budget for that, and
prefer a low-activity window.

## Procedure

1. **Back up the DB file first.** Non-negotiable — this rewrites every credential row in place.
   ```bash
   cp data/app.db data/app.db.pre-rotation-$(date +%Y%m%d).bak
   ```
   Or, if pulling a fresh copy from prod for a dry-run first, do that instead of touching the live
   file at all until you're confident in `--apply`.

   The script does **not** enforce this and cannot — it has no way to tell a real backup from a
   stale one.  A clean run is not evidence that a backup exists.

   This backup is encrypted under the **OLD** key.  Keep that in mind for step 7 — retiring the old
   key value makes this specific file permanently undecryptable, because `decryptValue()` only ever
   tries the *current* `ENCRYPTION_KEY`.

2. **Generate the new key:**
   ```bash
   openssl rand -hex 32
   ```

3. **Dry run** — decrypts every row under the OLD key, re-encrypts in memory, verifies the
   round-trip, writes NOTHING:
   ```bash
   DATABASE_URL=file:./data/app.db \
   OLD_ENCRYPTION_KEY=<current ENCRYPTION_KEY> \
   NEW_ENCRYPTION_KEY=<the key from step 2> \
   npx tsx scripts/rotate-encryption-key.ts --dry-run
   ```
   If this reports any failures, STOP — do not proceed to `--apply`. A failure means either the
   `OLD_ENCRYPTION_KEY` you supplied is wrong, or some rows are already under a different key than
   you think.

   **`npx tsx` needs a dev toolchain — the running prod container does not have one.**  The
   Dockerfile runs `npm prune --omit=dev` before the runtime stage (`Dockerfile`), so `tsx`
   (a devDependency) is not present inside the deployed `socratic-app` container, and that
   container has no outbound npm registry access to fetch it on demand either.  Run this script
   from a machine with the full repo and `npm ci` already run — a normal dev checkout/worktree, or
   a throwaway clone — never `docker exec` into the prod container.  Point `DATABASE_URL` at a
   **copy** of `data/app.db` pulled from the Coolify persistent volume (`/app/data/app.db`) for the
   dry run; only the `--apply` run in step 4 needs to touch the real file, and by then the app is
   already stopped so you can run directly against the volume path.

4. **Apply** — same env, single all-or-nothing SQLite transaction:
   ```bash
   ...same env as step 3... npx tsx scripts/rotate-encryption-key.ts --apply
   ```
   If ANY row fails mid-run, the whole transaction rolls back automatically — nothing partial is
   ever left committed.

5. **Only after a successful `--apply`**, update `ENCRYPTION_KEY` to the new value in
   Infisical (prod project) and Coolify, then redeploy (this restarts the app and resumes
   Litestream).

6. **Verify post-deploy** with the now-current key:
   ```bash
   DATABASE_URL=file:./data/app.db npx tsx scripts/rotate-encryption-key.ts --verify
   ```
   Reads `ENCRYPTION_KEY` from the environment exactly like the app does. Exits non-zero and lists
   every row that fails to decrypt.

   **Read the row count, not just the exit code.** Every mode refuses to create a database that
   does not exist (a mistyped `DATABASE_URL` or the wrong working directory is a hard failure, not
   an empty run), but an existing-yet-wrong database would still report `0 OK, 0 FAILED` and exit
   0.  A run that finds zero encrypted values prints a warning for exactly that reason; treat it as
   "I am pointed at the wrong file" unless you genuinely expect no stored credentials.

   Also confirm the app came back up cleanly and Litestream resumed (`docs/litestream.md`'s
   `litestream databases` / `pm2 show litestream`-equivalent Coolify log check) before moving on —
   the DB's on-disk bytes changed wholesale in one transaction in step 4, which is exactly the kind
   of change worth a restore drill (`docs/litestream.md` § Disaster recovery) after, not just a
   `--verify` pass.

7. **Retire the old key value — but only once you no longer need the step-1 backup.**  That backup
   is encrypted under the OLD key and always will be; there is no way to decrypt it once the old
   key is gone everywhere.  Pick one:
   - **Normal case:** once step 6's `--verify` passes clean, delete `data/app.db.pre-rotation-*.bak`
     (the live DB under the new key is now the good copy) — *then* retire the old key value from
     the secrets manager history, `.env` backups, and `~/.secrets`.
   - **If you want to keep that backup** (e.g. as an extra offline recovery point beyond the normal
     Litestream/B2 history): do not fully retire the old key.  Keep it recorded — labeled with the
     backup's filename/date — in the secrets manager's history so that specific artifact stays
     restorable later.  Retiring "everywhere" and keeping the backup are mutually exclusive; decide
     per rotation which one you actually want.

## `--verify` as a standalone health check

Run `--verify` any time, unrelated to rotation, to confirm every stored ciphertext still decrypts
under the currently-configured `ENCRYPTION_KEY` — useful after a restore-from-backup drill, or as
a periodic sanity check.
