"use client";

/** Settings — GLOBAL-ONLY since the 2026-07-10 IA restructure: everything here
 *  is either ALL YOUR ACCOUNTS (event notifications, delivery channels, scan
 *  shape, learning review, daily LLM budget, typed confirmation, boot behavior
 *  — user-level, overlaid on every account), THIS BROWSER (appearance),
 *  OPERATOR (admin links), REFERENCE (glossary), or DANGER (deletion). Nothing
 *  account-scoped lives here: per-account config (models, prompt, weights)
 *  belongs to Strategy (/console/strategy) and Guardrails (/console/guardrails,
 *  including tax treatment). The one-time-setup half of the old Settings page
 *  — broker connections and API keys — split out to Connections
 *  (/console/connections) in the 2026-07-16 IA restructure; a 3-line hash
 *  safety net below redirects any old #brokers/#api-keys bookmark there.
 *  Sub-sections live in sibling modules (delivery/danger/help/sharing/
 *  learning-review / llm-budget) with their fetch helpers in ./lib. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import type { NotificationEventType } from "@/lib/types";
import { NOTIFICATION_EVENT_TYPES } from "@/lib/types";
import { NOTIFICATION_EVENT_TYPE_LABELS } from "@/lib/dashboard-ui";
import { savePolicy, setAutoResume, ConsoleApiError } from "../lib/api";
import { resolveSourceFeatureNumberCommit } from "../lib/number-commit";
import { loginProviderLabel } from "../lib/labels";
import { CONSOLE_PAGE_WIDTH } from "../lib/page-width";
import { useAutoSave } from "../lib/useAutoSave";
import { useConsoleData } from "../lib/useConsoleData";
import { CONSOLE_FONT_OPTIONS, useConsoleFont } from "../lib/useConsoleFont";
import { CONSOLE_TEXT_BOX_FONT_OPTIONS, useConsoleTextBoxFont } from "../lib/useConsoleTextBoxFont";
import { useTickerLogoDisplay } from "../lib/useTickerLogoDisplay";
import type { TickerLogoDisplay } from "@/lib/ticker-logos";
import { useToast } from "../ui/toast";
import { Card, Chip, Field, RawNumInput, Toggle } from "../ui/primitives";
import { SaveStatus } from "../ui/save-status";
import { AccountDeletionCard } from "./danger";
import { DeliveryChannelsCard } from "./delivery";
import { HelpGlossaryCard } from "./help";
import { LearningReviewCard } from "./learning-review";
import { LegalCard } from "./legal";
import { LlmBudgetCard } from "./llm-budget";
import { ProxyCard } from "./proxy";
import { DataSharingCard } from "./sharing";
import {
  fetchSourceFeatures,
  patchSourceFeatures,
  type SourceFeatureRow
} from "./lib";

/** Sticky jump-chip targets for the long Settings page (UX PR-B4).
 *  Ids are also hash deep-link anchors — keep in sync with the wrappers below
 *  and with external links (e.g. Approvals → #learning-review). Labels are
 *  short for horizontal-scroll chips on mobile. */
const SETTINGS_TOC: ReadonlyArray<{ id: string; label: string }> = [
  { id: "notifications", label: "Notifications" },
  { id: "delivery", label: "Delivery" },
  { id: "sharing", label: "Sharing" },
  { id: "legal", label: "Legal" },
  { id: "learning-review", label: "Learning review" },
  { id: "llm-budget", label: "AI budget" },
  { id: "scan-shape", label: "Scan shape" },
  { id: "data-sources", label: "Data sources" },
  { id: "confirmation", label: "Confirmation" },
  { id: "boot", label: "Boot" },
  { id: "you", label: "Account" },
  { id: "appearance", label: "Display" },
  { id: "glossary", label: "Glossary" },
  { id: "danger", label: "Danger" }
];

/** Shared scroll offset class: clears sticky console chrome + the sticky TOC bar. */
const SECTION_SCROLL_MT = "scroll-mt-36";

/** One-line meaning for every notification event, completing the sentence
 *  "you get a notification whenever ...". VISIBLE LABELS come from the shared
 *  NOTIFICATION_EVENT_TYPE_LABELS map in src/lib/dashboard-ui.ts, so this page
 *  names events exactly the way the Alert Center and delivered notifications
 *  do. Both maps are full Records (not Partial): adding a NotificationEventType
 *  without copy is a compile error instead of a raw "run_failed" leaking into
 *  production UI. */
