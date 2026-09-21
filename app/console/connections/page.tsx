"use client";

/** Connections — the one-time-setup half of the old Settings page, split out
 *  in the 2026-07-16 Configure IA restructure: broker accounts and provider
 *  API keys, both user-level (ALL YOUR ACCOUNTS — they overlay every account
 *  you connect). Recurring preferences (notifications, sharing, appearance,
 *  etc.) stay on Settings. The card modules themselves did not move — they
 *  still live in ../settings/brokers and ../settings/api-keys, imported from
 *  here, so their fetch helpers in ../settings/lib keep working unchanged. */

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { CONSOLE_PAGE_WIDTH } from "../lib/page-width";
import { useConsoleData } from "../lib/useConsoleData";
import { Btn, Chip } from "../ui/primitives";
import { ApiKeysCard } from "../settings/api-keys";
import { BrokerAccountsCard } from "../settings/brokers";

export const metadata = { title: "Connections" };

export default function ConnectionsPage() {
  const { snapshot, loading, error, refresh } = useConsoleData();
  const ready = snapshot !== null;

  // Deep links (e.g. the Run-once blocked sheet, the account-scope menu, and the
  // Robinhood OAuth return trip all route to /console/connections#brokers or
  // #api-keys): the shell lets this route paint before the snapshot arrives
  // (SELF_SKELETON_ROUTES), so the anchors exist from first render — scroll on
  // mount, then again once the snapshot lands, because the broker placeholder is
  // replaced by real content of a different height, which shifts whatever the
  // first scroll landed on.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const timer = setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    return () => clearTimeout(timer);
  }, [ready]);

  return (
    <div className={`${CONSOLE_PAGE_WIDTH} flex flex-col gap-6`}>
      <h1 className="px-4 text-[length:var(--con-fs-lg)] font-bold lg:px-0">Connections</h1>

      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Chip
            tone="accent"
            title="Settings tagged ALL YOUR ACCOUNTS are stored per user — they overlay every account you connect, in every scope."
          >
            ALL YOUR ACCOUNTS
          </Chip>
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            applies everywhere, for you
          </span>
        </div>
        {/* Anchor ids (#brokers/#api-keys) are deep-link targets used by the
            Run-once blocked-reason sheet, the account-scope menu, and the
            Robinhood OAuth return trip; scroll-mt clears the sticky chrome. */}
        <div id="brokers" className="scroll-mt-28">
          {ready ? (
            <BrokerAccountsCard />
          ) : (
            <BrokerConnectionsPlaceholder loading={loading} error={error} onRetry={refresh} />
          )}
        </div>
        <div id="api-keys" className="scroll-mt-28">
          <ApiKeysCard />
        </div>
      </section>
    </div>
  );
}

/** Stand-in for BrokerAccountsCard while the dashboard snapshot is missing (the
 *  card reads connectedAccounts/policy/pending counts and renders nothing
 *  without them). Because the shell's SELF_SKELETON_ROUTES branch also bypasses
 *  its full-screen error card for this route, this placeholder is the route's
 *  only failure surface: once the first-load watchdog gives up (`error` set,
 *  `loading` false, snapshot still null) it must show the error and a retry —
 *  not pulse forever. ApiKeysCard below stays live in both states. */
function BrokerConnectionsPlaceholder({
  loading,
  error,
  onRetry
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => Promise<void>;
}) {
  if (!loading && error) {
    return (
      <section className="con-card">
        <header className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-1">
          <h2 className="con-card-title">Broker connections</h2>
        </header>
        <div className="px-4 pb-4 pt-2">
          {/* role="alert" on the message only — an alert should carry text, not the
              interactive Retry control, which stays a normally-discoverable sibling. */}
          <p role="alert" className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
            {error} The console retries automatically.
          </p>
          <div className="mt-3">
            <Btn variant="outline" size="sm" onClick={() => void onRetry()}>
              <RefreshCw className="h-3.5 w-3.5" />
              Retry now
            </Btn>
          </div>
        </div>
      </section>
    );
  }
  return (
    <section className="con-card">
      <header className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-1">
        <h2 className="con-card-title">Broker connections</h2>
        {/* Inert stand-ins for the real card's three connect buttons (same con-btn
            classes, labels invisible) so the header reserves the same height — and the
            same wrap behavior at phone widths — and the swap to the real card doesn't
            shift the ApiKeysCard the user may already be typing into. */}
        <div className="flex flex-wrap justify-end gap-2 animate-pulse" aria-hidden="true">
          {["Connect Robinhood", "Connect Alpaca", "Connect Tradier"].map((label) => (
            <span key={label} className="con-btn con-btn-outline con-btn-sm pointer-events-none select-none opacity-45">
              <span className="invisible">{label}</span>
            </span>
          ))}
        </div>
      </header>
      {/* Bars approximate the real card: an intro line and two account rows. */}
      <div className="animate-pulse px-4 pb-4 pt-2" aria-hidden="true">
        <div className="flex flex-col gap-3">
          <div className="h-3 w-2/3 rounded-control bg-[color:var(--con-line)]" />
          <div className="h-16 rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)]" />
          <div className="h-16 rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)]" />
        </div>
      </div>
      <BrokerLoadingStatus />
    </section>
  );
}

/** Screen-reader loading announcement. Mounted EMPTY and populated a beat later:
 *  live regions announce changes, so a region that mounts already containing its
 *  text is typically not read at all. Deliberately no aria-busy on the card —
 *  aria-busy licenses assistive tech to withhold changes inside the subtree,
 *  which would suppress this very announcement. */
function BrokerLoadingStatus() {
  const [message, setMessage] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setMessage("Loading broker connections…"), 150);
    return () => clearTimeout(timer);
  }, []);
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {message}
    </p>
  );
}
