"use client";

/** The console shell: providers + global chrome + navigation. Every screen
 *  renders inside this frame, so account scope, run state, STOP, Run once,
 *  and freshness are visible everywhere. Paper/no-account states get explicit
 *  banners; ordinary brokerage accounts do not get a red global frame. Theme: system
 *  preference by default, explicit light/dark via the chrome toggle
 *  (persisted, applied as data-theme on this root). */

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useMutationBusy } from "../lib/useMutationBusy";
import type { DashboardSnapshot } from "../../dashboard-types";
import { ConsoleDataProvider, useConsoleData } from "../lib/useConsoleData";
import { SENTENCE_GAP } from "../lib/format";
import { useConsoleFont } from "../lib/useConsoleFont";
import { useConsoleTextBoxFont } from "../lib/useConsoleTextBoxFont";
import { useConsoleTheme, type ConsoleTheme } from "../lib/useConsoleTheme";
import { DirtyGuardProvider } from "../lib/useDirtyGuard";
import { SymbolDrawerProvider } from "../ui/symbol-drawer";
import { ToastProvider } from "../ui/toast";
import {
  FreshnessStrip,
  MobileFreshnessBar,
  RealityBanner,
  RunOnceButton,
  RunStateButton,
  ScopeSelector,
  StateChip,
  UserMenu
} from "./chrome";
import { CommandPalette, CommandPaletteTrigger } from "./command-palette";
import { ConsentGate } from "./consent-gate";
import { ConsoleIntro } from "./intro-canvas";
import { HeaderLogo } from "../ui/header-logo";
import { WORDMARK_AR } from "../ui/candle-ticker";
import { getIntroPhase, subscribeIntroPhase, type IntroPhase } from "../ui/intro-bus";
import { DesktopRail, MobileTabBar, destinationLabel } from "./nav";
import { NotificationInbox } from "./notification-inbox";
import { Btn } from "../ui/primitives";
import { unreadNotificationCount } from "@/lib/notification-history";
import { activeConnectedAccount } from "../lib/derive";

export function ConsoleShell({ children }: { children: ReactNode }) {
  return (
    <ConsoleDataProvider>
      {/* DirtyGuardProvider wraps the nav AND the pages so unsaved drafts can
          intercept both tab-close (beforeunload) and in-console navigation. */}
      <DirtyGuardProvider>
        <ShellFrame>{children}</ShellFrame>
      </DirtyGuardProvider>
    </ConsoleDataProvider>
  );
}

/** Console routes that consume ZERO fields of the dashboard snapshot — they fetch their own
 *  data — so making them wait behind it is pure dead time on a screen the user is staring at.
 *
 *  Deliberately an allowlist, not a heuristic. Every other route either reads the snapshot
 *  directly or renders chrome (account scope, run state, STOP) that is derived from it, and
 *  showing that chrome before the snapshot exists would mean showing a run state we do not
 *  actually know yet. `/console/usage` is a server component wrapping LlmUsageClient, which
 *  fetches `/api/llm-usage` itself.
 *
 *  Before adding a route here, grep it (and everything it renders) for `useConsoleData` and
 *  confirm it does not read `snapshot`. A route that DOES read the snapshot but can degrade
 *  gracefully belongs in SELF_SKELETON_ROUTES below instead. */
const SNAPSHOT_INDEPENDENT_ROUTES = new Set(["/console/usage"]);

/** Console routes that DO read the snapshot but handle `snapshot === null` themselves — their
 *  page renders a route-local skeleton (and its own error/retry state) instead of returning
 *  null — so they get the same early render as SNAPSHOT_INDEPENDENT_ROUTES rather than the
 *  full-screen loader. `/console/connections`: BrokerAccountsCard needs connectedAccounts,
 *  policy, and per-account pending counts, so it skeletons until the snapshot lands — but
 *  ApiKeysCard fetches /api/keys itself and is usable the whole time, which matters on a slow
 *  broker chain (~24s worst case).
 *
 *  Before adding a route here: its page must render something meaningful for BOTH
 *  `snapshot === null` states — still loading AND load failed — because this branch also
 *  bypasses the shell's error card below. */
const SELF_SKELETON_ROUTES = new Set(["/console/connections"]);

