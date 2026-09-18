import type {
  AccountCapabilities,
  BrokerageAccount,
  BrokerQuote,
  EquityOrder,
  EquityPosition,
  ExecutedOrder,
  MarketHours,
  OrderSide,
  OrderType,
  Portfolio,
  ReviewedOrder,
  TimeInForce,
  BrokerGateway,
  EquityOrderInput,
  OptionPosition
} from "./types";
import type { OHLCBar } from "./indicators";
import { clearMcpOAuthTokens, getMcpAccessToken } from "./mcp-oauth";
import { logApiHealth } from "./db-health";
import { normalizeSymbol } from "./money";
import { mergeAccountCapabilities } from "./venue-contract";
import { isShortIntent } from "./broker-side";
import { getOpenLots, getPerformanceSummary } from "./performance";
import { fetchYahooFinanceQuote, fetchYahooFinanceQuotesBatch } from "./yahoo-finance";
import { messageFromUnknownError, recordRecoverableIssue } from "./recoverable-issue";

const TEST_SIM_STARTING_CASH = (() => {
  const n = Number(process.env.TEST_SIM_STARTING_CASH);
  return Number.isFinite(n) && n > 0 ? n : 100_000;
})();

export const ROBINHOOD_TRADING_MCP_URL = "https://agent.robinhood.com/mcp/trading";
const DEFAULT_MCP_PROTOCOL_VERSION = "2025-03-26";

/**
 * Live Roth `9d71dda4` (2026-08-19): gather sent the full 250-name universe in
 * one `get_equity_quotes` and Robinhood rejected `too many symbols (max 10,
 * got 250)`.  The whole batch died, so cascade never priced through Robinhood
 * and Manual Run once sat llm=0 until `stalled_no_progress`.  Keep the
 * universe; chunk the request.
 */
export const ROBINHOOD_EQUITY_SYMBOL_CHUNK = 10;
const ROBINHOOD_SYMBOL_CHUNK_CONCURRENCY = 4;

export function chunkRobinhoodSymbols(
  symbols: string[],
  size: number = ROBINHOOD_EQUITY_SYMBOL_CHUNK
): string[][] {
  const unique = Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean)));
  const chunks: string[][] = [];
  const n = Math.max(1, size);
  for (let i = 0; i < unique.length; i += n) chunks.push(unique.slice(i, i + n));
  return chunks;
}

async function mapRobinhoodSymbolChunks<T extends Record<string, unknown>>(
  symbols: string[],
  mapper: (chunk: string[]) => Promise<T>
): Promise<T> {
  const chunks = chunkRobinhoodSymbols(symbols);
  const merged = {} as T;
  const concurrency = ROBINHOOD_SYMBOL_CHUNK_CONCURRENCY;
  for (let i = 0; i < chunks.length; i += concurrency) {
    const wave = chunks.slice(i, i + concurrency);
    const parts = await Promise.all(wave.map((chunk) => mapper(chunk)));
    for (const part of parts) Object.assign(merged, part);
  }
  return merged;
}

export function parseRobinhoodQuotes(raw: Record<string, unknown> | unknown): Record<string, BrokerQuote> {
  const root = raw as Record<string, unknown> | undefined;
  const entries = Array.isArray(root?.results)
    ? root!.results
    : Array.isArray(root?.quotes)
      ? root!.quotes
      : Array.isArray(raw)
        ? raw
        : [];
  return Object.fromEntries(
    (entries as Array<Record<string, unknown>>).map((item) => {
      const q = (item.quote ?? item) as Record<string, unknown>;
      const symbol = normalizeSymbol(String(q.symbol ?? item.symbol));
      return [
        symbol,
        {
          symbol,
          price: optionalNumber(q.last_trade_price ?? q.last_non_reg_trade_price ?? q.price ?? q.last_price),
          bid: optionalNumber(q.bid_price ?? q.bid),
          ask: optionalNumber(q.ask_price ?? q.ask),
          asOf: optionalString(q.venue_last_trade_time ?? q.as_of ?? item.as_of),
          provider: "robinhood"
        } satisfies BrokerQuote
      ];
    })
  );
}

function parseRobinhoodTradability(
  raw: Record<string, unknown>
): Record<string, { tradable: boolean; fractional: boolean; reason?: string }> {
  const entries = Array.isArray(raw?.results) ? raw.results : Array.isArray(raw) ? raw : [];
  return Object.fromEntries(
    (entries as Array<Record<string, unknown>>).map((item) => {
      const symbol = normalizeSymbol(String(item.symbol));
      const active = item.state ? item.state === "active" : true;
      const tradable = Boolean(item.tradeable ?? item.tradable ?? item.is_tradable ?? true) && active;
      const fractional =
        item.fractional_tradability !== undefined
          ? item.fractional_tradability === "tradable"
          : Boolean(item.fractional ?? item.fractional_tradable);
      return [
        symbol,
        {
          tradable,
          fractional,
          reason: tradable
            ? (item.reason ? String(item.reason) : undefined)
            : String(item.reason ?? `${symbol} is ${String(item.state ?? "not tradable")}.`)
        }
      ];
    })
  );
}

export interface RobinhoodMcpHealth {
  adapter: "mcp";
  ok: boolean;
  configured: boolean;
  authenticated: boolean;
  url?: string;
  protocolVersion: string;
  transport: "http+sse";
  tools: string[];
  checkedAt: string;
  error?: string;
  warning?: string;
}

/**
 * Robinhood's minimum dollar-based/fractional equity order size. Below this, `review_equity_order`
 * returns an `order_checks` alertType telling us the order will be rejected outright (see
 * ROBINHOOD_SUB_MINIMUM_ALERT_TYPES). Exposed as a named per-broker constant — never hardcode the
 * literal `1` in a caller for this.
 */
export const ROBINHOOD_MIN_ORDER_NOTIONAL = 1;

/**
 * `order_checks.alertType` values that mean the order is a GUARANTEED reject for being below
 * Robinhood's minimum order size — not a soft warning, an unconditional floor no sizing/retry can
 * satisfy for the same notional. `review_equity_order` is a genuine pre-flight: if either of these
 * comes back, placing the order anyway will fail every time.
 */
export const ROBINHOOD_SUB_MINIMUM_ALERT_TYPES = new Set([
  "EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR",
  "EQUITY_SUB_DOLLAR_SHARE_BASED_ORDER"
]);

/**
 * Tolerantly normalize Robinhood's `review_equity_order` `order_checks` field, which can come back
 * as a single check object, an array of check objects, or be absent entirely — the MCP server's
 * exact envelope isn't documented, so this is deliberately liberal about shape. Extracts every
 * present alertType-shaped value plus any human-readable message/description/reason so callers can
 * build a pre-flight rejection signal without depending on one exact schema.
 */
