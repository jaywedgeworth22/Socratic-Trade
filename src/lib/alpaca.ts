import Alpaca from "@alpacahq/alpaca-trade-api";
import crypto from "crypto";
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
  GetEquityOrdersOptions,
  OptionPosition
} from "./types";
import {
  assertOptionOrderInput,
  optionIntentToBrokerSide,
  parseOccSymbol,
  type OptionOrderInput
} from "./option-orders";
import { OrderValidationError } from "./types";
import { fromAlpacaSymbol, normalizeSymbol, roundAlpacaPrice, toAlpacaSymbol } from "./money";
import { mergeAccountCapabilities } from "./venue-contract";
import { toBrokerSide, isRejectedOrCanceledState } from "./broker-side";
import { audit, getActiveConnectedAccount, getConnectedAccount, resolveApiKey } from "./db";
import { logApiHealth } from "./db-health";
import { fetchDailyOHLC } from "./history";
import { isTransientNetworkError } from "./network-errors";
import { SESSION_CLOSE_PROVIDER } from "./quote-delayed-fallback";
import {
  ALPACA_MCP_FETCH_MS,
  alpacaAccountReadBudgetMs,
  awaitWithFirstCallRetry,
  ALPACA_BROKER_IO_DEADLINE_MS,
  EQUITY_QUOTES_MS,
  equityOrdersDefaultSinceIso,
  withDeadline
} from "./inflight-deadline";

/**
 * Fill in a usable price for any symbol the broker didn't quote (>0). Alpaca's latest-quote feed
 * returns 0/empty bid-ask outside market hours and on the free IEX tier, which used to leave the chat
 * with no price and the pre-trade review with a MAX_SAFE_INTEGER "can't size it" sentinel (so even a
 * 0.5-share order tripped every cap). A recent daily close (keyless Yahoo, works anytime) is a fine
 * sizing/notional anchor and lets the assistant answer price questions. Exported for testing.
 */
export async function fillMissingQuotesWithClose(
  quotes: Record<string, BrokerQuote>,
  symbols: string[],
  getFallback: (symbol: string) => Promise<{ price: number; asOf?: string } | undefined>
): Promise<Record<string, BrokerQuote>> {
  const missing = symbols.filter((s) => {
    const q = quotes[s];
    return !(q && typeof q.price === "number" && q.price > 0);
  });
  await Promise.all(
    missing.map(async (symbol) => {
      const fb = await getFallback(symbol).catch(() => undefined);
      if (fb && Number.isFinite(fb.price) && fb.price > 0) {
        quotes[symbol] = {
          symbol,
          price: fb.price,
          asOf: fb.asOf,
          provider: SESSION_CLOSE_PROVIDER,
          fetchedAt: new Date().toISOString()
        };
      }
    })
  );
  return quotes;
}

export function getAlpacaGateway(userId: string = "local", connectedAccountId?: string): BrokerGateway {
  return new AlpacaBrokerGateway(userId, connectedAccountId);
}

/** In-process throttle for order-capability probes. */
const alpacaProbeCache = new Map<string, { at: number; ok: boolean; reason?: string }>();
const ALPACA_PROBE_TTL_MS = 2 * 60_000;

/**
 * Dashboard and strategy both call getAccounts + getPortfolio in Promise.all, and each
 * hits Alpaca getAccount().  Two live-account round-trips routinely blow the dashboard's
 * 6s getAccounts deadline (Roth IRA recoverable_issue storm 2026-08-18) even though the
 * second call is the same account.  Collapse in-flight duplicates and reuse a short TTL
 * so one load / one strategy run pays for one GET /v2/account.
 */
const alpacaAccountCache = new Map<string, { at: number; account: unknown }>();
const alpacaAccountInflight = new Map<string, Promise<unknown>>();
const ALPACA_ACCOUNT_TTL_MS = 15_000;

export function resetAlpacaAccountCacheForTests(): void {
  alpacaAccountCache.clear();
  alpacaAccountInflight.clear();
}

// Re-exported for existing callers/tests that import symbol conversion from this module — the
// canonical definitions now live in ./money alongside normalizeSymbol so data-providers.ts and
// the Alpaca stream workers can share them without importing this (much heavier) gateway module.
export { toAlpacaSymbol, fromAlpacaSymbol };

export function parseAlpacaOptionsLevel(account: Record<string, unknown>): AccountCapabilities["optionsLevel"] {
  const raw = account.options_approved_level ?? account.options_trading_level ?? account.optionsApprovedLevel;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 4) return undefined;
  return n as AccountCapabilities["optionsLevel"];
}

export function classifyAlpacaAccountType(account: Record<string, unknown>): AccountCapabilities["accountType"] {
  const rawType = String(account.account_type ?? account.accountType ?? "").toLowerCase();
  const rawSubType = String(account.account_sub_type ?? account.account_subtype ?? account.accountSubType ?? "").toLowerCase();
  const combined = `${rawType} ${rawSubType}`;
  if (combined.includes("roth")) return "roth_ira";
  if (combined.includes("traditional") || combined.includes("trad") || combined.includes("ira")) return "traditional_ira";
  return "brokerage";
}

/**
 * Estimate an order's notional for the pre-trade review. NEVER fabricates a price:
 * a wrong notional corrupts the value persisted to `trade_proposals` and the daily
 * cap accounting (a fabricated $100 made a $50k buy count as $10k). Prefers explicit
 * order prices, then the live quote; if none is available and there's no dollar
 * amount, an un-sizable OPENING order is reported as over-cap so it is blocked.
 *
 * Side matters. The over-cap sentinel is ONLY valid for opening orders (buy/short) —
 * for those, "no price" means "can't size it, so don't let it through". For an EXIT
 * (sell/cover) the sentinel is actively harmful: exits are never notional-capped, and a
 * MAX_SAFE_INTEGER value corrupts the persisted/displayed notional AND the gross/net
 * exposure projection (a 1-share sell looked like a ~$9 quadrillion short and tripped the
 * net-exposure cap, blocking a risk-reducing exit). So for exits we fall back to the
 * captured entry anchor (`referencePrice`) and, failing that, report 0 — the exit still
 * executes and exposure caps correctly exempt it.
 */