function ShellFrame({ children }: { children: ReactNode }) {
  const { snapshot, fetchedAt, loading, slowFirstLoad, error, sessionExpired, stream, refresh, online } =
    useConsoleData();
  const { theme, dataTheme, set: setTheme } = useConsoleTheme();
  const { dataTextBoxFont } = useConsoleTextBoxFont();
  const { dataConsoleFont } = useConsoleFont();
  const pathname = usePathname();

  // Per-page tab title: route via destinationLabel so the rail label and tab title
  // share one source (h1 === rail label, the 2026-07-16 naming canon). On desktop
  // multi-tab this is the difference between "Socratic Trade" on every tab and
  // "Orders · Socratic Trade" / "Guardrails · Socratic Trade" / etc.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const label = pathname ? destinationLabel(pathname) : "";
    const title = label && label !== pathname ? `${label} · Socratic Trade` : "Socratic Trade";
    if (document.title !== title) document.title = title;
  }, [pathname]);

  // A 401 anywhere in the console (the polled snapshot or a mutation) means the session is
  // gone, not merely slow — api.ts's redirectToLogin is already sending the browser to /login.
  // This takes over the ENTIRE shell, before the loading/failed/ready branches below: the last
  // good snapshot must not keep rendering as though it were still live for whatever brief
  // window the navigation takes (previously this only ever showed a small "delayed" freshness
  // chip while the rest of the trading desk kept rendering normally — see FreshnessStrip/
  // MobileFreshnessBar's `error` handling further down, which this branch deliberately bypasses).
  if (sessionExpired) {
    return (
      <div
        className="console-root flex min-h-dvh items-center justify-center px-6"
        data-theme={dataTheme}
        data-textbox-font={dataTextBoxFont}
        data-console-font={dataConsoleFont}
        suppressHydrationWarning
      >
        <div className="con-card max-w-md p-6 text-center" role="alert">
          <div className="con-card-title">Socratic Trade</div>
          <p className="mt-2 font-semibold">Your session has expired</p>
          <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
            Redirecting you to sign in.{SENTENCE_GAP}This screen no longer reflects live data.
          </p>
          {/* The automatic window.location.href navigation in api.ts's redirectToLogin fires a
              native beforeunload prompt when a dirty draft is registered (useDirtyGuard.tsx) —
              if the user cancels that prompt, redirectingToLogin is already latched true and
              never retries, leaving this screen up with no way out but a manual reload or
              address-bar edit. A real link is always clickable regardless of that outcome. */}
          <div className="mt-4 flex justify-center">
            <a href={`/login?callbackUrl=${encodeURIComponent(pathname || "/console")}`} className="con-btn con-btn-primary con-btn-sm">
              Sign in
            </a>
          </div>
        </div>
      </div>
    );
  }

  // A route that needs nothing from the snapshot — or that skeletons its snapshot-dependent
  // parts itself — renders immediately instead of waiting behind the full-screen loader (and
  // instead of the shell error card below: such a route's page owns the error surface too).
  // It shares the ONE tree at the bottom with the loaded state: the snapshot-derived chrome
  // renders into stable null slots, so when the snapshot lands React mounts the chrome
  // AROUND the live page instead of remounting it — in-progress page state (a half-typed
  // API key, a visible toast) survives the flip, and ConsoleIntro plays over the skeleton
  // from the start exactly as it does over the loader. Do NOT split the bare and loaded
  // states back into separate returns: keyless index reconciliation would turn the
  // snapshot's arrival into a destroy-and-recreate of the whole page subtree.
  const bare =
    !snapshot && !!pathname && (SNAPSHOT_INDEPENDENT_ROUTES.has(pathname) || SELF_SKELETON_ROUTES.has(pathname));

  if (!bare && loading) {
    return (
      <div
        className="console-root flex min-h-dvh items-center justify-center"
        data-theme={dataTheme}
        data-textbox-font={dataTextBoxFont}
        data-console-font={dataConsoleFont}
        suppressHydrationWarning
      >
        {/* The candlestick intro is the entire load screen — no text label, so
            the animation plays on a clean backdrop (owner request). LoadingBrand
            shows a small STATIC candlestick mark only when the intro is skipped
            (returning tab / reduced motion), so those loads aren't a blank flash. */}
        <ConsoleIntro />
        <LoadingBrand />
        {/* The visual load screen is deliberately wordless, which left screen-reader users
            with nothing at all — no heading, no landmark, no announcement, just an empty
            document until the snapshot arrived (which can legitimately take ~24s on a slow
            broker chain). This is the accessible equivalent of the animation: a polite live
            region, visually hidden so the clean backdrop is unchanged. */}
        <p role="status" aria-live="polite" className="sr-only">
          Loading your Socratic Trade console…
        </p>
        {/* A long first load is normal, not a failure: the snapshot's broker chain is sequential
            and can legitimately take ~24s. This used to render as a full-screen "Couldn't load the
            autonomy desk" card at 15s while the request was still in flight and about to succeed.
            Now the load screen simply stays up and says so, so the wordless backdrop is unchanged
            for every load that lands normally. */}
        {slowFirstLoad ? (
          <p
            role="status"
            aria-live="polite"
            className="pointer-events-none fixed inset-x-0 bottom-10 px-6 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]"
          >
            Still loading — gathering dashboard state.  Hang tight.
          </p>
        ) : null}
      </div>
    );
  }

  if (!bare && !snapshot) {
    return (
      <div
        className="console-root flex min-h-dvh items-center justify-center px-6"
        data-theme={dataTheme}
        data-textbox-font={dataTextBoxFont}
        data-console-font={dataConsoleFont}
        suppressHydrationWarning
      >
        {/* role="alert" so the failure is announced, not just drawn. */}
        <div className="con-card max-w-md p-6 text-center" role="alert">
          <div className="con-card-title">Socratic Trade</div>
          <p className="mt-2 font-semibold">Couldn&apos;t load the autonomy desk</p>
          <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
            {error ?? "The dashboard API did not respond."} The console retries automatically.
          </p>
          {/* The automatic retry is real (the poll interval re-fires), but "retries
              automatically" with no control is a dead end for anyone who does not want to
              wait out the interval — and there was no way to tell a stuck console from a
              slow one. refresh() is the same call the poll makes. */}
          <div className="mt-4 flex justify-center">
            <Btn variant="outline" size="sm" onClick={() => void refresh()}>
              <RefreshCw className="h-3.5 w-3.5" />
              Retry now
            </Btn>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="console-root flex min-h-dvh flex-col"
      data-theme={dataTheme}
      data-textbox-font={dataTextBoxFont}
      data-console-font={dataConsoleFont}
      suppressHydrationWarning
    >
      <a href="#console-main" className="con-skip-link">
        Skip to content
      </a>
      <ConsoleIntro />
      {/* ToastProvider must live INSIDE .console-root: it renders the .con-toasts
          viewport as its last child, and the --con-* design tokens (colors, radii,
          shadows) are scoped to .console-root — a toast mounted outside it would
          render unstyled. The provider adds no DOM around the children, so the
          flex column layout is unchanged; the toasts div is position:fixed. It is
          also required in the bare window: ApiKeysCard on /console/connections calls
          useToast unconditionally, so children may never render without it. */}
      <SymbolDrawerProvider>
        <ToastProvider>
          {/* Sticky chrome: reality + STOP stay reachable on every screen, especially mobile.
              MobileFreshnessBar lives here (not bottom-anchored) because the fixed bottom tab
              bar (nav.tsx) overlays anything at document end on phones. Every
              snapshot-derived piece renders in a fixed slot (null while bare) so child
              indices — and therefore the page subtree's identity — are stable across the
              snapshot's arrival. */}
          {snapshot ? (
            <div className="con-topbar sticky top-0 z-50 bg-[color:var(--con-bg)]">
              <RealityBanner snapshot={snapshot} />
              <ChromeBar snapshot={snapshot} theme={theme} setTheme={setTheme} />
              <MobileFreshnessBar snapshot={snapshot} fetchedAt={fetchedAt} error={error} stream={stream} online={online} />
            </div>
          ) : null}
          <div className="mx-auto flex w-full max-w-[1400px] flex-1">
            {snapshot ? (
              <DesktopRail
                pendingCount={snapshot.pendingProposals.length}
                unreadCount={unreadNotificationCount(snapshot.notifications ?? [], activeConnectedAccount(snapshot)?.id)}
              />
            ) : null}
            <main id="console-main" tabIndex={-1} className="min-w-0 flex-1 px-4 pb-24 pt-4 lg:px-6 lg:pb-8">{children}</main>
          </div>
          {snapshot ? (
            <>
              <FreshnessStrip snapshot={snapshot} fetchedAt={fetchedAt} error={error} stream={stream} online={online} />
              <MobileTabBar
                pendingCount={snapshot.pendingProposals.length}
                unreadCount={unreadNotificationCount(snapshot.notifications ?? [], activeConnectedAccount(snapshot)?.id)}
              />
              {/* Blocking legal clickwrap + mandatory data-pool gate.  Accept
                  dismisses it until either version bumps. */}
              <ConsentGate />
              {/* ⌘K / Ctrl+K command palette — from-anywhere jump to any console screen. */}
              <CommandPalette />
            </>
          ) : null}
        </ToastProvider>
      </SymbolDrawerProvider>
    </div>
  );
}

