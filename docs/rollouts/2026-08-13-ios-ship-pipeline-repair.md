# 2026-08-13 — iOS ship pipeline repair (Socratic-Trade side)

## 1. Context & Objective

A fleet-wide audit found six defects in the iOS TestFlight ship pipeline, the
worst of which is that PRs merged by `github-actions[bot]` land on `main` without
dispatching **any** workflow — so neither CI nor `ios-ship` ever runs on the
merge commit.  This note covers the Socratic-Trade-repo half of the repair plus
the two shared-tooling fixes that had to land alongside it.  Congress.Trade and
Usage-Monitor are owned by a peer agent in the same effort; nothing here touches
those repos.

Every finding below was re-confirmed against live data in this session, not taken
on faith from the audit text.

## 2. Changes Made

### Defect 1 — bot merges dispatch no workflow events

**Re-confirmed here.**  PR #2675 was merged by `github-actions[bot]`; merge sha
`ca38bb29797d46b68d9dd6a92006cdfb9c9cb20b` has 27 workflow runs and **zero** of
them are `event: push` (24 `workflow_run` Sentry reactions, one `schedule` CI,
one `schedule` effort-sync, one `workflow_dispatch` ios-ship).  PR #2680, merged
by `jaywedgeworth22`, gets the full push-triggered set.  So the audit's claim
that Socratic-Trade is exempt is **wrong** — ST has the identical defect and only
looked healthy because `ios-ship.yml` carries a `schedule:` cron.

Root cause: GitHub raises no workflow events for actions performed with the
repository's `GITHUB_TOKEN`.  `auto-merge-prs.yml` already *said* it preferred
`GH_PAT` / `SHEPHERD_TOKEN`, but `gh api repos/.../actions/secrets` shows the
repo has only `CONGRESS_TRADING_SHARED_DEPLOY_KEY`, `DEEPSEEK_API_KEY`,
`GH_PACKAGES_TOKEN`, `SENTRY_AUTH_TOKEN`, `SENTRY_FLEET_DSN` — **neither
`GH_PAT` nor `SHEPHERD_TOKEN` exists**, and the account is a user, not an org, so
there is no org secret scope either.  The `||` fallback chain silently resolved
to `GITHUB_TOKEN` on every run; the stated preference was decorative.

Fix, in three layers:

- **Layer 1 (root cause).**  `auto-merge-prs.yml` and
  `auto-merge-shared-dependency.yml` now gate arming on an elevated token being
  present (`HAS_PAT` computed from `secrets.GH_PAT != '' || secrets.SHEPHERD_TOKEN != ''`,
  the pattern `_merge-shepherd-impl.yml` already proved works).  With no such
  secret they log why and exit 0 **without arming**.  `scripts/merge-shepherd.sh`
  got the same guard on its direct `gh pr merge` path — it previously consulted
  `HAS_PAT` only for the `update-branch` re-sync, so it would still have merged
  as the bot.  PRs then land the way `AGENTS.md` already mandates: the landing
  agent's own `scripts/land.sh` ends in `gh pr merge --auto --squash` under the
  owner's gh credentials (verified present at `scripts/land.sh:258-263`), so
  `merged_by` is a human identity and every push-triggered workflow fires.
- **Layer 2 (backstop).**  `ci.yml` gains an hourly `17 * * * *` cron plus a
  redundancy gate in `classify`: it resolves `main` HEAD, asks the Actions API
  whether that sha already has a successful `CI` run (excluding itself), and
  skips the suite when one exists.  Almost every tick is a ~10s no-op.  The gate
  is **fail-closed** — any API or parse problem runs the full suite.  It cannot
  fire on `pull_request` / `merge_group` / `push`, so it can never short-circuit
  the required check on a PR.  The nightly `47 7 * * *` canary is deliberately
  exempt so the Next build-cache lineage keeps getting refreshed.
- **Layer 3 (iOS).**  ST already had the cron.  What it did **not** have was the
  guard that makes a cron safe — see the next section.

### Defect 1b — the ST cron was shipping backend-only commits (review blocker)

