# iOS fleet ship tooling

This directory is the **source of truth** for the fleet-wide TestFlight ship scripts used by all three apps (Socratic-Trade, Congress.Trade, Usage Monitor).  The runtime install location is `/Users/jay/apps/ios-fleet/`, which is outside version control — twice in one week an unversioned host script there carried a defect nobody could review (a reattach cron that opened a 60s outage window every minute; a macOS `flock` bug that would have shipped an empty version string).  This directory exists so the same scripts get code review, history, and PRs before they run.

## Files

- `ship-testflight.sh` — archive + export + upload a single app to TestFlight without the Xcode UI.
- `ship-all.sh` — ship all three fleet apps sequentially.
- `apps.json` — per-app registry (bundle id, scheme, project paths, team id).
- `asc-api.mjs` — minimal App Store Connect API client (ES256 JWT, no dependencies).  Used by `ship-testflight.sh` for export-compliance (`ensure-tf-ready`) and for build-number verification (`latest-build-seq`).
- `appstore-connect.env.example` — template for `~/.secrets/appstore-connect.env`; variable **names** only, no values.
- `ExportOptions-appstore.plist` — export options for `destination=upload`.
- `ExportOptions-export-ipa.plist` — export options for `destination=export` (local IPA only).
- `test-ship-seq.sh` — offline tests for the build-number rules (see **Tests**).  Repo-only; not installed to the runtime location.

Secrets (ASC API key id/issuer/path) are read at runtime from `~/.secrets/appstore-connect.env`; none of the files here contain secret values, only the names of the environment variables they expect.

## Install (sync repo copy -> runtime location)

```bash
install -m 0755 scripts/ios-fleet/ship-testflight.sh /Users/jay/apps/ios-fleet/ship-testflight.sh
install -m 0755 scripts/ios-fleet/ship-all.sh /Users/jay/apps/ios-fleet/ship-all.sh
install -m 0644 scripts/ios-fleet/apps.json /Users/jay/apps/ios-fleet/apps.json
install -m 0644 scripts/ios-fleet/asc-api.mjs /Users/jay/apps/ios-fleet/asc-api.mjs
install -m 0644 scripts/ios-fleet/appstore-connect.env.example /Users/jay/apps/ios-fleet/appstore-connect.env.example
install -m 0644 scripts/ios-fleet/ExportOptions-appstore.plist /Users/jay/apps/ios-fleet/ExportOptions-appstore.plist
install -m 0644 scripts/ios-fleet/ExportOptions-export-ipa.plist /Users/jay/apps/ios-fleet/ExportOptions-export-ipa.plist
install -m 0644 scripts/ios-fleet/AppUpdatePrompt.swift /Users/jay/apps/ios-fleet/AppUpdatePrompt.swift
```

Edit the runtime copy only through this repo: change the file here, land the PR, then re-run the `install` commands above to sync `/Users/jay/apps/ios-fleet/`.

## Versioning contract

| Field | Value | Example |
| --- | --- | --- |
| `MARKETING_VERSION` (`CFBundleShortVersionString`) | `1.0.<seq>`, +1 on every rebuild | `1.0.8` |
| `CURRENT_PROJECT_VERSION` (`CFBundleVersion`) | UTC `YYYYMMDDHHMM` | `202608121315` |

App Store Connect renders these as `<marketing> (<build>)`, so a ship shows **`1.0.8 (202608121315)`** — the parenthetical says *when* the build was cut.

An earlier revision set both fields to the same dotted string, which rendered as the uninformative `1.0.7 (1.0.7)`.  That was also a live rejection trap: Apple requires `CFBundleVersion` to be strictly increasing *within a marketing train*, and `trade.congress.ios` has 15 builds numbered `202608070253` … `202608120521` sitting in the `1.0.0` train.  `1.0.7` is numerically far lower than any of them; the dotted scheme only worked because each new marketing version opened a fresh, empty train.  A ship that landed back in an older train would have been rejected *after* a full archive + upload.  The UTC stamp is monotonic by construction, exceeds every existing build, and is demonstrably legal for ASC — those 15 live builds use exactly this format.

`--dry-run` only peeks at the next value and does not consume it, and the sequence file is guarded by an atomic-`mkdir` lock (not `flock(1)`, which does not exist on macOS) so concurrent ships cannot race the counter.

### Where the number comes from

The next sequence is **`max(local cache, App Store Connect, project.pbxproj) + 1`**.

`~/.cache/ios-fleet/build-seq-<app>.txt` is a *cache*, not the source of truth.  It is a single unbacked file on one machine: if it is lost, reset, or a ship runs from a second machine, a bare "+1" reuses a build number and App Store Connect rejects the upload as a duplicate.  Taking the max of every record we have is monotonic against all of them.  It can skip a number — harmless, numbers are free — but it cannot reuse one, which is fatal.

The three inputs are printed on every run, e.g. `seq sources: local=2 asc=1 project=4 -> floor=4`.

- **App Store Connect** is queried with `asc-api.mjs latest-build-seq <bundleId> 1.0`, using the same credentials already passed to `xcodebuild`.  That command reads **`preReleaseVersions[].attributes.version`** (the marketing version), *not* `builds[].attributes.version` (the build number) — the two are different fields, and the sequence tracks the marketing version.  Reading build numbers only ever worked during the window when both fields held the same string, and was already silently wrong for `socratic`, whose newest marketing version is `1.0.1` but whose build numbers are `2` / `1` / `202608120212`: none match `1.0.N`, so ASC contributed `0` and "verification" verified nothing.  Build numbers are still scanned afterwards so the floor can never come back *lower* than the old behaviour reported.

