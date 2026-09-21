"use client";
import { Table, Th, Td } from "../ui/primitives";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import type { WeeklyDigestName, WeeklyMarketDigest } from "@/lib/weekly-market-digest";
import { cx, fmtMoney, fmtPct, EM_DASH, SENTENCE_GAP } from "../lib/format";
import { useConsoleData } from "../lib/useConsoleData";
import { Ago, Btn, Card, Chip, Empty , Table, Th, Td} from "../ui/primitives";
import { SymbolButton } from "../ui/symbol-drilldown";

function fmtCap(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return EM_DASH;
  if (value >= 1_000_000_000_000) return `$${(value / 1_000_000_000_000).toFixed(1)}t`;
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}b`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}m`;
  return fmtMoney(value);
}

function statusChip(status: WeeklyMarketDigest["status"]): { tone: "pos" | "muted" | "warn"; label: string } {
  switch (status) {
    case "ready":
      return { tone: "pos", label: "ready" };
    case "value_only":
      return { tone: "muted", label: "value only" };
    case "pending":
      return { tone: "warn", label: "pending" };
    default: {
      const _never: never = status;
      return _never;
    }
  }
}

function vsLabel(value: WeeklyDigestName["vsSma20"]): string {
  if (value === "above") return "above";
  if (value === "below") return "below";
  return EM_DASH;
}