**Caught in review, and it was already live.**  ST's `*/30` cron carried no
`paths:` filter, and the ship script's own gate only tests "is HEAD the sha I
last shipped" plus a time interval — neither of which knows whether `ios/`
changed.  Receipt: run **31723515355** (`event: schedule`, 2026-08-13T17:00Z)
logged `ship-gate: ok — 22967s since last ship … HEAD 39c6acee9b`, then
`archiving...`, then `recorded success sha=39c6acee9b`.  Commit `39c6acee` is
`fix(alerts): stop RH MCP schema 400s, Pinecone 40960 overflow, and
overloaded-429 pages` — eight files, **zero** under `ios/`.  That build went to
testers as a byte-identical app with a new build number.  ST has the fleet's
highest commit volume, so the unguarded cron was the single biggest TestFlight
spam source, not an edge case.

Fixed with the same guard the peer agent built for CT/UM, ported here as
`scripts/ios-scheduled-ship-gate.sh` (`--path-prefix 'ios/'`, app key
`socratic`).  It runs **first** in `ios-ship.yml`, so a tick with nothing to
ship costs seconds and cannot go red on an unrelated environment problem; the
Xcode assert and the ship step are both `if: steps.gate.outputs.should_ship == '1'`.
`push` and `workflow_dispatch` bypass it entirely — a push already passed the
workflow's `paths:` filter and a dispatch is an explicit instruction.

The logic is a **script, not inline YAML**, precisely because it otherwise
executes only on the one Mac that can ship.  `scripts/test-ios-scheduled-ship-gate.sh`
(13 assertions, fully offline — throwaway git repos in a scratch dir, no
network, no credentials, no `xcodebuild`, no ASC) now runs in `ci.yml` on every
PR.  It covers push/dispatch bypass, no ship history, already-shipped HEAD,
**backend-only commits → skip**, iOS change → ship, per-app independence, the
three unreachable-sha fallbacks, and that "skip" is never a non-zero exit.

Removing the `IOS_TF_MIN_INTERVAL_SEC: 3600` override (defect 6) and adding this
gate are complementary, not redundant: the interval limits *how often* a ship
may happen, the gate decides *whether there is anything worth shipping*.  Only
the second one can tell an iOS change from an alerts refactor.

### Defect 2 — export compliance declared on the WRONG build

**Re-confirmed here** by reading `asc-api.mjs:197`: it fetched
`/v1/builds?filter[app]=<id>&sort=-uploadedDate&limit=1` and treated the newest
build as the one just uploaded.  Immediately after an upload the new build has no
ASC record at all, so "newest" is the **previous** ship — already `VALID`,
already `IN_BETA_TESTING`.  The `enc !== false` guard made the compliance PATCH a
no-op and the readiness poll succeeded on poll 1, printing "TestFlight internal
testers can install this build" about a build it never inspected.

Fixed by making `CFBundleVersion` a **required argument**:

- `ship-testflight.sh` now calls `ensure-tf-ready "$BUNDLE_ID" "$BUILD_NUM" "$MARKETING"`.
  `BUILD_NUM` is the same value already passed to `xcodebuild` as
  `CURRENT_PROJECT_VERSION`, and ASC ingests it verbatim as
  `builds[].attributes.version` (documented at `asc-api.mjs:99-103`).
- `asc-api.mjs` polls `filter[version]=<build>` (plus
  `filter[preReleaseVersion.version]=<marketing>` as a second predicate) until
  the build appears, then declares compliance and waits for readiness **on that
  id**.  Budget `IOS_TF_READY_TIMEOUT_SEC`, default 900s; the old budget was
  12 x 10s = 120s, which is why every run gave up before the build existed.
  0 results → keep polling; >1 → exit 2 rather than guess; timeout → new exit 4.
- There is deliberately **no** "newest build" fallback.  That fallback is the
  defect.
- Exit 4 warns loudly (and emits `::warning::` under Actions) but does **not**
  fail the ship: the upload genuinely succeeded, and `record_successful_ship`
  must still run or the rate gate never advances and the next cron re-ships the
  same HEAD.

Severity note: this is currently **latent, not active**.  All three apps carry
`ITSAppUsesNonExemptEncryption` in their Info.plists, which is what actually
keeps builds installable; the backstop added after ST 1.0.1/1.0.2 was simply
inert.  It becomes live the moment a target ships without that key.

### Defect 3 — "What to Test" empty on every build