### Nothing is consumed by a run that will not ship

A build number is committed to the counter only by a run that is actually about to archive.  The ship gate (rate limit / same-HEAD) is evaluated **before** the sequence is touched, `--dry-run` peeks only, and `--upload-only` resolves no sequence at all because the IPA already carries its versions.  Before 2026-08-12 the gate ran *after* the counter had advanced, so every rate-limited attempt burned a version that shipped nowhere — observed live: a run skipped at 4392s of a 9000s interval and the sequence still went 5 → 6, leaving `1.0.6` existing in no place at all and the local counter drifting further from ASC.

`test-ship-seq.sh` pins all of this down; see **Tests** below.
- **`project.pbxproj`** participates in the max, so the project file can never be silently disagreed with.  The resolved version is passed on the `xcodebuild` command line and overrides whatever the project file says, so a run whose resolved version differs from the project file prints a `NOTICE` naming both.  `--sync-project-version` writes the resolved version back into the project file (opt-in: it dirties the worktree, and shipping requires a clean one).
- If **ASC cannot be consulted at all** and there is no local sequence and no on-train version in the project file, the script **fails** rather than guessing, and prints the three ways to resolve it.  `--allow-unverified-seq` overrides, with a warning.

`IOS_FLEET_STATE_DIR` relocates the sequence/rate-limit state, for testing against a scratch directory.

## Rate limit — what holds back automatic shipping

Uploads are throttled to **one successful ship per app per `DEFAULT_MIN_INTERVAL_SEC` = 3600 seconds (1 hour)**.  The constant lives near the top of `ship-testflight.sh`.  This is the main reason a merge to `main` does not become a TestFlight build: `.github/workflows/ios-ship.yml` fires on every push touching `clients/ios/**`, and most of those runs land inside the window, print `ship-gate: skip`, and exit 0.  A run whose git HEAD already shipped skips for the same reason.  Cron ticks twice an hour, so an unbuilt merge is picked up on the next eligible hour.

- **Override one run:** `IOS_TF_MIN_INTERVAL_SEC=<seconds>` in the environment, or `--force-ship`.
- **Change the standing limit:** edit `DEFAULT_MIN_INTERVAL_SEC`.  That is the owner's call — the number is a local/process-hygiene choice, not an Apple constraint.
- `--export-only` and `--dry-run` are not rate limited; neither builds a TestFlight upload.

The skip message names the value, its source, and both overrides, so the limit is discoverable from the log rather than only from this file.

## Tests

```bash
bash scripts/ios-fleet/test-ship-seq.sh
```

47 assertions, fully offline — no network, no Xcode, no credentials.  It runs `ship-testflight.sh` with `HOME`, `PATH` and `IOS_FLEET_STATE_DIR` pointed at a scratch sandbox (a fake `xcodebuild` refuses to archive), so it cannot touch real ship state or App Store Connect.  It pins:

- a rate-limited run, and a same-HEAD run, exit 0 **without advancing the counter** (this is the 2026-08-12 regression, and the suite fails against the pre-fix script exactly there);
- a gated run does not even make the ASC round trip;
- an allowed run advances the counter by **exactly one**, three in a row give 6 → 7 → 8;
- `--dry-run` and `--upload-only` consume nothing; `--force-ship` still bypasses the gate;
- for **all four apps**: marketing is `1.0.N`, the build number is a 12-digit UTC stamp, the two differ, and the stamp exceeds `202608120521` (the highest build already live on `trade.congress.ios`, so a ship landing back in the old `1.0.0` train would still be accepted);
- the skip message names the 3600s default and both overrides;
- a last-ship 3000s ago is still gated (sequence untouched); at 3700s the gate proceeds.

## Drift check

`check-drift.sh` compares the sha256 of each file here against its counterpart in `/Users/jay/apps/ios-fleet/` and fails if they differ, so the repo copy cannot silently go stale relative to what actually runs.  Run it locally with:

```bash
bash scripts/ios-fleet/check-drift.sh
```

It exits 0 with a warning (not a failure) when `/Users/jay/apps/ios-fleet/` does not exist on the current machine, since that directory is host-local and won't be present in CI.

## In-app update prompt

Every fleet iOS app copies `AppUpdatePrompt.swift` from this directory (the
in-repo pin) into its app target and calls `.appUpdatePrompt()` on the root
view.  Do not fork the file.  Do not make a Swift package.

Apple IDs and marketing versions live in the public fleet manifest
https://raw.githubusercontent.com/jaywedgeworth22/ai-fleet-coordinator/main/site/ios-versions.json
(and the local mirror `ios-app-versions.json`).  `apps.json` is the ship
registry.  Live DealDex is `net.dealdex` appleId `6802474288`.
`online.dealdex` is not the live bundle.  Do not upload `me.grok.dealdex`.

`publish-ios-versions.sh` writes both the local mirror and the public
`site/ios-versions.json` on ai-fleet-coordinator after a successful ship.

Copy into this repo's iOS target:

```
cp scripts/ios-fleet/AppUpdatePrompt.swift ios/SocraticTrade/AppUpdatePrompt.swift
```

