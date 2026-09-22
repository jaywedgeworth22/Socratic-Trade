# Feature enablement backlog (default-off / dormant / gated)

**Owner reminder (2026-07-22):** shipping code with feature flags **off** is intentional for
merge safety, but **default-off is not “done forever.”** This file is the living checklist of
capabilities that exist in the tree but are **not yet product-live** until someone deliberately
enables them (env / Infisical / policy / subscription / rights gate).

**2026-07-24 owner enablement (CURSOR):** Priority A safe RAG retrieval flags flipped to
**default ON** in code + `.env.example` (unset == on). Explicit `=off` still disables.

**2026-07-27 dormant-features readiness (CURSOR):** Implementation substrate so remaining
dormant items can be enabled safely — not a blind flip of rights/cost gates:

- `src/lib/dormant-features.ts` + `GET /api/admin/rag-coverage` → `dormantFeatures` checklist
  (`readyToEnable` vs blocked).
- Marketing pages: `LANDING_PAGE_ENABLED` unset = **ON**; explicit off → 404.
- CSP: `CSP_ENABLED=on` is report-only by default; reports → `POST /api/csp-report`.
- `VECTOR_EMBED_CLEAN_TEXT=on` stamps `embed_rev=2` (vs 1) so mixed populations stay detectable.

Update this file when you add a new default-off switch. Pair enablement with a rollout note +
prod exact-SHA verify. Do **not** purge legacy vectors until unscoped re-embed is verified.

Canonical effort-board rows: `/Users/jay/apps/TRADING-EFFORT-LOG.md` (Planned) +
`docs/EFFORT-LOG.md`.

---

## Ready to enable (ops / owner decision only)

Code and collectors are ready. Flip in Infisical/env when desired; watch receipts.

| Flag / gate | Default | Ready? | How to enable safely |
|-------------|---------|--------|----------------------|
| `LANDING_PAGE_ENABLED` | **ON** (unset) | Live | Set `off` only for private deploys. Pages: `/welcome`, `/how-it-works`, `/strategy`. |
| `CSP_ENABLED` | off (prod Infisical **on** 2026-08-13, report-only) | **Live** (report-only) | `CSP_REPORT_ONLY=on`. Watch `[csp-report]` logs. **Do not** set `CSP_REPORT_ONLY=off` until clean. |
| `USAGE_BUDGET_ENFORCE` | off | **Yes** | Set `on` when usage-monitor budget-status is trusted. Fail-open on monitor outage. |
| `CONGRESS_SHARE_ENABLED` | off (prod Infisical **on** 2026-08-13) | **Live** | Requires `CONGRESS_TRADE_TOKEN` (CT INGEST_TOKEN). Nightly batch + after-scan refs. Keep `CONGRESS_SHARE_FUNDAMENTALS_ENABLED` off unless App A #46 is confirmed. |
| `WEB_SOURCE_SEC8K_FULL_BODY` | off (prod Infisical **on** 2026-08-13) | **Live** (bounded) | Limit 5/cycle + `WEB_SOURCE_SEC8K_FULL_BODY_BUDGET_MS=12000` (cap 60s). Adaptive FTS-mirror batching. Watch `[slow-sync]` / backlog. |
| `VECTOR_EMBED_CLEAN_TEXT` | off (prod Infisical **on** 2026-08-12) | **Yes** (rev-tagged) | Set `on` → new vectors `embed_rev=2`. Reindex/backfill before treating corpus as one space; never purge rev-1 early. |
| `RAG_EMBED_DISCLOSURES` | off (prod Infisical **on** 2026-08-12) | **Yes** (cost) | Parser path tested. OpenRouter/bge-m3 + Pinecone spend. |
| `RAG_MULTIQUERY` | off (prod Infisical **on** 2026-08-12) | **Yes** (paid embed + run-budget) | Facet sub-queries. Guarded by `RAG_RUN_BUDGET_ENABLED`. |
| `RAG_HYDE` | off (prod Infisical **on** 2026-08-12) | **Yes** (needs MULTIQUERY) | One cheap LLM draft per pass (`gpt-5.4-mini`). |
| `RAG_PERSIST_CANDIDATE_POOL` | off | **Yes** (canary) | Short diagnostic canaries only; watch DB growth. Keep `…_FULL` off. |
| `VECTOR_ASOF_STRICT` | off (prod Infisical **on** 2026-08-16) | **Live** | Fail-closed dated retrieval.  Live desk still omits `asOf`.  Receipt 13076/13076 epoch'd.  Re-run dry-run after large ingest.  `docs/rollouts/2026-08-16-asof-strict-on.md`. |