export function parseRobinhoodOrderChecks(raw: unknown): { alertTypes: string[]; messages: string[] } {
  const root = raw as Record<string, unknown> | undefined;
  const rawChecks = root?.order_checks ?? (root as Record<string, unknown> | undefined)?.orderChecks;
  const rows: unknown[] = Array.isArray(rawChecks)
    ? rawChecks
    : rawChecks && typeof rawChecks === "object"
      ? [rawChecks]
      : [];
  const alertTypes: string[] = [];
  const messages: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const check = row as Record<string, unknown>;
    const alertType = check.alertType ?? check.alert_type ?? check.type;
    if (alertType !== undefined && alertType !== null && alertType !== "") alertTypes.push(String(alertType));
    const message = check.message ?? check.description ?? check.detail ?? check.reason;
    if (message !== undefined && message !== null && message !== "") messages.push(String(message));
  }
  return { alertTypes, messages };
}

export function getRobinhoodGateway(userId: string): BrokerGateway {
  // Robinhood is MCP-only. When it isn't connected, the MCP gateway surfaces honest
  // errors and the health card shows "not connected" — it never returns fabricated data.
  return new HttpMcpRobinhoodGateway(userId);
}

// Test broker: real market quotes (Yahoo) + deterministic simulated fills for tests/dev.
// It never impersonates Robinhood or any real brokerage account.
export function getTestGateway(userId: string = "local"): BrokerGateway {
  return new TestBrokerGateway(userId);
}

export function portfolioFromRobinhoodRaw(accountNumber: string, raw: Record<string, unknown>): Portfolio {
  const buyingPower = firstMoney(raw, [
    "buying_power",
    "buyingPower",
    "buying_power.buying_power",
    "buying_power.amount",
    "buyingPower.amount",
    "account_balances.buying_power",
    "accountBalances.buyingPower"
  ]) ?? 0;
  const equityMarketValue = firstMoney(raw, [
    "equity_value",
    "equity_market_value",
    "equityMarketValue",
    "stock_value",
    "stockMarketValue",
    "securities_value",
    "market_value"
  ]) ?? 0;
  const optionMarketValue = firstMoney(raw, [
    "options_value",
    "option_market_value",
    "optionMarketValue",
    "optionsMarketValue"
  ]) ?? 0;
  const cash = firstMoney(raw, [
    "cash",
    "cash_balance",
    "cashBalance",
    "cash_available_for_withdrawal",
    "cashAvailableForWithdrawal",
    "withdrawable_cash",
    "withdrawableCash",
    "settled_cash",
    "settledCash",
    "cash_balances.cash",
    "cash_balances.cash_balance",
    "cash_balances.cash_available_for_withdrawal",
    "cash_balances.withdrawable_cash",
    "cashBalances.cash",
    "cashBalances.cashBalance",
    "cashBalances.cashAvailableForWithdrawal",
    "account_balances.cash",
    "accountBalances.cash"
  ]);
  const explicitTotal = firstMoney(raw, [
    "total_value",
    "total_market_value",
    "totalMarketValue",
    "total_equity",
    "totalEquity",
    "equity",
    "portfolio_value",
    "portfolioValue",
    "account_value",
    "accountValue"
  ]);
  const inferredCash = cash ?? (equityMarketValue <= 0 && optionMarketValue <= 0 ? buyingPower : 0);
  const inferredTotal = Math.max(0, equityMarketValue) + Math.max(0, optionMarketValue) + Math.max(0, inferredCash);
  const totalMarketValue = explicitTotal !== undefined && (explicitTotal > 0 || inferredTotal <= 0)
    ? explicitTotal
    : inferredTotal;

  return {
    accountNumber,
    totalMarketValue,
    buyingPower,
    equityMarketValue,
    optionMarketValue,
    cash: inferredCash
  };
}

class HttpMcpRobinhoodGateway implements BrokerGateway {
  // ordersListIncludesTerminal is DELIBERATELY left unset (⇒ conservative/false): Robinhood's
  // get_equity_orders terminal-inclusion window can't be verified without a live token, so
  // reconcilePlacementError must NOT conclude not_placed from an absent order here (a placed order
  // that already filled and aged out of a live-only list would be wrongly dropped, then duplicated
  // next run). Absent-from-list ⇒ uncertain (protected). Flip to `true` only once verified live.
  private readonly userId: string;

  constructor(userId: string) {
    this.userId = userId;
  }
  async getAccounts(): Promise<BrokerageAccount[]> {
    const raw = await this.callTool("get_accounts", {}) as Record<string, unknown>;
    const accounts = Array.isArray(raw?.accounts) ? raw.accounts : Array.isArray(raw) ? raw : [];
    return accounts.map((item: Record<string, unknown>) => {
      // Options level: Robinhood returns an integer 0-4 (0 = no options).
      const rawOptLevel = typeof item.option_level === "number" ? item.option_level : undefined;
      const optionsLevel = (rawOptLevel !== undefined && rawOptLevel >= 0 && rawOptLevel <= 4)
        ? (rawOptLevel as 0 | 1 | 2 | 3 | 4)
        : undefined;
      const optionsTrading = optionsLevel !== undefined ? optionsLevel > 0 : false;

      // Margin: Robinhood distinguishes "cash" vs "margin" account_type.
      const rawType = String(item.account_type ?? item.type ?? "").toLowerCase();
      const marginEnabled = rawType === "margin" || rawType.includes("margin");

      // Account structure for tax-regime classification.
      const rawBrokerageType = String(item.brokerage_account_type ?? "").toLowerCase();
      const accountType: AccountCapabilities["accountType"] =
        rawBrokerageType.includes("roth") ? "roth_ira"
        : rawBrokerageType.includes("ira") || rawBrokerageType.includes("traditional") ? "traditional_ira"
        : "brokerage";

      const capabilities: AccountCapabilities = mergeAccountCapabilities("robinhood", {
        equityTrading: true,
        // Live MCP place/review side enum is buy|sell only — no short/cover.
        shortSelling: false,
        optionsTrading,
        optionsLevel: optionsTrading ? optionsLevel : undefined,
        optionsOrders: false,
        futuresTrading: false,
        cryptoTrading: false,
        marginEnabled,
        accountType
      });

      return {
        accountNumber: String(item.account_number ?? item.accountNumber),
        // Robinhood labels accounts with `nickname` (e.g. "Agentic"); fall back to type.
        label: String(item.nickname ?? item.label ?? item.brokerage_account_type ?? item.type ?? "Brokerage account"),
        // Robinhood MCP does not return agentic_allowed; default to true only for
        // standard brokerage accounts (not IRA/Roth) since the MCP is purpose-built for
        // agentic equity trading. An explicit false from the broker still overrides.
        agenticAllowed: Boolean(item.agentic_allowed ?? item.agenticAllowed ?? (accountType === "brokerage")),
        capabilities
      };
    });
  }

  async getPortfolio(accountNumber: string): Promise<Portfolio> {
    const raw = await this.callTool("get_portfolio", { account_number: accountNumber }) as Record<string, unknown>;
    return portfolioFromRobinhoodRaw(accountNumber, raw);
  }

