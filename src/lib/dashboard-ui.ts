import type { EnrichmentSources, EquityPosition, MarketQuote, NotificationEvent, NotificationEventType, NotificationStatus, OrderSide } from "./types";
import type { SymbolMeta } from "./dashboard-feed";
import { SUPPORTED_INDEX_UNIVERSES, indexUniverseLabel } from "./index-universes";
import { formatQuantity } from "./money";
import { notificationFailureDetail } from "./strategy-run-failure";

export interface EnrichedPosition extends EquityPosition {
  costBasis: number;
  pnl: number;
  returnPct: number;
  allocPct: number;
}

export interface NotificationDisplayItem {
  title: string;
  detail: string;
  timestamp: string;
  symbol?: string;
  companyName?: string;
}

/** Scan source tags are `${IndexUniverse}-universe` (market.ts).  Keys are
 *  lowercased because `normalizeSourceKey` never re-hyphenates camelCase ids.
 *  Labels come from `indexUniverseLabel` so every slug — not just sp500 —
 *  prints `S&P 500 Universe` / `Nasdaq Composite Universe`, never the id. */
const INDEX_UNIVERSE_SOURCE_LABELS: Record<string, string> = Object.fromEntries(
  SUPPORTED_INDEX_UNIVERSES.map((id) => [`${id.toLowerCase()}-universe`, `${indexUniverseLabel(id)} Universe`])
);

const SOURCE_LABELS: Record<string, string> = {
  ...INDEX_UNIVERSE_SOURCE_LABELS,
  finnhub: "Finnhub",
  fmp: "FMP",
  "yahoo-finance": "Yahoo Finance",
  "yahoo-finance-delayed": "Yahoo Finance Delayed",
  "yahoo-finance-delayed-quotes": "Yahoo Finance Delayed Quotes",
  "yahoo-finance-batch": "Yahoo Finance Batch",
  "yahoo-finance-single": "Yahoo Finance Single",
  "yahoo-finance-synthetic": "Yahoo Finance Synthetic",
  "nasdaq-delayed-screener": "NASDAQ Delayed Screener",
  "nasdaq-delayed-screener-universe": "NASDAQ Delayed Screener Universe",
  "alpaca-quotes": "Alpaca Quotes",
  "alpaca-snapshot": "Alpaca Snapshot",
  "alpaca-news": "Alpaca News",
  "massive-vwap": "Massive",
  "broker-quotes": "Broker Quotes",
  robinhood: "Robinhood",
  "robinhood-quotes": "Robinhood Quotes",
  congress: "Congress.Trade",
  "congress.trade": "Congress.Trade",
  "congress-disclosure": "Congressional Disclosures",
  "senate-efd": "Senate EFD",
  "house-clerk": "House Clerk",
  "apify-congress": "Apify Congress",
  "sec-edgar": "SEC EDGAR",
  "sec-8k": "SEC 8-K",
  "sec-10k": "SEC 10-K",
  "sec-xbrl": "SEC XBRL",
  "insider-filing": "Insider Filing",
  "sec-form-4": "SEC Form 4",
  "blackrock-oef-holdings": "BlackRock Holdings",
  "tradingview": "TradingView",
  "cboe": "Cboe",
  "cftc": "CFTC",
  "kenneth-french": "Kenneth French",
  fred: "FRED",
  computed: "Computed",
  blended: "Blended (Multiple Sources)"
};

const SOURCE_LIST_LABELS: Record<string, string> = {
  ...SOURCE_LABELS,
  tiingo: "Tiingo",
  "alpha-vantage": "Alpha Vantage",
  finra: "FINRA",
  "finra-short-volume": "FINRA Short Volume"
};

