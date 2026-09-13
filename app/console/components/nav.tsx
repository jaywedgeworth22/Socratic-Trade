"use client";

/** Destinations: left rail on desktop (≥1024px), bottom tab bar on mobile.
 *  Approvals carries a red badge for pending trade proposals.
 *  Lessons handles pending/past learning (without a badge). */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { useOverlay } from "../ui/use-overlay";
import {
  Activity as ActivityIcon,
  BarChart3,
  Brain,
  Eye,
  Globe,
  Inbox,
  LayoutDashboard,
  GraduationCap,
  LayoutGrid,
  ListChecks,
  MessageSquare,
  Pin,
  Plug,
  Radar,
  ReceiptText,
  Settings as SettingsIcon,
  Shield,
  X
} from "lucide-react";
import { useFocusTrap } from "../ui/focus-trap";
import { cx } from "../lib/format";
import { useNavDirtyGuard } from "../lib/useDirtyGuard";
import { DEFAULT_MOBILE_TAB_HREFS, MOBILE_TABS_MAX, MOBILE_TABS_MIN, useMobileTabs, type MobileTabsState } from "../lib/mobile-tabs";

function badgeTitle(proposals: number): string {
  if (proposals > 0) return `${proposals} trade proposal${proposals === 1 ? "" : "s"} waiting for your decision`;
  return "";
}

function unreadTitle(unread: number): string {
  if (unread > 0) return `${unread} unread notification${unread === 1 ? "" : "s"}`;
  return "";
}

interface Destination {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Concise hover explanation (native title) — every destination has one. */
  desc: string;
}

export const DESTINATIONS: Destination[] = [
  // Wave B / PR-B1: plain-language rail labels. Hover `desc` keeps the
  // sophisticated Socratic metaphor (thesis / evidence / journal / regime / outcomes).
  { href: "/console", label: "Home", icon: LayoutDashboard, desc: "Live thesis, actions, evidence, dissent, and framework learning." },
  { href: "/console/approvals", label: "Proposals", icon: Inbox, desc: "Trade proposals awaiting your judgment." },
  { href: "/console/lessons", label: "Lessons", icon: GraduationCap, desc: "Pending learning and past learning." },
  { href: "/console/activity", label: "Activity", icon: ActivityIcon, desc: "Alerts Center, Notifications, Strategy Runs, Order Fills, and the Audit Log decision journal." },
  { href: "/console/scan", label: "Scan", icon: Radar, desc: "The market scan: screened and scored symbols from the latest run." },
  { href: "/console/watchlist", label: "Watchlist", icon: Eye, desc: "Symbols the agent monitors, with price alerts that notify you when a level is crossed." },
  { href: "/console/macro", label: "Macro", icon: Globe, desc: "Macro and market-regime board: rates, credit, volatility, breadth." },
  { href: "/console/orders", label: "Orders", icon: ListChecks, desc: "Order history and open orders at the broker." },
  { href: "/console/assistant", label: "Coach", icon: MessageSquare, desc: "Coach Socratic Trade about its reasoning, accounts, and market focus." },
  { href: "/console/strategy", label: "Strategy", icon: Brain, desc: "The agent's brain: instructions, models, scoring weights, presets." },
  { href: "/console/guardrails", label: "Guardrails", icon: Shield, desc: "Autonomy, spending caps, protective stops, schedule, and the trading rulebook." },
  { href: "/console/connections", label: "Connections", icon: Plug, desc: "Broker accounts and provider API keys." },
  { href: "/console/results", label: "Results", icon: BarChart3, desc: "Realized performance, equity curve, thesis scorecards, and learning evidence." },
  { href: "/console/usage", label: "Usage", icon: ReceiptText, desc: "Your LLM usage and estimated model cost by key, model, and workflow." },
  { href: "/console/settings", label: "Settings", icon: SettingsIcon, desc: "Notifications, sharing, confirmations, and console preferences." }
];