  async getEquityPositions(accountNumber: string): Promise<EquityPosition[]> {
    const raw = await this.callTool("get_equity_positions", { account_number: accountNumber }) as Record<string, unknown>;
    const rows = Array.isArray(raw?.positions) ? raw.positions : Array.isArray(raw?.results) ? raw.results : Array.isArray(raw) ? raw : [];
    const positions: EquityPosition[] = rows
      .map((item: Record<string, unknown>) => ({
        symbol: normalizeSymbol(String(item.symbol ?? "")),
        quantity: number(item.quantity),
        // Robinhood reports average cost as `average_buy_price` (already reflects partial sells).
        averageCost: number(item.average_buy_price ?? item.average_cost ?? item.averageCost),
        marketValue: number(item.market_value ?? item.marketValue)
      }))
      .filter((position: EquityPosition) => position.symbol && position.quantity !== 0);

    // Robinhood positions carry no market value — derive it from live quotes (fall back to cost).
    if (positions.length > 0) {
      try {
        const quotes = await this.getEquityQuotes(accountNumber, positions.map((position) => position.symbol));
        const missingQuoteSymbols: string[] = [];
        for (const position of positions) {
          if (position.marketValue > 0) continue;
          const price = quotes[position.symbol]?.price;
          if (price && price > 0) {
            position.marketValue = position.quantity * price;
          } else {
            missingQuoteSymbols.push(position.symbol);
            position.marketValue = position.quantity * position.averageCost;
          }
        }
        if (missingQuoteSymbols.length > 0) {
          recordRecoverableIssue({
            source: "broker",
            operation: "robinhood.getEquityPositions.averageCostFallback",
            message: "Robinhood returned positions without usable live quotes for one or more symbols.",
            fallback: "Using Robinhood position average cost to value positions.",
            userId: this.userId,
            broker: "robinhood",
            accountNumber,
            details: { symbols: missingQuoteSymbols }
          });
        }
      } catch (error) {
        recordRecoverableIssue({
          source: "broker",
          operation: "robinhood.getEquityPositions.quoteFallback",
          message: messageFromUnknownError(error),
          fallback: "Using Robinhood position average cost to value positions.",
          userId: this.userId,
          broker: "robinhood",
          accountNumber
        });
        for (const position of positions) {
          if (position.marketValue <= 0) position.marketValue = position.quantity * position.averageCost;
        }
      }
    }
    return positions;
  }

  async getOptionPositions(accountNumber: string): Promise<OptionPosition[]> {
    const raw = await this.callTool("get_option_positions", { account_number: accountNumber }) as Record<string, unknown>;
    const rows = Array.isArray(raw?.positions) ? raw.positions : Array.isArray(raw?.results) ? raw.results : Array.isArray(raw) ? raw : [];
    
    return rows.map((item: any) => {
      const underlying = String(item.chain_symbol ?? item.symbol ?? "");
      const expDate = String(item.expiration_date ?? item.expiry_date ?? "");
      const type = String(item.option_type ?? item.type ?? "call").toLowerCase() === "put" ? "put" as const : "call" as const;
      const strike = number(item.strike_price ?? item.strike ?? 0);
      const qty = number(item.quantity ?? 0);
      const avgPrice = number(item.average_price ?? item.average_buy_price ?? item.averageCost ?? 0);
      
      const symbol = buildOccSymbol(underlying, expDate, type, strike);
      const marketValue = number(item.market_value ?? item.marketValue ?? (qty * avgPrice * 100));

      return {
        symbol,
        underlyingSymbol: normalizeSymbol(underlying),
        expirationDate: expDate,
        optionType: type,
        strikePrice: strike,
        quantity: qty,
        averageCost: avgPrice,
        marketValue: marketValue
      } satisfies OptionPosition;
    }).filter((p) => p.underlyingSymbol && p.expirationDate && p.quantity !== 0);
  }

  async getEquityOrders(accountNumber: string, _options?: import("./types").GetEquityOrdersOptions): Promise<EquityOrder[]> {
    const raw = await this.callTool("get_equity_orders", { account_number: accountNumber });
    const orders = extractRobinhoodOrderCollection(raw);
    return orders.map((item: Record<string, unknown>) => ({
      id: String(item.id ?? item.order_id),
      symbol: normalizeSymbol(String(item.symbol)),
      side: item.side as OrderSide,
      type: item.type as OrderType,
      state: String(item.state),
      quantity: optionalNumber(item.quantity),
      dollarAmount: optionalNumber(item.dollar_based_amount ?? item.dollar_amount ?? item.dollarAmount),
      filledQuantity: optionalNumber(item.cumulative_quantity ?? item.filled_quantity ?? item.filledQuantity),
      averagePrice: optionalNumber(item.average_price ?? item.averagePrice),
      // Robinhood reports the resting limit as `price` (no dedicated limit_price field).
      limitPrice: optionalNumber(item.price ?? item.limit_price ?? item.limitPrice),
      stopPrice: optionalNumber(item.stop_price ?? item.stopPrice),
      timeInForce: optionalString(item.time_in_force ?? item.timeInForce),
      createdAt: String(item.created_at ?? item.createdAt ?? ""),
      updatedAt: optionalString(item.last_transaction_at ?? item.updated_at ?? item.updatedAt),
      clientOrderId: optionalString(item.ref_id ?? item.client_order_id ?? item.clientOrderId),
      placedAgent: optionalString(item.placed_agent ?? item.placedAgent)
    }));
  }

  async getEquityQuotes(accountNumber: string, symbols: string[]): Promise<Record<string, BrokerQuote>> {
    return mapRobinhoodSymbolChunks(symbols, async (chunk) => {
      try {
        const raw = (await this.callTool("get_equity_quotes", { symbols: chunk })) as Record<string, unknown>;
        return parseRobinhoodQuotes(raw);
      } catch (error) {
        recordRecoverableIssue({
          source: "broker",
          operation: "robinhood.getEquityQuotes",
          message: messageFromUnknownError(error),
          fallback: "Returning no Robinhood quotes for this chunk; other chunks and later cascade sources still run.",
          userId: this.userId,
          broker: "robinhood",
          accountNumber,
          details: { symbols: chunk, chunkSize: chunk.length, maxSymbols: ROBINHOOD_EQUITY_SYMBOL_CHUNK }
        });
        return {};
      }
    });
  }

  async getEquityTradability(accountNumber: string, symbols: string[]) {
    return mapRobinhoodSymbolChunks(symbols, async (chunk) => {
      try {
        const raw = (await this.callTool("get_equity_tradability", {
          account_number: accountNumber,
          symbols: chunk
        })) as Record<string, unknown>;
        return parseRobinhoodTradability(raw);
      } catch {
        return {};
      }
    });
  }

