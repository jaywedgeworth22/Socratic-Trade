"use client";

/** LLM stats console — per-alias aggregates with two side-by-side windows.
 *
 *  Owner rule 2026-09-23: every LLM call is kept forever.  This page renders TWO columns:
 *    1. All-time  — stable baseline for trade-outcome correlation (this is the column that
 *       answers "what does opus look like across all 4 generations I've used?").
 *    2. Last 90d  — rolling quarter so a recent pricing-tier drop or model swap is visible.
 *
 *  Alias mapping: all opus versions (claude-opus-4-8, claude-opus-5, claude-opus-5.5 when
 *  it lands, anthropic/claude-opus-latest) collapse into one `opus` row.  Same for sonnet,
 *  haiku, gemini-flash, etc. — see src/lib/llm-stats.ts:ALIAS_FAMILIES.
 *
 *  Cost display split:
 *    - billed = the transport's own `usage.cost` (OpenRouter).  Authoritative money.
 *    - estimated = price-table derivation.  Best-effort; not authoritative.
 *  Never summed and presented as one number (the user explicitly asked for the provenance
 *  split in 2026-09-23 feedback so estimated calls don't blend into billed spend). */

import { useCallback, useEffect, useState } from "react";
import { SENTENCE_GAP } from "../../console/lib/format";
import { Card, Stat } from "../../console/ui/primitives";
import { Loader2, RefreshCw } from "lucide-react";

interface AliasStatRow {
  alias: string;
  family: string | null;
  sourceModels: string[];
  providers: string[];
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  billedCostUsd: number;
  estimatedCostUsd: number;
  errorCalls: number;
  timeoutCalls: number;
  canceledCalls: number;
  latencyP50: number | null;
  latencyP95: number | null;
  latencyP99: number | null;
  latencySamples: number;
}

interface LlmStatsPayload {
  generatedAt: string;
  userId: string | null;
  allTime: AliasStatRow[];
  last90d: AliasStatRow[];
}

function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${(n / 1000).toFixed(2)}k`;
}

function fmtInt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtLatency(ms: number | null): string {
  return ms === null ? "—" : `${(ms / 1000).toFixed(2)}s`;
}

interface WindowTotals {
  calls: number;
  billed: number;
  estimated: number;
  errors: number;
  tokens: number;
}

function totalsFor(rows: AliasStatRow[]): WindowTotals {
  return rows.reduce<WindowTotals>(
    (acc, r) => {
      acc.calls += r.calls;
      acc.billed += r.billedCostUsd;
      acc.estimated += r.estimatedCostUsd;
      acc.errors += r.errorCalls;
      acc.tokens += r.totalTokens;
      return acc;
    },
    { calls: 0, billed: 0, estimated: 0, errors: 0, tokens: 0 }
  );
}

function StatsTable({ rows }: { rows: AliasStatRow[] }) {
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-[length:var(--con-fs-sm)]">
        <thead>
          <tr className="border-b border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] text-left text-[length:var(--con-fs-xs)] uppercase tracking-wide text-[color:var(--con-faint)]">
            <th className="px-3 py-2">Alias</th>
            <th className="px-3 py-2 text-right">Calls</th>
            <th className="px-3 py-2 text-right">Billed</th>
            <th className="px-3 py-2 text-right">Estimated</th>
            <th className="px-3 py-2 text-right">Tokens</th>
            <th className="px-3 py-2 text-right">p50</th>
            <th className="px-3 py-2 text-right">p95</th>
            <th className="px-3 py-2 text-right">p99</th>
            <th className="px-3 py-2 text-right">Errors</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={9} className="px-3 py-8 text-center text-[color:var(--con-faint)]">
                No LLM usage recorded for this window.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.alias} className="border-b border-[color:var(--con-line)]/40">
              <td className="px-3 py-2 font-semibold" title={r.sourceModels.join(", ")}>
                {r.alias}
                <span className="ml-1.5 font-normal text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                  {r.family ?? ""}
                </span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtInt(r.calls)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(r.billedCostUsd)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(r.estimatedCostUsd)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtInt(r.totalTokens)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtLatency(r.latencyP50)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtLatency(r.latencyP95)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtLatency(r.latencyP99)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-[color:var(--con-danger,#c00)]">
                {r.errorCalls > 0 ? fmtInt(r.errorCalls) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** One of the two side-by-side windows (all-time or last-90d): stat cards + alias table. */
function WindowSection({
  title,
  subtitle,
  rows
}: {
  title: string;
  subtitle: string;
  rows: AliasStatRow[];
}) {
  const totals = totalsFor(rows);
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">{subtitle}</p>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat label="Calls" value={fmtInt(totals.calls)} />
        <Stat label="Billed" value={fmtUsd(totals.billed)} sub="Transport's own usage.cost" />
        <Stat label="Estimated" value={fmtUsd(totals.estimated)} sub="Price-table derivation" />
        <Stat label="Total tokens" value={fmtInt(totals.tokens)} />
        <Stat label="Errors" value={fmtInt(totals.errors)} sub="status='error' rows" />
      </div>
      <StatsTable rows={rows} />
    </section>
  );
}

export function LlmStatsClient() {
  const [data, setData] = useState<LlmStatsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/llm-stats", { cache: "no-store" });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const payload = (await res.json()) as LlmStatsPayload;
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">LLM Stats — Alias Aggregates</h1>
          <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
            Per-alias rollup of every recorded LLM call.  Two windows side by side:{" "}
            <strong>All-time</strong> (unbounded baseline for trade-outcome correlation) and{" "}
            <strong>Last 90d</strong> (rolling quarter to catch a recent price drop or model swap).
            All opus generations (4-8, 5, 5.5 when it lands) collapse into one <code>opus</code>{" "}
            bucket per owner 2026-09-23.  Hover an alias for its source models.
          </p>
          {data?.generatedAt && (
            <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              Generated {new Date(data.generatedAt).toLocaleString("en-US", { timeZone: "America/Chicago" })}{" "}
              {data.userId ? ` · user ${data.userId}` : " · all users"}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={fetchData}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface)] px-3 py-1.5 text-[length:var(--con-fs-sm)] hover:border-[color:var(--con-accent)] disabled:opacity-50"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Refresh
          </button>
        </div>
      </header>

      {error && (
        <Card className="border-[color:var(--con-danger,#c00)] bg-[color:var(--con-danger-bg,#fdd)] p-3 text-[length:var(--con-fs-sm)]">
          {error}
        </Card>
      )}

      {data && (
        <>
          <div className="grid gap-8 xl:grid-cols-2">
            <WindowSection
              title="All-time"
              subtitle="Unbounded baseline — every LLM call kept forever."
              rows={data.allTime}
            />
            <WindowSection
              title="Last 90d"
              subtitle="Rolling quarter — catches a recent price drop or model swap."
              rows={data.last90d}
            />
          </div>

          <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            Billed = transport's own <code>usage.cost</code> (OpenRouter).{SENTENCE_GAP}Estimated = price-table
            derivation.{SENTENCE_GAP}Never summed together — the split is the answer to "how much of this is
            real money vs. best-effort".{SENTENCE_GAP}Latency percentiles are computed over rows with{" "}
            <code>latency_ms IS NOT NULL</code>; legacy rows recorded before migration #91 are
            excluded from the distribution.
          </p>
        </>
      )}
    </div>
  );
}
