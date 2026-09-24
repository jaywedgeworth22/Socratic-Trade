# 2026-08-13 — Honest Server Stats: delete the fabricated Actions runners

## 1. Context & Objective

Owner question: *"Why is all the server stats features on ST's admin panel and on UM's ops
panel not working correctly?"*

For Socratic-Trade the answer is two separate things, and the first one is worse than
"not working".

**(1) Six of the nine rows on `/admin/server` were invented.**
`app/api/admin/server-metrics/route.ts` carried a hardcoded array of six GitHub Actions
runners — `socratic-ci`, `socratic-ci-2`, `congress-ci`, `shared-ci`, `usage-ci` (all suffixed
`(ci-cpx32)`) plus `github-runner (prod host)` — every one pinned to `status:
"running:healthy"`. It existed at **two** separate sites (the `getActionRunners` fallback and
again inline in `localPayload`) and was returned on **five** distinct paths: no token, HTTP
error, non-array response, thrown request, **and a successful-but-empty live list**.

- `ci-cpx32` (77.42.35.209) was **deleted 2026-07-31** — see
  `docs/rollouts/2026-07-31-hetzner-servers-deleted.md`. Those machines do not exist.
- **None of `GH_TOKEN` / `GITHUB_TOKEN` / `GITHUB_MCP_TOKEN` is set in the ST prod Infisical
  project** (verified by exit-code presence check, no values read). So production took the
  fabricated branch on **100% of requests**. The panel has never once shown a real runner.
- Ground truth via `gh api repos/jaywedgeworth22/Socratic-Trade/actions/runners`: ST has
  **exactly one** registered runner, `mac-xcode26-socratic` (online, macOS/ARM64). Not one of
  the six hardcoded names exists in any fleet repository. Two runners that DO exist elsewhere
  are genuinely **offline** right now (`oracle-usage-ci`, `oracle-shared-ci`) — precisely the
  condition this panel is built to surface and was structurally incapable of reporting.

This violates the repo's own standing rule: *"Never label real data 'mock' or 'fallback' in
anything user-facing... every symbol gets real data or the cell shows `-`/`n/a`, never a fake
number."* The synthetic enrichment tier was deliberately deleted for exactly this reason.

**(2) Four more cards were structurally blank, with no explanation.**
System Memory utilization, Host Uptime and OS read only from `coolifyServer.server_metadata`,
which is `null` on the current Hetzner box (`is_metrics_enabled: false`), and disk capacity was
never fetched on the remote path at all (`getDiskStats()` is called only from `localPayload`).
So the live panel was roughly half fabricated and half blank, under a solid green `PRODUCTION`
chip — because `degraded` is computed from provider-fetch warnings, and none of these
conditions produces one.

Objective: measured, or explicitly unknown with a stated reason. Never a plausible-looking
default. The model copied is this repo's own `assessLitestreamTierFreshness`
(`src/lib/runtime-health.ts`), which returns `state: "not-observable"` with a machine-readable
`reason` and a human `detail` when a compaction level cannot be observed.

## 2. Changes Made

### Architectural summary

- Action runners are no longer smuggled into the Coolify `resources` array. They are a separate,
  separately-sourced, **discriminated** field on the payload:
  `{ state: "known", repo, runners[], omittedCount }` or
  `{ state: "unavailable", repo, reason, detail }`.
- `reason` is machine-readable (`no-github-token` | `github-api-error` | `unexpected-shape` |
  `request-failed`); `detail` is a human sentence naming the missing credential or the HTTP
  status. A measured **empty** list is a first-class answer and is rendered as
  "no runners registered", never replaced.
- **The service list carries the same discrimination** (added after adversarial review — see
  §2.1). `resources: []` is produced identically by "Coolify was never configured", "the Coolify
  read failed" and "Coolify answered zero", so the payload now carries
  `resourcesObservation: { state: "known" } | { state: "unavailable", reason, detail }` and the
  Services card renders three visually distinct states.