const PROVENANCE_LABELS: Partial<Record<keyof EnrichmentSources, string>> = {
  companyName: "Company name",
  sector: "Sector",
  industry: "Industry",
  price: "Price",
  intradayChangePct: "Intraday change",
  volume: "Volume",
  bid: "Bid",
  ask: "Ask",
  vwap: "VWAP",
  peRatio: "P/E ratio",
  analystRating: "Analyst rating",
  sentiment: "News sentiment",
  dividendYield: "Dividend yield",
  eps: "EPS",
  fcfYield: "FCF yield",
  debtToEquity: "Debt / equity",
  epsGrowth: "EPS growth",
  insiderSentiment: "Insider sentiment",
  senateTrades: "Congressional trades"
};

const PROVENANCE_ORDER: Array<keyof EnrichmentSources> = [
  "companyName",
  "sector",
  "industry",
  "price",
  "intradayChangePct",
  "volume",
  "bid",
  "ask",
  "vwap",
  "peRatio",
  "analystRating",
  "sentiment",
  "dividendYield",
  "eps",
  "fcfYield",
  "debtToEquity",
  "epsGrowth",
  "insiderSentiment",
  "senateTrades"
];

export function enrichPositionsForDisplay(positions: EquityPosition[], totalMarketValue: number): EnrichedPosition[] {
  return positions.map((position) => {
    const costBasis = position.averageCost * position.quantity;
    const pnl = position.marketValue - costBasis;
    return {
      ...position,
      costBasis,
      pnl,
      returnPct: costBasis > 0 ? (pnl / costBasis) * 100 : 0,
      allocPct: totalMarketValue > 0 ? (position.marketValue / totalMarketValue) * 100 : 0
    };
  });
}

export function friendlySource(name?: string): string {
  if (!name) return "unknown";
  return SOURCE_LABELS[normalizeSourceKey(name)] ?? name;
}