const EVENT_HINT: Record<NotificationEventType, string> = {
  fill: "an order filled",
  block: "the policy gate blocked an order",
  run_failed: "a strategy run failed",
  pending_approval: "a trade is waiting for you",
  kill_switch: "a circuit breaker fired",
  price_alert: "a price alert triggered",
  proposal_withdrawn: "the strategist took an idea back",
  limit_order_stale: "a limit order has been working too long",
  provider_degraded: "a data provider is failing",
  liveness_warning: "the trading liveness check degraded",
  budget_alert: "a usage budget threshold was crossed",
  learning_review: "the daily learning review posted its findings",
  deterministic_bear_veto: "the rule-based bear check vetoed a trade idea",
  red_team_veto_override_requested: "an override of a Red Team veto was requested",
  red_team_veto_overridden: "a human overrode a Red Team veto",
  prompt_injection_suspected: "injection-like text was found in the evidence sent to the model",
  evidence_age_anomaly: "a run leaned on evidence older than it should be",
  storage_warning: "the server's database storage crossed a warning threshold",
  autonomy_halted_on_boot: "a restart halted trading autonomy until you re-arm it",
  option_alert: "an option contract changed status or expired",
  earningscalls_entitlement_blocked: "the EarningsCalls.dev transcript program paused on a plan-entitlement problem",
  roic_status_advisory: "the ROIC.ai transcript program status and limits (advisory)",
  risk_advisory: "a risk guardrail was breached; nothing was blocked or changed (advisory)",
  protective_exit_failing: "a synthetic protective exit keeps failing and is still retrying",
  signal_health: "the AI's confidence signal is losing predictive power against matured outcomes (advisory)",
  lookahead_leak: "the weekly lookahead audit found decision inputs that differ when replayed from point-in-time data (advisory)",
  // Not shown in the list below — the daily watchlist digest has its own dedicated toggle in
  // Delivery (settings/delivery.tsx, notification_prefs.watchlistDigestEnabled) and is delivered
  // via notify() directly rather than through this enabledEvents gate, so an entry here would be
  // a second, non-functional on/off switch. Kept in the map only so NOTIFICATION_EVENT_TYPES stays
  // exhaustively labeled.
  watchlist_digest: "your daily watchlist digest sends (configured in Delivery, below)"
};

/** Sticky horizontal jump chips for the long Settings page (UX PR-B4).
 *  Sticks under the console topbar (measured) so chips stay reachable while
 *  scrolling; mobile overflow-x scrolls the chip row. No policy writes. */