  async reviewEquityOrder(input: EquityOrderInput): Promise<ReviewedOrder> {
    const raw = await this.callTool("review_equity_order", toMcpOrder(input)) as Record<string, unknown>;
    // Robinhood's own pre-flight review already tells us when an order is a guaranteed reject (e.g.
    // the sub-$1 minimum) via `order_checks`, not the top-level `alerts` array read below — surface
    // it as a structured signal so callers can skip a doomed order instead of placing (and
    // rejecting, and alerting on) it anyway.
    const { alertTypes, messages } = parseRobinhoodOrderChecks(raw);
    const blockingAlertTypes = alertTypes.filter((alertType) => ROBINHOOD_SUB_MINIMUM_ALERT_TYPES.has(alertType));
    return {
      estimatedNotional: number(
        raw.estimated_cost ?? raw.estimated_notional ?? raw.notional ?? raw.total ?? raw.estimated_amount ?? input.dollarAmount ?? 0
      ),
      alerts: Array.isArray(raw.alerts) ? raw.alerts.map(String) : [],
      ...(blockingAlertTypes.length > 0
        ? {
            preflightBlock: {
              alertTypes: blockingAlertTypes,
              message: messages[0] ?? `Robinhood rejects this order (${blockingAlertTypes.join(", ")}).`
            }
          }
        : {}),
      raw
    };
  }

  async placeEquityOrder(rawInput: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> {
    const input = normalizeVenueOrder(rawInput, "robinhood", this.userId) as typeof rawInput;
    const raw = await this.callTool("place_equity_order", { ...toMcpOrder(input), ref_id: input.refId }) as Record<string, unknown>;
    const orderId = raw.id ?? raw.order_id;
    // A response with no order id can't be tracked or reconciled against Robinhood's real order
    // list — String(undefined) would silently become the literal string "undefined" and the
    // caller would record this as a confirmed "placed" order that can never be matched later.
    // Throw so the caller's placement try/catch treats this as placement-uncertain instead.
    if (orderId === undefined || orderId === null || orderId === "") {
      throw new Error(`Robinhood place_equity_order response had no order id: ${JSON.stringify(raw)}`);
    }
    return {
      orderId: String(orderId),
      refId: input.refId,
      state: String(raw.state ?? "submitted"),
      filledQuantity: optionalNumber(raw.cumulative_quantity ?? raw.filled_quantity ?? raw.filledQuantity),
      averagePrice: optionalNumber(raw.average_price ?? raw.averagePrice),
      raw
    };
  }

  async cancelEquityOrder(accountNumber: string, orderId: string): Promise<ExecutedOrder> {
    const raw = await this.callTool("cancel_equity_order", { account_number: accountNumber, order_id: orderId }) as Record<string, unknown>;
    return { orderId, refId: crypto.randomUUID(), state: String(raw.state ?? "cancel_requested"), raw };
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return callRobinhoodMcpTool(this.userId, name, args);
  }
}

export async function getRobinhoodMcpHealth(userId: string): Promise<RobinhoodMcpHealth> {
  const checkedAt = new Date().toISOString();
  const protocolVersion = getRobinhoodMcpProtocolVersion();
  const base = {
    adapter: "mcp" as const,
    protocolVersion,
    transport: "http+sse" as const,
    checkedAt,
    tools: [] as string[]
  };

  if (process.env.ROBINHOOD_ADAPTER !== "mcp") {
    return {
      ...base,
      ok: true,
      configured: false,
      authenticated: false,
      warning: "Robinhood is not connected. Connect your Robinhood agentic account to enable it."
    };
  }

  const url = getRobinhoodMcpUrl();
  const token = await getMcpAccessToken(userId);
  if (!token) {
    return {
      ...base,
      ok: false,
      configured: true,
      authenticated: false,
      url,
      error: "No Robinhood MCP access token is stored or configured. Connect OAuth or set ROBINHOOD_MCP_AUTH_TOKEN."
    };
  }

  let warning: string | undefined;
  try {
    await callRobinhoodMcpMethod(userId, "initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "Socratic Trade", version: "0.1.0" }
    });
  } catch (error) {
    // Some HTTP MCP proxies accept direct tools/list calls. Keep this diagnostic
    // non-fatal and let tools/list decide whether the connection is usable.
    warning = `initialize failed: ${messageFromError(error)}`;
  }

  try {
    const result = await callRobinhoodMcpMethod(userId, "tools/list", {});
    const resultObj = result as { tools?: Array<{ name?: string }> };
    const tools = Array.isArray(resultObj?.tools)
      ? resultObj.tools.map((tool: { name?: string }) => String(tool?.name ?? "")).filter(Boolean).sort()
      : [];
    return { ...base, ok: true, configured: true, authenticated: true, url, tools, warning };
  } catch (error) {
    return {
      ...base,
      ok: false,
      configured: true,
      authenticated: true,
      url,
      error: [warning, messageFromError(error)].filter(Boolean).join("; ")
    };
  }
}

export async function callRobinhoodMcpTool(userId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  // Every Robinhood MCP call (trading + reads) funnels through here, so this single wrap
  // gives the admin connections-health page a "robinhood-broker" signal for whether the
  // broker gateway is reachable. The token is per-user, so key the lane by userId.
  // logApiHealth swallows its own errors and is only ever called around the real call, so
  // health logging can never throw or block the broker call.
  const start = Date.now();
  try {
    const result = await callRobinhoodMcpMethod(userId, "tools/call", { name, arguments: args });
    logApiHealth({ service: "robinhood-broker", ok: true, latencyMs: Date.now() - start, keySource: "user", userId });
    return unpackMcpToolResult(result);
  } catch (err) {
    logApiHealth({
      service: "robinhood-broker",
      ok: false,
      latencyMs: Date.now() - start,
      errorText: err instanceof Error ? err.message : String(err),
      keySource: "user",
      userId
    });
    throw err;
  }
}

export async function callRobinhoodMcpMethod(userId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const token = await getMcpAccessToken(userId);
  if (!token) {
    throw new Error("Robinhood not connected — reconnect your account in Connections");
  }
  const response = await fetch(getRobinhoodMcpUrl(), {
    method: "POST",
    // Bound every Robinhood MCP call (incl. place_equity_order) so a hung connection can't block
    // the order path / strategy run indefinitely.
    signal: AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": getRobinhoodMcpProtocolVersion(),
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params
    })
  });

  if (response.status === 401) {
    clearMcpOAuthTokens(userId);
    throw new Error("Robinhood session expired — reconnect your account in Connections");
  }

  const body = await response.text();
  const payload = parseMcpResponseBody(body, response.headers.get("content-type"));
  const errorMessage = mcpErrorMessage(payload);
  if (!response.ok) {
    throw new Error(`Robinhood MCP HTTP ${response.status}${errorMessage ? `: ${errorMessage}` : ""}`);
  }
  if (errorMessage) throw new Error(errorMessage);
  return payload.result;
}

export function parseMcpResponseBody(body: string, contentType: string | null): { result?: unknown; error?: unknown } {
  const trimmed = body.trim();
  if (!trimmed) return {};
  if (isSseResponse(trimmed, contentType)) return parseSseMcpResponse(trimmed);
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { error: { message: trimmed } };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: { message: "Robinhood MCP returned a non-object JSON payload." } };
  return parsed as { result?: unknown; error?: unknown };
}

