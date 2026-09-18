"use client";

/** Global chrome, rendered on every console screen:
 *  - word-first account-state banner for NO ACCOUNT / PAPER only
 *  - account scope selector
 *  - run-state × authority chip in plain words
 *  - run-state action: Start/Resume when paused, STOP when running
 *  - Run once (wired; disabled with a reason when blocked)
 *  - data freshness strip */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Check, ChevronDown, LogOut, Monitor, Moon, OctagonMinus, Play, ShieldCheck, SlidersHorizontal, Sun, UserRound } from "lucide-react";
import type { ConnectedAccount } from "@/lib/types";
// llm-required is PURE (no node/server imports — see its header), so its message constants are
// safe to import here: classifyRunFailure matches the server's own 412 summary strings.
import {
  LLM_MODEL_REQUIRED_STRATEGY_MESSAGE,
  LLM_ROTATION_AVAILABILITY_UNAVAILABLE_STRATEGY_MESSAGE,
  LLM_ROTATION_EMPTY_POOL_STRATEGY_MESSAGE
} from "@/lib/llm-required";
import type { DashboardSnapshot } from "../../dashboard-types";
import {
  activeConnectedAccount,
  deriveReality,
  deriveSpend,
  deriveStateInfo,
  realityForAccount
} from "../lib/derive";
import {
  activateAccount,
  ConsoleApiError,
  runOnce,
  setSystemState,
  startStrategy,
  stopEverything
} from "../lib/api";
import { cx, fmtClock, fmtMoney, fmtMoneyWhole, timeAgo, timeUntil, EM_DASH, fmtExact, SENTENCE_GAP } from "../lib/format";
import { loginProviderLabel } from "../lib/labels";
import type { ConsoleStreamHealth } from "../lib/useConsoleData";
import { useConsoleData } from "../lib/useConsoleData";
import { useDirtyActionGuard, useNextUnloadBypass } from "../lib/useDirtyGuard";
import type { ConsoleTheme } from "../lib/useConsoleTheme";
import { useToast } from "../ui/toast";
import { BREAKER_FIRED_NOTE } from "@/lib/guardrail-copy";
import { Btn, Chip, Dot, Meter, TextInput } from "../ui/primitives";
import { Sheet } from "../ui/sheet";

// ── Reality banner ───────────────────────────────────────────────────────────

export function RealityBanner({ snapshot }: { snapshot: DashboardSnapshot }) {
  const reality = deriveReality(snapshot);
  if (reality.tone === "live") return null;
  return (
    <div className={cx("con-reality", `con-reality-${reality.tone}`)}>
      <div className={cx("mx-auto flex max-w-[1400px] items-baseline px-4 py-1.5", reality.tone === "paper" ? "gap-0" : "gap-2")}>
        <span className="con-reality-word text-[length:var(--con-fs-sm)]">{reality.word}</span>
        <span className={cx("font-semibold text-black", reality.tone === "paper" && "whitespace-pre")}>{reality.tone === "paper" ? "  •  " : "•"}</span>
        <span className="font-semibold text-black">{reality.phrase}</span>
        {reality.tone !== "paper" && <span className="hidden truncate text-black sm:inline">— {reality.clarification}</span>}
      </div>
    </div>
  );
}

// ── Account scope selector ───────────────────────────────────────────────────

function brokerName(broker: string | undefined): string {
  switch (broker) {
    case "alpaca":
    case "alpaca-mcp":
      return "Alpaca";
    case "robinhood":
      return "Robinhood";
    case "tradier":
      return "Tradier";
    case "kalshi":
      return "Kalshi";
    case "etoro":
      return "eToro";
    case "public":
      return "Public";
    case "webull":
      return "Webull";
    default:
      return broker ?? "";
  }
}