function SettingsToc() {
  // Seed from hash on first client paint so deep links highlight without an effect.
  const [activeId, setActiveId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const hash = window.location.hash.slice(1);
    return SETTINGS_TOC.some((s) => s.id === hash) ? hash : null;
  });
  const [topOffset, setTopOffset] = useState(0);

  // Stick just below the console topbar (RealityBanner + ChromeBar + mobile
  // freshness). Measure live so desktop/mobile chrome heights both work.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const topbar = document.querySelector<HTMLElement>(".con-topbar");
    if (!topbar) return;
    const apply = () => setTopOffset(Math.ceil(topbar.getBoundingClientRect().height));
    apply();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
    ro?.observe(topbar);
    window.addEventListener("resize", apply);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, []);

  // Highlight the section currently in view (top of viewport + sticky chrome).
  useEffect(() => {
    if (typeof window === "undefined" || typeof IntersectionObserver === "undefined") return;
    const nodes = SETTINGS_TOC.map((s) => document.getElementById(s.id)).filter(
      (el): el is HTMLElement => el !== null
    );
    if (nodes.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Prefer the topmost intersecting section.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target?.id) setActiveId(visible[0].target.id);
      },
      {
        // Account for sticky chrome + TOC strip so "active" matches what the user sees.
        rootMargin: `-${Math.max(topOffset + 48, 96)}px 0px -55% 0px`,
        threshold: [0, 0.1, 0.25]
      }
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [topOffset]);

  const jump = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    setActiveId(id);
    // Keep URL shareable / back-button friendly without a full navigation.
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `#${id}`);
    }
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <nav
      aria-label="Settings sections"
      className="sticky z-30 -mx-4 border-b border-[color:var(--con-line)] bg-[color:var(--con-bg)]/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-[color:var(--con-bg)]/85 lg:-mx-6 lg:px-6"
      style={{ top: topOffset }}
    >
      <div className="flex gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {SETTINGS_TOC.map((item) => {
          const isActive = activeId === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => jump(item.id)}
              aria-current={isActive ? "true" : undefined}
              className={`shrink-0 rounded-full border px-2.5 py-1 text-[length:var(--con-fs-xs)] font-semibold transition-colors ${
                isActive
                  ? "border-[color:var(--con-accent)] bg-[color:var(--con-accent-soft)] text-[color:var(--con-accent)]"
                  : "border-[color:var(--con-line-strong)] bg-[color:var(--con-surface-2)] text-[color:var(--con-muted)] hover:border-[color:var(--con-accent-border)] hover:text-[color:var(--con-fg)]"
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export default function SettingsPage() {
  const { snapshot } = useConsoleData();
  const ready = snapshot !== null;

  const router = useRouter();

  // Deep links (e.g. #sharing, #learning-review, #confirmation, #danger, #appearance):
  // the page renders only after the snapshot arrives, so the native anchor jump
  // misses — scroll once the target section actually exists. Safety net: #brokers
  // and #api-keys moved to /console/connections in the 2026-07-16 IA restructure —
  // an old bookmark or stale link redirects there instead of scrolling to nothing.
  useEffect(() => {
    if (!ready || typeof window === "undefined") return;
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    if (hash === "brokers" || hash === "api-keys") {
      router.replace(`/console/connections#${hash}`);
      return;
    }
    const timer = setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    return () => clearTimeout(timer);
  }, [ready, router]);

  if (!snapshot) return null;

  return (
    <div className={`${CONSOLE_PAGE_WIDTH} flex flex-col gap-6`}>
      <h1 className="text-[length:var(--con-fs-lg)] font-bold">Settings</h1>

      {/* Sticky jump chips — long page, no policy behavior change (UX PR-B4). */}
      <SettingsToc />

      {/* Account-scoped config (models, prompt, weights) lives on Strategy
          (/console/strategy); Guardrails (/console/guardrails) carries the caps,
          protective stops, tax treatment, and rulebook — Settings is global-only. */}

      {/* ── ALL ACCOUNTS ── */}
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
        {/* notificationSettings is a USER-level policy field (USER_LEVEL_POLICY_FIELDS
            in db-profiles): one event list + webhook overlaid on every account —
            so the card lives under ALL YOUR ACCOUNTS, not THIS ACCOUNT. */}
        <div id="notifications" className={SECTION_SCROLL_MT}>
          <EventNotificationsCard />
        </div>
        <div id="delivery" className={SECTION_SCROLL_MT}>
          <DeliveryChannelsCard />
        </div>
        <div id="sharing" className={SECTION_SCROLL_MT}>
          <DataSharingCard />
        </div>
        <div id="legal" className={SECTION_SCROLL_MT}>
          <LegalCard />
        </div>
        {/* learningReviewEnabled/Mode/Model are USER-level policy fields
            (USER_LEVEL_POLICY_FIELDS in db-profiles): the review runs once per
            user per day over user-level learned context, so its config overlays
            every account — it belongs under ALL YOUR ACCOUNTS, not THIS ACCOUNT.
            The anchor id is a deep-link target (the Learning Review blocks on
            /console/approvals link here as "Model settings"). */}
        <div id="learning-review" className={SECTION_SCROLL_MT}>
          <LearningReviewCard />
        </div>
        <div id="llm-budget" className={SECTION_SCROLL_MT}>
          <LlmBudgetCard />
        </div>
        <div id="scan-shape" className={SECTION_SCROLL_MT}>
          <ScanShapeCard />
        </div>
        {/* id data-sources is canonical; fmp-features kept as alias for old deep-links */}
        <div id="data-sources" className={SECTION_SCROLL_MT}>
          <div id="fmp-features" className="contents">
            <DataSourcesCard />
          </div>
          <div className="mt-4">
            <ProxyCard />
          </div>
        </div>
        {/* requireTypedConfirmation is a USER-level policy field
            (USER_LEVEL_POLICY_FIELDS in db-profiles, promoted 2026-07-10): the
            phrase ceremony is an owner preference, not a per-account guardrail,
            so one switch applies across every account. */}
        <div id="confirmation" className={SECTION_SCROLL_MT}>
          <AdvancedActionConfirmationCard />
        </div>
        <div id="boot" className={SECTION_SCROLL_MT}>
          <BootBehaviorCard />
        </div>
        <div id="you" className={SECTION_SCROLL_MT}>
          <YouCard />
        </div>
      </section>

      {/* ── THIS BROWSER ── */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Chip tone="muted" title="Settings tagged THIS BROWSER are stored in this browser only.  They change how the console looks here, not how the strategy trades.">
            THIS BROWSER
          </Chip>
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            local display preferences
          </span>
        </div>
        <div id="appearance" className={SECTION_SCROLL_MT}>
          <AppearanceCard />
        </div>
      </section>

      {/* ── REFERENCE ── */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Chip tone="muted" title="Nothing here changes any setting — it's the app's vocabulary, searchable.">
            REFERENCE
          </Chip>
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            nothing here changes any setting — it&apos;s the app&apos;s vocabulary, searchable
          </span>
        </div>
        <div id="glossary" className={SECTION_SCROLL_MT}>
          <HelpGlossaryCard />
        </div>
      </section>

      {/* ── DANGER ── */}
      <section id="danger" className={`flex ${SECTION_SCROLL_MT} flex-col gap-4`}>
        <div className="flex items-center gap-2">
          <Chip tone="neg" title="Irreversible actions live here, behind typed confirmations — nothing in this section happens by accident.">
            DANGER
          </Chip>
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            irreversible actions, behind typed confirmations
          </span>
        </div>
        <AccountDeletionCard />
      </section>
    </div>
  );
}

// ── All accounts: typed confirmation for high-impact live actions ────────────

function AdvancedActionConfirmationCard() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  // Default ON (undefined => required). Real money is normal, but the phrase stays available as an
  // owner preference — this switch turns it off so approvals / replacements / loosening are one click.
  const required = snapshot?.policy.requireTypedConfirmation !== false;
  const setRequired = async (next: boolean) => {
    setSaving(true);
    try {
      await savePolicy({ requireTypedConfirmation: next });
      await refresh();
      toast.push(
        "pos",
        next ? "Typed confirmation on" : "Typed confirmation off",
        next
          ? "Approving a broker order, replacing a live order, and loosening a guardrail ask you to type the phrase first."
          : "Those are now ordinary one-click actions.  Winding down (which sells) and account deletion still confirm."
      );
    } catch (error) {
      toast.push("neg", "Couldn't save", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card title="Advanced action confirmation">
      <Field
        label="Type a phrase to confirm high-impact live actions"
        hint="One switch for your whole login — it applies across every account you connect.  On: approving a broker order, replacing a live order at market, and loosening a guardrail on a live account each ask you to type a short phrase (e.g. APPROVE LIVE NVDA) first. Off: they are one click.  Winding down (which SELLS) and deleting an account always keep their own typed confirmation regardless."
      >
        <div className="flex items-center gap-3">
          <Toggle
            checked={required}
            onChange={(next) => void setRequired(next)}
            disabled={saving}
            label="Require typed confirmation for high-impact live actions"
          />
          <span className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
            {required ? "On — type to confirm" : "Off — one click"}
          </span>
        </div>
      </Field>
    </Card>
  );
}

// ── This browser: local appearance preferences ──────────────────────────────

/** Shared button-grid for the two font pickers below — same idiom, different
 *  option list/selection/setter. */
function FontOptionGrid<F extends string>({
  options,
  selected,
  onSelect
}: {
  options: Array<{ value: F; label: string; description: string; fontFamily: string }>;
  selected: F;
  onSelect: (next: F) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((option) => {
        const isSelected = selected === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={isSelected}
            title={option.description}
            onClick={() => onSelect(option.value)}
            className={`min-h-[88px] rounded-control border px-3 py-2 text-left transition-colors ${
              isSelected
                ? "border-[color:var(--con-accent)] bg-[color:var(--con-accent-soft)]"
                : "border-[color:var(--con-line-strong)] bg-[color:var(--con-surface-2)] hover:border-[color:var(--con-accent-border)]"
            }`}
          >
            <span className="flex items-center justify-between gap-2 text-[length:var(--con-fs-sm)] font-semibold text-[color:var(--con-fg)]">
              {option.label}
              {isSelected && <Check size={14} className="text-[color:var(--con-accent)]" aria-hidden />}
            </span>
            <span
              className="mt-1 block max-h-[44px] overflow-hidden text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]"
              style={{ fontFamily: option.fontFamily }}
            >
              Objective: compound returns by rotating capital toward the strongest risk-adjusted opportunities.
            </span>
          </button>
        );
      })}
    </div>
  );
}

