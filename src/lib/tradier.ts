import crypto from "crypto";
import type {
  AccountCapabilities,
  BrokerageAccount,
  BrokerQuote,
  EquityOrder,
  EquityPosition,
  ExecutedOrder,
  OrderSide,
  OrderType,
  Portfolio,
  ReviewedOrder,
  BrokerGateway,
  EquityOrderInput,
  GetEquityOrdersOptions,
  OptionPosition
} from "./types";
import { normalizeSymbol, roundCents } from "./money";
import { isLiveOrderState, isRejectedOrCanceledState } from "./broker-side";
import { getActiveConnectedAccount, getConnectedAccount } from "./db";
import { logApiHealth } from "./db-health";
import { fetchDailyOHLC } from "./history";
import { isAbortOrTimeoutError, isTransientNetworkError } from "./network-errors";
// Reuse Alpaca's keyless-Yahoo quote floor and the shared pre-trade notional semantics verbatim —
// they are broker-agnostic helpers exported from ./alpaca (no Alpaca SDK behavior involved).
import { fillMissingQuotesWithClose, estimateReviewNotional } from "./alpaca";
import { mergeAccountCapabilities } from "./venue-contract";
import { TRADIER_BROKER_IO_DEADLINE_MS, equityOrdersDefaultSinceIso, withDeadline } from "./inflight-deadline";

/**
 * Tradier broker gateway. Hand-rolled REST (single Bearer token, no SDK), mirroring the Alpaca
 * adapter's structure. Environment is chosen explicitly at connect time — a sandbox token only
 * authenticates against sandbox.tradier.com and a production token only against api.tradier.com —
 * so the base URL is DERIVED from environment and the two can never cross. A misconfigured pairing
 * (e.g. a sandbox token stored as "live") 401s at the wrong host and throws before any order,
 * failing closed.
 *
 * Tradier is WHOLE-SHARE only (no fractional equities, no notional field), natively accepts the
 * 4-value order side (buy/sell/sell_short/buy_to_cover) so OrderSide maps DIRECTLY rather than
 * through toBrokerSide, and uses BRK.B dot notation on the wire. Our canonical INTERNAL form is
 * hyphenated (BRK-B, matching every other broker/proposal/fill via money.ts/normalizeSymbol), so
 * every read path (positions, orders, quotes) converts dot->hyphen with fromTradierSymbol and every
 * write converts hyphen->dot with toTradierSymbol — the two must stay symmetric so a share-class
 * position always matches its own resting orders. v1 uses synthetic stops (no OTOCO brackets)
 * because strategy.ts gates broker brackets to Alpaca.
 */
export function getTradierGateway(userId: string = "local", connectedAccountId?: string): BrokerGateway {
  return new TradierBrokerGateway(userId, connectedAccountId);
}

/**
 * In-process throttle for order-capability probes (scheduler ticks every 60s).
 *
 * Classification (production evidence, litestream-runtime.log 2026-08-29..2026-09-07): 1,364
 * "Tradier order capability probe failed" events over 9 days, all landing in the generic
 * connectivity/auth fallback below because the structured-rejection and 5xx regexes didn't
 * match Tradier's actual wording ("HTTP 400: Unexpected server error" has "server" between
 * "unexpected" and "error", so the old `/unexpected error/i` alternative never matched; a
 * timeout/AbortError also fell through the same way). `category` now records WHICH bucket a
 * failure landed in and `streak` counts consecutive same-category results so the TTL can back
 * off exponentially instead of re-probing (and re-warning) every single 60s tick for a
 * condition that has not changed. This does not change `ok`/`reason` for any input this
 * gateway already classified — same isHealthy verdict, just far fewer probes and log lines.
 */
type TradierProbeCategory =
  | "capability_ok" // structured OMS rejection (margin/PDT/etc.) or a clean preview accept
  | "server_error" // Tradier-side 5xx / backend / "unexpected (server) error"
  | "timeout" // caller-side abort or Tradier request timeout
  | "connectivity" // dead socket / DNS / reset — network-layer, not Tradier's application logic
  | "unclassified"; // none of the above matched — kept distinct so an unrecognized new Tradier
  // error string is still visible as its own category instead of hiding inside "connectivity"
const tradierProbeCache = new Map<
  string,
  { at: number; ok: boolean; reason?: string; category: TradierProbeCategory; streak: number }
>();
const TRADIER_PROBE_BASE_TTL_MS = 2 * 60_000;
/** Ceiling so a stuck/restricted account is still re-verified roughly hourly, never truly forever —
 *  the account could get re-enabled and this must eventually notice without a redeploy. */
const TRADIER_PROBE_MAX_TTL_MS = 60 * 60_000;

/** Exponential backoff on the SAME consecutive (ok, category) pair: 2m, 4m, 8m, ... capped at 1h. */
function tradierProbeTtlMs(streak: number): number {
  const doublings = Math.max(0, Math.min(streak, 5)); // 2m * 2^5 = 64m, already above the 60m cap
  return Math.min(TRADIER_PROBE_BASE_TTL_MS * 2 ** doublings, TRADIER_PROBE_MAX_TTL_MS);
}

// Tradier envelopes wrap collections as { orders: { order: [...] } }, collapse a lone element to a
// bare object { orders: { order: {...} } }, and report empty as null or the string "null". Normalize
// any of those to a plain array so per-row mapping is uniform.
function arr<T>(x: unknown): T[] {
  if (x === null || x === undefined) return [];
    if (typeof x === "string") return x.trim().toLowerCase() === "null" ? [] : [];
  if (Array.isArray(x)) return x as T[];
  return [x as T];
}

function tradierOrderCreatedMs(order: Record<string, unknown>): number {
  const raw = order.create_date ?? order.transaction_date ?? order.created_at;
  const parsed = typeof raw === "string" || typeof raw === "number" ? Date.parse(String(raw)) : NaN;
  return Number.isFinite(parsed) ? parsed : NaN;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function number(value: unknown): number {
  return optionalNumber(value) ?? 0;
}

// A finite, strictly-positive number, else undefined. Used where a literal 0 must be treated as
// ABSENT (not a real value) — e.g. a Tradier balance field Tradier omits or zero-fills must not
// override a genuine figure from another field.
function positiveNumber(value: unknown): number | undefined {
  const parsed = optionalNumber(value);
  return parsed != null && parsed > 0 ? parsed : undefined;
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return String(value);
}

function optionalIso(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  // Tradier quote payloads use millisecond epoch numbers for fields like trade_date and
  // bid_date; Date.parse(String(1757948508561)) returns NaN, so handle numeric values
  // as direct epoch milliseconds.
  let time: number;
  if (typeof value === "number") {
    time = value;
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    time = Number(value.trim());
  } else {
    time = Date.parse(String(value));
  }
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

// Tradier's valid extended-hours windows (https://docs.tradier.com/docs/orders):
//  - Pre-market:  07:00 – 09:24 ET
//  - Post-market: 16:00 – 19:55 ET
// Orders with extended-hours duration submitted outside these windows are REJECTED
// by the broker, so we fall back to regular-hours "day" when outside the window.
// Returns "pre", "post", or undefined (regular hours) as the duration value.
function tradierExtendedHoursDuration(): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const totalMinutes = hour * 60 + minute;
    const preStart = 7 * 60;      // 07:00
    const preEnd = 9 * 60 + 24;   // 09:24
    const postStart = 16 * 60;    // 16:00
    const postEnd = 19 * 60 + 55; // 19:55
    if (totalMinutes >= preStart && totalMinutes < preEnd) return "pre";
    if (totalMinutes >= postStart && totalMinutes < postEnd) return "post";
    return undefined; // Outside Tradier's extended-hours — fall back to regular session
  } catch {
    return undefined; // Clock lookup failed — fall back to regular session
  }
}

