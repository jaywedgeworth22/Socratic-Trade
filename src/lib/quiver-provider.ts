// QuiverQuant enrichment provider — key-gated, dormant producer for the five *Quiver carrier
// fields (congressTradesQuiver, insiderTradesQuiver, govContractsQuiver, lobbyingQuiver,
// patentsQuiver). Those fields were fully plumbed through src/lib/types.ts and
// data-providers.ts's EnrichmentSourcedField union / takeScalar cascade / EMPTY_SOURCED marker
// map, but no provider ever produced them — a STATUS.md/docs/EFFORT-LOG.md entry claiming a
// "Quiver Quant API Integration" landed was false (see the correction appended to both docs
// alongside this file, 2026-07-15, MONET wave 2). This is the first real producer.
//
// Gated ENTIRELY on QUIVER_API_KEY (process.env only — no per-user credential store; this is a
// slow-moving operator-funded data source, same posture as Massive/FRED). Absent key =>
// getEnrichmentProvider never registers this class => fully dormant, zero calls, zero cost.
//
// QuiverQuant's beta REST API (https://api.quiverquant.com/beta/) exposes one endpoint per
// dataset, scoped by ticker, each returning a JSON array of that ticker's FULL history (no
// server-side date-range filter): historical/congresstrading/{ticker}, historical/insiders/
// {ticker}, historical/govcontractsall/{ticker}, historical/lobbying/{ticker}, historical/
// patents/{ticker}. This provider trims to a trailing lookback window client-side per dataset
// (see the *_LOOKBACK_DAYS constants below) instead of surfacing an ever-growing all-time total.
//
// Field semantics (types.ts carries no doc comments for these five carriers — documenting the
// mapping here; see the rollout note for the same text):
//   congressTradesQuiver — COUNT of congressional trade disclosures in the trailing 180 days.
//   insiderTradesQuiver  — COUNT of SEC Form 4 insider transactions in the trailing 90 days.
//   govContractsQuiver   — SUM of $ obligated across gov contract awards in the trailing 365 days.
//   lobbyingQuiver        — SUM of $ spent on lobbying in the trailing 365 days.
//   patentsQuiver         — COUNT of patents published in the trailing 180 days.
// Counts use shorter activity windows (congress/insider/patent filings arrive continuously);
// the two dollar fields use a full trailing year so a single lumpy quarter doesn't dominate or
// vanish depending on which day the scan runs.
//
// This is real, slow-moving data (congressional disclosures lag weeks by statute, lobbying/gov-
// contract filings are quarterly), so it is cached >=24h per symbol (QUIVER_CACHE_TTL_MS) — a
// scan cadence of minutes never re-hits the API for an unchanged symbol. A failed/partial fetch
// caches whatever DID succeed at a much shorter negative TTL (QUIVER_NEGATIVE_CACHE_TTL_MS) so a
// transient outage/quota block retries the same day instead of being pinned to the 24h floor.
// Every one of the five sub-fetches is independently caught — a single failing dataset (e.g.
// patents 500s) never blocks the other four, and this provider NEVER throws out of enrich()
// (fail-open, per the MarketEnrichmentProvider contract — no fabricated numbers, just an absent
// field when a dataset couldn't be fetched).

import type { MarketEnrichmentProvider, SymbolEnrichment } from "./data-providers";
import { fetchWithRetry } from "./data-providers";
import { normalizeSymbol } from "./money";
import { directVendorRetirementMessage, isDirectVendorAccessAllowed } from "./retired-direct-vendors";

const QUIVER_BASE_URL = "https://api.quiverquant.com/beta";

// Floor at 24h regardless of override — this data does not move fast enough to justify a
// shorter cache, and a misconfigured low override would burn the paid quota needlessly.
const DEFAULT_TTL_MS = 24 * 60 * 60_000;
function quiverTtlMs(): number {
  const value = Number(process.env.QUIVER_CACHE_TTL_MS);
  return Number.isFinite(value) && value >= DEFAULT_TTL_MS ? value : DEFAULT_TTL_MS;
}

// Short negative/partial-result TTL so a transient outage or a single-dataset quota block
// retries the same day instead of sitting behind the 24h positive floor.
const DEFAULT_NEGATIVE_TTL_MS = 6 * 60 * 60_000;
function quiverNegativeTtlMs(): number {
  const value = Number(process.env.QUIVER_NEGATIVE_CACHE_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_NEGATIVE_TTL_MS;
}

// Each symbol costs 5 sub-fetches here, so the default budget is deliberately conservative
// (unlike the shared FMP_MAX_SYMBOLS knob, which several other paid tiers reuse). The env
// override is unclamped — an operator raising it is an explicit decision.
const DEFAULT_MAX_SYMBOLS = 25;
function quiverMaxSymbols(): number {
  const value = Number(process.env.QUIVER_MAX_SYMBOLS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_SYMBOLS;
  return Math.floor(value);
}

const CONCURRENCY = 4;

const CONGRESS_LOOKBACK_DAYS = 180;
const INSIDER_LOOKBACK_DAYS = 90;
const GOV_CONTRACTS_LOOKBACK_DAYS = 365;
const LOBBYING_LOOKBACK_DAYS = 365;
const PATENTS_LOOKBACK_DAYS = 180;

/**
 * Registration gate — permanently returns undefined.
 * Owner 2026-08-04: Socratic-Trade never calls QuiverQuant; congressional /
 * alt-data of that class comes from Congress.Trade (App A). Env keys may still
 * exist in secret stores for Congress.Trade latency probes; they must not
 * activate a producer here.
 */
export function resolveQuiverApiKey(): string | undefined {
  return undefined;
}

interface QuiverRow {
  [key: string]: unknown;
}

/** QuiverQuant beta endpoints normally respond with a bare JSON array; tolerate a wrapped
 *  envelope defensively (mirrors the pattern other providers in data-providers.ts use). */
export function extractQuiverRows(payload: unknown): QuiverRow[] {
  if (Array.isArray(payload)) return payload.filter((r): r is QuiverRow => !!r && typeof r === "object");
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ["results", "data", "rows"]) {
      const value = obj[key];
      if (Array.isArray(value)) return value.filter((r): r is QuiverRow => !!r && typeof r === "object");
    }
  }
  return [];
}

