import type { EquityOrder, EquityPosition, FillEvent, NotificationEvent, PendingProposal, TradeProposal } from "./types";
import { formatQuantity } from "./money";
import { humanizeFailureText } from "./strategy-run-failure";
import { isWorkingOrderState } from "./broker-held-orders";
import { shortOrderLabel } from "./order-labels";

export interface SymbolMeta {
  companyName?: string;
}

export interface AuditFeedItem {
  id: string;
  createdAt: string;
  title: string;
  detail: string;
  fullText: string;
  symbol?: string;
  companyName?: string;
  connectedAccountId?: string;
  accountLabel?: string;
}

interface SourceAuditEvent {
  id: string;
  createdAt: string;
  kind: string;
  payload: unknown;
  connectedAccountId?: string;
}

export interface StrategyDecisionLike {
  runId: string;
  createdAt?: string;
  status:
    | "completed"
    | "failed"
    | "skipped"
    | "skipped_budget"
    | "skipped_market_closed"
    | "skipped_broker_unhealthy";
  summary: string;
  proposals: Array<{ id?: string; proposal: TradeProposal; status: string; reasons: string[]; orderId?: string }>;
  marketScan?: {
    topCandidates: Array<{ symbol: string; companyName?: string }>;
    quotesBySymbol?: Record<string, { symbol: string; companyName?: string }>;
  };
}

export function buildSymbolMetaBySymbol(input: {
  positions?: EquityPosition[];
  orders?: EquityOrder[];
  pendingProposals?: PendingProposal[];
  latestStrategyRun?: StrategyDecisionLike;
}): Record<string, SymbolMeta> {
  const meta: Record<string, SymbolMeta> = {};

  const ensure = (symbol?: string, companyName?: string) => {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) return;
    meta[normalized] = {
      companyName: companyName?.trim() || meta[normalized]?.companyName
    };
  };

  for (const position of input.positions ?? []) ensure(position.symbol);
  for (const order of input.orders ?? []) ensure(order.symbol);
  for (const pending of input.pendingProposals ?? []) ensure(pending.proposal.symbol);

  const decision = input.latestStrategyRun;
  for (const proposal of decision?.proposals ?? []) ensure(proposal.proposal.symbol);
  for (const quote of decision?.marketScan?.topCandidates ?? []) ensure(quote.symbol, quote.companyName);
  for (const quote of Object.values(decision?.marketScan?.quotesBySymbol ?? {})) ensure(quote.symbol, quote.companyName);

  return meta;
}

export function buildAuditFeed(input: {
  audit: SourceAuditEvent[];
  symbolMetaBySymbol?: Record<string, SymbolMeta>;
  accountLabelById?: Record<string, string>;
  getProposalById?: (proposalId: string) => { proposal: TradeProposal } | undefined;
}): AuditFeedItem[] {
  const symbolMetaBySymbol = input.symbolMetaBySymbol ?? {};
  const accountLabelById = input.accountLabelById ?? {};

  return input.audit.map((event) => {
    const payload = asRecord(event.payload);
    const proposalLookup = proposalFromPayload(payload, input.getProposalById);
    const symbol = normalizeSymbol(
      stringValue(payload.symbol) ??
        stringValue(proposalLookup?.proposal?.symbol) ??
        notificationSymbol(payload)
    );
    const side = normalizeSide(stringValue(payload.side) ?? stringValue(proposalLookup?.proposal?.side) ?? notificationSide(payload));
    const companyName = symbol ? symbolMetaBySymbol[symbol]?.companyName : undefined;

    const feed = formatAuditEvent(event.kind, payload, { symbol, side, companyName });
    return {
      id: event.id,
      createdAt: event.createdAt,
      title: feed.title,
      detail: feed.detail,
      fullText: feed.fullText ?? feed.detail,
      symbol,
      companyName,
      connectedAccountId: event.connectedAccountId,
      accountLabel: event.connectedAccountId ? accountLabelById[event.connectedAccountId] : undefined
    };
  });
}