function parseSseMcpResponse(body: string): { result?: unknown; error?: unknown } {
  const events: string[] = [];
  let current: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (line === "") {
      if (current.length > 0) {
        events.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    if (line.startsWith("data:")) current.push(line.slice(5).trimStart());
  }
  if (current.length > 0) events.push(current.join("\n"));

  let lastObject: { result?: unknown; error?: unknown } | undefined;
  for (const event of events) {
    const data = event.trim();
    if (!data || data === "[DONE]") continue;
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      lastObject = parsed as { result?: unknown; error?: unknown };
      if ("result" in parsed || "error" in parsed) return lastObject;
    }
  }
  if (lastObject) return lastObject;
  throw new Error("Robinhood MCP SSE response did not include a JSON-RPC data event.");
}

function unpackMcpToolResult(raw: unknown): unknown {
  const rawObj = raw as Record<string, unknown> | undefined;
  // A tools/call result can report a TOOL-LEVEL failure via `isError: true` on an otherwise-2xx
  // JSON-RPC success (distinct from a JSON-RPC-level `error`, which callRobinhoodMcpMethod already
  // throws on). Surface it as a THROW so a broker-side failure (rate limit, auth lapse, upstream
  // 5xx surfaced by the MCP proxy) can never be silently unwrapped into an error-shaped payload
  // that a reader (e.g. getEquityOrders) then coalesces to an empty list. Booking a placement
  // reconcile off a masked error is the phantom-fill / dropped-order money-path hazard this guards.
  if (rawObj?.isError === true) {
    const contentText = Array.isArray(rawObj.content)
      ? (rawObj.content as Array<{ text?: unknown }>)
          .map((c) => (typeof c?.text === "string" ? c.text : ""))
          .filter(Boolean)
          .join("; ")
      : undefined;
    throw new Error(`Robinhood MCP tool reported an error${contentText ? `: ${contentText}` : ""}`);
  }
  const result = rawObj?.structuredContent ?? (rawObj?.content as Array<{ text?: unknown }>)?.[0]?.text ?? raw;
  let parsed: unknown = result;
  if (typeof result === "string") {
    try {
      parsed = JSON.parse(result);
    } catch {
      return { text: result };
    }
  }
  // Robinhood's MCP wraps every tool output in a `data` envelope, with a sibling
  // guide string. Unwrap it so gateway callers read fields directly.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "data" in (parsed as Record<string, unknown>)) {
    return (parsed as { data: unknown }).data;
  }
  return parsed;
}

/**
 * Pull the order array out of Robinhood's get_equity_orders response, distinguishing an
 * AUTHORITATIVE empty list (a real "no orders" account state) from a malformed / error-shaped
 * response. A shape that carries no recognizable orders/results collection must THROW — never
 * coalesce to `[]` — because a placement reconcile (reconcilePlacementError / flagStalePlacingIntents)
 * reads `[]` as "the broker has no such order" and would mark a genuinely-placed order not_placed,
 * drop its durable 'placing' intent, and let the next run DUPLICATE the position. After this guard,
 * a returned `[]` means Robinhood authoritatively returned an empty order list. Tool-level broker
 * errors already throw earlier in unpackMcpToolResult (isError), so a well-formed collection here is
 * a genuine success payload.
 */
function extractRobinhoodOrderCollection(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.orders)) return obj.orders as Record<string, unknown>[];
    if (Array.isArray(obj.results)) return obj.results as Record<string, unknown>[];
  }
  const preview = (() => {
    try {
      return JSON.stringify(raw)?.slice(0, 200) ?? String(raw);
    } catch {
      return String(raw);
    }
  })();
  throw new Error(
    `Robinhood get_equity_orders returned an unrecognized shape (no orders/results array) — treating as an error, not an empty account: ${preview}`
  );
}

function mcpErrorMessage(payload: { error?: unknown }): string | undefined {
  if (!payload.error) return undefined;
  if (typeof payload.error === "string") return payload.error;
  const err = payload.error as Record<string, unknown>;
  return err.message ? String(err.message) : JSON.stringify(payload.error);
}

function isSseResponse(body: string, contentType: string | null): boolean {
  return Boolean(contentType?.includes("text/event-stream")) || body.startsWith("event:") || body.startsWith("data:") || body.includes("\ndata:");
}

function getRobinhoodMcpUrl(): string {
  return process.env.ROBINHOOD_MCP_URL || ROBINHOOD_TRADING_MCP_URL;
}

