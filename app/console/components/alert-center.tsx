"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, BellOff, BellRing, Check, CheckCheck, Database, ShieldAlert } from "lucide-react";
import { alertConditionKey, isAlertMuted, type AlertMuteMap } from "@/lib/alert-mutes";
import { formatNotificationDisplay, isSystemSymbol } from "@/lib/dashboard-ui";
import type { ConnectedAccount, NotificationEvent } from "@/lib/types";
import type { DashboardSnapshot } from "../../dashboard-types";
import {
  acknowledgeAllAttention,
  acknowledgeNotifications,
  fetchAlertMutes,
  setAlertConditionMute,
  ConsoleApiError
} from "../lib/api";
import { cx } from "../lib/format";
import { notificationStatusLabel, notificationTypeLabel } from "../lib/labels";
import { useConsoleData } from "../lib/useConsoleData";
import { Ago, Btn, Card, Chip, Empty, TextInput } from "../ui/primitives";
import { SymbolButton } from "../ui/symbol-drilldown";
import { useSymbolDrawer } from "../ui/symbol-drawer";
import { useToast } from "../ui/toast";

type AlertCenterFilter = "attention" | "deliveries" | "approvals" | "all";

type AlertCenterRow = {
  /** Newest event of the incident — the one actually rendered. */
  event: NotificationEvent;
  title: string;
  detail: string;
  symbol?: string;
  companyName?: string;
  accountLabel?: string;
  tone: "neg" | "warn" | "accent" | "muted";
  /** How many notification rows this one line stands for (1 = not a repeat). */
  repeatCount: number;
  /** createdAt of the OLDEST row in the incident — "degraded since". */
  firstAt: string;
  /** Every row id in the incident, newest first. Acknowledging the line acks all of them. */
  eventIds: string[];
};

function accountLabelMap(accounts: ConnectedAccount[]): Record<string, string> {
  return Object.fromEntries(accounts.map((account) => [account.id, account.label || account.broker]));
}

function inScopeNotifications(notifications: NotificationEvent[], activeAccountId?: string) {
  if (!activeAccountId) return { events: [...notifications], hiddenOtherAccount: 0 };
  const events = notifications.filter((event) => !event.connectedAccountId || event.connectedAccountId === activeAccountId);
  return { events, hiddenOtherAccount: notifications.length - events.length };
}

function alertTone(event: NotificationEvent): AlertCenterRow["tone"] {
  if (event.type === "kill_switch" || event.type === "run_failed") return "neg";
  if (
    event.status === "failed" ||
    event.type === "budget_alert" ||
    event.type === "provider_degraded" ||
    event.type === "earningscalls_entitlement_blocked" ||
    event.type === "roic_status_advisory" ||
    event.type === "risk_advisory"
  ) {
    return "warn";
  }
  if (event.type === "pending_approval") return "accent";
  return "muted";
}

/** Exported (only) for direct unit testing — see test/notification-lifecycle.test.ts, which imports
 *  this pure function without rendering the component (same idiom as test/console-sheet.test.tsx). */
export function matchesFilter(event: NotificationEvent, filter: AlertCenterFilter): boolean {
  switch (filter) {
    case "attention":
      // Acknowledged rows drop out of Attention (that's the point of acknowledging) but remain
      // visible under "All" — the "all" case below is unconditional on acknowledgedAt.
      return (
        !event.acknowledgedAt &&
        (event.type === "kill_switch" ||
          event.type === "run_failed" ||
          event.type === "budget_alert" ||
          event.type === "provider_degraded" ||
          event.type === "earningscalls_entitlement_blocked" ||
          event.type === "roic_status_advisory" ||
          event.type === "risk_advisory" ||
          event.status === "failed")
      );
    case "deliveries":
      return event.status === "failed" || event.status === "skipped";
    case "approvals":
      return event.type === "pending_approval" || event.type === "block" || event.type === "proposal_withdrawn";
    case "all":
    default:
      return true;
  }
}