function formatAuditEvent(
  kind: string,
  payload: Record<string, unknown>,
  context: { symbol?: string; side?: "buy" | "sell" | "short" | "cover"; companyName?: string }
): { title: string; detail: string; fullText?: string } {
  if (kind === "strategy_run") {
    const llm = formatLlmSteps(payload.llmSteps);
    const summary = stringValue(payload.summary) ?? "No summary";
    const failed = payload.status === "failed";
    const detail = failed ? humanizeFailureText(summary) ?? summary : summary;
    return {
      title: failed ? "Strategy Run Failed" : "Strategy Run Completed",
      detail: joinDetail([detail, llm]) ?? detail
    };
  }

  if (kind === "llm_step") {
    const label = stringValue(payload.label) ?? "LLM step";
    const status = stringValue(payload.status) ?? "completed";
    const provider = stringValue(payload.provider);
    const model = stringValue(payload.model);
    const proposalCount = numberValue(payload.proposalCount);
    const reason = stringValue(payload.reason);
    return {
      title: `${label} ${status}`,
      detail: joinDetail([
        model && provider ? `${model} via ${capitalize(provider)}` : model ?? provider,
        proposalCount !== undefined ? `${proposalCount} proposal${proposalCount === 1 ? "" : "s"}` : undefined,
        reason
      ]) ?? "Model step recorded"
    };
  }

  if (kind === "deterministic_bear_veto") {
    return {
      title: `Vetoed by Bear Risk: ${context.symbol ?? "Trade"}`,
      detail: stringValue(payload.reason) ?? "Market regime blocked proposal"
    };
  }

  if (kind === "red_team_veto_override_requested") {
    return {
      title: `Red Team Override Requested: ${context.symbol ?? "Trade"}`,
      detail: stringValue(payload.reason) ?? "Override request recorded"
    };
  }

  if (kind === "red_team_veto_overridden") {
    return {
      title: `Red Team Veto Overridden: ${context.symbol ?? "Trade"}`,
      detail: stringValue(payload.reason) ?? "Human override recorded"
    };
  }

  if (kind === "prompt_injection_suspected") {
    return {
      title: `Prompt Injection Suspected: ${context.symbol ?? "Trade"}`,
      detail: stringValue(payload.detail) ?? "Security anomaly logged"
    };
  }

  if (kind === "evidence_age_anomaly") {
    return {
      title: `Evidence Age Anomaly: ${context.symbol ?? "Trade"}`,
      detail: stringValue(payload.detail) ?? "Stale context recorded"
    };
  }

  if (kind === "policy_change") {
    return {
      title: "Policy updated",
      detail: `Changed ${stringValue(payload.key) ?? "settings"}`
    };
  }

  if (kind === "profile_change") {
    const action = stringValue(payload.action) ?? "updated";
    return {
      title: `Profile ${action}`,
      detail: shortText(stringValue(payload.name) ?? "Strategy profile")
    };
  }

  if (kind === "proposal_approved") {
    const result = stringValue(payload.result) ?? "approved";
    const titlePrefix = sideLabel(context.side, context.symbol) ?? "Proposal";
    const title =
      result === "blocked"
        ? `${titlePrefix} Blocked`
        : result === "filled"
          ? `${titlePrefix} Filled`
          : result === "placed" || result === "paper"
          ? `${titlePrefix} Approved`
          : `${titlePrefix} ${capitalize(result)}`;
    const orderId = stringValue(payload.orderId);
    const buildProposalApprovedDetail = (orderIdFragment: string | undefined) =>
      joinDetail([
        // "paper" here is a legacy result value from before the local-simulation execution path was
        // removed — no code path writes it anymore, but old audit rows can still carry it.
        result === "paper" ? "Local simulation (legacy)" : undefined,
        result === "filled" ? "Order filled" : undefined,
        result === "placed" && stringValue(payload.fillStatus) === "pending_reconciliation" ? "Broker accepted order; pending execution" : undefined,
        result === "placed" && stringValue(payload.fillStatus) !== "pending_reconciliation" ? "Order placed" : undefined,
        (result === "placed" || result === "filled") && stringValue(payload.brokerState) ? `Broker state ${readableBrokerState(stringValue(payload.brokerState))}` : undefined,
        orderIdFragment,
        firstReason(payload)
      ]);
    // Detail shows the short order tag ("Order 6F8A1C2E"); the full broker order id is never
    // lost — it stays available via fullText (the raw-toggle affordance) when it differs.
    const detail = buildProposalApprovedDetail(orderId ? `Order ${shortOrderLabel(orderId)}` : undefined) ?? "Awaiting next update";
    const fullDetail = orderId ? buildProposalApprovedDetail(`Order ${orderId}`) : undefined;
    return { title, detail, fullText: fullDetail && fullDetail !== detail ? fullDetail : undefined };
  }

  if (kind === "proposal_rejected") {
    return {
      title: `${sideLabel(context.side, context.symbol) ?? "Proposal"} Rejected`,
      detail: "Rejected manually"
    };
  }

  if (kind === "order_rejected_by_broker") {
    const brokerState = stringValue(payload.brokerState);
    const orderId = stringValue(payload.orderId);
    const reason = stringValue(payload.reason) ?? stringValue(payload.error);
    const buildBrokerDeclineDetail = (orderIdFragment: string | undefined) =>
      joinDetail([
        brokerState ? `Broker state ${readableBrokerState(brokerState)}` : "Broker declined the order",
        orderIdFragment,
        reason
      ]);
    const detail = buildBrokerDeclineDetail(orderId ? `Order ${shortOrderLabel(orderId)}` : undefined) ?? "Broker declined the order";
    const fullDetail = orderId ? buildBrokerDeclineDetail(`Order ${orderId}`) : undefined;
    return {
      title: `${sideLabel(context.side, context.symbol) ?? context.symbol ?? "Order"} Broker Declined`,
      detail,
      fullText: fullDetail && fullDetail !== detail ? fullDetail : undefined
    };
  }

  if (kind === "notification") {
    const notification = payload as unknown as NotificationEvent;
    const symbol = normalizeSymbol(notificationSymbol(payload)) ?? context.symbol;
    const side = normalizeSide(notificationSide(payload)) ?? context.side;
    if (notification.type === "fill") {
      return {
        title: `${sideLabel(side, symbol) ?? symbol ?? "Trade"} ${notificationStatusLabel(notification.status)}`,
        detail: notification.error ? shortText(notification.error) : shortText(notification.title)
      };
    }
    if (notification.type === "pending_approval") {
      return {
        title: `${sideLabel(side, symbol) ?? symbol ?? "Proposal"} Approval Pending`,
        detail: notification.error ? shortText(notification.error) : shortText(notification.title)
      };
    }
    if (notification.type === "block") {
      return {
        title: `${sideLabel(side, symbol) ?? symbol ?? "Proposal"} Blocked`,
        detail: notification.error ? shortText(notification.error) : shortText(firstReason(asRecord(notification.payload)) ?? notification.title)
      };
    }
    return {
      title: `${notificationTypeLabel(notification.type)} ${notificationStatusLabel(notification.status)}`,
      detail: notification.error ? shortText(notification.error) : shortText(notification.title)
    };
  }

  if (kind === "fill_reconciled") {
    const status = stringValue(payload.status);
    return {
      title: `${context.symbol ?? "Fill"} reconciled`,
      detail: joinDetail([
        status ? feedStatusLabel(status) : undefined,
        numberValue(payload.quantity) ? `Qty ${trimNumber(numberValue(payload.quantity) ?? 0)}` : undefined,
        numberValue(payload.price) ? `@ ${trimCurrency(numberValue(payload.price) ?? 0)}` : undefined
      ]) ?? "Broker state synced"
    };
  }

  if (kind === "order_cancel") {
    const orderId = stringValue(payload.orderId);
    const detail = shortText(orderId ? `Order ${shortOrderLabel(orderId)}` : "Broker request submitted");
    const fullDetail = orderId ? shortText(`Order ${orderId}`) : undefined;
    return {
      title: "Order cancel requested",
      detail,
      fullText: fullDetail && fullDetail !== detail ? fullDetail : undefined
    };
  }

  if (kind === "post_mortem_reflection") {
    const provider = stringValue(payload.provider);
    const model = stringValue(payload.model);
    const modelAttribution = model && provider ? `${model} via ${capitalize(provider)}` : model ?? provider;
    if (payload.status === "failed") {
      return {
        title: "Post-mortem reflection failed",
        detail: joinDetail([modelAttribution, stringValue(payload.reason)]) ?? "The reflection model call failed"
      };
    }
    return {
      title: "Post Mortem Reflection",
      detail: joinDetail([modelAttribution, stringValue(payload.summary)]) ?? stringValue(payload.summary) ?? "No reflection summary"
    };
  }

  if (kind === "recoverable_issue") {
    const source = stringValue(payload.source) ?? "system";
    const operation = stringValue(payload.operation) ?? "operation";
    const repeats = numberValue(payload.suppressedSinceLastAudit);
    const message = plainRecoverableMessage(stringValue(payload.message) ?? operation);
    return {
      title: `${capitalize(source)} issue`,
      detail: joinDetail([
        message,
        stringValue(payload.fallback) ? `Fallback: ${stringValue(payload.fallback) ?? ""}` : undefined,
        repeats && repeats > 0 ? `${repeats} repeat${repeats === 1 ? "" : "s"} suppressed` : undefined
      ]) ?? operation
    };
  }

  if (kind === "candidates_considered") {
    const chosen = Array.isArray(payload.chosen) ? payload.chosen : [];
    const skipped = Array.isArray(payload.topSkipped) ? payload.topSkipped : [];
    const skippedSymbols = skipped
      .map((item) => asRecord(item))
      .map((item) => {
        const symbol = stringValue(item.symbol);
        const score = numberValue(item.score);
        return symbol ? `${symbol}${score !== undefined ? ` ${Math.round(score)}` : ""}` : undefined;
      })
      .filter(Boolean)
      .slice(0, 8)
      .join(", ");
    return {
      title: "Candidates considered",
      detail: joinDetail([
        `Chosen ${chosen.length}`,
        skipped.length > 0 ? `Top skipped: ${skippedSymbols || `${skipped.length} candidates`}` : "No skipped candidates",
        formatLlmSteps(payload.llmSteps)
      ]) ?? "No candidates recorded"
    };
  }

  if (kind === "signal_snapshot") {
    const signals = Array.isArray(payload.signals) ? payload.signals : [];
    const chosen = signals.filter((item) => asRecord(item).chosen === true).length;
    const asOf = stringValue(payload.asOf);
    return {
      title: "Signal snapshot",
      detail: joinDetail([
        `${signals.length} candidate signal${signals.length === 1 ? "" : "s"}`,
        chosen > 0 ? `${chosen} chosen` : "0 chosen",
        asOf ? `as of ${asOf}` : undefined
      ]) ?? "Signal evidence captured"
    };
  }

  if (kind === "rationale_diversity") {
    const count = numberValue(payload.count) ?? 0;
    const mean = numberValue(payload.meanPairwiseSimilarity);
    return {
      title: "Rationale diversity",
      detail: joinDetail([
        `${count} rationale${count === 1 ? "" : "s"} analyzed`,
        mean !== undefined ? `mean similarity ${mean.toFixed(2)}` : undefined,
        formatLlmSteps(payload.llmSteps)
      ]) ?? "Rationale check recorded"
    };
  }

  if (kind.startsWith("run_skipped_")) {
    const detail = genericAuditDetail(payload) ?? humanizeKind(kind);
    const fullDetail = genericAuditDetail(payload, { shortIds: false });
    return {
      title: "Strategy run skipped",
      detail,
      fullText: fullDetail && fullDetail !== detail ? fullDetail : undefined
    };
  }

  if (kind === "wash_sale_ira_disregarded") {
    // IRA rebuy proceeded under taxSettings.iraWashSaleHandling = "disregard" — surface the
    // verbatim annotation + priced provenance so the acceptance is visible in Activity.
    const symbol = stringValue(payload.symbol);
    const washSale = asRecord(payload.washSale);
    const note = stringValue(washSale.note) ?? "Wash Sale (Technically, but IRA purchase unreported to IRS)";
    const cost = numberValue(washSale.estimatedTaxCostUsd);
    const account = stringValue(washSale.account);
    return {
      title: `IRA wash sale disregarded${symbol ? ` — ${symbol}` : ""}`,
      detail:
        joinDetail([
          note,
          account ? `loss in ${account}` : undefined,
          cost !== undefined ? `~$${cost.toFixed(2)} deduction technically forfeited` : undefined
        ]) ?? note,
      fullText: serializeAuditPayload(payload)
    };
  }

  // ── Ops / housekeeping events: humanized one-liners (raw JSON only in fullText) ──

  if (kind === "web_source_refresh") {
    const id = stringValue(payload.id) ?? "web source";
    const label = WEB_SOURCE_LABELS[id] ?? id;
    const ok = payload.ok === true;
    const recordCount = numberValue(payload.recordCount) ?? 0;
    const fresh = numberValue(payload.fresh);
    const warning = stringValue(payload.warning) ?? stringValue(payload.reason);
    return {
      title: "Web source refresh",
      detail: ok
        ? joinDetail([
            `Refreshed ${recordCount} ${label} ${recordCount === 1 ? "entry" : "entries"}`,
            fresh !== undefined ? `${fresh} new` : undefined,
            warning
          ]) ?? `Refreshed ${label}`
        : joinDetail([`${capitalize(label)} refresh failed`, warning]) ?? `${capitalize(label)} refresh failed`,
      fullText: serializeAuditPayload(payload)
    };
  }

  if (kind === "congress_share_daily") {
    const ok = payload.ok === true;
    const reason = stringValue(payload.reason);
    const tickers = numberValue(payload.tickers) ?? 0;
    const priced = numberValue(payload.priced) ?? 0;
    const posts = numberValue(payload.posts) ?? 0;
    const failedPosts = numberValue(payload.failedPosts) ?? 0;
    return {
      title: "Congress daily share",
      detail:
        reason === "nothing-to-send"
          ? "Nothing to send today"
          : joinDetail([
              `${priced} of ${tickers} tickers priced`,
              `${posts} post${posts === 1 ? "" : "s"} sent`,
              failedPosts > 0 ? `${failedPosts} failed` : undefined,
              !ok && failedPosts === 0 ? "did not complete" : undefined
            ]) ?? "Daily share batch recorded",
      fullText: serializeAuditPayload(payload)
    };
  }

  if (kind === "notify.bridge.error") {
    const type = stringValue(payload.type);
    const errorMessage = stringValue(payload.error);
    return {
      title: "Notification delivery failed",
      detail: joinDetail([`Could not deliver ${type ?? "a"} notification`, errorMessage]) ?? "Could not deliver a notification",
      fullText: serializeAuditPayload(payload)
    };
  }

  if (kind === "connection_health_alert") {
    // Plain English instead of the scalar dump ("Key Source: none · User Id: local"):
    // say WHICH connection is failing and why; the raw payload stays on the toggle.
    const service = stringValue(payload.service);
    const errorText = stringValue(payload.errorText);
    const keySource = stringValue(payload.keySource);
    return {
      title: service ? `${capitalize(service)} connection is failing` : "A provider connection is failing",
      detail:
        joinDetail([
          errorText,
          keySource && keySource !== "none" ? `key from ${keySource}` : "no API key configured"
        ]) ?? "The server's health check could not reach this provider.",
      fullText: serializeAuditPayload(payload)
    };
  }

  // Unknown/unhandled audit kinds NEVER render raw JSON inline — the detail is either a
  // recognized generic field, up to 3 scalar payload fields as "Key: value" fragments, or a
  // plain "Event recorded". The full JSON payload stays available via the existing
  // RawToggle/fullText affordance.
  const serializedPayload = serializeAuditPayload(payload);
  const detail = genericAuditDetail(payload) ?? scalarFieldsDetail(payload) ?? "Event recorded";
  return {
    title: humanizeKind(kind),
    detail,
    fullText: serializedPayload ?? detail
  };
}

