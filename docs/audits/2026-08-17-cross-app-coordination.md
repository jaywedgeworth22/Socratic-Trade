# Cross-App Coordination Audit — 2026-08-17

**Status:** report landed (#2802).  Follow-ups are in progress on
`cursor/cross-app-coordination-followups-1212` (this tree implements the ST
slice of §7).

**Auditor:** Cursor Cloud (portfolio architect / contracts / SRE / product).
**Scope date:** 2026-08-17.  Evidence from `Socratic-Trade` HEAD plus GitHub `main`
on the peer repos listed below.

## 1. Context and objective

The fleet is no longer three loosely related apps.  Socratic-Trade (ST),
Congress.Trade (CT), Usage-Monitor (UM), and `congress-trading-shared` (CTS)
share contracts, tokens, a Hetzner box, Cloudflare accounts, Infisical
projects, Mac runners, and alert channels.  DealDex (DD) and
`ai-fleet-coordinator` (FLEET) sit on the same effort-board / Slack protocol
without a runtime money path into ST.

This audit answers: what is actually shared, where versions and gates have
drifted, who owns each surface, whether each product can fail independently,
and which portfolio fixes are worth doing first.  It does **not** implement
those fixes.

## 2. Scope and method

| Repo | How read | HEAD used |
|------|----------|-----------|
| Socratic-Trade | local `/workspace` | this branch's base (`4980322b` + docs) |
| Congress.Trade | `gh api` / `gh search code` on `main` | 2026-08-17 ~21:48Z |
| Usage-Monitor | `gh api` on `main` | 2026-08-17 ~14:18Z |
| congress-trading-shared | `gh api` on `main` + tags | tag `v2.5.2` (2026-08-11) |
| DealDex | `gh api` on `main` | 2026-08-17 ~20:03Z |
| ai-fleet-coordinator | `gh api` on `main` | `fleet-apps.json`, `AGENT-SYNC.md`, `EFFORT-LOG-PROTOCOL.md`, `docs/MAC-LOCAL-PROCESSES.md` |

GitHub MCP was unavailable in this session.  `gh` (read-only) was the peer-repo
path.  Secrets were not opened.  Production Infisical / Coolify values are
inferred from committed docs and enablement backlog, not live secret reads.

Severity:

| Grade | Meaning |
|-------|---------|
| **P1** | Coordination gate is a no-op, identity/quota collision, or a doc that will send the next agent down a retired path |
| **P2** | Observability / contract-doc drift that will waste a session or page the owner on a peer outage |
| **P3** | Hygiene.  Safe to defer |

No P0 (live money-path break) was found at audit time: ST, UM, and CT's vendor
tree all claim CTS `v2.5.2`, and ST's order path does not require CT or UM.

## 3. Architecture map

```
                    #agent-sync  +  per-app effort boards
                    (FLEET protocol; not a runtime bus)
                                    |
        +---------------------------+---------------------------+
        |                           |                           |
   DealDex (Vercel)          Personal-Site                 CTS library
   protocol only             protocol only                 v2.5.2 tag
        |                                                       |
        |          Infisical (app project shadows shared)       |
        |                           |                           |
        +-------- Hetzner cx43 Coolify (concurrent_builds=1) ---+
        |                           |                           |
   ST socratictrade.com        CT congress.trade           UM usage.jays.services
   Next + SQLite + Litestream  Deno container + SQLite     Next + Prisma/SQLite
   CTS npm git#v2.5.2          CTS vendored src v2.5.2     CTS npm git#v2.5.2
        |                           |                           |
        +------ price/ref share, webhook/SSE, market-read ------+
        |                           |                           |
        +------ usage telemetry v2  +  budget-status (fail-open) +
        |                           |                           |
        +------ R2 fleet GraphQL (3 CF accounts) + Pushover ----+
        |
   Mac (not in the ST trade path)
   mac-xcode26-{socratic,congress,usage}
   ios-fleet (untracked) + CT scout / senate-relay / vision-worker
```

### Runtime data paths (ST-centric)

| Direction | Path | Default in ST code | Prod note |
|-----------|------|--------------------|-----------|
| ST → CT share | `congress-share.ts` POST refs/prices/spx/… | `CONGRESS_SHARE_ENABLED` off | Infisical **on** 2026-08-13 |
| CT → ST prices | `CONGRESS_TRADE_READS_ENABLED` cache-aside | off | optional |
| CT → ST congress | `CONGRESS_TRADE_AS_CONGRESS_SOURCE` | **on** | CT is SoR for disclosures |
| CT → ST analytics | `CONGRESS_ANALYTICS_ENABLED` | **on** | overlay only |
| CT → ST fundamentals | `CONGRESS_TRADE_FUNDAMENTALS_ENABLED` | off | ST cascade owns fundamentals |
| CT → ST events | webhook `POST /api/webhooks/congress` | closed unless `CONGRESS_WEBHOOK_SECRET` | fail-soft apply |
| CT → ST SSE | `congress-stream.ts` | `CONGRESS_STREAM_ENABLED` off | self-guarded |
| ST → CT prices | `/api/market/prices/{ticker}`, `/api/market/spx` | bearer `APP_B_INGEST_TOKEN` | `skipAppATier` blocks echo |
| ST → UM | `usage-monitor-push.ts` v2 | off unless URL + ingest token | fail-open |
| UM → ST | `GET /api/budget-status` | advisory; `USAGE_BUDGET_ENFORCE` off | fail-open |
| UM → ST health | UM `operations-health.ts` fetches ST `/api/health` | n/a | paints Peer App Health |
| ST → UM health | `health-lane-reprobe.ts` hits UM `/api/ready` then `/api/health` | n/a | not a 503 |

DealDex has **no** import of CTS, no ST/CT/UM HTTP client, and no Coolify app.
Its PLAN.md still lists Infisical + Vercel domain + future `ios-fleet` as
owner work.

## 4. Findings

### 4.1 Shared contracts and version drift — P1

**What is true today**

| Consumer | How CTS is consumed | Claimed version |
|----------|---------------------|-----------------|
| Socratic-Trade | `package.json` `github:jaywedgeworth22/congress-trading-shared#v2.5.2` (lock `b2847eb9…`) | 2.5.2 |
| Usage-Monitor | same git tag pin | 2.5.2 |
| Congress.Trade | **not** an npm dependency.  Deno import map → `app/vendor/congress-trading-shared/src/index.ts`.  `VENDOR-PROVENANCE.md`: immutable release `v2.5.2`, imported 2026-08-11 | 2.5.2 |
| DealDex | no dependency | n/a |
| CTS itself | `package.json` `"version": "2.5.2"`, latest tag `v2.5.2` | 2.5.2 |

CTS README is explicit: public repo, tokenless git tag pin, do not point
consumers at `main`.  That policy matches ST and UM.  It does **not** match
CT's vendor-era consumption.

**The ST pin-check is a no-op against current CT.**
`.github/workflows/shared-package-pin-check.yml` still:

1. Reads CT `app/package.json` `dependencies["@jaywedgeworth22/congress-trading-shared"]`.
2. Treats a missing peer spec as `::warning:: … cannot compare` and **exits 0**.
3. Skips the entire peer fetch when `GH_PACKAGES_TOKEN` is unset (also exit 0).
4. Is intentionally **not** a required merge check.

CT `scripts/check-shared-package-pin.mjs` now **fails** if that npm dependency
is reintroduced (`CT is vendor-only`).  The two gates encode opposite worlds.
A coordinated bump can land on ST/UM while CT's vendor tree stays on an older
`src/`, and ST CI will stay green.

CT's own workflow compares vendored `src/` to the tagged upstream tree (plus
`APPROVED-DRIFT.patch`).  That is the better local gate.  It does not update
ST's workflow, and it does not include UM.

