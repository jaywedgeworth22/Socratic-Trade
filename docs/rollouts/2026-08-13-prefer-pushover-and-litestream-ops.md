# 2026-08-13 — Prefer Pushover over Resend + Litestream dual-writer stop

Owner was still getting ST Litestream emails and asked to (1) fix Litestream, (2) keep app-name sign-off, (3) prefer Pushover because Resend costs money.

## Live backup state (2026-08-14 ~00:48Z)

L0, L1, and L9 are healthy.  L2/L3 are still wedged at txid `000000000003a03b` (last advanced 2026-08-13 06:12Z) from overlapping L1 objects (same MaxTXID).  Daily snapshot + live WAL remain the restore floor.

## What shipped in this PR

Operator / storage / usage alerts send Pushover when a token and user key are available, and skip Resend.  Email remains last resort and still ends with `(sent by Socratic-Trade)`.  `PUSHOVER_ST_API_TOKEN` is accepted as the app token.

## Host ops already done (not in this commit)

- Coolify `socratic-app`: Consistent Container Names **on** (stops two `litestream replicate` processes on the next roll).
- Health-check start period **180s → 60s**.
- Infisical ST prod: `PUSHOVER_USER_KEY` written value-blind (len 30).  Token was already present as `PUSHOVER_ST_API_TOKEN`.

## Still owner / scoped-key

Surgical B2 delete of the overlapping L1 pair (MaxTXID `a0ad`).  Do not use the Backblaze master key.  Do not wipe the replica prefix.