function proposalFromPayload(
  payload: Record<string, unknown>,
  getProposalById?: (proposalId: string) => { proposal: TradeProposal } | undefined
) {
  const nested = asRecord(payload.payload);
  const proposalId = stringValue(payload.proposalId) ?? stringValue(nested.proposalId);
  return proposalId && getProposalById ? getProposalById(proposalId) : undefined;
}

function firstReason(payload: Record<string, unknown>): string | undefined {
  const reason = stringValue(payload.reason);
  if (reason) return reason;
  const reasons = payload.reasons;
  if (Array.isArray(reasons)) {
    const first = reasons.find((item) => typeof item === "string");
    if (typeof first === "string") return first;
  }
  return undefined;
}

function notificationSymbol(payload: Record<string, unknown>): string | undefined {
  const nested = asRecord(payload.payload);
  const fill = asRecord(nested.fill);
  const proposal = asRecord(nested.proposal);
  return stringValue(fill.symbol) ?? stringValue(proposal.symbol) ?? symbolFromTitle(stringValue(payload.title));
}

function notificationSide(payload: Record<string, unknown>): string | undefined {
  const nested = asRecord(payload.payload);
  const fill = asRecord(nested.fill);
  const proposal = asRecord(nested.proposal);
  return stringValue(fill.side) ?? stringValue(proposal.side);
}

