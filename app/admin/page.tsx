"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Cpu, RefreshCw, AlertTriangle, Database } from "lucide-react";
import { Card, Chip, Dot, Btn, Stat, Meter, type ChipTone } from "../console/ui/primitives";
import { SENTENCE_GAP } from "../console/lib/format";
import { describeProbeStatus } from "./lib/probe-error";
import { Markdown } from "./transcript/markdown";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ConnectionSummary {
  services: Array<{ service: string; keySource: string | null; stoppedWorking: boolean; callsLast24h: number }>;
}

interface LlmSummary {
  rows: Array<{ model: string | null; costUsd: number }>;
  totalCostUsd: number;
}

interface RagSummary {
  totalTickers: number;
  totalChunks: number;
  vectorStoreTotalVectors: number;
  globalBreakdown?: Record<string, number>;
  earningsTranscripts?: {
    featureEnabled: boolean;
    storageRightsConfirmed: boolean;
    enabled: boolean;
    capability: "disabled" | "unknown" | "available" | "endpoint_not_entitled" | "access_denied";
    lastCapability?: {
      httpStatus?: number;
    };
    ingestedCount: number;
  };
}

interface ServerSummary {
  hostInfo?: { cpuCount?: number; ramTotalGb?: number; memoryTotalBytes?: number };
  resources?: Array<{ status?: string; state?: string; name?: string }>;
  resourcesObservation?: { state: string };
  metrics?: {
    cpu?: Array<{ value: number }>;
  };
}

interface TranscriptSummary {
  turns: Array<{ id: string; role: string; text: string; model: string | null; createdAt: string }>;
}

interface R2Metric {
  id: "storage" | "classA" | "classB";
  label: string;
  mtd: number;
  limit: number;
  pctUsed: number;
  projected: number;
  projectedPct: number;
  exceeded: boolean;
  alertBasis: "absolute" | "pace";
  unit: "bytes" | "ops";
}

interface R2Summary {
  configured: boolean;
  accountsConfigured: Array<{ id: string; label: string }>;
  intervalHours: number;
  thresholdPct: number;
  /** True when THIS app's litestream→R2 is paused by the free-tier kill-switch marker. */
  replicationDisabled?: boolean;
  autoDisableArmed?: boolean;
  snapshots: Array<{
    accountId: string;
    accountLabel: string;
    checkedAt: string;
    metrics: R2Metric[];
  }>;
}