const TICKER_LOGO_DISPLAY_OPTIONS: Array<{ value: TickerLogoDisplay; label: string; description: string }> = [
  {
    value: "transparent",
    label: "Transparent",
    description: "Clean, transparent company logos without a background tile."
  },
  {
    value: "tile",
    label: "Tile Badge",
    description: "Company logos seated inside a neutral tile badge for consistent contrast."
  },
  {
    value: "off",
    label: "Monograms Only",
    description: "Hide company logos and render clean 2-letter ticker monograms."
  }
];

function AppearanceCard() {
  const { textBoxFont, setTextBoxFont } = useConsoleTextBoxFont();
  const { consoleFont, setConsoleFont } = useConsoleFont();
  const { tickerLogoDisplay, setTickerLogoDisplay } = useTickerLogoDisplay();

  return (
    <Card title="Appearance">
      <Field label="Ticker Logo Display" hint="Controls how ticker logos render across tables, cards, and symbols in this browser.">
        <div className="grid gap-2 sm:grid-cols-3">
          {TICKER_LOGO_DISPLAY_OPTIONS.map((opt) => {
            const isSelected = tickerLogoDisplay === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                aria-pressed={isSelected}
                onClick={() => setTickerLogoDisplay(opt.value)}
                className={`min-h-[72px] rounded-control border px-3 py-2 text-left transition-colors ${
                  isSelected
                    ? "border-[color:var(--con-accent)] bg-[color:var(--con-accent-soft)]"
                    : "border-[color:var(--con-line-strong)] bg-[color:var(--con-surface-2)] hover:border-[color:var(--con-accent-border)]"
                }`}
              >
                <span className="flex items-center justify-between gap-2 text-[length:var(--con-fs-sm)] font-semibold text-[color:var(--con-fg)]">
                  {opt.label}
                  {isSelected && <Check size={14} className="text-[color:var(--con-accent)]" aria-hidden />}
                </span>
                <span className="mt-1 block text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
                  {opt.description}
                </span>
              </button>
            );
          })}
        </div>
      </Field>
      <div className="mt-4">
        <Field label="Console Font" hint="The whole console (nav, cards, copy) uses this font in this browser.">
          <FontOptionGrid options={CONSOLE_FONT_OPTIONS} selected={consoleFont} onSelect={setConsoleFont} />
        </Field>
      </div>
      <div className="mt-4">
        <Field label="Text Box Font" hint="Editable text boxes use this font in this browser.">
          <FontOptionGrid options={CONSOLE_TEXT_BOX_FONT_OPTIONS} selected={textBoxFont} onSelect={setTextBoxFont} />
        </Field>
      </div>
    </Card>
  );
}