UM has **no** pin-check workflow — only `.github/workflows/auto-merge-shared-dependency.yml`,
which is a no-op without `GH_PAT` / `SHEPHERD_TOKEN`.

CT `VENDOR-PROVENANCE.md` (fetched 2026-08-17) lists release `v2.5.2` but **no**
`Commit: \`<40-hex>\`` line.  The sibling script `check-shared-package-pin.mjs`
parses that commit line and `fail()`s if it is missing.  Provenance and the
script have already drifted.

**Ownership:** CTS owns the contract.  ST owns the consumer pin-check that
still describes "two npm consumers."  CT owns vendor provenance.  UM should
be a first-class third consumer in any rewritten gate.

### 4.2 Health lanes — P2

**ST `/api/health` does not 503 on peer outages.**  Critical services are
`pinecone`, `alpaca-broker`, and (when RAG is not pinned-but-keyless)
`rag-embed` / `rag-rerank` (`app/api/health/route.ts`).  `congress.trade` and
`usage-monitor` appear only as Connections / `logApiHealth` rows.

**UM splits liveness from readiness.**  `GET /api/health` always returns
`{ ok: true, status: "live" }`.  `GET /api/ready` is the SQLite / backup /
scheduler probe.  ST's reprobe already prefers `/api/ready` then `/api/health`
(`src/lib/health-lane-reprobe.ts`).  That pairing is correct.

