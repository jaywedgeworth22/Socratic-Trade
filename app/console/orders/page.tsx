"use client";

/** Orders — working orders at the broker for the active account, with
 *  stale-limit detection (the SERVER's rule, mirrored exactly: a limit or
 *  stop-limit order still working with an unfilled remainder after the
 *  policy's stale threshold), a replace-at-market flow against
 *  POST /api/orders/replace-market, cancel against POST /api/orders/cancel,
 *  and a short history of finished orders. Everything renders only what the
 *  snapshot actually has — missing data is "—", never invented. */

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ORDER_ROLE_LABELS, type OrderRole } from "@/lib/order-role";
import type { EquityOrder, EquityPosition } from "@/lib/types";
import { deriveReality } from "../lib/derive";
import { cx, fmtExact, fmtMoney, fmtPct, fmtQty, fmtSignedMoney, EM_DASH, SENTENCE_GAP } from "../lib/format";
import { CONSOLE_PAGE_WIDTH } from "../lib/page-width";
import { useConsoleData } from "../lib/useConsoleData";
import { Ago, Btn, Card, Chip, Dash, Empty, SignedText, type ChipTone } from "../ui/primitives";
import { SymbolButton } from "../ui/symbol-drilldown";
import { CancelOrderSheet } from "./cancel-sheet";
import { ReplaceMarketSheet } from "./replace-market-sheet";
import { DEEP_LINK_FOCUS_CLASS, readSymbolQuery, scrollDeepLinkTarget, symbolElementId } from "../lib/deep-link-focus";
import {
  closingOrderPnl,
  deriveOpenOrders,
  effectiveOrderPrice,
  fmtAge,
  fmtMinutes,
  isReplaceableType,
  lastScanPrice,
  matchPosition,
  orderTypeLabel,
  readableState,
  staleThresholdMinutes,
  storedPriceFor,
  terminalOrders,
  type OpenOrderRow,
  type StoredPrice
} from "./lib";

const SIDE_LABEL: Record<string, string> = { buy: "BUY", sell: "SELL", short: "SHORT", cover: "COVER" };

const SIDE_TITLE: Record<string, string> = {
  buy: "Buy — opens or adds to a long position.",
  sell: "Sell — closes some or all of a long position.",
  short: "Short — sells borrowed shares to open a short position.",
  cover: "Cover — buys back borrowed shares to close a short position."
};

const TYPE_TITLE: Record<string, string> = {
  market: "Market — executes at whatever price the market gives; no price cap.",
  limit: "Limit — executes only at the limit price or better; may sit unfilled if the market moves away.",
  stop_market: "Stop — becomes a market order once the stop price trades.",
  stop_limit: "Stop-limit — becomes a limit order once the stop price trades; may sit unfilled after triggering."
};

const TIF_TITLE: Record<string, string> = {
  gtc: "Good-til-cancelled — rests until it fills or is cancelled.",
  gfd: "Good-for-day — expires at the end of the trading day if unfilled.",
  day: "Day order — expires at the end of the trading day if unfilled.",
  ioc: "Immediate-or-cancel — fills what it can immediately, cancels the rest.",
  fok: "Fill-or-kill — fills completely and immediately, or cancels.",
  opg: "At-the-open — executes in the opening auction only.",
  cls: "At-the-close — executes in the closing auction only."
};

function tifLabel(timeInForce: string | undefined): string | null {
  const tif = String(timeInForce ?? "").trim();
  return tif ? tif.toUpperCase() : null;
}

function tifTitle(timeInForce: string | undefined): string {
  return TIF_TITLE[String(timeInForce ?? "").trim().toLowerCase()] ?? "Time-in-force reported by the broker.";
}