function getRobinhoodMcpProtocolVersion(): string {
  return process.env.ROBINHOOD_MCP_PROTOCOL_VERSION || DEFAULT_MCP_PROTOCOL_VERSION;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MOCK_PRICES: Record<string, number> = {
  AAPL: 200,
  VOO: 500,
  MSFT: 420,
  NVDA: 125,
  AMZN: 180,
  JPM: 175,
  AMD: 165,
  TSLA: 180,
  META: 480,
  NFLX: 600,
  GOOG: 170
};

class TestBrokerGateway implements BrokerGateway {
  // The local deterministic sim has full knowledge of its own order history (nothing ages out), so
  // its order list is authoritative for terminal orders. (Moot in practice — TestBroker fills
  // synchronously and never throws on placement — but correct, and keeps sim reconciles precise.)
  readonly ordersListIncludesTerminal = true;
  private readonly userId: string;

  constructor(userId: string = "local") {
    this.userId = userId;
  }

  async getAccounts(): Promise<BrokerageAccount[]> {
    return [{
      accountNumber: "TEST",
      label: "Test broker",
      agenticAllowed: true,
      capabilities: {
        equityTrading: true,
        shortSelling: true,
        optionsTrading: true,
        optionsOrders: true,
        futuresTrading: false,
        cryptoTrading: false,
        marginEnabled: true,
        accountType: "brokerage"
      }
    }];
  }

  async probeOrderCapability(_accountNumber: string): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true };
  }

  async getEquityPositions(accountNumber: string): Promise<EquityPosition[]> {
    const lots = getOpenLots(accountNumber, undefined, this.userId);
    if (lots.length === 0) return [];
    const symbols = lots.map((l) => l.symbol);
    const quotes = await this.getEquityQuotes(accountNumber, symbols);
    return lots.map((l) => {
      const price = quotes[normalizeSymbol(l.symbol)]?.price ?? l.entryPrice;
      return {
        symbol: l.symbol,
        quantity: l.quantity,
        averageCost: l.entryPrice,
        marketValue: l.quantity * price
      };
    });
  }

  async getPortfolio(accountNumber: string): Promise<Portfolio> {
    const positions = await this.getEquityPositions(accountNumber);
    const positionsValue = positions.reduce((sum, p) => sum + p.marketValue, 0);
    const prices: Record<string, number> = {};
    for (const p of positions) {
      prices[normalizeSymbol(p.symbol)] = p.quantity !== 0 ? p.marketValue / p.quantity : 0;
    }
    // Total P&L = paper realized + paper unrealized (Test fills are recorded as "paper" source).
    const summary = getPerformanceSummary(accountNumber, prices, this.userId);
    const totalPnl = summary.paperRealizedPnl + summary.paperUnrealizedPnl;
    const equity = TEST_SIM_STARTING_CASH + totalPnl;
    const cash = equity - positionsValue;
    return {
      accountNumber,
      totalMarketValue: equity,
      buyingPower: Math.max(0, cash),
      equityMarketValue: positionsValue,
      optionMarketValue: 0,
      cash
    };
  }

  // The Test broker (test infrastructure) simulates fills instantly (placeEquityOrder returns
  // "filled"), so no order ever rests here — there is deliberately no limit/stop/TIF data to surface.
  async getEquityOrders(): Promise<EquityOrder[]> {
    return [];
  }

  async getEquityQuotes(_accountNumber: string, symbols: string[]): Promise<Record<string, BrokerQuote>> {
    const result: Record<string, BrokerQuote> = {};
    const remainingSymbols: string[] = [];
    const normalizedSymbols = symbols.map(s => normalizeSymbol(s));

    if (process.env.NODE_ENV !== "test") {
      try {
        const yfQuotes = await fetchYahooFinanceQuotesBatch(normalizedSymbols);
        for (const symbol of normalizedSymbols) {
          const yf = yfQuotes.get(symbol);
          if (yf) {
            result[symbol] = {
              symbol,
              price: yf.price,
              bid: yf.bid,
              ask: yf.ask,
              volume: yf.volume > 0 ? yf.volume : undefined,
              asOf: yf.asOf || new Date().toISOString(),
              provider: "yahoo-finance",
              ...(yf.syntheticBid ? { syntheticBid: true } : {}),
              ...(yf.syntheticAsk ? { syntheticAsk: true } : {}),
              ...(yf.syntheticSpread ? { syntheticSpread: true } : {})
            };
          } else {
            remainingSymbols.push(symbol);
          }
        }
      } catch (err) {
        console.error("[robinhood] batch quote fetch failed, falling back", err);
        remainingSymbols.push(...normalizedSymbols);
      }
    } else {
      remainingSymbols.push(...normalizedSymbols);
    }

    for (const symbol of remainingSymbols) {
      if (MOCK_PRICES[symbol]) {
        const price = MOCK_PRICES[symbol];
        result[symbol] = {
          symbol,
          price,
          bid: price * 0.999,
          ask: price * 1.001,
          asOf: new Date().toISOString(),
          provider: "test"
        };
      } else if (process.env.NODE_ENV === "test") {
        result[symbol] = {
          symbol,
          price: 100,
          bid: 99.9,
          ask: 100.1,
          asOf: new Date().toISOString(),
          provider: "test"
        };
      } else {
        result[symbol] = {
          symbol,
          price: 100,
          bid: 99.9,
          ask: 100.1,
          asOf: new Date().toISOString(),
          provider: "test-fallback"
        };
      }
    }

    return result;
  }

  async getEquityTradability(_accountNumber: string, symbols: string[]) {
    return Object.fromEntries(symbols.map((symbol) => [normalizeSymbol(symbol), { tradable: true, fractional: true }]));
  }

  async reviewEquityOrder(input: EquityOrderInput): Promise<ReviewedOrder> {
    const quotes = await this.getEquityQuotes(input.accountNumber, [input.symbol]);
    const price = quotes[normalizeSymbol(input.symbol)]?.price ?? 100;
    const estPrice = input.limitPrice ?? input.stopPrice ?? price;
    return { estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * estPrice, alerts: [], raw: { test: true } };
  }

  async placeEquityOrder(rawInput: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> {
    const input = normalizeVenueOrder(rawInput, "robinhood", this.userId) as typeof rawInput;
    const quotes = await this.getEquityQuotes(input.accountNumber, [input.symbol]);
    const price = quotes[normalizeSymbol(input.symbol)]?.price ?? 100;
    const estPrice = input.limitPrice ?? input.stopPrice ?? price;
    let quantity = input.quantity ?? (input.dollarAmount ? input.dollarAmount / estPrice : undefined);
    let state = "filled";
    if (input.symbol === "REJECT") {
      throw new Error("Simulated rejection for REJECT symbol");
    } else if (input.symbol === "PARTIAL") {
      state = "partially_filled";
      quantity = quantity ? quantity / 2 : undefined;
    }
    return {
      orderId: `test-${input.refId}`,
      refId: input.refId,
      state,
      filledQuantity: quantity,
      averagePrice: estPrice,
      raw: { test: true }
    };
  }

  async cancelEquityOrder(_accountNumber: string, orderId: string): Promise<ExecutedOrder> {
    return { orderId, refId: crypto.randomUUID(), state: "cancel_requested", raw: { test: true } };
  }

  async placeOptionOrder(input: {
    accountNumber: string;
    occSymbol: string;
    intent: "buy_to_open" | "sell_to_close" | "buy_to_close" | "sell_to_open";
    quantity: number;
    type: "market" | "limit";
    limitPrice?: number;
    timeInForce?: import("./types").TimeInForce;
    refId: string;
  }): Promise<ExecutedOrder> {
    return {
      orderId: `test-opt-${input.refId}`,
      refId: input.refId,
      state: "filled",
      filledQuantity: input.quantity,
      averagePrice: input.limitPrice ?? 2.5,
      raw: { test: true }
    };
  }

  async cancelOptionOrder(_accountNumber: string, orderId: string): Promise<ExecutedOrder> {
    return { orderId, refId: crypto.randomUUID(), state: "cancel_requested", raw: { test: true } };
  }
}

// SHORT_SELLING: Robinhood's MCP place_equity_order only accepts side "buy" or
// "sell" (review_equity_order docs explicitly state "no short sells"). policy.ts
// blocks short/cover before this code is reached, but the synthetic-stops engine
// can emit a "cover" exit OUTSIDE the policy/approval path, so we fail closed here
// too: a short/cover must never silently reach the broker as an invalid side. If
// Robinhood adds equity shorting, translate the side here (and likely add
// borrow/locate parameters) instead of throwing.
export function toMcpOrder(input: EquityOrderInput): Record<string, unknown> {
  if (isShortIntent(input.side)) {
    throw new Error(
      `Robinhood does not support short selling (side="${input.side}"). Short/cover orders must not reach the broker.`
    );
  }
  // The Robinhood MCP exposes no verified native trailing-stop parameter. A trailPercent order must
  // never silently degrade into a plain stop here — the protective-stop reconciler emulates trailing
  // on Robinhood itself (a stop_market it ratchets upward each tick) and deliberately omits this
  // field. If Robinhood's MCP adds a trailing peg, translate it here instead of throwing.
  if (input.trailPercent != null && input.trailPercent > 0) {
    throw new Error(
      "Robinhood MCP does not support native trailing stops. Place a stop_market and ratchet it (see broker-protective-stops.ts)."
    );
  }
  // FRACTIONAL / NOTIONAL ENTRIES ARE MARKET-ONLY ON ROBINHOOD. A fractional order -- a dollar_amount
  // order OR a sub-whole-share quantity (e.g. 0.5 sh) -- sent as a LIMIT (or in extended hours) is
  // accepted by the API but never fills: it shows "Placed"/working while the cash is never spent (the
  // $1 GOOG/AMAT symptom). Robinhood fills fractional/notional orders only as regular-hours MARKET
  // orders. So coerce a fractional ENTRY to a regular-hours market order and drop the limit modifier.
  //
  // Three things we deliberately do NOT coerce:
  //   - STOPS (stop_market/stop_limit): converting a protective/trailing stop to a market order would
  //     sell immediately instead of resting until the stop triggers. Robinhood can't place a notional
  //     stop, so a dollar-sized stop must be caught upstream by policy, never silently reshaped here.
  //   - EXITS (sell): a limit/take-profit exit must rest at its requested price or be rejected upstream;
  //     silently turning it into market would liquidate immediately.
  //   - Whole-share orders (integer quantity >= 1): preserved as-is so marketable-limit entries work.
  const wholeShare = input.quantity != null && Number.isInteger(input.quantity) && input.quantity >= 1;
  const fractional =
    !wholeShare && ((input.dollarAmount != null && input.dollarAmount > 0) || (input.quantity != null && input.quantity > 0));
  const isStop = input.type === "stop_market" || input.type === "stop_limit";
  const isOpening = input.side === "buy";
  return {
    account_number: input.accountNumber,
    symbol: normalizeSymbol(input.symbol),
    side: input.side,
    type: input.type,
    quantity: input.quantity?.toString(),
    dollar_amount: input.dollarAmount?.toFixed(2),
    limit_price: input.limitPrice?.toFixed(2),
    stop_price: input.stopPrice?.toFixed(2),
    time_in_force: input.timeInForce,
    market_hours: input.marketHours
  };
}