**UM Peer App Health is ST-shaped, not fleet-shaped.**
`Usage-Monitor/src/lib/operations-health.ts` hardcodes
`SOCRATIC_HEALTH_URL = "https://socratictrade.com/api/health"` and Coolify
fleet resources.  There is no `congress.trade/api/health` fetch.  A CT outage
does not paint UM's peer card.  A non-critical ST dependency historically did
(FilingAPI 401s; fixed 2026-08-13 in UM).  The same class will recur whenever
ST lists a retired vendor on public health — ST just omitted those vendors
from `checks.dependencies` (2026-08-17 FilingAPI retirement).

**CT `/api/health` is an UptimeRobot target** and now publishes Infisical
source status (names/counts, never values) after the 2026-08-16
`AGENT_SYNC_*` rotation (`docs/rollouts/2026-08-16-health-infisical-shared.md`
in CT).  A Coolify container gap still 403s at the Cloudflare edge; that is
not an app bug, but it **is** a shared-host deploy coupling (see 4.7).

**Keyword monitors remain a cross-app page source.**  ST health documents an
`"openrouterCredits":{"ok":false` keyword.  Deploy-time 503s have paired with
that monitor as "credits low" (fleet-alert triage 2026-08-13).  UM's always-ok
`/api/health` avoids that class; ST's richer payload does not.

### 4.3 Data ownership and cascade boundaries — P1 / P2

Canonical ownership (code + `docs/congress-trade-consume.md` after the
2026-08-04 update):

| Domain | System of record | ST default |
|--------|------------------|------------|
| Congressional disclosures | CT | consume ON |
| Congress analytics overlay | CT | consume ON |
| Fundamentals / analyst | ST cascade (Yahoo / Finnhub / ROIC / SEC / …) | CT fundamentals OFF |
| Daily OHLC | ST cascade; CT optional first tier | reads OFF |
| FMP / Quiver / UW / FilingAPI HTTP | **retired on ST** | must not call |
| FMP quota | CT (if CT still calls FMP) | ST must not hold a live FMP key |

`src/lib/retired-direct-vendors.ts` is the binding ST rule.  `data-providers.ts`
still contains an FMP class but does not register it; Quiver is warned-and-skipped
if a key reappears.

**Share outbound is live in production** (`FEATURE-ENABLEMENT-BACKLOG.md`:
`CONGRESS_SHARE_ENABLED` Infisical on 2026-08-13) while the code default stays
off.  Fundamentals share stays off pending CT App A #46.

