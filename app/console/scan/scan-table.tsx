"use client";

/** Sortable Market Scan table. Row hover/focus highlight comes free from
 *  `.con-table`; the symbol column is sticky so the table can scroll
 *  horizontally on small screens without losing the identity column (the
 *  sticky cell repaints the row-hover wash itself via group-hover, since its
 *  opaque background sits above the row's). Every header and cell carries a
 *  tooltip; cell tooltips get the scan-level "Received …" stamp when the
 *  field's own tooltip doesn't already carry one. */

import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Columns3, Star } from "lucide-react";
import { TableVirtuoso } from "react-virtuoso";
import type { MarketQuote, MarketScan } from "@/lib/types";
import { receivedLabel } from "@/lib/dashboard-ui";
import { cx, SENTENCE_GAP } from "../lib/format";
import { useFocusTrap } from "../ui/focus-trap";
import { Tooltip , Table, Th, Td} from "../ui/primitives";
import { useToast } from "../ui/toast";
import { openSymbolDetails } from "../ui/symbol-drilldown";
import { useSymbolDrawer } from "../ui/symbol-drawer";
import { DEFAULT_VISIBLE_SCAN_COLUMN_IDS, SCAN_COLUMNS, type ScanColumn } from "./columns";

/** Approx row height for virtualized height budgeting (con-table cells). */
const SCAN_ROW_PX = 40;
const SCAN_HEADER_PX = 40;
/** Cap so a 100-row scan still virtualizes on mid phones / laptops. */
const SCAN_VIEWPORT_MAX_PX = 560;

type SortDir = "asc" | "desc";
const SYMBOL_COLUMN_ID = "symbol";
const SCORE_COLUMN_ID = "score";
export const SCAN_COLS_KEY = "console-scan-visible-cols-v1";

/** Missing values (undefined/null/NaN) sort last in BOTH directions so the
 *  interesting rows stay on top whichever way the user flips a column. */
function compareValues(a: unknown, b: unknown, dir: SortDir): number {
  const aMissing = a === undefined || a === null || (typeof a === "number" && !Number.isFinite(a));
  const bMissing = b === undefined || b === null || (typeof b === "number" && !Number.isFinite(b));
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  const base = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
  return dir === "asc" ? base : -base;
}

// The sticky symbol cell needs its own opaque background (the row's hover wash
// is painted on the <tr>, underneath it). group-hover/focus-within re-derive
// the same 6% fg wash composited onto the surface so hover looks identical
// across the whole row in both themes.
const STICKY_CELL = "sticky left-0 z-[1] bg-[color:var(--con-surface)]";
const STICKY_CELL_HOVER =
  "group-hover:bg-[color:color-mix(in_oklab,var(--con-fg)_6%,var(--con-surface))] group-focus-within:bg-[color:color-mix(in_oklab,var(--con-fg)_6%,var(--con-surface))]";

function defaultSortForVisible(visible: string[]): { col: string; dir: SortDir } {
  return visible.includes(SCORE_COLUMN_ID) ? { col: SCORE_COLUMN_ID, dir: "desc" } : { col: SYMBOL_COLUMN_ID, dir: "asc" };
}

export function sanitizeVisibleScanColumns(saved: unknown): string[] {
  if (!Array.isArray(saved)) return DEFAULT_VISIBLE_SCAN_COLUMN_IDS;
  const valid = new Set(SCAN_COLUMNS.map((column) => column.id));
  const deduped = saved.filter((id): id is string => typeof id === "string" && valid.has(id)).filter((id, i, arr) => arr.indexOf(id) === i);
  if (deduped.length === 0) return DEFAULT_VISIBLE_SCAN_COLUMN_IDS;
  return [SYMBOL_COLUMN_ID, ...deduped.filter((id) => id !== SYMBOL_COLUMN_ID)];
}

export function toggleVisibleScanColumn(visible: string[], id: string): string[] {
  if (id === SYMBOL_COLUMN_ID) return visible;
  return visible.includes(id) ? visible.filter((columnId) => columnId !== id) : [...visible, id];
}