export function formatSourceList(sourceString?: string): string {
  if (!sourceString) return "";
  const labels = sourceString
    .split("+")
    .map((source) => sourceListLabel(source))
    .filter((label) => label && !/^live$/i.test(label) && !/^(none|unknown|-)$/i.test(label));
  const seen = new Set<string>();
  return labels
    .filter((label) => {
      const key = label.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(", ");
}

export function provenanceLabel(field: keyof EnrichmentSources): string {
  return PROVENANCE_LABELS[field] ?? field.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
}

export function orderedSourceEntries(sources?: EnrichmentSources): Array<[keyof EnrichmentSources, string]> {
  if (!sources) return [];
  const order = new Map(PROVENANCE_ORDER.map((field, index) => [field, index]));
  return (Object.entries(sources) as Array<[keyof EnrichmentSources, string]>).sort(([left], [right]) => {
    const leftOrder = order.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return String(left).localeCompare(String(right));
  });
}

function normalizeSourceKey(source: string): string {
  return source.trim().toLowerCase();
}

function sourceListLabel(source: string): string {
  const key = normalizeSourceKey(source);
  return SOURCE_LIST_LABELS[key] ?? titleizeSource(key);
}

function titleizeSource(source: string): string {
  return source
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

export function companyTitle(symbol: string, symbolMetaBySymbol: Record<string, SymbolMeta>): string | undefined {
  return symbolMetaBySymbol[symbol]?.companyName;
}

/**
 * Human "received" label for a timestamp: the clock time if within the last 24h,
 * otherwise the date. Used to stamp every data point's hover tooltip with when the
 * value was last received. Returns "" for a missing/invalid timestamp.
 */
export function receivedLabel(ts?: string): string {
  if (!ts) return "";
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return "";
  const ageMs = Date.now() - t;
  const d = new Date(t);
  if (ageMs >= -60 * 60_000 && ageMs < 24 * 60 * 60_000) {
    return `Received ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  return `Received ${d.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

export function cellTitle(label: string, source?: string, asOf?: string): string {
  const parts = [label];
  // Freshness rides provenance: no recorded source means no provider returned the
  // field, so a "Received <time>" stamp would claim freshness for data we never got.
  if (source) {
    parts.push(`Source: ${friendlySource(source)}`);
    const received = receivedLabel(asOf);
    if (received) parts.push(received);
  }
  return parts.join("\n");
}

export function quoteTitle(label: string, candidate: MarketQuote): string {
  const source = candidate.provider ? `Source: ${friendlySource(candidate.provider)}` : undefined;
  // `asOf` may be a display string ("Last price as of …") rather than a timestamp;
  // only format it as a clock time when it actually parses to a date.
  const ts = candidate.asOf ? Date.parse(candidate.asOf) : NaN;
  const asOf = Number.isFinite(ts)
    ? `Quote time: ${new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : typeof candidate.asOf === "string" && candidate.asOf
      ? candidate.asOf
      : undefined;
  return [label, source, asOf].filter(Boolean).join("\n");
}

export function ratingTitle(candidate: MarketQuote): string {
  if (typeof candidate.analystScore !== "number") return "No analyst rating data";
  const header = `Blended ${candidate.analystScore}/100 (${candidate.analystRating ?? "n/a"})`;
  const lines = Object.entries(candidate.analystBySource ?? {}).map(([src, detail]) => {
    const suffix = detail.counts
      ? ` (Strong Buy ${detail.counts.strongBuy}, Buy ${detail.counts.buy}, Hold ${detail.counts.hold}, Sell ${detail.counts.sell}, Strong Sell ${detail.counts.strongSell})`
      : typeof detail.mean === "number"
        ? ` (Yahoo mean ${detail.mean}; 1.0 = Strong Buy, 3.0 = Hold, 5.0 = Strong Sell)`
        : "";
    return `${friendlySource(src)}: ${detail.label} ${detail.score}${suffix}`;
  });
  return [header, ...lines].join("\n");
}

export function sentimentTitle(candidate: MarketQuote): string {
  const src = candidate.sources ?? {};
  if (typeof candidate.sentiment === "number") {
    const headlineText = candidate.headlines?.length
      ? `\n\nRecent Headlines:\n${candidate.headlines.map((headline) => `• ${headline}`).join("\n")}`
      : "";
    return cellTitle(`News sentiment score ${candidate.sentiment}/100${headlineText}`, src.sentiment);
  }
  return "No recent news sentiment score recorded";
}

export function insiderSentimentTitle(candidate: MarketQuote): string {
  const src = candidate.sources ?? {};
  if (typeof candidate.insiderSentiment === "number") {
    return cellTitle(`Insider sentiment score ${candidate.insiderSentiment}/100`, src.insiderSentiment ?? "sec-edgar");
  }
  return "No recent insider sentiment score recorded";
}

export function scanQuoteAsOf(candidates: MarketQuote[]): string | undefined {
  const timestamp = candidates
    .map((candidate) => candidate.asOf)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  return timestamp ? `quotes as of ${new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : undefined;
}

export function formatShareQuantity(value?: number, symbol?: string): string {
  return formatQuantity(value, symbol);
}

/** Defensive Title-Case de-underscore/de-hyphenate fallback so a raw snake_case or kebab-case
 *  enum value never reaches the user, even for a value not covered by an explicit label map
 *  below. Mirrors `plainLabel` in app/console/lib/labels.ts — that file is a separate package
 *  boundary (this is a server-shared lib and must not import from app/), so this is a small
 *  local mirror, not a cross-import. */
function plainEnumLabel(raw: string): string {
  return raw
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

// ── Feed / proposal / fill statuses (decided vocabulary) ───────────────────────────────────

const FEED_STATUS_LABELS: Record<string, string> = {
  filled: "Filled",
  partially_filled: "Partially filled",
  pending_order: "Order pending",
  pending_reconciliation: "Awaiting reconciliation",
  // Terminal: broker_order_id was unusable (empty / literal "undefined") — cannot reconcile.
  unreconcilable: "Unreconcilable",
  pending_approval: "Awaiting approval",
  approved: "Approved",
  blocked: "Blocked",
  rejected: "Rejected",
  rejected_by_broker: "Rejected by broker",
  pending: "Pending",
  unknown: "Status unknown",
  proposed: "Proposed",
  executed: "Executed",
  expired: "Expired",
  failed: "Failed",
  withdrawn: "Withdrawn",
  placed: "Placed",
  paper: "Paper trade",
  completed: "Completed",
  skipped: "Skipped",
  // Strategy-run pre-decision skips (UX PR-A1) — never success-ish "Completed".
  skipped_budget: "Skipped — LLM budget",
  skipped_market_closed: "Skipped — market closed",
  skipped_broker_unhealthy: "Skipped — broker unhealthy",
  placing_failed: "Placement failed",
  not_placed: "Not placed - safe to retry",
  running: "Running"
};

/** Plain-English label for a feed/proposal/fill status string. Unknown values fall back to a
 *  defensive Title-Case de-underscore rather than ever showing the raw enum. */
export function feedStatusLabel(raw?: string | null): string {
  if (!raw) return "";
  return FEED_STATUS_LABELS[raw.toLowerCase()] ?? plainEnumLabel(raw);
}

// ── Notifications (decided vocabulary) ──────────────────────────────────────────────────────

export const NOTIFICATION_EVENT_TYPE_LABELS: Record<NotificationEventType, string> = {
  fill: "Order filled",
  block: "Trade blocked",
  run_failed: "Strategy Run Failed",
  pending_approval: "Awaiting your approval",
  kill_switch: "Kill switch",
  price_alert: "Price alert",
  proposal_withdrawn: "Proposal withdrawn",
  limit_order_stale: "Stale limit order",
  provider_degraded: "Data provider degraded",
  liveness_warning: "Liveness warning",
  budget_alert: "Budget alert",
  learning_review: "Learning review",
  deterministic_bear_veto: "Vetoed by Bear risk",
  red_team_veto_override_requested: "Red Team override requested",
  red_team_veto_overridden: "Red Team veto overridden",
  prompt_injection_suspected: "Prompt injection suspected",
  evidence_age_anomaly: "Evidence age anomaly",
  storage_warning: "Storage warning",
  autonomy_halted_on_boot: "Autonomy halted on boot",
  option_alert: "Option alert",
  earningscalls_entitlement_blocked: "EarningsCalls.dev plan entitlement blocked",
  roic_status_advisory: "ROIC.ai program status",
  risk_advisory: "Risk advisory",
  protective_exit_failing: "Protective exit failing",
  signal_health: "Signal health drift",
  lookahead_leak: "Lookahead leak suspected",
  watchlist_digest: "Daily watchlist digest"
};

export function notificationTypeLabel(type?: string | null): string {
  if (!type) return "";
  return NOTIFICATION_EVENT_TYPE_LABELS[type as NotificationEventType] ?? plainEnumLabel(type);
}

const NOTIFICATION_STATUS_LABELS: Record<NotificationStatus, string> = {
  sent: "Sent",
  failed: "Delivery failed",
  skipped: "Not sent"
};

export function notificationStatusLabel(status?: string | null): string {
  if (!status) return "";
  return NOTIFICATION_STATUS_LABELS[status as NotificationStatus] ?? plainEnumLabel(status);
}

export function formatNotificationDisplay(
  event: NotificationEvent,
  symbolMetaBySymbol: Record<string, SymbolMeta>
): NotificationDisplayItem {
  const payload = asRecord(event.payload);
  const fill = asRecord(payload.fill);
  const proposal = asRecord(payload.proposal);
  const symbol = normalizeSymbol(stringValue(fill.symbol) ?? stringValue(proposal.symbol) ?? symbolFromTitle(event.title));
  const side = normalizeSide(stringValue(fill.side) ?? stringValue(proposal.side));
  const source = stringValue(fill.source);
  const fillStatus = stringValue(fill.status);
  const companyName = symbol ? symbolMetaBySymbol[symbol]?.companyName : undefined;

  let title = event.title;
  if (event.type === "fill") {
    if (source === "paper") title = `${paperActionLabel(side)} ${symbol ?? "Trade"}`;
    else if (fillStatus === "filled") title = `${executedActionLabel(side)} ${symbol ?? "Position"}`;
    else title = `${actionLabel(side)} ${symbol ?? "Trade"} Pending`;
  } else if (event.type === "block") {
    title = `${actionLabel(side)} ${symbol ?? "Proposal"} Blocked`;
  } else if (event.type === "pending_approval") {
    // Single-adversary visibility (§5.2): when the run flagged this pending approval as
    // "Red Team review unavailable" (payload metadata flag, read defensively via asRecord), the
    // Red-Team-unavailable signal must survive into the feed — append the indicator instead of
    // discarding it with the generic overwrite.
    const adversaryUnavailable = payload.adversaryUnavailable === true;
    const humanReviewReasonTitle = stringValue(payload.humanReviewReasonTitle);
    title = `${actionLabel(side)} ${symbol ?? "Proposal"} Awaiting Approval${humanReviewReasonTitle ? ` — ${humanReviewReasonTitle}` : adversaryUnavailable ? " — Red Team Unavailable" : ""}`;
  } else if (event.type === "kill_switch") {
    title = "Kill Switch Triggered";
  } else if (event.type === "run_failed") {
    title = "Strategy Run Failed";
  } else if (event.type === "proposal_withdrawn") {
    const expired = stringValue(payload.source) === "expiry";
    title = `${actionLabel(side)} ${symbol ?? "Proposal"} ${expired ? "Expired" : "Withdrawn"}`;
  } else if (event.type === "deterministic_bear_veto") {
    title = `${actionLabel(side)} ${symbol ?? "Trade"} Vetoed by Bear Risk`;
  } else if (event.type === "red_team_veto_override_requested") {
    title = `Red Team Override Requested ${symbol ? `for ${symbol}` : ""}`;
  } else if (event.type === "red_team_veto_overridden") {
    title = `Red Team Veto Overridden ${symbol ? `for ${symbol}` : ""}`;
  } else if (event.type === "prompt_injection_suspected") {
    title = `Prompt Injection Suspected ${symbol ? `for ${symbol}` : ""}`;
  } else if (event.type === "evidence_age_anomaly") {
    title = `Evidence Age Anomaly ${symbol ? `for ${symbol}` : ""}`;
  } else if (event.type === "option_alert") {
    title = event.title;
  }

  return {
    title,
    detail: notificationDetail(event),
    timestamp: new Date(event.createdAt).toLocaleString(),
    symbol,
    companyName
  };
}

function notificationDetail(event: NotificationEvent): string {
  if (event.type === "option_alert") {
    const payload = asRecord(event.payload);
    return stringValue(payload.detail) || "Option alert";
  }
  if (
    event.type === "deterministic_bear_veto" ||
    event.type === "red_team_veto_override_requested" ||
    event.type === "red_team_veto_overridden" ||
    event.type === "prompt_injection_suspected" ||
    event.type === "evidence_age_anomaly"
  ) {
    const payload = asRecord(event.payload);
    const reason = stringValue(payload.reason) || stringValue(payload.detail);
    return reason ? `Audit logged: ${reason}` : "Advisory audit logged";
  }
  const failure = notificationFailureDetail({
    type: event.type,
    payload: event.payload,
    title: event.title
  });
  if (failure) return failure;
  const prefix = notificationStatusLabel(event.status);
  const reason = notificationReason(event.error);
  return reason ? `${prefix} - ${reason}` : prefix;
}

function notificationReason(error?: string): string | undefined {
  if (!error) return undefined;
  if (error === "Notifications Webhook Not Configured") return "No notification channels enabled.";
  if (error === "not_configured") return "Notification channel is not configured by the operator.";
  if (error === "no_target") return "Notification channel has no delivery target.";
  if (error === "Notification type is disabled.") return "Type Disabled";
  return error;
}

function actionLabel(side?: OrderSide): string {
  if (side === "sell") return "Sell";
  if (side === "buy") return "Buy";
  if (side === "short") return "Short";
  if (side === "cover") return "Cover";
  return "Trade";
}

function executedActionLabel(side?: OrderSide): string {
  if (side === "sell") return "Sold";
  if (side === "buy") return "Bought";
  if (side === "short") return "Shorted";
  if (side === "cover") return "Covered";
  return "Traded";
}

function paperActionLabel(side?: OrderSide): string {
  if (side === "sell") return "Paper Sell";
  if (side === "buy") return "Paper Buy";
  if (side === "short") return "Paper Short";
  if (side === "cover") return "Paper Cover";
  return "Paper Trade";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Tokens that look like a ticker (all-caps 1-10 chars) but are actually system identifiers
 *  that should never be linked to a symbol drilldown drawer.  `symbolFromTitle` skips every
 *  match in this set so an alert titled "Usage limit hit: openrouter RAG ingest hit daily
 *  cap" no longer surfaces a "RAG" symbol button that opens a phantom SymbolDrilldown for
 *  the AI feature.  Includes LLM/data-provider names that share the casing pattern of real
 *  tickers (RAG, FMP, VOYAGE, OPENROUTER, ALPACA, TRADIER) and common infra acronyms
 *  (API, DB, CPU, GPU, MCP, LLM, HTTP, URL, SQL, SSH, TLS, VPN, CDN, AWS, GCP, AZ).
 *  Exported so the alerts console can render a non-clickable Chip for the same set
 *  (alert-center.tsx: renderSymbolChip). */
export const SYSTEM_SYMBOLS: ReadonlySet<string> = new Set([
  // The AI feature itself (Retrieval-Augmented Generation) — surfaced as "RAG" in alerts.
  "RAG",
  // Data + AI provider / service names
  "FMP", "ALPACA", "ALPAC", "TRADIER", "POLYGON", "VOYAGE", "OPENROUTER",
  "OPENAI", "ANTHROPIC", "GEMINI", "COHERE", "MISTRAL", "DEEPSEEK",
  // Infra acronyms that would otherwise be rendered as if they were tickers
  "API", "DB", "CPU", "GPU", "RAM", "MCP", "LLM", "HTTP", "HTTPS",
  "URL", "URI", "SQL", "SSH", "TLS", "SSL", "VPN", "CDN", "AWS", "GCP", "AZ"
]);

/** True when `value` is a system identifier that must never be treated as a tradable symbol.
 *  Returns false for undefined / empty / lowercase / numeric input. */
export function isSystemSymbol(value: string | undefined | null): value is string {
  if (!value) return false;
  const upper = value.trim().toUpperCase();
  if (!upper) return false;
  return SYSTEM_SYMBOLS.has(upper);
}

function symbolFromTitle(title?: string): string | undefined {
  if (!title) return undefined;
  // Pull every all-caps token 1-10 chars and pick the first one that isn't a known system
  // identifier.  A naive single-match regex used to swallow "RAG" from the RAG-ingest alert
  // title and route the user into a phantom SymbolDrilldown for the AI feature.
  const matches = title.match(/\b[A-Z][A-Z0-9.-]{0,9}\b/g);
  if (!matches) return undefined;
  for (const candidate of matches) {
    if (!isSystemSymbol(candidate)) return candidate;
  }
  return undefined;
}

function normalizeSymbol(symbol?: string): string | undefined {
  const value = symbol?.trim().toUpperCase();
  return value ? value : undefined;
}

function normalizeSide(side?: string): OrderSide | undefined {
  return side === "buy" || side === "sell" || side === "short" || side === "cover" ? side : undefined;
}