**Price echo is guarded.**  ST market-read uses `fetchDailyOHLC(..., { skipAppATier: true })`
so a CT pull cannot bounce back to CT (`src/lib/market-read.ts`).  Share
payloads carry `origin: app-b` so the import receiver skips a round-trip.

**Shared Massive quota is still unsplit.**  A 2026-08-01 Monet cross-app note
in CT (`docs/handoffs/2026-08-01-monet-cross-app-audit/maps.jsonl`) called this
out: ST reserves `MASSIVE_REST_MAX_CALLS_PER_MINUTE` locally (knob-synced from
UM subscriptions); CT only does reactive 429 backoff and documents the key as
shared.  The **unmetered `fetchMassive`** half of that note is **closed** —
current ST `src/lib/history.ts` calls `recordProviderCall("massive", …)` on
success and failure.  The **rate-split** half is not closed.  Neither app
consults UM `budget-status` before market-data spend.

**ST call-volume telemetry is still lossy across a long UM outage.**  LLM / RAG
/ provider-dispatch have durable replay (`usage-monitor-replay.ts`).
Market-data aggregates live in the in-memory push queue.  CT's pipeline
(queue + D1 + R2 outbox) is more durable.  After a multi-hour UM outage, the
shared Massive picture under-counts ST.

**Doc drift that will mis-set flags:**

- `docs/congress-trade-consume.md` still names deleted
  `src/lib/congress-trade-client.ts` (now `src/lib/api-clients/congress.ts`).
- `docs/congress-trade-share.md` still justifies the bridge as a shared **FMP**
  quota.  FMP direct access is retired on ST; the live reason is CT cache +
  disclosure SoR + Massive/Yahoo reuse.
- `docs/FEATURE-ENABLEMENT-BACKLOG.md` still lists "Quiver enrichment /
  `QUIVER_API_KEY`" as if a key would register the provider.  It will not.

### 4.4 Duplication — P2

ST no longer ships a local `SseParser` or usage-telemetry client.  Those come
from CTS (`congress-stream.ts`, `usage-monitor-push.ts`).  Remaining local
code is mapping, leases, health wrappers, and notify footers — appropriate.

CT vendors the **entire** CTS tree under `app/vendor/congress-trading-shared/`,
including a checked-in `node_modules/` and stale `dist/` that provenance
itself calls "older, unused build artifacts."  Deno reads `src/`.  That is a
large duplicate surface: Dependabot / secret scanning / lockfile noise, and a
second place for `src/` to drift from the tag.

DealDex does not duplicate trading contracts.  Fleet protocol files
(`AGENTS.md`, effort sync, slack-sync) are copied, which is the intended
onboard pattern.

### 4.5 Event and SSE dependencies — P2 (isolated)

| Ingress | Gate | Failure mode |
|---------|------|--------------|
| Webhook | `CONGRESS_WEBHOOK_SECRET` required; else 401 | `applyCongressEvent` never throws; 200/400 only |
| SSE | `CONGRESS_STREAM_ENABLED` default off | reconnect/backoff; parks when knob off |
| Event types | CTS `CONGRESS_EVENT_TYPES` | `ref.upsert` / `price.eod` / `spx.eod` are acknowledged no-ops (lazy read) |

SSE auto-subscribe uses `CONGRESS_TRADE_TOKEN` (ingest) as the client token
(`congress-stream.ts`).  Docs say keep ingest and read separate
(`docs/push-to-app-b.md`).  The stream path blurs that.  Not a trading
outage, but a token-blast-radius issue if the ingest secret leaks.

### 4.6 Alert routing — P2

ST `notify.ts` appends `(sent by Socratic-Trade)` on Resend bodies and skips
email when Pushover can deliver.  That closed the 2026-08-13
"Litestream mail looked like UM" confusion.