export function estimateReviewNotional(
  input: { side?: OrderSide; dollarAmount?: number; quantity?: number; limitPrice?: number; stopPrice?: number; referencePrice?: number },
  quotePrice: number | undefined
): { estimatedNotional: number; alerts: string[] } {
  if (input.dollarAmount != null) {
    return { estimatedNotional: input.dollarAmount, alerts: [] };
  }
  const isExit = input.side === "sell" || input.side === "cover";
  // Live quote / explicit order price for either side; for an exit, also fall back to the entry anchor
  // so a missing live quote doesn't corrupt the notional (exits aren't capped, so an approximation is fine).
  const estPrice =
    input.limitPrice ??
    input.stopPrice ??
    (quotePrice && quotePrice > 0 ? quotePrice : undefined) ??
    (isExit && input.referencePrice && input.referencePrice > 0 ? input.referencePrice : undefined);
  if (estPrice != null && estPrice > 0) {
    return { estimatedNotional: (input.quantity ?? 0) * estPrice, alerts: [] };
  }
  if (isExit) {
    // Never use the over-cap sentinel for an exit — exits are exempt from notional caps, and a giant value
    // would corrupt the displayed notional and the net/gross exposure projection. 0 is safe and won't block.
    return {
      estimatedNotional: 0,
      alerts: ["Price unavailable — exit notional could not be estimated; exits are not notional-capped, so this does not block the order."],
    };
  }
  return {
    estimatedNotional: Number.MAX_SAFE_INTEGER,
    alerts: ["Price unavailable — notional could not be estimated; treating as over-cap (set a limit/stop price or dollar amount)."],
  };
}

export interface AlpacaTimeInForceResolution {
  timeInForce: "day" | "gtc";
  /** True only when the CALLER asked for "gtc" and this resolved to "day" because of it — the
   *  honest signal for an audit receipt. A caller that already asked for "gfd" isn't "normalized". */
  normalized: boolean;
  reason?: "fractional_quantity" | "notional";
}

/**
 * Alpaca requires time_in_force="day" for any order carrying a fractional share quantity or a
 * notional (dollar) amount — fractional-share trading is day-only regardless of order type
 * (docs.alpaca.markets); a "gtc" on either is a guaranteed 422. Bracket orders already require
 * "day" for an unrelated reason (native OCO leg support). Resolves against the quantity/notional
 * actually being submitted (the caller must resolve any bracket-floor qty first), never the raw
 * proposal, so this can't drift from what really gets sent to the broker. Exported (and called from
 * a single place per order path below) so REST, MCP, and the native-trailing path can't disagree.
 */
export function resolveAlpacaTimeInForce(input: {
  requestedTimeInForce: TimeInForce;
  isBracket: boolean;
  quantity?: number;
  notional?: number;
}): AlpacaTimeInForceResolution {
  const isFractionalQty = input.quantity != null && !Number.isInteger(input.quantity);
  const isNotional = input.notional != null && input.notional > 0;
  const requiresDay = input.isBracket || isFractionalQty || isNotional;
  const timeInForce: "day" | "gtc" = requiresDay || input.requestedTimeInForce === "gfd" ? "day" : "gtc";
  const normalized = input.requestedTimeInForce === "gtc" && (isFractionalQty || isNotional);
  return {
    timeInForce,
    normalized,
    reason: normalized ? (isFractionalQty ? "fractional_quantity" : "notional") : undefined
  };
}

/** Alpaca's wire word for a stop-market is `stop`.  Keep `stop_limit` and everything else as-is. */
export function mapAlpacaOrderTypeWrite(type: OrderType | string): string {
  return type === "stop_market" ? "stop" : String(type);
}

export type McpCallMode = "read" | "write";

/**
 * MCP place/cancel timed out or otherwise failed after the sidecar may already have
 * forwarded the write.  REST-falling-back would be a second send.
 */