- Host facts the providers do not supply now carry a per-field explanation
  (`unobservedHostFacts: [{ field, reason, detail }]`) rendered **in place of the blank value**
  rather than in the warning banner — a permanent banner trains readers to ignore it, and a bare
  "Unavailable" reads as an intermittent outage rather than a wiring gap.

### Files touched

| File | Why |
| --- | --- |
| `src/lib/server-metrics-runners.ts` **(new)** | The rewritten runner probe. Returns measured rows or an explicit `unavailable` result with a reason + detail. No fallback list anywhere. Lives in `src/lib` because Next 16 route modules may export only handlers/config, so the route could not export a testable function. |
| `app/api/admin/server-metrics/route.ts` | Deleted BOTH fabricated arrays (lines 146-153 and 212-219 of the old file). Calls the new probe on the remote **and** local paths. Stops mixing runners into `resources`. Adds `unobservedHostFacts`, `monitoredTarget`, `staleScope`. Stops substituting Coolify's self-referential `localhost` host record. Uses `readNonNegativeNumber` for free memory and uptime. `cacheAgeSeconds` is now omitted (not 0) when `asOf` is unparseable. |
| `src/lib/server-metrics-runtime.ts` | New payload contract: `ServerMetricsActionRunners`, `ServerMetricsResourcesObservation`, `ServerMetricsUnobservedHostFact`, `ServerMetricsStaleScope`, `monitoredTarget`; `cacheAgeSeconds` becomes optional. |
| `src/lib/server-metrics-shapes.ts` | Added `readNonNegativeNumber`, type-guarded so `null`/`""` cannot coerce to 0. `readPositiveNumber` mapped a measured **0 bytes free** — an active OOM, the exact thing you open this panel to find — onto "Utilization unavailable". |
| `app/admin/server/server-metrics-client.tsx` | Renders the runner result honestly in its own "GitHub Actions Runners" card (list / measured-empty / not-available-with-reason). Fixes the `"unhealthy".includes("healthy") === true` tone bug and stops truncating the health half off the status label. Replaces the fabricated "Security & Access" claims. Explains blank host cards. Chart guards, timezone label, snapshot age, local-host placeholders. |
| `test/server-metrics.test.ts` | 15 new cases; 5 existing assertions corrected (they had been pinned to the fabricated row counts) and 3 extended to pin `resourcesObservation`. |
| `AGENTS.md` | Corrects the wrong "stale Coolify-side registration cleanup" note. |

### Client fixes worth calling out individually

- **`resourceStatusTone()`** — `"unhealthy".includes("healthy")` is `true`, and `isHealthy` was
  evaluated before `isDegraded`, so **every** `*:unhealthy` Coolify status rendered a solid
  green, non-pulsing dot. A container failing its healthcheck was displayed as success. All
  three live apps happen to be `running:healthy` today, which is why nobody noticed.
- **Status label** — was `item.status.split(":")[0]`, which discarded the entire health half.
  `exited:unhealthy` was shown to the reader as the word "EXITED" (with a green dot). The word
  "unhealthy" could never appear on the page. Now renders the full status.
- **"Security & Access" card** — was hardcoded prose asserting the firewall posture and that
  "In-container litestream PITR backup replication to Cloudflare R2 Cloud Storage" was running.
  Nothing was read from any source. The app has a documented R2 kill-switch (exit 41) that runs
  the container **without** litestream — in that exact state, with backups provably stopped,
  this card still claimed replication was live. Replaced with what this panel does read, an
  explicit "not measured here" list, and a link to `/admin/backups`, which actually measures it.
- Charts guarded on `length >= 2` (the components bail below that, so a single sample rendered
  an unexplained empty frame); the network chart now checks **both** series and says which one
  is missing.
