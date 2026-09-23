# Socratic-Trade APNs send verify

#2681 already landed the HTTP/2 sender, register route, and notify channel.  This pass does not steal `monet/apns-push`.

## What changed

- `loadApnsConfig` accepts `APNS_P8` / `APNS_PRIVATE_KEY` (raw PEM or base64) in addition to `APNS_PRIVATE_KEY_B64`.
- Tests cover `pending_approval` and `kill_switch` (protective halt) through the mocked transport.

## Secrets (Infisical `socratic-trade` prod)

| Name | Expected |
| --- | --- |
| `APNS_KEY_ID` | `SYV2VT3PQ6` (from `~/.secrets/ST_AuthKey_SYV2VT3PQ6.p8`, 257 bytes) |
| `APNS_TEAM_ID` | `CC8UTF7ATG` |
| `APNS_BUNDLE_ID` | `trade.socratic.app` |
| `APNS_P8` | PEM or base64 of that .p8 |
| `APNS_PRIVATE_KEY_B64` | same key, base64 |

Device delivery still needs a TestFlight tap after the keys are in Infisical.  Settings → Delivery shows "iPhone push — not configured" until then.
