"use client";

// Admin portal shell — same design system as the console (con-* tokens via
// console.css + .console-root scope), same nav idiom (DesktopRail geometry),
// but a distinct operator frame: no trading chrome, no snapshot fetch, and an
// always-visible console return link and profile control in the top bar.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Activity,
  BarChart3,
  Brain,
  Database,
  DatabaseBackup,
  Layers,
  Server,
  SlidersHorizontal,
  FileText,
  Monitor,
  Moon,
  Sun,
  UserRound,
  Menu,
  X
} from "lucide-react";
import "../console/console.css";
import { useConsoleTheme, type ConsoleTheme } from "../console/lib/useConsoleTheme";
import { useConsoleFont } from "../console/lib/useConsoleFont";
import { useConsoleTextBoxFont } from "../console/lib/useConsoleTextBoxFont";
import { HeaderLogo } from "../console/ui/header-logo";
import { SymbolDrawerProvider } from "../console/ui/symbol-drawer";

interface NavItem {
  href: string;
  label: string;
  desc: string;
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  exact?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    href: "/admin",
    label: "Overview",
    desc: "Server-wide status: connections, spend, corpus, host, and transcripts at a glance.",
    icon: LayoutDashboard,
    exact: true
  },
  {
    href: "/admin/connections",
    label: "API Connections",
    desc: "Per-provider call health: last success/failure, call volume, and error patterns.",
    icon: Activity
  },
  {
    href: "/admin/llm-usage",
    label: "LLM Usage & Cost",
    desc: "Per-key, per-model, per-context LLM spend across all accounts.",
    icon: Brain
  },
  {
    href: "/admin/rag-coverage",
    label: "RAG Coverage",
    desc: "Vector index contents per ticker: chunk counts, freshness, and coverage gaps.",
    icon: Database
  },
  {
    href: "/admin/enrichment-coverage",
    label: "Enrichment Coverage",
    desc: "Last market-data cascade: field fill rates, winning sources, and missing data points.",
    icon: Layers
  },
  {
    href: "/admin/data-catalog",
    label: "Data catalog",
    desc: "All fields + possible sources, RAG/numeric completeness %, provenance policy.",
    icon: Database
  },
  {
    href: "/admin/operations",
    label: "Operations",
    desc: "Server-level pause and kill switches: workers, streams, budgets — flipped at runtime, no redeploy.",
    icon: SlidersHorizontal
  },
  {
    href: "/admin/backtest-ic",
    label: "Factor Backtest",
    desc: "Read-only information-coefficient backtest of scan factor weights against forward returns.",
    icon: BarChart3
  },
  {
    href: "/admin/server",
    label: "Server Stats",
    desc: "Host node metrics and Coolify application resource statuses.",
    icon: Server
  },
  {
    href: "/admin/backups",
    label: "Backup Status",
    desc: "Litestream SQLite replication per compaction tier: continuous sync, compaction, daily snapshot.",
    icon: DatabaseBackup
  },
  {
    href: "/admin/transcript",
    label: "Chat Transcript",
    desc: "Every chat turn, with the model that produced each assistant reply.",
    icon: FileText
  }
];