/** Visible while any console write is in flight — toggles, dropdowns, buttons.
 *  The control often snaps back to the last server value until the POST returns;
 *  this chip is the honest "we heard you" signal for the whole desk. */
function MutationBusyChip() {
  const { busy } = useMutationBusy();
  if (!busy) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex shrink-0 items-center gap-1 rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-2 py-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-muted)]"
    >
      <Loader2 size={12} className="animate-spin" />
      Saving…
    </span>
  );
}

/** Desktop bar logo: invisible until the intro's candles assemble it (the
 *  splash lands on this exact element), then fades in and stays. Keeps its
 *  layout box while hidden so the splash can measure the landing target and
 *  the bar doesn't shift on reveal. Visible immediately when the intro is
 *  skipped (repeat visit, reduced motion). */
function BrandReveal() {
  const [phase, setPhase] = useState<IntroPhase>(getIntroPhase);
  useEffect(() => {
    setPhase(getIntroPhase()); // catch a phase change between render and subscribe
    return subscribeIntroPhase(setPhase);
  }, []);
  const shown = phase === "landed" || phase === "done";
  return (
    <div
      className="hidden shrink-0 pr-2 lg:block"
      style={{ opacity: shown ? 1 : 0, transition: "opacity .3s ease" }}
      aria-hidden={!shown}
    >
      <HeaderLogo />
    </div>
  );
}