// OrderSide -> Tradier `side` (WRITE). DIRECT 4-value map (not toBrokerSide): Tradier natively
// accepts sell_short/buy_to_cover, so this preserves the explicit short/cover intent the broker
// would otherwise have to infer.
function mapTradierSideWrite(side: OrderSide): string {
  switch (side) {
    case "buy":
      return "buy";
    case "sell":
      return "sell";
    case "short":
      return "sell_short";
    case "cover":
      return "buy_to_cover";
  }
}

// Tradier `o.side` -> OrderSide (READ-BACK).
function mapTradierSideRead(raw: unknown): OrderSide {
  switch (String(raw)) {
    case "buy":
      return "buy";
    case "sell":
      return "sell";
    case "sell_short":
      return "short";
    case "buy_to_cover":
      return "cover";
    default:
      return "buy";
  }
}

// OrderType -> Tradier `type` (WRITE). Tradier's wire word for a stop-market is "stop".
function mapTradierTypeWrite(type: OrderType): string {
  return type === "stop_market" ? "stop" : type;
}

// The exit (opposite) side for a bracket's take-profit/stop-loss legs — the leg that closes
// whatever the entry leg opened. A "buy"/entry long closes with "sell"; a "short"/entry short
// closes with "cover" (buy_to_cover).
function exitSideForEntry(entrySide: OrderSide): OrderSide {
  return entrySide === "short" ? "cover" : "sell";
}

// Tradier `o.type` -> OrderType (READ-BACK).
function mapTradierTypeRead(raw: unknown): OrderType {
  switch (String(raw)) {
    case "market":
      return "market";
    case "limit":
      return "limit";
    case "stop":
      return "stop_market";
    case "stop_limit":
      return "stop_limit";
    default:
      return "market";
  }
}

// EquityOrderInput -> Tradier `duration`. Extended-hours is expressed through the duration
// ("pre"/"post"), not a separate flag; Tradier only fills an extended-session order as a LIMIT, so
// only a limit order gets the pre/post session — anything else falls back to the regular-session TIF.
function durationFor(input: { marketHours?: EquityOrderInput["marketHours"]; type?: OrderType; timeInForce?: EquityOrderInput["timeInForce"] }): string {
  if (input.marketHours === "extended_hours" && input.type === "limit") {
    return tradierExtendedHoursDuration() ?? "day";
  }
  return input.timeInForce === "gfd" ? "day" : "gtc";
}

// Tradier equity symbols use DOT notation for share classes (BRK.B); our canonical INTERNAL form is
// HYPHENATED (BRK-B — the Robinhood convention, see money.ts/normalizeSymbol) so it matches
// proposal/fill/synthetic-stop symbols everywhere else. Convert at the wire boundary in BOTH
// directions so positions, orders, and quotes all key alike AND agree with the proposal symbols a
// double-exit / held-exit guard compares against.
function fromTradierSymbol(symbol: string): string {
  return normalizeSymbol(symbol).replace(/\./g, "-");
}
function toTradierSymbol(symbol: string): string {
  return normalizeSymbol(symbol).replace(/-/g, ".");
}

// Sanitize a refId into Tradier's `tag` field: alnum + dash, <= 255 chars. Tradier's documented tag
// charset is letters/numbers/dash only, so an underscore or dot would be rewritten to a dash and the
// tag would no longer round-trip to the raw refId a dedup compares against. Synthetic-stop refIds
// are therefore kept within [A-Za-z0-9-] at generation (src/lib/synthetic-stops.ts), and primary
// refIds are UUIDs — so this stays IDENTITY on every refId we actually place, and the broker-returned
// tag matches the stored refId exactly. This remains as defense-in-depth against a future refId
// source introducing an out-of-charset character.
function sanitizeTag(refId: string): string {
  return String(refId).replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 255);
}

// Tradier's GET /v1/user/profile account object -> AccountCapabilities. False-by-default discipline:
// only set a capability true on a field Tradier explicitly confirms.
function capsFromProfile(account: Record<string, unknown>): AccountCapabilities {
  const type = String(account.type ?? "").toLowerCase();
  const classification = String(account.classification ?? "").toLowerCase();
  const isMargin = type === "margin";
  const rawLevel = optionalNumber(account.option_level);
  const optionsLevel: AccountCapabilities["optionsLevel"] =
    rawLevel !== undefined && rawLevel >= 0 && rawLevel <= 4 ? (Math.trunc(rawLevel) as 0 | 1 | 2 | 3 | 4) : undefined;
  let accountType: AccountCapabilities["accountType"] = "brokerage";
  if (classification.includes("roth")) accountType = "roth_ira";
  else if (classification.includes("ira") || classification.includes("traditional") || classification.includes("rollover")) {
    accountType = "traditional_ira";
  }
  // Tradier IRAs report type "margin" even though they cannot short.
  // Short selling is only valid for non-IRA margin accounts.
  const isIra = accountType === "traditional_ira" || accountType === "roth_ira";
  return mergeAccountCapabilities("tradier", {
    equityTrading: true,
    shortSelling: isMargin && !isIra,
    optionsTrading: optionsLevel !== undefined ? optionsLevel > 0 : false,
    optionsLevel,
    optionsOrders: false,
    futuresTrading: false,
    cryptoTrading: false,
    marginEnabled: isMargin,
    accountType
  });
}

class TradierBrokerGateway implements BrokerGateway {
  readonly ordersListIncludesTerminal = true;
  private token: string;
  private baseUrl: string;
  private label: string;
  private environment: "paper" | "live";
  private accountNumber?: string;
  private keySource: string;

  constructor(private userId: string, connectedAccountId?: string) {
    const targeted = connectedAccountId ? getConnectedAccount(connectedAccountId, userId) : undefined;
    const active = getActiveConnectedAccount(userId);
    const acct = targeted ?? active;
    const keys = acct?.broker === "tradier" ? acct : undefined;

    // No operator env fallback: a Tradier token is a single owned Bearer credential (unlike Alpaca's
    // per-user tier with an operator env floor). Resolve ONLY from a stored connected-account row for
    // THIS user, and fail loudly otherwise so a non-owner never trades on someone else's token.
    if (!keys) {
      throw new Error("No Tradier account connected.");
    }
    const token = keys.apiKey?.trim();
    if (!token) {
      throw new Error(
        `Tradier access token is missing for ${keys.label}. Open Connections and re-save the token.`
      );
    }
    this.token = token;
    this.keySource = "user";
    this.environment = keys.environment;

    // `environment` is the AUTHORITY for the venue: live => api.tradier.com, paper => sandbox.tradier.com.
    // A stored baseUrl is honored ONLY when its host matches the environment's venue — a mismatched or
    // unparseable baseUrl is IGNORED (never allowed to route a paper-labeled account to the live API,
    // or a live account to sandbox). This fails safe on corrupt/legacy rows even though the connect
    // route also rejects a host-mismatched baseUrl at write time.
    const derivedBase = this.environment === "live" ? "https://api.tradier.com/v1" : "https://sandbox.tradier.com/v1";
    const expectedHost = new URL(derivedBase).host.toLowerCase();
    let baseUrl = derivedBase;
    const stored = keys.baseUrl?.trim();
    if (stored) {
      let storedHost: string | undefined;
      try {
        storedHost = new URL(stored).host.toLowerCase();
      } catch {
        storedHost = undefined;
      }
      if (storedHost === expectedHost) baseUrl = stored; // consistent venue — honor path/version customizations
    }
    baseUrl = baseUrl.replace(/\/+$/, "");
    if (!/\/v1$/i.test(baseUrl)) baseUrl = `${baseUrl}/v1`;
    this.baseUrl = baseUrl;

    this.label = keys.label || (this.environment === "live" ? "Tradier Brokerage" : "Tradier Sandbox");
    this.accountNumber = keys.accountNumber;
  }