function symbolFromTitle(title?: string): string | undefined {
  if (!title) return undefined;
  // Same denylist filter as dashboard-ui.ts: never treat a system identifier (RAG, FMP,
  // OPENROUTER, …) as a tradable symbol even though it matches the all-caps token regex.
  // Reuses the exported SYSTEM_SYMBOLS + isSystemSymbol from dashboard-ui so the two feed
  // paths cannot drift out of sync.
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

function normalizeSide(side?: string): "buy" | "sell" | "short" | "cover" | undefined {
  return side === "buy" || side === "sell" || side === "short" || side === "cover" ? side : undefined;
}

function sideLabel(side?: "buy" | "sell" | "short" | "cover", symbol?: string): string | undefined {
  if (!symbol) return undefined;
  if (!side) return symbol;
  const word =
    side === "buy" ? "Buy" : side === "sell" ? "Sell" : side === "short" ? "Short" : side === "cover" ? "Cover" : "Trade";
  return `${word} ${symbol}`;
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : value;
}

function shortText(value: string): string {
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Plain-English fallback for an audit kind with no dedicated branch above (e.g.
 *  "notify.prefs.set", "run_skipped_market_closed"). De-underscores, de-dots (namespaced kinds
 *  like "notification.delivery" or "watchlist.add" must never reach the UI as a raw
 *  `Foo.bar` string), and capitalizes just the leading letter (sentence case), matching the
 *  decided-vocabulary style used elsewhere in this file ("Web source refresh", "Trade
 *  blocked", ...) rather than every-word Title Case. */
function humanizeKind(kind: string): string {
  const spaced = kind.replace(/[._]+/g, " ");
  return spaced.length > 0 ? `${spaced[0]!.toUpperCase()}${spaced.slice(1)}` : spaced;
}

/** Title-Case de-underscore/de-camelCase for a payload field NAME used in a "Key: value"
 *  fragment (see `scalarFieldsDetail`) — e.g. "recordCount" -> "Record Count". Distinct from
 *  `humanizeKind`'s sentence-case treatment: field-name labels read as short header words. */
function titleCaseFieldKey(key: string): string {
  const spaced = key
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return spaced.replace(/\b\w/g, (char) => char.toUpperCase());
}

/** Last-resort detail for an unrecognized audit kind: up to 3 scalar (string/number/boolean)
 *  payload fields rendered as plain "Key: value" fragments — never the raw JSON blob. The raw
 *  payload stays available via `fullText` (see the catch-all return below). */
function scalarFieldsDetail(payload: Record<string, unknown>, limit = 3): string | undefined {
  const entries = Object.entries(payload).filter(
    ([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  );
  if (entries.length === 0) return undefined;
  const fragments = entries.slice(0, limit).map(([key, value]) => `${titleCaseFieldKey(key)}: ${String(value)}`);
  return fragments.length > 0 ? fragments.join(" · ") : undefined;
}

/** Broker order ids get shortOrderLabel (src/lib/order-labels.ts); strategy run ids get the
 *  same short-tag treatment via this local mirror — order-labels.ts is scoped to broker order
 *  ids, and run ids are a different id space, so this stays a tiny local helper rather than a
 *  cross-import. Same deterministic, stateless first-8-chars-uppercase projection. */
function shortRunLabel(id: string): string {
  const cleaned = String(id ?? "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
  if (cleaned.length === 0) return "?";
  if (cleaned.length < 8) return cleaned;
  return cleaned.slice(0, 8);
}

/** OrderType labels (decided vocabulary) for order/fill detail strings. A tiny local map rather
 *  than importing app/console/orders/lib.ts's orderTypeLabel — this is a server-shared lib and
 *  must not import from app/. */
const ORDER_TYPE_LABELS: Record<string, string> = {
  market: "Market",
  limit: "Limit",
  stop_market: "Stop-market",
  stop_limit: "Stop-limit"
};

function feedOrderTypeLabel(type?: string): string {
  if (!type) return "-";
  return ORDER_TYPE_LABELS[type] ?? humanizeKind(type);
}

/** Human names for the web-source connector ids used in `web_source_refresh` audits. */
const WEB_SOURCE_LABELS: Record<string, string> = {
  congress: "congressional-trade",
  "congress-analytics": "congressional-analytics",
  insider: "insider-filing (SEC Form 4)",
  finra: "short-interest (FINRA)",
  sec8k: "SEC 8-K filing",
  technical: "technical-signal"
};

/** Pure-ops audit kinds: background data refreshes and housekeeping that are not
 *  account decisions. The console collapses these into a "System" group. */
// Housekeeping/background kinds: bundled into the collapsed System bucket instead of one card
// each. notify.sent / notify.error / notification.delivery are channel-DELIVERY mechanics — the
// `notification` panel row (which carries the alert's content + status) still renders in the
// main feed; these are the per-channel webhook/email/push plumbing that used to add 2-4 rows per
// alert. notification.delivery in particular used to render as its own standalone
// "Notification.delivery" card duplicating the alert it belongs to (it carries no proposalId/
// runId to fold into that alert's group, so it needs its own ops-kind entry rather than
// piggybacking on another group's key).
export const OPS_AUDIT_KINDS = new Set([
  "web_source_refresh",
  "congress_share_daily",
  "notify.bridge.error",
  "notify.sent",
  "notify.error",
  "notification.delivery",
  "due_jobs_intraday_sample_drain",
  "vector_store",
  "recoverable_issue",
  "llm_cache_usage",
  // Corpus ingest/embed receipts (#2553a): a 10-K backlog drain used to open TODAY with ~30
  // "Sec filing ingest" cards plus per-cycle "Disclosure rag embed" rows before any trading
  // event. None of these carry a runId/proposalId, so each rendered as its own standalone card
  // instead of folding into the System collapse. They are pure data-pipeline housekeeping.
  "sec_filing_ingest",
  "sec_filing_refresh",
  "disclosure_rag_embed",
  "fmp_transcript_ingest",
  "fmp_transcript_refresh",
  "roic_transcript_ingested",
  "roic_transcript_refresh",
  "technical_signal_ingest",
  "fundamentals_card_ingest",
  "sec8k_rag_backlog_truncated"
]);

/** Audit kinds that are a one-shot settings/preference log entry, not a lifecycle action with a
 *  real completion state — the standalone-group fallback below must not paint these with a
 *  misleading "Completed" chip (e.g. "Data pool consent — Completed" implies a finished process
 *  where there is none, just a toggle that was set). These groups render with no status chip at
 *  all (the console only draws a chip when `status` is non-empty). */
const STATUS_LESS_AUDIT_KINDS = new Set(["data_pool_consent"]);

/**
 * Consolidate ANY audit event that carries a `runId` into its `run-<runId>` group (owner request
 * 2026-07-08: an hour of activity showed 30-40 separate cards because only 5 allowlisted kinds
 * joined the run group while a real run emits 15+ runId-tagged kinds — rag_retrieval_status,
 * experience_retrieval, llm_call_latency, evidence_age_anomaly, socratic_outcome_job, …).
 * Grouping is generic-by-runId, so new run-scoped audit kinds bundle automatically instead of
 * needing an allowlist entry. Proposal-linked events still take `prop-<id>` precedence at the
 * call site, and the run card's title stays anchored on the `strategy_run` summary event.
 */
function runGroupIdForAudit(_kind: string, payload: Record<string, unknown>): string | undefined {
  const runId = stringValue(payload.runId);
  return runId ? `run-${runId}` : undefined;
}

function trimNumber(value: number): string {
  const decimals = Math.abs(value) >= 1 ? 3 : 4;
  return value.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

function trimCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

function joinDetail(parts: Array<string | undefined>): string | undefined {
  const filtered = parts.filter(Boolean);
  return filtered.length > 0 ? filtered.join(" · ") : undefined;
}

/** `shortIds: false` (default true) spells out the full raw order/run id instead of the short
 *  tag — callers use that variant to build a distinct `fullText` so the complete id is never
 *  lost when the short-tag `detail` is shown. */
function genericAuditDetail(payload: Record<string, unknown>, options?: { shortIds?: boolean }): string | undefined {
  const details = asRecord(payload.details);
  const symbol = stringValue(payload.symbol) ?? stringValue(details.symbol);
  const side = stringValue(payload.side);
  const status = stringValue(payload.status);
  const operation = stringValue(payload.operation);
  const reason = stringValue(payload.reason);
  const summary = stringValue(payload.summary);
  const message = stringValue(payload.message);
  const error = stringValue(payload.error);
  const orderId = stringValue(payload.orderId);
  const runId = stringValue(payload.runId);
  const count = numberValue(payload.count) ?? numberValue(payload.recordCount) ?? numberValue(payload.candidateCount);
  const shortIds = options?.shortIds !== false;
  return joinDetail([
    reason,
    summary,
    message,
    error,
    operation,
    symbol ? [side, symbol].filter(Boolean).join(" ") : side,
    status ? `Status: ${feedStatusLabel(status)}` : undefined,
    orderId ? `Order ${shortIds ? shortOrderLabel(orderId) : orderId}` : undefined,
    count !== undefined ? `Count ${count}` : undefined,
    runId ? `Run ${shortIds ? shortRunLabel(runId) : runId}` : undefined
  ]);
}

function serializeAuditPayload(payload: Record<string, unknown>): string | undefined {
  if (Object.keys(payload).length === 0) return undefined;
  try {
    return JSON.stringify(payload);
  } catch {
    return undefined;
  }
}

function plainRecoverableMessage(message: string): string {
  if (/unexpected additional properties/i.test(message) && /validating/i.test(message)) {
    return "Robinhood rejected the quote request parameters.";
  }
  return message;
}

function formatLlmSteps(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const parts = value
    .map((item) => {
      const step = asRecord(item);
      const label = stringValue(step.label) ?? stringValue(step.step) ?? "LLM";
      const model = stringValue(step.model);
      const provider = stringValue(step.provider);
      const status = stringValue(step.status);
      if (!model && !provider) return undefined;
      const modelPart = model && provider ? `${model} via ${capitalize(provider)}` : model ?? provider;
      return `${label}: ${modelPart}${status && status !== "completed" ? ` (${status})` : ""}`;
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function readableBrokerState(state?: string): string {
  if (!state) return "Pending";
  return state.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isTerminalBrokerState(state?: string): boolean {
  return Boolean(state && ["canceled", "cancelled", "rejected", "failed", "expired"].includes(state));
}

function isPendingBrokerState(state?: string): boolean {
  // Shared working-state set (excludes terminal done_for_day — see broker-held-orders.ts).
  return isWorkingOrderState(state);
}

function brokerOrderDetail(order: EquityOrder | undefined, fillStatus?: string): string {
  if (!order) {
    if (fillStatus === "pending_reconciliation") return "Broker order accepted; awaiting broker status update.";
    if (fillStatus === "filled") return "Filled by broker.";
    if (fillStatus === "partially_filled") return "Partially filled by broker.";
    if (isTerminalBrokerState(fillStatus)) return `Broker reported ${readableBrokerState(fillStatus)}.`;
    return "Awaiting broker status update.";
  }
  const formattedFilled = formatQuantity(order.filledQuantity, normalizeSymbol(order.symbol));
  const formattedTotal = formatQuantity(order.quantity, normalizeSymbol(order.symbol));
  const prefix =
    fillStatus === "pending_reconciliation" && order.state === "filled"
      ? "Filled by broker; awaiting local reconciliation"
      : order.state === "filled"
      ? "Filled by broker"
      : order.state === "partially_filled"
        ? "Partially filled by broker"
        : isTerminalBrokerState(order.state)
          ? `Broker reported ${readableBrokerState(order.state)}`
          : "Accepted by broker; awaiting fill";
  // Don't restate a state the prefix already names ("Broker reported Expired: Expired",
  // "Filled by broker: Filled"); working states keep it ("Accepted by broker...: New").
  const state = readableBrokerState(order.state);
  const parts = [
    prefix.toLowerCase().includes(state.toLowerCase()) ? null : state,
    `Qty ${formattedFilled} / ${formattedTotal}`,
    feedOrderTypeLabel(order.type)
  ].filter(Boolean);
  return `${prefix}: ${parts.join(" · ")}`;
}

function brokerOrderTitle(order: EquityOrder): string {
  const side = order.side.toUpperCase();
  const symbol = normalizeSymbol(order.symbol);
  if (order.state === "filled") return `Order Filled: ${side} ${symbol}`;

  if (order.state === "partially_filled") return `Order Partially Filled: ${side} ${symbol}`;
  if (isTerminalBrokerState(order.state)) return `Order ${readableBrokerState(order.state)}: ${side} ${symbol}`;
  return `Order Submitted: ${side} ${symbol}`;
}

import { feedStatusLabel, formatNotificationDisplay, isSystemSymbol, notificationStatusLabel, notificationTypeLabel } from "./dashboard-ui";

const KNOWN_GLOBAL_AUDIT_KINDS = new Set([
  "vector_store",
  "notify.sent",
  "notify.error",
  "congress_share_daily",
  "market_scan_failed",
  "regime_flip",
  "storage_warning_alert",
  "connection_health_alert",
  "consent",
  "prefs",
  "daily_cleanup"
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export interface UnifiedActivitySubEvent {
  id: string;
  createdAt: string;
  type: "audit" | "notification" | "fill" | "order";
  title: string;
  detail: string;
  fullText?: string;
  status?: string;
  error?: string;
  raw?: unknown;
  count?: number;
}

export interface UnifiedActivityGroup {
  id: string;
  proposalId?: string;
  createdAt: string;
  updatedAt: string;
  symbol?: string;
  side?: "buy" | "sell" | "short" | "cover";
  companyName?: string;
  title: string;
  detail: string;
  fullText?: string;
  status: string;
  tags: string[];
  events: UnifiedActivitySubEvent[];
  connectedAccountId?: string;
  accountLabel?: string;
  count?: number;
}

/** Source-level cap on the PROPOSAL-LESS unified-feed tail (fills with no proposal + notifications),
 *  which is render-only (client slices the rendered feed to 50). Proposal-bearing groups are never
 *  capped — the decision ledger reconciles their statuses for up to 100 recent proposals. */
export const UNIFIED_FEED_MAX_GROUPS = 60;

export function buildUnifiedFeed(input: {
  audit: SourceAuditEvent[];
  notifications: NotificationEvent[];
  fills: FillEvent[];
  orders: EquityOrder[];
  symbolMetaBySymbol: Record<string, SymbolMeta>;
  accountLabelById?: Record<string, string>;
  getProposalById?: (proposalId: string) => { proposal: TradeProposal } | undefined;
}): UnifiedActivityGroup[] {
  const symbolMetaBySymbol = input.symbolMetaBySymbol ?? {};
  const accountLabelById = input.accountLabelById ?? {};
  const proposalIdByOrderId: Record<string, string> = {};

  // Build mapping of order_id to proposal_id from fills
  for (const fill of input.fills) {
    if (fill.proposalId && fill.brokerOrderId) {
      proposalIdByOrderId[fill.brokerOrderId] = fill.proposalId;
    }
  }

  // Build mapping from audit events
  for (const event of input.audit) {
    if (event.kind === "proposal_approved") {
      const payload = asRecord(event.payload);
      const proposalId = stringValue(payload.proposalId);
      const orderId = stringValue(payload.orderId);
      if (proposalId && orderId) {
        proposalIdByOrderId[orderId] = proposalId;
      }
    }
  }

  const groupEvents: Record<string, UnifiedActivitySubEvent[]> = {};

  const addSubEvent = (groupId: string, subEvent: UnifiedActivitySubEvent) => {
    if (!groupEvents[groupId]) groupEvents[groupId] = [];
    groupEvents[groupId].push(subEvent);
  };

  const proposalIdByGroupId = new Map<string, string>();
  const symbolByGroupId = new Map<string, string>();
  const sideByGroupId = new Map<string, "buy" | "sell" | "short" | "cover" | undefined>();
  const accountIdByGroupId = new Map<string, string>();
  const runIdByGroupId = new Map<string, string>();

  // Helper to extract symbol and side from a proposal lookup
  const lookupProposalInfo = (proposalId: string) => {
    if (input.getProposalById) {
      const lookup = input.getProposalById(proposalId);
      if (lookup?.proposal) {
        return {
          symbol: normalizeSymbol(lookup.proposal.symbol),
          side: normalizeSide(lookup.proposal.side)
        };
      }
    }
    return {};
  };

  // 1. Process Audit Events
  for (const event of input.audit) {
    if (event.kind === "notification") {
      continue;
    }

    const payload = asRecord(event.payload);
    const proposalId = getProposalIdFromAudit(event);

    let symbol = normalizeSymbol(stringValue(payload.symbol));
    let side = normalizeSide(stringValue(payload.side));

    if (proposalId) {
      const pInfo = lookupProposalInfo(proposalId);
      if (pInfo.symbol) symbol = pInfo.symbol;
      if (pInfo.side) side = pInfo.side;
    }

    const companyName = symbol ? symbolMetaBySymbol[symbol]?.companyName : undefined;
    const feed = formatAuditEvent(event.kind, payload, { symbol, side, companyName });

    const subEvent: UnifiedActivitySubEvent = {
      id: event.id,
      createdAt: event.createdAt,
      type: "audit",
      title: feed.title,
      detail: feed.detail,
      fullText: feed.fullText ?? feed.detail,
      raw: { kind: event.kind }
    };

    // Run-scoped events (run completed / rationale diversity / candidates considered /
    // signal snapshot / llm steps) consolidate into ONE `run-<runId>` group instead of
    // one card each (#8). Everything else without a proposal stays its own group.
    const groupId = proposalId ? `prop-${proposalId}` : runGroupIdForAudit(event.kind, payload) ?? `audit-${event.id}`;
    if (proposalId) {
      proposalIdByGroupId.set(groupId, proposalId);
    }
    if (symbol) symbolByGroupId.set(groupId, symbol);
    if (side) sideByGroupId.set(groupId, side);
    if (event.connectedAccountId) accountIdByGroupId.set(groupId, event.connectedAccountId);
    const auditRunId = stringValue(payload.runId);
    if (auditRunId) runIdByGroupId.set(groupId, auditRunId);

    // P3 #1: Coalesce consecutive identical audit events (feed storm resilience)
    const existingGroup = groupEvents[groupId];
    const lastSubEvent = existingGroup ? existingGroup[existingGroup.length - 1] : undefined;
    if (
      lastSubEvent &&
      lastSubEvent.type === "audit" &&
      (lastSubEvent.raw as any)?.kind === event.kind &&
      lastSubEvent.detail === feed.detail
    ) {
      lastSubEvent.count = (lastSubEvent.count ?? 1) + 1;
      // Bring timestamp forward to most recent
      lastSubEvent.createdAt = event.createdAt;
      lastSubEvent.id = event.id;
    } else {
      addSubEvent(groupId, subEvent);
    }
  }

  // 2. Process Notification Events
  for (const event of input.notifications) {
    const payload = asRecord(event.payload);
    const proposalId = getProposalIdFromNotification(event);

    const display = formatNotificationDisplay(event, symbolMetaBySymbol);

    let symbol = normalizeSymbol(display.symbol);
    let side = normalizeSide(stringValue(asRecord(payload.fill).side) ?? stringValue(asRecord(payload.proposal).side));

    if (proposalId) {
      const pInfo = lookupProposalInfo(proposalId);
      if (pInfo.symbol) symbol = pInfo.symbol;
      if (pInfo.side) side = pInfo.side;
    }

    const subEvent: UnifiedActivitySubEvent = {
      id: event.id,
      createdAt: event.createdAt,
      type: "notification",
      title: display.title,
      detail: display.detail,
      status: event.status,
      error: event.error,
      raw: event.payload
    };

    // Precedence: proposal group > run group > standalone. Run-scoped alerts ("Sell MU blocked",
    // "run failed", "Red Team routed to human") carry a runId in their payload — folding them into
    // the run card removes the 2-3 sibling rows that always appeared next to every run entry.
    const notifRunId = stringValue(payload.runId);
    const groupId = proposalId ? `prop-${proposalId}` : notifRunId ? `run-${notifRunId}` : `notif-${event.id}`;
    if (proposalId) {
      proposalIdByGroupId.set(groupId, proposalId);
    }
    if (symbol) symbolByGroupId.set(groupId, symbol);
    if (side) sideByGroupId.set(groupId, side);
    if (notifRunId) runIdByGroupId.set(groupId, notifRunId);
    // Notifications are USER-wide rows: carry their account attribution onto the group so
    // another account's proposal/fill alerts can be filtered out of this account's feed (#10).
    if (event.connectedAccountId) accountIdByGroupId.set(groupId, event.connectedAccountId);

    addSubEvent(groupId, subEvent);
  }

  // 3. Process Fill Events
  for (const fill of input.fills) {
    const proposalId = fill.proposalId ?? undefined;
    const symbol = normalizeSymbol(fill.symbol);
    const side = normalizeSide(fill.side);

    const formattedQty = formatQuantity(fill.quantity, symbol);
    const subEvent: UnifiedActivitySubEvent = {
      id: fill.id,
      createdAt: fill.filledAt,
      type: "fill",
      title: `${fill.source === "paper" ? "Paper " : ""}${fill.side.toUpperCase()} ${fill.symbol}`,
      detail: fill.status === "pending_reconciliation"
        ? `${formattedQty} shares reviewed @ ${trimCurrency(fill.price)} · broker order pending execution`
        : `${formattedQty} shares @ ${trimCurrency(fill.price)} · ${feedStatusLabel(fill.status)}`,
      status: fill.status,
      raw: fill.raw
    };

    const groupId = proposalId ? `prop-${proposalId}` : `fill-${fill.id}`;
    if (proposalId) {
      proposalIdByGroupId.set(groupId, proposalId);
    }
    if (symbol) symbolByGroupId.set(groupId, symbol);
    if (side) sideByGroupId.set(groupId, side);
    if (fill.runId) runIdByGroupId.set(groupId, fill.runId);

    addSubEvent(groupId, subEvent);
  }

  // 4. Process Broker Orders
  for (const order of input.orders) {
    const proposalId = proposalIdByOrderId[order.id];
    const symbol = normalizeSymbol(order.symbol);
    const side = normalizeSide(order.side);

    const formattedFilled = formatQuantity(order.filledQuantity, symbol);
    const formattedTotal = formatQuantity(order.quantity, symbol);
    const subEvent: UnifiedActivitySubEvent = {
      id: order.id,
      createdAt: order.createdAt,
      type: "order",
      title: brokerOrderTitle(order),
      detail: `Broker state: ${readableBrokerState(order.state)} · Qty ${formattedFilled} / ${formattedTotal} · ${feedOrderTypeLabel(order.type)}`,
      status: order.state,
      raw: order
    };

    const groupId = proposalId ? `prop-${proposalId}` : `order-${order.id}`;
    if (proposalId) {
      proposalIdByGroupId.set(groupId, proposalId);
    }
    if (symbol) symbolByGroupId.set(groupId, symbol);
    if (side) sideByGroupId.set(groupId, side);

    addSubEvent(groupId, subEvent);
  }

  // Pre-insert receipt fold (#2553b): the strategy loop generates a working proposal id up
  // front, emits per-proposal receipts against it (quote-staleness warnings, escalation audits),
  // and then REGENERATES the id just before persisting the row in several branches
  // (src/lib/strategy.ts). Those pre-insert receipts carry a proposalId that never lands in
  // trade_proposals, so one action used to render as TWO sibling rows — the persisted "BUY X"
  // group plus a side-less orphan "TRADE X" group. Fold each orphan prop group (its proposalId
  // does not resolve) into the persisted proposal group for the same run + symbol; every receipt
  // survives as a sub-event of the one merged row. Orphans holding fill/order events are real
  // money receipts and are never folded away.
  if (input.getProposalById) {
    const resolvedGroupByRunSymbol = new Map<string, string>();
    const groupIds = Object.keys(groupEvents);
    for (const groupId of groupIds) {
      const pid = proposalIdByGroupId.get(groupId);
      if (!pid || !input.getProposalById(pid)) continue;
      const runId = runIdByGroupId.get(groupId);
      const symbol = symbolByGroupId.get(groupId);
      if (!runId || !symbol) continue;
      const key = `${runId}|${symbol}`;
      if (!resolvedGroupByRunSymbol.has(key)) resolvedGroupByRunSymbol.set(key, groupId);
    }
    for (const groupId of groupIds) {
      const pid = proposalIdByGroupId.get(groupId);
      if (!pid || input.getProposalById(pid)) continue;
      const events = groupEvents[groupId];
      if (!events || events.some((ev) => ev.type === "fill" || ev.type === "order")) continue;
      const runId = runIdByGroupId.get(groupId);
      const symbol = symbolByGroupId.get(groupId);
      if (!runId || !symbol) continue;
      const target = resolvedGroupByRunSymbol.get(`${runId}|${symbol}`);
      if (!target || target === groupId) continue;
      groupEvents[target]!.push(...events);
      delete groupEvents[groupId];
      proposalIdByGroupId.delete(groupId);
      symbolByGroupId.delete(groupId);
      sideByGroupId.delete(groupId);
      accountIdByGroupId.delete(groupId);
      runIdByGroupId.delete(groupId);
    }
  }

  const unifiedGroups: UnifiedActivityGroup[] = [];

  for (const [groupId, events] of Object.entries(groupEvents)) {
    events.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const earliestDate = events[0]!.createdAt;
    const latestDate = events[events.length - 1]!.createdAt;

    const proposalId = proposalIdByGroupId.get(groupId);
    const symbol = symbolByGroupId.get(groupId);
    const side = sideByGroupId.get(groupId);
    const companyName = symbol ? symbolMetaBySymbol[symbol]?.companyName : undefined;
    const connectedAccountId = accountIdByGroupId.get(groupId);
    let accountLabel = connectedAccountId ? accountLabelById[connectedAccountId] : undefined;

    const tagsSet = new Set<string>();
    for (const ev of events) {
      if (ev.count && ev.count > 1) {
        ev.title = `${ev.title} (x${ev.count})`;
      }
      if (ev.type === "audit") {
        const rawAud = asRecord(ev.raw);
        const audKind = stringValue(rawAud.kind) ?? "";
        if (!accountLabel && KNOWN_GLOBAL_AUDIT_KINDS.has(audKind)) {
          accountLabel = "System-wide";
        }
        if (audKind === "policy_change" || audKind === "profile_change") {
          tagsSet.add("policy change");
        }
        if (audKind === "fill_reconciled") {
          tagsSet.add("trade");
        }
        if (audKind === "post_mortem_reflection") {
          tagsSet.add("post mortem");
        }
      }
      if (ev.type === "fill") {
        tagsSet.add("trade");
      }
      if (ev.type === "notification") {
        const nStatus = ev.status;
        if (nStatus === "sent") {
          tagsSet.add("notification sent");
        } else if (nStatus === "failed") {
          tagsSet.add("notification failed");
        } else if (nStatus === "skipped") {
          tagsSet.add("notification disabled");
        }
        const nRaw = asRecord(ev.raw);
        if (stringValue(nRaw.type) === "fill") {
          tagsSet.add("trade");
        }
      }
    }

    if (side === "buy") { tagsSet.add("buy"); tagsSet.add("trade"); }
    if (side === "sell") { tagsSet.add("sell"); tagsSet.add("trade"); }

    let status = "unknown";
    let title = "";
    let detail = "";

    if (proposalId) {
      const hasFill = events.find(ev => ev.type === "fill");
      const hasOrder = events.find(ev => ev.type === "order") as UnifiedActivitySubEvent | undefined;
      const hasApproval = events.find(ev => ev.type === "audit" && ev.title.includes("Approved"));
      const hasBrokerRejection = events.find(ev => ev.type === "audit" && asRecord(ev.raw).kind === "order_rejected_by_broker");
      const hasRejection = events.find(ev => ev.type === "audit" && ev.title.includes("Rejected"));
      const hasBlock = events.find(ev => ev.type === "notification" && ev.title.includes("Blocked"));
      const hasPendingApproval = events.find(ev => ev.type === "notification" && ev.title.includes("Approval Pending"));
      const order = hasOrder?.raw as EquityOrder | undefined;

      if (hasFill) {
        if (hasFill.status === "filled") {
          status = "filled";
        } else if (hasFill.status === "pending_reconciliation") {
          status = "pending_order";
        } else if (order?.state === "filled") {
          status = "filled";
        } else if (order?.state === "partially_filled") {
          status = "partially_filled";
        } else if (isTerminalBrokerState(order?.state)) {
          status = order!.state;
        } else if (isPendingBrokerState(order?.state) || hasFill.status === "pending_reconciliation") {
          status = "pending_order";
        } else {
          status = hasFill.status ?? "pending_order";
        }
      } else if (order?.state === "filled") {
        status = "filled";
      } else if (order?.state === "partially_filled") {
        status = "partially_filled";
      } else if (isTerminalBrokerState(order?.state)) {
        status = order!.state;
      } else if (isPendingBrokerState(order?.state)) {
        status = "pending_order";
      } else if (hasBrokerRejection) {
        status = "rejected";
      } else if (hasRejection) {
        status = "rejected";
      } else if (hasApproval) {
        status = "approved";
      } else if (hasBlock) {
        status = "blocked";
      } else if (hasPendingApproval) {
        status = "pending_approval";
      } else {
        status = "pending";
      }

      // An account is an account: a fill's own `source` ("paper"/"live", stamped at the FillEvent
      // level — see "Process Fill Events" above) is the sole signal for whether this group is a
      // broker-paper trade. It is never rewritten to "Test" — that execution mode no longer exists,
      // and broker-paper is not "the same as Test", it is a real broker-hosted sandbox account.
      const isPaper = events.some(ev => ev.type === "fill" && ev.title.startsWith("Paper "));

      // Group title mirrors the broker-style fill/order title casing (uppercase side),
      // distinct from the title-case used by individual notification/audit sub-events.
      const displaySide =
        side === "buy" ? "BUY" : side === "sell" ? "SELL" : side === "short" ? "SHORT" : side === "cover" ? "COVER" : "TRADE";
      title = `${isPaper ? "Paper " : ""}${displaySide} ${symbol}`;

      if (status === "filled") {

        const fillEv = events.find(ev => ev.type === "fill" && ev.status === "filled")!;
        detail = fillEv.detail;
      } else if (status === "pending_reconciliation") {
        const fillEv = events.find(ev => ev.type === "fill")!;
        detail = `Pending Broker Order: ${fillEv.detail}`;
      } else if ((hasFill || hasOrder) && (status === "pending_order" || status === "partially_filled" || isTerminalBrokerState(status))) {
        detail = brokerOrderDetail(order, hasFill?.status);
      } else if (status === "rejected" && hasBrokerRejection) {
        detail = hasBrokerRejection.detail;
      } else if (status === "rejected") {
        detail = "Rejected manually";
      } else if (status === "approved") {
        const appEv = events.find(ev => ev.type === "audit" && ev.title.includes("Approved"))!;
        detail = appEv.detail;
      } else if (status === "blocked") {
        const blkEv = events.find(ev => ev.type === "notification" && ev.title.includes("Blocked"))!;
        detail = blkEv.detail;
      } else if (status === "pending_approval") {
        detail = "Awaiting Approval";
      } else {
        detail = events[0]!.detail;
      }
    } else if (groupId.startsWith("run-")) {
      // Consolidated strategy-run card (#8): the strategy_run event is the primary
      // (title + summary rendered ONCE); diversity/candidates/signal-snapshot rows
      // stay visible as sub-rows. Falls back to the first event if the run summary
      // audit aged out of the window.
      const primary = events.find(
        (ev) => ev.type === "audit" && stringValue(asRecord(ev.raw).kind) === "strategy_run"
      );
      const anchor = primary ?? events[0]!;
      title = anchor.title;
      detail = anchor.detail;
      status = primary ? (primary.title.toLowerCase().includes("failed") ? "failed" : "completed") : events[0]!.status ?? "completed";
    } else {
      title = events[0]!.title;
      detail = events[0]!.detail;
      // Audit rows carry no status of their own; the old blanket "completed" default
      // painted a green chip on rows literally titled "Market scan failed". Derive
      // failure from the title when the event has no explicit status. A settings/preference
      // log entry (STATUS_LESS_AUDIT_KINDS) isn't a lifecycle action either way, so it gets no
      // chip at all rather than a fabricated "Completed".
      const soleAuditKind =
        events[0]!.type === "audit" ? stringValue(asRecord(events[0]!.raw).kind) ?? "" : "";
      status =
        events[0]!.status ??
        (STATUS_LESS_AUDIT_KINDS.has(soleAuditKind)
          ? ""
          : title.toLowerCase().includes("failed") || title.toLowerCase().includes("error")
            ? "failed"
            : "completed");
    }
    // Single-event groups surface the sub-event's fullText (e.g. an ops event's raw
    // JSON payload) so the client can offer a raw-data toggle; grouped cards keep the
    // summary as fullText.
    const groupFullText = proposalId || groupId.startsWith("run-") ? detail : events[0]!.fullText ?? detail;

    // Tags are ONLY what the events themselves earned. Two removed forcing blocks used
    // to blanket-push "notification failed" onto every non-policy group and a "paper"
    // tag onto EVERY group ("Live is not tested yet") — fabricated labels on real data,
    // which the product rules forbid (never mislabel real activity).
    const tagsList = Array.from(tagsSet);

    unifiedGroups.push({
      id: groupId,
      proposalId,
      createdAt: earliestDate,
      updatedAt: latestDate,
      symbol,
      side,
      companyName,
      title,
      detail,
      fullText: groupFullText,
      status,
      tags: tagsList,
      events,
      connectedAccountId,
      accountLabel
    });
  }

  // Bound the shipped payload WITHOUT changing observable output.
  const sorted = unifiedGroups.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  // Feed-storm coalescing: merge adjacent identical proposal-less groups
  const coalesced: UnifiedActivityGroup[] = [];
  for (const group of sorted) {
    const prev = coalesced[coalesced.length - 1];
    if (
      prev &&
      !prev.proposalId &&
      !group.proposalId &&
      prev.title === group.title &&
      prev.status === group.status &&
      prev.accountLabel === group.accountLabel &&
      Math.abs(new Date(prev.updatedAt).getTime() - new Date(group.updatedAt).getTime()) < 24 * 60 * 60 * 1000
    ) {
      prev.count = (prev.count || 1) + 1;
      prev.events.push(...group.events);
    } else {
      coalesced.push(group);
    }
  }

  for (const group of coalesced) {
    if (group.count && group.count > 1) {
      group.title = `${group.title} (x${group.count})`;
    }
  }

  const withProposal = coalesced.filter((g) => g.proposalId);
  const withoutProposal = coalesced.filter((g) => !g.proposalId).slice(0, UNIFIED_FEED_MAX_GROUPS);
  return [...withProposal, ...withoutProposal].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function getProposalIdFromAudit(event: SourceAuditEvent): string | undefined {
  const payload = asRecord(event.payload);
  const nested = asRecord(payload.payload);
  return (
    stringValue(payload.proposalId) ??
    stringValue(nested.proposalId)
  );
}

function getProposalIdFromNotification(event: NotificationEvent): string | undefined {
  const payload = asRecord(event.payload);
  const fill = asRecord(payload.fill);
  const proposal = asRecord(payload.proposal);
  return (
    stringValue(payload.proposalId) ??
    stringValue(fill.proposalId) ??
    stringValue(proposal.id) ??
    stringValue(proposal.proposalId)
  );
}