/** Loading-screen fallback brand mark. Shown ONLY when the intro splash won't
 *  animate — a returning tab (`st.introShown`) or prefers-reduced-motion — so
 *  those loads show a small centered candlestick "SOCRATIC TRADE" instead of a
 *  blank screen during the snapshot fetch. On a first visit it renders nothing
 *  (the intro owns the load screen). HeaderLogo self-selects a static frame
 *  under reduced motion. Starts hidden and only reveals after the client-side
 *  check, so the SSR/first paint never flashes it before the intro. */
function LoadingBrand() {
  const [skipped, setSkipped] = useState(false);
  useEffect(() => {
    let shown = false;
    try { shown = sessionStorage.getItem("st.introShown") === "1"; } catch { /* ignore */ }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (shown || reduce) setSkipped(true);
  }, []);
  if (!skipped) return null;
  return (
    <div className="flex items-center justify-center opacity-70" aria-hidden>
      <HeaderLogo height={26} />
    </div>
  );
}

/** Mobile-only intro brand row (the bar logo is display:none below lg). While
 *  the splash plays, the chrome reserves a full-width row above the controls
 *  bar — roughly doubling its height — whose big "SOCRATIC TRADE" is the
 *  splash's landing target. The wordmark stays invisible until the candles
 *  assemble it, holds a beat, then the whole row slides up and away to give
 *  the screen space back. Renders nothing when the intro is skipped. */
const MOBILE_BRAND_HOLD_MS = 3000;
const MOBILE_BRAND_SLIDE_MS = 550;

function MobileBrandRow() {
  const [state, setState] = useState<"waiting" | "shown" | "leaving" | "gone">(() => {
    const p = getIntroPhase();
    return p === "landed" || p === "done" ? "gone" : "waiting";
  });
  // Two words across most of the width; height follows from the aspect ratio.
  const [logoH, setLogoH] = useState(24);

  useEffect(() => {
    // Keep this formula in sync with intro-canvas.tsx layout()'s <lg fallback
    // header box — the splash assembles the wordmark at that size before this
    // row can be measured, and a mismatch shows as a size pop at reveal.
    const measure = () => setLogoH(Math.max(16, Math.min(34, Math.round((window.innerWidth * 0.88) / WORDMARK_AR))));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    let hold = 0, slide = 0, landedHandled = false;
    const apply = (p: IntroPhase) => {
      if (p === "landed" && !landedHandled) {
        landedHandled = true;
        setState("shown");
        hold = window.setTimeout(() => {
          setState("leaving");
          slide = window.setTimeout(() => setState("gone"), MOBILE_BRAND_SLIDE_MS);
        }, MOBILE_BRAND_HOLD_MS);
      } else if (p === "done") {
        // intro skipped without ever landing (repeat visit / reduced motion):
        // drop the row instantly; a post-landing "done" changes nothing.
        setState((s) => (s === "waiting" ? "gone" : s));
      }
    };
    apply(getIntroPhase());
    const un = subscribeIntroPhase(apply);
    return () => { un(); window.clearTimeout(hold); window.clearTimeout(slide); };
  }, []);

  if (state === "gone") return null;
  const rowH = logoH + 20;
  const leaving = state === "leaving";
  return (
    <div
      className="overflow-hidden lg:hidden"
      style={{ height: leaving ? 0 : rowH, transition: `height ${MOBILE_BRAND_SLIDE_MS}ms ease` }}
      aria-hidden={state !== "shown"}
    >
      <div
        className="flex items-center justify-center"
        style={{
          height: rowH,
          opacity: state === "waiting" ? 0 : 1,
          transform: leaving ? "translateY(-100%)" : "translateY(0)",
          transition: `transform ${MOBILE_BRAND_SLIDE_MS}ms ease, opacity .3s ease`
        }}
      >
        <HeaderLogo height={logoH} />
      </div>
    </div>
  );
}