export function ScopeSelector({ snapshot }: { snapshot: DashboardSnapshot; compact?: boolean }) {
  const toast = useToast();
  const guardAction = useDirtyActionGuard();
  const allowNextUnload = useNextUnloadBypass();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const active = activeConnectedAccount(snapshot);
  // Active account hoisted first, the rest after — same order the switch list
  // reads top-to-bottom. Mirrors the Broker connections settings card.
  const others = snapshot.connectedAccounts.filter((a) => !a.isActive);
  const ordered = active ? [active, ...others] : others;

  const label = active ? active.label || brokerName(active.broker) : "No connected account";
  const activeLast4 = active?.accountNumber ? active.accountNumber.slice(-4) : null;

  const close = () => {
    setOpen(false);
    // Return focus to the trigger so keyboard users aren't dropped at page top.
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  // Escape closes and returns focus to the trigger (menu-button pattern).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
     
  }, [open]);

  const switchTo = async (id: string) => {
    setBusyId(id);
    try {
      await activateAccount(id);
      // Activation changes the server-side scope used by run-state and broker actions. A full reload
      // removes any window where stale Account A UI could remain interactive while the server points
      // at Account B, and remounts every account-scoped editor from B's snapshot.
      allowNextUnload();
      close();
      window.location.reload();
    } catch (error) {
      toast.push("neg", "Could not load account", error instanceof ConsoleApiError ? error.message : undefined);
      setBusyId(null);
    }
  };

  // The whole row is the switch affordance; the loaded account is a non-interactive
  // current-state marker (checkmark, accent tint).
  const renderRow = (account: ConnectedAccount) => {
    const r = realityForAccount(account);
    const policy = snapshot.connectedAccountPolicies?.[account.id];
    const st = policy ? deriveStateInfo(policy) : null;
    const isActive = account.isActive;
    const last4 = account.accountNumber ? account.accountNumber.slice(-4) : null;
    return (
      <button
        key={account.id}
        type="button"
        role="menuitemradio"
        aria-checked={isActive}
        disabled={isActive || busyId !== null}
        onClick={() => guardAction(() => void switchTo(account.id))}
        className={cx(
          "con-scope-row flex w-full items-start gap-2 rounded-control border px-3 py-2 text-left",
          isActive ? "border-[color:var(--con-accent-border)]" : "border-[color:var(--con-line)]"
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[length:var(--con-fs-sm)] font-semibold">
              {account.label || brokerName(account.broker)}
            </span>
            {r.tone !== "live" && <Chip tone={r.tone}>{r.tone === "paper" ? "PAPER" : r.word}</Chip>}
            {st && (
              <Chip tone={st.tone}>
                {st.label.replace(" · market closed", "")}
              </Chip>
            )}
          </span>
          <span className="mt-0.5 flex min-w-0 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            <span className="truncate">{brokerName(account.broker)}</span>
            {last4 && <span className="shrink-0 whitespace-pre">{` — ${last4}`}</span>}
          </span>
        </span>
        <span
          className={cx(
            "flex shrink-0 items-center gap-1 self-center text-[length:var(--con-fs-xs)] font-semibold",
            isActive ? "text-[color:var(--con-accent)]" : "text-[color:var(--con-muted)]"
          )}
        >
          {isActive ? (
            <>
              <Check size={13} /> Loaded
            </>
          ) : busyId === account.id ? (
            "Loading…"
          ) : (
            "Switch"
          )}
        </span>
      </button>
    );
  };

  return (
    // relative wrapper: the dropdown anchors to the trigger's own left edge (the
    // scope sits at the LEFT of the bar, so anchoring here can't overflow off the
    // left the way a right-aligned menu would). flex sizing lives on the wrapper
    // so the trigger fills it. On phones the selector is min-w-0 flex-1: it absorbs
    // exactly the space left by the fixed-width chrome controls (state chip, avatar,
    // run-once, run-state) — never a fixed floor, which would overflow the row on a
    // narrow (≤360px Android) viewport (Codex review, PR #1708). Legibility instead of
    // an "N.." clip comes from the reduced button padding (px-2.5) + truncate: at 360px
    // the leftover is ~73px, enough for "No con…"/the broker name, and it only grows
    // from there. Paired with the tighter mobile gap/padding on the header row (shell.tsx).
    <div className="relative flex-1 min-w-[120px] sm:flex-none sm:min-w-[190px] sm:max-w-[300px]">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-2 overflow-hidden rounded-control border border-[color:var(--con-line-strong)] bg-[color:var(--con-surface-2)] px-2.5 py-1.5 text-left transition-colors hover:border-[color:var(--con-accent)] sm:px-3 con-bar-ctl con-bar-ctl-scope"
        title="Switch which account this console shows"
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 text-[length:var(--con-fs-sm)] font-semibold leading-tight">
            <span className="truncate">{label}</span>
            {activeLast4 && <span className="shrink-0 whitespace-pre">{`   — ${activeLast4}`}</span>}
          </span>
        </span>
        <ChevronDown
          size={14}
          className={cx("mt-0.5 shrink-0 text-[color:var(--con-faint)] transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <>
          {/* invisible click-away backdrop; uses button for iOS Safari / PWA touch compatibility */}
          <button
            type="button"
            aria-label="Close account menu"
            className="fixed inset-0 z-40 h-full w-full cursor-default border-0 bg-transparent opacity-0"
            onClick={close}
          />
          <div
            role="menu"
            aria-label="Account scope"
            className="con-menu-drop absolute left-0 top-[calc(100%+4px)] z-50 flex max-h-[min(70vh,480px)] w-[min(calc(100vw-48px),360px)] max-w-[calc(100vw-48px)] sm:w-[360px] sm:max-w-[360px] flex-col gap-2 overflow-y-auto rounded-card border border-[color:var(--con-line-strong)] bg-[color:var(--con-surface)] p-3 shadow-xl"
          >
            <p className="text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
              One account is loaded at a time. Switching rescopes everything — balances, guardrails, approvals, run
              state, and decision history.
            </p>
            {ordered.length === 0 ? (
              <div className="rounded-control border border-[color:var(--con-line)] p-3 text-[length:var(--con-fs-sm)]">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">No account connected</span>
                  <Chip tone="none">NO ACCOUNT</Chip>
                </div>
                <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                  Connect a broker account before the app can place orders.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">{ordered.map(renderRow)}</div>
            )}
            <div className="my-0.5 h-px bg-[color:var(--con-line)]" />
            <Link
              href="/console/connections#brokers"
              role="menuitem"
              onClick={close}
              className="con-scope-row flex w-full items-center gap-2 rounded-control border border-[color:var(--con-line)] px-3 py-2 text-[length:var(--con-fs-sm)] font-medium"
              title="Add, remove, or reconnect broker accounts"
            >
              <SlidersHorizontal size={14} className="shrink-0 text-[color:var(--con-faint)]" />
              Configure accounts
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

// ── Run-state chip + control sheet (STOP never sells) ────────────────────────

const STATE_TONE: Record<string, "pos" | "warn" | "neg" | "muted"> = {
  pos: "pos",
  warn: "warn",
  neg: "neg",
  muted: "muted"
};

export function StateChip({ snapshot }: { snapshot: DashboardSnapshot }) {
  const [open, setOpen] = useState(false);
  const info = deriveStateInfo(snapshot.policy);
  // On phones the boxed single-line chip read as a second dropdown next to the
  // account selector and crowded the bar (owner report) — below sm it renders
  // unboxed with the state stacked over the authority in smaller type. Desktop
  // keeps the boxed single-line form.
  const [word, mode] = info.label.split(" · ");
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="con-bar-ctl flex shrink-0 items-center gap-2 rounded-control border border-transparent px-1.5 py-1 text-left transition-colors sm:border-[color:var(--con-line-strong)] sm:bg-[color:var(--con-surface-2)] sm:px-3 sm:py-1.5 sm:hover:border-[color:var(--con-accent)]"
        title={info.detail}
      >
        <Dot tone={STATE_TONE[info.tone]} pulse={info.state === "active" && info.marketOpen !== false && snapshot.policy.strategyAuthority === "decide"} />
        <span className="flex flex-col leading-tight sm:flex-row sm:items-center sm:gap-1">
          <span className="whitespace-nowrap text-[length:var(--con-fs-xs)] font-semibold sm:text-[length:var(--con-fs-sm)]">{word}</span>
          {mode && (
            <span className="whitespace-nowrap text-[length:var(--con-fs-2xs)] text-[color:var(--con-muted)] sm:text-[length:var(--con-fs-sm)] sm:font-semibold sm:text-inherit sm:before:content-['·_']">
              {mode}
            </span>
          )}
        </span>
      </button>
      <ControlSheet snapshot={snapshot} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function RunStateButton({ snapshot }: { snapshot: DashboardSnapshot }) {
  const [open, setOpen] = useState(false);
  const state = snapshot.policy.systemState;
  const isStartDirection = state === "halted" || state === "close_only";
  const info = deriveStateInfo(snapshot.policy);
  const label = state === "halted" ? "Start Agent" : state === "close_only" ? "Resume Agent" : "Stop Agent";
  const title =
    info.word === "Paused · market closed"
      ? "The agent is on.  Scheduled runs wait for the next open.  Open this to stop it or change run state."
      : state === "halted"
        ? "Open start options.  Scheduled runs stay off until you confirm Start Agent."
        : state === "close_only"
          ? "Open resume options.  You can resume full operation or change run state."
          : "Stop the agent.  Stopping never sells anything.";
  return (
    <>
      <button
        type="button"
        className={isStartDirection ? "con-start-btn" : "con-stop-btn"}
        onClick={() => setOpen(true)}
        title={title}
        aria-label={label}
      >
        {isStartDirection ? <Play size={15} /> : <OctagonMinus size={15} />}
        <span className="con-run-state-label">{label}</span>
      </button>
      <ControlSheet snapshot={snapshot} open={open} onClose={() => setOpen(false)} emergency={!isStartDirection} />
    </>
  );
}

/** One control surface for run-state changes. Friction is reserved for what SELLS or halts
 *  the world: stopping = one tap + one confirm; winding down (the one stop verb that SELLS) =
 *  typed ritual. Starting scheduled runs is ONE TAP for every account — a live broker account
 *  is the app's normal, in-domain case, not a scary exception that needs a typed ritual. */
function ControlSheet({
  snapshot,
  open,
  onClose,
  emergency
}: {
  snapshot: DashboardSnapshot;
  open: boolean;
  onClose: () => void;
  emergency?: boolean;
}) {
  const { refresh } = useConsoleData();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [armText, setArmText] = useState("");
  const [confirmVerb, setConfirmVerb] = useState<"start" | "liquidate" | null>(null);
  const reality = deriveReality(snapshot);
  const info = deriveStateInfo(snapshot.policy);
  const state = snapshot.policy.systemState;

  const startLabel = state === "close_only" ? "Resume Agent" : "Start Agent";
  const startGerund = state === "close_only" ? "Resuming" : "Starting";
  const startProgressLabel = `${startGerund}…`;
  const liquidatePhrase = "WIND DOWN";
  const sheetTitle = emergency
    ? "Stop Agent"
    : state === "halted"
      ? "Start Agent"
      : state === "close_only"
        ? "Resume or Change Run State"
        : "Change Agent";

  const act = async (verb: string, fn: () => Promise<unknown>, successTitle: string, successDetail?: string) => {
    setBusy(verb);
    try {
      await fn();
      await refresh();
      toast.push(verb === "stop" ? "warn" : "info", successTitle, successDetail);
      setConfirmVerb(null);
      setArmText("");
      onClose();
    } catch (error) {
      toast.push("neg", "That didn't go through", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const options = useMemo(() => {
    const startOption = {
      id: "start",
      title: state === "halted" ? "Start scheduled runs" : "Resume full operation",
      body:
        snapshot.policy.strategyAuthority === "decide"
          ? "Runs resume on schedule and the strategy may place orders itself, inside your guardrails."
          : "Runs resume on schedule. Every trade still waits for your approval.",
      available: state !== "active",
      danger: false
    };
    const stopOption = {
        id: "stop",
        title: "STOP everything",
        body:
          "Nothing buys, nothing sells — not even this app's automatic stop-losses, which pause too. Broker-held brackets keep resting at your broker. Your positions stay exactly as they are. Nothing is sold.",
        available: state !== "halted",
        danger: true
    };
    const closeOnlyOption = {
        id: "close_only",
        title: "Exit-only",
        body:
          "No new buys. Protective sells and the app's stop monitor keep working. This is what the automatic circuit breakers choose.",
        available: state !== "close_only",
        danger: false
    };
    const liquidatingOption = {
        id: "liquidating",
        title: "Wind Down",
        body:
          "The strategy sells positions until the account is in cash. This SELLS things — it may realize losses and taxes.",
        available: state !== "liquidating",
        danger: true
    };

    if (state === "halted") {
      return [startOption, closeOnlyOption, liquidatingOption];
    }
    if (state === "close_only") {
      return [startOption, stopOption, liquidatingOption];
    }
    if (state === "liquidating") {
      return [stopOption, startOption, closeOnlyOption];
    }
    return [stopOption, closeOnlyOption, liquidatingOption];
  }, [state, snapshot.policy.strategyAuthority]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={sheetTitle}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[length:var(--con-fs-sm)]">
        {reality.tone !== "live" && (
          <Chip tone={reality.tone}>
            {reality.word} · {reality.phrase}
          </Chip>
        )}
        <span className="text-[color:var(--con-muted)]">
          Now: <strong className="text-[color:var(--con-fg)]">{info.label}</strong>
        </span>
      </div>
      <p className="mb-4 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
        {info.detail}
        {info.word === "Paused · market closed"
          ? "  Stop Agent turns scheduled autonomy off.  The market being closed is not the same as the agent being stopped."
          : ""}
      </p>

      <div className="flex flex-col gap-2.5">
        {options
          .filter((o) => o.available)
          .map((o) => (
            <div key={o.id} className="rounded-control border border-[color:var(--con-line)] p-3">
              <div className="flex items-center justify-between gap-3">
                <span className={cx("font-semibold", o.id === "stop" && "text-[color:var(--con-neg)]")}>{o.title}</span>
                {o.id === "stop" && (
                  <Btn variant="danger" size="sm" disabled={busy !== null} onClick={() => void act("stop", stopEverything, "Stopped", "Nothing was sold. App-managed stops are paused; broker-held brackets keep resting.")}>
                    {busy === "stop" ? "Stopping…" : "Confirm: STOP"}
                  </Btn>
                )}
                {o.id === "close_only" && (
                  <Btn variant="outline" size="sm" disabled={busy !== null} onClick={() => void act("close_only", () => setSystemState("close_only", snapshot.policy.connectedAccountId), "Exit-only", "No new buys. Protective exits keep working.")}>
                    {busy === "close_only" ? "Switching…" : "Confirm"}
                  </Btn>
                )}
                {o.id === "liquidating" && (
                  <Btn variant="dangerOutline" size="sm" disabled={busy !== null} onClick={() => setConfirmVerb(confirmVerb === "liquidate" ? null : "liquidate")}>
                    Wind Down…
                  </Btn>
                )}
                {o.id === "start" && (
                  <Btn variant="pos" size="sm" disabled={busy !== null} onClick={() => void act("start", startStrategy, "Running", "Scheduled runs are on.")}>
                    {busy === "start" ? startProgressLabel : startLabel}
                  </Btn>
                )}
              </div>
              <p className="mt-1.5 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">{o.body}</p>

              {o.id === "liquidating" && confirmVerb === "liquidate" && (
                <TypedConfirm
                  phrase={liquidatePhrase}
                  value={armText}
                  onChange={setArmText}
                  busy={busy === "liquidating"}
                  confirmLabel="Wind Down — this sells"
                  variant="danger"
                  onConfirm={() =>
                    void act("liquidating", () => setSystemState("liquidating", snapshot.policy.connectedAccountId), "Winding down", "Only sell orders until the account is in cash.")
                  }
                />
              )}
            </div>
          ))}
      </div>
    </Sheet>
  );
}

export function TypedConfirm({
  phrase,
  value,
  onChange,
  onConfirm,
  busy,
  confirmLabel,
  variant = "danger",
  note
}: {
  phrase: string;
  value: string;
  onChange: (v: string) => void;
  onConfirm: () => void;
  busy?: boolean;
  confirmLabel: ReactNode;
  /** "danger" only for DESTRUCTIVE confirms (wind-down/sells). Commit/arm
   *  rituals use "primary" — the typed word is the friction, not the color. */
  variant?: "danger" | "pos" | "primary";
  note?: string;
}) {
  const inputId = useId();
  const matches = value.trim().toUpperCase() === phrase;
  // Only a destructive confirm gets the red frame; other typed rituals use the
  // caution (warn) tint so red stays reserved for reality/STOP/destruction.
  const frameClass =
    variant === "danger"
      ? "border-[color:var(--con-live-border)] bg-[color:var(--con-live-soft)]"
      : "border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)]";
  return (
    <div className={cx("mt-3 rounded-control border p-3", frameClass)}>
      {note && <p className="mb-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">{note}</p>}
      <label className="con-label" htmlFor={inputId}>
        Type exactly: <span className="con-mono text-[color:var(--con-fg)]">{phrase}</span>
      </label>
      <div className="flex gap-2">
        <TextInput
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          onPaste={(e) => e.preventDefault()}
          placeholder={phrase}
          className="con-mono"
        />
        <Btn variant={variant} disabled={!matches || busy} onClick={onConfirm}>
          {busy ? "Working…" : confirmLabel}
        </Btn>
      </div>
    </div>
  );
}

// ── Run once ─────────────────────────────────────────────────────────────────

/** Why a manual run can't go ahead, plus where to fix it. Shown in a sheet —
 *  never buried in a disabled button's hover tooltip (useless on mobile). */
interface RunBlock {
  title: string;
  detail: string;
  /** Extra honest context (e.g. what Stopped really pauses). */
  note?: string;
  fixHref?: string;
  fixLabel?: string;
}

/** Pre-flight blocks the snapshot already knows about, before any request.
 *  Exported so the Guardrails Autonomy surface can show the same “why can’t I run?”
 *  copy without inventing a second readiness path. */
export function deriveRunBlock(snapshot: DashboardSnapshot): RunBlock | null {
  if (snapshot.llmConfigured === false) {
    return {
      title: "No LLM key is configured",
      detail:
        "Proposal generation is LLM-driven, so a manual run needs a working LLM provider key. Market data, positions, and guardrails all work without one — only runs and chat are gated.",
      fixHref: "/console/connections#api-keys",
      fixLabel: "Open Connections → API keys"
    };
  }
  if (snapshot.accountReadiness && !snapshot.accountReadiness.ok) {
    return {
      title: snapshot.accountReadiness.reason ?? "The account isn't ready to run",
      detail: snapshot.accountReadiness.detail,
      fixHref: "/console/connections#brokers",
      fixLabel: "Open Connections → Broker accounts"
    };
  }
  return null;
}

/** Map a refusal from POST /api/strategy/run (412 LLM gate, 400 failed run)
 *  onto a reason + the screen that fixes it. Matching is on the server's own
 *  summary strings (src/lib/strategy.ts / llm-required.ts). */
function classifyRunFailure(message: string, status?: number): RunBlock {
  const m = message.toLowerCase();
  // A 412 fires for two DIFFERENT reasons the sheet must not conflate: the team-model CHOICE is
  // missing (LLM_MODEL_REQUIRED_STRATEGY_MESSAGE — fix under the model pickers), or a provider KEY
  // is missing (everything else — fix under API keys). Titling a model-choice refusal "No LLM key
  // is configured" sent the owner hunting through API keys that were fine — match the choice
  // message FIRST, on the server's own string.
  if (m.includes(LLM_ROTATION_AVAILABILITY_UNAVAILABLE_STRATEGY_MESSAGE.toLowerCase())) {
    return {
      title: "Rotation Couldn't Check Models",
      detail: message,
      fixHref: "/console/strategy#models",
      fixLabel: "Open Strategy → Models"
    };
  }
  if (m.includes(LLM_ROTATION_EMPTY_POOL_STRATEGY_MESSAGE.toLowerCase())) {
    return {
      title: "Rotation has no keyed model to serve",
      detail: message,
      fixHref: "/console/connections#api-keys",
      fixLabel: "Open Connections → API keys"
    };
  }
  if (m.includes(LLM_MODEL_REQUIRED_STRATEGY_MESSAGE.toLowerCase())) {
    return {
      title: "Choose your team models",
      detail: message,
      fixHref: "/console/strategy#models",
      fixLabel: "Open Strategy → Models"
    };
  }
  if (status === 412 || m.includes("llm provider") || m.includes("llm key") || m.includes("provider key")) {
    return {
      title: "No LLM key is configured",
      detail: message,
      fixHref: "/console/connections#api-keys",
      fixLabel: "Open Connections → API keys"
    };
  }
  if (m.includes("kill switch")) {
    return {
      title: "A circuit breaker is holding new entries",
      detail: message,
      note: BREAKER_FIRED_NOTE,
      fixHref: "/console/guardrails",
      fixLabel: "Review Guardrails"
    };
  }
  if (m.includes("halted") || m.includes("stopped")) {
    return {
      title: "The system is stopped",
      detail: `${message} Start it (or switch to Exit-only) from the run-state chip in the top bar.`,
      note:
        "While stopped, nothing buys or sells — and this app's automatic stop-losses are paused too. Broker-held brackets keep resting at your broker."
    };
  }
  if (m.includes("already in progress")) {
    return {
      title: "A run is already in progress",
      detail: `${message} Wait for it to finish — Activity shows it as it happens.`,
      fixHref: "/console/activity?tab=runs",
      fixLabel: "Open Strategy Runs"
    };
  }
  if (m.includes("budget")) {
    return {
      title: "The daily LLM budget is used up",
      detail: message,
      note: "The budget ceiling lives in the strategy's tuning settings. Raising it raises what a day of runs can cost.",
      fixHref: "/console/strategy",
      fixLabel: "Open Strategy"
    };
  }
  if (m.includes("account")) {
    return {
      title: "Account problem",
      detail: message,
      fixHref: "/console/connections#brokers",
      fixLabel: "Open Connections → Broker accounts"
    };
  }
  return {
    title: "The run failed",
    detail: message,
    fixHref: "/console/activity?tab=alerts",
    fixLabel: "See the full story in Alerts Center"
  };
}

export function RunOnceButton({
  snapshot,
  size,
  iconOnly
}: {
  snapshot: DashboardSnapshot;
  size?: "sm";
  /** Icon-only rendering for the phone chrome bar, where the full label doesn't fit
   *  but the hero's "Run once" call-to-action still needs a reachable control. */
  iconOnly?: boolean;
}) {
  const { refresh } = useConsoleData();
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [block, setBlock] = useState<RunBlock | null>(null);

  const preflight = deriveRunBlock(snapshot);

  const run = useCallback(async () => {
    // Blocked runs still respond to the click: they open the "why" sheet with
    // the route to the fix, instead of being a dead disabled button.
    if (preflight) {
      setBlock(preflight);
      return;
    }
    setRunning(true);
    try {
      const result = await runOnce();
      await refresh();
      if (result.status === "failed") {
        setBlock(classifyRunFailure(result.summary || "The run failed."));
      } else if (result.status === "started" || result.status === "queued") {
        // The route persisted the run and returned before it finished (real runs can take several
        // minutes on LLM-heavy steps) — reflect queued/started, not complete. Activity/snapshot
        // polling already renders the strategy_runs row this created as it progresses.
        toast.push("pos", "Run started", result.summary || "Check Activity for progress.");
      } else {
        toast.push("pos", "Run complete", result.summary);
      }
    } catch (error) {
      if (error instanceof ConsoleApiError) {
        setBlock(classifyRunFailure(error.message, error.status));
      } else {
        setBlock(classifyRunFailure(String(error)));
      }
      void refresh();
    } finally {
      setRunning(false);
    }
  }, [preflight, refresh, toast]);

  useEffect(() => {
    const onRunOnce = () => {
      void run();
    };
    window.addEventListener("console:run-once", onRunOnce);
    return () => window.removeEventListener("console:run-once", onRunOnce);
  }, [run]);

  return (
    <>
      <Btn
        // iconOnly (phone chrome bar) sits directly beside the filled/soft-green
        // Start button with no text label of its own — a solid primary fill there
        // read as a second, ambiguous "start" control (owner report). Outline keeps
        // it reachable and clearly actionable without competing with Start as a
        // second primary-looking CTA. The labeled desktop button keeps its filled look.
        variant={iconOnly ? "outline" : "primary"}
        size={size}
        disabled={running}
        onClick={() => void run()}
        aria-label={iconOnly ? (running ? "Running…" : "Run Once") : undefined}
        title={
          preflight
            ? `Blocked: ${preflight.title}. Click to see why and where to fix it.`
            : "Manual runs always ask first — they can only propose, never place on their own."
        }
      >
        {/* Emoji bolt, not lucide Zap (owner preference 2026-08-08 — the colored emoji
            reads better than the line icon). Still not Play: Start/Resume owns Play. */}
        <span aria-hidden className="text-[13px] leading-none">⚡</span>
        {iconOnly ? null : running ? "Running…" : "Run Once"}
      </Btn>

      <Sheet open={block !== null} onClose={() => setBlock(null)} title="Run Once Can't Go Ahead">
        {block && (
          <div className="flex flex-col gap-3 text-[length:var(--con-fs-sm)]">
            <div className="flex items-center gap-2">
              <Chip tone="warn">blocked</Chip>
              <span className="font-semibold">{block.title}</span>
            </div>
            <p className="leading-relaxed text-[color:var(--con-muted)]">{block.detail}</p>
            {block.note && (
              <p className="rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
                {block.note}
              </p>
            )}
            {block.fixHref && (
              <Link
                href={block.fixHref}
                onClick={() => setBlock(null)}
                className="con-btn con-btn-primary self-start"
                title="Takes you straight to the screen where this is fixed."
              >
                {block.fixLabel ?? "Go to the fix"}
              </Link>
            )}
            <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              Manual runs always ask first — they can only propose, never place on their own.
            </p>
          </div>
        )}
      </Sheet>
    </>
  );
}

// ── Signed-in identity + sign out ────────────────────────────────────────────

// Labels removed since we don't cycle anymore
const THEME_WORD: Record<ConsoleTheme, string> = { system: "System", dark: "Dark", light: "Light" };

function Avatar({ imageUrl, size, iconSize }: { imageUrl?: string; size: string; iconSize: number }) {
  // Google/GitHub profile photo when the session has one (imageUrl comes from
  // the Auth.js session via snapshot.currentUser); generic icon otherwise.
  // no-referrer: googleusercontent 403s avatar requests with a referrer.
  return imageUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- external avatar host; next/image needs remotePatterns per provider
    <img
      src={imageUrl}
      alt=""
      referrerPolicy="no-referrer"
      style={{ width: "100%", height: "100%", maxWidth: "100%", maxHeight: "100%", objectFit: "cover" }}
      className={cx(size, "shrink-0 block rounded-[inherit]")}
    />
  ) : (
    <UserRound size={iconSize} />
  );
}

/** Profile menu: a slide-DOWN dropdown anchored under the header button — NOT a
 *  bottom sheet, which the fixed mobile tab bar covered (sign out was
 *  unreachable on phones). Holds identity, the theme control (moved off the
 *  bar), and sign out. Button is a 44px target on phones and shows the
 *  provider avatar when the session has one. */
export function UserMenu({
  snapshot,
  theme,
  setTheme
}: {
  snapshot: DashboardSnapshot;
  theme: ConsoleTheme;
  setTheme: (theme: ConsoleTheme) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const user = snapshot.currentUser;

  const close = () => {
    setOpen(false);
    // Return focus to the trigger so keyboard users land back on the button.
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
     
  }, [open]);

  // No session identity (single-user/local operation) → nothing to sign out of.
  if (!user) return null;

  const who = user.name ?? user.email ?? user.userId;

  return (
    // Not position:relative — the dropdown anchors to the bar row (the nearest
    // positioned ancestor, set in shell.tsx) so it hugs the viewport-right edge
    // instead of overflowing left off small screens.
    <div className="shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        title={`Signed in as ${user.email ?? who}. Click for account, theme, and sign out.`}
        aria-label={`Signed in as ${user.email ?? who} — account menu`}
        aria-expanded={open}
        aria-haspopup="menu"
        className="con-bar-ctl flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-control border border-[color:var(--con-line-strong)] text-[color:var(--con-muted)] transition-colors hover:border-[color:var(--con-accent)] hover:text-[color:var(--con-accent)]"
      >
        <Avatar imageUrl={user.imageUrl} size="h-full w-full" iconSize={15} />
      </button>

      {open && (
        <>
          {/* invisible click-away backdrop; the panel sits above it */}
          <div className="fixed inset-0 z-40" onClick={close} aria-hidden />
          <div className="con-menu-drop absolute right-2 top-[calc(100%+2px)] z-50 w-[min(92vw,340px)] rounded-card border border-[color:var(--con-line-strong)] bg-[color:var(--con-surface)] p-4 shadow-xl">
            <div className="flex flex-col gap-3 text-[length:var(--con-fs-sm)]">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[color:var(--con-line)] text-[color:var(--con-muted)]">
                  <Avatar imageUrl={user.imageUrl} size="h-full w-full" iconSize={18} />
                </span>
                <div className="min-w-0">
                  <div className="truncate font-semibold">{who}</div>
                  {user.email && user.name && <div className="truncate text-[color:var(--con-muted)]">{user.email}</div>}
                  <div className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                    {user.loginProvider ? `Signed in via ${loginProviderLabel(user.loginProvider)}` : "Signed in"}
                    {user.isAdmin ? " · operator/admin rights" : ""}
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-control border border-[color:var(--con-line)] px-3 py-2">
                <span className="text-[color:var(--con-muted)]">Theme</span>
                <div className="flex items-center gap-1 rounded-control border border-[color:var(--con-line-strong)] bg-[color:var(--con-bg)] p-0.5">
                  {(["light", "dark", "system"] as const).map((t) => {
                    const active = theme === t;
                    const Icon = t === "dark" ? Moon : t === "light" ? Sun : Monitor;
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setTheme(t)}
                        title={THEME_WORD[t]}
                        aria-label={`Set theme to ${THEME_WORD[t]}`}
                        className={cx(
                          "con-theme-btn flex items-center gap-1.5 rounded-control px-2.5 py-1 text-[length:var(--con-fs-xs)] transition-colors",
                          active
                            ? "bg-[color:var(--con-surface)] text-[color:var(--con-fg)] font-medium shadow-sm border border-[color:var(--con-line)]"
                            : "text-[color:var(--con-muted)] hover:text-[color:var(--con-fg)] border border-transparent"
                        )}
                      >
                        <Icon size={13} />
                        {THEME_WORD[t]}
                      </button>
                    );
                  })}
                </div>
              </div>
              <p className="text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-faint)]">
                Signing out only ends this browser session. The strategy keeps its current run state on the server —
                it does not stop, start, or sell anything.
              </p>
              <div className="flex items-center gap-2">
                {/* Operator-only admin portal entry — the phone-reachable twin of the
                    desktop chrome's Admin link (the chrome bar has no room on phones). */}
                {user.isAdmin && (
                  <a
                    href="/admin"
                    className="con-btn con-btn-outline"
                    title="Admin portal — operator diagnostics: connections, LLM spend, RAG coverage, server."
                  >
                    <ShieldCheck size={14} />
                    Admin portal
                  </a>
                )}
                {/* Server route: clears the Auth.js session cookies and redirects to /login. */}
                <a
                  href="/logout"
                  className="con-btn con-btn-outline"
                  title="End this browser session and return to the sign-in page. Does not change the strategy's run state."
                >
                  <LogOut size={14} />
                  Sign out
                </a>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Freshness strip ──────────────────────────────────────────────────────────

/** Freshness label shared by the desktop strip and the mobile bar: "delayed"
 *  while the last refresh errored, "loading" before the first fetch lands,
 *  "aging" while the push stream is reconnecting, otherwise "fresh". */
function deriveFreshnessLabel(fetchedAt: Date | null, error: string | null, stream: ConsoleStreamHealth): string {
  return error ? "delayed"
    : fetchedAt == null ? "loading"
    : stream.status === "reconnecting" ? "aging"
    : "fresh";
}

/** Compact one-line freshness + today's spend, rendered in the STICKY TOP
 *  chrome (below ChromeBar) on phones — the fixed bottom tab bar (nav.tsx)
 *  overlays anything at document end there, so a bottom-anchored strip is
 *  invisible on mobile. This is the only mobile freshness surface; the
 *  desktop-only FreshnessStrip below no longer renders a mobile variant. */
function OfflineBanner() {
  return (
    <span className="shrink-0 font-semibold text-[color:var(--con-warn)]">
      You’re offline.{SENTENCE_GAP}Showing the last snapshot.
    </span>
  );
}

export function MobileFreshnessBar({
  snapshot,
  fetchedAt,
  error,
  stream,
  online = true
}: {
  snapshot: DashboardSnapshot;
  fetchedAt: Date | null;
  error: string | null;
  stream: ConsoleStreamHealth;
  online?: boolean;
}) {
  const spend = deriveSpend(snapshot);
  const freshnessLabel = deriveFreshnessLabel(fetchedAt, error, stream);
  // PR-E3: when healthy, collapse to one short line (Fresh · Today) instead of
  // repeating clock + label + spend + delayed chip. Unhealthy keeps the detail.
  const healthy = online && !error && freshnessLabel === "fresh" && fetchedAt != null;
  return (
    <div className="flex items-center gap-3 border-t border-[color:var(--con-line)] bg-[color:var(--con-surface)] px-4 py-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)] lg:hidden">
      {healthy ? (
        <span
          className="flex min-w-0 flex-1 items-center gap-2 truncate"
          title={`Data as of ${fmtClock(fetchedAt)}. Refreshes about every 15 seconds. Opening orders only for the daily cap.`}
        >
          <span>Fresh</span>
          <span aria-hidden>·</span>
          <span className="con-num inline-flex items-center gap-1.5">
            <ShieldCheck size={12} />
            Deployed today: {fmtMoney(spend.usedNotional)}
          </span>
        </span>
      ) : (
        <>
          <span title="When this console last fetched data. It refreshes about every 15 seconds.">
            Data as of {fetchedAt ? fmtClock(fetchedAt) : EM_DASH} · {freshnessLabel}
          </span>
          <span className="con-num ml-auto flex items-center gap-1.5" title="Opening orders only. Exits never consume the daily cap.">
            <ShieldCheck size={12} />
            Deployed today: {fmtMoney(spend.usedNotional)}
          </span>
          {!online && <OfflineBanner />}
          {error && (
            <span className="shrink-0 font-semibold text-[color:var(--con-warn)]" title={error}>
              delayed
            </span>
          )}
        </>
      )}
    </div>
  );
}

export function FreshnessStrip({
  snapshot,
  fetchedAt,
  error,
  stream,
  online = true
}: {
  snapshot: DashboardSnapshot;
  fetchedAt: Date | null;
  error: string | null;
  stream: ConsoleStreamHealth;
  online?: boolean;
}) {
  const spend = deriveSpend(snapshot);
  const scanAt = snapshot.latestStrategyRun?.marketScan?.generatedAt;
  const nextRun = snapshot.scheduler?.nextRunAt;
  const freshnessLabel = deriveFreshnessLabel(fetchedAt, error, stream);
  const streamLabel =
    stream.status === "live"
      ? "stream live"
      : stream.status === "connecting"
        ? "stream connecting"
        : stream.status === "reconnecting"
          ? "stream reconnecting"
          : "polling only";
  const streamTitle =
    stream.status === "live"
      ? `Connected ${stream.connectedAt ? fmtExact(stream.connectedAt.toISOString()) : "recently"}${stream.lastEventType ? `; last push ${stream.lastEventType}${stream.lastEventAt ? ` at ${fmtExact(stream.lastEventAt.toISOString())}` : ""}` : ""}.`
      : stream.status === "reconnecting"
        ? `The push stream hit an error${stream.lastErrorAt ? ` at ${fmtExact(stream.lastErrorAt.toISOString())}` : ""}; EventSource will retry automatically while polling continues.`
        : stream.status === "connecting"
          ? "Opening the push stream now."
          : "This browser does not expose EventSource, so the console is using polling only.";
  return (
    // Desktop only — the mobile equivalent is MobileFreshnessBar, rendered in
    // the sticky TOP chrome (shell.tsx) instead of a bottom-anchored strip,
    // since the fixed bottom tab bar (nav.tsx) overlays anything at document
    // end on phones.
    <div className="hidden border-t border-[color:var(--con-line)] bg-[color:var(--con-surface)] text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)] lg:block">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5">
        <span title="When this console last fetched data. It refreshes about every 15 seconds.">
          Data as of {fetchedAt ? fmtClock(fetchedAt) : EM_DASH} · {freshnessLabel} · quotes may be delayed
        </span>
        <span title={streamTitle}>{streamLabel}</span>
        {stream.lastEventAt && stream.lastEventType && <span title={fmtExact(stream.lastEventAt.toISOString())}>Push {stream.lastEventType} {timeAgo(stream.lastEventAt.toISOString())}</span>}
        {scanAt && <span title={fmtExact(scanAt)}>Scan {timeAgo(scanAt)}</span>}
        {snapshot.marketSession && <span>Market: {snapshot.marketSession}</span>}
        {nextRun && snapshot.policy.systemState === "active" && <span title={fmtExact(nextRun)}>Next run {timeUntil(nextRun)}</span>}
        <span className="con-num flex min-w-32 items-center gap-2" title="Opening orders only. Exits never consume the daily cap.">
          <ShieldCheck size={12} />
          Deployed today: {fmtMoney(spend.usedNotional)}
          {typeof spend.capNotional === "number" ? ` of ${fmtMoneyWhole(spend.capNotional)}` : ""}
          <Meter value={spend.usedNotional} max={spend.capNotional} className="w-16" label="Deployed today" />
        </span>
        {!online && <OfflineBanner />}
        {error && (
          <span className="font-semibold text-[color:var(--con-warn)]" title={error}>
            refresh failing — showing last good data
          </span>
        )}
      </div>
    </div>
  );
}