- `As of` now prints its timezone name (the zone is forced to Central Time, the locale is the
  viewer's, and nothing said so) and always prints an age, "age unknown" included.
- Local-path placeholders `127.0.0.1` / `local` / `local runtime` removed — the local path never
  measures an IP, a location or a server type.

## 2.1 Second pass: the fabricated empty-state this change first introduced

An adversarial review of the first commit found that the fix had **reintroduced the same class
of bug in the card directly beside the one it rebuilt**, and it is worth recording because the
mistake is instructive: the honest-empty-state discipline was applied to runners and not to
services.

The Services & Containers card rendered `resources.length === 0` as the flat sentence
*"coolify reported no services for this server"*. Three different realities produce that empty
array and only the third justifies the sentence:

1. **Coolify is not configured at all** — `route.ts` skips the whole Coolify fetch block, so
   nothing was ever requested.
2. **Coolify is configured but the `/resources` read failed** (HTTP error or unreachable) — the
   route short-circuits an undefined payload to `{ resources: [] }`.
3. **Coolify was queried and genuinely answered zero.**

Case 2 is the dangerous one. When the Hetzner reads succeed and only the Coolify resources read
fails, `successfulProviderReads > 0`, so *neither* stale-cache branch fires: the page renders a
fresh-looking snapshot whose Services card asserts a measurement that never happened — which is
precisely the failure an operator opens this panel to catch.

Fixed the same way as the runners:

- `ServerMetricsResourcesObservation = { state: "known" } | { state: "unavailable", reason,
  detail }` on the payload, with `reason ∈ { coolify-not-configured,
  coolify-partially-configured, coolify-request-failed }`.
- `describeResourcesObservation()` in the route derives it from the configuration state and
  whether the resources read actually returned a payload; `localPayload()` reports
  `coolify-not-configured` explicitly rather than relying on a `usesLocalHost` flag at render
  time.
- A new `ServicesPanel` renders three visually distinct states — list, measured-zero
  ("Coolify returned zero applications and services... This is a measured answer, not a failed
  read"), and unavailable-with-reason-code — mirroring `ActionRunnersPanel`.
- `parseResourcesObservation()` returns `undefined` on a malformed or absent value and the card
  says "not reported"; it never defaults to `known`, which would restore the original bug.

Two smaller honesty fixes went in with it, both flagged as non-blocking by the same review:

- **Security & Access card** asserted unconditionally that "everything above is fetched live"
  from Hetzner and Coolify. False on the local path (host facts come from node's `os` module)
  and false per-provider whenever one is unconfigured. Now describes the path actually taken.
- **CPU meter** rendered a confident `X%` for a number the code itself flags as an unverified
  transform (see the divide-by-cores note in §3). The uncertainty now reaches the reader:
  "per-core average; scaling unverified", plus a hover explaining that the value may read low.
  The transform itself is still deliberately unchanged.

## 3. Decisions & Trade-offs

- **`degraded` and the runner state.** A runner read that *failed* (`github-api-error`,
  `request-failed`, `unexpected-shape`) sets `degraded`, like any other provider error. A read
  that was never *attempted* because no token is configured does **not** — it is a known gap
  rendered explicitly in its own card, and flipping prod to a permanent
  "PRODUCTION - DEGRADED" chip would just teach the owner to ignore the chip. Debatable; easy to
  flip if the owner prefers the louder signal.
- **Coolify's `localhost` host record.** Its server entry on this box is literally named
  `localhost` with ip `host.docker.internal` (Coolify's self-reference). It is real data, but as
  a fallback it disguised a Hetzner outage as a plausible hostname on the production panel. Now
  suppressed by name, and the card reads "Unavailable" instead. A named exclusion set is a mild
  smell; the alternative (dropping the Coolify fallback entirely) loses a legitimate value in
  configurations where Coolify names the host properly.
- **Sentinel not wired.** Coolify Sentinel *is* enabled and fresh on this server
  (`is_sentinel_enabled: true`, `sentinel_updated_at` current, 10s refresh), so the blank
  memory/uptime/OS cards are fixable with a real source rather than only an honest blank. I did
  not wire it in this PR: I could not read the Sentinel endpoint's response shape without a
  token, and guessing a provider shape is how the last round of wrong numbers got here. Left as
  a follow-up with the reason recorded in `unobservedHostFacts` so the gap is visible in the UI
  rather than silent.
- **CPU divide-by-cores left ALONE and unresolved.** `route.ts` divides every Hetzner CPU
  sample by the core count before plotting against a fixed yMax of 100. Hetzner's documented
  `type=cpu` series is percent of server CPU, 0-100 — if that is right, prod CPU is
  under-reported 8x on this cx43 and a saturated box shows as 10%. The only support for the
  divide is an uncited comment in Usage-Monitor plus a test fixture that hard-codes the current
  behaviour. **I did not change it**, because "fix" in the wrong direction is as bad as the bug
  and settling it needs one live Hetzner metrics sample, which needs the token. Open question,
  not a proven defect.
- **No token was created.** Per the standing rule, agents never mint provider credentials. The
  runners card will keep saying "not available: no GitHub token configured" — correctly — until
  the owner supplies one.

## 4. Verification State

Run from `/Users/jay/apps/trading-monet-serverstats` with node 24 first on `PATH`.

```
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx tsc --noEmit    # clean, no output
npm test            # see counts below
npm run build       # see below
npm run lint        # see below
```

### Gate output (observed, final tree)

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0, no output |
| `npm test` | **Test Files 563 passed \| 1 skipped (564)** · **Tests 6547 passed \| 51 skipped (6598)** · exit 0. `test/server-metrics.test.ts` alone: **46 passed**. |
| `npm run build` | exit 0. `/admin/server` static, `/api/admin/server-metrics` dynamic, 40/40 static pages generated. |
| `npm run lint` | exit 0 — **764 problems, 0 errors, 764 warnings**, all pre-existing/grandfathered. Zero warnings in any file touched by this change. |

The suite was run again in full on the post-review tree (the §2.1 changes): same 563/1 file
split, 6547 tests passing, `tsc` clean, `lint` still exactly 764 warnings / 0 errors with none
in a touched file.

## 5. Next Steps & Blockers

**Owner action required (agents must not do this):**

1. **Supply a GitHub token to the ST prod Infisical project** (`GH_TOKEN` or `GITHUB_TOKEN`,
   repository-administration read scope) if the runners panel should show live data. Until then
   it will honestly report `no-github-token`. Do NOT let an agent mint one.
2. Decide whether a GitHub-hosted-only CI fleet even wants a self-hosted-runner card on this
   panel. ST's only runner is the Mac Xcode runner; if that is the whole story, the card could
   be scoped to "iOS build runner" instead.

**Follow-ups in this repo:**

3. Wire Coolify **Sentinel** for host memory / uptime / OS / disk capacity. It is already
   enabled and reporting on `<HETZNER_COOLIFY_SERVER_UUID>`; confirm the response shape against a
   real call before mapping fields.
4. Settle the **CPU divide-by-cores** question with one live Hetzner sample, then either delete
   the divide or document the evidence at the call site and in
   `test/server-metrics.test.ts:419`.
5. Consider showing all backup layers on `/admin/backups` (the owner asked for "all types of
   backups" per app): today it covers Litestream tiers only, not B2 full dumps, Hetzner volume
   snapshots, or the R2 historic object set.

**Out of scope for this PR — recorded so they are not lost:**

6. **Usage-Monitor** (`/Users/jay/Code/Usage-Monitor`):
   - `src/lib/fleet-backup-status.ts:477` — `summarizeApp()` returns `ok: true` when **every**
     location was unobservable (`decisive.length === 0`). An app with nothing observed renders a
     green "Healthy" pill. `src/components/OperationsOverview.tsx:540` compounds it: the per-app
     pill is a two-state boolean with no "unknown", even though the per-location rows below it
     render `ok === null` correctly. Fix: `ok: boolean | null` + a "Not observable" pill.
   - `fleet-backup-status.ts:95` — ST's `litestreamPrefix` is `null`, but ST's real off-site
     replica is B2 `jays-socratic-trade-eu` at `trading-live/app.db`
     (`litestream.coolify.yml:5,36-37`). ST's off-site backup is never independently verified.
   - `fleet-backup-status.ts:706` — the "not configured" placeholder branch tests
     `spec.litestreamPrefix === ""`, but no spec uses the empty string (they use a path or
     `null`), so it is **dead code** and an unwired app silently loses the row entirely rather
     than showing "not configured".
   - `OperationsOverview.tsx:559` — object counts are rendered as absolute figures while
     `inventoryPrefix()` caps paging and signals it only via `reason: "list_truncated"`, which
     the UI drops. Render "4000+" or surface the truncation.
   - `src/lib/runtime-health.ts:1148` — when `LITESTREAM_REQUIRED !== "true"`, `primary.ok` is
     unconditionally true. Latent today (the env is set) but one flip makes UM's own backup row
     a permanent green light.
   - `src/lib/r2-usage.ts:1774` — the per-account catch returns all-zero metrics alongside
     `status: "error"`. The web card early-returns on the status, but the zeros ship in the
     `/api/operations` JSON the iOS client reads.
   - `src/lib/operations-health.ts:437,635` — peer/Coolify success caches replay with no maximum
     age; a peer down for days serves days-old numbers under one amber "Stale" pill. ST's own
     module bounds this at `SERVER_METRICS_MAX_STALE_MS = 10 min`.
   - `src/lib/server-metrics.ts:30-36` — hardcoded `DEFAULT_HETZNER_SERVER_ID` /
     `DEFAULT_COOLIFY_SERVER_UUID` / `DEFAULT_COOLIFY_APP_UUID` literals, same fabrication
     class: they silently point at whatever box those IDs meant when they were written.
   - UM's own `/api/health` exposes **no** storage/backup fields, so the cross-app backup
     picture is one-directional.
   - Good news, verified: UM has **no** fabricated-runner bug. Its Coolify adapter returns
     `state: "unavailable"` with empty arrays when Coolify is unreachable. It is the
     counter-example proving ST's fallback array was never necessary.
7. **Congress.Trade** (`/Users/jay/Code/Congress.Trade`):
   - `app/src/shared/litestreamAge.ts:29` — `litestreamStatus: "replicating"` is derived from
     the mtime of **local** `*.ltx` files. That proves the local writer is producing WAL
     segments; it proves nothing about the B2 upload. If B2 auth breaks, litestream keeps
     writing locally, CT keeps reporting "replicating", and UM keeps painting "Live Litestream ·
     OK" while zero bytes reach off-site storage. ST discloses this honestly with a
     `source: "local-ltx"` field; CT exposes no `source` at all. Add one.
   - `app/src/shared/r2Usage.ts:274` — `formatOwnBackupRegimenLine()` ignores its argument and
     returns a hardcoded sentence describing all three backup layers, appended to the owner's
     Pushover message. It happens to match `app/litestream.yml` today, but it will keep
     asserting all three layers are running long after any of them stops.
   - CT has no admin backup surface at all.

## 6. Zero-Code Findings

- The 2026-08-11 rollout note (`docs/rollouts/2026-08-11-server-metrics-panel-hetzner-config-repair.md`)
  records the repaired panel returning "9 live resources including the three real Coolify apps".
  Coolify returns exactly **3**. The other 6 were the fabrications. That note was itself
  answering this same owner question, and the fabricated array is why its answer was wrong — an
  agent debugging the panel trusted the panel. The note is a dated historical record and is left
  unedited per repo convention; `AGENTS.md`, which copied the claim forward as durable guidance,
  is corrected in this PR.
- Verified read-only, no values printed: `HETZNER_API_TOKEN`, `HETZNER_SERVER_ID`,
  `COOLIFY_SERVER_STATS`, `COOLIFY_API_TOKEN`, `COOLIFY_SERVER_UUID`,
  `SERVER_METRICS_TARGET_ENVIRONMENT` are **present** in ST prod;
  `GH_TOKEN` / `GITHUB_TOKEN` / `GITHUB_MCP_TOKEN` are **absent**.
- Coolify server `<HETZNER_COOLIFY_SERVER_UUID>`: `server_metadata: null`,
  `is_metrics_enabled: false`, `is_sentinel_enabled: true` with a fresh `sentinel_updated_at`.
  Its own record is named `localhost` with ip `host.docker.internal`.
