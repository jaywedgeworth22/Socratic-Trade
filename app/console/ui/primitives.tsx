"use client";

/** Console UI primitives. Own design system — no imports from app/ui/*. */

import { useState, useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cx, fmtExact, timeAgo, EM_DASH } from "../lib/format";
import { isInteractiveTooltipTrigger } from "../lib/tooltip-trigger";
import { AnimatePresence, motion } from "motion/react";

export { isInteractiveTooltipTrigger } from "../lib/tooltip-trigger";

// ── Card ─────────────────────────────────────────────────────────────────────


export function Card({
  title,
  action,
  children,
  className,
  padded = true,
  collapsible = false,
  defaultOpen = true
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  padded?: boolean;
  /** Render the card as a collapsible disclosure (native <details>) with the title as the
   *  summary and a chevron. Requires a title. Off by default so existing cards are unchanged. */
  collapsible?: boolean;
  /** Initial open state when collapsible. Defaults to open so nothing is hidden on first load. */
  defaultOpen?: boolean;
}) {
  if (collapsible && title) {
    return (
      <details className={cx("con-card con-disclosure", className)} open={defaultOpen}>
        <summary className="focus:outline-none">
          {/* Open: pt-3.5 pb-1 (tight bottom toward body). Collapsed: balanced
              py via .con-disclosure.con-card:not([open]) in console.css so
              one-line titles like "You're set" sit vertically centered. */}
          <div className="flex items-center gap-3 px-4 pt-3.5 pb-1">
            <span className="con-card-title">{title}</span>
            {action && (
              <span className="ml-auto" onClick={(e) => e.preventDefault()}>{action}</span>
            )}
            <span className={cx("con-disclosure-label", !action && "ml-auto")} />
          </div>
        </summary>
        <div className={padded ? "px-4 pb-4 pt-2" : undefined}>{children}</div>
      </details>
    );
  }
  return (
    <section className={cx("con-card", className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-1">
          {title ? <h2 className="con-card-title">{title}</h2> : <span />}
          {action}
        </header>
      )}
      <div className={padded ? "px-4 pb-4 pt-2" : undefined}>{children}</div>
    </section>
  );
}

// ── Button ───────────────────────────────────────────────────────────────────

export type BtnVariant = "primary" | "outline" | "ghost" | "danger" | "dangerOutline" | "pos";

const BTN_CLASS: Record<BtnVariant, string> = {
  primary: "con-btn-primary",
  outline: "con-btn-outline",
  ghost: "con-btn-ghost",
  danger: "con-btn-danger",
  dangerOutline: "con-btn-danger-outline",
  pos: "con-btn-pos"
};

