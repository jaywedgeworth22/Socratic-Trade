"use client";

/** Strategy — how this account trades: the models, the strategist's written
 *  instructions (prompt), the eight scoring-factor weights, AI review, and
 *  the preset library. Always account-scoped; the header repeats the scope.
 *  Progressive structure (PR-B3): Models + Instructions open by default;
 *  Scoring weights collapsed; Presets collapsible open. No policy value changes.
 *  Presets are copy-not-link and can never arm or disarm anything
 *  (server-enforced). Tax treatment lives on Guardrails, not here (moved
 *  there in the 2026-07-16 IA restructure — it sits next to the Tax rules
 *  group that references it). */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Lock, Unlock } from "lucide-react";
import type { ConnectedAccount, LlmReasoningEffort, ScoringWeights, StrategyProfile, StrategyTuningPatch, TradingPolicy } from "@/lib/types";
import { isDisallowedInteractiveStrategyReasoningConfig, reasoningCapabilityForModel } from "@/lib/llm-request";
import { reasoningAdviceForModel, recommendedReasoningEffortForModel } from "@/lib/model-reasoning-recommendations";
import type { DashboardSnapshot } from "../../dashboard-types";
import {
  normalizeReasoningValueForControl,
  reasoningControlForModels,
  reasoningSummary,
  seatReasoningPatch,
  type ReasoningControl
} from "./reasoning-control";
// Pure curated-model DATA (no legacy UI components) — the same catalog the rest
// of the app offers, so the console review picker stays consistent with it.
import { CURATED_LLM_MODEL_GROUPS, CURATED_LLM_MODEL_IDS, CUSTOM_MODEL_ID_SEED, ROTATE_ALL_MODELS_ID, ROTATE_ALL_MODELS_LABEL } from "../../ui/llm-model-catalog";
import {
  activateProfile,
  copyProfileToAccount,
  createProfile,
  deleteProfile,
  fetchLatestTuneReview,
  importAccountSettings,
  resolveTuneReview,
  savePolicy,
  tuneStrategy,
  updateProfile,
  ConsoleApiError,
  type StrategyTuneResult
} from "../lib/api";
import { activeConnectedAccount, deriveReality, type RealityInfo } from "../lib/derive";
import { EM_DASH } from "../lib/format";
import { classify, getAtPath, type FieldDef } from "../lib/policy-diff";
import { CONSOLE_PAGE_WIDTH } from "../lib/page-width";
import { useAutoSave } from "../lib/useAutoSave";
import { useConsoleData } from "../lib/useConsoleData";
import { useUnsavedChanges } from "../lib/useDirtyGuard";
import { ALL_DEFS } from "../guardrails/field-defs";
import { TypedConfirm } from "../components/chrome";
import { ModelStatsButton } from "../components/model-stats-drawer";
import { resolveScoringWeightCommit } from "../lib/number-commit";
import { useToast } from "../ui/toast";
import { Ago, Btn, Card, Chip, Empty, Field, LiveTag, RawNumInput, Select, TextArea, TextInput, Tooltip } from "../ui/primitives";
import { SaveStatus } from "../ui/save-status";
import { Sheet } from "../ui/sheet";
import { OverlaysPanel } from "./overlays-panel";
import { TuningDryRunPanel } from "./tuning-dry-run";

export const metadata = { title: "Strategy" };

/** Shipped default weights (src/lib/defaults.ts) — shown as ghost reference. */
const DEFAULT_WEIGHTS: ScoringWeights = {
  liquidity: 1.4,
  momentum: 1.2,
  value: 0.8,
  quality: 0.8,
  volatility: 0.8,
  sentiment: 0.6,
  positioning: 0.8,
  diversification: 1
};

const WEIGHT_KEYS = Object.keys(DEFAULT_WEIGHTS) as Array<keyof ScoringWeights>;

/** Human-readable name + hover explanation for each scoring factor. Display-only —
 *  does not touch the scoring math in src/lib/scoring.ts (or wherever weights are applied). */
const FACTOR_META: Record<keyof ScoringWeights, { name: string; tip: string }> = {
  liquidity: {
    name: "Liquidity",
    tip: "How easily you can trade the stock, from recent share volume.  More weight favors high-volume names you can enter and exit cleanly, and penalizes thin, illiquid ones."
  },
  momentum: {
    name: "Momentum",
    tip: "Recent trend strength: intraday move, position within the 52-week range, and technical signals (RSI/MACD/moving averages).  More weight favors names that are rising and near their highs."
  },
  value: {
    name: "Value",
    tip: "Cheapness from P/E and free-cash-flow yield.  More weight tilts toward low-multiple, cash-generative names and away from expensive ones."
  },
  quality: {
    name: "Quality",
    tip: "Financial sturdiness: company size, low debt, and earnings growth.  More weight favors large, low-leverage, profitably growing companies."
  },
  volatility: {
    name: "Volatility",
    tip: "Steadiness, not choppiness — the score is highest for calm, low-beta names.  Counter-intuitively, more weight here favors steady stocks and penalizes sharp movers and high-beta risk."
  },
  sentiment: {
    name: "Sentiment",
    tip: "Aggregate news, analyst, and market sentiment (0–100).  More weight favors positively-covered names and discounts negatively-covered ones."
  },
  positioning: {
    name: "Positioning",
    tip: "Smart-money accumulation: net congressional buying, insider open-market purchases (SEC Form 4), and short-squeeze setups.  More weight favors names insiders and Congress are buying."
  },
  diversification: {
    name: "Diversification",
    tip: "Portfolio fit: a name you don't already hold scores higher than one you do.  More weight pushes toward new positions instead of adding to what you already own — it's held-vs-not, not sector spread."
  }
};

const CUSTOM_MODEL_OPTION = CUSTOM_MODEL_ID_SEED;

function isCuratedModel(model: string | undefined): boolean {
  return !!model && CURATED_LLM_MODEL_IDS.includes(model);
}

function modelSelectValue(model: string | undefined): string {
  if (!model) return "";
  return model;
}

function modelProviderLabel(model: string | undefined): string {
  if (!model) return "Not Set";
  if (model === ROTATE_ALL_MODELS_ID) return "Rotating (a different model each run)";
  const group = CURATED_LLM_MODEL_GROUPS.find((g) => g.options.some((option) => option.value === model));
  return group?.label ?? "Custom Provider";
}

