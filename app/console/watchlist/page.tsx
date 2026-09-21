"use client";

/** Watchlist — symbols you follow, with price alerts.
 *  Real endpoints only: GET/POST/DELETE /api/watchlist (symbols + quotes via
 *  the active broker gateway) and GET/POST/DELETE /api/alerts (price alerts).
 *  Honesty rules: a missing quote renders as "—" (quotes need an active
 *  account and may be delayed); alerts are checked server-side about once a
 *  minute while the app is running, and a trigger notifies through the
 *  price_alert event in Settings → Event notifications. */

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BellPlus, Plus, Trash2 } from "lucide-react";
import type { PriceAlert, WatchlistItem } from "@/lib/types";
import { DEEP_LINK_FOCUS_CLASS, readSymbolQuery, scrollDeepLinkTarget, symbolElementId } from "../lib/deep-link-focus";
import { useMediaQuery } from "../lib/useMediaQuery";
import { useConsoleData } from "../lib/useConsoleData";
import { cx, fmtMoney, EM_DASH } from "../lib/format";
import { CONSOLE_PAGE_WIDTH } from "../lib/page-width";
import { useToast } from "../ui/toast";
import { Ago, Btn, Card, Chip, Dash, Empty, Field, NumInput, Select, TextInput } from "../ui/primitives";
import { SymbolButton } from "../ui/symbol-drilldown";

interface WatchlistQuote {
  symbol: string;
  price?: number;
  asOf?: string;
  provider?: string;
}

interface WatchlistData {
  items: WatchlistItem[];
  quotes: Record<string, WatchlistQuote>;
}

const POLL_MS = 30_000;

async function readError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error || fallback;
}

export default function WatchlistPage() {
  return (
    <Suspense fallback={null}>
      <WatchlistPageInner />
    </Suspense>
  );
}

