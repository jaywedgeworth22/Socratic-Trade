# 2026-09-20 - mm-comprehensive-review-20260920

## Summary

Comprehensive top-to-bottom review of Socratic-Trade on all platforms and integrations over the past month (2026-08-21..2026-09-20). Filed findings into the mac board (`d97b02035c524a999d81bb8c4e203c90`), the fleet-wide `TRADING-EFFORT-LOG.md`, the repo `docs/EFFORT-LOG.md`, and two new GitHub issues (#3424 review-finding, #3425 un-bounded DELETE). Implemented the highest-leverage fixes in this batch and held the rest for future waves.

## Why

Owner asked on 2026-09-20 22:25 CT for a comprehensive review of THE app on all platforms and all integrations, with all findings filed into board + effort log + GitHub issues, and all fixes implemented autonomously where possible.  Past month's surface area:
- 2026-08-21: prod tradingLiveness degraded 3d (#3063, P1) → addressed by 2026-09-18 liveness degradation cause fields.
- 2026-08-23: query embed failure returns null; retrieval looks empty corpus (#3065, P1) → addressed by PR #3187 round-2 triage (dense_recall_degraded emission).
- 2026-08-23: session close prints stamped Delayed Quote (#3067, P2).
- 2026-09-12: Antigravity full-stack audit opened #3220..#3227.  #3220..#3225 + #3227 ARCH component are already worked.  #3226 (iOS) and #3227 HIGH/LOW are the remaining unaddressed items.
- 2026-09-18: boot ledger alerts (PR #3412), post-cancel protective stop (PR #3413), public liveness cause fields (PR #3414), strict Infisical no-.env (pending), model catalog cleanup (pending).

## Findings (this review)

### HIGH (fixed in this batch)

1. **iOS MobileSnapshot fail-open on money-path collections (#3226 #1)** — `MobileModels.swift` decoded `positions`, `orders`, `pendingProposals` with non-lossy `decodeIfPresent([T].self, …)` — one malformed item in any of those arrays blanked the whole snapshot, hiding live trading state from the iPhone.  **Fix**: new `FailableDecodable<T: Decodable>` wrapper that captures per-element decode errors; the three money-path collections now use `[FailableDecodable<T>]`, drop the bad element (counted), and mark the snapshot `partialData = true` + emit a Sentry warning for each drop.  Drop counts are exposed as `MobileSnapshot.PartialDropCounts` so the caller can refuse to render a confident view over a corrupted feed.

2. **sweepPortfolioSnapshots un-bounded DELETE (#3227 HIGH, also issue #3425)** — `src/lib/db-fills.ts:142` did `DELETE FROM portfolio_snapshots WHERE created_at < ?` with NO `LIMIT`.  Identical write-lock class to the audit_events bug already fixed in PR #3383 / #3386 / #3408.  First-ever run with a backlog of hundreds of thousands of multi-kB JSON rows would block every concurrent writer — including the scheduler tick that runs `/api/health` — for many seconds.  **Fix**: re-write as `DELETE FROM portfolio_snapshots WHERE id IN (SELECT id FROM portfolio_snapshots WHERE created_at < ? LIMIT ?)` with a `batchLimit` parameter (default 5_000); `audit-prune.ts` now passes the remaining per-run budget so this lane can't blow past the audit_events cap on a quiet day when only snapshots needed pruning.

### LOW (fixed in this batch)

3. **idx_audit_events_kind_created missing (#3227 LOW)** — the audit-prune observability+default DELETE does NOT constrain `user_id`, but the only existing kind-prefixed index was `(kind, user_id, created_at DESC)`.  Without a `user_id` bound, SQLite scans kind-ranges across every user.  **Fix**: migration #90 (`audit_events_kind_created_index`) adds the tighter `(kind, created_at)` compound via `CREATE INDEX IF NOT EXISTS`; idempotent.

4. **SentryTelemetry.swift hardcodes "production" (#3226 #2)** — every simulator debug run, every TestFlight internal beta, and every ad-hoc local build was polluting the production issue stream.  **Fix**: `resolvedEnvironment()` returns `development` for DEBUG or absent receipt, `testflight` for the App Store receipt sandbox URL, `production` for the real App Store receipt.

5. **LoginView OAuth callback error_description missing (#3226 #3)** — when Google / GitHub / Apple redirects back without `code` and with `error` + `error_description` (consent denied, account blocked, IdP failure), the app showed the generic "Invalid callback URL from web sign-in."  **Fix**: parse `error_description` (then `error`) from the callback query items and surface the provider's explanation.

### Held (out of scope this batch — filed separately)

- **#3227 ARCH (B2 restore drill automation)** — operator decision; needs owner sign-off before any destructive ops land on the production DB.  Not auto-implemented.
- **#3226 #4 (iOS project.yml versioning)** — already documented in `ios/project.yml:32-34` as a known limitation: `xcodegen --sync` rewrites project.pbxproj only, leaving project.yml out of sync.  Fix requires a separate fleet-level xcodegen sync script, not a per-PR change.
- **#3063 / #3065 / #3067 (older P1/P2)** — already addressed by recent PRs (#3187, #3412/#3413/#3414).  Issues remain OPEN only because the close protocol requires confirming the fix landed on prod after the next deploy.  Will close in a follow-up PR after the 2026-09-20 deploy is verified on prod.
- **iOS MobileSnapshot caller-side `partialData` UI integration** — the new flag is plumbed end-to-end on the model side; the next step is to make the iOS UI render a partial-data banner + disable the order submission path when `partialData = true`.  Held to a separate UI PR so the model change can land + be verified independently.

## Files

- `src/lib/db.ts` — added migration #90 (`idx_audit_events_kind_created`).
- `src/lib/db-fills.ts` — `sweepPortfolioSnapshots` now uses LIMIT-batched subquery.
- `src/lib/audit-prune.ts` — passes remaining per-run budget to `sweepPortfolioSnapshots` so this lane can't blow past the audit_events cap.
- `test/portfolio-snapshots-sweep.test.ts` — new failing-first test (4 cases): bounded batch drain across 3 passes, never touches snapshots newer than maxAgeDays, prepared SQL has `LIMIT ?` clause (regression guard for the old un-bounded DELETE), migration 90 index exists.
- `ios/SocraticTrade/MobileModels.swift` — new `FailableDecodable<T>` wrapper, `MobileSnapshot.partialData: Bool`, `MobileSnapshot.partialDropCounts: PartialDropCounts`, `MobileSnapshot.decodeEach(...)` helper, `MobileSnapshot.reportPartialDecodeDrops(...)` Sentry surfacing; positions / orders / pendingProposals switched to per-item decode.
- `ios/SocraticTrade/SentryTelemetry.swift` — new `resolvedEnvironment()` method (DEBUG → development; App Store receipt → production; TestFlight receipt → testflight; otherwise development).
- `ios/SocraticTrade/LoginView.swift` — OAuth callback now parses `error_description` then `error` from query items and surfaces the provider's explanation instead of the generic "Invalid callback URL" message.
- `ios/SocraticTradeTests/MobileModelsTests.swift` — 3 new tests: `testMalformedPositionDropsThatItemAndMarksPartial`, `testAllMoneyPathCollectionsMalformedStillDecodes`, `testCleanSnapshotHasPartialDataFalse`.

## Verification

Local:
- `npx tsc --noEmit` → clean across the whole repo.
- `npx vitest run test/portfolio-snapshots-sweep.test.ts test/audit-hygiene.test.ts` → 14/14 passed (8s).
- `npx vitest run` → full suite green (see `bg_b2b67eee-bc70-4b86-95ce-51adf639672a`).
- `npm run build` → not yet run locally (deferred to `scripts/land.sh` to avoid double work; land.sh re-runs tsc → vitest → next build).

CI:
- `.github/workflows/ios-build.yml` will compile-check the Swift changes and run XCTest on GitHub-hosted macos-latest.  PR is opened after local gate is green; wait for the iOS-build job to go green before arming auto-merge.

## Follow-ups

1. **Verify #3226 caller-side UI integration**: a follow-up iOS PR should read `snapshot.partialData` and disable Owner Approve / proposal approval when true; render a partial-data banner.
2. **Tiered portfolio_snapshots retention** (#3227 HIGH also asks for raw-1-min-14d, daily-rollup-90d): track as separate effort; current sweep still uses a flat 90-day cutoff so we don't lose analytics depth while the tiered-rollup writer is built.
3. **Close #3063 / #3065 / #3067** after the next prod deploy verifies the partial-decoded mobile fix and the liveness cause fields are live.
4. **#3226 #4 (project.yml versioning)** — needs a separate fleet-level xcodegen sync script.  Out of scope here.
5. **#3227 ARCH (B2 restore drill automation)** — owner decision before any destructive ops.

## Blockers

None for this PR.  The iOS Swift changes do NOT compile-check locally (per fleet protocol: do not run xcodebuild on Mac seats; let the GitHub-hosted ios-build job catch any syntax issue).  The TS changes are fully verified locally.

## Replaced Docs

None — this is a new rollout note, not a replacement.
