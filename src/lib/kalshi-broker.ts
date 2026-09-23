/**
 * Kalshi broker gateway — implements the BrokerGateway interface for Kalshi
 * event-contract accounts (Demo and Live).
 *
 * Translates portfolio balances, event-contract positions, orders, and market quotes
 * between Socratic-Trade standard account structures and Kalshi trade APIs.
 */

import { audit, getConnectedAccount } from "./db";
import {
  getKalshiConfig,
  kalshiApiBase,
  kalshiAuthHeaders,
  signKalshiRequest,
  type KalshiConfig,
  type KalshiEnv
} from "./kalshi";
import type {
  BrokerageAccount,
  BrokerGateway,
  BrokerQuote,
  EquityOrder,
  EquityOrderInput,
  EquityPosition,
  ExecutedOrder,
  GetEquityOrdersOptions,
  Portfolio,
  ReviewedOrder
} from "./types";
import { knownBrokerLimits, mergeAccountCapabilities } from "./venue-contract-pure";
import { logError, logWarn, recordBrokerCall } from "./sentry-metrics";

const REQUEST_TIMEOUT_MS = 10_000;

export class KalshiBrokerGateway implements BrokerGateway {
  readonly ordersListIncludesTerminal = true;
  private config: KalshiConfig;
  private label: string;
  private environment: KalshiEnv;

  constructor(
    private userId: string,
    private connectedAccountId?: string
  ) {
    const acct = connectedAccountId ? getConnectedAccount(connectedAccountId, userId) : undefined;
    this.environment = acct?.environment === "live" ? "prod" : "demo";
    this.label = acct?.label || (this.environment === "prod" ? "Kalshi Live" : "Kalshi Demo");

    const keyId = acct?.apiKey?.trim() || process.env.KALSHI_API_KEY_ID?.trim();
    const pem = acct?.apiSecret?.replace(/\\n/g, "\n").trim() || process.env.KALSHI_PRIVATE_KEY_PEM?.replace(/\\n/g, "\n").trim();

    this.config = {
      env: this.environment,
      baseUrl: kalshiApiBase(this.environment),
      keyId: keyId || undefined,
      privateKeyPem: pem || undefined
    };
  }

