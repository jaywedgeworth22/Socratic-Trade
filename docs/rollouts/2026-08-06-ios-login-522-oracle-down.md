# 2026-08-06 — iOS login 522 + Oracle host hard-down

> **2026-09-22 [MM] archaeology note:** historical reference to the iOS bundle ID `trade.socratic.app` is kept verbatim as it was live at rollout time.  Renamed on 2026-09-22 to `com.socratictrade.ios` (PR forthcoming).  The Apple capability / provisioning steps in this rollout still apply — only the bundle ID string changes.  See `docs/rollouts/2026-09-22-bundle-id-migration.md`.

## Context & Objective

Owner reported native iOS sign-in failures on the Socratic Trade login screen:
Apple showed `The server returned an error (522)`; Google/GitHub web auth went white
then a Cloudflare interstitial. Also Xcode deprecation on
`LoginView.swift` `ASPresentationAnchor()`.

## Investigation (zero-code production)

Confirmed **fleet-wide origin outage**, not an iOS OAuth code bug:

| Probe | Result |
|-------|--------|
| `https://socratictrade.com/` | HTTP **522** after ~19s (`error code: 522`) |
| UptimeRobot `socratictrade.com` | **DOWN** ~35m (cause 522) |
| UptimeRobot `congress.trade` | **DOWN** (522) |
| UptimeRobot `usage.jays.services` | **DOWN** (522) |
| UptimeRobot `host.jays.services` | **DOWN** first (~41m) — Coolify control plane |
| Public IP `<ORACLE_IP_RETIRED>` | ICMP timeout |
| Tailscale `usage-monitor-oracle` (`<TAILSCALE_IP_RETIRED>`) | **offline**, last seen ~30m |
| SSH via Tailscale | connect timeout |
| OCI API (pem + fingerprint from secrets bak) | **401 NotAuthenticated** — cannot SOFTRESET |

Incident window (UTC, from UptimeRobot): host.jays.services down from
`2026-08-06T22:09Z`; apps followed within minutes.

Apple console lines `AKAuthenticationError -7003` / `ASAuthorizationError 1001`
are client-side cancel/auth noise secondary to the origin being unreachable; the
banner text `(522)` is the real signal (POST `/api/mobile/auth/apple` hit CF 522).

Google/GitHub `ASWebAuthenticationSession` loads
`https://socratictrade.com/api/auth/signin/{provider}` — when origin is dead, CF
returns 522 / error interstitial (often described as “Access block”).

## Changes Made (iOS only — does not restore prod)

- `ios/SocraticTrade/LoginView.swift` — stop using deprecated `ASPresentationAnchor()` /
  `UIWindow()`; present web auth from key window or `UIWindow(windowScene:)`.
- `ios/SocraticTrade/MobileAPIClient.swift` — clearer copy for Cloudflare 521–523;
  surface short plain-text CF bodies (e.g. `error code: 522`).
- `ios/SocraticTradeTests/MobileModelsTests.swift` — assert 522 message is readable.
- Docs: this rollout + effort board row.

## Decisions & Trade-offs

- Did **not** attempt host recovery without working OCI auth (would be guessing).
- Client message improvement only; true fix is host SOFTRESET / network restore.

## Verification State

- Production still 522 at write time (cannot green-check live login).
- iOS unit assertion added for error copy; run:
  `xcodebuild -project ios/SocraticTrade.xcodeproj -scheme SocraticTrade -destination 'platform=iOS Simulator,name=iPhone 16 Pro' CODE_SIGNING_ALLOWED=NO test`

## Next Steps & Blockers

1. **Owner (required):** Oracle Cloud Console → Compute → instance for
   `usage-monitor-oracle` / `<ORACLE_IP_RETIRED>` in **us-phoenix-1** → **Reboot**
   (SOFTRESET) or Stop/Start.
2. After host returns: verify Tailscale online, `host.jays.services`, then
   `https://socratictrade.com/api/health`, then re-try iOS Sign in with Apple / Google / GitHub.
3. Optional: repair OCI API keys under `~/.secrets` so agents can SOFTRESET without console
   (current keys return 401).
4. If Apple still fails after host is up with only `-7003` (no 522), re-check Sign in with
   Apple capability / provisioning for `trade.socratic.app` and that the device has an Apple ID.

## Zero-Code Findings

Root cause of all three sign-in failures: **Oracle Coolify host hard-down**. iOS app and
Auth.js routes are fine once origin answers.