---

## Keep off until precondition clears

| Flag / gate | Default | Blocker |
|-------------|---------|---------|
| `SEC_INGEST_WORKER_ENABLED` | off | Seed via `/api/admin/sec-ingest`; confirm queue/DLQ first |
| `WEB_SOURCE_FMP_TRANSCRIPTS` + `FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED` | both off | Dual gate: entitled FMP plan **and** owner commercial storage rights |
| `RAG_PERSIST_CANDIDATE_POOL_FULL` | off | Full pool persistence — too heavy for always-on |
| **bge-m3 corpus re-embed → purge-legacy** | incomplete | **Do not purge** until unscoped re-embed verified |

---

## Priority A — RAG / retrieval (already LIVE unless noted)

| Flag / gate | Default | Status |
|-------------|---------|--------|
| `RAG_CORPUS_WIDE_LEXICAL` | **ON** | Live 2026-07-24 |
| `HYBRID_RETRIEVAL` | off | Prefer lexical; keep off |
| `RAG_ADAPTIVE_RERANK` | **ON** | Live; no-ops without rerank credentials |
| `RAG_RERANK_PROVIDER` | unset | Set only with key + budget headroom |
| `RAG_PARENT_CONTEXT_EXPANSION` | **ON** | Live |
| `RAG_APPLY_DEFAULT_FLOORS` | **ON** | Live |
| `RAG_RUN_BUDGET_ENABLED` | **ON** | Guardrail live |
| `RAG_RETRIEVAL_TELEMETRY` | **ON** | Live |
| `RAG_RETRIEVAL_STAGE_TELEMETRY` | **ON** | Live |
| `RAG_CITATION_STALENESS` | **ON** | Advisory live |
| `VECTOR_ASOF_SERVER_FILTER` | **ON** | Fail-open live |

---

## Priority B — Market data / sources (dormant until key, rights, or flag)

| Capability | Gate | Notes |
|------------|------|--------|
| FMP earnings transcripts | dual gate above | Rights + entitlement |
| FMP price targets | `FMP_PRICE_TARGETS_ENABLED=off` | Extra call per symbol |
| EarningsCalls.dev | key / plan; `EARNINGSCALLS_DISABLED` | Self-activates when entitled |
| RapidAPI enrichment tier | `RAPIDAPI_KEY` unset → dormant | After free Yahoo |
| Massive short interest | `MASSIVE_API_KEY` + enable flag | Inert without key |
| Quiver enrichment | retired | Owner 2026-08-04: ST must not call Quiver.  Key will not register.  Congressional disclosures come from congress.trade. |
| Webull unofficial | `WEBULL_UNOFFICIAL_ENABLED=off` | Unofficial path |
| Congress share outbound | `CONGRESS_SHARE_ENABLED` **on** (2026-08-13) | Live — token + flag. Fundamentals stay off. |
| Alpaca price event streams | `STREAMS_ALPACA_PRICE_EVENTS_ENABLED` | Streaming |

---

## Priority C — Ops / safety / product surfaces