function WatchlistPageInner() {
  const searchParams = useSearchParams();
  const toast = useToast();
  const [data, setData] = useState<WatchlistData | null>(null);
  const [alerts, setAlerts] = useState<PriceAlert[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isDesktop = useMediaQuery("(min-width: 1024px)");

  // Add-symbol form
  const [newSymbol, setNewSymbol] = useState("");

  // New-alert form
  const [alertSymbol, setAlertSymbol] = useState("");
  const [alertOp, setAlertOp] = useState<"<" | ">">(">");
  const [alertPrice, setAlertPrice] = useState("");
  const [alertNote, setAlertNote] = useState("");
  const alertFormRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [wlRes, alRes] = await Promise.all([
        fetch("/api/watchlist", { cache: "no-store" }),
        fetch("/api/alerts", { cache: "no-store" })
      ]);
      if (!wlRes.ok) throw new Error(await readError(wlRes, `Watchlist failed (${wlRes.status}).`));
      if (!alRes.ok) throw new Error(await readError(alRes, `Alerts failed (${alRes.status}).`));
      const wl = (await wlRes.json()) as WatchlistData;
      const al = (await alRes.json()) as { alerts: PriceAlert[] };
      setData({ items: wl.items ?? [], quotes: wl.quotes ?? {} });
      setAlerts(al.alerts ?? []);
      setLoadError(null);
    } catch (error) {
      // Keep the last good data on screen; surface the staleness.
      setLoadError(error instanceof Error ? error.message : "Could not refresh.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const addSymbol = async () => {
    const symbol = newSymbol.trim().toUpperCase();
    if (!symbol) return;
    setBusy(true);
    try {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol })
      });
      if (!res.ok) throw new Error(await readError(res, "Could not add the symbol."));
      const item = (await res.json()) as WatchlistItem & { deduped?: boolean };
      setNewSymbol("");
      await refresh();
      toast.push("pos", item.deduped ? `${symbol} was already on the watchlist` : `${symbol} added`);
    } catch (error) {
      toast.push("neg", "Not added", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const removeSymbol = async (symbol: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/watchlist?symbol=${encodeURIComponent(symbol)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res, "Could not remove the symbol."));
      await refresh();
      toast.push("info", `${symbol} removed`, "Its price alerts stay armed until you delete them below.");
    } catch (error) {
      toast.push("neg", "Not removed", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const createAlert = async () => {
    const symbol = alertSymbol.trim().toUpperCase();
    const price = Number(alertPrice);
    if (!symbol || !Number.isFinite(price) || price <= 0) {
      toast.push("neg", "Alert needs a symbol and a price above zero");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol, op: alertOp, price, note: alertNote.trim() || undefined })
      });
      if (!res.ok) throw new Error(await readError(res, "Could not create the alert."));
      setAlertPrice("");
      setAlertNote("");
      await refresh();
      toast.push("pos", `Alert armed: ${symbol} ${alertOp === ">" ? "above" : "below"} ${fmtMoney(price)}`);
    } catch (error) {
      toast.push("neg", "Alert not created", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const removeAlert = async (alert: PriceAlert) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/alerts?id=${encodeURIComponent(alert.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res, "Could not delete the alert."));
      await refresh();
      toast.push("info", `Alert deleted for ${alert.symbol}`);
    } catch (error) {
      toast.push("neg", "Not deleted", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const prefillAlert = (symbol: string) => {
    setAlertSymbol(symbol);
    const price = data?.quotes[symbol]?.price;
    if (typeof price === "number" && Number.isFinite(price)) setAlertPrice(String(price));
    alertFormRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const armedBySymbol = new Map<string, number>();
  for (const a of alerts ?? []) {
    if (a.status === "armed") armedBySymbol.set(a.symbol, (armedBySymbol.get(a.symbol) ?? 0) + 1);
  }

  const focusedSymbol = readSymbolQuery(searchParams.get("symbol"));

  useEffect(() => {
    if (!focusedSymbol) return;
    scrollDeepLinkTarget([
      symbolElementId(focusedSymbol, "card"),
      symbolElementId(focusedSymbol)
    ]);
  }, [focusedSymbol, data, alerts]);

  return (
    <div className={`${CONSOLE_PAGE_WIDTH} flex flex-col gap-4`}>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">Watchlist</h1>
        <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          yours across every account — watching costs nothing and trades nothing
        </span>
        {loadError && (
          <Chip tone="warn" title={loadError}>
            refresh failing — showing last good data
          </Chip>
        )}
      </div>

      {/* ── Symbols ── */}
      <Card
        title="Symbols"
        action={
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void addSymbol();
            }}
          >
            <TextInput
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value)}
              placeholder="e.g. NVDA"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className="con-mono w-28"
              aria-label="Symbol to add"
              title="Ticker to follow.  Watching a symbol never trades it — it only shows up here with a quote."
            />
            <Btn variant="primary" size="sm" type="submit" disabled={busy || newSymbol.trim().length === 0} title="Add this ticker to your watchlist.">
              <Plus size={13} /> Add
            </Btn>
          </form>
        }
        padded={false}
      >
        {data === null ? (
          <Empty>Loading watchlist…</Empty>
        ) : data.items.length === 0 ? (
          <Empty>Nothing watched yet.  Add a ticker above — watching is free and never trades.</Empty>
        ) : (
          isDesktop ? (
            <div className="overflow-x-auto">
              <table className="con-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th className="num" title="Latest known price from the active account's data source.  '—' means no quote is available right now — never a made-up number.">
                      Price
                    </th>
                    <th className="num" title="Armed price alerts on this symbol.">Alerts</th>
                    <th title="When you added the symbol.">Added</th>
                    <th aria-label="Row actions" />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => {
                    const quote = data.quotes[item.symbol];
                    const armed = armedBySymbol.get(item.symbol) ?? 0;
                    const focused = focusedSymbol === item.symbol.toUpperCase();
                    return (
                      <tr
                        key={item.symbol}
                        id={focused ? symbolElementId(item.symbol.toUpperCase()) : undefined}
                        className={focused ? DEEP_LINK_FOCUS_CLASS : undefined}
                      >
                        <td className="con-mono font-semibold">
                          <SymbolButton symbol={item.symbol} />
                        </td>
                        <td
                          className="num con-num"
                          title={
                            typeof quote?.price === "number"
                              ? `${item.symbol}: ${fmtMoney(quote.price)}${quote.provider ? ` via ${quote.provider}` : ""}.  Quotes may be delayed.`
                              : "No quote available — quotes come from the active account's data source and may be delayed."
                          }
                        >
                          {typeof quote?.price === "number" ? fmtMoney(quote.price) : EM_DASH}
                        </td>
                        <td className="num con-num" title={armed > 0 ? `${armed} armed alert${armed === 1 ? "" : "s"} on ${item.symbol} — listed below.` : `No armed alerts on ${item.symbol}.`}>
                          {armed > 0 ? armed : <Dash />}
                        </td>
                        <td>
                          <Ago iso={item.addedAt} />
                        </td>
                        <td className="num">
                          <WatchlistRowActions
                            symbol={item.symbol}
                            busy={busy}
                            onAlert={() => prefillAlert(item.symbol)}
                            onRemove={() => void removeSymbol(item.symbol)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex flex-col gap-2 px-2 pb-3 pt-2">
              {data.items.map((item) => {
                const quote = data.quotes[item.symbol];
                const armed = armedBySymbol.get(item.symbol) ?? 0;
                const focused = focusedSymbol === item.symbol.toUpperCase();
                return (
                  <div
                    key={item.symbol}
                    id={focused ? symbolElementId(item.symbol.toUpperCase(), "card") : undefined}
                    className={cx(
                      "con-row flex flex-col gap-2 rounded-control border border-[color:var(--con-line)] p-3",
                      focused && DEEP_LINK_FOCUS_CLASS
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <SymbolButton symbol={item.symbol} />
                        <span className="mt-1 block text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                          added <Ago iso={item.addedAt} />
                        </span>
                      </div>
                      <div className="con-num text-right text-[length:var(--con-fs-md)] font-semibold">
                        {typeof quote?.price === "number" ? fmtMoney(quote.price) : EM_DASH}
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                        {armed > 0 ? `${armed} armed alert${armed === 1 ? "" : "s"}` : "no armed alerts"}
                      </span>
                      <WatchlistRowActions
                        symbol={item.symbol}
                        busy={busy}
                        onAlert={() => prefillAlert(item.symbol)}
                        onRemove={() => void removeSymbol(item.symbol)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )
        )}
      </Card>

      {/* ── Price alerts ── */}
      <Card title="Price Alerts">
        <p className="mb-3 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-faint)]">
          Armed alerts are checked against live quotes about once a minute while the app&apos;s server is running. A
          trigger fires once, then the alert moves to &ldquo;triggered&rdquo; — it never re-arms by itself. Delivery
          uses the &ldquo;Price alert&rdquo; notification in Settings → Event notifications. Alerts only notify; they
          never place orders.
        </p>

        <div ref={alertFormRef} className="mb-4 grid gap-3 rounded-control border border-[color:var(--con-line)] p-3 sm:grid-cols-[7rem_7rem_8rem_1fr_auto]">
          <Field label="Symbol" htmlFor="alert-symbol">
            <TextInput
              id="alert-symbol"
              value={alertSymbol}
              onChange={(e) => setAlertSymbol(e.target.value)}
              placeholder="NVDA"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className="con-mono"
              title="Ticker to alert on — any symbol, watched or not."
            />
          </Field>
          <Field label="Direction" htmlFor="alert-op">
            <Select
              id="alert-op"
              value={alertOp}
              onChange={(e) => setAlertOp(e.target.value === "<" ? "<" : ">")}
              title="Above fires when the price rises past the level; below fires when it falls past it."
            >
              <option value=">">above</option>
              <option value="<">below</option>
            </Select>
          </Field>
          <Field label="Price $" htmlFor="alert-price">
            <NumInput
              id="alert-price"
              value={alertPrice}
              onChange={(e) => setAlertPrice(e.target.value)}
              placeholder="0.00"
              min={0}
              step="0.01"
              title="The trigger level in dollars."
            />
          </Field>
          <Field label="Note (optional)" htmlFor="alert-note">
            <TextInput
              id="alert-note"
              value={alertNote}
              onChange={(e) => setAlertNote(e.target.value)}
              placeholder="why this level matters"
              title="Shown with the alert so future-you remembers why the level mattered."
            />
          </Field>
          <div className="self-end">
            <Btn
              variant="primary"
              disabled={busy || alertSymbol.trim().length === 0 || alertPrice.trim().length === 0}
              onClick={() => void createAlert()}
              title="Arm the alert.  It notifies once when the level is crossed — it never trades."
            >
              <BellPlus size={13} /> Arm alert
            </Btn>
          </div>
        </div>

        {alerts === null ? (
          <Empty>Loading alerts…</Empty>
        ) : alerts.length === 0 ? (
          <Empty>No price alerts yet.  Arm one above, or use the Alert button on a watched symbol.</Empty>
        ) : (
          <div className="flex flex-col">
            {[...alerts]
              .sort((a, b) => (a.status === b.status ? b.createdAt.localeCompare(a.createdAt) : a.status === "armed" ? -1 : 1))
              .map((alert) => (
                <div
                  key={alert.id}
                  className={cx(
                    "con-row flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control px-1.5 py-2",
                    focusedSymbol === alert.symbol.toUpperCase() && DEEP_LINK_FOCUS_CLASS
                  )}
                  title={
                    alert.status === "armed"
                      ? `Armed: notifies when ${alert.symbol} trades ${alert.op === ">" ? "above" : "below"} ${fmtMoney(alert.price)}.`
                      : `Triggered${typeof alert.triggeredPrice === "number" ? ` at ${fmtMoney(alert.triggeredPrice)}` : ""} — it fired once and will not re-arm by itself.`
                  }
                >
                  <span className="con-mono font-semibold">
                    <SymbolButton symbol={alert.symbol} />
                  </span>
                  <span className="con-num text-[length:var(--con-fs-sm)]">
                    {alert.op === ">" ? "above" : "below"} {fmtMoney(alert.price)}
                  </span>
                  {alert.status === "armed" ? (
                    <Chip tone="accent">armed</Chip>
                  ) : (
                    <Chip tone="muted">
                      triggered{typeof alert.triggeredPrice === "number" ? ` @ ${fmtMoney(alert.triggeredPrice)}` : ""}
                    </Chip>
                  )}
                  {alert.note && <span className="truncate text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">{alert.note}</span>}
                  <span className="flex-1" />
                  <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                    {alert.status === "triggered" && alert.triggeredAt ? (
                      <>
                        fired <Ago iso={alert.triggeredAt} />
                      </>
                    ) : (
                      <>
                        set <Ago iso={alert.createdAt} />
                      </>
                    )}
                  </span>
                  <Btn
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void removeAlert(alert)}
                    title="Delete this alert.  Armed alerts stop watching; triggered ones just leave the list."
                  >
                    <Trash2 size={13} />
                  </Btn>
                </div>
              ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function WatchlistRowActions({
  symbol,
  busy,
  onAlert,
  onRemove
}: {
  symbol: string;
  busy: boolean;
  onAlert: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex justify-end gap-1">
      <Btn
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={onAlert}
        title={`Set a price alert for ${symbol} — prefills the form below with the current price.`}
        align="right"
      >
        <BellPlus size={13} /> Alert
      </Btn>
      <Btn
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={onRemove}
        title={`Stop watching ${symbol}.  Its alerts are separate and stay armed until deleted.`}
        align="right"
      >
        <Trash2 size={13} />
      </Btn>
    </div>
  );
}