`betaBuildLocalizations` is **absent**, not blank, so the implementation must
CREATE (`POST`) and not only `PATCH`.  `asc-api.mjs` now renders the mandatory
`/Users/jay/apps/AGENT-SYNC.md` template from the commit range since the last
successful ship.

Blocker found while implementing, **not in the audit**: all three `ios-ship.yml`
files use bare `actions/checkout@v4`, so the runner workspace is shallow with
exactly one commit and `git log <prev>..HEAD` fails with "unknown revision".  A
naive implementation would emit zero bullets on every CI ship and look fixed.
ST's checkout now sets `fetch-depth: 0`.

Rendering rules implemented: conventional-commit prefix stripped; trailing
`(#NNNN)` harvested into the header and stripped from the bullet; noise dropped
(`merge|bump|wip|revert`, <12 chars); case-insensitive dedupe; 10-bullet cap with
iOS-path commits as the tie-break; 4000-char truncation at a bullet boundary.
Agent names are removed structurally first (bracketed agent markers, `Agent:`,
`Co-Authored-By:`), then any bullet still matching the deny-list is **dropped
whole** — never word-deleted in place, which yields mangled copy.  A final
assertion re-scans the fully rendered body and skips the upload entirely if a
name survived.

**Corrected before landing (review finding).**  The first version of this file
claimed "`AG` is deliberately not in the deny-list; the structured-marker strip
covers `[AG] ...`".  That was **false for the corpus it runs against.**  The
strip was start-anchored (`/^\[[A-Za-z]+\]\s*/`) but the fleet writes the tag at
the **end**: measured 2026-08-13, Congress.Trade has **48** commit subjects with
a non-leading `[AG]` and **zero** leading ones (ST: 2 and 2).  So the marker was
stripped from none of them, and because `AG` was also absent from the deny-list,
the final assertion did not fire either — `[AG]` would have published to
TestFlight, which AGENT-SYNC's STRICT rule names explicitly.  Reproduced on
`fix(ios): set App Category to Finance and Display Name to Congress.Trade (#1030) [AG] (#1264)`,
which rendered the bullet with `[AG]` intact.

Fixed two ways: the marker strip is now **global and unanchored** over the known
agent tags (`[AG]`, `[Grok]`, `[Monet]`, … case-insensitive, tolerant of inner
spaces), and the deny-list gained a **bracketed-only** `\[\s*ag\s*\]` alternative
so the rendered-body assertion is a real backstop.  Bare `AG` still stays out of
the word-boundary deny-list — as a naked token it fires on ordinary English and
on tickers.  Stripping beats dropping here: the offending bullet keeps its
content (`- Set App Category to Finance and Display Name to Congress.Trade (#1030)`)
instead of vanishing.

Verified against the real corpora, 1500 subjects per repo: **CT 48 / ST 4**
subjects carry `[AG]`, and after the fix **zero** leak through the per-bullet
render, **zero** trip the whole-body assertion across every 40-subject chunk of
either history.

Timestamp renders via two `Intl.DateTimeFormat` calls joined with `" at "` —
one combined call produces `"Mon, Aug 12, 2026, 1:15 AM"` (comma), not the
template's `"at"`.  `America/Chicago` handles CDT/CST.  All prose generation
lives in Node so the non-ASCII `·` separator never transits bash (AGENTS.md bans
non-ASCII in operator shell scripts).

**This step is OPT-IN and defaults to a dry render.**  See Decisions below.

### Defect 4 — MARKETING_VERSION drift

`ios/project.yml` and `ios/Socratic Trade.xcodeproj/project.pbxproj` both said
`1.0.1` / `2` while ASC has shipped through **1.0.8 (202608132022, uploaded
2026-08-13 13:25 PT)** — read live via `GET /v1/builds?filter[app]=6799238379`.
Both files now record 1.0.8 / 202608132022.

Re-read at review time: the first pass wrote 1.0.6 / 202608131700, and the train
had already moved on (1.0.6 10:02 PT → 1.0.8 13:25 PT) before that commit was
even authored.  A hand-written snapshot is stale the moment the next ship lands
— which is the argument for the `--sync-project-version` follow-up below, not
against recording it.

The repo stays a **record**, not the source of truth: the ship script passes both
values to `xcodebuild` on the command line, and the sequence is
`max(local counter, ASC, pbxproj) + 1`, so writing 1.0.8 changes no future
outcome (ASC already reports 8).