R2 fleet alerts pick a **subject-app** Pushover token
(`PUSHOVER_ST_API_TOKEN` / `PUSHOVER_CT_API_TOKEN` /
`PUSHOVER_USAGE_API_TOKEN`) so the phone logo matches the account, not the
sender process (`src/lib/r2-usage.ts`).  AGENT-SYNC records the inverse bug:
tokens lived only in the peer Infisical project, so ST sent a CT digest with
the wrong logo.  Cross-app keys must be **copied into the consuming app's
Infisical project**, not read from `~/.secrets` at runtime.

UptimeRobot + Sentry + Pushover still overlap on `/api/health`.  A deploy 503,
a keyword credits-low, and a health-lane Sentry can all fire for one Coolify
swap.  That is product noise, not a coupling that stops trading.

### 4.7 CI and deploy interactions — P1

**Shared fate on the Hetzner box.**  ST, CT, and UM Coolify apps share
`fleet-hetzner-nbg1` (`<PROD_ORIGIN_IP>`) with `concurrent_builds=1`.  A ST
merge queues behind a UM or CT build.  A box OOM or disk fill takes all three
offline.  DealDex is on Vercel — it does **not** share this fate.

**Merge == live** on ST (and CT per CT `AGENTS.md`).  The Coolify GitHub
manual webhook HMAC must match `manual_webhook_secret_github`.  Secret drift
returns HTTP 200 with `Invalid signature` and **freezes prod while merges
pile up** (`docs/rollouts/2026-08-02-deploy-webhook-secret-repair.md`).  That
is a per-app secret, but the failure mode is fleet-wide "why didn't it
deploy?"

**CT `AGENTS.md` still mandates retired self-hosted runners.**  It says all
workflows MUST target Coolify runners (`hetzner-ct-ci-1` / `oracle-ci` /
`socratic-ci`) and bans GitHub-hosted.  ST `AGENTS.md` (2026-07-29, corrected
2026-08-13) says fleet CI is **GitHub-hosted `ubuntu-latest` only** and that
those self-hosted labels are retired.  CT's pin-check workflow still contains:

```yaml
runs-on: ${{ vars.CT_CI_RUNNER != '' && github.event.repository.private && fromJSON('["self-hosted", "oracle-ci"]') || 'ubuntu-latest' }}
```

An agent following CT `AGENTS.md` will try to resurrect banned runners.  An
agent following ST `AGENTS.md` will not.  That is a protocol split, not a
style difference.

**iOS ship is a shared untracked tree.**  `scripts/ios-ship-testflight.sh`
execs `/Users/jay/apps/ios-fleet/ship-testflight.sh` after
`scripts/ios-fleet-pin.sh --check`.  CT and UM have sibling pins.  Hourly
cron ships plus a standing rate gate contend for one Mac Xcode identity
(team `CC8UTF7ATG`).  A backend-only ST commit has already shipped to
TestFlight when the path gate was missing (2026-08-13).  DealDex PLAN.md
intends to join this pipeline once an ASC record exists — that will add a
fourth contender.

### 4.8 Secrets and account identity — P1

**Cloudflare is four accounts, not one.**  AGENT-SYNC: Congress.Trade,
SocraticTrade.com, Usage.Jays.Services, plus a legacy zero-zone "jay"
account.  At least four login emails.  `/user/tokens/verify` 401s on
account-owned tokens by design.  Agents keep declaring live tokens dead.
ST `r2-usage.ts` monitors three R2 free tiers (`st` / `ct` / `um`) with
phased GraphQL so peer checks do not stampede.

**Infisical merge order is a rotation trap.**  Shared project loads first;
app project shadows.  CT 2026-08-16 deleted `AGENT_SYNC_*` from ST and CT
**app** projects so the shared project is the only copy.  `ADMIN_TOKEN` stayed
on CT app (correct — it is CT admin auth).  UM was **not** given
`AGENT_SYNC_*`.  The next rotation that writes a fleet key into an app
project will recreate the three-project chore.

**Token names that look interchangeable and are not:**