function ChromeBar({
  snapshot,
  theme,
  setTheme
}: {
  snapshot: DashboardSnapshot;
  theme: ConsoleTheme;
  setTheme: (theme: ConsoleTheme) => void;
}) {
  return (
    <header className="border-b border-[color:var(--con-line)] bg-[color:var(--con-surface)]">
      <MobileBrandRow />
      {/* Phone bar priorities (owner-tuned): the account scope gets the slack
          (flex-1), the run-state chip is unboxed+stacked, the theme toggle
          lives inside the profile menu, and nothing squeezes the STOP button.
          The desktop spacer is hidden below sm so the scope absorbs the room. */}
      {/* relative: the UserMenu dropdown anchors to this row (right edge of the
          bar), not to its small button — anchoring to the 44px button pushed the
          panel off the left edge of phone viewports. gap-1.5/px-3 on phones (vs
          gap-2/px-4 from sm up) claws back a few px so the account scope's mobile
          min-width (chrome.tsx ScopeSelector) has room without overflowing.
          overflow-x-auto guards against the 320px screen width collapse. */}
      <div className="relative mx-auto flex max-w-[1400px] items-center gap-1.5 px-3 py-2 sm:gap-2 sm:px-4 overflow-x-auto">
        <BrandReveal />
        <ScopeSelector snapshot={snapshot} />
        <StateChip snapshot={snapshot} />
        <MutationBusyChip />
        <div className="hidden flex-1 sm:block" />
        {/* Operator-only: small top-of-site entry to the admin portal (owner-directed —
            it must not be buried in Settings). Desktop chrome only; phones reach the
            same link from the profile menu (UserMenu), where there's room. */}
        {snapshot.currentUser?.isAdmin && (
          <Link
            href="/admin"
            className="hidden items-center gap-1.5 rounded-control border border-[color:var(--con-line-strong)] px-2.5 text-[length:var(--con-fs-xs)] font-medium text-[color:var(--con-muted)] transition-colors hover:border-[color:var(--con-accent)] hover:text-[color:var(--con-accent)] md:flex sm:h-8"
            title="Admin portal — operator diagnostics: connections, LLM spend, RAG coverage, server.  Visible because this login has admin rights."
          >
            <ShieldCheck size={14} />
            Admin
          </Link>
        )}
        {/* Always visible (PR-E3): touch users have no ⌘K chord; icon-only on
            phones (kbd hidden below sm) so the bar still prioritizes scope + STOP. */}
        <CommandPaletteTrigger />
        <NotificationInbox snapshot={snapshot} />
        <UserMenu snapshot={snapshot} theme={theme} setTheme={setTheme} />
        <div className="hidden sm:block">
          <RunOnceButton snapshot={snapshot} />
        </div>
        {/* Phones get an icon-only Run once: the home hero's call-to-action was
            unreachable on mobile without scrolling to the very bottom. Icon-only
            keeps the owner-tuned phone-bar priorities (scope gets the slack,
            nothing squeezes STOP). size="sm" trims its footprint to help the
            scope selector's mobile min-width fit; the outline styling (chrome.tsx)
            keeps it from reading as a second "Start" sitting right next to it. */}
        <div className="sm:hidden">
          <RunOnceButton snapshot={snapshot} size="sm" iconOnly />
        </div>
        <RunStateButton snapshot={snapshot} />
      </div>
    </header>
  );
}