`--sync-project-version` was **not** added to the workflow, because it is a
silent no-op for this app: it seds `project.pbxproj`, and `xcodegen generate`
runs afterwards and rewrites the pbxproj from `project.yml`, restoring the stale
value.  Making it work needs a change to the shared ship script — see Next Steps.

### Defect 5 — ios-fleet drift guard

`/Users/jay/apps/ios-fleet` is confirmed **not** a git repo.  ST's workflow ran
`/Users/jay/apps/ios-fleet/ship-testflight.sh` directly, bypassing even its own
`scripts/ios-ship-testflight.sh` wrapper, and would not have noticed a change.

Rather than vendor a second 38KB copy (Congress.Trade's approach — whose own
drift check is red today precisely because two copies exist with no defined
reconciliation direction), ST pins checksums:

- `scripts/ios-fleet.sha256` — sha256 of `ship-testflight.sh`, `asc-api.mjs`,
  `apps.json`, the three runtime files that can change what this repo ships
  (`apps.json` carries `marketingVersionDefault`, i.e. the version train).
- `scripts/ios-fleet-pin.sh` — `--check` (default) / `--update`.
- `scripts/ios-ship-testflight.sh` runs `--check` before exec'ing the fleet
  script, and `ios-ship.yml` now calls the wrapper instead of the fleet path, so
  the guard cannot be bypassed by accident.
- Escape hatch `IOS_FLEET_PIN_SKIP=1`, same spirit as `--force-ship`.

### Defect 6 — the 1h override, not the 2.5h doc, is the bug

`ios-ship.yml` was the only file in any fleet repo setting
`IOS_TF_MIN_INTERVAL_SEC` as a standing value (3600), against
`DEFAULT_MIN_INTERVAL_SEC=9000` in the ship script and "2.5 hours" in the fleet
README.  The script's own gate log calls the env var a per-run override and the
constant "owner's call".

Confirmed empirically from ASC upload timestamps for app 6799238379 — consecutive
gaps went **2.80h, 2.58h** before the override to **1.60h, 1.34h** after, exactly
matching the audit's "1h35m and 1h20m".

The introducing commit (`d6c79765`) justified the change by trailing commits
being stranded — a *trigger* problem (defect 1) that the `schedule:` cron added
in the same commit already solves.  Override removed; cron kept.

### Files touched

Socratic-Trade (`monet/ship-pipeline-fix`):

- `.github/workflows/auto-merge-prs.yml`
- `.github/workflows/auto-merge-shared-dependency.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/ios-ship.yml`
- `scripts/merge-shepherd.sh`
- `scripts/ios-ship-testflight.sh`
- `scripts/ios-scheduled-ship-gate.sh` (new — defect 1b)
- `scripts/test-ios-scheduled-ship-gate.sh` (new — defect 1b)
- `scripts/ios-fleet-pin.sh` (new)
- `scripts/ios-fleet.sha256` (new)
- `ios/project.yml`
- `ios/Socratic Trade.xcodeproj/project.pbxproj`
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note

Shared tooling, **NOT under version control** (see Decisions):

- `/Users/jay/apps/ios-fleet/asc-api.mjs`
- `/Users/jay/apps/ios-fleet/ship-testflight.sh`
- `/Users/jay/apps/ios-fleet/README.md`
- backup of all three pre-edit: `/Users/jay/apps/ios-fleet/.backup-monet-20260813/`

## 3. Decisions & Trade-offs

**The ios-fleet edits are unversioned and take effect immediately.**
`/Users/jay/apps/ios-fleet` is not a git repo — there is no PR gate, no history,
and the change is live for **all four** fleet apps the moment the file is saved.
Reversal is a file copy from `.backup-monet-20260813/`.  Revert `asc-api.mjs` and
`ship-testflight.sh` **together**: if the required-arg check survives while the
ship script reverts to the one-arg call, every ship's `ensure-tf-ready` exits 2.
Reverting also invalidates `scripts/ios-fleet.sha256`, so re-run
`bash scripts/ios-fleet-pin.sh --update`.

