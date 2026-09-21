"use client";

/** Activity — Alerts Center, Notifications, Strategy Runs, Order Fills, Audit Log. */

import { Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ACTIVITY_TAB_IDS,
  ACTIVITY_TABS,
  parseActivityTab,
  type ActivityTabId
} from "@/lib/activity-tabs";
import { AlertCenter } from "../components/alert-center";
import { destinationLabel } from "../components/nav";
import { activeConnectedAccount } from "../lib/derive";
import { cx } from "../lib/format";
import { CONSOLE_PAGE_WIDTH } from "../lib/page-width";
import { nextTabId } from "../lib/tabs";
import { useConsoleData } from "../lib/useConsoleData";
import { AuditFeed } from "./audit-feed";
import { NotificationsLedger } from "./notifications-ledger";
import { OrderFillsList } from "./order-fills-list";
import { StrategyRunsList } from "./strategy-runs-list";

export const metadata = { title: "Activity" };

export default function ActivityPage() {
  return (
    <Suspense fallback={null}>
      <ActivityPageInner />
    </Suspense>
  );
}

function ActivityPageInner() {
  const { snapshot } = useConsoleData();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTabState] = useState<ActivityTabId>(() => parseActivityTab(searchParams.get("tab")));
  const tabRefs = useRef<Partial<Record<ActivityTabId, HTMLButtonElement | null>>>({});

  useEffect(() => {
    setTabState(parseActivityTab(searchParams.get("tab")));
  }, [searchParams]);

  const setTab = (id: ActivityTabId) => {
    setTabState(id);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", id);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const accountLabelById = useMemo(
    () =>
      Object.fromEntries(
        (snapshot?.connectedAccounts ?? []).map((account) => [account.id, account.label || account.broker])
      ),
    [snapshot?.connectedAccounts]
  );

  if (!snapshot) return null;

  const onTabsKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = nextTabId(ACTIVITY_TAB_IDS, tab, e.key);
    if (!next) return;
    e.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className={cx(CONSOLE_PAGE_WIDTH, "flex flex-col gap-4 px-4 sm:px-6")}>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">{destinationLabel("/console/activity")}</h1>
        <div
          role="tablist"
          aria-label="Activity views"
          onKeyDown={onTabsKeyDown}
          className="flex min-h-11 gap-1 overflow-x-auto rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface)] p-1"
        >
          {ACTIVITY_TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              id={`activity-tab-${t.id}`}
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={tab === t.id ? `activity-tabpanel-${t.id}` : undefined}
              tabIndex={tab === t.id ? 0 : -1}
              type="button"
              onClick={() => setTab(t.id)}
              className={cx(
                "min-h-11 shrink-0 rounded-control px-3 py-1 text-[length:var(--con-fs-xs)] font-semibold transition-colors",
                tab === t.id
                  ? "bg-[color:var(--con-accent-soft)] text-[color:var(--con-accent)]"
                  : "text-[color:var(--con-muted)] hover:text-[color:var(--con-fg)]"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div role="tabpanel" id={`activity-tabpanel-${tab}`} aria-labelledby={`activity-tab-${tab}`}>
        {tab === "alerts" && (
          <AlertCenter
            notifications={snapshot.notifications ?? []}
            connectedAccounts={snapshot.connectedAccounts}
            symbolMetaBySymbol={snapshot.symbolMetaBySymbol}
            activeAccountId={activeConnectedAccount(snapshot)?.id}
            title="Alerts Center"
            maxItems={100}
          />
        )}
        {tab === "notifications" && (
          <NotificationsLedger
            notifications={snapshot.notifications ?? []}
            connectedAccounts={snapshot.connectedAccounts}
            symbolMetaBySymbol={snapshot.symbolMetaBySymbol}
            activeAccountId={activeConnectedAccount(snapshot)?.id}
          />
        )}
        {tab === "runs" && (
          <StrategyRunsList
            runs={snapshot.strategyRuns ?? []}
            recentProposals={snapshot.recentProposals ?? []}
            accountLabelById={accountLabelById}
          />
        )}
        {tab === "fills" && <OrderFillsList fills={snapshot.performance?.fills ?? []} />}
        {tab === "audit" && <AuditFeed groups={snapshot.unifiedFeed ?? []} />}
      </div>
    </div>
  );
}