// ── All accounts: event notifications (user-level policy field) ─────────────

function EventNotificationsCard() {
  const { snapshot, refresh } = useConsoleData();
  const autoSave = useAutoSave();
  // Sticky optimistic local state: seeded lazily from the snapshot, updated on
  // change for instant feedback, reverted by useAutoSave's onError if the write
  // fails. refresh() keeps the shared snapshot current for the rest of the app.
  const [localEvents, setLocalEvents] = useState<NotificationEventType[] | null>(null);
  if (!snapshot) return null;

  const current = snapshot.policy.notificationSettings;
  const events = localEvents ?? current.enabledEvents;

  const toggleEvent = (type: NotificationEventType, on: boolean) => {
    const prev = events;
    const next = on ? events.filter((e) => e !== type) : [...events, type];
    setLocalEvents(next);
    autoSave.save(() => savePolicy({ notificationSettings: { enabledEvents: next } }).then(() => refresh()), {
      onError: () => setLocalEvents(prev)
    });
  };

  return (
    <Card title="Event notifications" action={<SaveStatus status={autoSave.status} />}>
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Which events send notifications. One list for your whole login — it applies across every account, not just the
        one you&apos;re viewing. Where they go (webhook URL, push/email/SMS) is configured in Delivery channels, below.
      </p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {/* watchlist_digest is deliberately excluded — see the EVENT_HINT comment above. */}
        {NOTIFICATION_EVENT_TYPES.filter((type) => type !== "watchlist_digest").map((type) => {
          const on = events.includes(type);
          const hint = EVENT_HINT[type];
          return (
            <label
              key={type}
              title={`${type} — when on, you get a notification whenever ${hint}. (${type} is the event's id in webhook payloads and the audit log.)`}
              className="flex cursor-pointer items-start gap-2 rounded-control px-1.5 py-1 text-[length:var(--con-fs-sm)] transition-colors hover:bg-[color:var(--con-surface-2)] focus-within:bg-[color:var(--con-surface-2)]"
            >
              {/* Native checkbox inside its <label>: the visible text IS the accessible
                  name — no aria-label needed (unlike the Toggle primitive elsewhere). */}
              <input
                type="checkbox"
                className="mt-1"
                checked={on}
                disabled={autoSave.saving}
                onChange={() => toggleEvent(type, on)}
              />
              <span className="min-w-0">
                <span className="font-semibold">{NOTIFICATION_EVENT_TYPE_LABELS[type]}</span>{" "}
                <span className="text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">{hint}</span>
              </span>
            </label>
          );
        })}
      </div>
    </Card>
  );
}