export function Btn({
  variant = "outline",
  size,
  className,
  type = "button",
  title,
  align,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm"; align?: "center" | "left" | "right" }) {
  const button = (
    <button
      type={type}
      className={cx("con-btn", BTN_CLASS[variant], size === "sm" && "con-btn-sm", className)}
      {...rest}
    />
  );
  if (title) {
    return <Tooltip content={title} align={align}>{button}</Tooltip>;
  }
  return button;
}

export function IconButton({
  label,
  className,
  type = "button",
  align,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; align?: "center" | "left" | "right" }) {
  const button = (
    <button
      type={type}
      aria-label={label}
      className={cx(
        "inline-flex h-8 w-8 items-center justify-center rounded-[var(--con-radius-sm)] border border-[color:var(--con-line-strong)] bg-[color:var(--con-surface)] text-[color:var(--con-muted)] transition-colors hover:text-[color:var(--con-fg)] hover:bg-[color:var(--con-surface-2)] disabled:opacity-45 disabled:cursor-not-allowed",
        className
      )}
      {...rest}
    />
  );
  return <Tooltip content={label} align={align}>{button}</Tooltip>;
}

// ── Chip ─────────────────────────────────────────────────────────────────────

export type ChipTone = "muted" | "accent" | "pos" | "neg" | "warn" | "info" | "none" | "paper" | "live";

/** Single source of truth for tone -> CSS custom-property color. CHIP_CLASS, the status
 *  Dot, and the inline Stat/SignedText color ternaries all derive their tone set from this
 *  one map, so adding a new tone is one edit here instead of three. */
export const TONE_VAR: Record<ChipTone, string> = {
  muted: "var(--con-faint)",
  accent: "var(--con-accent)",
  pos: "var(--con-pos)",
  neg: "var(--con-neg)",
  warn: "var(--con-warn)",
  info: "var(--con-info)",
  none: "var(--con-none)",
  paper: "var(--con-paper)",
  // Accent, not --con-live red: .con-chip-live (console.css) deliberately renders the
  // live state in the accent tint — live trading is this app's normal state, not an
  // alarm. Dots and chip fallbacks must agree with the chip class.
  live: "var(--con-accent)"
};

const CHIP_CLASS: Record<ChipTone, string | undefined> = Object.fromEntries(
  (Object.keys(TONE_VAR) as ChipTone[]).map((tone) => [tone, tone === "muted" ? undefined : `con-chip-${tone}`])
) as Record<ChipTone, string | undefined>;

export function Chip({
  tone = "muted",
  className,
  title,
  align,
  children
}: {
  tone?: ChipTone;
  className?: string;
  title?: string;
  align?: "center" | "left" | "right";
  children: ReactNode;
}) {
  const chip = (
    <span className={cx("con-chip", CHIP_CLASS[tone], className)}>
      {children}
    </span>
  );
  // Only pay for the Tooltip (state + effects) when there's actually a title —
  // matches the Btn pattern above and avoids per-chip hook overhead in lists.
  if (title) {
    return <Tooltip content={title} align={align}>{chip}</Tooltip>;
  }
  return chip;
}

/** Small brokerage-confirmation tag for actions that still use the server's
 *  typed confirmation contract. Function name stays stable for existing call
 *  sites, but the visible label avoids treating normal brokerage accounts as an
 *  emergency state. */
export function LiveTag() {
  return <span className="con-live-tag">BROKER</span>;
}

// ── Status dot ───────────────────────────────────────────────────────────────

export function Dot({ tone = "muted", pulse }: { tone?: keyof typeof TONE_VAR; pulse?: boolean }) {
  return <span className={cx("con-dot", pulse && "con-dot-pulse")} style={{ background: TONE_VAR[tone] ?? TONE_VAR.muted }} aria-hidden />;
}

// ── Meter ────────────────────────────────────────────────────────────────────

export function Meter({
  value,
  max,
  className,
  label
}: {
  value: number;
  max?: number;
  className?: string;
  /** Accessible name for the progressbar. Required for AT; the visible caption sits beside the bar. */
  label?: string;
}) {
  const hasMax = typeof max === "number" && Number.isFinite(max) && max > 0;
  const rawRatio = hasMax ? Math.max(0, value / max!) : 0;
  const ratio = Math.min(1, rawRatio);
  // At-cap and over-cap used to render identically (both clamp to a solid 100% fill) —
  // a breach gets a hatched pattern + the overage surfaced in a title tooltip / aria-valuetext
  // so it doesn't rely on the red tint alone to signal "this is over the limit, not just full".
  const breached = hasMax && rawRatio > 1;
  const overagePct = breached ? Math.round((rawRatio - 1) * 100) : undefined;
  const tone = ratio >= 0.95 ? "con-meter-neg" : ratio >= 0.75 ? "con-meter-warn" : undefined;
  return (
    <div
      className={cx("con-meter", tone, className)}
      role="progressbar"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemax={hasMax ? max : undefined}
      aria-valuetext={breached ? `${overagePct}% over` : undefined}
      title={breached ? `+${overagePct}% over` : undefined}
    >
      <div
        style={
          breached
            ? {
                width: "100%",
                backgroundImage:
                  "repeating-linear-gradient(135deg, var(--con-neg) 0px, var(--con-neg) 4px, var(--con-warn) 4px, var(--con-warn) 8px)"
              }
            : { width: `${hasMax ? ratio * 100 : 0}%` }
        }
      />
    </div>
  );
}

// ── Stat (label + big number) ────────────────────────────────────────────────

export function Stat({
  label,
  value,
  sub,
  tone,
  title
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "pos" | "neg" | "muted";
  title?: string;
}) {
  const color = tone && tone !== "muted" ? TONE_VAR[tone] : undefined;
  return (
    <Tooltip content={title} className="block">
      <div>
        <div className="con-card-title">{label}</div>
        <div className="con-num mt-1 text-[length:var(--con-fs-xl)] font-semibold leading-tight" style={color ? { color } : undefined}>
          {value}
        </div>
        {sub !== undefined && <div className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">{sub}</div>}
      </div>
    </Tooltip>
  );
}

// ── Form controls ────────────────────────────────────────────────────────────

export function Field({ label, hint, children, htmlFor }: { label: ReactNode; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div>
      <label className="con-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">{hint}</p>}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx("con-input", props.className)} />;
}

export function NumInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="number" inputMode="decimal" {...props} className={cx("con-input con-input-num", props.className)} />;
}