**Release notes default to a DRY RENDER, not to publishing.**  This is the only
step in the pipeline that writes owner-facing copy every TestFlight tester reads,
auto-generated from commit subjects nobody reviewed.  A bad bullet reaches every
tester.  So `IOS_TF_RELEASE_NOTES=1` publishes, `=0` disables, and **unset (the
default) renders the exact body into the ship log and writes nothing**.  No App
Store Connect write was performed while implementing this — every ASC call made
here was a `GET`.  The owner should read the rendered body from one or two real
ships, then flip the variable.  The `POST` create-body shape could not be
verified against Apple's docs in this session (JS-rendered pages) and no live
write was attempted, so treat the first real publish as its verification and read
the printed HTTP status.

**The pin guard hard-fails rather than warns.**  A warning nobody reads is the
status quo the guard exists to end.  The cost is real and is called out in Next
Steps: the peer agent is expected to edit `ship-testflight.sh` today for the
CT/UM iOS-paths guard, which will turn ST's next ship red until the pin is
refreshed (one command, 3-line PR).  Loud beats silent, and
`IOS_FLEET_PIN_SKIP=1` unblocks an emergency ship.

**Layer 1 trades a silent failure for a loud one.**  If an agent lands a PR and
forgets to arm auto-merge, the PR sits open on the PR list — visible, one command
to fix — instead of today's silent unverified merge.  `scripts/land.sh` already
arms it, so the normal path is unaffected.

**ASC stays the source of truth for versions.**  Making the repo authoritative
would hard-fail every ST ship starting today (repo 1.0.1 vs ASC 1.0.6) and cannot
serve a "+1 on every rebuild" counter driven by a 30-minute cron without a human
racing the automation.

**No credential was created.**  Layer 1 self-activates the instant the owner adds
a `GH_PAT` or `SHEPHERD_TOKEN` secret; minting it is an owner action.

## 4. Verification State

Node 24 on PATH (`export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`).

```
bash -n /Users/jay/apps/ios-fleet/ship-testflight.sh     # syntax OK
node --check /Users/jay/apps/ios-fleet/asc-api.mjs        # syntax OK
grep -nP '\$\{?\w+\}?[^\x00-\x7F]' ship-testflight.sh     # no $VAR-adjacent non-ASCII
bash scripts/ios-fleet-pin.sh --check                     # OK (rc 0)
IOS_FLEET_PIN_SKIP=1 bash scripts/ios-fleet-pin.sh        # bypass works (rc 0)
IOS_FLEET_DIR=<mutated copy> bash scripts/ios-fleet-pin.sh --check   # detects drift (rc 1)
xcodegen generate  (scratch copy of ios/)                 # regenerated pbxproj is
                                                          # byte-identical to the
                                                          # checked-in one; Info.plist
                                                          # keeps $(MARKETING_VERSION)
```

Repo gates, node 24 (`v24.19.0`):

| Gate | Result |
|------|--------|
| `npm run lint` | 764 problems, **0 errors**, 764 warnings (the grandfathered backlog) |
| `npx tsc --noEmit` | exit 0, clean |
| `npm test` | **563 files passed / 1 skipped (564)**; **6520 tests passed / 51 skipped (6571)**; 691.67s |
| `npm run build` | see STATUS.md |

All four workflow YAML files parse (`yaml.safe_load`); `ci.yml` exposes crons
`47 7 * * *` and `17 * * * *` and classify outputs `docs-only` + `redundant`.

Release-notes rendering was exercised directly against a throwaway importable
copy of `asc-api.mjs` (scratchpad; the real file was not modified for the test) —
covering a real commit range, an unreachable prev sha, no prev sha, and an
unusable repo path.  All four degrade correctly.

Agent-marker handling was then re-verified after the review fix, against the
**real** histories (1500 subjects each):

```
review's leaking subject (CT #1264)   -> marker gone, content kept
[AG] leading / trailing / inner       -> stripped in every position
[ag] lowercase, [ AG ] inner spaces   -> stripped
named agent ("Monet lane")            -> whole bullet dropped (unchanged)
CT corpus: 48 subjects carry [AG]     -> 0 leaks, 0 body-assertion failures
ST corpus:  4 subjects carry [AG]     -> 0 leaks, 0 body-assertion failures
passed=12 failed=0
```