function firstStr(row: QuiverRow, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNum(row: QuiverRow, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value === null || value === undefined || value === "") continue;
    const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** True when `dateStr` parses and falls within the trailing `days` window ending now (+1 day of
 *  slack for clock skew / same-day filings so a just-filed row at the boundary isn't dropped). */
function withinLookback(dateStr: string | undefined, days: number, now: number): boolean {
  if (!dateStr) return false;
  const t = Date.parse(dateStr);
  if (!Number.isFinite(t)) return false;
  const slackMs = 24 * 60 * 60_000;
  return t <= now + slackMs && now - t <= days * 24 * 60 * 60_000;
}

// Field-name candidates cover both the documented QuiverQuant beta PascalCase schema and the
// snake_case shape a normalized proxy may surface — parsing is deliberately tolerant since this
// is an external, versioned third-party API this codebase does not control.
const CONGRESS_DATE_KEYS = ["traded", "Traded", "TransactionDate", "transaction_date", "filed", "Filed", "ReportDate", "report_date", "Date", "date"];
const INSIDER_DATE_KEYS = ["date", "Date", "TransactionDate", "transaction_date", "file_date", "FileDate"];
const GOV_CONTRACT_DATE_KEYS = ["action_date", "ActionDate", "Date", "date"];
const GOV_CONTRACT_AMOUNT_KEYS = ["total_dollars_obligated", "TotalDollarsObligated", "Amount", "amount"];
const LOBBYING_DATE_KEYS = ["date", "Date"];
const LOBBYING_AMOUNT_KEYS = ["amount", "Amount"];
const PATENT_DATE_KEYS = ["pub_date", "PubDate", "Date", "date"];

export function parseCongressTradesCount(rows: QuiverRow[], now: number): number {
  return rows.filter((r) => withinLookback(firstStr(r, CONGRESS_DATE_KEYS), CONGRESS_LOOKBACK_DAYS, now)).length;
}

export function parseInsiderTradesCount(rows: QuiverRow[], now: number): number {
  return rows.filter((r) => withinLookback(firstStr(r, INSIDER_DATE_KEYS), INSIDER_LOOKBACK_DAYS, now)).length;
}

export function parseGovContractsTotal(rows: QuiverRow[], now: number): number {
  let total = 0;
  for (const row of rows) {
    if (!withinLookback(firstStr(row, GOV_CONTRACT_DATE_KEYS), GOV_CONTRACTS_LOOKBACK_DAYS, now)) continue;
    const amount = firstNum(row, GOV_CONTRACT_AMOUNT_KEYS);
    if (amount !== undefined) total += amount;
  }
  return Math.round(total * 100) / 100;
}

export function parseLobbyingTotal(rows: QuiverRow[], now: number): number {
  let total = 0;
  for (const row of rows) {
    // Lobbying rows may carry only a `year`/`Year` (int) with no parseable date field — fall back
    // to Jan 1 of that year so trailing-12-month filtering still works instead of silently
    // dropping the row (a real quarterly filing, not missing data).
    const dateStr =
      firstStr(row, LOBBYING_DATE_KEYS) ??
      (() => {
        const year = firstNum(row, ["year", "Year"]);
        return year !== undefined ? `${year}-01-01` : undefined;
      })();
    if (!withinLookback(dateStr, LOBBYING_LOOKBACK_DAYS, now)) continue;
    const amount = firstNum(row, LOBBYING_AMOUNT_KEYS);
    if (amount !== undefined) total += amount;
  }
  return Math.round(total * 100) / 100;
}

export function parsePatentsCount(rows: QuiverRow[], now: number): number {
  return rows.filter((r) => withinLookback(firstStr(r, PATENT_DATE_KEYS), PATENTS_LOOKBACK_DAYS, now)).length;
}

const quiverCache = new Map<string, { expiresAt: number; data: SymbolEnrichment }>();

/** Test helper: clear the long-TTL Quiver cache between runs. */
export function clearQuiverCache(): void {
  quiverCache.clear();
}

export class QuiverEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "quiverquant";
  readonly configured = true;
  readonly costTier = "paid" as const;

  constructor(private readonly apiKey: string) {}

  async enrich(_symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    // Hard ban: never open a socket to api.quiverquant.com from this app.
    if (!isDirectVendorAccessAllowed("quiverquant")) {
      return {};
    }
    return {};
  }

  private async getRows(symbol: string, path: string): Promise<QuiverRow[]> {
    if (!isDirectVendorAccessAllowed("quiverquant")) {
      throw new Error(directVendorRetirementMessage("quiverquant"));
    }
    const url = `${QUIVER_BASE_URL}/${path}/${encodeURIComponent(symbol)}`;
    const response = await fetchWithRetry(
      url,
      { cache: "no-store", headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" } },
      {
        service: "quiverquant",
        keySource: "env",
        suppressHealthStatuses: [404]
      }
    );
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return extractQuiverRows(await response.json());
  }
}