  private async authenticatedFetch<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: Record<string, unknown>
  ): Promise<T | null> {
    const url = `${this.config.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        ...kalshiAuthHeaders(this.config, method, path)
      };

      let reqBody: string | undefined;
      if (body && method === "POST") {
        headers["Content-Type"] = "application/json";
        reqBody = JSON.stringify(body);
      }

      const started = Date.now();
      const res = await fetch(url, {
        method,
        headers,
        body: reqBody,
        cache: "no-store",
        signal: controller.signal
      });

      if (!res.ok) {
        await res.text().catch(() => "");
        recordBrokerCall("kalshi", `${method} ${path}`, Date.now() - started, "failure");
        logWarn("broker.call", { broker: "kalshi", method, path, status: res.status });
        return null;
      }

      recordBrokerCall("kalshi", `${method} ${path}`, Date.now() - started, "success");
      return (await res.json()) as T;
    } catch (err) {
      recordBrokerCall("kalshi", `${method} ${path}`, 0, "failure");
      logError("broker.call", {
        broker: "kalshi",
        method,
        path,
        error: err instanceof Error ? err.message : String(err)
      });
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getAccounts(): Promise<BrokerageAccount[]> {
    const caps = mergeAccountCapabilities("kalshi", { eventContracts: true });
    return [
      {
        accountNumber: this.config.keyId ? `kalshi-${this.config.keyId.slice(0, 8)}` : "kalshi-account",
        label: this.label,
        agenticAllowed: true,
        capabilities: caps
      }
    ];
  }

  async getPortfolio(accountNumber: string): Promise<Portfolio> {
    const balanceData = await this.authenticatedFetch<{ balance?: number; balance_dollars?: string }>(
      "GET",
      "/portfolio/balance"
    );

    let cash = 0;
    if (balanceData?.balance_dollars != null) {
      cash = parseFloat(balanceData.balance_dollars) || 0;
    } else if (balanceData?.balance != null) {
      cash = balanceData.balance / 100;
    } else if (this.environment === "demo" && !this.config.keyId) {
      cash = 10_000; // Standalone demo practice default
    }

    const positions = await this.getEquityPositions(accountNumber);
    const equityMarketValue = positions.reduce((sum, p) => sum + p.marketValue, 0);

    return {
      accountNumber,
      totalMarketValue: cash + equityMarketValue,
      buyingPower: cash,
      equityMarketValue,
      optionMarketValue: 0,
      cash
    };
  }

  async getEquityPositions(_accountNumber: string): Promise<EquityPosition[]> {
    const posData = await this.authenticatedFetch<{
      market_positions?: Array<{
        ticker: string;
        position: number;
        market_exposure?: number;
        market_exposure_dollars?: string;
        realized_pnl?: number;
        total_traded?: number;
        fees_paid?: number;
      }>;
    }>("GET", "/portfolio/positions");

    if (!posData?.market_positions) return [];

    return posData.market_positions
      .filter((p) => p.position !== 0)
      .map((p) => {
        const exposure =
          p.market_exposure_dollars != null
            ? parseFloat(p.market_exposure_dollars) || 0
            : (p.market_exposure ?? 0) / 100;
        const avgCost = p.position !== 0 ? Math.abs(exposure / p.position) : 0.5;

        return {
          symbol: p.ticker,
          quantity: p.position,
          averageCost: avgCost,
          marketValue: exposure,
          sector: "Event Contracts",
          industry: "Kalshi"
        };
      });
  }

  async getEquityOrders(_accountNumber: string, _options?: GetEquityOrdersOptions): Promise<EquityOrder[]> {
    const orderData = await this.authenticatedFetch<{
      orders?: Array<{
        order_id: string;
        client_order_id?: string;
        ticker: string;
        side: "yes" | "no";
        action: "buy" | "sell";
        type: "limit" | "market";
        yes_price?: number;
        no_price?: number;
        yes_price_dollars?: string;
        no_price_dollars?: string;
        count: number;
        status: string;
        created_time: string;
        last_update_time?: string;
      }>;
    }>("GET", "/portfolio/orders");

    if (!orderData?.orders) return [];

    return orderData.orders.map((o) => {
      let limitPrice: number | undefined;
      if (o.side === "yes") {
        limitPrice = o.yes_price_dollars ? parseFloat(o.yes_price_dollars) : o.yes_price ? o.yes_price / 100 : undefined;
      } else {
        limitPrice = o.no_price_dollars ? parseFloat(o.no_price_dollars) : o.no_price ? o.no_price / 100 : undefined;
      }

      return {
        id: o.order_id,
        symbol: o.ticker,
        side: o.action === "buy" ? (o.side === "no" ? "short" : "buy") : (o.side === "no" ? "cover" : "sell"),
        type: o.type === "limit" ? "limit" : "market",
        state: o.status,
        quantity: o.count,
        limitPrice,
        createdAt: o.created_time,
        updatedAt: o.last_update_time,
        clientOrderId: o.client_order_id
      };
    });
  }

  async getEquityQuotes(_accountNumber: string, symbols: string[]): Promise<Record<string, BrokerQuote>> {
    const out: Record<string, BrokerQuote> = {};
    if (symbols.length === 0) return out;

    const marketsData = await this.authenticatedFetch<{
      markets?: Array<{
        ticker: string;
        yes_bid?: number;
        yes_ask?: number;
        last_price?: number;
        yes_bid_dollars?: string;
        yes_ask_dollars?: string;
        last_price_dollars?: string;
        volume_24h_fp?: number;
        open_interest_fp?: number;
        status?: string;
      }>;
    }>("GET", `/markets?tickers=${encodeURIComponent(symbols.join(","))}`);

    if (marketsData?.markets) {
      for (const m of marketsData.markets) {
        const bid = m.yes_bid_dollars ? parseFloat(m.yes_bid_dollars) : m.yes_bid != null ? m.yes_bid / 100 : undefined;
        const ask = m.yes_ask_dollars ? parseFloat(m.yes_ask_dollars) : m.yes_ask != null ? m.yes_ask / 100 : undefined;
        const price = m.last_price_dollars ? parseFloat(m.last_price_dollars) : m.last_price != null ? m.last_price / 100 : ask ?? bid ?? 0.5;

        out[m.ticker] = {
          symbol: m.ticker,
          price,
          bid,
          ask,
          volume: m.volume_24h_fp,
          provider: "kalshi",
          venuePriceAuthoritative: true,
          fetchedAt: new Date().toISOString()
        };
      }
    }

    return out;
  }

  async getEquityTradability(_accountNumber: string, symbols: string[]): Promise<Record<string, { tradable: boolean; fractional: boolean; reason?: string }>> {
    const res: Record<string, { tradable: boolean; fractional: boolean; reason?: string }> = {};
    for (const s of symbols) {
      res[s] = { tradable: true, fractional: false };
    }
    return res;
  }

  async reviewEquityOrder(input: EquityOrderInput): Promise<ReviewedOrder> {
    const count = Math.max(1, Math.round(input.quantity ?? 1));
    const estimatedPrice = input.limitPrice ?? 0.5;
    const estimatedNotional = count * estimatedPrice;

    return {
      estimatedNotional,
      alerts: [],
      raw: { count, estimatedPrice }
    };
  }

  async placeEquityOrder(input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> {
    const count = Math.max(1, Math.round(input.quantity ?? 1));
    const side: "yes" | "no" = input.side === "short" || input.side === "cover" ? "no" : "yes";
    const action: "buy" | "sell" = input.side === "buy" || input.side === "short" ? "buy" : "sell";
    const type = input.type === "limit" ? "limit" : "market";

    const body: Record<string, unknown> = {
      ticker: input.symbol.trim().toUpperCase(),
      side,
      action,
      count,
      type,
      client_order_id: input.refId
    };

    if (type === "limit" && input.limitPrice != null) {
      const priceCents = Math.max(1, Math.min(99, Math.round(input.limitPrice * 100)));
      if (side === "yes") body.yes_price = priceCents;
      else body.no_price = priceCents;
    }

    const orderRes = await this.authenticatedFetch<{ order?: { order_id: string; status: string } }>(
      "POST",
      "/portfolio/orders",
      body
    );

    const orderId = orderRes?.order?.order_id || `kalshi-${Date.now()}`;
    const status = orderRes?.order?.status || "placed";

    audit(
      "kalshi_order_placed",
      {
        orderId,
        refId: input.refId,
        ticker: input.symbol,
        side,
        action,
        count,
        status
      },
      this.userId
    );

    return {
      orderId,
      refId: input.refId,
      state: status,
      filledQuantity: count,
      averagePrice: input.limitPrice ?? 0.5,
      raw: orderRes
    };
  }

  async cancelEquityOrder(_accountNumber: string, orderId: string): Promise<ExecutedOrder> {
    await this.authenticatedFetch("DELETE", `/portfolio/orders/${encodeURIComponent(orderId)}`);

    audit("kalshi_order_cancelled", { orderId }, this.userId);

    return {
      orderId,
      refId: crypto.randomUUID(),
      state: "canceled",
      raw: { orderId }
    };
  }
}

export function getKalshiGateway(userId: string, connectedAccountId?: string): KalshiBrokerGateway {
  return new KalshiBrokerGateway(userId, connectedAccountId);
}