export function moveVisibleScanColumn(visible: string[], id: string, delta: -1 | 1): string[] {
  if (id === SYMBOL_COLUMN_ID) return visible;
  const from = visible.indexOf(id);
  if (from === -1) return visible;
  const minIndex = visible[0] === SYMBOL_COLUMN_ID ? 1 : 0;
  const to = Math.max(minIndex, Math.min(visible.length - 1, from + delta));
  if (from === to) return visible;
  const next = visible.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function sameScanColumns(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

async function watchlistErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error || fallback;
}

/** Same "own tooltip, else stamp the scan-level Received line" rule the table
 *  body uses — shared with the mobile card list so both surfaces agree. */
function cellTitleWithReceived(column: ScanColumn, q: MarketQuote, received: string): string | undefined {
  const own = column.cellTitle?.(q);
  return [own, own?.includes("Received ") ? undefined : received].filter(Boolean).join("\n") || undefined;
}

/** Watch/unwatch toggle for a scan row — posts straight to the same
 *  /api/watchlist contract the Watchlist screen uses. Optimistic: the star
 *  flips immediately and only reverts if the request actually fails. Filled
 *  vs outline star (not just a color change) carries the watched state. */
function WatchButton({
  symbol,
  watched,
  pending,
  onToggle
}: {
  symbol: string;
  watched: boolean;
  pending: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      disabled={pending}
      aria-pressed={watched}
      title={
        watched
          ? `Stop watching ${symbol}.`
          : `Add ${symbol} to your watchlist — watching costs nothing and never trades.`
      }
      className={cx(
        "con-watch-btn inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-control border transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        watched
          ? "border-[color:var(--con-accent-border)] bg-[color:var(--con-accent-soft)] text-[color:var(--con-accent)]"
          : "border-[color:var(--con-line)] text-[color:var(--con-faint)] hover:border-[color:var(--con-line-strong)] hover:text-[color:var(--con-fg)]"
      )}
    >
      <Star size={13} fill={watched ? "currentColor" : "none"} aria-hidden />
    </button>
  );
}

// Mobile card fields: symbol always leads; these are the "load-bearing" ones
// worth a glance without opening the drilldown. Fixed regardless of the
// desktop table's user-customized column visibility — the card is a compact
// summary, not a second column picker.
const CARD_FIELD_IDS = ["score", "price", "change", "senateTrades"];

function ScanCard({
  q,
  received,
  watched,
  pending,
  onToggleWatch
}: {
  q: MarketQuote;
  received: string;
  watched: boolean;
  pending: boolean;
  onToggleWatch: () => void;
}) {
  const { openDrawer } = useSymbolDrawer();
  const symbolColumn = SCAN_COLUMNS.find((c) => c.id === SYMBOL_COLUMN_ID);
  const fields = CARD_FIELD_IDS.map((id) => SCAN_COLUMNS.find((c) => c.id === id)).filter(
    (c): c is ScanColumn => Boolean(c)
  );
  const normalized = q.symbol.trim().toUpperCase();
  const openDetails = () => openSymbolDetails(openDrawer, normalized, q);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={openDetails}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openDetails();
        }
      }}
      aria-label={q.companyName ? `${q.companyName} — open ${normalized} details` : `Open ${normalized} details`}
      className="con-row flex cursor-pointer flex-col gap-2 rounded-control border border-[color:var(--con-line)] p-3"
    >
      <div className="flex items-center gap-2">
        <WatchButton symbol={q.symbol} watched={watched} pending={pending} onToggle={onToggleWatch} />
        {symbolColumn?.render(q)}
      </div>
      <div className="grid grid-cols-2 gap-1.5 text-[length:var(--con-fs-sm)]">
        {fields.map((c) => (
          <div key={c.id} title={cellTitleWithReceived(c, q, received)} className="rounded-control bg-[color:var(--con-surface-2)] px-2 py-1">
            <div className="text-[length:var(--con-fs-xs)] uppercase tracking-[0.06em] text-[color:var(--con-faint)]">{c.label}</div>
            <div className={cx(c.num && "con-num")}>{c.render(q)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ScanColumnsMenu({
  open,
  onOpenChange,
  visible,
  columnChooserRows,
  onReset,
  onToggle,
  onMove
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  visible: string[];
  columnChooserRows: ScanColumn[];
  onReset: () => void;
  onToggle: (id: string) => void;
  onMove: (id: string, delta: -1 | 1) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useFocusTrap(panelRef, open, { onEscape: () => onOpenChange(false) });

  return (
    <div className="relative">
      <Tooltip content={`Show, hide, reorder, or reset scan columns.${SENTENCE_GAP}Saved in this browser.`}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-haspopup="dialog"
          onClick={() => onOpenChange(!open)}
          className="inline-flex h-8 items-center gap-1.5 rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface)] px-2.5 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-muted)] transition-colors hover:text-[color:var(--con-fg)]"
        >
          <Columns3 size={14} aria-hidden />
          Columns
        </button>
      </Tooltip>
      {open && (
        <>
          <div
            className="fixed inset-0 z-10 cursor-default"
            aria-hidden
            onClick={() => onOpenChange(false)}
          />
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-label="Scan columns"
            tabIndex={-1}
            className="absolute right-0 z-20 mt-1 flex max-h-[60vh] w-72 flex-col overflow-hidden rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface)] shadow-[var(--shadow-lg)]"
          >
            <div className="flex items-center justify-between gap-2 border-b border-[color:var(--con-line)] px-3 py-2">
              <p className="text-[length:var(--con-fs-xs)] font-semibold uppercase tracking-[0.07em] text-[color:var(--con-faint)]">
                Columns
              </p>
              <button
                type="button"
                onClick={onReset}
                className="text-[length:var(--con-fs-xs)] font-medium text-[color:var(--con-accent)] hover:opacity-80"
              >
                Reset
              </button>
            </div>
            <div className="flex flex-col gap-1 overflow-auto p-1.5">
              {columnChooserRows.map((column) => {
                const isVisible = visible.includes(column.id);
                const index = visible.indexOf(column.id);
                return (
                  <Tooltip key={column.id} content={column.headerTitle}>
                    <div
                      className={cx(
                        "flex w-full items-center justify-between gap-2 rounded-control px-2.5 py-1.5 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)] hover:bg-[color:var(--con-surface-2)]",
                        !isVisible && "opacity-70"
                      )}
                    >
                      <label className={cx("flex min-w-0 items-center gap-2", column.id === SYMBOL_COLUMN_ID ? "opacity-70" : "cursor-pointer")}>
                        <input
                          type="checkbox"
                          checked={isVisible}
                          onChange={() => onToggle(column.id)}
                          disabled={column.id === SYMBOL_COLUMN_ID}
                          className="accent-[var(--con-accent)]"
                        />
                        <span className="truncate">{column.label}</span>
                      </label>
                      {isVisible ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            aria-label={`Move ${column.label} earlier`}
                            onClick={() => onMove(column.id, -1)}
                            disabled={index <= 0}
                            className="inline-flex h-6 w-6 items-center justify-center rounded text-[color:var(--con-faint)] hover:bg-[color:var(--con-surface-2)] hover:text-[color:var(--con-fg)] disabled:opacity-30"
                          >
                            <ArrowUp size={14} aria-hidden />
                          </button>
                          <button
                            type="button"
                            aria-label={`Move ${column.label} later`}
                            onClick={() => onMove(column.id, 1)}
                            disabled={index === visible.length - 1}
                            className="inline-flex h-6 w-6 items-center justify-center rounded text-[color:var(--con-faint)] hover:bg-[color:var(--con-surface-2)] hover:text-[color:var(--con-fg)] disabled:opacity-30"
                          >
                            <ArrowDown size={14} aria-hidden />
                          </button>
                        </div>
                      ) : (
                        <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">hidden</span>
                      )}
                    </div>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export const ScanTable = memo(function ScanTable({ scan }: { scan: MarketScan }) {
  const toast = useToast();
  const [sort, setSort] = useState<{ col: string; dir: SortDir }>({ col: "score", dir: "desc" });
  const [visible, setVisible] = useState<string[]>(DEFAULT_VISIBLE_SCAN_COLUMN_IDS);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [watched, setWatched] = useState<Set<string>>(new Set());
  const [pendingWatch, setPendingWatch] = useState<Set<string>>(new Set());

  // Sync the current watchlist once on mount so rows already watched show a
  // filled star. Non-blocking: a failed sync just means an already-watched
  // symbol may show unwatched until the next successful load — the Watch
  // button itself still works either way (the server dedupes).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/watchlist", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Watchlist failed (${res.status}).`))))
      .then((data: { items?: { symbol: string }[] }) => {
        if (cancelled) return;
        setWatched(new Set((data.items ?? []).map((item) => item.symbol.trim().toUpperCase())));
      })
      .catch(() => {
        /* soft-fail — see comment above */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleWatch = async (symbolRaw: string) => {
    const symbol = symbolRaw.trim().toUpperCase();
    const wasWatched = watched.has(symbol);
    setPendingWatch((prev) => new Set(prev).add(symbol));
    setWatched((prev) => {
      const next = new Set(prev);
      if (wasWatched) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
    try {
      if (wasWatched) {
        const res = await fetch(`/api/watchlist?symbol=${encodeURIComponent(symbol)}`, { method: "DELETE" });
        if (!res.ok) throw new Error(await watchlistErrorMessage(res, `Could not remove ${symbol}.`));
        toast.push("info", `${symbol} removed from watchlist`);
      } else {
        const res = await fetch("/api/watchlist", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ symbol })
        });
        if (!res.ok) throw new Error(await watchlistErrorMessage(res, `Could not add ${symbol}.`));
        const item = (await res.json()) as { deduped?: boolean };
        toast.push("pos", item.deduped ? `${symbol} was already on the watchlist` : `${symbol} added to watchlist`);
      }
    } catch (error) {
      // Revert the optimistic flip — the request didn't actually go through.
      setWatched((prev) => {
        const next = new Set(prev);
        if (wasWatched) next.add(symbol);
        else next.delete(symbol);
        return next;
      });
      toast.push("neg", wasWatched ? "Not removed" : "Not added", error instanceof Error ? error.message : undefined);
    } finally {
      setPendingWatch((prev) => {
        const next = new Set(prev);
        next.delete(symbol);
        return next;
      });
    }
  };

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SCAN_COLS_KEY);
      if (!saved) return;
      const next = sanitizeVisibleScanColumns(JSON.parse(saved));
      setVisible((current) => (sameScanColumns(current, next) ? current : next));
    } catch {
      /* ignore storage failures */
    }
  }, []);

  function saveVisibleColumns(next: string[]) {
    setVisible(next);
    try {
      window.localStorage.setItem(SCAN_COLS_KEY, JSON.stringify(next));
    } catch {
      /* ignore storage failures */
    }
  }

  function resetScanColumns() {
    saveVisibleColumns(DEFAULT_VISIBLE_SCAN_COLUMN_IDS);
  }

  const activeSort = useMemo(() => (visible.includes(sort.col) ? sort : defaultSortForVisible(visible)), [sort, visible]);

  const rows = useMemo(() => {
    // Shape defense (not data hiding): a candidate without a symbol can't be
    // keyed or drilled into — old/compact run captures may carry such rows.
    const candidates = scan.topCandidates.filter((q) => typeof q?.symbol === "string" && q.symbol.length > 0);
    const col = SCAN_COLUMNS.find((c) => c.id === activeSort.col);
    if (!col) return candidates;
    return [...candidates].sort((a, b) => compareValues(col.sortValue(a), col.sortValue(b), activeSort.dir));
  }, [activeSort, scan]);

  const visibleColumns = useMemo(
    () =>
      visible
        .map((id) => SCAN_COLUMNS.find((column) => column.id === id))
        .filter((column): column is (typeof SCAN_COLUMNS)[number] => Boolean(column)),
    [visible]
  );

  const columnChooserRows = useMemo(
    () => [...visibleColumns, ...SCAN_COLUMNS.filter((column) => !visible.includes(column.id))],
    [visible, visibleColumns]
  );

  // The quote-level `asOf` can be a display sentence rather than a timestamp;
  // the scan's ISO generatedAt is the authoritative "received" time here.
  const received = receivedLabel(scan.generatedAt);

  // Virtualization needs a fixed viewport height; size to content until the cap.
  const tableHeight = Math.min(SCAN_VIEWPORT_MAX_PX, Math.max(SCAN_HEADER_PX + SCAN_ROW_PX, rows.length * SCAN_ROW_PX + SCAN_HEADER_PX));

  const headerRow = (
    <tr>
      {visibleColumns.map((c, i) => {
        const active = activeSort.col === c.id;
        return (
          <Th
            key={c.id}
            scope="col"
            aria-sort={active ? (activeSort.dir === "asc" ? "ascending" : "descending") : undefined}
            className={cx(
              "!text-center text-center",
              c.id === "score" && "w-16 px-2",
              i === 0 && STICKY_CELL
            )}
          >
            <Tooltip
              content={`${c.headerTitle}\nClick to sort by ${c.label.toLowerCase()}${active ? ` (currently ${activeSort.dir === "asc" ? "ascending" : "descending"})` : ""}.`}>
              <button
                type="button"
                onClick={() => setSort({ col: c.id, dir: activeSort.col === c.id && activeSort.dir === "desc" ? "asc" : "desc" })}
                className={cx(
                  "inline-flex cursor-pointer select-none items-center justify-center gap-1 font-semibold uppercase tracking-[0.07em] transition-colors mx-auto",
                  active ? "text-[color:var(--con-fg)]" : "hover:text-[color:var(--con-fg)]"
                )}>
                {c.label}
                <span aria-hidden className={cx("text-[length:var(--con-fs-2xs)]", !active && "opacity-0")}>
                  {active && activeSort.dir === "asc" ? "▲" : "▼"}
                </span>
              </button>
            </Tooltip>
          </Th>
        );
      })}
    </tr>
  );

  return (
    <div>
      {/* Column picker only applies to the desktop table — the mobile card
          list below always shows the same fixed load-bearing fields. */}
      <div className="hidden items-center justify-between gap-3 border-b border-[color:var(--con-line)] px-4 py-2 lg:flex">
        <Tooltip
          content="Visible columns are saved per browser for the console scan table.">
          <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            {visibleColumns.length} shown
          </p>
        </Tooltip>
        <ScanColumnsMenu
          open={columnsOpen}
          onOpenChange={setColumnsOpen}
          visible={visible}
          columnChooserRows={columnChooserRows}
          onReset={resetScanColumns}
          onToggle={(id) => saveVisibleColumns(toggleVisibleScanColumn(visible, id))}
          onMove={(id, delta) => saveVisibleColumns(moveVisibleScanColumn(visible, id, delta))}
        />
      </div>
      {/* Desktop: TableVirtuoso (C3) — only visible rows mount; sticky symbol via CSS. */}
      <div className="hidden overflow-x-auto lg:block">
        {rows.length === 0 ? (
          <Table caption="Data table" className="con-table min-w-full">
            <thead>{headerRow}</thead>
            <tbody />
          </Table>
        ) : (
          <TableVirtuoso
            style={{ height: tableHeight }}
            data={rows}
            overscan={8}
            components={{
              Table: (props) => <Table caption="Data table" {...props} className="con-table min-w-full" />,
              TableRow: ({ item: _item, ...props }) => <tr {...props} className="group" />
            }}
            fixedHeaderContent={() => headerRow}
            itemContent={(_index, q) => {
              const symbolKey = q.symbol.trim().toUpperCase();
              return (
                <>
                  {visibleColumns.map((c, i) => {
                    const isSymbolCol = c.id === SYMBOL_COLUMN_ID;
                    const alignmentClass =
                      c.align === "left"
                        ? "!text-left text-left"
                        : c.align === "right"
                          ? "!text-right text-right"
                          : "!text-center text-center";
                    const flexAlignClass =
                      c.align === "left" ? "justify-start" : c.align === "right" ? "justify-end" : "justify-center";
                    return (
                      <Td
                        key={c.id}
                        title={cellTitleWithReceived(c, q, received)}
                        className={cx(
                          "cursor-default whitespace-nowrap",
                          alignmentClass,
                          c.id === "score" && "w-16 px-2",
                          c.num && "con-num",
                          i === 0 && cx(STICKY_CELL, STICKY_CELL_HOVER)
                        )}
                      >
                        {isSymbolCol ? (
                          <div className="inline-flex w-full items-center justify-start gap-1.5">
                            <WatchButton
                              symbol={q.symbol}
                              watched={watched.has(symbolKey)}
                              pending={pendingWatch.has(symbolKey)}
                              onToggle={() => void toggleWatch(q.symbol)}
                            />
                            {c.render(q)}
                          </div>
                        ) : (
                          <div className={cx("inline-flex w-full items-center", flexAlignClass)}>{c.render(q)}</div>
                        )}
                      </Td>
                    );
                  })}
                </>
              );
            }}
          />
        )}
      </div>
      <div className="flex flex-col gap-2 p-2 lg:hidden">
        {rows.map((q) => {
          const symbolKey = q.symbol.trim().toUpperCase();
          return (
            <ScanCard
              key={q.symbol}
              q={q}
              received={received}
              watched={watched.has(symbolKey)}
              pending={pendingWatch.has(symbolKey)}
              onToggleWatch={() => void toggleWatch(q.symbol)}
            />
          );
        })}
      </div>
    </div>
  );
});