/** Canonical destination name for page titles. Every page h1 renders through this
 *  (h1 === rail label, the 2026-07-16 naming canon) so nav and titles can't drift
 *  apart again — Wave B / PR-B1 plain renames (Home/Scan/Activity/Results/Macro)
 *  flow through here so the rail and h1 stay locked. */
export function destinationLabel(href: string): string {
  return DESTINATIONS.find((d) => d.href === href)?.label ?? href;
}

function isActive(pathname: string, href: string): boolean {
  return href === "/console" ? pathname === "/console" : pathname.startsWith(href);
}

/** Single source of truth for destination grouping — desktop rail and the
 *  mobile Tabs menu both render from this so the two surfaces cannot drift
 *  apart. Order: Core (the three permanent-feeling primaries) first, then
 *  Monitor / Review, then Configure last (Settings is deliberately the
 *  lowest item in both surfaces). Anything not explicitly placed here falls
 *  into the last group so a newly added destination stays reachable even if
 *  this list isn't updated in lockstep. */
const GROUPED_DESTINATION_HREFS: { label: string; hrefs: string[] }[] = [
  { label: "Core", hrefs: ["/console", "/console/approvals", "/console/lessons", "/console/activity"] },
  { label: "Monitor", hrefs: ["/console/scan", "/console/watchlist", "/console/macro", "/console/orders"] },
  { label: "Review", hrefs: ["/console/assistant", "/console/results", "/console/usage"] },
  { label: "Configure", hrefs: ["/console/strategy", "/console/guardrails", "/console/connections", "/console/settings"] }
];

export function groupedDestinations(destinations: Destination[]): { label: string; items: Destination[] }[] {
  const placed = new Set<string>();
  const groups = GROUPED_DESTINATION_HREFS.map((group) => {
    const items = group.hrefs
      .map((href) => destinations.find((d) => d.href === href))
      .filter((d): d is Destination => d !== undefined);
    items.forEach((d) => placed.add(d.href));
    return { label: group.label, items };
  });
  const unmapped = destinations.filter((d) => !placed.has(d.href));
  if (unmapped.length > 0) groups[groups.length - 1].items.push(...unmapped);
  return groups;
}

function triggerFeedback(onSuccess?: () => void) {
  if (typeof window === "undefined") return;
  const Sentry = (window as unknown as { Sentry?: { getFeedback?: () => { createForm?: () => Promise<{ appendToDom: () => void; open: () => void }> } } }).Sentry;
  const feedback = Sentry?.getFeedback?.();
  if (feedback?.createForm) {
    void feedback.createForm().then((form) => {
      form.appendToDom();
      form.open();
      onSuccess?.();
    }).catch(() => {});
  }
}