// ── All accounts: scan shape ─────────────────────────────────────────────────

function ScanShapeCard() {
  const { snapshot, refresh } = useConsoleData();
  const autoSave = useAutoSave();
  const [draft, setDraft] = useState<{ marketScanCandidateLimit?: number; marketScanOutlierReserve?: number }>({});
  if (!snapshot) return null;

  const policy = snapshot.policy;
  const candidateLimit = draft.marketScanCandidateLimit ?? policy.marketScanCandidateLimit;
  const outlierReserve = draft.marketScanOutlierReserve ?? policy.marketScanOutlierReserve;

  // Numeric fields: local text while typing, persist on blur. `key` is a top-level
  // policy field (whole-replace), not a nested object.
  const commitNumber = (key: "marketScanCandidateLimit" | "marketScanOutlierReserve", next: number | undefined, saved: number | undefined) => {
    if (next === saved) return; // unchanged → no write
    autoSave.save(() => savePolicy({ [key]: next }).then(() => refresh()), {
      onError: () => setDraft((d) => ({ ...d, [key]: saved }))
    });
  };

  return (
    <Card title="Market-scan shape" action={<SaveStatus status={autoSave.status} />}>
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        How wide every account&apos;s market scan looks. These two are user-level, like everything on this page: they
        overlay all your accounts.
      </p>
      <div className="grid max-w-md grid-cols-2 gap-3">
        <Field label="Enriched candidates" hint="Ranked names that get full enrichment per run." htmlFor="scan-limit">
          <RawNumInput
            id="scan-limit"
            value={String(candidateLimit ?? "")}
            emptyValue={0}
            title="How many top-ranked symbols get full enrichment (fundamentals, news, technicals) each run.  More = wider view, slower and costlier runs.  Saves when you click away."
            onValueChange={(parsed) => setDraft((d) => ({ ...d, marketScanCandidateLimit: parsed }))}
            onBlur={() => commitNumber("marketScanCandidateLimit", candidateLimit, policy.marketScanCandidateLimit)}
          />
        </Field>
        <Field label="Outlier reserve" hint="Below-cutoff slots reserved for notable web signals." htmlFor="scan-reserve">
          <RawNumInput
            id="scan-reserve"
            value={String(outlierReserve ?? "")}
            emptyValue={0}
            title="Of the candidate slots, how many are held for symbols that rank below the cutoff but carry a notable web signal (news spike, unusual activity).  Saves when you click away."
            onValueChange={(parsed) => setDraft((d) => ({ ...d, marketScanOutlierReserve: parsed }))}
            onBlur={() => commitNumber("marketScanOutlierReserve", outlierReserve, policy.marketScanOutlierReserve)}
          />
        </Field>
      </div>
    </Card>
  );
}

// ── All accounts: boot behavior ──────────────────────────────────────────────