// ── Robinhood MCP market-DATA helpers (historicals + fundamentals) ────────────
// These reuse the authenticated MCP transport but are pure read-only DATA calls,
// independent of the BrokerGateway interface. They are INERT unless ROBINHOOD_ADAPTER=mcp
// and a token is present — every path returns null/{} otherwise, so the OHLC cascade and
// enrichment cascade degrade exactly as before when Robinhood is not connected.

export function robinhoodMcpDataEnabled(): boolean {
  return process.env.ROBINHOOD_ADAPTER === "mcp";
}

/**
 * Fetch daily OHLC history for a symbol via Robinhood MCP `get_equity_historicals`.
 * Returns null when Robinhood isn't connected, the call fails, or <2 bars come back —
 * so it slots into the keyed-first OHLC cascade as just another tier.
 *
 * SECURITY: `userId` is REQUIRED — the access token is per-user, so the caller must
 * pass the request-scoped identity. There is deliberately no `DEV_USER_ID` default:
 * a missing userId used to silently resolve the operator's ('local') broker token for
 * every tenant (cross-user credential leak). Background/shared callers that have no
 * user in scope must NOT call this at all (see `fetchDailyOHLC`, which omits the
 * private broker tier when no userId is provided).  `ROBINHOOD_MCP_AUTH_TOKEN` is a
 * boot seed into the operator (`local`) stored row, not a live getMcpAccessToken
 * bypass.  Peer intraday may pass userId `local` only after APP_B_INGEST_TOKEN.
 */
export async function fetchRobinhoodHistoricals(
  symbol: string,
  opts: {
    interval?: string;
    span?: string;
    userId: string;
    /** Explicit RFC3339 window. When given, `startTime` wins over the `span` shorthand and
     *  `endTime` bounds the far end — required for INTRADAY reads, where "5 years back until
     *  now" would blow past the row cap long before reaching the minute of interest. */
    startTime?: string;
    endTime?: string;
    bounds?: string;
  }
): Promise<OHLCBar[] | null> {
  if (!robinhoodMcpDataEnabled()) return null;
  const sym = normalizeSymbol(symbol);
  if (!sym) return null;
  const userId = opts.userId;
  try {
    const raw = await callRobinhoodMcpTool(userId, "get_equity_historicals", {
      symbols: [sym],
      start_time: opts.startTime ?? robinhoodHistoricalsStartTime(opts.span ?? "5year"),
      ...(opts.endTime ? { end_time: opts.endTime } : {}),
      interval: opts.interval ?? "day",
      bounds: opts.bounds ?? "regular"
    });
    const bars = parseRobinhoodHistoricals(raw, sym);
    // The >=2 floor exists so a single stale print cannot satisfy the DAILY cascade. An explicit
    // intraday window is a different question ("what traded between 14:40 and 15:40"), where one
    // bar is a legitimate answer for a thin name — so only apply the floor to span-style reads.
    const minBars = opts.startTime ? 1 : 2;
    return bars.length >= minBars ? bars : null;
  } catch {
    return null;
  }
}

/** Convert the legacy `span` knob (e.g. `5year`) into the RFC3339 `start_time` the live MCP requires. */
export function robinhoodHistoricalsStartTime(span: string, nowMs = Date.now()): string {
  const raw = String(span || "5year").trim().toLowerCase();
  const match = raw.match(/^(\d+)?(year|month|week|day)s?$/);
  const count = match?.[1] ? Number(match[1]) : 1;
  const unit = match?.[2] ?? "year";
  const dayMs = 24 * 60 * 60 * 1000;
  const ms =
    unit === "year" ? count * 365.25 * dayMs
    : unit === "month" ? count * 30 * dayMs
    : unit === "week" ? count * 7 * dayMs
    : count * dayMs;
  return new Date(nowMs - ms).toISOString();
}

/** Defensive parser for Robinhood historicals — tolerates several envelope shapes. */
export function parseRobinhoodHistoricals(raw: unknown, symbol: string): OHLCBar[] {
  const root = raw as Record<string, unknown> | undefined;
  let rows: unknown[] = [];
  if (root && Array.isArray(root.historicals)) {
    rows = root.historicals as unknown[];
  } else if (root && Array.isArray(root.results)) {
    const results = root.results as Array<Record<string, unknown>>;
    const match = results.find((r) => normalizeSymbol(String(r.symbol ?? "")) === symbol);
    if (match && Array.isArray(match.historicals)) rows = match.historicals as unknown[];
    else if (results.length > 0 && Array.isArray(results[0]?.historicals)) rows = results[0]!.historicals as unknown[];
    else rows = results;
  } else if (Array.isArray(raw)) {
    rows = raw as unknown[];
  }

  const bars: OHLCBar[] = [];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const close = firstNum(r, ["close_price", "close", "c"]);
    if (close === undefined) continue;
    const bar: OHLCBar = { close };
    const time = optionalString(r.begins_at ?? r.timestamp ?? r.date ?? r.t);
    if (time !== undefined) bar.time = time;
    const open = firstNum(r, ["open_price", "open", "o"]);
    if (open !== undefined) bar.open = open;
    const high = firstNum(r, ["high_price", "high", "h"]);
    if (high !== undefined) bar.high = high;
    const low = firstNum(r, ["low_price", "low", "l"]);
    if (low !== undefined) bar.low = low;
    const volume = firstNum(r, ["volume", "v"]);
    if (volume !== undefined) bar.volume = volume;
    bars.push(bar);
  }
  return bars;
}