| Capability | Gate | Notes |
|------------|------|--------|
| Usage-budget hard enforce | `USAGE_BUDGET_ENFORCE=off` | Ready — see table above |
| Infisical primary bridge writer | `INFISICAL_ST_PRIMARY_WRITER_ENABLED=false` | Usage-monitor primary credentials |
| Landing / welcome / strategy | `LANDING_PAGE_ENABLED` unset → **ON** | Explicit off → 404 |
| CSP headers | `CSP_ENABLED=on` + `CSP_REPORT_ONLY=on` (2026-08-13) | Live report-only; `/api/csp-report`. Do not enforce-block. |
| Sentry session replay | `NEXT_PUBLIC_SENTRY_REPLAY_ENABLED=false` | Privacy/cost |
| Dev background workers | `DEV_BACKGROUND_WORKERS=off` | **Keep off** in local UI QA |
| Robinhood broker-held stops | `policy.robinhoodBrokerStops` default off | Per-account policy |
| Apple Sign-In (web) | `AUTH_APPLE_ID` / `AUTH_APPLE_SECRET` | **Waiting on secrets.** Code path live. Infisical keys (no values here): `AUTH_APPLE_ID`, `AUTH_APPLE_SECRET` — or mint from `AUTH_APPLE_TEAM_ID` + `AUTH_APPLE_KEY_ID` + `AUTH_APPLE_PRIVATE_KEY` (SIWA .p8 PEM, not ASC/APNs). |
| Native iOS push (APNs) | `APNS_KEY_ID` + `APNS_TEAM_ID` + `APNS_BUNDLE_ID` + `APNS_P8` (or `APNS_PRIVATE_KEY` / `APNS_PRIVATE_KEY_B64`) | **Waiting on Apple portal secret.** Client + server code live (#2681). Channel reports "not configured" until all four values are in ST prod Infisical. Team `CC8UTF7ATG`, topic `trade.socratic.ios`. Do not invent or commit a `.p8`. |
| Kalshi / options / short-sell capability | dormant per-account double gates | Phase 1 design landed |
| Kalshi macro prompt context | `KALSHI_CONTEXT` (default on) + `KALSHI_ENV` | Public data; inert without `KALSHI_ENV` |
| Kalshi live event orders | `KALSHI_LIVE_ORDERS` + `kalshiLiveOrdersEnabled` both off | Dry-run until both on |
| Alpaca paper options | `optionsTradingEnabled` default off | Paper place/cancel when on; live needs `optionsLiveOrdersEnabled` |
| Broker-held short buy-stops | `brokerStopsForShorts` default on | Alpaca only; requires `shortSellingEnabled` |

---

## Priority D — Cross-app

| App | Dormant / gated themes |
|-----|------------------------|
| Congress.Trade | Mobile parity; FMP Senate recovery; security-bundle; audit trains |
| API-usage-monitor | Oracle cutover / writer ownership; iOS; R2 entitlements |
| congress-trading-shared | Consumer pin upgrades; classifier enrichment contract |
| Fleet infra | Litestream R2; Mac runners banned; Coolify CI capacity |

---

## Settings portal vs Infisical (owner 2026-08-12)

**Infisical is the sole source of truth for runtime secrets.** Coolify should only hold the
Infisical bootstrap (`INFISICAL_CLIENT_ID` / `_SECRET` / `_PROJECT_ID` / `_ENV` / shared twin),
`REQUIRE_SECRETS_MANAGER`, and host process knobs (`NODE_ENV`, `PORT`, `HOSTNAME`,
`DB_BOOTSTRAP`, `NODE_OPTIONS`). Product knobs live in Infisical and/or Settings.

**Should be editable in Settings → Data Sources** (user override → Infisical/env → catalog):
every `SOURCE_SETTINGS_CATALOG` id — FMP intent, SEC/RAG cadence, transcript budgets, news
relevance, Public execution, enrichment toggles.

**Stay Infisical-only (do not put values in the portal):**
API keys and tokens, `ADMIN_*` / `OPS_*` tokens, `DATABASE_URL`, Litestream/R2/B2/AWS creds,
`AUTH_*` secrets, Twilio auth token (the From number can stay a setting if we add it), Slack
bot token, Pinecone/OpenRouter/Voyage keys, Coolify tokens, Infisical identities themselves.

---

## How agents should use this

1. When landing a default-off feature, **add a row here** and a **Planned** effort-log line:
   `Enable <flag> in production after <precondition>`.
2. When the owner asks “what are we not using?”, point here first — then
   `GET /api/admin/rag-coverage` → `dormantFeatures` for live env status.
3. Enabling in prod = Infisical/env change **and/or** code-default flip + health/receipt check + rollout note.
4. Do not enable high-cost or rights-gated flags without an explicit owner decision.

Inventory first cut: GROK 2026-07-22. Owner enablement pass: CURSOR 2026-07-24.
Readiness checklist + collectors: CURSOR 2026-07-27 (`cursor/dormant-features-impl-1c6c`).
Ungate share + 8-K (bounded) + CSP report-only + UM read token: GROK 2026-08-13 (`grok/st-ungate-share-8k-apple-csp`). Apple web still waiting on `AUTH_APPLE_*`.
