"use client";

/** Header inbox so a toast is not the only place a notification lives.
 *  Reuses the same persisted notification_events the Activity Alert Center shows. */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Bell, Check } from "lucide-react";
import { formatNotificationDisplay } from "@/lib/dashboard-ui";
import { inScopeNotificationEvents, unreadNotificationCount } from "@/lib/notification-history";
import type { DashboardSnapshot } from "../../dashboard-types";
import { acknowledgeNotifications, ConsoleApiError } from "../lib/api";
import { activeConnectedAccount } from "../lib/derive";
import { cx } from "../lib/format";
import { useConsoleData } from "../lib/useConsoleData";
import { Ago, Btn } from "../ui/primitives";
import { useFocusTrap } from "../ui/focus-trap";
import { useToast } from "../ui/toast";

const INBOX_PREVIEW = 8;

export function NotificationInbox({ snapshot }: { snapshot: DashboardSnapshot }) {
  const [open, setOpen] = useState(false);
  const [ackingIds, setAckingIds] = useState<Set<string>>(new Set());
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { refresh } = useConsoleData();
  const toast = useToast();
  const activeAccountId = activeConnectedAccount(snapshot)?.id;
  const scoped = useMemo(
    () => inScopeNotificationEvents(snapshot.notifications ?? [], activeAccountId),
    [snapshot.notifications, activeAccountId]
  );
  const unread = unreadNotificationCount(snapshot.notifications ?? [], activeAccountId);
  const preview = scoped.slice(0, INBOX_PREVIEW);

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useFocusTrap(menuRef, open, { onEscape: close });

  const markRead = async (ids: string[]) => {
    const unique = ids.filter((id) => id.length > 0);
    if (unique.length === 0) return;
    const key = unique[0]!;
    setAckingIds((prev) => new Set(prev).add(key));
    try {
      await acknowledgeNotifications(unique);
      await refresh();
    } catch (error) {
      toast.push("neg", "Could not mark as read", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setAckingIds((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  return (
    <div className="shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        title={unread > 0 ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "Notifications"}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-[color:var(--con-line-strong)] text-[color:var(--con-muted)] transition-colors hover:border-[color:var(--con-accent)] hover:text-[color:var(--con-accent)] [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
      >
        <Bell size={14} aria-hidden />
        {unread > 0 && (
          <span className="con-badge absolute -right-1.5 -top-1.5 min-w-4 px-1">{unread > 99 ? "99+" : unread}</span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} aria-hidden />
          <div
            ref={menuRef}
            role="dialog"
            aria-label="Notifications"
            tabIndex={-1}
            className="con-menu-drop absolute right-2 top-[calc(100%+2px)] z-50 w-[min(92vw,380px)] rounded-card border border-[color:var(--con-line-strong)] bg-[color:var(--con-surface)] p-3 shadow-xl"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-[length:var(--con-fs-sm)] font-semibold">Notifications</div>
              <Link
                href="/console/activity?tab=alerts"
                className="text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)] hover:underline"
                onClick={close}
              >
                Open Alerts Center
              </Link>
            </div>
            {preview.length === 0 ? (
              <p className="px-1 py-3 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                No notifications yet.  Alerts stay here after the toast is gone.
              </p>
            ) : (
              <ul className="flex max-h-[min(70vh,28rem)] flex-col gap-2 overflow-auto">
                {preview.map((event) => {
                  const display = formatNotificationDisplay(event, snapshot.symbolMetaBySymbol ?? {});
                  const read = Boolean(event.acknowledgedAt);
                  return (
                    <li
                      key={event.id}
                      className={cx(
                        "rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2.5",
                        read && "opacity-60"
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 font-semibold text-[color:var(--con-fg)]">{display.title}</p>
                        <span className="shrink-0 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                          {read ? "read" : "unread"}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
                        {display.detail}
                      </p>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                        <Ago iso={event.createdAt} />
                        {!read && (
                          <Btn
                            variant="ghost"
                            size="sm"
                            disabled={ackingIds.has(event.id)}
                            onClick={() => void markRead([event.id])}
                            aria-label="Mark as Read"
                          >
                            <Check size={13} /> Mark as Read
                          </Btn>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