| Name | Role |
|------|------|
| `CONGRESS_TRADE_TOKEN` | CT **INGEST** (ST share + SSE auto-subscribe client) |
| `CONGRESS_TRADE_READ_TOKEN` | optional ST read / SSE secret fallback |
| `CONGRESS_WEBHOOK_SECRET` | inbound webhook only |
| `APP_B_INGEST_TOKEN` | ST inbound import + market-read bearer (CT → ST) |
| `USAGE_INGEST_TOKEN` | UM push |
| `USAGE_READ_TOKEN` | UM budget/status (preferred over ingest) |
| `COOLIFY_SERVER_STATS` | read-only metrics |
| `COOLIFY_AGENTS` | full deploy — must never be the app's `COOLIFY_API_TOKEN` |

ST refuses to `infisical secrets set` LLM runtime key names
(`scripts/infisical-secrets-safe.sh`).  Connections tombstones are honored
(`migrateLocalEnvCredentials`).  That is ST-local and must not be "fixed" by
re-seeding from env.

### 4.9 Shared Mac and runner contention — P1

From FLEET `docs/MAC-LOCAL-PROCESSES.md` (inventory 2026-08-16):

| Process | Kind | Who dies if the Mac dies |
|---------|------|--------------------------|
| `mac-xcode26-socratic` | Always-on GH runner | ST TestFlight / iOS CI |
| `mac-xcode26-congress` | Always-on GH runner | CT TestFlight / iOS CI |
| `mac-xcode26-usage` | Always-on GH runner | UM TestFlight / iOS CI |
| pm2 `scout` + `senate-relay` + `senate-tunnel` | Always-on | **CT Senate ingest** (product) |
| pm2 `vision-worker` | Always-on | CT scanned-PTR |
| pm2 `agent-sync-push` | Always-on | Slack fan-out for all seats |
| `xcode-health` | Always-on | operator visibility |

ST **trading** does not need the Mac.  CT **Senate discovery** still does
(local `SENATE_RELAY_URL=http://127.0.0.1:8899`; do not hairpin
`scout.jays.services`).  That is the sharpest product-vs-infra coupling in
the fleet: CT's Coolify container is not sufficient for the House/Senate
path.

Three Xcode runners on one Mac will queue.  ios-fleet's rate gate (3600s
after the 2026-08-14 hourly change; historically 2.5h) is the only
cross-app brake.

### 4.10 Fleet / effort-board protocol — P2

`ai-fleet-coordinator/fleet-apps.json` registers ST, CT, UM, CTS, DD, FLEET,
Personal-Site.  Effort-log protocol: live board under `~/apps/` plus
`docs/EFFORT-LOG.md` mirror; GitHub issues sync from the **committed**
mirror only.  Cloud / no-Mac agents cannot update the live board.

Cross-app work is supposed to get a row on **each** affected board.  This
audit is ST-only by design (report lives here).  A follow-up should add
pointer rows on CT / UM / CTS / FLEET / DD boards so the next seat does not
re-audit.

`STATUS.md` / `PLAN.md` / `docs/EFFORT-LOG.md` use `merge=union`.  Concurrent
PRs interleave headings.  Trust `docs/rollouts/` over a spliced STATUS
heading.  That is a coordination tax, not a runtime bug.

### 4.11 DealDex isolation — P3 (healthy)

DealDex is a Pokémon listing desk.  No CTS pin, no ST/CT/UM API, no Coolify
slot, no shared vendor quota.  Fleet membership is protocol + future
ios-fleet / Infisical.  Keep it that way.  Do not "helpfully" add
`USAGE_INGEST_TOKEN` or a Coolify app unless the owner asks.

## 5. Independent failure matrix

