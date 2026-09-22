# 2026-08-12 — iOS parity wave 2: guardrail tightening, control catalog, universal links

> **2026-09-22 [MM] archaeology note:** historical reference to the AASA `appIDs` claim `CC8UTF7ATG.trade.socratic.app` is kept verbatim as it was live at rollout time.  Renamed on 2026-09-22 to `CC8UTF7ATG.trade.socratic.ios` (PR forthcoming); the URL `components` (paths the iOS app claims) are unchanged.  See `docs/rollouts/2026-09-22-bundle-id-migration.md`.

## 1. Context & Objective

Wave 2 of the iOS parity roadmap: give the phone three capabilities the server already
supports but the app never used — protective policy tightening (roadmap #6), server-advertised
capability discovery (#8), and universal links / deep-link routing (#7).  Everything here is
iOS-side except one new web route handler (the AASA file) and one middleware allowlist entry
without which that file is unreachable.

Branch `monet/ios-parity-wave2`, worktree `~/apps/trading-monet-wave2`.

## 2. Changes Made

### Item A — Protective policy tightening (`policy.patch`)

New `Tighten Guardrails` section in the account/settings sheet (`HomeView.AccountSettingsView`),
directly under the read-only "Current Policy" rows that show the same numbers — the smallest
possible IA delta and no new destination to discover.  It offers:

- Autopilot -> Ask-First (`strategyAuthority: "propose"`).
- 75% / 50% / 25% reductions of `maxOrderNotional` and `maxDailyNotional`, rounded DOWN to whole
  dollars, presented as a menu of concrete amounts.

Server surface relied on (`src/lib/mobile-api.ts`, `normalizePolicyPatch`):

```ts
if (input.strategyAuthority !== "propose" && input.strategyAuthority !== "decide") {
  throw new MobileCommandValidationError("strategyAuthority must be propose or decide.");
}
...
["maxOrderNotional", 1, 100_000],
["maxDailyNotional", 1, undefined],
```

and the payload envelope:

```ts
case "policy.patch":
  return { patch: normalizePolicyPatch(payload.patch ?? payload) };
```

Submission goes through the normal `store.submit` path, so it inherits the busy guard, the
idempotency key, and the post-command snapshot reload.  No extra confirmation ceremony was
added: this is the same weight of action as Close Only or Wind Down.

- `ios/SocraticTrade/PolicyTightening.swift` (new) — pure `PolicyTightening` enum
  (`tightenedAuthority`, `tightenedCap`, `tightenedCapOptions`, payload builders) plus the
  `GuardrailTighteningSection` view.
- `ios/SocraticTrade/HomeView.swift` — section wired into the settings Form.
- `ios/SocraticTrade/AppComponents.swift` — `policy.patch` added to `AppFormat.commandLabels`
  ("Policy Change" — neutral, because the same command type arrives from the console in either
  direction and Activity shows both).

### Item B — Decode `snapshot.catalog`

`app/api/mobile/snapshot/route.ts` already emits `catalog: mobileControlCatalog()`, whose
command list is literally:

```ts
commands: MOBILE_COMMAND_TYPES.map((type) => ({ type }))
```

- `ios/SocraticTrade/MobileModels.swift` — new `ControlCatalog` (`version`, `commands[].type`,
  `advertisedCommandTypes`, `describesCommands`), decoded as `MobileSnapshot.catalog?`.  The
  catalog's `auth` / `realtime` / `accountDeletion` blocks are deliberately NOT mirrored — the
  app does not act on them and dead model surface rots.
- `ios/SocraticTrade/MobileStore.swift` — `serverAdvertises(_:)` plus a gate inside `canSubmit`,
  and a specific `unavailableMessage` branch.
- `PolicyTightening`'s whole section is hidden when `policy.patch` is not advertised.

### Item C — Universal links + deep-link routing

- `ios/SocraticTrade/DeepLink.swift` (new) — pure, total `DeepLink.destination(for:)`.
- `ios/SocraticTrade/SocraticTradeApp.swift` — first `onOpenURL` in the app; the pending
  destination is held on `ContentView` so a link arriving before sign-in still routes.
- `ios/SocraticTrade/MobileControlView.swift` — applies the destination through the EXISTING
  rerouting `selection` binding, so a link to an unpinned screen lands in the More stack (the
  documented pattern, reused rather than duplicated), and holds `focusedProposalId`.
- `ios/SocraticTrade/ProposalsView.swift` — optional `focusedProposalId` binding: the matching
  card gets `.id(proposal.id)`, an accent ring, and is scrolled to.
- `ios/SocraticTrade/AppComponents.swift` — `SnapshotScaffold` gained an optional `scrollTarget`
  (wrapped in a `ScrollViewReader`; re-scrolls when the snapshot lands, since the target row may
  not exist yet).
- `ios/SocraticTrade/SocraticTrade.entitlements` + `ios/project.yml` — `applinks:socratictrade.com`
  in BOTH (xcodegen rewrites the entitlements file from `project.yml`, so an entry only added to
  the file is lost on the next regen).
- `app/.well-known/apple-app-site-association/route.ts` (new) — appIDs
  `CC8UTF7ATG.trade.socratic.app`, `application/json`, no `.json` extension, paths limited to the
  five routes the app actually handles.
- `middleware.ts` — `/.well-known/apple-app-site-association` added to `PUBLIC_PREFIXES`.

Routing table (and therefore the AASA claim):

| URL | Destination |
| --- | --- |
| `/console/approvals` | Proposals tab |
| `/console/approvals/<id>`, `/console/approvals?proposal=<id>` | Proposals tab, that card focused |
| `/console/orders`, `/console/watchlist` | Assets tab |
| `/console/activity` | Activity tab |

### Docs

- `STATUS.md` (new Current stanza), `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md`
  (new row), this note.

## 3. Decisions & Trade-offs

- **Tighten-only is deliberate asymmetric friction, not paternalism.**  The server accepts both
  directions and these are the owner's own adjustable preferences; the reason the phone only
  tightens is the DEVICE, not the owner's risk appetite.  A phone is the surface most likely to
  fire an unintended tap or be operated with three seconds of attention, and only edits that
  cannot increase exposure are safe under those conditions.  Loosening is one tap away in the
  console.  The reasoning is written into the file's doc comment so a later agent does not
  "helpfully" symmetrize it or, worse, bolt an are-you-sure dialog onto the tightening.
- **Percent-of-NAV caps refuse outright.**  `src/lib/policy-normalization.ts`
  (`normalizeExclusivePolicyCaps`) treats notional and percent caps as either/or: sending a
  notional while a percent cap is stored DELETES the percent cap and changes which rule binds —
  which can be a loosening in practice.  Switching cap modes stays a console decision.  Practical
  consequence: on a policy where `maxOrderPctOfNav` is set, the Max Order row shows
  "set as % of NAV — console only" rather than a reduction menu.
- **Protective commands are never catalog-gated.**  A halt must not depend on the catalog
  decoding correctly, so `canSubmit` returns true for stop / close-only / wind-down / reject
  before the catalog is consulted.
- **Missing catalog means "unanswered", not "unsupported".**  Nil catalog or an empty `commands`
  array falls back to the app's built-in controls, so an older server never silently disables
  working buttons.
- **The custom scheme stays auth-callback-only.**  `socratictrade://` is consumed inside
  `ASWebAuthenticationSession` (which never routes through `onOpenURL`) and any app on the device
  can register the same scheme, so a content route arriving on it is a mistake or a spoof —
  `DeepLink` rejects it.
- **Only the apex host is accepted.**  `console.` / `mobile.` / `www.` are real hosts but are not
  in the entitlement, so accepting them in the parser would describe routing iOS will never
  perform.
- **No new proposal-id URL convention on the web.**  Nothing in the console currently links to a
  single proposal; the app accepts both `/console/approvals/<id>` and `?proposal=<id>` so whichever
  convention the web adopts later already works.
- **AASA is `force-static`** with a one-hour cache header — it is a constant document and Apple's
  CDN fetches it out-of-band.
- **Deviation from the "iOS-only plus ONE web file" scope:** the middleware `PUBLIC_PREFIXES`
  entry.  Without it Apple's anonymous fetch 307s to `/login` and the domain never claims the
  app, i.e. the feature would be dead on arrival.  It is one line and adds no new public content.

## 4. Verification State

```
cd ios && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project "Socratic Trade.xcodeproj" -scheme SocraticTrade \
  -destination 'platform=macOS,variant=Designed for iPad' test
#   Executed 56 tests, with 0 failures (0 unexpected)   ** TEST SUCCEEDED **
#   (baseline before this branch: 37 tests)

npx tsc --noEmit                     # clean
npx vitest run test/apple-app-site-association-route.test.ts \
  test/subdomain-routing.test.ts test/security-headers.test.ts test/logout-route.test.ts
#   Test Files 4 passed (4)   Tests 16 passed (16)
npx eslint app/.well-known middleware.ts test/apple-app-site-association-route.test.ts  # clean
npm run build                        # Compiled successfully; ○ /.well-known/apple-app-site-association
```

New tests: `ios/SocraticTradeTests/DeepLinkTests.swift` (7), `PolicyTighteningTests.swift` (7),
`ControlCatalogTests.swift` (4 + the 1 shared store case), `test/apple-app-site-association-route.test.ts` (3).

`ios/Socratic Trade.xcodeproj/project.pbxproj` was regenerated with `xcodegen generate` (three
new .swift files) and the fleet header re-applied: `objectVersion = 100` +
`preferredProjectObjectVersion = 100` (the inner `PBXProject` value was aligned to 100 too, matching
Usage-Monitor).  `Info.plist` version keys are untouched — `project.yml` declares them as build
variables, as intended.

## 5. Next Steps & Blockers

- **Owner action (no agent credential work was performed, per standing rule):** the associated
  domain only takes effect for a build that ships with the entitlement.  Automatic signing
  produced a valid device build locally, but the App ID's Associated Domains capability and the
  next TestFlight upload are owner-side steps.
- After deploy, verify the domain half:
  `curl -sI https://socratictrade.com/.well-known/apple-app-site-association` (expect 200 +
  `content-type: application/json`, no redirect to /login).
- Follow-ups deliberately NOT taken here: no web-side "link to this proposal" affordance was
  added (the parser already accepts both shapes when one is wanted), and no notification payload
  was changed to carry deep links.

## 6. Zero-Code Findings

- The app previously had NO `onOpenURL` anywhere: every link into it was silently dropped.
- `mobileControlCatalog()` has been emitted on both `/api/mobile/snapshot` and
  `/api/mobile/bootstrap` for some time with no client reading it.