export class AlpacaMcpWriteAmbiguousError extends Error {
  readonly code = "ALPACA_MCP_WRITE_AMBIGUOUS" as const;
  constructor(toolName: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Alpaca MCP ${toolName} failed ambiguously; REST write fallback skipped to avoid a double-submit. ${detail}`,
      cause instanceof Error ? { cause } : undefined
    );
    this.name = "AlpacaMcpWriteAmbiguousError";
  }
}

/**
 * REST-fallback is safe for a WRITE only when the sidecar never dispatched the tool
 * (unknown tool / method-not-found / 4xx before send).  Timeouts, aborts, 5xx, 408/409/429,
 * and network errors are ambiguous — the order may already exist at Alpaca.
 */
export function mcpWriteFailureAllowsRestFallback(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  const lower = text.toLowerCase();
  if (
    /-32601\b/.test(lower) ||
    /method not found/.test(lower) ||
    /unknown tool/.test(lower) ||
    /tool not found/.test(lower) ||
    /not implemented/.test(lower)
  ) {
    return true;
  }
  const http = text.match(/alpaca mcp http (\d{3})/i);
  if (http) {
    const status = Number(http[1]);
    return status === 400 || status === 401 || status === 403 || status === 404 || status === 405 || status === 501;
  }
  return false;
}

class AlpacaBrokerGateway implements BrokerGateway {
  // Default getEquityOrders returns open orders plus terminal orders inside a bounded window.
  readonly ordersListIncludesTerminal = true;
  private alpaca: Alpaca;
  private label: string;
  private isMcp: boolean;
  private mcpUrl?: string;
  // Credential lane for health logging: a per-user connected account resolves to "user",
  // the operator env fallback (local only, no stored account) to "env".
  private keySource: string;
  /** Stable per-credential cache key.  Never includes the secret. */
  private accountCacheKey: string;
  private hasRestKeys: boolean;

  constructor(private userId: string, connectedAccountId?: string) {
    const targeted = connectedAccountId ? getConnectedAccount(connectedAccountId, userId) : undefined;
    const activeAccount = getActiveConnectedAccount(userId);
    const brokerAccount = targeted ?? activeAccount;
    const accountKeys =
      brokerAccount?.broker === "alpaca" || brokerAccount?.broker === "alpaca-mcp"
        ? brokerAccount
        : undefined;
    this.keySource = accountKeys ? "user" : "env";
    this.accountCacheKey = `${userId}|${accountKeys?.id ?? connectedAccountId ?? "env"}|${accountKeys?.environment ?? "paper"}`;
    this.isMcp = brokerAccount?.broker === "alpaca-mcp";
    this.label = accountKeys?.label || (accountKeys?.environment === "live" ? "Alpaca Brokerage" : "Alpaca Paper");
    // A connected-account key (per-user account data) wins. If an Alpaca account is explicitly
    // selected, never fall back to generic/operator Alpaca keys: those can belong to a different
    // account and surface as a misleading "Account Mismatch" instead of the real credential problem.
    // SECURITY: route through resolveApiKey so the env fallback is operator-only (alpaca keys are
    // a per-user-only tier). A non-`local` user with no stored key gets "" → broker construction
    // fails loudly instead of silently trading on the operator's Alpaca account via process.env.
    const keyId = accountKeys?.apiKey?.trim() || (!accountKeys ? resolveApiKey("alpaca_paper_api_key", userId) || "" : "");
    const secretKey = accountKeys?.apiSecret?.trim() || (!accountKeys ? resolveApiKey("alpaca_paper_secret_key", userId) || "" : "");
    this.hasRestKeys = !!keyId;

    let baseUrl = accountKeys?.baseUrl?.trim();
    if (this.isMcp) {
      this.mcpUrl = baseUrl || undefined;
    }

    if (accountKeys && !this.isMcp && !keyId) {
      throw new Error(
        `Alpaca credentials are missing for ${this.label}. Open Connections and re-save the API key.`
      );
    }
    if (accountKeys && this.isMcp && !this.mcpUrl && !keyId) {
      throw new Error(
        `Alpaca MCP credentials are missing for ${this.label}. Open Connections and re-save the MCP endpoint or API key.`
      );
    }

    if (baseUrl && !this.isMcp) {
      baseUrl = baseUrl.replace(/\/+$/, "");
      if (baseUrl.toLowerCase().endsWith("/v2")) {
        baseUrl = baseUrl.slice(0, -3);
      }
    }

    const options: any = {
      paper: accountKeys?.environment !== "live",
      usePolygon: false
    };

    if (keyId && !secretKey) {
      options.oauth = keyId;
    } else {
      options.keyId = keyId;
      options.secretKey = secretKey;
    }

    if (baseUrl && !this.isMcp) {
      options.baseUrl = baseUrl;
    }

    this.alpaca = new Alpaca(options);
  }

  // Wrap a raw Alpaca SDK call so the admin connections-health page can show whether the
  // broker gateway itself is reachable ("alpaca-broker"), distinct from the market-data
  // enrichment services. logApiHealth already swallows its own errors, but the timing/log
  // is still wrapped so a health-logging failure can never affect the real broker call.
  // The Alpaca SDK ships no types, so this.alpaca.* calls are already `any`; a constrained
  // generic here would collapse those returns to `unknown` at every call site.
  //
  // `signal` is supplied ONLY by idempotent read paths (getAccount / getPositions /
  // getOrders / getLatestQuotes), which route through awaitWithFirstCallRetry.  It fires when
  // that wrapper has stopped waiting on this attempt — the loser of the first/retry race, or
  // both attempts once the combined budget expires.  Order placement, cancel, and replace
  // deliberately pass no signal, so they can never be abandoned mid-flight (see #2960/#2962).
  private async trackHealth(
    fn: () => Promise<any>,
    opts?: { deadlineMs?: number; retryTransient?: boolean; signal?: AbortSignal }
  ): Promise<any> {
    const start = Date.now();
    // Reads may retry a dead keep-alive socket. createOrder must not: if Alpaca
    // accepted the first POST and the response socket died, a retry with the
    // same client_order_id returns HTTP 409, which the placement catch treated
    // as rejected_by_broker and hid the live order.
    const attempts = opts?.retryTransient === false ? 1 : 2;
    let lastErr: unknown;
    const runOnce = () => {
      const call = fn();
      return opts?.deadlineMs != null
        ? withDeadline(call, opts.deadlineMs, "Alpaca broker call timed out")
        : call;
    };
    for (let attempt = 0; attempt < attempts; attempt++) {
      // The abort can also land during the backoff sleep below — re-check so a cancelled
      // read never opens a second connection.
      if (attempt > 0 && opts?.signal?.aborted) throw lastErr;
      try {
        const result = await runOnce();
        logApiHealth({ service: "alpaca-broker", ok: true, latencyMs: Date.now() - start, keySource: this.keySource, userId: this.userId });
        return result;
      } catch (err) {
        lastErr = err;
        // This attempt was abandoned by our own deadline, not by Alpaca.  Do not spend a
        // fresh connection on work nobody is waiting for, and do not write a broker-failure
        // health row: that row feeds the consecutive-failure streak that auto-halts autonomy,
        // so a slow-but-healthy broker would look like an outage.
        if (opts?.signal?.aborted) throw err;
        // Alpaca's keep-alive pool reuses a socket the origin already closed
        // (UND_ERR_SOCKET / "other side closed").  One retry on a fresh
        // connection recovers the quote/account read; the first miss is not
        // logged so a recovered blip cannot feed the consecutive-failure streak.
        if (attempt + 1 < attempts && isTransientNetworkError(err)) {
          await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
          continue;
        }
        logApiHealth({
          service: "alpaca-broker",
          ok: false,
          latencyMs: Date.now() - start,
          errorText: err instanceof Error ? err.message : String(err),
          keySource: this.keySource,
          userId: this.userId
        });
        throw err;
      }
    }
    throw lastErr;
  }

  /** Account GET used by getAccounts / getPortfolio.  First wait is above the
   *  live alpaca-broker max (14s).  One fresh retry if that call stays pending.
   *  A thrown credential / 401 is not retried here — trackHealth already retries
   *  UND_ERR_SOCKET. */
  private async readAccount(): Promise<any> {
    const { firstMs, retryMs } = alpacaAccountReadBudgetMs();
    return awaitWithFirstCallRetry(
      ({ signal }) => this.trackHealth(() => this.alpaca.getAccount(), { signal }),
      {
        firstMs,
        retryMs,
        onFinalTimeout: () => {
          throw new Error(`Timed out waiting for alpaca.getAccount after ${firstMs}+${retryMs}ms.`);
        }
      }
    );
  }

  private getAccountCached(): Promise<any> {
    const key = this.accountCacheKey;
    const hit = alpacaAccountCache.get(key);
    if (hit && Date.now() - hit.at < ALPACA_ACCOUNT_TTL_MS) {
      return Promise.resolve(hit.account);
    }
    const pending = alpacaAccountInflight.get(key);
    if (pending) return pending;
    const request = this.readAccount()
      .then((account) => {
        alpacaAccountCache.set(key, { at: Date.now(), account });
        return account;
      })
      .finally(() => {
        alpacaAccountInflight.delete(key);
      });
    alpacaAccountInflight.set(key, request);
    return request;
  }

  private async callMcp<T>(
    toolName: string,
    args: Record<string, unknown>,
    fallbackFn: () => Promise<T>,
    opts?: { mode?: McpCallMode; reconcile?: () => Promise<T | undefined> }
  ): Promise<T> {
    if (!this.isMcp || !this.mcpUrl) {
      return fallbackFn();
    }
    const mode: McpCallMode = opts?.mode ?? "read";
    try {
      const response = await fetch(this.mcpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json"
        },
        signal: AbortSignal.timeout(ALPACA_MCP_FETCH_MS),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args
          }
        })
      });
      if (!response.ok) {
        throw new Error(`Alpaca MCP HTTP ${response.status}`);
      }
      const body = await response.json();
      if (body.error) {
        const code = body.error.code != null ? String(body.error.code) : "";
        const message = body.error.message || JSON.stringify(body.error);
        throw new Error(code ? `Alpaca MCP ${code} ${message}` : message);
      }
      const content = body.result?.content;
      if (Array.isArray(content) && content[0]?.type === "text") {
        try {
          return JSON.parse(content[0].text);
        } catch {
          return content[0].text;
        }
      }
      return body.result;
    } catch (e) {
      const { logWarn, recordBrokerCall } = await import("./sentry-metrics");
      recordBrokerCall("alpaca", `mcp:${toolName}`, 0, "failure");
      logWarn("broker.call", {
        broker: "alpaca",
        endpoint: `mcp:${toolName}`,
        error: e instanceof Error ? e.message : String(e)
      });
      // Reads may always REST-fallback.  Writes fallback only when the sidecar
      // never dispatched the tool; otherwise reconcile by client_order_id / id
      // and refuse a second send.
      if (mode === "read" || mcpWriteFailureAllowsRestFallback(e)) {
        return fallbackFn();
      }
      if (opts?.reconcile) {
        try {
          const recovered = await opts.reconcile();
          if (recovered !== undefined) return recovered;
        } catch (reconcileErr) {
          logWarn("broker.call", {
            broker: "alpaca",
            endpoint: `mcp:${toolName}:reconcile`,
            error: reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr)
          });
        }
      }
      throw new AlpacaMcpWriteAmbiguousError(toolName, e);
    }
  }

  private async fetchAlpacaOrderByClientOrderId(clientOrderId: string): Promise<Record<string, unknown> | undefined> {
    try {
      const raw = await this.trackHealth(
        () => this.alpaca.sendRequest(
          `/orders:by_client_order_id/${encodeURIComponent(clientOrderId)}`,
          null,
          null,
          "GET"
        ),
        { deadlineMs: ALPACA_BROKER_IO_DEADLINE_MS, retryTransient: true }
      );
      if (raw && typeof raw === "object" && (raw as { id?: unknown }).id) {
        return raw as Record<string, unknown>;
      }
      return undefined;
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 404) return undefined;
      const msg = error instanceof Error ? error.message : String(error);
      if (/\b404\b|not found/i.test(msg)) return undefined;
      throw error;
    }
  }

  private async reconcilePlacedOrderByClientOrderId(clientOrderId: string): Promise<ExecutedOrder | undefined> {
    const raw = await this.fetchAlpacaOrderByClientOrderId(clientOrderId);
    if (!raw?.id) return undefined;
    return executedOrderFromRaw(raw, clientOrderId);
  }

  private async reconcileCanceledOrder(orderId: string): Promise<ExecutedOrder | undefined> {
    try {
      const raw = await this.trackHealth(
        () => this.alpaca.getOrder(orderId),
        { deadlineMs: ALPACA_BROKER_IO_DEADLINE_MS, retryTransient: true }
      );
      const state = String(raw?.status ?? "");
      if (isRejectedOrCanceledState(state) || state.toLowerCase() === "filled") {
        return { orderId, refId: crypto.randomUUID(), state: "cancel_requested", raw: raw ?? { reconciled: true } };
      }
      return undefined;
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        return { orderId, refId: crypto.randomUUID(), state: "cancel_requested", raw: { reconciled: true, missing: true } };
      }
      throw error;
    }
  }


  /**
   * Side-effect-free order-path probe via Alpaca account flags (no order submitted).
   * `trading_blocked` / non-ACTIVE status means strategy runs would only mint unplaceable proposals.
   */
  async probeOrderCapability(accountNumber: string): Promise<{ ok: boolean; reason?: string }> {
    const key = `alpaca|${accountNumber}|${this.keySource}`;
    const cached = alpacaProbeCache.get(key);
    if (cached && Date.now() - cached.at < ALPACA_PROBE_TTL_MS) {
      return { ok: cached.ok, reason: cached.reason };
    }
    try {
      const account = await this.getAccountCached();
      if (account && String(account.account_number ?? "") && accountNumber) {
        const live = String(account.account_number).trim().toLowerCase();
        const want = String(accountNumber).trim().toLowerCase();
        if (live && want && live !== want) {
          const reason = `Alpaca credentials are for account ${account.account_number}, not ${accountNumber}`;
          alpacaProbeCache.set(key, { at: Date.now(), ok: false, reason });
          return { ok: false, reason };
        }
      }
      if (account?.trading_blocked === true || account?.account_blocked === true) {
        const reason = "Alpaca reports this account is blocked from trading";
        alpacaProbeCache.set(key, { at: Date.now(), ok: false, reason });
        return { ok: false, reason };
      }
      const status = String(account?.status ?? "").toUpperCase();
      if (status && status !== "ACTIVE") {
        const reason = `Alpaca account status is ${status} (not ACTIVE)`;
        alpacaProbeCache.set(key, { at: Date.now(), ok: false, reason });
        return { ok: false, reason };
      }
      alpacaProbeCache.set(key, { at: Date.now(), ok: true });
      return { ok: true };
    } catch (error) {
      const reason = `Alpaca order capability probe failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 240);
      alpacaProbeCache.set(key, { at: Date.now(), ok: false, reason });
      return { ok: false, reason };
    }
  }

  async getAccounts(): Promise<BrokerageAccount[]> {
    const getCapabilities = (acc: any): AccountCapabilities => {
      const shortSelling = Boolean(acc.shorting_enabled);
      const rawAccountType = String(acc.account_type ?? "").toUpperCase();
      const accountType = classifyAlpacaAccountType(acc);
      const marginEnabled = accountType === "brokerage" && (shortSelling || rawAccountType === "MARGIN");
      const optionsLevel = parseAlpacaOptionsLevel(acc);
      return mergeAccountCapabilities(this.isMcp ? "alpaca-mcp" : "alpaca", {
        equityTrading: true,
        shortSelling,
        optionsTrading: optionsLevel != null ? optionsLevel > 0 : false,
        optionsOrders: optionsLevel != null && optionsLevel >= 2,
        optionsLevel,
        futuresTrading: false,
        cryptoTrading: false,
        marginEnabled,
        accountType
      });
    };

    return this.callMcp<any>("get_account_info", {}, async () => {
      const account = await this.getAccountCached();
      return [
        {
          accountNumber: account.account_number,
          label: this.label,
          agenticAllowed: true,
          capabilities: getCapabilities(account)
        }
      ];
    }).then((res: any) => {
      if (res && res.account_number) {
        return [
          {
            accountNumber: res.account_number,
            label: this.label,
            agenticAllowed: true,
            capabilities: getCapabilities(res)
          }
        ];
      }
      return res;
    });
  }

  async getPortfolio(accountNumber: string): Promise<Portfolio> {
    return this.callMcp<any>("get_account_info", {}, async () => {
      const account = await this.getAccountCached();
      // Alpaca API credentials are scoped to exactly one account, so getAccount() always returns THE
      // account these keys belong to. Only flag a GENUINE cross-account mismatch (both numbers present
      // and actually different, ignoring case/whitespace) — a blank configured number or a mere
      // formatting difference must never block a run. The message is actionable so the operator can
      // correct the stored number in Connections.
      const liveNum = String(account.account_number ?? "").trim();
      const wantNum = String(accountNumber ?? "").trim();
      if (wantNum && liveNum && liveNum.toLowerCase() !== wantNum.toLowerCase()) {
        throw new Error(
          `Account Mismatch: the connected Alpaca credentials are for account ${liveNum}, but this profile is configured for ${wantNum}. Update the account number in Connections.`
        );
      }
      return {
        accountNumber,
        totalMarketValue: number(account.portfolio_value),
        buyingPower: number(account.buying_power),
        equityMarketValue: number(account.equity) - number(account.cash),
        optionMarketValue: 0,
        cash: number(account.cash)
      };
    }).then((res: any) => {
      let result: Portfolio;
      if (res && res.account_number) {
        result = {
          accountNumber,
          totalMarketValue: number(res.portfolio_value),
          buyingPower: number(res.buying_power),
          equityMarketValue: number(res.equity) - number(res.cash),
          optionMarketValue: 0,
          cash: number(res.cash)
        };
      } else {
        result = res;
      }
      return result;
    });
  }

  async getEquityPositions(accountNumber: string): Promise<EquityPosition[]> {
    return this.callMcp<any>("get_positions", {}, async () => {
      const { firstMs, retryMs } = alpacaAccountReadBudgetMs();
      const positions = await awaitWithFirstCallRetry(
        ({ signal }) => this.trackHealth(() => this.alpaca.getPositions(), { signal }),
        {
          firstMs,
          retryMs,
          onFinalTimeout: () => {
            throw new Error(`Timed out waiting for alpaca.getPositions after ${firstMs}+${retryMs}ms.`);
          }
        }
      );
      return positions.map(parseAlpacaPosition);
    }).then((res: any) => {
      if (Array.isArray(res)) {
        return res.map(parseAlpacaPosition);
      }
      return res;
    });
  }

  async getEquityOrders(accountNumber: string, options?: GetEquityOrdersOptions): Promise<EquityOrder[]> {
    if (options?.fullHistory) {
      return this.getEquityOrdersFullHistory(accountNumber);
    }
    const sinceIso = options?.since ?? equityOrdersDefaultSinceIso();
    const sinceMs = Date.parse(sinceIso);
    // MCP must request status:"all".  status:"open" is live-only, but
    // ordersListIncludesTerminal=true tells reconcilePlacementError that a
    // missing refId means never-placed (safe to retry).  A market fill that
    // leaves "open" before the place deadline returns would then double-submit.
    // REST fallback stays open + closed-since (bounded).
    return this.callMcp<any>("get_orders", { status: "all", limit: 500 }, async () => {
      const open = await this.fetchAlpacaOrderPages({ status: "open" });
      const closed = await this.fetchAlpacaOrderPages({
        status: "closed",
        after: sinceIso,
        stopBeforeMs: Number.isFinite(sinceMs) ? sinceMs : undefined
      });
      const merged = new Map<string, Record<string, unknown>>();
      for (const row of [...open, ...closed]) merged.set(String(row.id), row);
      return Array.from(merged.values());
    }).then((res: any) => (Array.isArray(res) ? res.map((o: any) => mapAlpacaOrder(o as Record<string, unknown>)) : res));
  }

  /** Legacy full-history walk — explicit opt-in via GetEquityOrdersOptions.fullHistory. */
  private async getEquityOrdersFullHistory(accountNumber: string): Promise<EquityOrder[]> {
    return this.callMcp<any>("get_orders", { status: "all", limit: 500 }, async () => {
      const all = await this.fetchAlpacaOrderPages({ status: "all" });
      return all;
    }).then((res: any) => (Array.isArray(res) ? res.map((o: any) => mapAlpacaOrder(o as Record<string, unknown>)) : res));
  }

  private async fetchAlpacaOrderPages(params: {
    status: "open" | "closed" | "all";
    after?: string;
    until?: string;
    stopBeforeMs?: number;
  }): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const PAGE = 500;
    let until: string | undefined = params.until;
    for (let guard = 0; guard < 50; guard++) {
      const { firstMs, retryMs } = alpacaAccountReadBudgetMs();
      const page = (await awaitWithFirstCallRetry(
        ({ signal }) => this.trackHealth(() => this.alpaca.getOrders({
          status: params.status,
          limit: PAGE,
          direction: "desc",
          ...(params.after ? { after: params.after } : {}),
          ...(until ? { until } : {})
        } as Parameters<typeof this.alpaca.getOrders>[0]), { signal }),
        {
          firstMs,
          retryMs,
          onFinalTimeout: () => {
            throw new Error(`Timed out waiting for alpaca.getOrders after ${firstMs}+${retryMs}ms.`);
          }
        }
      )) as Record<string, unknown>[];
      if (!Array.isArray(page) || page.length === 0) break;
      let added = 0;
      let oldest: string | undefined;
      let oldestMs = Number.POSITIVE_INFINITY;
      for (const o of page) {
        const id = String(o.id);
        const createdAt = String(o.created_at);
        const createdMs = Date.parse(createdAt);
        if (!seen.has(id)) {
          seen.add(id);
          all.push(o);
          added += 1;
        }
        if (!oldest || createdAt < oldest) oldest = createdAt;
        if (Number.isFinite(createdMs)) oldestMs = Math.min(oldestMs, createdMs);
      }
      if (params.stopBeforeMs != null && oldestMs < params.stopBeforeMs) break;
      if (page.length < PAGE || added === 0 || !oldest || oldest === until) break;
      until = oldest;
    }
    return all;
  }

  async getEquityQuotes(accountNumber: string, symbols: string[]): Promise<Record<string, BrokerQuote>> {
    // Standard quotes method: fall back to REST directly to avoid multi-ticker latency
    const aliasesByCanonical = new Map<string, Set<string>>();
    for (const rawSymbol of symbols) {
      const requested = normalizeSymbol(rawSymbol);
      const canonical = fromAlpacaSymbol(toAlpacaSymbol(requested));
      if (!canonical) continue;
      const aliases = aliasesByCanonical.get(canonical) ?? new Set<string>();
      aliases.add(canonical);
      if (requested) aliases.add(requested);
      aliasesByCanonical.set(canonical, aliases);
    }
    const normalizedSymbols = Array.from(aliasesByCanonical.keys());
    const quotes: Record<string, BrokerQuote> = {};
    try {
      const { firstMs, retryMs } = alpacaAccountReadBudgetMs();
      const response = await awaitWithFirstCallRetry(
        ({ signal }) => this.trackHealth(
          () => this.alpaca.getLatestQuotes(normalizedSymbols.map(toAlpacaSymbol)),
          { deadlineMs: ALPACA_BROKER_IO_DEADLINE_MS, signal }
        ),
        {
          firstMs: EQUITY_QUOTES_MS,
          retryMs,
          onFinalTimeout: () => {
            throw new Error(`Timed out waiting for alpaca.getLatestQuotes after ${firstMs}+${retryMs}ms.`);
          }
        }
      );
      for (const [rawSymbol, q] of Object.entries(response)) {
        const symbol = fromAlpacaSymbol(rawSymbol);
        const anyQ = q as Record<string, number | string>;
        const bid = optionalNumber(anyQ.bp);
        const ask = optionalNumber(anyQ.ap);
        quotes[symbol] = {
          symbol,
          price: ask ?? bid ?? 0,
          bid,
          ask,
          asOf: optionalIso(anyQ.t),
          provider: "alpaca",
          fetchedAt: new Date().toISOString()
        };
      }
    } catch (error) {
      // Don't fail silently — a swallowed quote error is what makes the review fall through to an
      // unusable price. Surface it; the keyless fallback below still tries to price the symbols.
      console.warn(`[alpaca] getLatestQuotes failed for ${normalizedSymbols.join(",")}:`, error instanceof Error ? error.message : error);
    }
    // Keyless market-data fallback for any symbol the broker left unpriced (0/empty bid-ask — common
    // outside market hours and on the free IEX tier). A recent daily close keeps the chat quote and
    // the pre-trade notional review usable instead of failing closed to the over-cap sentinel.
    await fillMissingQuotesWithClose(quotes, normalizedSymbols, async (symbol) => {
      const bars = await fetchDailyOHLC(symbol, Date.now(), this.userId);
      const last = bars && bars.length ? bars[bars.length - 1] : undefined;
      return last && typeof last.close === "number" ? { price: last.close, asOf: last.time != null ? String(last.time) : undefined } : undefined;
    });
    for (const [canonical, aliases] of aliasesByCanonical) {
      const quote = quotes[canonical];
      if (!quote) continue;
      for (const alias of aliases) {
        if (!quotes[alias]) quotes[alias] = { ...quote, symbol: alias };
      }
    }
    return quotes;
  }

  async getEquityTradability(accountNumber: string, symbols: string[]) {
    return Object.fromEntries(symbols.map((symbol) => [normalizeSymbol(symbol), { tradable: true, fractional: true }]));
  }

  async reviewEquityOrder(input: EquityOrderInput): Promise<ReviewedOrder> {
    const quotes = await this.getEquityQuotes(input.accountNumber, [input.symbol]);
    const quotePrice = quotes[normalizeSymbol(input.symbol)]?.price;
    const { estimatedNotional, alerts } = estimateReviewNotional(input, quotePrice);
    return { estimatedNotional, alerts, raw: { alpaca: true } };
  }

  async placeEquityOrder(input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> {
    const isBracket = !!(input.bracketTakeProfit || input.bracketStopLoss);
    const isTrailing = input.trailPercent != null && input.trailPercent > 0;

    // Native trailing stop: Alpaca's `trailing_stop` order type with `trail_percent` — the broker
    // trails the high-water mark itself. Mutually exclusive with brackets (both would claim the
    // same shares), quantity-based only, and Alpaca rejects limit/stop price params on it, so any
    // caller-supplied stopPrice (a ratchet anchor meant for brokers without native trailing) is
    // deliberately dropped.
    if (isTrailing) {
      if (isBracket) {
        throw new OrderValidationError("Alpaca trailing stop cannot carry bracket legs — place one or the other.");
      }
      if (!input.quantity || !(input.quantity > 0)) {
        throw new OrderValidationError("Alpaca trailing stop requires a positive share quantity (no notional trailing stops).");
      }
      const trailingTif = resolveAlpacaTimeInForce({ requestedTimeInForce: input.timeInForce, isBracket: false, quantity: input.quantity });
      if (trailingTif.normalized) {
        audit("alpaca_tif_normalized_to_day", { symbol: input.symbol, side: input.side, requestedTimeInForce: input.timeInForce, reason: trailingTif.reason, quantity: input.quantity }, this.userId);
      }
      try {
        const raw = await this.trackHealth(
          () => this.alpaca.createOrder({
            symbol: toAlpacaSymbol(input.symbol),
            side: toBrokerSide(input.side),
            type: "trailing_stop",
            trail_percent: String(input.trailPercent),
            qty: input.quantity,
            time_in_force: trailingTif.timeInForce,
            client_order_id: input.refId
          }),
          { deadlineMs: ALPACA_BROKER_IO_DEADLINE_MS, retryTransient: false }
        );
        return {
          orderId: raw.id,
          refId: input.refId,
          state: raw.status,
          filledQuantity: optionalNumber(raw.filled_qty),
          averagePrice: optionalNumber(raw.filled_avg_price),
          raw
        };
      } catch (error: unknown) {
        throw new Error(`Alpaca trailing stop order failed: ${formatAlpacaOrderError(error)}`);
      }
    }

    // Alpaca does not support notional (dollar) bracket orders — only qty-based.
    // If a bracketed dollar order reaches this gateway, it must carry a real entry
    // anchor from review/proposal enrichment. Never fall back to 1; that can turn a
    // $500 market bracket into 500 shares.
    let bracketQty: number | undefined;
    if (isBracket && input.dollarAmount && !input.quantity) {
      const estPrice = input.limitPrice ?? input.referencePrice;
      if (estPrice == null || !(estPrice > 0)) {
        throw new OrderValidationError("Alpaca bracket dollar orders require a positive limitPrice or referencePrice.");
      }
      bracketQty = Math.floor(input.dollarAmount / estPrice);
      if (bracketQty < 1) {
        throw new OrderValidationError("Alpaca bracket dollar order is too small for a whole-share bracket at the reference price.");
      }
    }

    // The ACTUAL quantity/notional this order will submit — resolved once (post bracket-floor
    // resolution above) so the REST and MCP paths below, and the tif normalization right after,
    // can't drift from each other or from what really gets sent.
    const effectiveQty = bracketQty ?? (input.quantity || undefined);
    const effectiveNotional = effectiveQty == null && input.dollarAmount && !isBracket ? input.dollarAmount : undefined;
    // Bracket orders require time_in_force="day" (native OCO leg support); independently, Alpaca
    // rejects "gtc" on any fractional-share-quantity or notional (dollar) order — fractional trading
    // is day-only (docs.alpaca.markets). A caller-requested "gtc" (an LLM proposal, or any
    // dollar-routed entry) that would otherwise 422 gets normalized instead of reaching the broker;
    // the original intent is preserved via an audit receipt (Codex review, item 10).
    const tif = resolveAlpacaTimeInForce({
      requestedTimeInForce: input.timeInForce,
      isBracket,
      quantity: effectiveQty,
      notional: effectiveNotional
    });
    if (tif.normalized) {
      audit("alpaca_tif_normalized_to_day", {
        symbol: input.symbol,
        side: input.side,
        requestedTimeInForce: input.timeInForce,
        reason: tif.reason,
        quantity: effectiveQty,
        dollarAmount: effectiveNotional
      }, this.userId);
    }

    const fallbackFn = async () => {
      try {
        const orderOptions: Record<string, unknown> = {
          symbol: toAlpacaSymbol(input.symbol),
          side: toBrokerSide(input.side), // short→sell, cover→buy; Alpaca infers open/close from position
          type: mapAlpacaOrderTypeWrite(input.type),
          time_in_force: tif.timeInForce,
          client_order_id: input.refId
        };

        if (effectiveQty != null) {
          orderOptions.qty = effectiveQty;
        } else if (effectiveNotional != null) {
          orderOptions.notional = effectiveNotional;
        }

        if (input.limitPrice) orderOptions.limit_price = roundAlpacaPrice(input.limitPrice);
        // stop_price is only legal on stop-family order types — Alpaca rejects a limit order that
        // carries one with HTTP 422 40010001 "limit orders require no stop price" (proposals may
        // carry a protective stopPrice idea; that intent rides the bracket stop_loss /
        // protective-stop systems, never this field).
        if (input.stopPrice && (input.type === "stop_market" || input.type === "stop_limit")) {
          orderOptions.stop_price = roundAlpacaPrice(input.stopPrice);
        }
        if (input.marketHours === "extended_hours") orderOptions.extended_hours = true;

        if (isBracket) {
          orderOptions.order_class = "bracket";
          if (input.bracketTakeProfit != null) {
            orderOptions.take_profit = { limit_price: roundAlpacaPrice(input.bracketTakeProfit) };
          }
          if (input.bracketStopLoss != null) {
            orderOptions.stop_loss = {
              stop_price: roundAlpacaPrice(input.bracketStopLoss),
              ...(input.bracketStopLimit != null ? { limit_price: roundAlpacaPrice(input.bracketStopLimit) } : {})
            };
          }
        }

        const raw = await this.trackHealth(
          () => this.alpaca.createOrder(orderOptions),
          { deadlineMs: ALPACA_BROKER_IO_DEADLINE_MS, retryTransient: false }
        );
        return {
          orderId: raw.id,
          refId: input.refId,
          state: raw.status,
          filledQuantity: optionalNumber(raw.filled_qty),
          averagePrice: optionalNumber(raw.filled_avg_price),
          raw
        };
      } catch (error: unknown) {
        throw new Error(`Alpaca order failed: ${formatAlpacaOrderError(error)}`);
      }
    };

    if (!this.isMcp || !this.mcpUrl) {
      return fallbackFn();
    }

    const toolName = input.type === "limit"
      ? "place_limit_order"
      : (input.type === "stop_market" || input.type === "stop_limit")
        ? "place_stop_order"
        : "place_market_order";

    const orderArgs: Record<string, any> = {
      symbol: toAlpacaSymbol(input.symbol),
      side: toBrokerSide(input.side), // short→sell, cover→buy; Alpaca infers open/close from position
      type: mapAlpacaOrderTypeWrite(input.type),
      time_in_force: tif.timeInForce,
      client_order_id: input.refId
    };

    if (effectiveQty != null) orderArgs.qty = String(effectiveQty);
    else if (effectiveNotional != null) orderArgs.notional = String(effectiveNotional);

    if (input.limitPrice) orderArgs.limit_price = String(roundAlpacaPrice(input.limitPrice));
    // Same constraint as the REST path: stop_price only on stop-family types (Alpaca 422s a
    // limit order carrying one).
    if (input.stopPrice && (input.type === "stop_market" || input.type === "stop_limit")) {
      orderArgs.stop_price = String(roundAlpacaPrice(input.stopPrice));
    }

    if (isBracket) {
      orderArgs.order_class = "bracket";
      if (input.bracketTakeProfit != null) {
        orderArgs.take_profit = { limit_price: roundAlpacaPrice(input.bracketTakeProfit) };
      }
      if (input.bracketStopLoss != null) {
        orderArgs.stop_loss = {
          stop_price: roundAlpacaPrice(input.bracketStopLoss),
          ...(input.bracketStopLimit != null ? { limit_price: roundAlpacaPrice(input.bracketStopLimit) } : {})
        };
      }
    }

    return this.callMcp<any>(toolName, orderArgs, fallbackFn, {
      mode: "write",
      reconcile: () => this.reconcilePlacedOrderByClientOrderId(input.refId)
    }).then((res: any) => {
      if (res && res.id) {
        return executedOrderFromRaw(res, input.refId);
      }
      return res;
    });
  }

  async placeOptionOrder(input: OptionOrderInput): Promise<ExecutedOrder> {
    const parsed = parseOccSymbol(input.occSymbol);
    if (!parsed) throw new OrderValidationError("Invalid OCC option symbol.");
    const bad = assertOptionOrderInput(input);
    if (bad) throw new OrderValidationError(bad);
    const symbol = input.occSymbol.trim().toUpperCase().replace(/\s+/g, "");
    try {
      const raw = await this.trackHealth(
        () => this.alpaca.createOrder({
          symbol,
          qty: String(input.quantity),
          side: optionIntentToBrokerSide(input.intent),
          type: input.type,
          time_in_force: "day",
          limit_price: input.type === "limit" && input.limitPrice != null ? String(roundAlpacaPrice(input.limitPrice)) : undefined,
          client_order_id: input.refId
        }),
        { deadlineMs: ALPACA_BROKER_IO_DEADLINE_MS, retryTransient: false }
      );
      return {
        orderId: raw.id,
        refId: input.refId,
        state: raw.status,
        filledQuantity: optionalNumber(raw.filled_qty),
        averagePrice: optionalNumber(raw.filled_avg_price),
        raw
      };
    } catch (error: unknown) {
      throw new Error(`Alpaca option order failed: ${formatAlpacaOrderError(error)}`);
    }
  }

  async cancelOptionOrder(accountNumber: string, orderId: string): Promise<ExecutedOrder> {
    return this.cancelEquityOrder(accountNumber, orderId);
  }

  async getOptionPositions(accountNumber: string): Promise<OptionPosition[]> {
    const rows = await this.getEquityPositions(accountNumber);
    const out: OptionPosition[] = [];
    for (const row of rows) {
      const parsed = parseOccSymbol(row.symbol);
      if (!parsed) continue;
      out.push({
        symbol: parsed.occSymbol,
        underlyingSymbol: parsed.underlyingSymbol,
        expirationDate: parsed.expirationDate,
        optionType: parsed.optionType,
        strikePrice: parsed.strikePrice,
        quantity: row.quantity,
        averageCost: row.averageCost,
        marketValue: row.marketValue
      });
    }
    return out;
  }

  async cancelEquityOrder(accountNumber: string, orderId: string): Promise<ExecutedOrder> {
    const restCancel = async (): Promise<ExecutedOrder> => {
      await this.trackHealth(() => this.alpaca.cancelOrder(orderId), { deadlineMs: ALPACA_BROKER_IO_DEADLINE_MS });
      return { orderId, refId: crypto.randomUUID(), state: "cancel_requested", raw: {} };
    };
    return this.callMcp<any>("cancel_order", { order_id: orderId }, restCancel, {
      mode: "write",
      reconcile: () => this.reconcileCanceledOrder(orderId)
    }).then((res: any) => {
      if (res && typeof res === "object") {
        return { orderId, refId: crypto.randomUUID(), state: "cancel_requested", raw: res };
      }
      return res;
    });
  }

  // Identifies and cancels a bracket's still-resting sibling legs given the ORIGINAL entry order's
  // own ID. Alpaca's `GET /v2/orders/{id}?nested=true` returns the entry order with a `legs` array
  // — each leg is ALSO independently listed in the plain (non-nested) order list with its own real
  // order ID, and Alpaca cascades a cancel across the whole OCO group on its own once any one leg is
  // cancelled/filled. This always goes through native REST (this.alpaca), never the MCP tool
  // surface — this repo's alpaca-mcp integration has no documented equivalent for a nested-legs
  // fetch, and `this.alpaca` is constructed with the same REST-capable keys regardless of isMcp
  // whenever an underlying API key is configured (see the constructor) — so this degrades to a
  // best-effort no-op only on an MCP-ONLY account with no REST-capable key at all.
  async cancelBracketSiblingLegs(accountNumber: string, originalOrderId: string): Promise<{ cancelledOrderIds: string[] }> {
    if (this.isMcp && !this.hasRestKeys) {
      audit("alpaca_mcp_bracket_cancel_unsupported", { message: "Bracket sibling legs cannot be cancelled on MCP accounts without REST credentials", originalOrderId, accountNumber });
      return { cancelledOrderIds: [] };
    }
    let raw: any;
    try {
      raw = await this.trackHealth(
        () => this.alpaca.sendRequest(`/orders/${originalOrderId}`, { nested: true }, null, "GET"),
        { deadlineMs: ALPACA_BROKER_IO_DEADLINE_MS }
      );
    } catch (error) {
      // A 404 means the entry order is genuinely gone (expired/purged) — nothing to tear down, safe
      // to resolve as done. Any OTHER failure (network, rate-limit, 5xx) is transient and must
      // propagate so reconcilePendingBracketTeardowns' bounded-retry sweep actually retries it,
      // instead of the row being silently and permanently dropped on the first hiccup (adversarial
      // review of PR #1661, 2026-07-16).
      if ((error as { response?: { status?: number } })?.response?.status === 404) {
        return { cancelledOrderIds: [] };
      }
      throw error;
    }
    const legs = Array.isArray(raw?.legs) ? raw.legs : [];
    const cancelledOrderIds: string[] = [];
    for (const leg of legs) {
      const legId = leg?.id != null ? String(leg.id) : undefined;
      if (!legId) continue;
      const legState = String(leg?.status ?? "");
      if (isRejectedOrCanceledState(legState) || legState.toLowerCase() === "filled") continue;
      try {
        await this.trackHealth(() => this.alpaca.cancelOrder(legId), { deadlineMs: ALPACA_BROKER_IO_DEADLINE_MS });
        cancelledOrderIds.push(legId);
      } catch {
        // best-effort — a leg that filled/cancelled between the fetch above and this cancel is fine
        // to skip; Alpaca's own OCO cascade may have already resolved it
      }
    }
    return { cancelledOrderIds };
  }
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function executedOrderFromRaw(raw: { id?: unknown; status?: unknown; filled_qty?: unknown; filled_avg_price?: unknown }, refId: string): ExecutedOrder {
  return {
    orderId: String(raw.id),
    refId,
    state: raw.status != null ? String(raw.status) : "accepted",
    filledQuantity: optionalNumber(raw.filled_qty),
    averagePrice: optionalNumber(raw.filled_avg_price),
    raw
  };
}

function number(value: unknown): number {
  return optionalNumber(value) ?? 0;
}

// Map Alpaca's raw order `type` to our OrderType union. Alpaca uses "stop" (not "stop_market") and
// "trailing_stop"; a raw `as OrderType` cast silently leaked those non-union values downstream.
export function mapAlpacaOrderType(raw: unknown): OrderType {
  switch (String(raw)) {
    case "market":
      return "market";
    case "limit":
      return "limit";
    case "stop":
      return "stop_market";
    case "stop_limit":
      return "stop_limit";
    case "trailing_stop":
      return "stop_market"; // closest representation in our union (a stop-triggered exit)
    default:
      return "market"; // unknown/absent → safe default rather than leaking an invalid value
  }
}

// Map a raw Alpaca order object (REST or MCP shape — same field names) to our EquityOrder.
export function mapAlpacaOrder(o: Record<string, unknown>): EquityOrder {
  return {
    id: String(o.id),
    symbol: fromAlpacaSymbol(String(o.symbol)),
    side: o.side as OrderSide,
    type: mapAlpacaOrderType(o.type),
    state: String(o.status),
    quantity: optionalNumber(o.qty),
    dollarAmount: optionalNumber(o.notional),
    filledQuantity: optionalNumber(o.filled_qty),
    averagePrice: optionalNumber(o.filled_avg_price),
    limitPrice: optionalNumber(o.limit_price),
    stopPrice: optionalNumber(o.stop_price),
    timeInForce: o.time_in_force ? String(o.time_in_force) : undefined,
    createdAt: String(o.created_at),
    updatedAt: o.updated_at ? String(o.updated_at) : undefined,
    clientOrderId: o.client_order_id ? String(o.client_order_id) : undefined,
    orderClass: o.order_class ? String(o.order_class) : undefined,
    placedAgent: "alpaca"
  };
}

export function parseAlpacaPosition(p: Record<string, unknown>): EquityPosition {
  return {
    symbol: fromAlpacaSymbol(String(p.symbol)),
    quantity: number(p.qty ?? p.quantity),
    averageCost: number(p.avg_entry_price ?? p.average_entry_price ?? p.averageCost),
    marketValue: number(p.market_value ?? p.marketValue),
    sector: undefined,
    industry: undefined
  };
}

function optionalIso(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function formatAlpacaOrderError(error: unknown): string {
  const err = error as {
    message?: string;
    response?: { status?: number; data?: unknown };
  };
  const status = err.response?.status;
  const data = err.response?.data;
  const body = typeof data === "string"
    ? data
    : data && typeof data === "object"
      ? JSON.stringify(data)
      : "";
  const message = err.message ?? String(error);
  const detail = [status ? `HTTP ${status}` : "", message, body].filter(Boolean).join(" — ");
  if (status === 403 && !/position|short|permission|forbidden|insufficient/i.test(body)) {
    return `${detail} — broker forbade the order; verify the account has permission and a matching open position if this was a sell/cover.`;
  }
  return detail;
}