/**
 * Controlled numeric input that fixes the "0."-collapse bug: a plain
 * `value={Number(...)}` input re-renders `"0."` or `"12."` back to `"0"`/`"12"`
 * on every keystroke because `Number("0.")` is a whole number, so the trailing
 * `.` (or `-`, or a mid-typed decimal) can never be typed. This component keeps
 * the raw typed text in local state while focused — so those transient strings
 * survive — while still committing the PARSED number to the caller on every
 * keystroke via `onValueChange`. On blur it drops the raw text and snaps back
 * to whatever canonical string the caller derives from its own committed value
 * (`value` prop), matching the commit-on-blur pattern this replaces.
 */
export function RawNumInput({
  value,
  onValueChange,
  emptyValue,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  /** Canonical display value (e.g. `String(current)`), shown whenever not focused. */
  value: string;
  /** Called with the parsed number on every keystroke; NaN/empty becomes `emptyValue`. */
  onValueChange: (parsed: number, raw: string) => void;
  /** Value passed to `onValueChange` when the field is empty or unparsable. */
  emptyValue: number;
}) {
  const [editText, setEditText] = useState<string | null>(null);
  return (
    <NumInput
      {...props}
      value={editText ?? value}
      onFocus={(e) => {
        setEditText(value);
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        setEditText(null);
        props.onBlur?.(e);
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setEditText(raw);
        const parsed = Number(raw);
        onValueChange(raw === "" || !Number.isFinite(parsed) ? emptyValue : parsed, raw);
      }}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx("con-select", props.className)} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx("con-textarea", props.className)} />;
}

export function Toggle({
  checked,
  onChange,
  disabled,
  busy,
  label
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** In-flight write — keeps the optimistic checked value visible and marks the switch busy. */
  busy?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={busy === true}
      aria-label={label}
      disabled={disabled}
      className={cx("con-toggle", busy && "opacity-70")}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cx("inline-flex rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] p-0.5", className)}
    >
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            title={opt.title}
            onClick={() => onChange(opt.value)}
            className={cx(
              "con-segmented-btn",
              active
                ? "rounded px-2 py-1 text-[length:var(--con-fs-xs)] font-bold text-[color:var(--con-fg)] bg-[color:var(--con-surface)]"
                : "rounded px-2 py-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Empty state / dash ───────────────────────────────────────────────────────

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">{children}</p>;
}

export function Dash() {
  return <span className="text-[color:var(--con-faint)]">{EM_DASH}</span>;
}

/** Humanized timestamp with the exact time on hover — the console's rule for
 *  every timestamp. */
export function Ago({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <Dash />;
  return (
    <Tooltip content={fmtExact(iso)}>
      <time dateTime={iso} className="cursor-default whitespace-nowrap">
        {timeAgo(iso)}
      </time>
    </Tooltip>
  );
}

/** Signed value coloring: green up, red down, plain when zero/absent. */
export function signTone(v: number | null | undefined): "pos" | "neg" | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v === 0) return undefined;
  return v > 0 ? "pos" : "neg";
}

export function SignedText({ value, children }: { value: number | null | undefined; children: ReactNode }) {
  const tone = signTone(value);
  const color = tone ? TONE_VAR[tone] : undefined;
  return (
    <span className="con-num" style={color ? { color } : undefined}>
      {children}
    </span>
  );
}

// ── Tooltip ──────────────────────────────────────────────────────────────────

export function Tooltip({
  children,
  content,
  className,
  align = "center"
}: {
  children: ReactNode;
  content: ReactNode;
  className?: string;
  align?: "center" | "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function handleClickOutside(event: MouseEvent | TouchEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, [open]);

  if (!content) return <>{children}</>;

  const alignClass =
    align === "right"
      ? "right-0 translate-x-0"
      : align === "left"
      ? "left-0 translate-x-0"
      : "left-1/2 -translate-x-1/2";

  const interactive = isInteractiveTooltipTrigger(children);

  return (
    <span
      ref={ref}
      className={cx(
        "group relative inline-flex cursor-pointer",
        !interactive &&
          "rounded-[var(--con-radius-sm)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--con-accent)]",
        className
      )}
      tabIndex={interactive ? undefined : 0}
      aria-describedby={tooltipId}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={() => setOpen((prev) => !prev)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      {children}
      <span id={tooltipId} className="sr-only">
        {content}
      </span>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 2, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 2, scale: 0.98 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            role="tooltip"
            aria-hidden
            className={cx(
              "pointer-events-none absolute bottom-full z-[100] mb-2 w-max max-w-xs rounded-[var(--con-radius-sm)] border border-[color:var(--con-line-strong)] bg-[color:var(--con-surface)] px-2.5 py-1.5 text-center text-[length:var(--con-fs-xs)] font-medium leading-snug text-[color:var(--con-fg)] shadow-[var(--con-shadow-lg)] whitespace-pre-line",
              alignClass
            )}
          >
            {content}
          </motion.div>
        )}
      </AnimatePresence>
    </span>
  );
}