| If this is down | ST still trades? | CT still ingests disclosures? | UM still records? | Notes |
|-----------------|------------------|-------------------------------|-------------------|-------|
| Congress.Trade | **Yes** | — | Yes | Weaker congress signals; share/SSE idle; price cache-aside skipped |
| Usage-Monitor | **Yes** | Yes (budget fail-open) | — | Telemetry loss; ST call-volume forgotten; no hard budget |
| Socratic-Trade | — | Yes, with Massive/Yahoo fallback | Yes | CT peer prices 401/5xx → CT's own cascade |
| Hetzner Coolify box | **No** | **No** (Coolify CT) | **No** | Shared fate.  DD on Vercel survives |
| Owner Mac | **Yes** | Senate scout/relay **degrade** | Yes (web) | iOS ships stall for ST/CT/UM |
| CTS repo / npm | No new installs | Vendor tree still boots | No new installs | Running containers keep last `node_modules` / vendor |
| DealDex | Yes | Yes | Yes | No runtime edge |
| Slack / effort boards | Yes | Yes | Yes | Humans collide; products do not |

**Verdict:** ST's money path is independent of CT and UM by construction
(broker health gate in `src/lib/strategy.ts`; usage push / budget fail-open;
congress score gate fail-open).  **The three Coolify apps are not
infrastructure-independent.**  CT's Senate path is not Mac-independent.

## 6. Ownership recommendations

| Surface | Owner repo | Peer must not |
|---------|------------|---------------|
| Zod / event / telemetry / client types | **CTS** (tag + CHANGELOG) | redefine in ST/CT/UM |
| ST pin + required drift gate | **ST** | keep reading CT `app/package.json` deps |
| CT vendor `src/` + provenance | **CT** | re-add npm CTS dep |
| UM ingest + budget-status + Peer App Health | **UM** | 503 ST on UM outage |
| Congressional disclosures SoR | **CT** | ST calling Quiver/FMP/UW |
| Fundamentals cascade | **ST** | enable CT fundamentals without an owner flag |
| Daily OHLC SoR for the peer bridge | **ST** (`skipAppATier`) | CT treating Massive as primary once peer is healthy |
| Massive 100/min split | **UM knobs + ST reserve + CT last-resort** | second Massive key (owner: never mint keys) |
| Infisical fleet keys (`AGENT_SYNC_*`) | **shared project only** | copy into app projects |
| Coolify deploy webhook HMAC | **per-app Infisical** | share one secret across apps |
| Mac senate-relay / scout | **CT + FLEET MAC list** | hairpin public scout URL from the box |
| ios-fleet scripts | **FLEET untracked + per-repo sha256** | hand-edit without `--update` pin |
| DealDex product | **DD** | mix keys into ST/CT/UM Infisical |
| Effort boards / #agent-sync | **FLEET protocol** | treat Slack as a lock |

## 7. Prioritized portfolio fixes

Suggested order.  ST items 1 / 3 (label) / 4 / 6 / 7 are on this follow-up
branch.  Peer-repo items (2, 3 CT last-resort, 5, 8) land as separate PRs.
Item 9 stays deferred until the triangle is a matched pair.

### P1 — do next (gates and identity)

1. **Rewrite ST `shared-package-pin-check.yml` for vendor-era CT.**  **Done
   (ST).**  `scripts/check-shared-package-pin.mjs` compares ST/UM npm pins +
   lock SHAs to CT `VENDOR-PROVENANCE.md` + vendor `package.json`.  Fails when
   CT is unreadable, versions diverge, or CT reintroduces the npm dep.  Still
   not a required merge check.
2. **Reconcile CT `AGENTS.md` CI runner policy** with the retired
   self-hosted / `oracle-ci` world.  Until that file matches ST/FLEET, every
   CT session will try to revive banned runners.  **Peer PR.**
3. **Split or last-resort the shared Massive key.**  Owner already pointed
   the cascade at ST.  CT should treat direct Massive as fallback; ST tags
   `label: congress-read` on peer-serving cache misses.  Do **not** mint
   `MASSIVE_API_KEY_ALT` as a second production key.  **ST label done; CT
   last-resort is a peer PR.**