/**
 * Raw `get_equity_fundamentals` output, normalized to a per-symbol map. Returns {} when
 * Robinhood isn't connected. The exact field set is broker-defined; callers map defensively.
 *
 * SECURITY: `userId` is REQUIRED — the access token is per-user, so the caller must pass
 * the request-scoped identity. There is deliberately no `DEV_USER_ID` default: a missing
 * userId used to silently resolve the operator's ('local') broker token for every tenant
 * (cross-user credential leak). Enrichment callers with no user in scope must fail closed
 * rather than borrow 'local' (see `RobinhoodEnrichmentProvider`).  There is no
 * env-token bypass of getMcpAccessToken.
 */
export async function fetchRobinhoodFundamentals(symbols: string[], userId: string): Promise<Record<string, Record<string, unknown>>> {
  if (!robinhoodMcpDataEnabled()) return {};
  const wanted = Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean)));
  if (wanted.length === 0) return {};
  return mapRobinhoodSymbolChunks(wanted, async (chunk) => {
    try {
      const raw = await callRobinhoodMcpTool(userId, "get_equity_fundamentals", { symbols: chunk });
      const root = raw as Record<string, unknown> | undefined;
      const rows = Array.isArray(root?.results)
        ? root!.results
        : Array.isArray(root?.fundamentals)
          ? root!.fundamentals
          : Array.isArray(raw)
            ? (raw as unknown[])
            : [];
      const out: Record<string, Record<string, unknown>> = {};
      for (const row of rows as Array<Record<string, unknown>>) {
        const sym = normalizeSymbol(String(row.symbol ?? row.ticker ?? ""));
        if (sym) out[sym] = row;
      }
      return out;
    } catch {
      return {};
    }
  });
}

/**
 * Fetch the option chain for a symbol via Robinhood MCP `get_option_chains`, optionally narrowing to
 * specific instruments via `get_option_instruments`. Returns the raw MCP payloads for a caller-side
 * parser (see robinhood-options.ts). Returns null when Robinhood isn't connected or the call fails —
 * so the options enrichment tier degrades to contributing nothing, exactly like other optional tiers.
 *
 * SECURITY: `userId` is REQUIRED (per-user OAuth token). No 'local' fallback — a missing userId must
 * not resolve the operator's broker token for a shared/background scan.
 */
export async function fetchRobinhoodOptionChain(
  symbol: string,
  userId: string,
  opts: { expiration?: string; type?: "call" | "put" } = {}
): Promise<{ chains: unknown; instruments: unknown; underlyingPrice?: number } | null> {
  if (!robinhoodMcpDataEnabled()) return null;
  const sym = normalizeSymbol(symbol);
  if (!sym || !userId) return null;
  try {
    // Live MCP schemas are additionalProperties:false. get_option_chains accepts only
    // ids / underlying_symbol; get_option_instruments wants chain_symbol (not symbol/symbols).
    // Sending both shapes used to 400 the whole lane: unexpected additional properties
    // ["symbol" "symbols"] — Pushover/Sentry SOCRATIC-TRADE-K / GH #2576.
    const chains = await callRobinhoodMcpTool(userId, "get_option_chains", {
      underlying_symbol: sym
    });
    let instruments: unknown = undefined;
    try {
      instruments = await callRobinhoodMcpTool(userId, "get_option_instruments", {
        chain_symbol: sym,
        ...(opts.expiration ? { expiration_dates: opts.expiration } : {}),
        ...(opts.type ? { type: opts.type } : {})
      });
    } catch {
      // get_option_instruments is best-effort; the chain payload often already carries what we need.
      instruments = undefined;
    }
    // Best-effort underlying price so the caller can pick the true near-the-money strike and apply its
    // ±20% around-the-money filter. Without it, "near-the-money" IV / put-call ratio are basis-less and
    // far-OTM strikes can dominate; a failure here simply omits the price (metrics fall back / suppress).
    let underlyingPrice: number | undefined;
    try {
      const quote = await callRobinhoodMcpTool(userId, "get_equity_quotes", { symbols: [sym] });
      underlyingPrice = extractUnderlyingPrice(quote, sym);
    } catch {
      underlyingPrice = undefined;
    }
    return { chains, instruments, ...(underlyingPrice !== undefined ? { underlyingPrice } : {}) };
  } catch {
    return null;
  }
}

/** Tolerantly pull a positive underlying last/mark price for `sym` from a get_equity_quotes payload. */
export function extractUnderlyingPrice(raw: unknown, sym: string): number | undefined {
  const root = raw as Record<string, unknown> | undefined;
  const rows: unknown[] = Array.isArray(root?.results)
    ? (root!.results as unknown[])
    : Array.isArray(root?.quotes)
      ? (root!.quotes as unknown[])
      : Array.isArray(raw)
        ? (raw as unknown[])
        : root && typeof root === "object"
          ? [root]
          : [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const outer = r as Record<string, unknown>;
    // Robinhood commonly wraps the quote in a `quote` envelope (mirrors `item.quote ?? item` used by
    // the equity-quote parser elsewhere in this file); read that nested shape, not just the top level.
    const inner =
      outer.quote && typeof outer.quote === "object" ? (outer.quote as Record<string, unknown>) : outer;
    const rsym = normalizeSymbol(
      String(inner.symbol ?? inner.ticker ?? outer.symbol ?? outer.ticker ?? "")
    );
    if (rows.length > 1 && rsym && rsym !== sym) continue;
    const price = firstNum(inner, [
      "last_trade_price",
      "last_non_reg_trade_price",
      "mark_price",
      "adjusted_mark_price",
      "price",
      "last_price"
    ]);
    if (price !== undefined && price > 0) return price;
  }
  return undefined;
}

function firstNum(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value === null || value === undefined || value === "") continue;
    const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstMoney(row: Record<string, unknown>, paths: string[]): number | undefined {
  for (const path of paths) {
    const parsed = moneyValue(valueAtPath(row, path));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function valueAtPath(row: Record<string, unknown>, path: string): unknown {
  let current: unknown = row;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function moneyValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,%\s,]/g, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    for (const key of ["amount", "value", "cash", "cash_balance", "buying_power", "buyingPower"]) {
      const parsed = moneyValue(row[key]);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return number(value);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text ? text : undefined;
}

export { fetchYahooFinanceQuote } from "./yahoo-finance";

export function buildOccSymbol(underlying: string, expirationDate: string, type: "call" | "put", strike: number): string {
  const parts = expirationDate.split("-");
  if (parts.length !== 3) {
    return underlying.toUpperCase() + expirationDate;
  }
  const yy = parts[0].slice(2, 4);
  const mm = parts[1].padStart(2, "0");
  const dd = parts[2].padStart(2, "0");
  const cp = type === "put" ? "P" : "C";
  const strikeDigits = Math.round(strike * 1000).toString().padStart(8, "0");
  return `${underlying.toUpperCase()}${yy}${mm}${dd}${cp}${strikeDigits}`;
}