function ModelSelect({
  id,
  value,
  onPick,
  onCustomTextChange,
  onCustomTextBlur,
  disabled,
  allowBlank,
  blankLabel,
  blankDisabled,
  role
}: {
  id: string;
  value: string | undefined;
  /** A concrete model choice from the dropdown (curated id, blank, or rotate) — persist immediately. */
  onPick: (model: string) => void;
  /** Local-only update per keystroke while typing a custom id — never persists. */
  onCustomTextChange: (text: string) => void;
  /** Persist the typed custom id (if any) on blur. */
  onCustomTextBlur: () => void;
  disabled?: boolean;
  allowBlank?: boolean;
  blankLabel?: string;
  /** Render the blank option as an unselectable placeholder (native "choose one" pattern) — for a
   *  seat where blank is NOT a valid choice to actively pick (the Proposer), only a display state
   *  for "unconfigured." Without this, a `<select value="">` with no matching `<option value="">`
   *  falls back to visually showing its FIRST rendered option (the comparative rotation),
   *  making an unconfigured seat look like rotation is on even though nothing was ever chosen. */
  blankDisabled?: boolean;
  role: "proposer" | "red-team";
}) {
  const selectValue = modelSelectValue(value);
  const custom = selectValue === CUSTOM_MODEL_OPTION;
  const customCurrent = value && !isCuratedModel(value) && value !== CUSTOM_MODEL_OPTION && value !== ROTATE_ALL_MODELS_ID ? value : null;
  return (
    <div className="flex flex-col gap-2">
      <Select
        id={id}
        value={selectValue}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          if (next === CUSTOM_MODEL_OPTION) {
            // Entering (or re-entering) custom-id entry mode is a UI-mode switch, not a concrete
            // model choice — don't persist until a real id is typed and blurred.
            onCustomTextChange(custom ? (value ?? CUSTOM_MODEL_OPTION) : CUSTOM_MODEL_OPTION);
            return;
          }
          onPick(next);
        }}
      >
        {allowBlank && (
          <option value="" disabled={blankDisabled}>
            {blankLabel ?? "Not Set"}
          </option>
        )}
        <option
          value={ROTATE_ALL_MODELS_ID}
          title="Rotates through every curated model with a resolvable key, favoring models with less accrued history (2x pick weight), so attributed comparative history accrues evenly.  Use only where model-to-model variation is acceptable."
        >
          {ROTATE_ALL_MODELS_LABEL}
        </option>
        {customCurrent && (
          <option value={customCurrent} title="A model id outside the curated list, kept exactly as stored.">
            {customCurrent} - custom id
          </option>
        )}
        {CURATED_LLM_MODEL_GROUPS.map((group) => (
          <optgroup key={group.provider} label={group.label}>
            {group.options.map((option) => {
              const label = role === "proposer" && option.recommendedGreen
                ? `${option.label} (Rec Green Team)`
                : role === "red-team" && option.recommendedRed
                ? `${option.label} (Rec Red Team)`
                : option.label;
              return (
                <option key={option.value} value={option.value}>
                  {label}
                </option>
              );
            })}
          </optgroup>
        ))}
        <option value={CUSTOM_MODEL_OPTION}>Custom Model ID...</option>
      </Select>
      {custom && (
        <TextInput
          value={value && value !== CUSTOM_MODEL_OPTION ? value : ""}
          placeholder="provider-model-id"
          onChange={(event) => onCustomTextChange(event.target.value)}
          onBlur={onCustomTextBlur}
          title="Type an exact provider model ID if it is not in the curated list. Saves when you click away."
        />
      )}
    </div>
  );
}

/** One seat's own reasoning/thinking control (per-team split 2026-07-10): rendered under that
 *  seat's model picker, only when THAT model exposes a reasoning knob. The reviewer additionally
 *  gets an `inherit` blank option ("Same as Green Team") representing the unset per-team field.
 *  Disallowed interactive combos (gpt-5.5 + high) are disabled IN the select — the rule surfaces
 *  before any save instead of as a post-save 400 toast — and curated per-model advice
 *  (src/lib/model-reasoning-recommendations.ts) renders underneath. */
function SeatEffortSelect({
  id,
  model,
  control,
  value,
  disabled,
  onPick,
  inherit
}: {
  id: string;
  /** The seat's concrete model (drives per-option disallow checks + advice). */
  model: string;
  control: ReasoningControl;
  /** The resolved effort the select shows (same normalization the server applies at call time). */
  value: LlmReasoningEffort | undefined;
  disabled?: boolean;
  onPick: (effort: LlmReasoningEffort) => void;
  /** Reviewer-only: the "Same as proposer" unset state. `active` = no explicit per-team value is
   *  stored; `resolvedLabel` names what currently inherits; `onClear` reverts to inheriting. */
  inherit?: { active: boolean; resolvedLabel?: string; onClear: () => void };
}) {
  const advice = reasoningAdviceForModel(model);
  const hasDisallowedOption = control.options.some((option) => isDisallowedInteractiveStrategyReasoningConfig(model, option.value));
  return (
    <div>
      <Field label={control.label} hint={control.hint} htmlFor={id}>
        <Select
          id={id}
          value={inherit?.active ? "" : (value ?? "")}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            if (!next) {
              inherit?.onClear();
              return;
            }
            onPick(next as LlmReasoningEffort);
          }}
        >
          {inherit && (
            <option
              value=""
              title="No Red Team-specific effort stored — the Red Team inherits the Green Team's effort, re-clamped to this model's supported range at call time."
            >
              Same as Green Team{inherit.resolvedLabel ? ` (${inherit.resolvedLabel})` : ""}
            </option>
          )}
          {control.options.map((option) => {
            const disallowed = isDisallowedInteractiveStrategyReasoningConfig(model, option.value);
            return (
              <option
                key={option.value}
                value={option.value}
                disabled={disallowed}
                title={disallowed ? "gpt-5.5 with high reasoning is disabled for interactive strategy runs." : option.hint}
              >
                {option.label}
                {disallowed ? " — disabled for interactive runs" : ""}
              </option>
            );
          })}
        </Select>
      </Field>
      {advice && (
        <p className={`mt-1.5 text-[length:var(--con-fs-xs)] ${hasDisallowedOption ? "text-[color:var(--con-warn)]" : "text-[color:var(--con-muted)]"}`}>
          {advice}
        </p>
      )}
    </div>
  );
}