function matchesQuery(row: AlertCenterRow, query: string): boolean {
  if (!query) return true;
  const haystack = [row.title, row.detail, row.symbol, row.companyName, row.accountLabel, row.event.type]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

/** Alert types that get re-emitted for one CONTINUING condition rather than once per new event, so
 *  the rows are repeats of a single incident and must be counted as one. `provider_degraded` is the
 *  case that forced this: db-health's alert cooldown (HEALTH_ALERT_COOLDOWN_MS, 6h) suppresses
 *  re-SENDING but still writes a fresh notification row each window, so a single provider outage
 *  lasting three days lands ~12 separate rows in Attention and the pill reads "12" for one problem.
 *  Anything NOT listed here keeps one row = one incident; add a type only when its repeats really do
 *  describe the same condition. */
const GROUPED_ALERT_TYPES: ReadonlySet<NotificationEvent["type"]> = new Set(["provider_degraded"]);

/** Fingerprint deciding which rows are repeats of ONE incident.
 *
 *  Keyed on the title, deliberately NOT on the payload: `provider_degraded` has four producers
 *  (db-health's connection alert, vector-db's RAG failure, the LLM provider-cooldown escalation,
 *  and the provider-tier downgrade) and each writes a different payload shape, so any single
 *  payload field is undefined for most of them — a payload key would collapse three unrelated
 *  subsystems into one row, which is worse than not grouping at all. Every producer does name the
 *  failing thing in the title ("fmp connection failed"). When `payload.service` is present
 *  (db-health connection alerts) that lane id wins so "congress.trade connection failed" and
 *  a later "congress.trade connection failed: timeout" still collapse as one incident.
 *
 *  Acknowledged state is part of the key on purpose: an acked row has left Attention, and folding it
 *  together with live rows would either drag it back in or hide live rows behind an acked
 *  representative. */
function incidentKey(event: NotificationEvent): string {
  if (!GROUPED_ALERT_TYPES.has(event.type)) return event.id;
  const payload =
    event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {};
  const service = typeof payload.service === "string" ? payload.service.trim() : "";
  const lane = service || event.title;
  return [event.type, event.connectedAccountId ?? "", event.acknowledgedAt ? "ack" : "open", lane].join("|");
}

/** Exported (only) for direct unit testing — see test/alert-center-incident-grouping.test.ts. */
export function buildRows(
  notifications: NotificationEvent[],
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"],
  connectedAccounts: ConnectedAccount[]
): AlertCenterRow[] {
  const labels = accountLabelMap(connectedAccounts);
  const byIncident = new Map<string, AlertCenterRow>();
  const sorted = notifications.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  for (const event of sorted) {
    const key = incidentKey(event);
    const existing = byIncident.get(key);
    if (existing) {
      // Newest-first iteration, so the first row seen is the representative and every later one is an
      // older repeat: extend the count, walk firstAt back, and remember the id so acknowledging the
      // collapsed line clears the whole incident instead of uncovering the next repeat underneath it.
      existing.repeatCount += 1;
      existing.firstAt = event.createdAt;
      existing.eventIds.push(event.id);
      continue;
    }
    const display = formatNotificationDisplay(event, symbolMetaBySymbol);
    byIncident.set(key, {
      event,
      title: display.title,
      detail: display.detail,
      symbol: display.symbol,
      companyName: display.companyName,
      accountLabel: event.connectedAccountId ? labels[event.connectedAccountId] : undefined,
      tone: alertTone(event),
      repeatCount: 1,
      firstAt: event.createdAt,
      eventIds: [event.id]
    });
  }
  // Map iteration preserves insertion order, which is already the newest-first sort above.
  return Array.from(byIncident.values());
}

/** Per-condition mutes (#2555): split incident rows into the ones still shown and the ones a
 *  live mute hides. Rendering-only — the rows still exist, still count under the visible
 *  "muted N" affordance, and come back the moment the mute lapses or is reversed.
 *  Exported (only) for direct unit testing. */
export function splitMutedAlertRows(
  rows: AlertCenterRow[],
  mutes: AlertMuteMap,
  nowMs: number
): { active: AlertCenterRow[]; muted: AlertCenterRow[] } {
  const active: AlertCenterRow[] = [];
  const muted: AlertCenterRow[] = [];
  for (const row of rows) {
    (isAlertMuted(row.event, mutes, nowMs) ? muted : active).push(row);
  }
  return { active, muted };
}

/** Provider-outage rollup (#2555): every provider_degraded incident collapses into ONE
 *  expandable "N provider lanes degraded" row so infrastructure weather never buries real
 *  attention items (Run failed, protective_exit_failing) in the same flat list.
 *  Exported (only) for direct unit testing. */
export function partitionProviderRollup(rows: AlertCenterRow[]): { provider: AlertCenterRow[]; rest: AlertCenterRow[] } {
  const provider: AlertCenterRow[] = [];
  const rest: AlertCenterRow[] = [];
  for (const row of rows) {
    (row.event.type === "provider_degraded" ? provider : rest).push(row);
  }
  return { provider, rest };
}

export function AlertCenter({
  notifications,
  connectedAccounts,
  symbolMetaBySymbol,
  activeAccountId,
  title = "Alerts Center",
  maxItems
}: {
  notifications: NotificationEvent[];
  connectedAccounts: ConnectedAccount[];
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"];
  activeAccountId?: string;
  title?: string;
  maxItems?: number;
}) {
  const [filter, setFilter] = useState<AlertCenterFilter>("attention");
  const [query, setQuery] = useState("");
  const [ackingIds, setAckingIds] = useState<Set<string>>(new Set());
  const [bulkAcking, setBulkAcking] = useState(false);
  const [mutes, setMutes] = useState<AlertMuteMap>({});
  const [showMuted, setShowMuted] = useState(false);
  const [mutingKeys, setMutingKeys] = useState<Set<string>>(new Set());
  // Mute expiries are 24h-granular; a minute-level clock keeps lapsed mutes surfacing
  // without an impure Date.now() inside render (same pattern as orders/page.tsx).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);
  const { refresh } = useConsoleData();
  const toast = useToast();
  useEffect(() => {
    let alive = true;
    fetchAlertMutes()
      .then((result) => {
        if (alive) setMutes(result.mutes);
      })
      .catch(() => {
        /* mutes are a rendering nicety — a failed fetch just shows everything */
      });
    return () => {
      alive = false;
    };
  }, []);
  const { events, hiddenOtherAccount } = useMemo(
    () => inScopeNotifications(notifications, activeAccountId),
    [notifications, activeAccountId]
  );
  const rows = useMemo(
    () => buildRows(events, symbolMetaBySymbol, connectedAccounts),
    [events, symbolMetaBySymbol, connectedAccounts]
  );
  const { active: activeRows, muted: mutedRows } = useMemo(
    () => splitMutedAlertRows(rows, mutes, nowMs),
    [rows, mutes, nowMs]
  );
  const normalizedQuery = query.trim().toLowerCase();
  const visibleRows = useMemo(() => {
    const filtered = activeRows.filter((row) => matchesFilter(row.event, filter) && matchesQuery(row, normalizedQuery));
    return typeof maxItems === "number" ? filtered.slice(0, maxItems) : filtered;
  }, [activeRows, filter, normalizedQuery, maxItems]);
  // Muted rows matching the same filter/query — hidden behind the visible "muted N" affordance.
  const mutedVisibleRows = useMemo(
    () => mutedRows.filter((row) => matchesFilter(row.event, filter) && matchesQuery(row, normalizedQuery)),
    [mutedRows, filter, normalizedQuery]
  );
  // Rollup (#2555): provider_degraded incidents render as ONE expandable row.
  const { provider: providerRows, rest: restRows } = useMemo(() => partitionProviderRollup(visibleRows), [visibleRows]);

  const summary = useMemo(
    () => ({
      attention: activeRows.filter((row) => matchesFilter(row.event, "attention")).length,
      deliveries: activeRows.filter((row) => matchesFilter(row.event, "deliveries")).length,
      approvals: activeRows.filter((row) => matchesFilter(row.event, "approvals")).length,
      total: activeRows.length
    }),
    [activeRows]
  );

  const filters: Array<{ id: AlertCenterFilter; label: string; count: number; hint: string }> = [
    {
      id: "attention",
      label: "Attention",
      count: summary.attention,
      hint: "Events that likely need you: kill switch, failed runs, budget alerts, degraded providers, failed deliveries.  Repeat alerts for one ongoing condition count once."
    },
    { id: "deliveries", label: "Deliveries", count: summary.deliveries, hint: "Notification deliveries that failed or were skipped." },
    { id: "approvals", label: "Approvals", count: summary.approvals, hint: "Proposals waiting for you, policy blocks, and withdrawn ideas." },
    { id: "all", label: "All Alerts", count: summary.total, hint: "Every alert in the current account scope." }
  ];

  // Acks the whole incident, not just the row on screen: a collapsed provider_degraded line stands
  // for every repeat behind it, and acking only the representative would leave the older repeats
  // unacknowledged — they would immediately regroup into a fresh Attention row and the button would
  // look broken.
  const acknowledgeOne = async (row: AlertCenterRow) => {
    const id = row.event.id;
    setAckingIds((prev) => new Set(prev).add(id));
    try {
      await acknowledgeNotifications(row.eventIds);
      await refresh();
    } catch (error) {
      toast.push("neg", "Could not acknowledge alert", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setAckingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  // Advisory + reversible (#2555): a mute only hides this condition's rows HERE for 24h —
  // detection, recording, and delivery are untouched, and the "muted N" affordance below
  // keeps the hidden rows one click away.
  const toggleMute = async (row: AlertCenterRow, mute: boolean) => {
    const key = alertConditionKey(row.event);
    setMutingKeys((prev) => new Set(prev).add(key));
    try {
      const result = await setAlertConditionMute(key, mute);
      setMutes(result.mutes);
    } catch (error) {
      toast.push(
        "neg",
        mute ? "Could not mute this condition" : "Could not unmute this condition",
        error instanceof ConsoleApiError ? error.message : String(error)
      );
    } finally {
      setMutingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const acknowledgeAllVisible = async () => {
    setBulkAcking(true);
    try {
      // Scope the bulk ack to the account this view is actually filtered to (inScopeNotifications
      // above) — without this, "Acknowledge all" would also silently ack unacknowledged rows from
      // the user's OTHER connected accounts, which never appeared in this list at all.
      const result = await acknowledgeAllAttention(activeAccountId);
      await refresh();
      // `result.acknowledged` counts ROWS, while the Attention pill counts incidents, so this can
      // legitimately read "Acknowledged 12 alerts" after a pill showing 3. That is the truth on both
      // sides, and the collapsed rows carry a visible "x12" badge so the arithmetic is legible —
      // do not "fix" the mismatch by making either number lie about what it counted.
      toast.push("pos", `Acknowledged ${result.acknowledged} alert${result.acknowledged === 1 ? "" : "s"}`);
    } catch (error) {
      toast.push("neg", "Could not acknowledge alerts", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBulkAcking(false);
    }
  };

  return (
    <Card
      title={
        <span className="flex items-center gap-1.5">
          <BellRing size={13} /> {title}
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        {hiddenOtherAccount > 0 && (
          <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            {hiddenOtherAccount} alert{hiddenOtherAccount === 1 ? "" : "s"} from your other accounts{" "}
            {hiddenOtherAccount === 1 ? "is" : "are"} hidden by the current account scope.
          </p>
        )}

        {/* Wrapping pill row instead of a fixed 4-column tile grid: the uppercase tile headings
            clipped ("DELIVERIE…") in narrow rails.  Pills wrap to any width, use Title Case,
            and signal the selected state with aria-pressed + weight, not color alone. */}
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Alert filters">
          {filters.map((item) => {
            const selected = filter === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                aria-pressed={selected}
                title={item.hint}
                className={cx(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[length:var(--con-fs-xs)] transition-colors [@media(pointer:coarse)]:min-h-11",
                  selected
                    ? "border-[color:var(--con-accent)] bg-[color:var(--con-accent-soft)] font-bold text-[color:var(--con-accent)]"
                    : "border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] font-semibold text-[color:var(--con-muted)] hover:border-[color:var(--con-line-strong)]"
                )}
              >
                {item.label}
                <span className="con-num font-semibold" aria-label={`${item.count} alerts`}>
                  {item.count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <TextInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter alerts by symbol, title, account, or type"
            aria-label="Filter alerts"
            className="flex-1"
          />
          {filter === "attention" && summary.attention > 0 && (
            <Btn variant="outline" size="sm" disabled={bulkAcking} onClick={() => void acknowledgeAllVisible()} title="Acknowledge every alert currently in Attention">
              <CheckCheck size={13} /> Acknowledge all
            </Btn>
          )}
        </div>

        {visibleRows.length === 0 && mutedVisibleRows.length === 0 ? (
          <Empty>{filter === "attention" ? "No alerts need attention." : "No alerts match this filter."}</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {providerRows.length > 0 && (
              <details className="rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)]">
                <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-3">
                  <AlertTriangle size={14} className="shrink-0 text-[color:var(--con-warn)]" />
                  <span className="font-semibold text-[color:var(--con-fg)]">
                    {providerRows.length} provider lane{providerRows.length === 1 ? "" : "s"} degraded
                  </span>
                  <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                    infrastructure weather, rolled up so it never buries real attention items — expand for lanes
                  </span>
                  <span className="ml-auto text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                    <Ago iso={providerRows[0]!.event.createdAt} />
                  </span>
                </summary>
                <div className="flex flex-col gap-2 border-t border-[color:var(--con-line)] px-3 py-2">
                  {providerRows.map((row) => (
                    <AlertRow
                      key={row.event.id}
                      row={row}
                      acking={ackingIds.has(row.event.id)}
                      muting={mutingKeys.has(alertConditionKey(row.event))}
                      muted={false}
                      onAck={() => void acknowledgeOne(row)}
                      onMute={(mute) => void toggleMute(row, mute)}
                    />
                  ))}
                </div>
              </details>
            )}
            {restRows.map((row) => (
              <AlertRow
                key={row.event.id}
                row={row}
                acking={ackingIds.has(row.event.id)}
                muting={mutingKeys.has(alertConditionKey(row.event))}
                muted={false}
                onAck={() => void acknowledgeOne(row)}
                onMute={(mute) => void toggleMute(row, mute)}
              />
            ))}
            {mutedVisibleRows.length > 0 && (
              <button
                type="button"
                onClick={() => setShowMuted((prev) => !prev)}
                className="self-start text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)] underline decoration-dotted underline-offset-2 hover:text-[color:var(--con-fg)]"
                title="Muted conditions stay recorded and delivered — only this list hides them, and only for 24h per mute."
              >
                muted {mutedVisibleRows.length} — {showMuted ? "hide" : "show"}
              </button>
            )}
            {showMuted &&
              mutedVisibleRows.map((row) => (
                <AlertRow
                  key={row.event.id}
                  row={row}
                  acking={ackingIds.has(row.event.id)}
                  muting={mutingKeys.has(alertConditionKey(row.event))}
                  muted
                  onAck={() => void acknowledgeOne(row)}
                  onMute={(mute) => void toggleMute(row, mute)}
                />
              ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function AlertRow({
  row,
  acking,
  muting,
  muted,
  onAck,
  onMute
}: {
  row: AlertCenterRow;
  acking: boolean;
  muting: boolean;
  muted: boolean;
  onAck: () => void;
  onMute: (mute: boolean) => void;
}) {
  const acknowledged = Boolean(row.event.acknowledgedAt);
  return (
    <article
      className={cx(
        "rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-3",
        (acknowledged || muted) && "opacity-60"
      )}
    >
      <div className="flex flex-wrap items-start gap-2">
        <Chip tone={acknowledged ? "muted" : row.tone}>{notificationTypeLabel(row.event.type)}</Chip>
        <Chip
          tone={row.event.status === "failed" ? "neg" : row.event.status === "sent" ? "pos" : "muted"}
        >
          {notificationStatusLabel(row.event.status)}
        </Chip>
        {row.repeatCount > 1 && (
          <Chip
            tone="muted"
            title={`${row.repeatCount} alerts recorded for this one condition — the app re-alerts while it persists.`}
          >
            x{row.repeatCount}
          </Chip>
        )}
        {muted && (
          <Chip tone="muted" title="This condition is muted here for 24h — recording and delivery are unaffected.">
            muted
          </Chip>
        )}
        {row.symbol && (
          // The dashboard-ui symbol extractor used to scan alert titles with an all-caps regex
          // and link any match (including system identifiers like "RAG") into the SymbolDrilldown
          // drawer — opening a phantom price-history page for the AI feature.  When the resolved
          // token is a known system identifier, render a non-clickable Chip so the row still
          // surfaces the source label without inviting the bad click.  RAG is special-cased to
          // open the dedicated RAG info drawer (universe + last ingest + last strategy run)
          // instead of a phantom symbol drilldown.
          isSystemSymbol(row.symbol) ? (
            <SystemSymbolChip symbol={row.symbol} event={row.event} />
          ) : (
            <SymbolButton symbol={row.symbol} className="text-[length:var(--con-fs-xs)]" />
          )
        )}
        <div className="ml-auto flex items-center gap-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          <Ago iso={row.event.createdAt} />
          <Btn
            variant="ghost"
            size="sm"
            disabled={muting}
            onClick={() => onMute(!muted)}
            title={
              muted
                ? "Unmute — this condition's rows show here again immediately"
                : "Mute this condition for 24h — hides its rows here only; recording and delivery are unaffected.  Reversible via the muted count below the list."
            }
            aria-label={muted ? "Unmute condition" : "Mute condition for 24 hours"}
          >
            {muted ? <BellRing size={13} /> : <BellOff size={13} />}
          </Btn>
          {!acknowledged && (
            <Btn
              variant="ghost"
              size="sm"
              disabled={acking}
              onClick={onAck}
              title={
                row.repeatCount > 1
                  ? `Acknowledge — clears all ${row.repeatCount} alerts for this condition from Attention, they stay visible under All`
                  : "Acknowledge — clears this from Attention, stays visible under All"
              }
              aria-label={row.repeatCount > 1 ? `Acknowledge ${row.repeatCount} alerts` : "Acknowledge alert"}
            >
              <Check size={13} />
            </Btn>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-start gap-2">
        {!acknowledged && row.tone === "neg" ? (
          <ShieldAlert size={14} className="mt-0.5 shrink-0 text-[color:var(--con-neg)]" />
        ) : !acknowledged && row.tone === "warn" ? (
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[color:var(--con-warn)]" />
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-relaxed text-[color:var(--con-fg)]">{row.title}</p>
          <p className="mt-1 text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]">{row.detail}</p>
          {row.repeatCount > 1 && (
            <p className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              {row.repeatCount} alerts for this condition, oldest <Ago iso={row.firstAt} />
            </p>
          )}
          {(row.accountLabel || row.companyName || acknowledged) && (
            <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              {[
                row.accountLabel ? `Account ${row.accountLabel}` : undefined,
                row.companyName,
                acknowledged ? "Acknowledged" : undefined
              ]
                .filter(Boolean)
                .join(" · ")}
              {acknowledged && row.event.acknowledgedAt && (
                <>
                  {" "}
                  <Ago iso={row.event.acknowledgedAt} />
                </>
              )}
            </p>
          )}
        </div>
      </div>
    </article>
  );
}

/** Non-clickable badge for tokens that look like tickers but are actually system identifiers
 *  (RAG, FMP, ALPACA, OPENROUTER, …).  Replaces the previous SymbolButton rendering path that
 *  routed "RAG" through a phantom SymbolDrilldown sheet.  RAG is special-cased to open the
 *  dedicated RAG info drawer (universe + last strategy run + last ingest); every other system
 *  identifier renders a static informational chip so the row still labels the source. */
function SystemSymbolChip({ symbol, event }: { symbol: string; event: NotificationEvent }) {
  const { openDrawer } = useSymbolDrawer();
  if (symbol === "RAG") {
    return (
      <button
        type="button"
        title="Show RAG (Retrieval-Augmented Generation) details for this account"
        onClick={(click) => {
          click.stopPropagation();
          openRagInfoDrawer(openDrawer);
        }}
        className="inline-flex items-center gap-1.5 rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-2 py-0.5 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-fg)] transition-colors hover:border-[color:var(--con-accent)] hover:text-[color:var(--con-accent)]"
      >
        <Database size={11} />
        <span>{symbol}</span>
      </button>
    );
  }
  return (
    <Chip tone="muted" title={`${symbol} is a system identifier, not a tradable symbol — alert source label only.`}>
      {symbol}
    </Chip>
  );
}

/** Opens the RAG info drawer via the shared SymbolDrawer context.  Renders a focused sheet
 *  describing the universe under retrieval, the last ingest event, and the most recent
 *  strategy run that pulled from RAG — the answers an owner wants when an alert says
 *  "Usage limit hit: openrouter RAG ingest hit daily cap".  The drawer body intentionally
 *  composes from props-only (no live fetch on mount) so the alert chip opens instantly;
 *  future work can layer an async refresh if the field proves useful for daily ops. */
function openRagInfoDrawer(
  openDrawer: ReturnType<typeof useSymbolDrawer>["openDrawer"]
): void {
  openDrawer({
    title: (
      <span className="flex items-center gap-2">
        <Database size={14} />
        <span>RAG — Retrieval-Augmented Generation</span>
      </span>
    ),
    ariaLabel: "RAG info",
    body: <RagInfoSheet />
  });
}

function RagInfoSheet() {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]">
        Retrieval-Augmented Generation is the system that pulls SEC filings, earnings transcripts,
        and other corpus documents into strategy-run prompts.  It is not a stock ticker; the alerts
        below it describe ingest, retrieval, and provider-health events for THIS account's universe.
      </p>
      <div className="grid gap-2">
        <RagInfoRow label="Universe size" hint="Documents reachable in the vector store for the active account scope" pending />
        <RagInfoRow label="Last ingest" hint="Most recent successful embed + upsert pair (UTC)" pending />
        <RagInfoRow label="Last strategy run using RAG" hint="The most recent run that called the RAG retrieval tool" pending />
        <RagInfoRow label="Daily cap" hint="Rolling 24h text-budget (RAG_INGEST_MAX_TEXTS_PER_DAY)" pending />
      </div>
      <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Live metrics are not yet wired here — follow-up lane will surface per-account universe
        size, last ingest timestamp, and the last retrieval-call site (strategy run id).  Until
        then, the active alerts above tell you which lane is degraded.
      </p>
    </div>
  );
}

function RagInfoRow({ label, hint, pending }: { label: string; hint: string; pending?: boolean }) {
  return (
    <div className="rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2">
      <p className="text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-fg)]">{label}</p>
      <p className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">{hint}</p>
      {pending && (
        <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          <em>not wired in this PR</em>
        </p>
      )}
    </div>
  );
}