function finiteNum(v: number | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Every piece derived once per row and shared between the desktop table row
 *  and the mobile card, so the two surfaces can never drift apart. */
function deriveOrderRowView(
  row: OpenOrderRow,
  quotes: Parameters<typeof lastScanPrice>[0],
  positions: EquityPosition[] | undefined,
  fallbackPrices: Record<string, StoredPrice> | undefined,
  halted: boolean,
  noAccount: boolean,
  live: boolean
) {
  const order = row.order;
  const scan = lastScanPrice(quotes, order.symbol);
  const position = matchPosition(positions, order.symbol);
  // "Last price" prefers the held position's own mark over the market-scan cache — see
  // effectiveOrderPrice for why (same snapshot, can't be stale in a way the scan isn't).
  // Final fallback: the durable per-symbol store's last-known price (age-tagged), so the
  // Replace-at-market decision is never staring at a bare "—" for an unheld, unscanned symbol.
  const price = effectiveOrderPrice(position, scan, storedPriceFor(fallbackPrices, order.symbol));
  const limit = finiteNum(order.limitPrice);
  const stop = finiteNum(order.stopPrice);
  // Gap between the latest known price and the resting limit — how far the market
  // sits from the order. Positive = market above the limit.
  const limitGapPct = limit !== undefined && limit > 0 && price ? ((price.price - limit) / limit) * 100 : undefined;
  const tif = tifLabel(order.timeInForce);
  const filled = order.filledQuantity ?? 0;
  const showReplace = isReplaceableType(order.type) && row.remaining > 0;
  const replaceEnabled = row.stale && !halted && !noAccount;
  const replaceTitle = !row.stale
    ? row.thresholdMinutes > 0
      ? `Becomes available once the order has been working ${row.thresholdMinutes} minutes without filling (your policy's stale threshold) — currently ${fmtMinutes(row.ageMinutes)}.`
      : "Stale-limit detection is disabled (policy stale threshold is 0), so the server refuses market replacements."
    : halted
      ? "Start the system first — replacing places a NEW order, which the server refuses while everything is stopped.  Cancelling stays available."
      : noAccount
        ? "Market replacement needs a broker-backed Paper or Live account; no account is connected."
        : `Cancel this stale ${orderTypeLabel(order.type)} order and submit the remaining ${fmtQty(row.remaining)} shares as a market order${live ? " — typed broker confirmation required" : ""}.`;
  // Only rows that would CLOSE/REDUCE a held position (sell-of-long, cover-of-short, a
  // bracket "held" exit leg that matches) get an estimate; opening orders never do.
  const estPnl = closingOrderPnl(order, row.remaining, position, price);
  return { order, scan, price, limit, stop, limitGapPct, tif, filled, showReplace, replaceEnabled, replaceTitle, estPnl };
}

/** Price + a source/age suffix (the td/div's own title keeps the fuller hover
 *  explanation; Ago adds the exact timestamp on its own hover). A held
 *  position's own mark carries no separate "as of" — it's the same snapshot
 *  the rest of the row came from — so it gets a "held mark" tag instead of a
 *  quote age. The vs-limit gap, when there is one, stays on its own line. */
function OrderPriceInfo({ view }: { view: ReturnType<typeof deriveOrderRowView> }) {
  return (
    <>
      {view.price ? fmtMoney(view.price.price) : <Dash />}
      {view.price?.source === "position" && (
        <span className="ml-1 text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-faint)]">· held mark</span>
      )}
      {view.price?.source === "scan" && view.price.asOf && (
        <span className="ml-1 text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-faint)]">
          · quote <Ago iso={view.price.asOf} />
        </span>
      )}
      {view.price?.source === "store" && fmtAge(view.price.asOf) && (
        <span
          className="ml-1 text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-faint)]"
          title={`Last stored price from the durable per-symbol store${view.price.provider ? ` (${view.price.provider})` : ""}, as of ${fmtExact(view.price.asOf)} — not a live quote.`}
        >
          · {fmtAge(view.price.asOf)} old
        </span>
      )}
      {view.limitGapPct !== undefined && (
        <span
          className="block text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
          title="How far the latest known price sits from the resting limit price.  Positive = market above the limit."
        >
          {fmtPct(view.limitGapPct, 1, true)} vs limit
        </span>
      )}
    </>
  );
}

/** Replace/Cancel buttons, shared by the table row and the mobile card. The
 *  max-lg bump gives the ~26px desktop buttons a ~40px tap target below the
 *  lg breakpoint — the width the mobile card list takes over at. */
function OrderRowActions({
  view,
  onReplace,
  onCancel
}: {
  view: ReturnType<typeof deriveOrderRowView>;
  onReplace: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex justify-end gap-1.5 whitespace-nowrap">
      {view.showReplace && (
        <Btn
          size="sm"
          variant="outline"
          disabled={!view.replaceEnabled}
          onClick={onReplace}
          title={view.replaceTitle}
          className="max-lg:min-h-10"
          align="right"
        >
          Replace at market
        </Btn>
      )}
      <Btn
        size="sm"
        variant="dangerOutline"
        onClick={onCancel}
        title="Ask the broker to cancel this order.  Risk-reducing — allowed even while the system is stopped; fills that already happened stand."
        className="max-lg:min-h-10"
        align="right"
      >
        Cancel
      </Btn>
    </div>
  );
}

const STATE_TONE: Record<string, ChipTone> = {
  filled: "pos",
  partially_filled: "accent",
  new: "accent",
  open: "accent",
  accepted: "accent",
  confirmed: "accent",
  queued: "accent",
  submitted: "accent",
  unconfirmed: "accent",
  pending_new: "accent",
  held: "warn",
  suspended: "warn",
  pending_cancel: "warn",
  pending_replace: "warn",
  done_for_day: "warn",
  stopped: "warn",
  calculated: "warn",
  cancelled: "muted",
  canceled: "muted",
  expired: "muted",
  replaced: "muted",
  rejected: "neg",
  failed: "neg"
};

function stateTone(state: string | undefined): ChipTone {
  return STATE_TONE[String(state ?? "").trim().toLowerCase()] ?? "muted";
}

/** Tone for the order-role badge — see src/lib/order-role.ts's classifyOrderRole. A protective
 *  stop (fixed or trailing) is the "correct behavior at rest" case the badge exists for, so it
 *  gets the calm info tone rather than a warning; bracket_stop_loss and replacement get warn
 *  since both mean "something is actively guarding against loss right now". */
const ROLE_TONE: Record<OrderRole, ChipTone> = {
  protective_stop: "info",
  trailing_stop: "info",
  bracket_take_profit: "pos",
  bracket_stop_loss: "warn",
  entry: "accent",
  exit: "accent",
  synthetic_stop: "info",
  replacement: "warn",
  external: "muted"
};

/** Role badge + one-sentence whyResting, shared by the desktop row and the mobile card. Renders
 *  nothing when the order carries no `role` (e.g. the snapshot couldn't resolve an account
 *  number to classify against) — never a placeholder badge for missing data. `flex-wrap` keeps
 *  the badge and its explanation from overflowing at ~390px widths. */
function OrderRoleBadge({ order, className }: { order: EquityOrder; className?: string }) {
  if (!order.role) return null;
  return (
    <div className={cx("flex flex-wrap items-center gap-1.5", className)}>
      <Chip tone={ROLE_TONE[order.role]} title={order.whyResting ?? ORDER_ROLE_LABELS[order.role]}>
        {ORDER_ROLE_LABELS[order.role]}
      </Chip>
      {order.whyResting && (
        <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">{order.whyResting}</span>
      )}
    </div>
  );
}

function isExit(side: string): boolean {
  return side === "sell" || side === "cover";
}

/** "10 sh" / "~$500" / "—" — whichever the broker order actually carries. */
function sizeText(order: EquityOrder): string {
  if (typeof order.quantity === "number" && Number.isFinite(order.quantity)) return `${fmtQty(order.quantity)} sh`;
  if (typeof order.dollarAmount === "number" && Number.isFinite(order.dollarAmount))
    return `~${fmtMoney(order.dollarAmount)}`;
  return EM_DASH;
}

/** What actually EXECUTED, distinct from sizeText (what was PLACED) — "8 sh · $412.16" when the
 *  broker reports both a filled quantity and an average price, "8 sh" alone when only the
 *  quantity is known. Undefined (never rendered) when nothing filled — rejected, expired, or
 *  cancelled before any execution — so the finished-orders list never shows a false "0 sh". */
function executedText(order: EquityOrder): string | undefined {
  const filled = order.filledQuantity;
  if (typeof filled !== "number" || !Number.isFinite(filled) || filled <= 0) return undefined;
  const avg = order.averagePrice;
  const notional = typeof avg === "number" && Number.isFinite(avg) ? fmtMoney(avg * filled) : undefined;
  return notional ? `${fmtQty(filled)} sh · ${notional} executed` : `${fmtQty(filled)} sh executed`;
}

export default function OrdersPage() {
  return (
    <Suspense fallback={null}>
      <OrdersPageInner />
    </Suspense>
  );
}

function OrdersPageInner() {
  const searchParams = useSearchParams();
  const { snapshot, refresh } = useConsoleData();
  const [replaceRow, setReplaceRow] = useState<OpenOrderRow | null>(null);
  const [cancelRow, setCancelRow] = useState<OpenOrderRow | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Ages advance between the 15s snapshot polls.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  const rows = useMemo(
    () => (snapshot ? deriveOpenOrders(snapshot.orders ?? [], snapshot.policy, new Date(nowMs)) : []),
    [snapshot, nowMs]
  );
  const history = useMemo(() => (snapshot ? terminalOrders(snapshot.orders ?? [], 20) : []), [snapshot]);
  const focusedSymbol = readSymbolQuery(searchParams.get("symbol"));
  const firstFocusedOpenId = useMemo(() => {
    if (!focusedSymbol) return undefined;
    return rows.find((row) => row.order.symbol.toUpperCase() === focusedSymbol)?.order.id;
  }, [rows, focusedSymbol]);
  const firstFocusedHistoryId = useMemo(() => {
    if (!focusedSymbol || firstFocusedOpenId) return undefined;
    return history.find((order) => order.symbol.toUpperCase() === focusedSymbol)?.id;
  }, [history, focusedSymbol, firstFocusedOpenId]);

  useEffect(() => {
    if (!focusedSymbol) return;
    scrollDeepLinkTarget([symbolElementId(focusedSymbol, "card"), symbolElementId(focusedSymbol)]);
  }, [focusedSymbol, firstFocusedOpenId, firstFocusedHistoryId]);

  if (!snapshot) return null;

  const reality = deriveReality(snapshot);
  const noAccount = reality.tone === "none";
  const live = reality.tone === "live";
  const halted = snapshot.policy.systemState === "halted";
  const thresholdMinutes = staleThresholdMinutes(snapshot.policy);
  const staleCount = rows.filter((r) => r.stale).length;
  const quotes = snapshot.latestStrategyRun?.marketScan?.quotesBySymbol;
  const fallbackPrices = snapshot.orderPriceFallbacks;
  const multiAccount = snapshot.connectedAccounts.length > 1;

  const doRefresh = async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className={`${CONSOLE_PAGE_WIDTH} flex flex-col gap-4`}>
      {/* Title + Refresh on ONE row (owner mobile punch list 2026-08-08). The env and
          account chips that used to sit here duplicated the top banner / account scope
          switcher, so they're gone. */}
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">Orders</h1>
        <Btn
          size="sm"
          onClick={() => void doRefresh()}
          disabled={refreshing}
          title="Fetch the latest orders from the broker now.  The console also refreshes automatically every 15 seconds."
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </Btn>
      </div>

      <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Orders originate from approved proposals — there is no manual order-entry here.
        {multiAccount && (
          <>
            {SENTENCE_GAP}Showing the active account only — switch the account scope (top bar) to see another
            account&apos;s orders.
          </>
        )}
      </p>

      {staleCount > 0 && (
        <div
          className="rounded-control border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] px-3 py-2 text-[length:var(--con-fs-sm)]"
          title={`Your policy's stale threshold is ${thresholdMinutes} minutes (Settings → "Stale limit alert").`}
        >
          <span className="font-semibold text-[color:var(--con-warn)]">
            {staleCount} limit order{staleCount === 1 ? "" : "s"} working longer than {thresholdMinutes} minutes without
            filling.
          </span>{" "}
          <span className="text-[color:var(--con-muted)]">
            The market may have moved away from the limit price.  Review each: keep waiting, cancel, or replace the
            remainder at market.
          </span>
        </div>
      )}

      <Card title={`Open Orders (${rows.length})`} padded={false}>
        {rows.length === 0 ? (
          <Empty>
            {noAccount
              ? "No working orders — connect a broker Paper or Live account first. Working orders appear once an account is active."
              : "No working orders at the broker.  When you or the strategy place a limit or stop order, it appears here until it fills, expires, or is cancelled."}
          </Empty>
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="con-table">
                <thead>
                  <tr>
                    <th title="Ticker — click a symbol to open its price history and details.">Symbol</th>
                    <th title="Order direction: buy, sell, short, or cover.">Side</th>
                    <th title="Order type.  Limit and stop-limit orders can sit unfilled and go stale; market orders execute immediately.">
                      Type
                    </th>
                    <th className="num" title="Order size as the broker holds it: share quantity, or an approximate dollar amount for notional orders.  Partial fills show how much already executed.">
                      Size
                    </th>
                    <th className="num" title="Resting limit price and/or stop trigger price the broker holds for this order.  '—' when the broker reported neither (e.g. a market order).">
                      Limit / Stop
                    </th>
                    <th className="num" title="Latest price this app has for the symbol: this account's OWN held mark (from the same snapshot as the order) when the symbol is currently held, else the most recent market scan (can be minutes old), else the durable per-symbol store's last-known price (age-tagged; can be hours or days old).  '—' only when none is available.  Where the order has a limit price, the gap between this price and the limit is shown underneath.">
                      Last price
                    </th>
                    <th title="Time-in-force: how long the order stays working.  DAY/GFD expires at market close; GTC rests until cancelled.">
                      TIF
                    </th>
                    <th
                      title={
                        thresholdMinutes > 0
                          ? `How long the order has been working.  Limit/stop-limit orders older than your ${thresholdMinutes}-minute policy threshold with an unfilled remainder are flagged stale.`
                          : "How long the order has been working.  Stale-limit detection is disabled (policy stale threshold is 0)."
                      }
                    >
                      Age
                    </th>
                    <th title="The order's state as last reported by the broker.">Status</th>
                    <th className="num" title="Estimated realized P/L if this order's unfilled remainder closed right now at the last known price: only shown for orders that would REDUCE or CLOSE a held position (sell-of-long, cover-of-short, a bracket exit leg) — never for an order that opens or adds to a position.">
                      Est. P/L
                    </th>
                    <th title="Actions: replace a stale limit order's remainder at market, or cancel the order.">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <OpenOrderTr
                      key={row.order.id}
                      row={row}
                      quotes={quotes}
                      positions={snapshot.positions}
                      fallbackPrices={fallbackPrices}
                      companyName={snapshot.symbolMetaBySymbol?.[row.order.symbol]?.companyName}
                      halted={halted}
                      noAccount={noAccount}
                      live={live}
                      focused={row.order.id === firstFocusedOpenId}
                      onReplace={() => setReplaceRow(row)}
                      onCancel={() => setCancelRow(row)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-col gap-2 px-2 pb-3 pt-2 lg:hidden">
              {rows.map((row) => (
                <OpenOrderCard
                  key={row.order.id}
                  row={row}
                  quotes={quotes}
                  positions={snapshot.positions}
                  fallbackPrices={fallbackPrices}
                  companyName={snapshot.symbolMetaBySymbol?.[row.order.symbol]?.companyName}
                  halted={halted}
                  noAccount={noAccount}
                  live={live}
                  focused={row.order.id === firstFocusedOpenId}
                  onReplace={() => setReplaceRow(row)}
                  onCancel={() => setCancelRow(row)}
                />
              ))}
            </div>
          </>
        )}
      </Card>

      <Card title="Recent Finished Orders" padded={false}>
        {history.length === 0 ? (
          <Empty>
            {noAccount
              ? "No broker order history — connect a broker account to see finished orders."
              : "No finished orders reported by the broker yet."}
          </Empty>
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="con-table">
                <thead>
                  <tr>
                    <th title="Ticker — click a symbol to open its price history and details.">Symbol</th>
                    <th title="Order direction: buy, sell, short, or cover.">Side</th>
                    <th title="Order type as placed.">Type</th>
                    <th title="Time-in-force as placed.  DAY/GFD expires at market close; GTC rests until cancelled.">TIF</th>
                    <th className="num" title="Order size: share quantity or approximate dollar amount.">Size</th>
                    <th className="num" title="Average price the broker reports for the executed part; '—' when nothing executed.">
                      Avg fill
                    </th>
                    <th title="Final state the broker reported.">Status</th>
                    <th title="When the broker last updated the order.">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((order) => (
                    <tr
                      key={order.id}
                      id={order.id === firstFocusedHistoryId ? symbolElementId(order.symbol.toUpperCase()) : undefined}
                      className={order.id === firstFocusedHistoryId ? DEEP_LINK_FOCUS_CLASS : undefined}
                    >
                      <td>
                        <SymbolButton symbol={order.symbol} />
                      </td>
                      <td
                        className={isExit(order.side) ? "font-semibold text-[color:var(--con-warn)]" : "font-semibold"}
                        title={SIDE_TITLE[order.side] ?? "Order direction."}
                      >
                        {SIDE_LABEL[order.side] ?? String(order.side).toUpperCase()}
                      </td>
                      <td title={TYPE_TITLE[String(order.type)] ?? "Order type."}>{orderTypeLabel(order.type)}</td>
                      <td title={tifTitle(order.timeInForce)}>{tifLabel(order.timeInForce) ?? <Dash />}</td>
                      <td className="num con-num" title="Order size as placed.">
                        {sizeText(order)}
                        {executedText(order) && (
                          <span className="block text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                            {executedText(order)}
                          </span>
                        )}
                      </td>
                      <td className="num con-num" title="Average executed price reported by the broker.">
                        {typeof order.averagePrice === "number" && Number.isFinite(order.averagePrice) ? (
                          fmtMoney(order.averagePrice)
                        ) : (
                          <Dash />
                        )}
                      </td>
                      <td>
                        <Chip tone={stateTone(order.state)} title="Final state the broker reported for this order.">
                          {readableState(order.state)}
                        </Chip>
                      </td>
                      <td className="whitespace-nowrap text-[color:var(--con-faint)]">
                        <Ago iso={order.updatedAt ?? order.createdAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-col gap-2 px-2 pb-3 pt-2 lg:hidden">
              {history.map((order) => (
                <FinishedOrderCard
                  key={order.id}
                  order={order}
                  focused={order.id === firstFocusedHistoryId}
                />
              ))}
            </div>
            <p className="px-4 py-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              Latest {history.length} finished orders, straight from the broker&apos;s order list. The full story —
              fills, runs, and alerts — lives on the Activity screen.
            </p>
          </>
        )}
      </Card>

      {replaceRow && (
        <ReplaceMarketSheet row={replaceRow} reality={reality} open onClose={() => setReplaceRow(null)} />
      )}
      {cancelRow && <CancelOrderSheet row={cancelRow} reality={reality} open onClose={() => setCancelRow(null)} />}
    </div>
  );
}

interface OrderRowProps {
  row: OpenOrderRow;
  quotes: Parameters<typeof lastScanPrice>[0];
  positions: EquityPosition[] | undefined;
  fallbackPrices: Record<string, StoredPrice> | undefined;
  companyName?: string;
  halted: boolean;
  noAccount: boolean;
  live: boolean;
  focused?: boolean;
  onReplace: () => void;
  onCancel: () => void;
}

function OpenOrderTr({ row, quotes, positions, fallbackPrices, companyName, halted, noAccount, live, focused, onReplace, onCancel }: OrderRowProps) {
  const view = deriveOrderRowView(row, quotes, positions, fallbackPrices, halted, noAccount, live);
  const order = view.order;

  return (
    <tr
      id={focused ? symbolElementId(order.symbol.toUpperCase()) : undefined}
      className={cx(row.stale && "bg-[color:var(--con-warn-soft)]", focused && DEEP_LINK_FOCUS_CLASS)}
    >
      <td>
        <SymbolButton symbol={order.symbol} />
        {companyName && (
          <span className="block max-w-44 truncate pl-[26px] text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            {companyName}
          </span>
        )}
      </td>
      <td
        className={isExit(order.side) ? "font-semibold text-[color:var(--con-warn)]" : "font-semibold"}
        title={SIDE_TITLE[order.side] ?? "Order direction."}
      >
        {SIDE_LABEL[order.side] ?? String(order.side).toUpperCase()}
      </td>
      <td title={TYPE_TITLE[String(order.type)] ?? "Order type."}>{orderTypeLabel(order.type)}</td>
      <td className="num con-num" title="Order size as the broker holds it; partial fills shown underneath.">
        {sizeText(order)}
        {view.filled > 0 && row.remaining > 0 && (
          <span className="block text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            {fmtQty(view.filled)} filled · {fmtQty(row.remaining)} left
          </span>
        )}
      </td>
      <td
        className="num con-num"
        title={
          view.limit !== undefined && view.stop !== undefined
            ? `Stop-limit: triggers at the ${fmtMoney(view.stop)} stop, then rests as a ${fmtMoney(view.limit)} limit.`
            : view.limit !== undefined
              ? "The limit price this order rests at, as the broker holds it."
              : view.stop !== undefined
                ? "The stop trigger price, as the broker holds it."
                : "The broker reported no limit or stop price for this order."
        }
      >
        {view.limit === undefined && view.stop === undefined ? (
          <Dash />
        ) : (
          <>
            {fmtMoney(view.limit ?? view.stop)}
            {view.limit !== undefined && view.stop !== undefined && (
              <span className="block text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                stop {fmtMoney(view.stop)}
              </span>
            )}
          </>
        )}
      </td>
      <td
        className="num con-num"
        title={
          view.price?.source === "position"
            ? "This account's own held mark for the symbol (marketValue / quantity), from the same snapshot as this order — not a live broker quote."
            : view.price?.source === "store"
              ? `Last stored price from the durable per-symbol store${view.price.provider ? ` (${view.price.provider})` : ""}${view.price.asOf ? `, as of ${fmtExact(view.price.asOf)}` : ""} — can be hours or days old; not a live quote.`
              : view.price
                ? `From the latest market scan${view.price.provider ? ` (${view.price.provider})` : ""}${view.price.asOf ? `, as of ${fmtExact(view.price.asOf)}` : ""} — not a live broker quote.`
                : "No held position, market scan, or stored price covers this symbol, so no price is available here."
        }
      >
        <OrderPriceInfo view={view} />
      </td>
      <td title={tifTitle(order.timeInForce)}>{view.tif ?? <Dash />}</td>
      <td className="whitespace-nowrap">
        <Ago iso={order.createdAt} />
        {row.stale && (
          <Chip
            tone="warn"
            className="ml-1.5"
            title={`Working ${fmtMinutes(row.ageMinutes)} without filling — past your ${row.thresholdMinutes}-minute stale threshold.  Heuristic, not an error: the market has likely moved away from the limit price, so it may never fill.  You can keep waiting, cancel, or replace the remainder at market.`}
          >
            stale {fmtMinutes(row.ageMinutes)}
          </Chip>
        )}
      </td>
      <td>
        <Chip tone={stateTone(order.state)} title="The order's state as last reported by the broker.">
          {readableState(order.state)}
        </Chip>
        <OrderRoleBadge order={order} className="mt-1 max-w-[220px]" />
      </td>
      <td className="num con-num" title="Estimated realized P/L if this order's unfilled remainder closed right now at the last known price.">
        {view.estPnl ? (
          <SignedText value={view.estPnl.pnl}>
            {fmtSignedMoney(view.estPnl.pnl)}
            <span className="block text-[length:var(--con-fs-xs)] font-normal">{fmtPct(view.estPnl.pnlPct, 1, true)}</span>
          </SignedText>
        ) : (
          <Dash />
        )}
      </td>
      <td>
        <OrderRowActions view={view} onReplace={onReplace} onCancel={onCancel} />
      </td>
    </tr>
  );
}

/** Mobile counterpart to `OpenOrderTr` — same derived view, same actions,
 *  laid out as a card: symbol/side/status up top, the load-bearing fields
 *  (size, limit/stop, last price, age) in a small grid, actions at the
 *  bottom. Shown lg:hidden while the table above is hidden below lg. */
function OpenOrderCard({ row, quotes, positions, fallbackPrices, companyName, halted, noAccount, live, focused, onReplace, onCancel }: OrderRowProps) {
  const view = deriveOrderRowView(row, quotes, positions, fallbackPrices, halted, noAccount, live);
  const order = view.order;
  return (
    <div
      id={focused ? symbolElementId(order.symbol.toUpperCase(), "card") : undefined}
      className={cx(
        "con-row flex flex-col gap-2 rounded-control border border-[color:var(--con-line)] p-3",
        row.stale && "bg-[color:var(--con-warn-soft)]",
        focused && DEEP_LINK_FOCUS_CLASS
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <SymbolButton symbol={order.symbol} />
          {companyName && <span className="block truncate text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">{companyName}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={isExit(order.side) ? "font-semibold text-[color:var(--con-warn)]" : "font-semibold"}
            title={SIDE_TITLE[order.side] ?? "Order direction."}
          >
            {SIDE_LABEL[order.side] ?? String(order.side).toUpperCase()}
          </span>
          <Chip tone={stateTone(order.state)} title="The order's state as last reported by the broker.">
            {readableState(order.state)}
          </Chip>
        </div>
      </div>
      <OrderRoleBadge order={order} />
      <div className="grid grid-cols-2 gap-2 text-[length:var(--con-fs-sm)]">
        <div className="rounded-control bg-[color:var(--con-surface-2)] px-1.5 py-0.5" title="Order size as the broker holds it; partial fills shown underneath.">
          <div className="flex justify-between items-baseline gap-0.5">
            <span className="text-[length:var(--con-fs-xs)] uppercase tracking-[0.06em] text-[color:var(--con-faint)]">Size</span>
            <div className="con-num truncate">
              {sizeText(order)}
              {view.filled > 0 && row.remaining > 0 && (
                <span className="ml-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">({fmtQty(view.filled)} filled)</span>
              )}
            </div>
          </div>
        </div>
        <div
          className="rounded-control bg-[color:var(--con-surface-2)] px-1.5 py-0.5"
          title={
            view.limit !== undefined && view.stop !== undefined
              ? `Stop-limit: triggers at the ${fmtMoney(view.stop)} stop, then rests as a ${fmtMoney(view.limit)} limit.`
              : view.limit !== undefined
                ? "The limit price this order rests at, as the broker holds it."
                : view.stop !== undefined
                  ? "The stop trigger price, as the broker holds it."
                  : "The broker reported no limit or stop price for this order."
          }
        >
          <div className="flex justify-between items-baseline gap-0.5">
            <span className="text-[length:var(--con-fs-xs)] uppercase tracking-[0.06em] text-[color:var(--con-faint)]">Limit / Stop</span>
            <div className="con-num truncate">{view.limit === undefined && view.stop === undefined ? <Dash /> : fmtMoney(view.limit ?? view.stop)}</div>
          </div>
        </div>
        <div
          className="rounded-control bg-[color:var(--con-surface-2)] px-1.5 py-0.5"
          title={
            view.price?.source === "position"
              ? "This account's own held mark for the symbol (marketValue / quantity), from the same snapshot as this order — not a live broker quote."
              : view.price?.source === "store"
                ? `Last stored price from the durable per-symbol store${view.price.provider ? ` (${view.price.provider})` : ""}${view.price.asOf ? `, as of ${fmtExact(view.price.asOf)}` : ""} — can be hours or days old; not a live quote.`
                : view.price
                  ? `From the latest market scan${view.price.provider ? ` (${view.price.provider})` : ""}${view.price.asOf ? `, as of ${fmtExact(view.price.asOf)}` : ""} — not a live broker quote.`
                  : "No held position, market scan, or stored price covers this symbol, so no price is available here."
          }
        >
          <div className="flex justify-between items-start gap-0.5">
            {/* "Last", not "Last price": the two-word label wrapped to a second line in this
                narrow card cell (owner mobile punch list 2026-08-08) — the hover keeps the
                full name, matching the one-line SIZE/AGE labels beside it. */}
            <span className="whitespace-nowrap text-[length:var(--con-fs-xs)] uppercase tracking-[0.06em] text-[color:var(--con-faint)]" title="Last price">Last</span>
            <div className="con-num text-right">
              <OrderPriceInfo view={view} />
            </div>
          </div>
        </div>
        <div
          className="rounded-control bg-[color:var(--con-surface-2)] px-1.5 py-0.5"
          title={
            row.thresholdMinutes > 0
              ? `How long the order has been working.  Limit/stop-limit orders older than your ${row.thresholdMinutes}-minute policy threshold with an unfilled remainder are flagged stale.`
              : "How long the order has been working.  Stale-limit detection is disabled (policy stale threshold is 0)."
          }
        >
          <div className="flex justify-between items-baseline gap-0.5">
            <span className="text-[length:var(--con-fs-xs)] uppercase tracking-[0.06em] text-[color:var(--con-faint)]">Age</span>
            <div className="con-num text-right">
              <Ago iso={order.createdAt} />
              {row.stale && (
                <Chip tone="warn" className="ml-1" title={`Working ${fmtMinutes(row.ageMinutes)} without filling — past your ${row.thresholdMinutes}-minute stale threshold.`}>
                  stale
                </Chip>
              )}
            </div>
          </div>
        </div>
        {view.estPnl && (
          <div
            className="col-span-2 rounded-control bg-[color:var(--con-surface-2)] px-1.5 py-0.5"
            title="Estimated realized P/L if this order's unfilled remainder closed right now at the last known price."
          >
            <div className="flex justify-between items-baseline gap-0.5">
              <span className="text-[length:var(--con-fs-xs)] uppercase tracking-[0.06em] text-[color:var(--con-faint)]">Est. P/L</span>
              <SignedText value={view.estPnl.pnl}>
                {fmtSignedMoney(view.estPnl.pnl)} ({fmtPct(view.estPnl.pnlPct, 1, true)})
              </SignedText>
            </div>
          </div>
        )}
      </div>
      <OrderRowActions view={view} onReplace={onReplace} onCancel={onCancel} />
    </div>
  );
}

/** Mobile counterpart to the finished-orders table row — read-only, so no
 *  actions row. */
function FinishedOrderCard({ order, focused }: { order: EquityOrder; focused?: boolean }) {
  return (
    <div
      id={focused ? symbolElementId(order.symbol.toUpperCase(), "card") : undefined}
      className={cx(
        "con-row flex flex-col gap-2 rounded-control border border-[color:var(--con-line)] p-3",
        focused && DEEP_LINK_FOCUS_CLASS
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <SymbolButton symbol={order.symbol} />
        <Chip tone={stateTone(order.state)} title="Final state the broker reported for this order.">
          {readableState(order.state)}
        </Chip>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[length:var(--con-fs-sm)]">
        <div className="rounded-control bg-[color:var(--con-surface-2)] px-1.5 py-0.5" title={SIDE_TITLE[order.side] ?? "Order direction."}>
          <div className="flex justify-between items-baseline gap-0.5">
            <span className="text-[length:var(--con-fs-xs)] uppercase tracking-[0.06em] text-[color:var(--con-faint)]">Side</span>
            <div className={cx("con-num truncate", isExit(order.side) ? "font-semibold text-[color:var(--con-warn)]" : "font-semibold")}>
              {SIDE_LABEL[order.side] ?? String(order.side).toUpperCase()}
            </div>
          </div>
        </div>
        <div className="rounded-control bg-[color:var(--con-surface-2)] px-1.5 py-0.5" title="Order size: share quantity or approximate dollar amount.">
          <div className="flex justify-between items-baseline gap-0.5">
            <span className="text-[length:var(--con-fs-xs)] uppercase tracking-[0.06em] text-[color:var(--con-faint)]">Size</span>
            <div className="con-num truncate">
              {sizeText(order)}
              {executedText(order) && (
                <span className="block text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">{executedText(order)}</span>
              )}
            </div>
          </div>
        </div>
        <div className="rounded-control bg-[color:var(--con-surface-2)] px-1.5 py-0.5" title="Average price the broker reports for the executed part; '—' when nothing executed.">
          <div className="flex justify-between items-baseline gap-0.5">
            <span className="text-[length:var(--con-fs-xs)] uppercase tracking-[0.06em] text-[color:var(--con-faint)]">Avg fill</span>
            <div className="con-num truncate">
              {typeof order.averagePrice === "number" && Number.isFinite(order.averagePrice) ? fmtMoney(order.averagePrice) : <Dash />}
            </div>
          </div>
        </div>
        <div className="rounded-control bg-[color:var(--con-surface-2)] px-1.5 py-0.5" title="When the broker last updated the order.">
          <div className="flex justify-between items-baseline gap-0.5">
            <span className="text-[length:var(--con-fs-xs)] uppercase tracking-[0.06em] text-[color:var(--con-faint)]">Updated</span>
            <div className="con-num text-right">
              <Ago iso={order.updatedAt ?? order.createdAt} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