4. **Infisical rotation runbook:** fleet keys live only in the shared
   project; app projects must not shadow them.  **Done (ST `AGENTS.md`).**

### P2 — this month

5. **UM operations:** add a bounded `congress.trade/api/health` probe next to
   ST, with the same "do not paint degraded on retired / last-resort lanes"
   rule.  **Peer PR.**
6. **Durable ST call-volume replay.**  **Done (ST).**  Persist windows to
   settings on drain; ACK after a successful POST; replay loads leftovers.
   Counts still sitting in the ~2s in-memory aggregate can still be lost.
7. **Doc refresh in ST:** consume client path, share FMP rationale,
   FEATURE-ENABLEMENT Quiver row, events comment.  **Done (ST).**
8. **CT vendor hygiene:** stop tracking unused `dist/` + `node_modules/`
   under `app/vendor/congress-trading-shared/` once Deno-only is proven.
   Put a 40-hex commit on `VENDOR-PROVENANCE.md`.  **Peer PR.**
9. **Promote the rewritten pin-check to required** only after ST+CT+UM land
   as a matched pair (the current "not required" comment is why coordinated
   bumps work — keep that until the gate understands vendor-era CT).

### P3 — when touching the area

10. DealDex: Infisical + ASC + ios-fleet pin when the owner opens those
    dashboards.  Stay off the Hetzner Coolify queue.
11. Cross-post pointer rows on CT / UM / CTS / FLEET / DD effort boards
    after this PR merges.
12. Consider collapsing union-merge STATUS/PLAN (owner call).  Not an agent
    unilateral edit.

## 8. Evidence index

| Claim | Evidence |
|-------|----------|
| ST CTS pin `v2.5.2` | `package.json` line 38; lock `b2847eb9…` |
| UM CTS pin `v2.5.2` | `Usage-Monitor/package.json` dependencies |
| CT vendor `v2.5.2` | `Congress.Trade/app/vendor/congress-trading-shared/VENDOR-PROVENANCE.md` |
| CT forbids npm CTS dep | `Congress.Trade/scripts/check-shared-package-pin.mjs` `assertNoNpmDep` |
| ST pin-check reads CT `app/package.json` deps | `.github/workflows/shared-package-pin-check.yml` `PEER_PACKAGE_JSON_PATH` |
| ST pin-check skip on missing token / missing peer spec | same file lines 216–230 |
| ST health critical set | `app/api/health/route.ts` `criticalServices` |
| UM health always live | `Usage-Monitor/src/app/api/health/route.ts` |
| UM probes ST only | `Usage-Monitor/src/lib/operations-health.ts` `SOCRATIC_HEALTH_URL` |
| ST meters Massive history | `src/lib/history.ts` `recordProviderCall("massive", …)` |
| Share live in prod | `docs/FEATURE-ENABLEMENT-BACKLOG.md` |
| Market-read echo guard | `src/lib/market-read.ts` `skipAppATier` |
| Usage fail-open | `src/lib/usage-monitor-push.ts` header; `docs/usage-monitor-integration.md` |
| Three R2 accounts | `src/lib/r2-usage.ts` `R2FleetAccountId` |
| Mac runners + CT scout | FLEET `docs/MAC-LOCAL-PROCESSES.md` |
| DealDex isolation | `DealDex/package.json`; `DealDex/PLAN.md`; `DealDex/docs/rollouts/2026-08-13-fleet-onboard.md` |
| Fleet registry | `ai-fleet-coordinator/fleet-apps.json` |

## 9. Zero-code findings (this PR)

Pins currently **match** at `v2.5.2`.  The danger is the **gate**, not a live
skew.  ST can trade if CT or UM dies.  ST/CT/UM cannot survive the shared
Hetzner box dying.  CT Senate ingest cannot survive the Mac dying.  DealDex
is correctly isolated.  The highest-leverage follow-up is rewriting the
shared-package pin triangle so the next CTS release cannot land on two
consumers and miss the third.