  // Raw Tradier REST call. Bearer auth + JSON accept; POST/PUT bodies are form-encoded (Tradier's
  // trading API takes application/x-www-form-urlencoded, not JSON). Throws a joined message on a
  // non-2xx response or a parsed Tradier error envelope ({ errors: { error: [...] } }).
  private async request<T>(
    method: string,
    path: string,
    opts: { form?: Record<string, string | number | undefined>; query?: Record<string, string | number | undefined> } = {}
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (opts.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null && v !== "") qs.append(k, String(v));
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json"
    };
    let body: string | undefined;
    if (method === "POST" || method === "PUT") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.form ?? {})) {
        if (v !== undefined && v !== null && v !== "") form.append(k, String(v));
      }
      body = form.toString();
    }
    const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(TRADIER_BROKER_IO_DEADLINE_MS) });
    let parsed: unknown = undefined;
    const text = await response.text();
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      throw new Error(`Tradier HTTP ${response.status}: ${formatTradierError(parsed) || text || response.statusText}`);
    }
    // Tradier returns 200 with an { errors: { error: [...] } } envelope for validation failures.
    if (parsed && typeof parsed === "object" && "errors" in (parsed as Record<string, unknown>)) {
      const msg = formatTradierError(parsed);
      if (msg) throw new Error(`Tradier HTTP 422: ${msg}`);
    }
    return parsed as T;
  }

  // Wrap a call for the admin connections-health page ("tradier-broker"), mirroring Alpaca's
  // trackHealth. logApiHealth swallows its own errors; the broker call is never affected by a
  // logging failure.
  //
  // `retryTransient` is opt-IN (default false, unlike Alpaca's opt-out) — the safe default for a
  // gateway whose call sites are a mix of reads and money-moving writes is to retry nothing unless
  // a call site explicitly proves itself idempotent. Only GET reads and the side-effect-free
  // preview probe (probeOrderCapability) opt in. placeEquityOrder / placeOptionOrder / the bracket
  // POST / cancelEquityOrder never do: a dead keep-alive socket after Tradier already accepted the
  // write would make a retry a genuine second order attempt, or a cancel-of-already-cancelled 400
  // that the caller would misread as failure (same class of risk Alpaca's trackHealth documents for
  // createOrder).
  private async trackHealth<T>(
    fn: () => Promise<T>,
    opts?: { deadlineMs?: number; retryTransient?: boolean }
  ): Promise<T> {
    const start = Date.now();
    const attempts = opts?.retryTransient ? 2 : 1;
    const runOnce = () => {
      const call = fn();
      return opts?.deadlineMs != null
        ? withDeadline(call, opts.deadlineMs, "Tradier broker call timed out")
        : call;
    };
    let lastErr: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const result = await runOnce();
        logApiHealth({ service: "tradier-broker", ok: true, latencyMs: Date.now() - start, keySource: this.keySource, userId: this.userId });
        return result;
      } catch (err) {
        lastErr = err;
        // Tradier's keep-alive pool can hand back a socket the origin already closed
        // (UND_ERR_SOCKET / "other side closed" / bare "fetch failed"). One retry on a fresh
        // connection recovers a read; the first miss is not logged so a recovered blip cannot
        // feed the connections-health consecutive-failure streak. A caller-side abort/timeout is
        // never retried here — isAbortOrTimeoutError takes priority so a budget timeout doesn't
        // also eat a retry slot.
        if (
          attempt + 1 < attempts &&
          !isAbortOrTimeoutError(err) &&
          isTransientNetworkError(err)
        ) {
          await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
          continue;
        }
        logApiHealth({
          service: "tradier-broker",
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

  async getAccounts(): Promise<BrokerageAccount[]> {
    return this.trackHealth(async () => {
      const body = await this.request<{ profile?: { account?: unknown } }>("GET", "/user/profile");
      const accounts = arr<Record<string, unknown>>(body.profile?.account);
      return accounts.map((account) => {
        const accountNumber = String(account.account_number ?? "");
        const type = account.type ? String(account.type) : "";
        const status = String(account.status ?? "").toLowerCase();
        return {
          accountNumber,
          label: this.label || `Tradier ${type || "account"}`.trim(),
          // A closed account is not usable — strategy.ts checks agenticAllowed
          // before proceeding with any trading operations.
          agenticAllowed: status !== "closed",
          capabilities: capsFromProfile(account)
        } satisfies BrokerageAccount;
      });
    }, { retryTransient: true });
  }

  async getPortfolio(accountNumber: string): Promise<Portfolio> {
    return this.trackHealth(async () => {
      const body = await this.request<{ balances?: Record<string, unknown> }>("GET", `/accounts/${accountNumber}/balances`);
      const b = body.balances ?? {};
      // Account-Mismatch guard mirroring Alpaca: only flag a GENUINE cross-account mismatch (both
      // present and actually different, ignoring case/whitespace).
      const liveNum = String(b.account_number ?? "").trim();
      const wantNum = String(accountNumber ?? "").trim();
      if (wantNum && liveNum && liveNum.toLowerCase() !== wantNum.toLowerCase()) {
        throw new Error(
          `Account Mismatch: the connected Tradier credentials are for account ${liveNum}, but this profile is configured for ${wantNum}. Update the account number in Connections.`
        );
      }
      const margin = b.margin as Record<string, unknown> | undefined;
      const cashAcct = b.cash as Record<string, unknown> | undefined;
      const pdt = b.pdt as Record<string, unknown> | undefined;
      const totalCash = number(b.total_cash);
      const totalMarketValue = optionalNumber(b.total_equity) ?? number(b.market_value) + totalCash;
      // Buying power fed to position sizing must be the OVERNIGHT / Reg-T figure
      // (margin.stock_buying_power), NEVER the ~4x INTRADAY pdt.stock_buying_power a pattern-day-trader
      // margin account also reports — sizing off the intraday number would silently lever up an
      // overnight hold, which the owner's conservative/opt-in-leverage margin decision forbids.
      //
      // The intraday/PDT figure is a DOWNWARD-ONLY clamp: it may pull the conservative overnight
      // figure DOWN (via min), but it must never STAND IN as buying power. A symmetric
      // min-of-positive-candidates was wrong — if Tradier omits/zero-fills the overnight
      // stock_buying_power while the ~4x intraday pdt.stock_buying_power is positive, the min over the
      // surviving candidate returned the INTRADAY figure and over-levered an overnight hold. So: only
      // when the overnight Reg-T figure is present/positive is buying power known; if it is absent/0
      // we report buying power as UNKNOWN (0), never the intraday 4x. Both consumers read a
      // non-positive buyingPower as "unknown => don't block, defer to the broker's own margin
      // rejection" (strategy.ts openingRiskCapacity only adds the buying-power cap when `> 0`;
      // policy.ts affordability only blocks when `> 0`), matching how the Alpaca adapter treats a
      // missing buying_power (number(undefined) => 0). A spurious 0 in either field is treated as
      // absent (positiveNumber). Richer PDT/margin figures are deliberately NOT fed to sizing here.
      // Cash accounts use cash_available; else total cash.
      const marginBuyingPower = margin
        ? (() => {
            const overnight = positiveNumber(margin.stock_buying_power);
            if (overnight == null) return undefined; // unknown Reg-T BP — never fall back to the intraday 4x figure
            const intraday = positiveNumber(pdt?.stock_buying_power);
            return intraday != null ? Math.min(overnight, intraday) : overnight;
          })()
        : undefined;
      const buyingPower = margin
        ? (marginBuyingPower ?? 0)
        : cashAcct
          ? number(cashAcct.cash_available)
          : totalCash;
      // Use stock-specific fields for equityMarketValue to avoid double-counting option
      // value: Tradier's balance.market_value includes option value, and storing it as
      // equityMarketValue while also storing optionMarketValue makes accountEquity() add
      // option value twice for mixed stock/options accounts.
      // Net option value: Tradier exposes both option_long_value and option_short_value
      // in the balances payload. Storing only the long value overstates equity for
      // accounts with short option positions, since accountEquity() composes
      // cash + equityMarketValue + optionMarketValue.
      const optionLong = number(b.long_option_value ?? b.option_long_value ?? 0);
      const optionShort = number(b.short_option_value ?? b.option_short_value ?? 0);
      const optionMarketValue = optionLong - optionShort;
      const rawStockLong = optionalNumber(b.stock_long_value);
      // Tradier documents short stock value under the top-level stock_short_value and the
      // margin/pdt nested objects. Try each in turn so a nested-only field is not missed.
      // The value is a positive absolute number, subtracted from stock_long_value to compute
      // net equity from stock positions. Deliberately NOT falling back to top-level
      // short_market_value — that is stock+option short COMBINED, so using it here would
      // double-count option-short value already netted into optionMarketValue above (a
      // cash/IRA account holding a short option would otherwise understate equity).
      const rawStockShort = optionalNumber(b.stock_short_value)
        ?? (margin ? optionalNumber(margin.stock_short_value) : undefined)
        ?? (pdt ? optionalNumber(pdt.stock_short_value) : undefined);
      const equityMarketValue =
        rawStockLong != null && rawStockShort != null
          ? rawStockLong - rawStockShort
          : number(b.market_value) - optionMarketValue;
      return {
        accountNumber,
        totalMarketValue,
        buyingPower,
        equityMarketValue,
        optionMarketValue,
        cash: totalCash
      };
    }, { retryTransient: true });
  }

  async getEquityPositions(accountNumber: string): Promise<EquityPosition[]> {
    return this.trackHealth(async () => {
      const body = await this.request<{ positions?: { position?: unknown } | string }>("GET", `/accounts/${accountNumber}/positions`);
      const positionsField = typeof body.positions === "object" && body.positions ? (body.positions as Record<string, unknown>).position : undefined;
      const rows = arr<Record<string, unknown>>(positionsField);
      if (rows.length === 0) return [];
      // Filter out OCC option positions: Tradier's /positions returns open option contracts
      // alongside equities, keyed by their 21-char OCC symbol (root + YYMMDD + C/P + 8-digit
      // strike, e.g. DELL140118C00015000). Tradier position rows carry NO option_type field, so
      // discriminate by the OCC symbol format; mapping options as EquityPosition would pollute
      // the equity book/risk checks for mixed stock+options accounts. A plain ticker (incl. a
      // dotted/hyphenated share class like BRK-B) never matches the OCC suffix, so no real equity
      // position is dropped.
      const equityRows = rows.filter((p) => !/\d{6}[CP]\d{8}$/.test(String(p.symbol ?? "").trim().toUpperCase()));
      if (equityRows.length === 0) return [];
      // Canonicalize to the hyphenated form so a share-class position (BRK-B) matches its own resting
      // orders/quotes/proposals AND the quote-map keys getEquityQuotes returns — Tradier speaks dotted
      // (BRK.B), which would otherwise never match (mispriced or treated as absent).
      const symbols = equityRows.map((p) => fromTradierSymbol(String(p.symbol)));
      // Tradier position rows carry TOTAL cost_basis and no live market_value — price them via a
      // single batched quote call (fall back to cost basis when a quote is missing).
      const quotes = await this.getEquityQuotes(accountNumber, symbols).catch(() => ({} as Record<string, BrokerQuote>));
      return equityRows.map((p) => {
        const symbol = fromTradierSymbol(String(p.symbol));
        const quantity = number(p.quantity);
        const totalCost = number(p.cost_basis);
        // Tradier reports negative quantity for short positions; use Math.abs so that
        // averageCost stays positive — risk paths treat averageCost <= 0 as unusable and
        // would skip short add/cover checks for Tradier short holdings.
        const averageCost = quantity !== 0 ? totalCost / Math.abs(quantity) : 0;
        const price = quotes[symbol]?.price;
        const marketValue = price && price > 0 ? quantity * price : quantity * averageCost;
        return {
          symbol,
          quantity,
          averageCost,
          marketValue,
          sector: undefined,
          industry: undefined
        } satisfies EquityPosition;
      });
    }, { retryTransient: true });
  }

  async getOptionPositions(accountNumber: string): Promise<OptionPosition[]> {
    return this.trackHealth(async () => {
      const body = await this.request<{ positions?: { position?: unknown } | string }>("GET", `/accounts/${accountNumber}/positions`);
      const positionsField = typeof body.positions === "object" && body.positions ? (body.positions as Record<string, unknown>).position : undefined;
      const rows = arr<Record<string, unknown>>(positionsField);
      if (rows.length === 0) return [];
      
      const optionRows = rows.filter((p) => /\d{6}[CP]\d{8}$/.test(String(p.symbol ?? "").trim().toUpperCase()));
      if (optionRows.length === 0) return [];

      const symbols = optionRows.map((p) => String(p.symbol).trim().toUpperCase().replace(/\s+/g, ""));
      const quotes = await this.getEquityQuotes(accountNumber, symbols).catch(() => ({} as Record<string, BrokerQuote>));

      return optionRows.map((p) => {
        const symbol = String(p.symbol).trim().toUpperCase().replace(/\s+/g, "");
        const parsed = parseOccSymbol(symbol);
        const qty = number(p.quantity);
        const costBasis = number(p.cost_basis);
        const averageCost = qty !== 0 ? Math.abs(costBasis / (qty * 100)) : 0;
        const price = quotes[symbol]?.price;
        const marketValue = price !== undefined && price > 0 ? qty * price * 100 : costBasis;

        return {
          symbol,
          underlyingSymbol: parsed.underlyingSymbol,
          expirationDate: parsed.expirationDate,
          optionType: parsed.optionType,
          strikePrice: parsed.strikePrice,
          quantity: qty,
          averageCost: Number(averageCost.toFixed(2)),
          marketValue: Number(marketValue.toFixed(2))
        } satisfies OptionPosition;
      });
    }, { retryTransient: true });
  }

  async getEquityOrders(accountNumber: string, options?: GetEquityOrdersOptions): Promise<EquityOrder[]> {
    const fullHistory = options?.fullHistory === true;
    const sinceMs = options?.since ? Date.parse(options.since) : Date.parse(equityOrdersDefaultSinceIso());
    // Always walk up to 50 pages. Tradier defaults to 25 rows/page, newest first, with no
    // status=open split (unlike Alpaca). A 5-page default (#2886) stopped after ~125 recent
    // rows — often option/combo activity — and hid a later-page GTC equity protective stop.
    // liveExitOrderCoverage then saw no exit and the synthetic-stop monitor double-sold.
    // Continue on the RAW page (any class). Do not stop when the equity filter drops a page.
    const maxPages = 50;
    return this.trackHealth(async () => {
      const all: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      for (let page = 1; page <= maxPages; page++) {
        const body = await this.request<{ orders?: { order?: unknown } | string }>("GET", `/accounts/${accountNumber}/orders`, {
          query: { page, includeTags: "true" }
        });
        const ordersField = typeof body.orders === "object" && body.orders ? (body.orders as Record<string, unknown>).order : undefined;
        const rows = arr<Record<string, unknown>>(ordersField);
        if (rows.length === 0) break; // genuinely no more pages
        // Pagination continuation is decided on the RAW page (ALL classes), NOT the
        // post-equity-filter count. A mixed equity+options account can have a page holding
        // only option/combo rows sitting BEFORE a later page that carries a resting
        // protective EQUITY exit; breaking as soon as a page yields zero *equity* rows
        // would stop before that exit, hiding it from liveExitOrderCoverage and letting
        // the synthetic-stop monitor place a DUPLICATE.
        let newThisPage = 0;
        for (const o of rows) {
          const id = String(o.id);
          if (seen.has(id)) continue;
          seen.add(id);
          newThisPage += 1;
          const oClass = String(o.class ?? "").toLowerCase();
          if (oClass === "equity") {
            all.push(o);
          } else if (["oto", "otoco", "oco", "multileg", "combo"].includes(oClass)) {
            // Include the container (primary entry order) for advanced orders if it represents an equity action
            // Tradier's container for equity brackets usually carries the entry leg's details at the top level.
            if (o.symbol && o.side) all.push(o);
            const legField = o.leg ?? o.legs;
            if (legField) {
              for (const leg of arr<Record<string, unknown>>(legField)) {
                if (String(leg.class ?? "").toLowerCase() !== "equity") continue;
                all.push({
                  symbol: o.symbol,
                  status: o.status,
                  create_date: o.create_date,
                  transaction_date: o.transaction_date,
                  duration: o.duration,
                  // Deliberately omitting `tag: o.tag` for exit legs so they don't usurp the entry leg's clientOrderId
                  ...leg
                });
              }
            }
          }
        }
        if (newThisPage === 0) break; // fully-duplicate page — done
      }
      const scoped = fullHistory
        ? all
        : all.filter((o) => {
            // Must match isLiveOrderState, not a hand-rolled subset. pending_cancel /
            // pending_replace still fill until Tradier confirms them dead. Dropping a
            // week-old GTC stop in that state hides it from liveExitOrderCoverage and
            // the synthetic-stop monitor (and account-drain) can stack a second exit.
            if (isLiveOrderState(String(o.status ?? ""))) return true;
            const createdMs = tradierOrderCreatedMs(o);
            return Number.isFinite(sinceMs) && Number.isFinite(createdMs) && createdMs >= sinceMs;
          });
      return scoped.map((o) => mapTradierOrder(o));
    }, { retryTransient: true });
  }

  async getEquityQuotes(accountNumber: string, symbols: string[]): Promise<Record<string, BrokerQuote>> {
    const aliasesByCanonical = new Map<string, Set<string>>();
    for (const rawSymbol of symbols) {
      const requested = normalizeSymbol(rawSymbol);
      // Canonicalize to our HYPHENATED form (BRK-B) so the quote map keys the same way positions,
      // orders, and proposals do; Tradier's dotted wire form is applied only on the request below.
      const canonical = fromTradierSymbol(requested);
      if (!canonical) continue;
      const aliases = aliasesByCanonical.get(canonical) ?? new Set<string>();
      aliases.add(canonical);
      if (requested) aliases.add(requested);
      aliasesByCanonical.set(canonical, aliases);
    }
    const canonicalSymbols = Array.from(aliasesByCanonical.keys());
    const quotes: Record<string, BrokerQuote> = {};
    if (canonicalSymbols.length > 0) {
      try {
        // Tradier equity symbols use dots (BRK.B); our canonical is hyphenated, so convert on the wire.
        const wireSymbols = canonicalSymbols.map((s) => toTradierSymbol(s));
        const body = await this.trackHealth(
          () =>
            this.request<{ quotes?: { quote?: unknown } | string }>("GET", "/markets/quotes", {
              query: { symbols: wireSymbols.join(","), greeks: "false" }
            }),
          { retryTransient: true }
        );
        const quotesField = typeof body.quotes === "object" && body.quotes ? (body.quotes as Record<string, unknown>).quote : undefined;
        for (const q of arr<Record<string, unknown>>(quotesField)) {
          const symbol = fromTradierSymbol(String(q.symbol));
          const last = optionalNumber(q.last);
          const close = optionalNumber(q.close);
          const ask = optionalNumber(q.ask);
          const bid = optionalNumber(q.bid);
          quotes[symbol] = {
            symbol,
            price: last ?? close ?? ask ?? bid ?? 0,
            bid,
            ask,
            volume: optionalNumber(q.volume),
            asOf: optionalIso(q.trade_date ?? q.bid_date),
            provider: "tradier"
          };
        }
      } catch (error) {
        console.warn(`[tradier] getEquityQuotes failed for ${canonicalSymbols.join(",")}:`, error instanceof Error ? error.message : error);
      }
    }
    // Keyless Yahoo daily-close floor for any symbol Tradier left unpriced — identical to Alpaca.
    await fillMissingQuotesWithClose(quotes, canonicalSymbols, async (symbol) => {
      const bars = await fetchDailyOHLC(symbol, Date.now(), this.userId);
      const lastBar = bars && bars.length ? bars[bars.length - 1] : undefined;
      return lastBar && typeof lastBar.close === "number" ? { price: lastBar.close, asOf: lastBar.time != null ? String(lastBar.time) : undefined } : undefined;
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
    // v1 stub mirroring Alpaca, but fractional MUST be false — Tradier has no fractional equities,
    // which also forces whole-share sizing upstream.
    return Object.fromEntries(symbols.map((symbol) => [fromTradierSymbol(symbol), { tradable: true, fractional: false }]));
  }

  async reviewEquityOrder(input: EquityOrderInput): Promise<ReviewedOrder> {
    // v1 self-computes (no Tradier preview call) using the shared over-cap/exit notional semantics.
    const quotes = await this.getEquityQuotes(input.accountNumber, [input.symbol]);
    const quotePrice = quotes[fromTradierSymbol(input.symbol)]?.price;
    const { estimatedNotional, alerts } = estimateReviewNotional(input, quotePrice);
    return { estimatedNotional, alerts, raw: { tradier: true } };
  }

  async placeEquityOrder(input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> {
    // WHOLE-SHARE resolution: Tradier has no notional field AND no broker-side notional cap, so WE
    // size a dollar order into shares at an anchor price and must not overspend the budget. Never
    // default to 1 — a $500 order must not become 500 shares.
    //  - A LIMIT order's fill price is capped at limitPrice, so limitPrice is a safe (never-
    //    overspending) anchor.
    //  - A MARKET order has NO price cap, so the STALE proposal referencePrice is unsafe: on a stock
    //    that rose since the proposal it under-prices the share and buys too many. Size a market
    //    order from a FRESH quote at placement time, and THROW (never silently fall back to the stale
    //    price and overspend) when no live price is available.
    let shares = input.quantity != null ? input.quantity : undefined;
    if (shares == null && input.dollarAmount) {
      let anchorPrice = input.limitPrice != null && input.limitPrice > 0 ? input.limitPrice : undefined;
      if (anchorPrice == null) {
        const quotes = await this.getEquityQuotes(input.accountNumber, [input.symbol]);
        const quote = quotes[fromTradierSymbol(input.symbol)];
        if (quote && quote.provider === "tradier") {
          anchorPrice = quote.price;
        }
      }
      if (!(anchorPrice != null && anchorPrice > 0)) {
        throw new Error("Tradier: cannot size a dollar order without a live quote.");
      }
      shares = input.dollarAmount / anchorPrice;
    }
    const wholeQty = shares != null ? Math.floor(shares) : NaN;
    if (!(wholeQty >= 1)) {
      throw new Error("Tradier order too small for a whole share.");
    }

    // Native Tradier bracket support: "otoco" (one-triggers-one-cancels-other) when BOTH a
    // take-profit and stop-loss are set, "oto" (one-triggers-other, single exit) when only one is —
    // Tradier's OTOCO always implicitly OCO-pairs legs 1+2, so a single-exit bracket uses the
    // simpler 2-leg class instead of padding a phantom second leg. Leg 0 (entry) only accepts
    // limit/stop/stop_limit per Tradier's schema — no market-type entry leg exists for a multi-leg
    // order — so a market-type bracket request falls through to the plain single-leg order below
    // (no bracket attached). Note: because fixed and atr plans are not registered in the synthetic-stop
    // monitor, a market entry on Tradier with fixed/atr leaves the position unprotected between
    // hourly proactive strategy runs.
    const isBracket = input.bracketTakeProfit != null || input.bracketStopLoss != null;
    const entryTypeSupportsBracket = input.type === "limit" || input.type === "stop_market" || input.type === "stop_limit";
    if (isBracket && entryTypeSupportsBracket) {
      const exitSide = mapTradierSideWrite(exitSideForEntry(input.side));
      const hasTakeProfit = input.bracketTakeProfit != null;
      const hasStopLoss = input.bracketStopLoss != null;
      const bracketForm: Record<string, string | number | undefined> = {
        class: hasTakeProfit && hasStopLoss ? "otoco" : "oto",
        duration: durationFor(input),
        tag: sanitizeTag(input.refId),
        "symbol[0]": toTradierSymbol(input.symbol),
        "side[0]": mapTradierSideWrite(input.side),
        "quantity[0]": String(wholeQty),
        "type[0]": mapTradierTypeWrite(input.type)
      };
      if (input.limitPrice != null) bracketForm["price[0]"] = roundCents(input.limitPrice);
      if (input.stopPrice != null) bracketForm["stop[0]"] = roundCents(input.stopPrice);

      let legIndex = 1;
      if (hasTakeProfit) {
        bracketForm[`symbol[${legIndex}]`] = toTradierSymbol(input.symbol);
        bracketForm[`side[${legIndex}]`] = exitSide;
        bracketForm[`quantity[${legIndex}]`] = String(wholeQty);
        bracketForm[`type[${legIndex}]`] = "limit";
        bracketForm[`price[${legIndex}]`] = roundCents(input.bracketTakeProfit!);
        legIndex += 1;
      }
      if (hasStopLoss) {
        bracketForm[`symbol[${legIndex}]`] = toTradierSymbol(input.symbol);
        bracketForm[`side[${legIndex}]`] = exitSide;
        bracketForm[`quantity[${legIndex}]`] = String(wholeQty);
        bracketForm[`type[${legIndex}]`] = input.bracketStopLimit != null ? "stop_limit" : "stop";
        bracketForm[`stop[${legIndex}]`] = roundCents(input.bracketStopLoss!);
        if (input.bracketStopLimit != null) bracketForm[`price[${legIndex}]`] = roundCents(input.bracketStopLimit);
      }

      let bracketBody: { order?: Record<string, unknown> };
      try {
        bracketBody = await this.trackHealth(() =>
          this.request<{ order?: Record<string, unknown> }>("POST", `/accounts/${input.accountNumber}/orders`, { form: bracketForm })
        );
      } catch (error) {
        throw new Error(`Tradier bracket order failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const bracketOrder = bracketBody.order ?? {};
      const bracketId = bracketOrder.id;
      if (bracketId === undefined || bracketId === null || bracketId === "") {
        throw new Error(`Tradier bracket order failed: response had no order id: ${JSON.stringify(bracketBody)}`);
      }
      const bracketRawStatus = String(bracketOrder.status ?? "");
      return {
        orderId: String(bracketId),
        refId: input.refId,
        state: bracketRawStatus && bracketRawStatus.toLowerCase() !== "ok" ? bracketRawStatus : "pending",
        filledQuantity: optionalNumber(bracketOrder.exec_quantity),
        averagePrice: optionalNumber(bracketOrder.avg_fill_price),
        raw: bracketBody
      };
    }

    // No bracket (or a market-type entry that can't carry one): plain single-leg order. Protection
    // comes from the synthetic-stop monitor / broker-protective-stops.ts instead.
    const form: Record<string, string | number | undefined> = {
      class: "equity",
      symbol: toTradierSymbol(input.symbol),
      side: mapTradierSideWrite(input.side), // DIRECT 4-value map (short->sell_short, cover->buy_to_cover)
      type: mapTradierTypeWrite(input.type), // stop_market->stop
      quantity: String(wholeQty),
      duration: durationFor(input),
      tag: sanitizeTag(input.refId)
    };
    if (input.limitPrice != null) form.price = input.limitPrice;
    if (input.stopPrice != null) form.stop = input.stopPrice;

    let body: { order?: Record<string, unknown> };
    try {
      body = await this.trackHealth(() =>
        this.request<{ order?: Record<string, unknown> }>("POST", `/accounts/${input.accountNumber}/orders`, { form })
      );
    } catch (error) {
      throw new Error(`Tradier order failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const o = body.order ?? {};
    const id = o.id;
    // ExecutedOrder MUST carry a usable orderId or the reconciliation sweep can't match it —
    // String(undefined) must never silently become the literal "undefined".
    if (id === undefined || id === null || id === "") {
      throw new Error(`Tradier order failed: response had no order id: ${JSON.stringify(body)}`);
    }
    // Tradier returns status "ok" on accept (request-accepted, not a real order-state word) —
    // normalize to "pending" so isLiveOrderState recognizes it as resting; a real terminal status
    // (e.g. "rejected") passes through verbatim so isRejectedOrCanceledState still catches a
    // synchronous decline.
    const raw = String(o.status ?? "");
    const state = raw && raw.toLowerCase() !== "ok" ? raw : "pending";
    // Tradier may fill immediately on submission (e.g. a market order for a liquid
    // stock); preserve the broker's fill data rather than silently discarding it.
    // Without this, a filled dollar order is booked with the proposal notional/scan
    // price instead of the broker's whole-share fill, corrupting positions and P&L.
    const filledQuantity = optionalNumber(o.exec_quantity);
    const averagePrice = optionalNumber(o.avg_fill_price);
    return {
      orderId: String(id),
      refId: input.refId,
      state,
      filledQuantity,
      averagePrice,
      raw: body
    };
  }

  /**
   * Side-effect-free order-path probe: submit a 1-share limit PREVIEW. A 200 with a structured
   * validation/BP error means the OMS is reachable (ok). HTTP 5xx / "backend" / "unexpected
   * (server) error" means paper/live OMS is down — the case that was burning strategy LLM runs
   * on VA93389646. Base throttle is once per 2 minutes per account; a failing probe backs off
   * exponentially (see tradierProbeTtlMs) so a sustained condition does not re-probe (and the
   * caller does not re-warn) every single 60s scheduler tick — see tradierProbeCache doc comment.
   * `retryTransient: true` is safe here specifically because `preview: "true"` makes this call
   * side-effect-free; a retried real order placement elsewhere in this file never opts in.
   */
  async probeOrderCapability(accountNumber: string): Promise<{ ok: boolean; reason?: string }> {
    const key = `${this.baseUrl}|${accountNumber}`;
    const cached = tradierProbeCache.get(key);
    if (cached) {
      // Back off only FAILED probes (2026-09-07 fix). Exponential backoff applied to a healthy
      // streak too would let a stale "ok" result ride all the way to the 60-minute ceiling; if
      // the order path then actually went down, checkBrokerHealth could keep accepting that
      // stale success for up to an hour instead of catching it within the intended 2-minute
      // base window. Successful results always use the base TTL; only a failing streak backs off.
      const ttlMs = cached.ok ? TRADIER_PROBE_BASE_TTL_MS : tradierProbeTtlMs(cached.streak);
      if (Date.now() - cached.at < ttlMs) {
        return { ok: cached.ok, reason: cached.reason };
      }
    }
    const remember = (ok: boolean, category: TradierProbeCategory, reason?: string): { ok: boolean; reason?: string } => {
      const streak = cached && cached.ok === ok && cached.category === category ? cached.streak + 1 : 0;
      tradierProbeCache.set(key, { at: Date.now(), ok, reason, category, streak });
      return { ok, reason };
    };
    try {
      await this.trackHealth(
        () =>
          this.request<{ order?: Record<string, unknown> }>("POST", `/accounts/${accountNumber}/orders`, {
            form: {
              class: "equity",
              symbol: "AAPL",
              side: "buy",
              quantity: "1",
              type: "limit",
              duration: "day",
              price: "1.00",
              preview: "true"
            }
          }),
        { retryTransient: true }
      );
      // Preview accepted with result — OMS up.
      return remember(true, "capability_ok");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // 5xx / backend / "unexpected error" OR "unexpected server error" — Tradier has been seen
      // to answer with BOTH wordings; the old `/unexpected error/i` alternative alone missed the
      // "server" variant entirely, which is why this bucket previously undercounted and nearly
      // every real server-side failure fell through to the generic "unclassified" branch below.
      const isServerError = /HTTP 5\d\d|\bbackend\b|unexpected\s+(?:server\s+)?error|OmsUnavailable|OmsInternalError/i.test(msg);
      // Structured OMS rejections prove the order path is alive (account just can't afford /
      // validate this probe). Treat as healthy order capability.
      if (
        /buying power|InitialMargin|MaintenanceMargin|OrderQuantity|LimitPrice|IncorrectOrder|not enough|day.?trad|margin|AccountDisabled|TradingDenied|AssetTrading|pdt/i.test(
          msg
        ) &&
        !isServerError
      ) {
        return remember(true, "capability_ok");
      }
      if (isServerError) {
        const reason = `Tradier order path unavailable: ${msg.slice(0, 220)}`;
        return remember(false, "server_error", reason);
      }
      if (isAbortOrTimeoutError(error)) {
        const reason = `Tradier order capability probe timed out: ${msg.slice(0, 220)}`;
        return remember(false, "timeout", reason);
      }
      if (isTransientNetworkError(error)) {
        const reason = `Tradier order capability probe failed (network): ${msg.slice(0, 220)}`;
        return remember(false, "connectivity", reason);
      }
      // Unrecognized failure shape — kept as its own category rather than folded into
      // "connectivity" so a genuinely new Tradier error string stays visible as such.
      const reason = `Tradier order capability probe failed: ${msg.slice(0, 220)}`;
      return remember(false, "unclassified", reason);
    }
  }

  async cancelEquityOrder(accountNumber: string, orderId: string): Promise<ExecutedOrder> {
    const body = await this.trackHealth(() =>
      this.request<{ order?: Record<string, unknown> }>("DELETE", `/accounts/${accountNumber}/orders/${orderId}`)
    );
    // Tradier's DELETE returns status "ok" = the cancel REQUEST was accepted (async), not a confirmed
    // terminal state — the order transitions to "canceled" only once the broker confirms it dead.
    // Normalize the bare "ok" (which no broker-side.ts state check recognizes) to "pending_cancel", a
    // state isLiveOrderState still treats as live: a cancel-requested order can still fill until the
    // broker confirms it dead, so protection/coverage must keep counting it. A real terminal status
    // passes through verbatim.
    const raw = String(body.order?.status ?? "");
    const state = raw && raw.toLowerCase() !== "ok" ? raw : "pending_cancel";
    return {
      orderId,
      refId: crypto.randomUUID(),
      state,
      raw: body
    };
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
    const { parseOccSymbol } = await import("./option-orders");
    const parsed = parseOccSymbol(input.occSymbol);
    const underlying = parsed?.underlyingSymbol ?? input.occSymbol.slice(0, 4);

    const form: Record<string, string> = {
      class: "option",
      symbol: underlying,
      option_symbol: input.occSymbol,
      side: input.intent,
      quantity: String(Math.max(1, Math.round(input.quantity))),
      type: input.type === "limit" ? "limit" : "market",
      duration: input.timeInForce === "gtc" ? "gtc" : "day",
      tag: input.refId
    };
    if (input.type === "limit" && input.limitPrice != null) {
      form.price = input.limitPrice.toFixed(2);
    }

    const body = await this.trackHealth(() =>
      this.request<{ order?: Record<string, unknown> }>("POST", `/accounts/${input.accountNumber}/orders`, { form })
    );

    const id = body.order?.id ?? body.order?.order_id ?? input.refId;
    const state = String(body.order?.status ?? "pending");
    return {
      orderId: String(id),
      refId: input.refId,
      state,
      filledQuantity: input.quantity,
      averagePrice: input.limitPrice,
      raw: body
    };
  }

  async cancelOptionOrder(accountNumber: string, orderId: string): Promise<ExecutedOrder> {
    return this.cancelEquityOrder(accountNumber, orderId);
  }

  // Identifies and cancels a bracket's (otoco/oto) still-resting sibling legs given the ORIGINAL
  // entry order's own container ID. Reuses equityRowsFromTradierOrder — the SAME leg-flattening
  // helper getEquityOrders already relies on for coverage — so this shares its exact (and, per that
  // function's own note, still webhook/live-unverified) understanding of Tradier's multi-leg
  // response shape: a resting otoco/oto container's `leg` array holds ONLY the take-profit/stop-loss
  // EXIT legs (per that function's own doc comment and its pre-existing getEquityOrders test) — the
  // entry itself is not one of the container's enumerated legs, so no entry-vs-sibling disambiguation
  // is needed here; the terminal-state check below is sufficient.
  //
  // A container whose own `class` IS "equity" means no bracket was ever attached to this order in
  // the first place (e.g. Tradier's market-type-entry fallback in placeEquityOrder, where the
  // tracked `opening_order_id` still gets recorded even though no bracket exists — see
  // performance.ts's comment on that). In that case equityRowsFromTradierOrder would return the
  // entry order ITSELF as a pseudo-"leg" (its `[itself]` fallback for plain equity orders) — treating
  // that as a cancellable sibling would wrongly cancel the entry order, so this is special-cased to
  // a no-op (adversarial review of PR #1661, 2026-07-16).
  async cancelBracketSiblingLegs(accountNumber: string, originalOrderId: string): Promise<{ cancelledOrderIds: string[] }> {
    let body: { order?: Record<string, unknown> };
    try {
      body = await this.trackHealth(
        () =>
          this.request<{ order?: Record<string, unknown> }>("GET", `/accounts/${accountNumber}/orders/${originalOrderId}`),
        { retryTransient: true }
      );
    } catch (error) {
      // "Order gone" means nothing to tear down, safe to resolve as done — Tradier surfaces this
      // TWO ways: a genuine HTTP 404 (this.request's `!response.ok` branch), or a 200 response with
      // its own `{errors: {error: "not found"}}` validation envelope (this.request's second throw
      // path, which carries no HTTP-status prefix at all — see formatTradierError). Any OTHER
      // failure (network, rate-limit, 5xx, an unrelated validation error) is transient/real and must
      // propagate so reconcilePendingBracketTeardowns' bounded-retry sweep actually retries it,
      // instead of the row being silently and permanently dropped on the first hiccup.
      if (error instanceof Error && (/Tradier HTTP 404/.test(error.message) || /not found/i.test(error.message))) {
        return { cancelledOrderIds: [] };
      }
      throw error;
    }
    const container = body.order;
    if (!container) return { cancelledOrderIds: [] };
    if (String(container.class ?? "").toLowerCase() === "equity") {
      // No bracket was ever attached to this order — nothing to tear down, and this must never be
      // treated as "cancel the entry itself."
      return { cancelledOrderIds: [] };
    }
    const cancelledOrderIds: string[] = [];
    for (const legRow of equityRowsFromTradierOrder(container)) {
      const legId = legRow.id != null ? String(legRow.id) : undefined;
      if (!legId) continue;
      const legState = String(legRow.status ?? "");
      if (isRejectedOrCanceledState(legState) || legState.toLowerCase() === "filled") continue;
      try {
        await this.cancelEquityOrder(accountNumber, legId);
        cancelledOrderIds.push(legId);
      } catch {
        // best-effort — a leg that filled/cancelled between the fetch above and this cancel is
        // fine to skip; Tradier's own OCO cascade may have already resolved it
      }
    }
    return { cancelledOrderIds };
  }
}

// Flatten a raw Tradier order row into the EQUITY rows it contributes to coverage/dashboard state.
//  - A plain equity order returns [itself].
//  - A multi-leg advanced order (OTOCO/OCO/OTO/combo/multileg) is reported by Tradier as a CONTAINER
//    whose own `class` is NOT "equity", with the individual legs nested under a `leg` array. A
//    protective EQUITY stop/limit leg a user placed from Tradier's own OCO/OTOCO UI lives there, so
//    without surfacing it that resting exit is invisible to getEquityOrders coverage — exactly the
//    double-exit hole. Each leg carries its own id/side/type/status/price; when a leg omits the
//    symbol/tag/dates the container's are inherited. Only class-"equity" legs are surfaced.
//  - Anything else (a lone option/combo order with no equity legs) returns [] and is dropped.
// NOTE: the nested-`leg` shape follows Tradier's documented advanced-order response; it has not been
// verified against a live multi-leg account and may need a field-name tweak once one is available.
export function equityRowsFromTradierOrder(row: Record<string, unknown>): Record<string, unknown>[] {
  if (String(row.class ?? "").toLowerCase() === "equity") return [row];
  const legField = row.leg ?? row.legs;
  if (legField === undefined || legField === null) return [];
  const out: Record<string, unknown>[] = [];
  for (const leg of arr<Record<string, unknown>>(legField)) {
    if (String(leg.class ?? "").toLowerCase() !== "equity") continue;
    out.push({
      // Container-level fallbacks first, overlaid by the leg's own fields (leg wins).
      symbol: row.symbol,
      status: row.status,
      create_date: row.create_date,
      transaction_date: row.transaction_date,
      duration: row.duration,
      tag: row.tag,
      ...leg
    });
  }
  return out;
}

// Map a raw Tradier order object to our EquityOrder. State is stored RAW (broker-side.ts normalizes).
export function mapTradierOrder(o: Record<string, unknown>): EquityOrder {
  return {
    id: String(o.id),
    symbol: fromTradierSymbol(String(o.symbol)),
    side: mapTradierSideRead(o.side),
    type: mapTradierTypeRead(o.type),
    state: String(o.status),
    quantity: optionalNumber(o.quantity),
    filledQuantity: optionalNumber(o.exec_quantity),
    averagePrice: optionalNumber(o.avg_fill_price),
    limitPrice: optionalNumber(o.price),
    stopPrice: optionalNumber(o.stop_price),
    timeInForce: optionalString(o.duration),
    createdAt: String(o.create_date),
    updatedAt: optionalString(o.transaction_date),
    clientOrderId: optionalString(o.tag),
    placedAgent: "tradier"
  };
}

// Join a Tradier error envelope ({ errors: { error: [...] | "msg" } }) into a single message.
function formatTradierError(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";
  const errors = (parsed as Record<string, unknown>).errors;
  if (!errors) return "";
  if (typeof errors === "string") return errors;
  if (typeof errors === "object") {
    const err = (errors as Record<string, unknown>).error;
    if (Array.isArray(err)) return err.map((e) => String(e)).join("; ");
    if (err != null) return String(err);
  }
  return "";
}

export function parseOccSymbol(occ: string): {
  underlyingSymbol: string;
  expirationDate: string;
  optionType: "call" | "put";
  strikePrice: number;
} {
  const clean = occ.replace(/\s+/g, "").toUpperCase();
  const match = clean.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
  if (!match) {
    return {
      underlyingSymbol: clean,
      expirationDate: "",
      optionType: "call",
      strikePrice: 0
    };
  }
  const [, underlying, yymmdd, cp, strikeDigits] = match;
  const yy = yymmdd.slice(0, 2);
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);
  const expirationDate = `20${yy}-${mm}-${dd}`;
  const optionType = cp === "P" ? ("put" as const) : ("call" as const);
  const strikePrice = Number(strikeDigits) / 1000;
  return { underlyingSymbol: underlying, expirationDate, optionType, strikePrice };
}