function BootBehaviorCard() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!snapshot) return null;

  return (
    <Card title="After a restart">
      <div
        className="flex items-center justify-between gap-4 rounded-control px-1.5 py-1 transition-colors hover:bg-[color:var(--con-surface-2)]"
        title="Controls what happens to Running accounts when the server process restarts.  Off keeps the safety net: a human must start trading again."
      >
        <div>
          <div className="text-[length:var(--con-fs-sm)] font-semibold">Auto-resume on boot</div>
          <p className="mt-0.5 max-w-xl text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
            Off (recommended): whenever the server restarts, any Running account is stopped until a person starts it
            again — a restored backup or crash-loop can never silently resume trading.  Turning this ON removes that
            safety net.
          </p>
        </div>
        <Toggle
          checked={snapshot.autoResumeOnBoot}
          onChange={async (next) => {
            setBusy(true);
            try {
              await setAutoResume(next);
              await refresh();
              toast.push(next ? "warn" : "pos", next ? "Auto-resume ON" : "Auto-resume off", next ? "Accounts left Running will resume by themselves after a restart." : "Restarts stop everything until you start it again.");
            } catch (error) {
              toast.push("neg", "Not saved", error instanceof ConsoleApiError ? error.message : String(error));
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy}
          label="Auto-resume on boot"
        />
      </div>
    </Card>
  );
}

// ── You ──────────────────────────────────────────────────────────────────────

function YouCard() {
  const { snapshot } = useConsoleData();
  if (!snapshot?.currentUser) return null;
  const user = snapshot.currentUser;
  return (
    <Card title="Account">
      <div className="flex flex-wrap items-center gap-2 text-[length:var(--con-fs-sm)]">
        <span className="font-semibold" title="The signed-in user every ALL YOUR ACCOUNTS setting belongs to.">
          {user.name ?? user.email ?? user.userId}
        </span>
        {user.email && user.name && <span className="text-[color:var(--con-faint)]">{user.email}</span>}
        {user.isAdmin && (
          <Chip tone="accent" title="This login has operator/admin rights on the server.">
            ADMIN
          </Chip>
        )}
        {user.loginProvider && (
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]" title="Which identity provider authenticated this session.">
            via {loginProviderLabel(user.loginProvider)}
          </span>
        )}
      </div>
    </Card>
  );
}

// ── All accounts: Data sources + per-user feature knobs ──────────────────────

const GROUP_ORDER = ["fmp", "sec", "web_sources", "transcripts", "rag", "enrichment"] as const;

/** Decides what a "Data sources" number row's blur should persist, given the
 *  raw text just typed and the row's last committed value. Returns null when
 *  nothing should be written to the server: blank/unparseable text reverts to
 *  the last committed value instead of silently saving a fallback (these rows
 *  used to PATCH the row's default straight to the server on the very next
 *  keystroke after clearing the field), and an unchanged value is a no-op. */