export function AdminShell({ children, adminEmail }: { children: React.ReactNode; adminEmail: string | null }) {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { theme, dataTheme, set: setTheme } = useConsoleTheme();
  const { dataConsoleFont } = useConsoleFont();
  const { dataTextBoxFont } = useConsoleTextBoxFont();

  const isActive = (item: NavItem) => {
    if (item.exact) return pathname === item.href;
    return pathname.startsWith(item.href) && pathname !== "/admin";
  };
  const activeItem = NAV_ITEMS.find(isActive);

  const navLinks = (onNavigate?: () => void) =>
    NAV_ITEMS.map((item) => {
      const Icon = item.icon;
      const active = isActive(item);
      return (
        <Link
          key={item.href}
          href={item.href}
          className="con-nav-item"
          data-active={active}
          aria-current={active ? "page" : undefined}
          title={item.desc}
          onClick={onNavigate}
        >
          <Icon size={16} />
          <span>{item.label}</span>
        </Link>
      );
    });

  return (
    <div
      className="console-root flex min-h-dvh flex-col"
      data-theme={dataTheme}
      data-console-font={dataConsoleFont}
      data-textbox-font={dataTextBoxFont}
      suppressHydrationWarning /* same SSR-vs-localStorage pattern as the console shell */
    >
      {/* ── Top bar: the normal console geometry, with admin-only actions ── */}
      <header className="sticky top-0 z-40 border-b border-[color:var(--con-line)] bg-[color:var(--con-surface)]">
        <div className="relative mx-auto flex h-12 w-full max-w-[1400px] items-center gap-2 px-4">
          <button
            type="button"
            onClick={() => setMobileMenuOpen((open) => !open)}
            className="-ml-2 flex h-11 w-11 items-center justify-center rounded-[var(--con-radius-sm)] text-[color:var(--con-muted)] transition-colors hover:text-[color:var(--con-fg)] lg:hidden"
            aria-label="Toggle admin navigation"
            aria-expanded={mobileMenuOpen}
          >
            {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
          <div className="flex min-w-0 items-center gap-2">
            <span>
              <HeaderLogo height={18} />
            </span>
          </div>
          <div className="flex-1" />
          <Link href="/console" className="con-btn con-btn-outline hidden shrink-0 h-8 mr-2 sm:inline-flex">
            Back to Console
          </Link>
          <AdminProfileMenu theme={theme} setTheme={setTheme} adminEmail={adminEmail} />
        </div>
      </header>

      {/* ── Mobile navigation drawer (top bar stays visible above it) ────── */}
      {mobileMenuOpen && (
        <div
          className="con-scrim lg:hidden"
          style={{ top: 48, zIndex: 30 }}
          onClick={() => setMobileMenuOpen(false)}
        >
          <div
            className="absolute inset-y-0 left-0 flex w-64 flex-col gap-1 border-r border-[color:var(--con-line)] bg-[color:var(--con-surface)] p-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="con-card-title px-3 pb-1">Admin</div>
            {navLinks(() => setMobileMenuOpen(false))}
          </div>
        </div>
      )}

      {/* ── Rail + content ───────────────────────────────────────────────── */}
      <div className="mx-auto flex w-full max-w-[1400px] flex-1">
        <aside
          className="hidden w-52 shrink-0 flex-col gap-1 border-r border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-4 shadow-sm lg:flex mr-4"
          aria-label="Admin navigation"
        >
          <div className="con-card-title px-3 pb-1">Admin</div>
          {navLinks()}
        </aside>
        <main className="min-w-0 flex-1 px-4 pt-4 pb-8 lg:px-6">
          <SymbolDrawerProvider>{children}</SymbolDrawerProvider>
        </main>
      </div>
    </div>
  );
}

function AdminProfileMenu({ theme, setTheme, adminEmail }: { theme: ConsoleTheme; setTheme: (theme: ConsoleTheme) => void; adminEmail: string | null }) {
  const [open, setOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState<string>();
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    fetch("/api/auth/session")
      .then((res) => res.json())
      .then((s) => setImageUrl(s?.user?.image))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        title="Open profile and account settings"
        aria-label="Profile and account settings"
        aria-expanded={open}
        aria-haspopup="menu"
        style={{ width: 32, height: 32, minWidth: 32, minHeight: 32, maxWidth: 32, maxHeight: 32 }}
        className="flex shrink-0 items-center justify-center overflow-hidden rounded-control border border-[color:var(--con-line-strong)] text-[color:var(--con-muted)] transition-colors hover:border-[color:var(--con-accent)] hover:text-[color:var(--con-accent)]"
      >
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- external avatar host
          <img
            src={imageUrl}
            alt=""
            referrerPolicy="no-referrer"
            style={{ width: "100%", height: "100%", maxWidth: "100%", maxHeight: "100%", objectFit: "cover" }}
            className="shrink-0 block rounded-[inherit]"
          />
        ) : (
          <UserRound size={15} />
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} aria-hidden />
          <div className="con-menu-drop absolute right-0 top-[calc(100%+2px)] z-50 w-[min(92vw,340px)] rounded-card border border-[color:var(--con-line-strong)] bg-[color:var(--con-surface)] p-4 shadow-xl">
            <div className="flex flex-col gap-3 text-[length:var(--con-fs-sm)]">
              <div>
                <div className="font-semibold">{adminEmail || "Admin Profile"}</div>
                <div className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                  Console preferences and account settings
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-control border border-[color:var(--con-line)] px-3 py-2">
                <span className="text-[color:var(--con-muted)]">Theme</span>
                <div className="flex items-center gap-1 rounded-control border border-[color:var(--con-line-strong)] bg-[color:var(--con-bg)] p-0.5">
                  {(["light", "dark", "system"] as const).map((option) => {
                    const active = theme === option;
                    const Icon = option === "dark" ? Moon : option === "light" ? Sun : Monitor;
                    return (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setTheme(option)}
                        aria-label={`Set theme to ${option}`}
                        className={`flex items-center gap-1.5 rounded-control border px-2.5 py-1 text-[length:var(--con-fs-xs)] transition-colors ${
                          active
                            ? "border-[color:var(--con-line)] bg-[color:var(--con-surface)] font-medium text-[color:var(--con-fg)] shadow-sm"
                            : "border-transparent text-[color:var(--con-muted)] hover:text-[color:var(--con-fg)]"
                        }`}
                      >
                        <Icon size={13} />
                        {option[0].toUpperCase() + option.slice(1)}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Link href="/console" className="con-btn con-btn-outline" onClick={close}>
                  Back to Console
                </Link>
                <a href="/logout" className="con-btn con-btn-outline" onClick={close}>
                  Sign Out
                </a>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