export function WeeklyDigestCard() {
  const { snapshot } = useConsoleData();
  const [override, setOverride] = useState<WeeklyMarketDigest | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshotDigest = snapshot?.weeklyMarketDigest;
  const sameScan =
    Boolean(override?.scanGeneratedAt) && override?.scanGeneratedAt === snapshotDigest?.scanGeneratedAt;
  const digest = sameScan ? override : (snapshotDigest ?? override);

  const onRefresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch("/api/scan/weekly-digest?refresh=1", { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { digest?: WeeklyMarketDigest; error?: string };
      if (!res.ok || !body.digest) {
        setError(body.error ?? `Refresh failed (${res.status}).`);
        return;
      }
      setOverride(body.digest);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed.");
    } finally {
      setRefreshing(false);
    }
  };

  if (!digest) {
    return (
      <Card title={<span title="Native value and 5-day momentum screens from this account's scan tape.">Weekly Screens</span>}>
        <Empty>
          Weekly screens appear after a market scan.{SENTENCE_GAP}Value uses live quotes; momentum waits on daily bars.
        </Empty>
      </Card>
    );
  }

  const chip = statusChip(digest.status);
  const warning = digest.warnings[0];

  return (
    <Card
      title={<span title={`Large-cap value near the 52-week low, and liquid names ranked by 5-day return.${SENTENCE_GAP}Advisory data only.`}>Weekly Screens</span>}
      action={
        <div className="flex items-center gap-2">
          <Chip tone={chip.tone} title={digest.warnings.slice(0, 4).join("\n") || chip.label}>
            {chip.label}
          </Chip>
          <Btn
            size="sm"
            variant="outline"
            onClick={() => void onRefresh()}
            disabled={refreshing}
            title={`Rebuild the screens from this scan plus daily bars.${SENTENCE_GAP}Read-only: it never places trades.`}
          >
            <RefreshCw size={13} className={cx(refreshing && "animate-spin")} aria-hidden />
            {refreshing ? "Refreshing…" : "Refresh bars"}
          </Btn>
        </div>
      }
    >
      <p className="mb-3 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-faint)]">
        Native screens from this account&apos;s scan tape — large-cap ≥ $10b, price &gt; $5, volume ≥ 500k.{SENTENCE_GAP}
        Value needs a trailing P/E ≤ 10 and a print within 10% of the 52-week low.{SENTENCE_GAP}
        Momentum ranks the same floor by 5-day return.{SENTENCE_GAP}
        Missing fields exclude the name.{SENTENCE_GAP}
        Advisory data only — not a trade trigger.
      </p>
      {digest.generatedAt && (
        <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          screened <Ago iso={digest.generatedAt} />
          {digest.universeSize > 0 ? ` · ${digest.universeSize} names` : ""}
          {digest.barsCovered > 0 ? ` · ${digest.barsCovered} with bars` : ""}
        </p>
      )}
      {error && (
        <p className="mb-3 rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          {error}{SENTENCE_GAP}The last good screens stay on screen.
        </p>
      )}
      {warning && (
        <p
          className="mb-3 cursor-default rounded-control border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] px-3 py-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]"
          title={digest.warnings.join("\n")}
        >
          {digest.warnings.length > 1 ? `${warning} (+${digest.warnings.length - 1} more)` : warning}
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <ScreenList
          title="Value"
          empty="No names pass the value screen."
          names={digest.value}
          columns="value"
        />
        <ScreenList
          title="Momentum"
          empty={digest.status === "value_only" ? "Momentum is waiting on daily bars." : "No liquid large-caps had a 5-day return."}
          names={digest.momentum}
          columns="momentum"
        />
      </div>
      {digest.overlap.length > 0 && (
        <p className="mt-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Overlap:{" "}
          {digest.overlap.map((symbol, i) => (
            <span key={symbol}>
              {i > 0 ? ", " : ""}
              <SymbolButton symbol={symbol} className="text-inherit" />
            </span>
          ))}
        </p>
      )}
    </Card>
  );
}

function ScreenList({
  title,
  empty,
  names,
  columns
}: {
  title: string;
  empty: string;
  names: WeeklyDigestName[];
  columns: "value" | "momentum";
}) {
  return (
    <div>
      <h3 className="mb-2 text-[length:var(--con-fs-sm)] font-semibold">{title}</h3>
      {names.length === 0 ? (
        <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">{empty}</p>
      ) : (
        <Table caption="Data table" className="w-full text-left text-[length:var(--con-fs-xs)]">
          <thead>
            <tr className="text-[color:var(--con-faint)]">
              <Th className="pb-1 font-medium">Ticker</Th>
              {columns === "value" ? (
                <>
                  <Th className="pb-1 font-medium">P/E</Th>
                  <Th className="pb-1 font-medium">vs 52w low</Th>
                  <Th className="pb-1 font-medium">Cap</Th>
                </>
              ) : (
                <>
                  <Th className="pb-1 font-medium">5-day</Th>
                  <Th className="pb-1 font-medium">RSI-14</Th>
                  <Th className="pb-1 font-medium">vs MAs</Th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {names.map((row) => (
              <tr key={row.symbol} className="border-t border-[color:var(--con-line)]">
                <Td className="py-1.5 pr-2">
                  <SymbolButton symbol={row.symbol} className="text-inherit" />
                  {row.sector ? <span className="ml-1 text-[color:var(--con-faint)]">{row.sector}</span> : null}
                </Td>
                {columns === "value" ? (
                  <>
                    <Td className="py-1.5 pr-2">{row.peRatio != null ? row.peRatio.toFixed(1) : EM_DASH}</Td>
                    <Td className="py-1.5 pr-2">{fmtPct(row.pctAbove52wLow, 1)}</Td>
                    <Td className="py-1.5">{fmtCap(row.marketCap)}</Td>
                  </>
                ) : (
                  <>
                    <Td className="py-1.5 pr-2">{fmtPct(row.return5d, 1, true)}</Td>
                    <Td className="py-1.5 pr-2">
                      {row.rsi14 != null ? row.rsi14.toFixed(0) : EM_DASH}
                      {row.rsiZone ? <span className="ml-1 text-[color:var(--con-faint)]">{row.rsiZone}</span> : null}
                    </Td>
                    <Td className="py-1.5 text-[color:var(--con-faint)]">
                      20 {vsLabel(row.vsSma20)} · 50 {vsLabel(row.vsSma50)} · 200 {vsLabel(row.vsSma200)}
                    </Td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