function DataSourcesCard() {
  const toast = useToast();
  const [rows, setRows] = useState<SourceFeatureRow[] | null>(null);
  const [groups, setGroups] = useState<Record<string, { title: string; blurb: string }>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<import("../lib/useAutoSave").AutoSaveStatus>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  // Raw in-progress text for number rows, keyed by row id — commit-on-blur (see
  // commitNumberRow below), matching every other numeric field in the console
  // instead of PATCHing the server on every keystroke.
  const [numberDrafts, setNumberDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const data = await fetchSourceFeatures();
      setRows(data.settings);
      setGroups(data.groups);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ConsoleApiError ? err.message : "Could not load source settings.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byGroup = useMemo(() => {
    const map = new Map<string, SourceFeatureRow[]>();
    for (const row of rows ?? []) {
      if (row.advanced && !showAdvanced) continue;
      const list = map.get(row.group) ?? [];
      list.push(row);
      map.set(row.group, list);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g)!] as const);
  }, [rows, showAdvanced]);

  const saveOne = async (id: string, value: boolean | number | string | null) => {
    setBusy(id);
    setSaveStatus("saving");
    setRows((cur) =>
      (cur ?? []).map((row) => {
        if (row.id !== id) return row;
        if (value === null) {
          return { ...row, value: row.defaultValue, source: "default" as const };
        }
        return { ...row, value, source: "user" as const };
      })
    );
    try {
      await patchSourceFeatures({ [id]: value });
      await load();
      setSaveStatus("saved");
    } catch (err) {
      setSaveStatus("error");
      toast.push("neg", "Could not save", err instanceof ConsoleApiError ? err.message : String(err));
      await load();
    } finally {
      setBusy(null);
    }
  };

  // Commits a number row's typed text on blur. Blank or unparseable text
  // reverts to the row's last committed value instead of silently persisting
  // a fallback (an emptied field used to write the row's default straight to
  // the server on the very next keystroke).
  const commitNumberRow = async (row: SourceFeatureRow) => {
    const raw = numberDrafts[row.id];
    setNumberDrafts((d) => {
      if (!(row.id in d)) return d;
      const copy = { ...d };
      delete copy[row.id];
      return copy;
    });
    if (raw === undefined) return;
    const next = resolveSourceFeatureNumberCommit(raw, Number(row.value));
    if (next === null) return;
    await saveOne(row.id, next);
  };

  return (
    <Card
      title="Data sources"
      action={
        <span className="flex items-center gap-2">
          <SaveStatus status={saveStatus} />
          <a
            href="/console/connections#api-keys"
            className="text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)] underline-offset-2 hover:underline"
            title="Open Connections to add provider keys and plan tiers."
          >
            Manage keys →
          </a>
        </span>
      }
    >
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Turn data features on or off for your account.  Values you set here override the current
        default; leave a row unset to keep it.  API keys and plan tiers still live on{" "}
        <a href="/console/connections#api-keys" className="font-semibold text-[color:var(--con-accent)] underline-offset-2 hover:underline">
          Connections
        </a>
        .
      </p>

      {loadError && (
        <p className="mb-3 rounded-control border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] p-2.5 text-[length:var(--con-fs-xs)]">
          {loadError}{" "}
          <button type="button" className="font-semibold underline" onClick={() => void load()}>
            Retry
          </button>
        </p>
      )}

      {rows === null && !loadError && (
        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">Loading source settings…</p>
      )}

      <div className="mb-3 flex items-center gap-2">
        <Toggle
          checked={showAdvanced}
          onChange={setShowAdvanced}
          label="Show Advanced Features"
        />
      </div>

      <div className="flex flex-col gap-4">
        {byGroup.map(([groupId, list]) => {
          const meta = groups[groupId] ?? { title: groupId, blurb: "" };
          return (
            <div key={groupId} className="rounded-control border border-[color:var(--con-line)] p-2.5">
              <div className="text-[length:var(--con-fs-sm)] font-semibold">{meta.title}</div>
              {meta.blurb && (
                <p className="mt-0.5 mb-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">{meta.blurb}</p>
              )}
              <div className="flex flex-col gap-2">
                {list.map((row) => (
                  <div
                    key={row.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-control px-1.5 py-1 hover:bg-[color:var(--con-surface-2)]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[length:var(--con-fs-sm)] font-semibold">{row.label}</span>
                        <Chip
                          tone={row.source === "user" ? "pos" : row.source === "server" ? "info" : row.source === "env" ? "accent" : "muted"}
                          title={
                            row.source === "user"
                              ? "You overrode this for your account"
                              : row.source === "server"
                                ? "Server-level override set by the operator in Admin > Operations"
                                : row.source === "env"
                                  ? "Using the server default"
                                  : "Catalog default"
                          }
                        >
                          {row.source}
                        </Chip>
                        {row.advanced && (
                          <Chip tone="muted" title="Advanced">
                            adv
                          </Chip>
                        )}
                      </div>
                      <p className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">{row.description}</p>
                      {row.caveat && (
                        <p className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">{row.caveat}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {row.type === "boolean" ? (
                        <Toggle
                          checked={Boolean(row.value)}
                          disabled={busy !== null}
                          busy={busy === row.id}
                          onChange={(on) => void saveOne(row.id, on)}
                          label={row.label}
                        />
                      ) : row.type === "number" ? (
                        <RawNumInput
                          className="w-24"
                          value={numberDrafts[row.id] ?? String(row.value)}
                          emptyValue={Number(row.value) || 0}
                          min={row.min}
                          max={row.max}
                          disabled={busy === row.id}
                          onValueChange={(_n, raw) => setNumberDrafts((d) => ({ ...d, [row.id]: raw }))}
                          onBlur={() => void commitNumberRow(row)}
                          aria-label={row.label}
                        />
                      ) : null}
                      {row.source === "user" && (
                        <button
                          type="button"
                          className="text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-faint)] underline-offset-2 hover:underline"
                          disabled={busy !== null}
                          onClick={() => void saveOne(row.id, null)}
                          title="Clear your override; fall back to env/default"
                        >
                          reset
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