export default function OperatorDashboard() {
  const [connections, setConnections] = useState<ConnectionSummary | null>(null);
  const [llm, setLlm] = useState<LlmSummary | null>(null);
  const [rag, setRag] = useState<RagSummary | null>(null);
  const [server, setServer] = useState<ServerSummary | null>(null);
  const [transcript, setTranscript] = useState<TranscriptSummary | null>(null);
  const [r2, setR2] = useState<R2Summary | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Each probe's failure as its raw HTTP status, or "network" when the fetch itself never
  // got a response. Kept raw here (not pre-formatted into "HTTP 403" strings) so render sites
  // can turn it into human copy via describeProbeStatus — see ./lib/probe-error.
  const [probeErrors, setProbeErrors] = useState<Record<string, number | "network">>({});

  const fetchDashboardData = async () => {
    setError(null);
    setProbeErrors({});
    try {
      const results = await Promise.allSettled([
        fetch("/api/admin/connections-health"),
        fetch("/api/admin/llm-usage?sinceDays=30"),
        fetch("/api/admin/rag-coverage?sinceDays=30"),
        fetch("/api/admin/server-metrics"),
        fetch("/api/admin/transcript?limit=10"),
        fetch("/api/admin/r2-usage")
      ]);

      const [resConn, resLlm, resRag, resServ, resTrans, resR2] = results;
      const errs: Record<string, number | "network"> = {};

      if (resConn.status === "fulfilled") {
        if (resConn.value.ok) setConnections(await resConn.value.json());
        else errs.connections = resConn.value.status;
      } else errs.connections = "network";

      if (resLlm.status === "fulfilled") {
        if (resLlm.value.ok) setLlm(await resLlm.value.json());
        else errs.llm = resLlm.value.status;
      } else errs.llm = "network";

      if (resRag.status === "fulfilled") {
        if (resRag.value.ok) setRag(await resRag.value.json());
        else errs.rag = resRag.value.status;
      } else errs.rag = "network";

      if (resServ.status === "fulfilled") {
        if (resServ.value.ok) setServer(await resServ.value.json());
        else errs.server = resServ.value.status;
      } else errs.server = "network";

      if (resTrans.status === "fulfilled") {
        if (resTrans.value.ok) setTranscript(await resTrans.value.json());
        else errs.transcript = resTrans.value.status;
      } else errs.transcript = "network";

      if (resR2.status === "fulfilled") {
        if (resR2.value.ok) setR2(await resR2.value.json());
        else errs.r2 = resR2.value.status;
      } else errs.r2 = "network";

      setProbeErrors(errs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load dashboard data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchDashboardData();
  };

  // Helper formats
  const fmtCost = (usd: number) => {
    if (usd === 0) return "$0.00";
    if (usd < 0.01) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
  };

  const getSourceLabel = (src: string) => {
    if (src === "sec-edgar") return "SEC";
    if (src.startsWith("fundamentals:")) return "Fund Card";
    if (src.startsWith("disclosure:congress")) return "Congress";
    if (src.startsWith("disclosure:insider")) return "Insider";
    if (src.includes("socratic-memory")) return "Coach";
    if (src.startsWith("sec8k-summary")) return "8-K Summary";
    if (src === "fmp-earnings-transcript") return "Earnings Transcript";
    return src.split(":").pop() || src;
  };

  const getSourceTone = (src: string): ChipTone => {
    if (src === "sec-edgar") return "accent";
    if (src.startsWith("fundamentals:")) return "info";
    if (src.startsWith("disclosure:congress")) return "warn";
    if (src.startsWith("disclosure:insider")) return "muted";
    if (src.includes("socratic-memory")) return "pos";
    if (src.startsWith("sec8k-summary")) return "neg";
    if (src === "fmp-earnings-transcript") return "info";
    return "muted";
  };

  const failedConnections = connections?.services.filter((s) => s.stoppedWorking) ?? [];
  const earningsStatus = rag?.earningsTranscripts;
  const earningsStatusView = !earningsStatus?.featureEnabled
    ? { label: "Off", tone: "muted" as const }
    : !earningsStatus.storageRightsConfirmed
      ? { label: "Rights unconfirmed", tone: "warn" as const }
      : earningsStatus.capability === "endpoint_not_entitled"
        ? { label: "Plan excludes endpoint", tone: "warn" as const }
        : earningsStatus.capability === "access_denied"
          ? {
              label: `Access denied${earningsStatus.lastCapability?.httpStatus ? ` (HTTP ${earningsStatus.lastCapability.httpStatus})` : ""}`,
              tone: "warn" as const
            }
        : earningsStatus.capability === "available"
          ? { label: "Available", tone: "pos" as const }
          : { label: "Not checked", tone: "muted" as const };

  // Every operator-gated probe 403'd → this login isn't an operator. One honest notice
  // instead of five per-card probe errors (presentation of a real 403, not a gate).
  //
  // Enumerated rather than counted. `fetchDashboardData` fires SIX requests, but only these
  // five are behind requireAdmin — `/api/chat-history` (the `transcript` key) is an ordinary
  // per-user endpoint that answers 200 for a non-operator. The old test was
  // `Object.keys(probeErrors).length === 5 && every(=== 403)`, which happened to be right only
  // because the sixth probe usually succeeds and writes no key: any transient network failure
  // on chat-history added a sixth key and silently suppressed this notice, and adding a seventh
  // admin card would have broken it outright. Keyed membership has neither failure mode — a new
  // admin probe just gets its key added here.
  const ADMIN_PROBE_KEYS = ["connections", "llm", "rag", "server", "r2"] as const;
  const allForbidden = ADMIN_PROBE_KEYS.every((key) => probeErrors[key] === 403);

  // Short, human chip/badge text for a single probe's failure — see ./lib/probe-error for the
  // "why" (this presents a real 403 from requireAdmin, it doesn't paper over it).
  const probeErrorLabel = (entry: number | "network" | undefined): string | null =>
    entry === undefined ? null : entry === "network" ? "Request failed" : describeProbeStatus(entry).shortMessage;

  const currentCpu = server?.metrics?.cpu?.length ? server.metrics.cpu[server.metrics.cpu.length - 1]?.value : undefined;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Operator Overview</h1>
          <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
            Real-time status, diagnostics, and metrics across the Socratic Trade environment.
          </p>
        </div>
        <Btn variant="outline" size="sm" disabled={loading || refreshing} onClick={handleRefresh}>
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "Refreshing..." : "Refresh"}
        </Btn>
      </div>

      {error && (
        /* Plain div, not Card: con-card's unlayered background/border beat
           Tailwind's layered utilities, so a tinted Card never actually tints. */
        <div className="rounded-[var(--con-radius)] border border-[color:var(--con-neg-border)] bg-[color:var(--con-neg-soft)] p-4">
          <div className="flex items-start gap-3 text-[length:var(--con-fs-sm)] text-[color:var(--con-neg)]">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <span className="font-semibold">Operator access required</span>
              <p className="mt-1 text-[length:var(--con-fs-xs)] opacity-90">{error}</p>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="py-20 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          Loading dashboard...
        </div>
      ) : allForbidden ? (
        <Card>
          <div className="flex items-start gap-3 text-[length:var(--con-fs-sm)]">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--con-warn)]" />
            <div>
              <div className="font-semibold">Operator access required</div>
              <p className="mt-1 text-[color:var(--con-muted)]">
                This login does not have admin rights on the server.
              </p>
            </div>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {/* ── 1. API Connections ───────────────────────────────────────────── */}
          <Card
            title="API Connections"
            action={
              <Link href="/admin/connections" className="con-btn con-btn-ghost con-btn-sm">
                Open →
              </Link>
            }
            className="flex h-full flex-col"
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">Overall health</span>
                <Chip tone={failedConnections.length > 0 ? "neg" : probeErrors.connections ? "warn" : "pos"}>
                  <span title={typeof probeErrors.connections === "number" ? `HTTP ${probeErrors.connections}` : undefined}>
                    {failedConnections.length > 0 ? `${failedConnections.length} Offline` :
                     probeErrors.connections ? probeErrorLabel(probeErrors.connections) : "All Operations Online"}
                  </span>
                </Chip>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {connections?.services.slice(0, 6).map((srv) => (
                  <div key={`${srv.service}:${srv.keySource ?? ""}`} className="con-tile flex items-center justify-between">
                    <span className="con-mono mr-2 truncate text-[length:var(--con-fs-xs)] font-medium" title={`${srv.service}${srv.keySource ? ` (${srv.keySource})` : ""}`}>
                      {srv.service}
                      {srv.keySource && <span className="ml-1 text-[color:var(--con-faint)]">({srv.keySource})</span>}
                    </span>
                    <Dot tone={srv.stoppedWorking ? "neg" : srv.callsLast24h > 0 ? "pos" : "muted"} pulse={srv.stoppedWorking} />
                  </div>
                ))}
              </div>
            </div>
          </Card>

          {/* ── 2. LLM Usage & Cost ──────────────────────────────────────────── */}
          <Card
            title="LLM Usage & Cost"
            action={
              <Link href="/admin/llm-usage" className="con-btn con-btn-ghost con-btn-sm">
                Open →
              </Link>
            }
            className="flex h-full flex-col"
          >
            <div className="flex h-full flex-col justify-between">
              <div className="mb-4">
                {probeErrors.llm ? (
                  <span
                    className="text-[length:var(--con-fs-sm)] text-[color:var(--con-warn)]"
                    title={typeof probeErrors.llm === "number" ? `HTTP ${probeErrors.llm}` : undefined}
                  >
                    {probeErrorLabel(probeErrors.llm)}
                  </span>
                ) : (
                  <Stat label="Last 30 days spend" value={llm ? fmtCost(llm.totalCostUsd) : "$0.00"} />
                )}
              </div>
              <div className="flex-1 space-y-2 border-t border-[color:var(--con-line)] pt-4">
                <span className="con-card-title mb-2 block">
                  Cost by model
                  {probeErrors.llm && <span className="ml-1.5 font-normal normal-case text-[color:var(--con-warn)]">(unavailable)</span>}
                </span>
                {(() => {
                  const agg = (llm?.rows ?? []).reduce<Record<string, number>>((acc, row) => {
                    const model = row.model ?? "Unknown";
                    acc[model] = (acc[model] || 0) + (row.costUsd || 0);
                    return acc;
                  }, {});
                  return Object.entries(agg)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 3)
                    .map(([model, cost]) => (
                      <div key={model} className="flex items-center justify-between text-[length:var(--con-fs-xs)]">
                        <span className="con-mono max-w-[180px] truncate text-[color:var(--con-muted)]" title={model}>
                          {model}
                        </span>
                        <span className="con-num font-semibold">{fmtCost(cost)}</span>
                      </div>
                    ));
                })()}
              </div>
            </div>
          </Card>

          {/* ── 3. RAG Coverage ──────────────────────────────────────────────── */}
          <Card
            title="RAG Coverage"
            action={
              <Link href="/admin/rag-coverage" className="con-btn con-btn-ghost con-btn-sm">
                Open →
              </Link>
            }
            className="flex h-full flex-col"
          >
            <div className="space-y-4">
              {probeErrors.rag && (
                <div
                  className="flex items-center gap-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]"
                  title={typeof probeErrors.rag === "number" ? `HTTP ${probeErrors.rag}` : undefined}
                >
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  {probeErrorLabel(probeErrors.rag)}
                </div>
              )}
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="con-tile">
                  <div className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">Tickers</div>
                  <div className="con-num mt-0.5 text-lg font-bold">{rag?.totalTickers ?? 0}</div>
                </div>
                <div className="con-tile">
                  <div className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">Chunks</div>
                  <div className="con-num mt-0.5 text-lg font-bold">{rag?.totalChunks ?? 0}</div>
                </div>
                <div className="con-tile">
                  <div className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">Vectors</div>
                  <div className="con-num mt-0.5 text-lg font-bold">{rag?.vectorStoreTotalVectors ?? 0}</div>
                </div>
              </div>

              {rag?.globalBreakdown && Object.keys(rag.globalBreakdown).length > 0 && (
                <div className="space-y-1.5 border-t border-[color:var(--con-line)] pt-3">
                  <span className="con-card-title mb-1 block">Index breakdown</span>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(rag.globalBreakdown)
                      .slice(0, 4)
                      .map(([src, count]) => (
                        <Chip key={src} tone={getSourceTone(src)} className="con-mono">
                          {count} {getSourceLabel(src)}
                        </Chip>
                      ))}
                  </div>
                </div>
              )}
              {earningsStatus && (
                <div className="flex items-center justify-between gap-3 border-t border-[color:var(--con-line)] pt-3 text-[length:var(--con-fs-xs)]">
                  <div>
                    <div className="text-[color:var(--con-muted)]">Earnings transcripts</div>
                    <div className="mt-0.5 text-[color:var(--con-faint)]">
                      {earningsStatus.ingestedCount.toLocaleString()} periods indexed
                    </div>
                  </div>
                  <Chip tone={earningsStatusView.tone}>{earningsStatusView.label}</Chip>
                </div>
              )}
            </div>
          </Card>

          {/* ── 4. Server Stats ───────────────────────────────────────────────── */}
          <Card
            title="Server Stats"
            action={
              <Link href="/admin/server" className="con-btn con-btn-ghost con-btn-sm">
                Open →
              </Link>
            }
            className="flex h-full flex-col"
          >
            <div className="space-y-4">
              {probeErrors.server && (
                <div
                  className="mb-2 flex items-center gap-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]"
                  title={typeof probeErrors.server === "number" ? `HTTP ${probeErrors.server}` : undefined}
                >
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  {probeErrorLabel(probeErrors.server)}
                </div>
              )}
              <div className="space-y-3">
                {/* CPU Load */}
                <div>
                  <div className="mb-1 flex items-center justify-between text-[length:var(--con-fs-xs)]">
                    <span
                      className="flex items-center gap-1 text-[color:var(--con-muted)] cursor-help"
                      title={`Each Hetzner CPU sample is divided by the server core count before display.${SENTENCE_GAP}Whether Hetzner already reports a whole-server percentage is unconfirmed, so this value may read low.`}
                    >
                      <Cpu className="h-3.5 w-3.5" /> CPU load
                    </span>
                    <span className="con-num font-semibold">{currentCpu !== undefined ? `${currentCpu.toFixed(1)}%` : "Unavailable"}</span>
                  </div>
                  {currentCpu !== undefined ? <Meter value={currentCpu} max={100} label="CPU load" /> : <div className="h-2 w-full rounded-full bg-[color:var(--con-line)] opacity-50" />}
                </div>

                {/* RAM */}
                <div>
                  <div className="mb-1 flex items-center justify-between text-[length:var(--con-fs-xs)]">
                    <span className="text-[color:var(--con-muted)]">Total memory (RAM)</span>
                    <span className="con-num font-semibold">
                      {server?.hostInfo?.memoryTotalBytes ? `${(server.hostInfo.memoryTotalBytes / 1024 / 1024 / 1024).toFixed(1)} GB` : "Unavailable"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Containers list */}
              <div className="flex items-center justify-between border-t border-[color:var(--con-line)] pt-3 text-[length:var(--con-fs-xs)]">
                <span className="text-[color:var(--con-muted)]">Docker containers</span>
                <span className="con-mono font-semibold">
                  {server?.resourcesObservation?.state === "known" ? `${server?.resources?.filter((c) => { const s = c.status ?? ""; return (s.includes("running") || s.includes("healthy")) && !s.includes("unhealthy"); }).length ?? 0} Running` : "Unavailable"}
                </span>
              </div>
            </div>
          </Card>

          {/* ── 4b. R2 free-tier usage (scheduler snapshot; alert threshold) ── */}
          <Card title="R2 Free-Tier Usage" className="flex h-full flex-col">
            <div className="space-y-4">
              {probeErrors.r2 && (
                <div
                  className="mb-2 flex items-center gap-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]"
                  title={typeof probeErrors.r2 === "number" ? `HTTP ${probeErrors.r2}` : undefined}
                >
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  {probeErrorLabel(probeErrors.r2)}
                </div>
              )}
              {!r2?.configured && (
                <div className="py-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                  Not configured — set the <span className="con-mono">CLOUDFLARE_*_API_TOKEN</span> +{" "}
                  <span className="con-mono">CLOUDFLARE_*_ACCOUNT_ID</span> env pairs (ST/CT/JAY) to monitor the R2 free tiers.
                </div>
              )}
              {r2?.configured && r2.snapshots.length === 0 && (
                <div className="py-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                  No usage check yet — the scheduler lane runs every {r2.intervalHours}h.
                </div>
              )}
              {r2?.replicationDisabled && (
                <div className="rounded-md border border-[color:var(--con-warn)]/40 bg-[color:var(--con-warn)]/10 px-2.5 py-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">
                  Socratic Trade litestream→R2 writes are <strong>paused</strong> (free-tier kill-switch).
                  Pace % still reflects month-to-date history and can look alarming even while new Class A
                  ops are near zero.&nbsp; Resume: <span className="con-mono">POST /api/admin/r2-usage/resume</span>.
                </div>
              )}
              {r2 && r2.snapshots.length > 0 && (
                <div className="space-y-4">
                  {r2.snapshots.map((snap) => (
                    <div key={snap.accountId} className="space-y-3">
                      <div className="text-[length:var(--con-fs-xs)] font-semibold uppercase tracking-wide text-[color:var(--con-faint)]">
                        {snap.accountLabel}
                      </div>
                      {snap.metrics.map((m) => {
                        const fmt = (v: number) =>
                          m.unit === "bytes" ? `${(v / 1024 ** 3).toFixed(2)} GiB` : Math.round(v).toLocaleString();
                        return (
                          <div key={`${snap.accountId}-${m.id}`}>
                            <div className="mb-1 flex items-center justify-between text-[length:var(--con-fs-xs)]">
                              <span className="flex items-center gap-1 text-[color:var(--con-muted)]">
                                <Database className="h-3.5 w-3.5" /> {m.label}
                              </span>
                              <span className={`con-num font-semibold ${m.exceeded ? "text-[color:var(--con-warn)]" : ""}`}>
                                {fmt(m.mtd)} · {m.pctUsed.toFixed(1)}%
                              </span>
                            </div>
                            <Meter value={Math.min(m.pctUsed, 100)} max={100} label={m.label} />
                            <div className="mt-0.5 text-right text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                              {m.alertBasis === "pace" ? `pace → ${m.projectedPct.toFixed(0)}% by month end` : "absolute usage"}
                              {m.exceeded ? ` (>${r2.thresholdPct}% threshold)` : ""}
                            </div>
                          </div>
                        );
                      })}
                      <div className="flex items-center justify-between border-t border-[color:var(--con-line)] pt-2 text-[length:var(--con-fs-xs)]">
                        <span className="text-[color:var(--con-muted)]">Free tier · checked</span>
                        <span className="con-mono text-[color:var(--con-faint)]">
                          {new Date(snap.checkedAt).toLocaleString(undefined, { timeZone: "America/Chicago" })}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>

          {/* ── 5. Chat Transcript (full-width span) ──────────────────────────── */}
          <Card
            title="Chat Transcript"
            action={
              <Link href="/admin/transcript" className="con-btn con-btn-ghost con-btn-sm">
                Open →
              </Link>
            }
            className="sm:col-span-2"
          >
            <div className="divide-y divide-[color:var(--con-line)]">
              {probeErrors.transcript && (
                <div
                  className="flex items-center gap-1.5 pb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]"
                  title={typeof probeErrors.transcript === "number" ? `HTTP ${probeErrors.transcript}` : undefined}
                >
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  {probeErrorLabel(probeErrors.transcript)}
                </div>
              )}
              {transcript?.turns.filter((t) => t.role === "assistant").reverse().slice(0, 2).map((t, i) => (
                <div key={t.id} className={`${i > 0 ? "pt-3.5" : ""} flex flex-col gap-1.5 pb-3.5`}>
                  <div className="flex items-center justify-between text-[length:var(--con-fs-xs)]">
                    <Chip tone="accent" className="con-mono">
                      {t.model ?? "Unknown Model"}
                    </Chip>
                    <span className="con-mono text-[color:var(--con-faint)]">
                      {new Date(t.createdAt).toLocaleString(undefined, { timeZone: "America/Chicago" })}
                    </span>
                  </div>
                  {/* The turn text is markdown SOURCE. Interpolating it as a text node made
                      every `**bold**`, `###`, and table pipe show up literally, in a monospace
                      italic that read as "this is code" — it isn't. Render it through the same
                      component the full transcript uses, clamped by HEIGHT rather than
                      `line-clamp`: `-webkit-line-clamp` clamps one inline flow, so a heading,
                      list, or table in the reply would escape it and blow out the card. */}
                  <div className="con-tile overflow-hidden">
                    <Markdown className="max-h-[3.3em] overflow-hidden text-[color:var(--con-muted)]">{t.text}</Markdown>
                  </div>
                </div>
              ))}
              {transcript?.turns.filter((t) => t.role === "assistant").length === 0 && (
                <div className="py-4 text-center text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                  No transcripts recorded yet.
                </div>
              )}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