function FallbackModelSelect({
  id,
  value,
  onChange,
  onCommit,
  disabled
}: {
  id: string;
  value: string;
  onChange: (val: string) => void;
  onCommit: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen((currentOpen) => {
          if (currentOpen) {
            onCommitRef.current();
          }
          return false;
        });
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selectedSet = new Set(value.split(",").map(s => s.trim()).filter(Boolean));

  return (
    <div className="relative" ref={containerRef}>
      <TextInput
        id={id}
        value={value}
        placeholder="e.g. gpt-5.4-mini, claude-sonnet-5"
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Defer commit to let any in-flight checkbox onChange events settle
          // (e.g. toggling a model via keyboard while focus moves away).
          setTimeout(() => {
            onCommitRef.current();
            setOpen(false);
          }, 0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            setOpen(false);
            onCommitRef.current();
          }
        }}
        disabled={disabled}
        autoComplete="off"
      />
      {open && (
        <div className="absolute z-10 mt-1 w-full max-h-64 overflow-auto rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-1)] shadow-lg py-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-text)]">
          {CURATED_LLM_MODEL_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="px-3 py-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-faint)] bg-[color:var(--con-surface-2)]">
                {group.label}
              </div>
              {group.options.map((opt) => {
                const checked = selectedSet.has(opt.value);
                return (
                  <label
                    key={opt.value}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-[color:var(--con-surface-2)] cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const nextSet = new Set(selectedSet);
                        if (e.target.checked) {
                          nextSet.add(opt.value);
                        } else {
                          nextSet.delete(opt.value);
                        }
                        onChange(Array.from(nextSet).join(", "));
                      }}
                      className="rounded border border-[color:var(--con-line)] bg-[color:var(--con-surface-1)] text-[color:var(--con-accent)]"
                    />
                    <span>{opt.value}</span>
                  </label>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Copy for a rotating seat, where the manual effort control is deliberately hidden. Matches the
 *  server behavior in src/lib/model-rotation.ts (recommendedReasoningEffortForModel). */
function RotationEffortNote() {
  return (
    <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
      Reasoning is auto-set per rotated model at its curated recommended level (models without a
      curated recommendation run Medium).
    </p>
  );
}

export default function StrategyPage() {
  const { snapshot } = useConsoleData();
  if (!snapshot) return null;
  return <AccountScopedStrategyPage key={snapshot.policy.connectedAccountId ?? "no-account"} />;
}

function AccountScopedStrategyPage() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();

  // Prompt: local text while typing, persist on blur (see commitPrompt below).
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const autoSavePrompt = useAutoSave();
  // Models: sticky optimistic overlay per field — each select persists immediately on
  // change; the custom-id text fields persist on blur. Reverted by useAutoSave's onError.
  const [localProposerModel, setLocalProposerModel] = useState<string | null>(null);
  const [localRedTeamModel, setLocalRedTeamModel] = useState<string | null>(null);
  const [localFallbackModels, setLocalFallbackModels] = useState<string | null>(null);
  const [localRedTeamFallbackModels, setLocalRedTeamFallbackModels] = useState<string | null>(null);
  const autoSaveFallback = useAutoSave();
  const autoSaveRedTeamFallback = useAutoSave();
  // Per-team reasoning overlays (per-team split 2026-07-10). Proposer: plain optimistic value —
  // llmReasoningEffort always resolves (it has a "medium" default). Reviewer: "cleared" = an
  // optimistic explicit-unset (the "Same as Green Team" option) awaiting the server round-trip;
  // null = no local overlay (fall back to the saved policy value).
  const [localReasoningEffort, setLocalReasoningEffort] = useState<LlmReasoningEffort | null>(null);
  const [localRedTeamReasoningEffort, setLocalRedTeamReasoningEffort] = useState<LlmReasoningEffort | "cleared" | null>(null);
  const autoSaveModels = useAutoSave();
  // Scoring weights: local text while typing each factor, persist on blur (per-field patch —
  // the server deep-merges scoringWeights, see commitWeight below).
  const [weightsDrafts, setWeightsDrafts] = useState<Partial<Record<keyof ScoringWeights, string>>>({});
  const autoSaveWeights = useAutoSave();
  // Presets ("Apply to this account") is a discrete action button, not auto-saved.
  const [busy, setBusy] = useState<string | null>(null);

  const reality = useMemo(() => (snapshot ? deriveReality(snapshot) : null), [snapshot]);
  const ready = snapshot !== null;

  // Deep links (e.g. Settings' old #models links now route to /console/strategy#models):
  // the page renders only after the snapshot arrives, so the native anchor jump
  // misses — scroll once the target section actually exists.
  useEffect(() => {
    if (!ready || typeof window === "undefined") return;
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const timer = setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    return () => clearTimeout(timer);
  }, [ready]);

  if (!snapshot || !reality) return null;

  const policy = snapshot.policy;
  const activeAccount = activeConnectedAccount(snapshot);
  const prompt = promptDraft ?? snapshot.strategyPrompt;
  const proposerModel = localProposerModel ?? policy.llmModel ?? "";
  const redTeamModel = localRedTeamModel ?? policy.redTeamLlmModel ?? "";
  // NOTE (2026-07-10 fix): there used to be an `effectiveRedTeamModel = redTeamModel ||
  // proposerModel` here that every display below read from. That was a false assumption — the
  // server (`resolveRoleModel(policy, "red")` in src/lib/llm-provider.ts) does NOT fall back to
  // the Proposer model when the Reviewer is blank; it returns "" and `debateProposal`
  // (src/lib/red-team.ts) fails CLOSED to human review (`not_configured`). A blank Reviewer never
  // runs the Proposer's model. Every display below now reads the Reviewer's own `redTeamModel`
  // directly (blank stays blank) so the UI can't imply an inheritance that doesn't exist. This is
  // display-only — no save/resolution behavior changed; see docs/rollouts/2026-07-10-per-team-reasoning.md.
  //
  // Reasoning EFFORT inheritance (storedReviewerEffort below) is a DIFFERENT, real mechanism —
  // resolveReviewerReasoningEffort (src/lib/llm-request.ts) genuinely falls back to the Proposer's
  // effort when redTeamReasoningEffort is unset, but only ever matters once a Reviewer model is
  // actually configured (debateProposal returns before resolving effort when the model is blank).
  // The rotation sentinel is neither a custom id (it only ever serves curated models, so the
  // custom-cost-fallback warning doesn't apply) nor a model with its own reasoning capability.
  const isRotate = (m: string) => m === ROTATE_ALL_MODELS_ID;
  const showCustomModelWarning =
    (proposerModel && !isCuratedModel(proposerModel) && !isRotate(proposerModel)) ||
    (redTeamModel && !isCuratedModel(redTeamModel) && !isRotate(redTeamModel));
  const rotationSelected = isRotate(proposerModel) || isRotate(redTeamModel);
  // Joint control used ONLY for the one-line provider/reasoning summary below. The actual effort
  // selects are PER SEAT (per-team split 2026-07-10): each picker gets its own control, shown only
  // when THAT seat's model exposes a reasoning knob; a rotating seat hides the manual control
  // entirely (rotation auto-sets each served model's recommended effort server-side). A blank
  // Reviewer model is filtered out here (not substituted with the Proposer's), so the summary
  // reflects only models that actually resolve.
  const reasoningControl = reasoningControlForModels([proposerModel, redTeamModel]);
  const storedProposerEffort = localReasoningEffort ?? policy.llmReasoningEffort;
  // The reviewer's EXPLICIT per-team value only — undefined = inheriting the proposer's
  // (mirrors resolveReviewerReasoningEffort server-side).
  const storedReviewerEffort =
    localRedTeamReasoningEffort === "cleared" ? undefined : (localRedTeamReasoningEffort ?? policy.redTeamReasoningEffort);
  const proposerRotates = isRotate(proposerModel);
  const reviewerRotates = isRotate(redTeamModel);
  const proposerReasoningControl = proposerRotates ? null : reasoningControlForModels([proposerModel]);
  // null (not just when rotating) whenever redTeamModel is blank — reasoningControlForModels
  // filters out empty strings, so an unconfigured Reviewer correctly shows NO reasoning control
  // at all rather than the Proposer's ladder under the Reviewer's heading.
  const reviewerReasoningControl = reviewerRotates ? null : reasoningControlForModels([redTeamModel]);
  const proposerReasoningValue = proposerReasoningControl
    ? normalizeReasoningValueForControl([proposerModel], proposerReasoningControl, storedProposerEffort)
    : undefined;
  // What the reviewer would RUN at right now (explicit value, else the inherited proposer effort),
  // re-normalized to the reviewer model's own supported range — shown inside the "Same as
  // proposer" option label so inheritance is never a mystery value. Only computed when the
  // Reviewer actually has a model (reviewerReasoningControl is null otherwise).
  const reviewerReasoningValue = reviewerReasoningControl
    ? normalizeReasoningValueForControl([redTeamModel], reviewerReasoningControl, storedReviewerEffort ?? storedProposerEffort)
    : undefined;
  const reviewerInheriting = storedReviewerEffort === undefined;
  const reviewerInheritedLabel = reviewerReasoningControl?.options.find((option) => option.value === reviewerReasoningValue)?.label;
  // A concrete seat model that takes NO reasoning parameters at all (e.g. mistral-small-2603) —
  // disclose per seat that reasoning settings don't apply to it.
  const proposerNoKnob = Boolean(proposerModel) && !proposerRotates && !reasoningCapabilityForModel(proposerModel);
  const reviewerNoKnob = Boolean(redTeamModel) && !reviewerRotates && !reasoningCapabilityForModel(redTeamModel);
  // The Reviewer is unconfigured (blank, not rotating) — the real server-side consequence is that
  // every risk-adding opening fails CLOSED to human review; it does NOT run the Proposer's model.
  const reviewerNotConfigured = !redTeamModel;

  // Prompt: skip the write if blur leaves it unchanged from the saved copy.
  const commitPrompt = () => {
    if (promptDraft === null || promptDraft === snapshot.strategyPrompt) return;
    const next = promptDraft;
    const prev = snapshot.strategyPrompt;
    autoSavePrompt.save(() => savePolicy({ strategyPrompt: next }, policy.connectedAccountId).then(() => refresh()), {
      onError: () => setPromptDraft(prev),
      errorTitle: "Prompt not saved"
    });
  };

  // Persist one team's model choice (from either the select or a blurred custom-id text field).
  // Bundles a renormalized effort FOR THAT SEAT into the SAME write whenever its model changes —
  // see seatReasoningPatch — so a model-only save can never leave the seat's (model, effort)
  // combo in an invalid state (including the disallowed interactive gpt-5.5+high combo, which is
  // clamped to medium in the patch instead of bouncing off the server).
  const commitProposerModel = (model: string, prev: string) => {
    if (model === (policy.llmModel ?? "")) return; // unchanged from the saved value -> no write
    const patch = {
      llmModel: model,
      ...seatReasoningPatch("llmReasoningEffort", model, storedProposerEffort)
    };
    setLocalProposerModel(model);
    autoSaveModels.save(() => savePolicy(patch, policy.connectedAccountId).then(() => refresh()), {
      onError: () => setLocalProposerModel(prev),
      errorTitle: "Green Team not saved"
    });
  };
  const commitRedTeamModel = (model: string, prev: string) => {
    if (model === (policy.redTeamLlmModel ?? "")) return; // unchanged from the saved value -> no write
    const patch = {
      // "" (blank = same as proposer) -> null: the policy route strips nulls back to absent,
      // which is how this optional field is actually cleared (an empty string is rejected).
      redTeamLlmModel: model || null,
      // Renormalize ONLY an explicit reviewer effort against the seat's new effective model — an
      // inheriting (unset) reviewer stays unset (seatReasoningPatch no-ops on undefined effort).
      ...seatReasoningPatch("redTeamReasoningEffort", model || proposerModel, storedReviewerEffort)
    };
    setLocalRedTeamModel(model);
    autoSaveModels.save(() => savePolicy(patch, policy.connectedAccountId).then(() => refresh()), {
      onError: () => setLocalRedTeamModel(prev),
      errorTitle: "Red Team not saved"
    });
  };
  const commitProposerReasoningEffort = (effort: LlmReasoningEffort) => {
    const prev = localReasoningEffort;
    setLocalReasoningEffort(effort);
    autoSaveModels.save(() => savePolicy({ llmReasoningEffort: effort }, policy.connectedAccountId).then(() => refresh()), {
      onError: () => setLocalReasoningEffort(prev),
      errorTitle: "Green Team reasoning not saved"
    });
  };
  const commitReviewerReasoningEffort = (effort: LlmReasoningEffort) => {
    const prev = localRedTeamReasoningEffort;
    setLocalRedTeamReasoningEffort(effort);
    autoSaveModels.save(() => savePolicy({ redTeamReasoningEffort: effort }, policy.connectedAccountId).then(() => refresh()), {
      onError: () => setLocalRedTeamReasoningEffort(prev),
      errorTitle: "Red Team reasoning not saved"
    });
  };
  // The reviewer's "Same as Green Team" blank option: clear the explicit per-team value entirely
  // (the policy route strips the null back to absent), so the reviewer goes back to inheriting
  // the proposer's effort via resolveReviewerReasoningEffort at call time.
  const clearReviewerReasoningEffort = () => {
    const prev = localRedTeamReasoningEffort;
    setLocalRedTeamReasoningEffort("cleared");
    autoSaveModels.save(() => savePolicy({ redTeamReasoningEffort: null }, policy.connectedAccountId).then(() => refresh()), {
      onError: () => setLocalRedTeamReasoningEffort(prev),
      errorTitle: "Red Team reasoning not saved"
    });
  };

  const commitFallbackModels = () => {
    if (localFallbackModels === null) return;
    const array = localFallbackModels.split(",").map(s => s.trim()).filter(Boolean);
    const prevArray = policy.llmFallbackModels || [];
    if (array.join(",") === prevArray.join(",")) return;
    autoSaveFallback.save(() => savePolicy({ llmFallbackModels: array }, policy.connectedAccountId).then(() => refresh()), {
      onError: () => setLocalFallbackModels(prevArray.join(", ")),
      errorTitle: "Fallback models not saved"
    });
  };

  const commitRedTeamFallbackModels = () => {
    if (localRedTeamFallbackModels === null) return;
    const array = localRedTeamFallbackModels.split(",").map(s => s.trim()).filter(Boolean);
    const prevArray = policy.redTeamFallbackModels || [];
    if (array.join(",") === prevArray.join(",")) return;
    autoSaveRedTeamFallback.save(() => savePolicy({ redTeamFallbackModels: array }, policy.connectedAccountId).then(() => refresh()), {
      onError: () => setLocalRedTeamFallbackModels(prevArray.join(", ")),
      errorTitle: "Red Team fallback models not saved"
    });
  };

  // Scoring weights: one factor per blur, skip the write if unchanged, blank, or unparseable.
  const commitWeight = (key: keyof ScoringWeights, saved: number) => {
    const raw = weightsDrafts[key];
    setWeightsDrafts((d) => {
      if (!(key in d)) return d;
      const copy = { ...d };
      delete copy[key];
      return copy;
    });
    if (raw === undefined) return;
    const next = resolveScoringWeightCommit(raw, saved);
    if (next === null) return;
    autoSaveWeights.save(() => savePolicy({ scoringWeights: { [key]: next } }, policy.connectedAccountId).then(() => refresh()));
  };

  return (
    <div className={`${CONSOLE_PAGE_WIDTH} flex flex-col gap-4`}>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">Strategy</h1>
        <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          for {reality.account?.label ?? "no connected account"} — each account has its own strategy
        </span>
        <div className="ml-auto">
          <ImportFromAccountControl snapshot={snapshot} policy={policy} currentLabel={reality.account?.label} />
        </div>
      </div>

      {/* Models — id anchor is a deep-link target (old Settings "#models" links
          retargeted here in the 2026-07-10 Settings IA restructure).
          Progressive structure (PR-B3): open by default with Instructions. */}
      <div id="models" className="scroll-mt-28">
      <Card
        title="Models"
        collapsible
        defaultOpen
        action={
          <div className="flex items-center gap-3">
            <Link
              href="/console/usage"
              className="flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]"
              title="What each model actually spends — per-provider and per-context LLM usage and cost."
            >
              LLM usage &amp; cost <ArrowRight size={12} />
            </Link>
            <SaveStatus status={autoSaveModels.status} />
          </div>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-3">
            <Field
              label={
                <>
                  <span className="text-[color:var(--con-pos)]">Green Team</span> Model
                </>
              }
              hint="The proposer — writes the trade proposals each run."
              htmlFor="llm-model"
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <ModelSelect
                    id="llm-model"
                    value={proposerModel}
                    role="proposer"
                    allowBlank
                    blankDisabled
                    blankLabel="Not set — choose a model"
                    disabled={autoSaveModels.saving}
                    onPick={(model) => commitProposerModel(model, proposerModel)}
                    onCustomTextChange={(text) => setLocalProposerModel(text)}
                    onCustomTextBlur={() => {
                      const typed = (localProposerModel ?? "").trim();
                      if (!typed || typed === CUSTOM_MODEL_OPTION) return; // nothing concrete typed
                      commitProposerModel(typed, policy.llmModel ?? "");
                    }}
                  />
                </div>
                <ModelStatsButton role="proposer" />
              </div>
            </Field>
            {proposerRotates && <RotationEffortNote />}
            {proposerReasoningControl && (
              <SeatEffortSelect
                id="proposer-effort"
                model={proposerModel}
                control={proposerReasoningControl}
                value={proposerReasoningValue}
                disabled={autoSaveModels.saving}
                onPick={commitProposerReasoningEffort}
              />
            )}
            {proposerNoKnob && (
              <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                {proposerModel} takes no reasoning parameters — reasoning settings don&apos;t apply to it.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-3">
            <Field
              label={
                <>
                  <span className="text-[color:var(--con-neg)]">Red Team</span> Model
                </>
              }
              hint="The adversarial reviewer — reviews every proposal each run, and runs a deeper adversarial debate on high-conviction or dissent-flagged ideas.  Blank = not configured: it does NOT inherit the Green Team model — every risk-adding opening routes to human review until a Red Team model is set."
              htmlFor="rt-model"
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <ModelSelect
                    id="rt-model"
                    value={redTeamModel}
                    allowBlank
                    blankLabel="Not set"
                    role="red-team"
                    disabled={autoSaveModels.saving}
                    onPick={(model) => commitRedTeamModel(model, redTeamModel)}
                    onCustomTextChange={(text) => setLocalRedTeamModel(text)}
                    onCustomTextBlur={() => {
                      const typed = (localRedTeamModel ?? "").trim();
                      if (!typed || typed === CUSTOM_MODEL_OPTION) return; // nothing concrete typed
                      commitRedTeamModel(typed, policy.redTeamLlmModel ?? "");
                    }}
                  />
                </div>
                <ModelStatsButton role="red-team" />
              </div>
            </Field>
            {reviewerRotates && <RotationEffortNote />}
            {reviewerReasoningControl && (
              <SeatEffortSelect
                id="reviewer-effort"
                model={redTeamModel}
                control={reviewerReasoningControl}
                value={reviewerReasoningValue}
                disabled={autoSaveModels.saving}
                onPick={commitReviewerReasoningEffort}
                inherit={{
                  active: reviewerInheriting,
                  resolvedLabel: reviewerInheritedLabel,
                  onClear: clearReviewerReasoningEffort
                }}
              />
            )}
            {reviewerNoKnob && (
              <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                {redTeamModel} takes no reasoning parameters — reasoning settings don&apos;t apply to it.
              </p>
            )}
            {reviewerNotConfigured && (
              <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">
                No Reviewer model set — it does not inherit the Proposer.  Every risk-adding opening
                routes to human review until a Reviewer model is chosen.
              </p>
            )}
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-[color:var(--con-line)] grid gap-4 sm:grid-cols-2">
          <Field
            label="Green Team Fallback Models"
            hint="Models tried in order if the primary Green Team model hits a transient error (e.g. rate limit, timeout)."
            htmlFor="llm-fallback-models"
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <FallbackModelSelect
                  id="llm-fallback-models"
                  value={localFallbackModels ?? (policy.llmFallbackModels || []).join(", ")}
                  onChange={(val) => setLocalFallbackModels(val)}
                  onCommit={commitFallbackModels}
                  disabled={autoSaveFallback.saving}
                />
              </div>
              <SaveStatus status={autoSaveFallback.status} />
            </div>
          </Field>
          <Field
            label="Red Team Fallback Models"
            hint="Models tried in order if the primary Red Team model hits a transient error (e.g. rate limit, timeout)."
            htmlFor="rt-fallback-models"
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <FallbackModelSelect
                  id="rt-fallback-models"
                  value={localRedTeamFallbackModels ?? (policy.redTeamFallbackModels || []).join(", ")}
                  onChange={(val) => setLocalRedTeamFallbackModels(val)}
                  onCommit={commitRedTeamFallbackModels}
                  disabled={autoSaveRedTeamFallback.saving}
                />
              </div>
              <SaveStatus status={autoSaveRedTeamFallback.status} />
            </div>
          </Field>
        </div>
        {showCustomModelWarning && (
          // con-warn tokens (not Tailwind amber + dark:): the console theme is driven by
          // data-theme on .console-root, which Tailwind's dark: variant never sees.
          <div className="mt-3 text-[length:var(--con-fs-xs)] rounded-[var(--con-radius-sm)] border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] text-[color:var(--con-warn)] p-2.5 flex items-start gap-1.5">
            <svg className="h-4 w-4 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
            <div>
              Custom model selected.  Cost tracking will use a conservative fallback rate to prevent budget bypass.
            </div>
          </div>
        )}
        <div className="mt-3 rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          Green Team: {modelProviderLabel(proposerModel)}. Red Team: {modelProviderLabel(redTeamModel)}.
          {" "}
          {reasoningSummary(reasoningControl)}
          {rotationSelected && (
            <span className="block mt-2 pt-2 border-t border-[color:var(--con-line)]">
              Rotation: each run picks a curated model whose provider key resolves, weighted toward models
              underrepresented in this account&apos;s recent rotation history (2x pick weight vs 1x, audited).
              Every proposal records the concrete model that wrote it, so per-model history accrues
              automatically. Use only where model-to-model variation is acceptable for that account.
            </span>
          )}
        </div>
      </Card>
      </div>

      {/* Instructions — primary brief; open on first paint (PR-B3). */}
      <div id="instructions" className="scroll-mt-28">
      <Card
        title="Instructions"
        collapsible
        defaultOpen
        action={<SaveStatus status={autoSavePrompt.status} />}
      >
        <p className="mb-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Free-text brief the proposer LLM runs under: objective, selection logic, sell rules, sizing guidance, output
          contract.  The deterministic policy gate still constrains everything it proposes.
        </p>
        <TextArea
          rows={16}
          value={prompt}
          onChange={(e) => setPromptDraft(e.target.value)}
          onBlur={commitPrompt}
          spellCheck={false}
          title="Saves when you click away."
        />
      </Card>
      </div>

      {/* Scoring weights — advanced; collapsed on first paint (PR-B3). No policy value changes. */}
      <div id="scoring" className="scroll-mt-28">
      <Card
        title="Scoring"
        collapsible
        defaultOpen={false}
        action={<SaveStatus status={autoSaveWeights.status} />}
      >
        <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          The market scan ranks candidates by these eight factors before the strategist ever sees them. Defaults shown
          under each field. Weights are relative — raising one factor increases its share of the score and lowers the
          others&apos;; only the ratios between factors matter, not the absolute numbers.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {WEIGHT_KEYS.map((key) => {
            const saved = policy.scoringWeights?.[key] ?? DEFAULT_WEIGHTS[key];
            const raw = weightsDrafts[key];
            const meta = FACTOR_META[key] ?? { name: key, tip: "A scoring factor used to rank market-scan candidates." };
            return (
              <Field
                key={key}
                label={
                  <Tooltip content={meta.tip}>
                    <span className="inline-flex cursor-default items-center gap-1">
                      {meta.name}
                      <span aria-hidden className="text-[color:var(--con-faint)]">
                        ⓘ
                      </span>
                      <span className="sr-only">{meta.tip}</span>
                    </span>
                  </Tooltip>
                }
                hint={`default ${DEFAULT_WEIGHTS[key]}`}
                htmlFor={`w-${key}`}
              >
                <RawNumInput
                  id={`w-${key}`}
                  step="0.1"
                  min="0"
                  value={raw ?? String(saved)}
                  emptyValue={saved}
                  title="Saves when you click away."
                  onValueChange={(_parsed, r) => setWeightsDrafts((d) => ({ ...d, [key]: r }))}
                  onBlur={() => commitWeight(key, saved)}
                />
              </Field>
            );
          })}
        </div>
      </Card>
      </div>

      <OverlaysPanel policy={policy} onSaved={refresh} />

      <div id="weight-tuning-preview" className="scroll-mt-28">
        <TuningDryRunPanel />
      </div>

      {/* AI review */}
      <AiReviewPanel policy={policy} strategyPrompt={snapshot.strategyPrompt} reality={reality} />

      {/* Presets — collapsible; open so the library remains discoverable without scrolling past
          advanced weights (PR-B3). */}
      <div id="presets" className="scroll-mt-28">
      <Card title="Presets" collapsible defaultOpen>
        <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Applying a preset copies its policy, prompt, and weights onto the active account — copy, not link: later edits
          to the preset never follow. A preset can never start or stop the strategy; your run state is always preserved.
        </p>
        <PresetLibrary
          profiles={snapshot.profiles}
          policy={policy}
          strategyPrompt={snapshot.strategyPrompt}
          activeAccount={activeAccount}
          busy={busy}
          setBusy={setBusy}
          refresh={refresh}
        />
      </Card>
      </div>
    </div>
  );
}

function PresetLibrary({
  profiles,
  policy,
  strategyPrompt,
  activeAccount,
  busy,
  setBusy,
  refresh
}: {
  profiles: StrategyProfile[];
  policy: TradingPolicy;
  strategyPrompt: string;
  activeAccount?: ConnectedAccount;
  busy: string | null;
  setBusy: (value: string | null) => void;
  refresh: () => Promise<void>;
}) {
  const toast = useToast();
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const createPreset = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      await createProfile({ name, prompt: strategyPrompt, policy, active: false });
      setNewName("");
      toast.push("pos", "Preset saved", `“${name}” captures this account’s current strategy.`);
      await refresh();
    } catch (error) {
      toast.push("neg", "Preset not saved", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  };

  const applyPreset = async (profile: StrategyProfile) => {
    setBusy(`profile-${profile.id}`);
    try {
      if (activeAccount) {
        await copyProfileToAccount(profile.id, activeAccount.id);
        toast.push("pos", `Applied “${profile.name}”`, "Copied onto this account.  Run state unchanged.");
      } else {
        await activateProfile(profile.id);
        toast.push("pos", `Activated “${profile.name}”`, "Applied as the base strategy for new account scope.");
      }
      await refresh();
    } catch (error) {
      toast.push("neg", "Preset not applied", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const commitRename = async (profile: StrategyProfile) => {
    const name = renameDraft.trim();
    setRenameId(null);
    if (!name || name === profile.name) return;
    setBusy(`rename-${profile.id}`);
    try {
      await updateProfile(profile.id, { name });
      toast.push("pos", "Preset renamed", `Now “${name}”.`);
      await refresh();
    } catch (error) {
      toast.push("neg", "Rename failed", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const removePreset = async (profile: StrategyProfile) => {
    if (!window.confirm(`Delete preset “${profile.name}”?  This cannot be undone.`)) return;
    setBusy(`delete-${profile.id}`);
    try {
      await deleteProfile(profile.id);
      toast.push("pos", "Preset deleted", `“${profile.name}” removed from the library.`);
      await refresh();
    } catch (error) {
      toast.push("neg", "Delete failed", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="min-w-[12rem] flex-1">
          <Field label="Save current as preset" htmlFor="new-preset-name">
            <TextInput
              id="new-preset-name"
              value={newName}
              placeholder="e.g. Momentum swing"
              disabled={creating || busy !== null}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void createPreset();
              }}
            />
          </Field>
        </div>
        <Btn size="sm" disabled={creating || busy !== null || !newName.trim()} onClick={() => void createPreset()}>
          {creating ? "Saving…" : "Create preset"}
        </Btn>
      </div>
      {profiles.length === 0 ? (
        <Empty>No presets saved yet.</Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {profiles.map((profile) => {
            const applied = policy.activeProfileId ? policy.activeProfileId === profile.id : profile.active;
            const renaming = renameId === profile.id;
            return (
              <div key={profile.id} className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-[color:var(--con-line)] p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {renaming ? (
                      <TextInput
                        aria-label="Preset name"
                        value={renameDraft}
                        autoFocus
                        disabled={busy !== null}
                        className="max-w-xs"
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onBlur={() => void commitRename(profile)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void commitRename(profile);
                          if (event.key === "Escape") setRenameId(null);
                        }}
                      />
                    ) : (
                      <span className="font-semibold">{profile.name || EM_DASH}</span>
                    )}
                    {applied && <Chip tone="accent">applied here</Chip>}
                  </div>
                  <div className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                    updated <Ago iso={profile.updatedAt} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {!applied && (
                    <Btn size="sm" disabled={busy !== null} onClick={() => void applyPreset(profile)}>
                      {busy === `profile-${profile.id}` ? "Applying…" : "Apply to this account"}
                    </Btn>
                  )}
                  {!renaming && (
                    <Btn
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => {
                        setRenameId(profile.id);
                        setRenameDraft(profile.name);
                      }}
                    >
                      Rename
                    </Btn>
                  )}
                  <Btn
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void removePreset(profile)}
                  >
                    {busy === `delete-${profile.id}` ? "Deleting…" : "Delete"}
                  </Btn>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ── Import settings from another account ────────────────────────────────────

/** Header affordance: copy this account's ENTIRE strategy config (models, prompt, guardrails,
 *  weights, watchlist, tax treatment) from any other connected account. Any->any — never
 *  paper-only — and never touches broker connection, credentials, or run state (server-enforced,
 *  see importAccountSettings). Hidden entirely when there's no other account to copy from. */
function ImportFromAccountControl({
  snapshot,
  policy,
  currentLabel
}: {
  snapshot: DashboardSnapshot;
  policy: TradingPolicy;
  currentLabel?: string;
}) {
  const { refresh } = useConsoleData();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [sourceId, setSourceId] = useState("");
  const [busy, setBusy] = useState(false);

  const otherAccounts = snapshot.connectedAccounts.filter((a) => a.id !== policy.connectedAccountId);
  if (otherAccounts.length === 0) return null;

  const source = otherAccounts.find((a) => a.id === sourceId) ?? null;
  const closeSheet = () => {
    setOpen(false);
    setSourceId("");
  };

  const doImport = async () => {
    if (!source || !policy.connectedAccountId) return;
    setBusy(true);
    try {
      await importAccountSettings(policy.connectedAccountId, source.id);
      await refresh();
      toast.push("pos", "Settings imported", `Copied strategy settings from “${source.label}” onto this account.`);
      closeSheet();
    } catch (error) {
      toast.push("neg", "Import failed", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Btn size="sm" onClick={() => setOpen(true)} title="Copy strategy settings from another connected account onto this one.">
        Import from account…
      </Btn>
      <Sheet open={open} onClose={closeSheet} title="Import settings from another account">
        <p className="mb-3 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-faint)]">
          Copies strategy settings — models, prompt, guardrails, weights, watchlist, tax treatment — from another
          connected account onto {currentLabel ? `“${currentLabel}”` : "this account"}. Does not touch broker
          connection, credentials, or run state.
        </p>
        <Field label="Source account" htmlFor="import-source-account">
          <Select id="import-source-account" value={sourceId} onChange={(e) => setSourceId(e.target.value)} disabled={busy}>
            <option value="">Choose an account…</option>
            {otherAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label} ({account.broker} · {account.environment})
              </option>
            ))}
          </Select>
        </Field>
        {source && (
          <div className="mt-4 rounded-control border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] p-3">
            <p className="mb-2 text-[length:var(--con-fs-xs)] leading-relaxed">
              Copies strategy settings — models, prompt, guardrails, weights, watchlist, tax treatment — from
              “{source.label}” onto {currentLabel ? `“${currentLabel}”` : "this account"}. Does not touch broker
              connection, credentials, or run state.
            </p>
            <div className="flex justify-end gap-2">
              <Btn variant="ghost" size="sm" disabled={busy} onClick={() => setSourceId("")}>
                Cancel
              </Btn>
              <Btn variant="primary" size="sm" disabled={busy} onClick={() => void doImport()}>
                {busy ? "Importing…" : "Import settings"}
              </Btn>
            </div>
          </div>
        )}
      </Sheet>
    </>
  );
}

// ── AI review (#12) ──────────────────────────────────────────────────────────

interface ReviewChange {
  key: string;
  label: string;
  from: string;
  to: string;
  direction: "looser" | "tighter" | "changed";
}

const DEFS_BY_PATH = new Map<string, FieldDef>(ALL_DEFS.map((def) => [def.path, def]));

function fmtRaw(def: FieldDef | undefined, value: unknown): string {
  if (value === undefined || value === null || value === "") return "unset";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") {
    if (def?.kind === "money") return `$${value}`;
    if (def?.kind === "pct") return `${value}%`;
    if (def?.kind === "minutes") return `${value} min`;
    if (def?.kind === "seconds") return `${value} s`;
    return String(value);
  }
  return String(value);
}

function ReviewDirectionTag({ direction }: { direction: ReviewChange["direction"] }) {
  if (direction === "changed") return null;
  const unlocks = direction === "looser";
  const Icon = unlocks ? Unlock : Lock;
  const label = unlocks ? "Unlocks" : "Locks Down";
  const title = unlocks
    ? "Raises a cap, removes a protection, broadens the universe, or otherwise expands trading authority."
    : "Adds a protection, lowers a cap, narrows the universe, or otherwise restricts trading authority.";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-current px-1.5 py-0.5 text-[length:var(--con-fs-xs)] font-bold"
      style={{ color: unlocks ? "var(--con-warn)" : "var(--con-pos)" }}
      title={title}
    >
      <Icon size={12} aria-hidden />
      {label}
    </span>
  );
}

/** Flatten the tune proposal's policy/weights patch into labeled from→to rows,
 *  classified LOOSER/TIGHTER via the same guardrail metadata the Guardrails
 *  editor uses — so brokerage loosening costs the same typed word here too. */
function reviewChanges(patch: StrategyTuningPatch, policy: TradingPolicy): ReviewChange[] {
  const rows: ReviewChange[] = [];

  const push = (path: string, label: string, from: unknown, to: unknown, direction?: ReviewChange["direction"]) => {
    const same = (from === undefined && to === undefined) || from === to;
    if (same) return;
    const def = DEFS_BY_PATH.get(path);
    rows.push({
      key: path,
      label,
      from: fmtRaw(def, from),
      to: fmtRaw(def, to),
      direction: direction ?? (def ? classify(def, from, to) : "changed")
    });
  };

  for (const [k, v] of Object.entries(patch.scoringWeights ?? {})) {
    push(`scoringWeights.${k}`, `Weight: ${k}`, policy.scoringWeights?.[k as keyof ScoringWeights], v);
  }

  const p = patch.policy ?? {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "riskRules" || k === "sectorCaps") continue;
    if (k === "strategyAuthority") {
      const from = policy.strategyAuthority;
      if (v !== from) {
        // propose→decide arms Autopilot — the loosest possible move.
        push(k, "Autonomy", from === "decide" ? "Autopilot" : "Ask-first", v === "decide" ? "Autopilot" : "Ask-first", v === "decide" ? "looser" : "tighter");
      }
      continue;
    }
    push(k, DEFS_BY_PATH.get(k)?.label ?? k, getAtPath(policy, k), v);
  }
  for (const [k, v] of Object.entries(p.riskRules ?? {})) {
    push(`riskRules.${k}`, DEFS_BY_PATH.get(`riskRules.${k}`)?.label ?? `riskRules.${k}`, getAtPath(policy, `riskRules.${k}`), v);
  }
  for (const [k, v] of Object.entries(p.sectorCaps ?? {})) {
    const from = policy.sectorCaps?.[k];
    if (from === v) continue;
    rows.push({
      key: `sectorCaps.${k}`,
      label: `Sector cap: ${k}`,
      from: from === undefined ? "unset" : `${from}%`,
      to: `${v}%`,
      // Raising a sector cap allows more concentration — looser.
      direction: typeof from === "number" ? (v > from ? "looser" : "tighter") : "changed"
    });
  }
  return rows;
}

function AiReviewPanel({
  policy,
  strategyPrompt,
  reality
}: {
  policy: TradingPolicy;
  strategyPrompt: string;
  reality: RealityInfo;
}) {
  const { refresh } = useConsoleData();
  const toast = useToast();
  const [model, setModel] = useState<string>("");
  const [reviewReasoning, setReviewReasoning] = useState<LlmReasoningEffort | undefined>(undefined);
  const [busy, setBusy] = useState<"review" | "apply" | null>(null);
  const [review, setReview] = useState<StrategyTuneResult | null>(null);
  // Id of the persisted review row (from the POST response or a restored review) — passed to
  // resolveTuneReview so Apply/Discard/dismiss keep the server's record in sync. Null for a review
  // this session generated but the server hasn't (yet) told us an id for, or once resolved.
  const [reviewId, setReviewId] = useState<string | null>(null);
  // Set only when `review` came from fetchLatestTuneReview (not a fresh generate() in this
  // session) — drives the "Restored unapplied review…" banner. Cleared on dismiss/apply/discard.
  const [restoredBanner, setRestoredBanner] = useState<{ createdAt: string; model: string } | null>(null);
  const [typed, setTyped] = useState("");
  useUnsavedChanges(review !== null);

  // Restore an unapplied review on mount (e.g. after a reload or lost connection before Apply) —
  // scoped to THIS account. Resilient by construction: fetchLatestTuneReview swallows its own
  // errors and resolves null (the server contract may not exist yet / this is a nice-to-have, never
  // a blocking requirement), and the `reviewRef` guard skips restoring over a review the user
  // already started generating in the brief window before this resolves.
  const reviewRef = useRef(review);
  useEffect(() => {
    reviewRef.current = review;
  }, [review]);
  useEffect(() => {
    let cancelled = false;
    fetchLatestTuneReview(policy.connectedAccountId).then((restored) => {
      if (cancelled || !restored || reviewRef.current !== null) return;
      setReview(restored.result);
      setReviewId(restored.id);
      setModel(restored.model ?? "");
      if (restored.reasoningEffort) setReviewReasoning(restored.reasoningEffort);
      setRestoredBanner({ createdAt: restored.createdAt, model: restored.model || "local rules (no LLM)" });
    });
    return () => {
      cancelled = true;
    };
  }, [policy.connectedAccountId]);

  // The rotation sentinel is not a callable model — when a rotating seat would be inherited,
  // fall through to the next concrete choice (AI review runs once, outside the per-run rotation).
  const inheritedReviewerModel =
    [policy.redTeamLlmModel, policy.llmModel].find((m) => m && m !== ROTATE_ALL_MODELS_ID) || "";
  const inheritedReviewerLabel =
    policy.redTeamLlmModel && policy.redTeamLlmModel !== ROTATE_ALL_MODELS_ID ? "Red Team" : "Green Team";
  // With EVERY team seat rotating there is no concrete model to inherit; a blank pick then honestly
  // degrades server-side to local rules (no LLM) — disclose that upfront instead of only via the
  // after-the-fact "local rules" chip (see policyForTuningReviewer in src/lib/strategy-tuning.ts).
  const rotationBlocksInheritance =
    !inheritedReviewerModel && [policy.redTeamLlmModel, policy.llmModel].some((m) => m === ROTATE_ALL_MODELS_ID);
  const reviewerModel = model || inheritedReviewerModel;
  const reviewerReasoningControl = reasoningControlForModels([reviewerModel]);
  // Per-team reasoning (2026-07-10): when the seat being inherited is the Reviewer's, its default
  // effort is the reviewer's own (redTeamReasoningEffort, falling back to the proposer's) —
  // mirrors policyForTuningReviewer / resolveReviewerReasoningEffort server-side.
  const inheritedEffort =
    !model && inheritedReviewerLabel === "Red Team"
      ? (policy.redTeamReasoningEffort ?? policy.llmReasoningEffort)
      : policy.llmReasoningEffort;
  const reviewerReasoningValue = reviewerReasoningControl
    ? normalizeReasoningValueForControl(
        [reviewerModel],
        reviewerReasoningControl,
        reviewReasoning ?? (model ? recommendedReasoningEffortForModel(reviewerModel, "review") : inheritedEffort)
      )
    : undefined;
  const reviewerAdvice = reasoningAdviceForModel(reviewerModel);
  const changes = useMemo(() => (review ? reviewChanges(review.proposedPatch, policy) : []), [review, policy]);
  const promptChanged = Boolean(review?.proposedPatch.prompt && review.proposedPatch.prompt !== strategyPrompt);
  const hasAnyChange = changes.length > 0 || promptChanged;
  const hasLooser = changes.some((c) => c.direction === "looser");
  const needsTyped = reality.tone === "live" && hasLooser && policy.requireTypedConfirmation !== false;

  // Best-effort server-side resolve — never blocks or throws into the caller. A failed resolve
  // just means the review may resurface as "restored" on next load, which is a safe (non-destructive)
  // fallback rather than a reason to hold up the UI the user is actively dismissing/applying.
  const resolveReviewSilently = (id: string, status: "applied" | "dismissed") => {
    resolveTuneReview(id, status).catch(() => {});
  };

  const discard = () => {
    if (reviewId) resolveReviewSilently(reviewId, "dismissed");
    setReview(null);
    setReviewId(null);
    setRestoredBanner(null);
    setTyped("");
  };

  const generate = async () => {
    setBusy("review");
    try {
      const result = await tuneStrategy(model || undefined, reviewerReasoningValue, policy.connectedAccountId);
      setReview(result);
      setReviewId(result.reviewId ?? null);
      setRestoredBanner(null);
      setTyped("");
    } catch (error) {
      toast.push("neg", "Review failed", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!review) return;
    const patch = review.proposedPatch;
    setBusy("apply");
    try {
      const { riskRules, sectorCaps, ...policyRest } = patch.policy ?? {};
      // Same write path as every other strategy edit: PUT /api/policy. The server
      // deep-merges scoringWeights/riskRules; sectorCaps is whole-replace, so merge
      // over the current caps here to keep untouched sectors intact.
      await savePolicy({
        ...policyRest,
        ...(riskRules ? { riskRules } : {}),
        ...(sectorCaps ? { sectorCaps: { ...policy.sectorCaps, ...sectorCaps } } : {}),
        ...(patch.scoringWeights ? { scoringWeights: patch.scoringWeights } : {}),
        ...(patch.prompt ? { strategyPrompt: patch.prompt } : {})
      }, policy.connectedAccountId);
      await refresh();
      if (reviewId) resolveReviewSilently(reviewId, "applied");
      setReview(null);
      setReviewId(null);
      setRestoredBanner(null);
      setTyped("");
      toast.push("pos", "Review changes applied", "Takes effect on the next run.");
    } catch (error) {
      toast.push("neg", "Not applied", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title="AI review"
      action={
        review ? (
          <Btn variant="ghost" size="sm" disabled={busy !== null} onClick={discard}>
            Discard
          </Btn>
        ) : undefined
      }
    >
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        A strategist model reads this account&apos;s recent performance, missed opportunities, factor evidence, and the
        market backdrop, then proposes prompt/weight/guardrail changes. Nothing is applied until you review the exact
        diff and commit it — the same rules as editing by hand, including a typed word for LIVE authority expansion.
      </p>

      {review && restoredBanner && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2 text-[length:var(--con-fs-xs)]">
          <span>
            Restored unapplied review from <Ago iso={restoredBanner.createdAt} /> ({restoredBanner.model}).
          </span>
          <Btn
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              if (reviewId) resolveReviewSilently(reviewId, "dismissed");
              setReview(null);
              setReviewId(null);
              setRestoredBanner(null);
              setTyped("");
            }}
          >
            Dismiss
          </Btn>
        </div>
      )}

      {!review ? (
        <div className="flex flex-col gap-3">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Strategist"
              hint={
                rotationBlocksInheritance
                  ? "Both team seats rotate, so there is no single model to inherit.  Pick a strategist model here — left blank, the review runs on local rules (no LLM)."
                  : `Blank = same as ${inheritedReviewerLabel}.  AI Review has no separate account-level model.`
              }
              htmlFor="ai-review-model"
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <Select
                    id="ai-review-model"
                    value={model}
                    onChange={(e) => {
                      const nextModel = e.target.value;
                      setModel(nextModel);
                      setReviewReasoning(nextModel ? recommendedReasoningEffortForModel(nextModel, "review") : undefined);
                    }}
                  >
                    <option value="">
                      {rotationBlocksInheritance ? "No model — local rules (no LLM)" : `Same As ${inheritedReviewerLabel}`}
                    </option>
                    {CURATED_LLM_MODEL_GROUPS.map((group) => (
                      <optgroup key={group.provider} label={group.label}>
                        {group.options.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </Select>
                </div>
                <ModelStatsButton role="strategist" />
              </div>
            </Field>
            {reviewerReasoningControl && reviewerReasoningValue && (
              <div>
                <Field label={reviewerReasoningControl.label} hint={reviewerReasoningControl.hint} htmlFor="ai-review-effort">
                  <Select
                    id="ai-review-effort"
                    value={reviewerReasoningValue}
                    onChange={(e) => setReviewReasoning(e.target.value as LlmReasoningEffort)}
                  >
                    {reviewerReasoningControl.options.map((option) => (
                      <option key={option.value} value={option.value} title={option.hint}>
                        {option.label}
                        {option.value === recommendedReasoningEffortForModel(reviewerModel, "review") ? " — recommended" : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
                {reviewerAdvice && (
                  <p className="mt-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">{reviewerAdvice}</p>
                )}
              </div>
            )}
          </div>
          <div className="flex justify-end">
            <Btn variant="primary" disabled={busy !== null} onClick={() => void generate()}>
              {busy === "review" ? "Reviewing…" : "Generate review"}
            </Btn>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-[length:var(--con-fs-sm)]">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={review.generatedBy === "llm" ? "accent" : "muted"}>
              {review.generatedBy === "llm" ? "LLM review" : "local rules (no LLM)"}
            </Chip>
            <span className="con-num text-[color:var(--con-muted)]">Confidence {review.confidenceScore}/100</span>
          </div>
          <p className="leading-relaxed">{review.summary}</p>
          {review.rationale && <p className="leading-relaxed text-[color:var(--con-muted)]">{review.rationale}</p>}
          {(review.marketContext || review.performanceReadout) && (
            <details className="con-disclosure">
              <summary>Evidence the reviewer saw</summary>
              <div className="flex flex-col gap-2 pb-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                {review.performanceReadout && <p>{review.performanceReadout}</p>}
                {review.marketContext && <p>{review.marketContext}</p>}
              </div>
            </details>
          )}
          {review.cautions.length > 0 && (
            <ul className="list-disc pl-4 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">
              {review.cautions.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}

          {/* The diff — exactly what Apply would write. */}
          <div className="rounded-control border border-[color:var(--con-line)] p-3">
            <div className="con-card-title mb-1">Proposed changes</div>
            {!hasAnyChange ? (
              <p className="text-[color:var(--con-muted)]">No changes proposed — the reviewer left everything as is.</p>
            ) : (
              <div className="flex flex-col divide-y divide-[color:var(--con-line)]">
                {promptChanged && (
                  <details className="con-disclosure">
                    <summary>Prompt rewrite proposed</summary>
                    <div className="grid gap-2 pb-2 sm:grid-cols-2">
                      <div>
                        <div className="con-card-title mb-1">Current</div>
                        <pre className="con-mono max-h-48 overflow-auto whitespace-pre-wrap rounded-control bg-[color:var(--con-surface-2)] p-2 text-[length:var(--con-fs-2xs)] leading-relaxed">{strategyPrompt}</pre>
                      </div>
                      <div>
                        <div className="con-card-title mb-1">Proposed</div>
                        <pre className="con-mono max-h-48 overflow-auto whitespace-pre-wrap rounded-control bg-[color:var(--con-surface-2)] p-2 text-[length:var(--con-fs-2xs)] leading-relaxed">{review.proposedPatch.prompt}</pre>
                      </div>
                    </div>
                  </details>
                )}
                {changes.map((c) => (
                  <div key={c.key} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="font-semibold">{c.label}</span>
                    <span className="con-num flex items-center gap-2">
                      <span className="text-[color:var(--con-faint)]">{c.from}</span>
                      <span className="text-[color:var(--con-faint)]">→</span>
                      <span>{c.to}</span>
                      <ReviewDirectionTag direction={c.direction} />
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {hasAnyChange &&
            (needsTyped ? (
              <TypedConfirm
                phrase="CONFIRM"
                value={typed}
                onChange={setTyped}
                busy={busy === "apply"}
                variant="primary"
                confirmLabel={
                  <>
                    Apply review changes <LiveTag />
                  </>
                }
                note="At least one proposed change expands authority on a brokerage account.  Unlocking authority costs a typed word here exactly like it does in Guardrails."
                onConfirm={() => void apply()}
              />
            ) : (
              <div className="flex justify-end gap-2">
                <Btn variant="ghost" disabled={busy !== null} onClick={discard}>
                  Discard
                </Btn>
                <Btn variant="primary" disabled={busy !== null} onClick={() => void apply()}>
                  {busy === "apply" ? "Applying…" : "Apply changes"}
                </Btn>
              </div>
            ))}
        </div>
      )}
    </Card>
  );
}