export function DesktopRail({ pendingCount, unreadCount = 0 }: { pendingCount: number; unreadCount?: number }) {
  const pathname = usePathname() ?? "";
  const guardNav = useNavDirtyGuard();
  return (
    <nav className="hidden w-52 shrink-0 flex-col gap-1 px-3 py-4 lg:flex border-r border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] shadow-sm mr-4" aria-label="Console navigation">
      {groupedDestinations(DESTINATIONS).map((group, i) => (
        <div key={group.label} className={cx("flex flex-col gap-1", i > 0 && "mt-4")}>
          <div className="con-card-title px-3 pb-1">{group.label}</div>
          {group.items.map((d) => {
            const Icon = d.icon;
            const active = isActive(pathname, d.href);
            return (
              <Link
                key={d.href}
                href={d.href}
                className="con-nav-item"
                data-active={active}
                aria-current={active ? "page" : undefined}
                title={d.desc}
                onClick={(e) => guardNav(e, d.href)}
              >
                <Icon size={16} />
                <span className="flex-1">{d.label}</span>
                {d.href === "/console/approvals" && pendingCount > 0 && (
                  <span className="con-badge" title={badgeTitle(pendingCount)}>
                    {pendingCount}
                  </span>
                )}
                {d.href === "/console/activity" && unreadCount > 0 && (
                  <span className="con-badge" title={unreadTitle(unreadCount)}>
                    {unreadCount}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      ))}
      <div className="mt-auto pt-3 border-t border-[color:var(--con-line)]">
        <button
          type="button"
          className="con-nav-item w-full text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)] hover:text-[color:var(--con-fg)]"
          onClick={() => triggerFeedback()}
          title="Report a Problem"
        >
          <span className="flex-1 text-left">Report a Problem</span>
        </button>
      </div>
    </nav>
  );
}

/** Sheet stops just above the fixed tab bar (rather than covering it) so the
 * bar — and any pin toggle's live effect on it — stays visible the whole
 * time the sheet is open. `barHeight` is the tab bar's real measured height
 * (see `MobileTabBar`'s ResizeObserver), so this tracks safe-area insets and
 * font-scaling exactly instead of guessing a fixed offset. `GAP` is the
 * small breathing-room reveal between the sheet and the bar; `TOP_GAP` keeps
 * the sheet off the very top of the viewport (status bar / notch). A floor
 * is used until the first measurement lands (effectively instant — the bar
 * is always mounted before a user can tap "Tabs" to open this). */
const TABS_SHEET_GAP = 0;
const TABS_SHEET_TOP_GAP = 16;
const TABS_SHEET_BAR_FLOOR = 56;

/** The bottom-sheet destination picker — replaces the old "More" list.
 *  Unlike the shared `Sheet` (a centered dialog on desktop, plain bottom
 *  sheet on mobile), this always slides up from the bottom with an explicit
 *  transform/opacity transition, because it only ever renders on mobile
 *  (`lg:hidden`) alongside the bottom tab bar. `prefers-reduced-motion`
 *  collapses the transition to 0ms rather than skipping it, so the sheet
 *  still ends up in the right place either way.
 *
 *  It floats above the tab bar (not over it) and stretches to fill nearly
 *  all remaining vertical space, so a typical phone shows every destination
 *  without scrolling while the bar's pin state stays live underneath —
 *  see `TABS_SHEET_GAP` etc. above for why. */
function TabsSheet({
  open,
  onClose,
  pathname,
  guardNav,
  tabs,
  pendingCount,
  unreadCount = 0,
  barHeight,
  sheetId
}: {
  open: boolean;
  onClose: () => void;
  pathname: string;
  guardNav: (event: { preventDefault: () => void } | undefined, href: string) => boolean;
  tabs: MobileTabsState;
  pendingCount: number;
  unreadCount?: number;
  barHeight: number;
  sheetId: string;
}) {
  const router = useRouter();
  const sheetRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const overlayId = useId();
  const [entered, setEntered] = useState(false);
  const barOffset = Math.max(barHeight, TABS_SHEET_BAR_FLOOR);

  useOverlay(overlayId, open, onClose);
  useFocusTrap(sheetRef, open, { onEscape: onClose });

  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  if (!open) return null;

  return (
    <>
      {/* Scrim stops above the tab bar (not inset-0) so the bar reads as
       * live/interactive, not dimmed, while the sheet is open. */}
      <div className="con-scrim lg:hidden" style={{ bottom: barOffset }} onClick={onClose} aria-hidden />
      <div
        ref={sheetRef}
        id={sheetId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        className={cx(
          "fixed inset-x-0 z-[101] flex flex-col overflow-hidden rounded-t-[24px] border border-[color:var(--con-line-strong)] bg-[color:var(--con-surface)] shadow-[var(--con-shadow-lg)] transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none motion-reduce:duration-0 lg:hidden",
          entered ? "translate-y-0 opacity-100" : "translate-y-full opacity-0"
        )}
        style={{
          bottom: barOffset + TABS_SHEET_GAP,
          maxHeight: `min(calc(var(--con-vv-height, 100dvh) - ${barOffset + TABS_SHEET_GAP + TABS_SHEET_TOP_GAP}px), calc(100dvh - ${barOffset + TABS_SHEET_GAP + TABS_SHEET_TOP_GAP}px))`
        }}
      >
        <header className="flex items-center justify-between gap-4 border-b border-[color:var(--con-line)] px-5 py-3.5 relative">
          <div className="absolute top-2 left-1/2 -translate-x-1/2 w-9 h-1.5 rounded-full bg-[color:var(--con-line-strong)] opacity-60"></div>
          <h2 id={headingId} className="text-[length:var(--con-fs-md)] font-semibold mt-2">
            More
          </h2>
          <button
            type="button"
            aria-label="Close"
            className="con-icon-btn"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="overflow-y-auto overscroll-contain px-3 py-3">
          {groupedDestinations(DESTINATIONS).map((group) => (
            <div key={group.label} className="mb-4 last:mb-1">
              <div className="px-2 pb-1.5 text-[length:var(--con-fs-xs)] font-semibold uppercase tracking-[0.07em] text-[color:var(--con-faint)]">
                {group.label}
              </div>
              <div className="flex flex-col gap-1 pl-2">
                {group.items.map((d) => {
                  const Icon = d.icon;
                  const active = isActive(pathname, d.href);
                  const pinned = tabs.isPinned(d.href);
                  const canToggle = tabs.canToggle(d.href);
                  const pinTitle = pinned
                    ? canToggle
                      ? "Remove from tabs"
                      : `Keep at least ${MOBILE_TABS_MIN} tabs`
                    : canToggle
                      ? "Add to tabs"
                      : `Up to ${MOBILE_TABS_MAX} tabs — remove one first`;
                  return (
                    <div key={d.href} className="flex items-center gap-1">
                      <Link
                        href={d.href}
                        className="con-nav-item flex-1"
                        data-active={active}
                        aria-current={active ? "page" : undefined}
                        title={d.desc}
                        onClick={(e) => {
                          e.preventDefault();
                          if (guardNav(e, d.href)) {
                            router.push(d.href);
                            onClose();
                          }
                        }}
                      >
                        <Icon size={16} />
                        <span className="flex-1">{d.label}</span>
                        {d.href === "/console/approvals" && pendingCount > 0 && (
                          <span className="con-badge" title={badgeTitle(pendingCount)}>
                            {pendingCount}
                          </span>
                        )}
                        {d.href === "/console/activity" && unreadCount > 0 && (
                          <span className="con-badge" title={unreadTitle(unreadCount)}>
                            {unreadCount}
                          </span>
                        )}
                      </Link>
                      <button
                        type="button"
                        aria-pressed={pinned}
                        aria-label={pinned ? `Remove ${d.label} from tabs` : `Add ${d.label} to tabs`}
                        title={pinTitle}
                        disabled={!canToggle}
                        className="con-icon-btn h-9 w-9 shrink-0 text-[color:var(--con-faint)] enabled:hover:text-[color:var(--con-fg)] disabled:opacity-40"
                        onClick={(e) => {
                          e.stopPropagation();
                          tabs.togglePin(d.href);
                        }}
                      >
                        <Pin size={16} fill={pinned ? "currentColor" : "none"} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="mt-2 pt-3 border-t border-[color:var(--con-line)]">
            <button
              type="button"
              className="con-nav-item w-full text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)] hover:text-[color:var(--con-fg)]"
              onClick={() => triggerFeedback(onClose)}
              title="Report a Problem"
            >
              <span className="flex-1 text-left">Report a Problem</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/* Tab bar stays at bottom:0. The 2026-08-05 measured-gap shift (negative
 * `bottom`) is still forbidden: it slid labels under Safari's URL chrome.
 * Browser padding is ~22% of env(safe-area-inset-bottom) so ~78% of the
 * grey-blue band is gone; a solid --con-surface ::after paints the rest
 * and the area around the URL pill (see .con-tabbar in console.css).
 * Standalone/PWA still uses the full env() pad for the home indicator. */

export function MobileTabBar({ pendingCount, unreadCount = 0 }: { pendingCount: number; unreadCount?: number }) {
  const pathname = usePathname() ?? "";
  const moreSheetId = useId();
  const [tabsOpen, setTabsOpen] = useState(false);
  const guardNav = useNavDirtyGuard();
  const tabsState = useMobileTabs(DESTINATIONS.map((d) => d.href));
  const navRef = useRef<HTMLElement>(null);
  /** Distance from layout-viewport bottom to the bar's top edge — TabsSheet
   *  stops here. */
  const [barOffset, setBarOffset] = useState(0);

  // Real measured offset (bar top → layout bottom) so the TabsSheet can stop
  // exactly above the bar on any device/font-scale/safe-area-inset, rather
  // than guessing a fixed px offset from height alone.
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top;
      setBarOffset(Math.max(0, Math.round(window.innerHeight - top)));
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      window.addEventListener("resize", measure);
      window.visualViewport?.addEventListener("resize", measure);
      return () => {
        ro.disconnect();
        window.removeEventListener("resize", measure);
        window.visualViewport?.removeEventListener("resize", measure);
      };
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // SSR-safe: before mount, tabHrefs is already DEFAULT_MOBILE_TAB_HREFS (the
  // hook's initial state), so this matches the server render exactly.
  const activeHrefs = tabsState.mounted ? tabsState.tabHrefs : [...DEFAULT_MOBILE_TAB_HREFS];
  const tabs = DESTINATIONS.filter((d) => activeHrefs.includes(d.href));
  const tabsButtonActive = !DESTINATIONS.some((d) => activeHrefs.includes(d.href) && isActive(pathname, d.href));

  return (
    <>
      <nav
        ref={navRef}
        className="con-tabbar fixed inset-x-0 bottom-0 z-50 border-t border-[color:var(--con-line-strong)] lg:hidden"
        aria-label="Console navigation"
      >
        <div className="flex">
          {tabs.map((d) => {
            const Icon = d.icon;
            const active = isActive(pathname, d.href);
            return (
              <Link
                key={d.href}
                href={d.href}
                className="con-tab-item"
                data-active={active}
                aria-current={active ? "page" : undefined}
                title={d.desc}
                style={active ? { fontWeight: 800 } : undefined}
                onClick={(e) => {
                  if (guardNav(e, d.href)) {
                    setTabsOpen(false);
                  }
                }}
              >
                <span
                  className="relative flex h-7 w-10 items-center justify-center rounded-full transition-colors"
                  style={active ? { background: "var(--con-accent-soft)" } : undefined}
                >
                  <Icon size={19} />
                  {d.href === "/console/approvals" && pendingCount > 0 && (
                    <span className="con-badge absolute -right-2.5 -top-1" title={badgeTitle(pendingCount)}>
                      {pendingCount}
                    </span>
                  )}
                  {d.href === "/console/activity" && unreadCount > 0 && (
                    <span className="con-badge absolute -right-2.5 -top-1" title={unreadTitle(unreadCount)}>
                      {unreadCount}
                    </span>
                  )}
                </span>
                {d.label}
              </Link>
            );
          })}
          <button
            type="button"
            className="con-tab-item"
            data-active={tabsButtonActive || tabsOpen}
            title={tabsOpen ? "Close more menu" : "Choose which screens show up here, or jump to any screen"}
            style={tabsButtonActive || tabsOpen ? { fontWeight: 800 } : undefined}
            aria-expanded={tabsOpen}
            aria-controls={moreSheetId}
            onClick={() => setTabsOpen(!tabsOpen)}
          >
            <span
              className="relative flex h-7 w-10 items-center justify-center rounded-full transition-colors"
              style={tabsButtonActive || tabsOpen ? { background: "var(--con-accent-soft)" } : undefined}
            >
              <LayoutGrid size={19} />
            </span>
            {/* Was "Tabs" — unclear for the standard mobile overflow-menu pattern this
                is (the grid of every destination, with pin/unpin to customize the bar
                above). "More" is the conventional label for this affordance. */}
            More
          </button>
        </div>
      </nav>

      <TabsSheet
        open={tabsOpen}
        onClose={() => setTabsOpen(false)}
        pathname={pathname}
        guardNav={guardNav}
        tabs={tabsState}
        pendingCount={pendingCount}
        unreadCount={unreadCount}
        barHeight={barOffset}
        sheetId={moreSheetId}
      />
    </>
  );
}
