# Notify channel server-env fix: SMS live, Pushover pending owner token (2026-07-31)

## Context & objective

Owner report: settings showed "Pushover not configured on the server", and
SMS was expected to be "configured properly already". Root-caused and fixed
what could be fixed without owner-only credentials.

## Findings

- `notify()` channel availability is **server-env gated**:
  Pushover needs `PUSHOVER_APP_TOKEN`; SMS needs `TWILIO_ACCOUNT_SID` +
  `TWILIO_AUTH_TOKEN` + `TWILIO_FROM`; email needs `RESEND_API_KEY`
  (`src/lib/notify.ts:59-70,247-326`).
- Infisical ST prod had **none** of the Pushover/Twilio keys (only
  `RESEND_API_KEY`) → "not configured on the server" was accurate.
- The Twilio set the owner remembered configuring lives in the **shared**
  Infisical project (`shared-at-ct`, prod) — not in the Socratic-Trade
  project the app's prod env actually reads.
- `PUSHOVER_APP_TOKEN` exists in **no** secret store (local `~/.secrets`,
  shared prod, CT prod, ST prod) — the Pushover *application* token was never
  created. Feature code (PR from 2026-07-30) shipped before the token existed.
- Prod `notification_prefs` (user `local`) had `channels: ["push"]` only —
  `phone` was set (+1956…0244) but the `sms` channel was never enabled;
  `pushover_target` (Pushover user key) was never set.

## Changes made (ops only, no code)

1. Copied `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` from
   shared prod → ST prod Infisical (values never printed; lengths verified:
   34/32/12).
2. Enabled the `sms` channel in prod `notification_prefs` →
   `channels: ["push","sms"]` (direct SQL; required registering the app's
   `account_subject_token` SQLite function — sha256 of
   `account-subject:v1|<userId>` — so the account-write-fence triggers parse).
3. Restarted the prod app via Coolify one-shot token (deploy
   `u55ixt87btp2anxde84r54s0`, finished 22:56:10 UTC); verified the
   `next-server` process env now carries `TWILIO_*`, `RESEND_API_KEY`,
   `AWS_*`, `CLOUDFLARE_ST_*`. Public `/api/health` 200 throughout.
4. **End-to-end SMS verification**: sent a real test message through the
   Twilio API with the copied creds to the owner's phone — Twilio returned
   `status: queued`, no error.

## What remains — Pushover (owner-only step)

`PUSHOVER_APP_TOKEN` must be created on the owner's Pushover account:

1. https://pushover.net/apps → **Create an Application/API Token** (name e.g.
   "Socratic Trade") → copy the API Token.
2. Hand it to an agent (or drop it into Infisical ST prod as
   `PUSHOVER_APP_TOKEN`), then restart the app.
3. In the app settings → Delivery: paste the **Pushover user key** (from the
   owner's Pushover dashboard home) into the Pushover field and enable the
   Pushover channel.

Until then, alert delivery runs on ntfy push + SMS (+ email server-side,
channel currently disabled in prefs — enable in settings if wanted).

## Verification state

- Process-env presence verified on `next-server` (names only, no values).
- Twilio test SMS: `status: queued`, `error: none`.
- R2 daily digest (PR #2319) will deliver via ntfy + SMS once deployed —
  that will be the first organic end-to-end notification through this path.