Neither ship script was executed, no TestFlight build was uploaded, and every
App Store Connect call made in this session was a **GET**.

Exact gate numbers are recorded in STATUS.md.

## 5. Next Steps & Blockers

1. **Owner decision — elevated token.**  Add a fine-grained PAT or GitHub App
   installation token (contents + pull_requests write) as `GH_PAT`, and auto-merge
   re-activates fleet-wide with no further code change.  Until then, land PRs with
   `gh pr merge <n> --squash --auto` (which `scripts/land.sh` already does).
2. **Owner decision — publish release notes.**  Read the dry-rendered body in one
   or two ship logs, then set `IOS_TF_RELEASE_NOTES=1` in `ios-ship.yml`.
3. **Follow-up — make `--sync-project-version` work for XcodeGen apps.**  In
   `ship-testflight.sh`, write `${XCODEGEN_DIR}/project.yml` (anchored to the
   `settings.base` keys only — never `info.properties`, whose `$(MARKETING_VERSION)`
   substitutions must survive) and re-apply the pbxproj sed *after* the xcodegen
   step.  Until then version drift must be corrected by hand.
4. **Coordination — pin refresh.**  Any edit to
   `/Users/jay/apps/ios-fleet/{ship-testflight.sh,asc-api.mjs,apps.json}` makes
   ST's pin stale and the ship job fails red.  Fix:
   `bash scripts/ios-fleet-pin.sh --update` and land it.  Note the new scheduled
   gate runs *before* the pin check, so ticks with nothing to ship no longer go
   red on a stale pin — the exposure is now only ticks that would really ship.
   Emergency single-ship bypass: `IOS_FLEET_PIN_SKIP=1`.
5. **Follow-up — release-notes signal quality.**  Only `merge|bump|wip|revert` is
   filtered, so ops/CI/docs commits publish as bullets ("Parse Coolify deploy
   lists that use numeric object keys" is not something a TestFlight tester can
   act on).  Separately, dropping a whole bullet on a deny-list hit removes
   roughly 15% of CT's real subjects (196 of 1274 end in a bracketed agent tag)
   — the bracketed-marker strip now rescues the `[AG]`-style ones, but a bullet
   whose prose genuinely names an agent still vanishes.  Both argue for reviewing
   the dry-rendered output before flipping `IOS_TF_RELEASE_NOTES=1`.
6. **Not done here, by scope:** the iOS-paths guard inside `evaluate_ship_gate`
   itself.  ST/CT/UM now each gate the *scheduled* path in the workflow, which
   covers the cron; a manual `ship-now-gui.sh` still has no path awareness.

## 6. Zero-Code Findings

- The audit's DEFECT 1 framing needed one correction: Socratic-Trade is **not**
  exempt.  Its bot-merged PR #2675 produced zero push runs too; the `schedule:`
  cron in `ios-ship.yml` masked it.
- Defect 2 is currently latent rather than active — every app's Info.plist
  already carries `ITSAppUsesNonExemptEncryption`, so the broken backstop had
  nothing to catch.  That is luck, not design.
- `_merge-shepherd-impl.yml` needed no change: it already passes
  `SHEPHERD_HAS_PAT`.  The gap was in `scripts/merge-shepherd.sh`, which consulted
  that flag only on the re-sync path and would still have merged as the bot.

## 7. GROK pickup addendum (2026-08-13)

Monet hit session quota with this branch finished locally and **no PR opened**.
Owner directed GROK to land it from `~/apps/trading-monet-shipfix` without
redesign.

Pickup steps:

- `git fetch origin && git merge origin/main --no-edit` — clean merge of `#2684`
  honest server stats (`77bbb77f`).  STATUS / EFFORT-LOG auto-merged via union.
- Confirmed `git config user.email` is the GitHub noreply address.
- Marked the effort In Progress under GROK pickup on the live board +
  `docs/EFFORT-LOG.md`; added this addendum; updated the STATUS.md current
  block.
- Landing via `bash scripts/land.sh` (READY PR **#2687**) then
  `gh pr merge 2687 --squash --auto` (armed; waiting required `verify`).

Local land.sh gates: `tsc --noEmit` clean; vitest **6600 passed / 51 skipped**
(567 files + 1 skipped); `npm run build` clean.

No product redesign.  Dual credit on the pickup commit.
