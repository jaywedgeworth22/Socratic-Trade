// db-profiles.ts — strategy profiles (create/read/update/delete/activate),
// plus mergePolicy / normalizeScoringWeights helpers used only by this module
// and the re-exported getPolicy / setPolicy / getStrategyPrompt / setStrategyPrompt.
import "server-only";
import crypto from "crypto";
import { getDb, audit } from "./db";
import { getInternalSetting, getUserSetting, setInternalSetting, setUserSetting } from "./db-settings";
import { getActiveConnectedAccount, getConnectedAccount, listConnectedAccounts } from "./db-api-keys";
import { DEFAULT_POLICY, DEFAULT_SCORING_WEIGHTS, DEFAULT_STRATEGY_PROMPT } from "./defaults";
import type {
  ScoringWeights,
  StrategyProfile,
  TradingPolicy
} from "./types";
import { invalidateDashboardSnapshotCache } from "./dashboard-snapshot-cache";

// ── User-level vs account-level policy field split ─────────────────────────────
// User-level fields are stored in user_settings.policy and overlaid on top of the
// account-level base on every read. Account-level fields live in account_strategy_state.
// New additions must be added to the set below to ensure they land in the correct store.

const USER_LEVEL_POLICY_FIELDS = new Set<keyof TradingPolicy>([
  "notificationSettings",
  "marketScanCandidateLimit",
  "marketScanOutlierReserve",
  // The daily learning review runs ONCE per user per day over user-level learned
  // context (runDailyLearningReviewIfDue keys on userId, not account), so its
  // config is user-level too — enabling/configuring it applies to your whole
  // login, and the job reads the same setting regardless of which account is
  // loaded when the scheduler ticks. (Was account-scoped in #1116; corrected.)
  "learningReviewEnabled",
  "learningReviewMode",
  "learningReviewModel",
  "learningReviewReasoningEffort",
  "learningReviewMinNewLessons",
  "learningReviewMaxWaitDays",
  // Typed confirmation for high-impact live actions is an OWNER preference, not a
  // per-account guardrail: the owner either wants the phrase ceremony or they don't,
  // regardless of which account the action targets (Settings IA restructure,
  // 2026-07-10). Was account-scoped before; promotion supersedes any divergent
  // per-account values — reads strip it from account rows, and with no user-level
  // value stored yet it falls back to the DEFAULT_POLICY value (true = required),
  // the safe direction. No legacy seed on purpose (sole-user, no compat tax).
  "requireTypedConfirmation",
  "fmpRealTimeDataEnabled",
  "fmpMacroDataEnabled",
  "fmpEventsDataEnabled",
  "fmpFundamentalsDataEnabled"
]);

const LEGACY_STRATEGY_MODEL_FIELDS: Array<keyof TradingPolicy> = ["llmModel", "redTeamLlmModel", "llmReasoningEffort"];

/** The learning-review subset of USER_LEVEL_POLICY_FIELDS (used by the one-time legacy seed below). */
const LEARNING_REVIEW_POLICY_FIELDS: Array<keyof TradingPolicy> = [
  "learningReviewEnabled",
  "learningReviewMode",
  "learningReviewModel",
  "learningReviewReasoningEffort",
  "learningReviewMinNewLessons",
  "learningReviewMaxWaitDays"
];

/**
 * Global-settings key (per-user) marking that the one-time legacy learning-review seed has been
 * evaluated for this user. Lives in the global `settings` store (getInternalSetting), mirroring
 * the learning-review runner's own markers (`learning_review:lastRunDate:<userId>`, …); the
 * userId suffix keeps it per-user. Once set, the seed never re-runs — see seedLegacyLearningReviewFields.
 */
function learningReviewLegacySeedKey(userId: string): string {
  return `learning_review:legacySeedDone:${userId}`;
}

/** Extract only the user-level fields from a TradingPolicy. */
function pickUserFields(policy: TradingPolicy): Partial<TradingPolicy> {
  const result: Partial<TradingPolicy> = {};
  for (const key of USER_LEVEL_POLICY_FIELDS) {
    if (key in policy) {
      (result as Record<string, unknown>)[key as string] = policy[key];
    }
  }
  return result;
}

/** Extract only the account-level fields from a TradingPolicy (everything NOT in USER_LEVEL_POLICY_FIELDS). */
function pickAccountFields(policy: TradingPolicy): Partial<TradingPolicy> {
  const result: Partial<TradingPolicy> = {};
  for (const key of Object.keys(policy) as Array<keyof TradingPolicy>) {
    if (!USER_LEVEL_POLICY_FIELDS.has(key) && key !== "scoringWeights") {
      (result as Record<string, unknown>)[key as string] = policy[key];
    }
  }
  // scoringWeights are already handled inside mergePolicy, write them to the account policy
  if (policy.scoringWeights) {
    result.scoringWeights = policy.scoringWeights;
  }
  return result;
}

/** Drop user-level fields from legacy account rows before applying the user-level overlay. */
function stripUserFields(policy: Partial<TradingPolicy>): Partial<TradingPolicy> {
  const result: Partial<TradingPolicy> = { ...policy };
  for (const key of USER_LEVEL_POLICY_FIELDS) {
    delete result[key];
  }
  return result;
}

/**
 * One-time lazy seed (#1278 follow-up, deferred finding #3): the learning-review config shipped
 * account-scoped (#1116) and is user-level now. Reads strip learningReview* from account rows and
 * pre-#1278 tiered saves never wrote those keys to user_settings.policy, so a review enabled before
 * this deploy would silently read as disabled. On the first read after the cutover we copy the
 * account-level value up to user_settings.policy — the reverse-direction companion of
 * migrateLegacyStrategyModelFieldsToAccounts. Returns the seeded fields, or null when there was
 * nothing to seed.
 *
 * TWO guards, because the earlier "bail whenever any review key is already present" was wrong and a
 * naive replacement is dangerous (finding #3):
 *
 *  1. Full-blob vs tiered disambiguation. `user_settings.policy` historically also held a FULL
 *     policy blob (a profile activation via writePolicyBlobPreservingUserFields, a no-account
 *     setPolicy, or a pre-tier DB) that stamps the DEFAULT learningReviewEnabled:false there while
 *     the user's real ENABLED value lived account-scoped. So a review key being *present* does not
 *     mean it is authoritative. A modern TIERED write (pickUserFields → setUserSetting) contains
 *     ONLY user-level keys; a full blob also carries account-level keys. A review key in a tiered
 *     blob is the user's real post-cutover value (leave it); the same key in a full blob is a stale
 *     default (seed over it).
 *  2. One-time marker (the load-bearing guard). Pre-cutover, learningReview* was never a user-level
 *     field, so it could not reach a tiered blob — meaning on the FIRST read a present review key
 *     can only be a stale full-blob default, never a deliberate choice. The marker pins the decision
 *     to that pre-cutover state: after the user starts making post-cutover changes, a deliberate
 *     tiered disable can be folded back into a full blob (the next profile activation runs
 *     writePolicyBlobPreservingUserFields), making its false indistinguishable from a stale default
 *     — but by then the marker is set (the first read necessarily precedes any deliberate change),
 *     so the seed never re-fires and never clobbers that intent.
 */
function seedLegacyLearningReviewFields(userId: string, stored: Partial<TradingPolicy>): Partial<TradingPolicy> | null {
  if (getInternalSetting<boolean>(learningReviewLegacySeedKey(userId)) === true) return null;
  const seeded = computeLegacyLearningReviewSeed(userId, stored);
  // Set unconditionally, whether or not anything was seeded: the seed is a one-shot cutover
  // migration that must evaluate only the pre-deploy DB state (guard #2 above).
  setInternalSetting(learningReviewLegacySeedKey(userId), true);
  return seeded;
}

function computeLegacyLearningReviewSeed(userId: string, stored: Partial<TradingPolicy>): Partial<TradingPolicy> | null {
  // Guard #1: a review key sitting in a TIERED write (only user-level keys present) is the user's
  // authoritative value — never overwrite it. A review key in a FULL blob (account-level keys also
  // present) only stamped the default there; the real value still lives account-scoped, so seed.
  const hasReviewKey = LEARNING_REVIEW_POLICY_FIELDS.some((key) => key in stored);
  const isTieredWrite = Object.keys(stored).every((key) => USER_LEVEL_POLICY_FIELDS.has(key as keyof TradingPolicy));
  if (hasReviewKey && isTieredWrite) return null;
  // Iterate accounts as listed — the legacy seed must NOT depend on the active-account (view)
  // pointer (PR #7 view/execution decouple guard, test/pr7-merge-gate.test.ts). Learning-review
  // config is user-level intent that happened to ship account-scoped (#1116), so any account
  // that carries it is an equally valid source; first-with-keys wins.
  for (const account of listConnectedAccounts(userId)) {
    const state = getAccountStrategyStateRow(userId, account.id);
    if (!state) continue;
    let accountPolicy: Partial<TradingPolicy>;
    try {
      accountPolicy = JSON.parse(state.policy) as Partial<TradingPolicy>;
    } catch {
      continue;
    }
    const found: Partial<TradingPolicy> = {};
    for (const key of LEARNING_REVIEW_POLICY_FIELDS) {
      if (key in accountPolicy) {
        (found as Record<string, unknown>)[key as string] = accountPolicy[key];
      }
    }
    if (Object.keys(found).length > 0) {
      // Persist onto the SAME stored object so a legacy full blob stays intact —
      // readLegacyStrategyModelFields still reads llmModel/redTeamLlmModel/llmReasoningEffort from it.
      setUserSetting(userId, "policy", { ...stored, ...found });
      return found;
    }
  }
  return null;
}

/** Read user-level policy fields from user_settings and return them as a partial policy. */
function readUserPolicyFields(userId: string): Partial<TradingPolicy> {
  const raw = getUserSetting<Partial<TradingPolicy>>(userId, "policy", {});
  let stored: Partial<TradingPolicy> = raw && typeof raw === "object" ? raw : {};
  // Legacy learning-review settings (account-scoped in #1116) seed into user_settings on
  // first read after the user-level cutover, so an already-enabled review survives the deploy.
  const seeded = seedLegacyLearningReviewFields(userId, stored);
  if (seeded) stored = { ...stored, ...seeded };
  // Only pluck the known user-level fields from whatever is stored (backward-compat:
  // existing DBs have the full policy in user_settings — we only care about user fields now).
  const result: Partial<TradingPolicy> = {};
  for (const key of USER_LEVEL_POLICY_FIELDS) {
    if (key in stored) {
      (result as Record<string, unknown>)[key as string] = stored[key];
    }
  }
  return result;
}

/** Back-compat seed for accounts written before Strategy Studio became account-scoped. */
function readLegacyStrategyModelFields(userId: string): Partial<TradingPolicy> {
  const stored = getUserSetting<Partial<TradingPolicy>>(userId, "policy", {});
  if (!stored || typeof stored !== "object") return {};
  const result: Partial<TradingPolicy> = {};
  for (const key of LEGACY_STRATEGY_MODEL_FIELDS) {
    if (key in stored) {
      (result as Record<string, unknown>)[key as string] = stored[key];
    }
  }
  return result;
}

function withLegacyStrategyModelSeed(userId: string, policy: Partial<TradingPolicy>): Partial<TradingPolicy> {
  return missingLegacyStrategySeed(userId, policy).policy;
}

function missingLegacyStrategySeed(userId: string, policy: Partial<TradingPolicy>): { policy: Partial<TradingPolicy>; changed: boolean } {
  const legacy = readLegacyStrategyModelFields(userId);
  let changed = false;
  const next: Partial<TradingPolicy> = { ...policy };
  for (const key of LEGACY_STRATEGY_MODEL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(legacy, key) && !Object.prototype.hasOwnProperty.call(next, key)) {
      (next as Record<string, unknown>)[key as string] = legacy[key];
      changed = true;
    }
  }
  return { policy: next, changed };
}

// ── Internal raw-row type ──────────────────────────────────────────────────────

type RawStrategyProfile = {
  id: string;
  name: string;
  policy: string;
  prompt: string;
  scoring_weights: string;
  active: number;
  created_at: string;
  updated_at: string;
};

// ── Policy/weight helpers (private to this module) ────────────────────────────

export function mergePolicy(policy: Partial<TradingPolicy>): TradingPolicy {
  // Strip legacy paperMode/dryRun/paperStartingCash keys that may still be present in old stored
  // JSON — these fields were removed. An account's own `environment` (paper/live) is now the sole
  // source of truth for execution mode; there is no policy-level override.
  const legacy = policy as Partial<TradingPolicy> & { dryRun?: boolean; paperMode?: boolean; paperStartingCash?: number };
  const { dryRun: _legacyDryRun, paperMode: _legacyPaperMode, paperStartingCash: _legacyPaperStartingCash, ...policyWithoutLegacyFields } = legacy;
  const merged: TradingPolicy = {
    ...DEFAULT_POLICY,
    ...policyWithoutLegacyFields,
    scoringWeights: normalizeScoringWeights(policy.scoringWeights ?? DEFAULT_POLICY.scoringWeights),
    sectorCaps: policy.sectorCaps ?? DEFAULT_POLICY.sectorCaps,
    riskRules: { ...DEFAULT_POLICY.riskRules, ...(policy.riskRules ?? {}) },
    // Deep-merge tuning like riskRules: a stored policy inherits NEW default tuning keys (e.g. the
    // 2026-07-28 guard enablement) while any key it explicitly set still wins. Keep identical to
    // the migrate-time copy in db.ts.
    tuning: { ...DEFAULT_POLICY.tuning, ...(policy.tuning ?? {}) },
    notificationSettings: {
      ...DEFAULT_POLICY.notificationSettings,
      ...(policy.notificationSettings ?? {}),
      enabledEvents:
        policy.notificationSettings?.enabledEvents ?? DEFAULT_POLICY.notificationSettings.enabledEvents
    }
  };
  // DEFAULT_POLICY now uses account-relative daily sizing. Preserve an older account's explicit
  // dollar mode instead of silently layering the new percent default on top; when both are truly
  // present, percent wins consistently with normalizeExclusivePolicyCaps and the UI.
  const explicitDailyPct = typeof policyWithoutLegacyFields.maxDailyPctOfNav === "number" && policyWithoutLegacyFields.maxDailyPctOfNav > 0;
  const explicitDailyNotional = typeof policyWithoutLegacyFields.maxDailyNotional === "number" && policyWithoutLegacyFields.maxDailyNotional > 0;
  if (explicitDailyPct) delete merged.maxDailyNotional;
  else if (explicitDailyNotional) delete merged.maxDailyPctOfNav;
  if ((merged.maxOrderNotional ?? 0) > 100_000) merged.maxOrderNotional = 100_000;
  // FMP module toggles are user-selectable again (owner 2026-08-06). Defaults stay false.
  // Direct FMP network remains hard-blocked in fmp-common / retired-direct-vendors until that
  // ban is lifted — toggles persist intent + future re-enable without another UI rewrite.
  return merged;
}

export function normalizeScoringWeights(weights: Partial<ScoringWeights>): ScoringWeights {
  return {
    ...DEFAULT_SCORING_WEIGHTS,
    ...Object.fromEntries(
      Object.entries(weights).map(([key, value]) => [key, Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0])
    )
  };
}

function toStrategyProfile(row: RawStrategyProfile): StrategyProfile {
  const scoringWeights = normalizeScoringWeights(JSON.parse(row.scoring_weights) as Partial<ScoringWeights>);
  const policy = mergePolicy({ ...(JSON.parse(row.policy) as Partial<TradingPolicy>), scoringWeights, activeProfileId: row.id });
  return {
    id: row.id,
    name: row.name,
    policy,
    prompt: row.prompt,
    scoringWeights,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// ── Per-account live strategy state (account_strategy_state) ──────────────────
// strategy_profiles is the user-level copyable LIBRARY; account_strategy_state is
// what a given connected account is actually running. Reads go through getPolicy
// (which prefers the account's live row); every effective-policy writer mirrors into
// it via copyPolicyConfigToActiveAccount (config only — never arms/disarms), so the
// live row never goes stale. Lazily seeded
// on first read so existing single-account users are byte-identical day one.

type RawAccountStrategyState = {
  policy: string;
  prompt: string | null;
  scoring_weights: string | null;
  system_state: string;
  derived_from_profile_id: string | null;
};

/** Resolve the account whose live state applies: an explicit id, else the active account. */
function resolveAccount(userId: string, connectedAccountId?: string) {
  if (connectedAccountId) return listConnectedAccounts(userId).find((a) => a.id === connectedAccountId);
  return getActiveConnectedAccount(userId);
}

function getAccountStrategyStateRow(userId: string, connectedAccountId: string): RawAccountStrategyState | undefined {
  return getDb()
    .prepare(
      "SELECT policy, prompt, scoring_weights, system_state, derived_from_profile_id FROM account_strategy_state WHERE user_id = ? AND connected_account_id = ?"
    )
    .get(userId, connectedAccountId) as RawAccountStrategyState | undefined;
}

function writeAccountStrategyState(
  userId: string,
  connectedAccountId: string,
  args: { policy: TradingPolicy; prompt: string; scoringWeights: ScoringWeights; derivedFromProfileId?: string | null }
): void {
  getDb()
    .prepare(
      `INSERT INTO account_strategy_state
         (user_id, connected_account_id, policy, prompt, scoring_weights, system_state, derived_from_profile_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, connected_account_id) DO UPDATE SET
         policy = excluded.policy, prompt = excluded.prompt, scoring_weights = excluded.scoring_weights,
         system_state = excluded.system_state,
         derived_from_profile_id = COALESCE(excluded.derived_from_profile_id, account_strategy_state.derived_from_profile_id),
         updated_at = excluded.updated_at`
    )
    .run(
      userId,
      connectedAccountId,
      JSON.stringify(args.policy),
      args.prompt,
      JSON.stringify(args.scoringWeights),
      args.policy.systemState,
      args.derivedFromProfileId ?? null,
      new Date().toISOString()
    );
}

function updateAccountStrategyPolicy(
  userId: string,
  connectedAccountId: string,
  policy: TradingPolicy,
  scoringWeights: ScoringWeights
): void {
  getDb()
    .prepare(
      "UPDATE account_strategy_state SET policy = ?, scoring_weights = ?, system_state = ?, updated_at = ? WHERE user_id = ? AND connected_account_id = ?"
    )
    .run(JSON.stringify(policy), JSON.stringify(scoringWeights), policy.systemState, new Date().toISOString(), userId, connectedAccountId);
}

/**
 * Mirror the user's new effective policy/prompt into the ACTIVE account's live state.
 * Called by every effective-policy writer so account_strategy_state never goes stale.
 * No-op when there is no active connected account (legacy single-context behavior).
 */
function copyPolicyConfigToActiveAccount(
  userId: string,
  policy: TradingPolicy,
  prompt: string,
  scoringWeights: ScoringWeights,
  derivedFromProfileId?: string | null
): void {
  const account = getActiveConnectedAccount(userId);
  if (!account) return;
  // PR #7: propagate strategy CONFIG (prompt/weights/caps) to the active account,
  // but NEVER arm or disarm it as a side-effect of a library-profile edit — preserve
  // the account's own run-state (systemState) and authority mode (strategyAuthority).
  // This mirrors applyProfileToAccount's per-account autonomy guard; arming stays an
  // explicit per-account action. peekPolicy is read-only (no seeding) and returns the
  // fail-closed floor for a fresh account.
  const current = peekPolicy(userId, account.id);
  writeAccountStrategyState(userId, account.id, {
    policy: { ...policy, systemState: current.systemState, strategyAuthority: current.strategyAuthority },
    prompt,
    scoringWeights,
    derivedFromProfileId
  });
}

function migrateLegacyStrategyModelFieldsToAccounts(userId: string): void {
  const legacy = readLegacyStrategyModelFields(userId);
  if (LEGACY_STRATEGY_MODEL_FIELDS.every((key) => !Object.prototype.hasOwnProperty.call(legacy, key))) return;

  const accounts = listConnectedAccounts(userId);
  if (accounts.length === 0) return;

  for (const account of accounts) {
    const state = getAccountStrategyStateRow(userId, account.id);
    if (state) {
      const stored = stripUserFields(JSON.parse(state.policy) as Partial<TradingPolicy>);
      const seeded = missingLegacyStrategySeed(userId, stored);
      if (!seeded.changed) continue;
      const scoringWeights = normalizeScoringWeights(
        (state.scoring_weights ? JSON.parse(state.scoring_weights) : seeded.policy.scoringWeights ?? {}) as Partial<ScoringWeights>
      );
      updateAccountStrategyPolicy(userId, account.id, mergePolicy({ ...seeded.policy, scoringWeights }), scoringWeights);
      continue;
    }

    let policy = getBasePolicy(userId);
    // PR #7: view/execution decouple. A freshly-seeded account never inherits an
    // "active" (armed) run-state — fail-closed to "halted" regardless of which
    // account is the view pointer. (Previously the seed compared against the active
    // account pointer, coupling the seed to the ephemeral view. Arming is now an
    // explicit per-account action; boot-reset (reconcileAutonomyOnBoot) is the other guard.)
    if (policy.systemState === "active") {
      policy = { ...policy, systemState: "halted" };
    }
    writeAccountStrategyState(userId, account.id, {
      policy,
      prompt: getStrategyPrompt(userId, account.id),
      scoringWeights: policy.scoringWeights,
      derivedFromProfileId: policy.activeProfileId ?? null
    });
  }
}

/** Write only the user-level fields of a policy to user_settings.policy. */
function writeUserPolicyFields(userId: string, policy: TradingPolicy, emitAudit = true): void {
  migrateLegacyStrategyModelFieldsToAccounts(userId);
  const userFields = pickUserFields(policy);
  setUserSetting(userId, "policy", userFields, { auditPolicyChange: emitAudit });
}

/** The user-level base policy (active library profile, else legacy user_settings). */
function getBasePolicy(userId: string): TradingPolicy {
  const active = getActiveStrategyProfile(userId);
  if (active) return mergePolicy({ ...active.policy, activeProfileId: active.id });
  return mergePolicy(getUserSetting(userId, "policy", DEFAULT_POLICY));
}

function setSettingDirect(userId: string, key: string, value: unknown, updatedAt: string): void {
  getDb()
    .prepare(
      "INSERT INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
    .run(`${userId}_${key}`, userId, key, JSON.stringify(value), updatedAt);
}

/**
 * Write a full policy blob to user_settings.policy while PRESERVING the currently stored
 * user-level fields (notification prefs, market-scan breadth, learning-review config).
 * Profile create/update/activate write the whole profile policy here, and profile rows carry
 * stripped-to-default values for the user-level keys (setPolicy syncs profiles through
 * pickAccountFields + mergePolicy) — without this overlay, activating or editing the active
 * profile would silently reset the user's review/notification/scan settings to defaults.
 */
function writePolicyBlobPreservingUserFields(userId: string, policy: TradingPolicy, updatedAt: string): void {
  setSettingDirect(userId, "policy", mergePolicy({ ...policy, ...readUserPolicyFields(userId) }), updatedAt);
}

function syncActiveProfile(patch: { policy?: TradingPolicy; prompt?: string; scoringWeights?: ScoringWeights }, userId: string = "local"): void {
  const active = getActiveStrategyProfile(userId);
  if (!active) return;
  const policy = patch.policy ? mergePolicy({ ...patch.policy, activeProfileId: active.id }) : active.policy;
  const prompt = patch.prompt ?? active.prompt;
  const scoringWeights = patch.scoringWeights ?? policy.scoringWeights;
  getDb()
    .prepare("UPDATE strategy_profiles SET policy = ?, prompt = ?, scoring_weights = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(JSON.stringify(policy), prompt, JSON.stringify(scoringWeights), new Date().toISOString(), active.id, userId);
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function getPolicy(userId: string = "local", connectedAccountId?: string): TradingPolicy {
  const account = resolveAccount(userId, connectedAccountId);
  let policy: TradingPolicy;

  if (account) {
    const state = getAccountStrategyStateRow(userId, account.id);
    if (state) {
      const stored = JSON.parse(state.policy) as Partial<TradingPolicy>;
      const scoringWeights = normalizeScoringWeights(
        (state.scoring_weights ? JSON.parse(state.scoring_weights) : stored.scoringWeights ?? {}) as Partial<ScoringWeights>
      );
      const seeded = missingLegacyStrategySeed(userId, stripUserFields(stored));
      policy = mergePolicy({ ...seeded.policy, scoringWeights });
      if (seeded.changed) {
        updateAccountStrategyPolicy(userId, account.id, policy, scoringWeights);
      }
    } else {
      policy = getBasePolicy(userId);
      // PR #7: fail-closed seed — a fresh account never auto-arms, independent of
      // the ephemeral active-account pointer (see migrateLegacyStrategyModelFieldsToAccounts).
      if (policy.systemState === "active") {
        policy = { ...policy, systemState: "halted" };
      }
      writeAccountStrategyState(userId, account.id, {
        policy,
        prompt: getStrategyPrompt(userId, account.id),
        scoringWeights: policy.scoringWeights,
        derivedFromProfileId: policy.activeProfileId ?? null
      });
    }
    // Overlay true user-level fields from user_settings.policy on top of the account base.
    // Provider keys, notification prefs, and market-scan breadth apply across accounts;
    // Strategy Studio settings (prompt/models/weights) remain account-scoped.
    const userFields = readUserPolicyFields(userId);
    policy = mergePolicy({ ...policy, ...userFields });
    policy.connectedAccountId = account.id;
    policy.activeBroker = account.broker;
    policy.accountNumber = account.accountNumber;
  } else {
    // No active account: the user-level overlay still applies. The base can be an active
    // library profile whose row carries stripped-to-default values for the user-level keys
    // (setPolicy syncs profiles via pickAccountFields + mergePolicy), so without the overlay
    // an enabled learning review / notification prefs would silently read as defaults the
    // moment the user has no active connected account (the scheduler reads getPolicy(userId)).
    // Idempotent for legacy full-blob users — the plucked keys come from the same blob.
    policy = mergePolicy({ ...getBasePolicy(userId), ...readUserPolicyFields(userId) });
  }

  return policy;
}

/**
 * Read-only policy projection for diagnostics. Never seeds `account_strategy_state`.
 * When no per-account row exists, returns the same effective policy `getPolicy` would
 * compute on first touch — without persisting it.
 */
export function peekPolicy(userId: string = "local", connectedAccountId?: string): TradingPolicy {
  const account = resolveAccount(userId, connectedAccountId);
  let policy: TradingPolicy;

  if (account) {
    const state = getAccountStrategyStateRow(userId, account.id);
    if (state) {
      const stored = JSON.parse(state.policy) as Partial<TradingPolicy>;
      const scoringWeights = normalizeScoringWeights(
        (state.scoring_weights ? JSON.parse(state.scoring_weights) : stored.scoringWeights ?? {}) as Partial<ScoringWeights>
      );
      policy = mergePolicy({ ...withLegacyStrategyModelSeed(userId, stripUserFields(stored)), scoringWeights });
    } else {
      policy = getBasePolicy(userId);
      // PR #7: fail-closed projection — mirrors the seed decouple in getPolicy so
      // peek never reports a fresh account as auto-armed via the active pointer.
      if (policy.systemState === "active") {
        policy = { ...policy, systemState: "halted" };
      }
    }
    policy.connectedAccountId = account.id;
    policy.activeBroker = account.broker;
    policy.accountNumber = account.accountNumber;
  } else {
    policy = getBasePolicy(userId);
  }

  return policy;
}

export function setPolicy(policy: TradingPolicy, userId: string = "local", connectedAccountId?: string): void {
  const merged = mergePolicy(policy);
  const account = resolveAccount(userId, connectedAccountId);

  if (account) {
    // ── Tiered write: user fields → user_settings, account fields → account_strategy_state ──
    writeUserPolicyFields(userId, merged, false);
    syncActiveProfile({ policy: pickAccountFields(merged) as TradingPolicy, scoringWeights: merged.scoringWeights }, userId);
    writeAccountStrategyState(userId, account.id, {
      policy: pickAccountFields(merged) as TradingPolicy,
      prompt: getStrategyPrompt(userId, account.id),
      scoringWeights: merged.scoringWeights
    });
    audit("policy_change", { userId, key: "policy", value: merged }, userId, account.id);
  } else {
    // ── No connected account: store the full policy in user_settings (backward compat) ──
    // Users without a connected account (legacy single-user mode) keep the old behaviour:
    // the full policy is stored as a single blob under user_settings.policy.
    setUserSetting(userId, "policy", merged, { auditPolicyChange: false });
    syncActiveProfile({ policy: merged, scoringWeights: merged.scoringWeights }, userId);
    audit("policy_change", { userId, key: "policy", value: merged }, userId);
  }
  // C1: policy changes materialize in the next dashboard snapshot — drop the short TTL cache.
  invalidateDashboardSnapshotCache(userId);
}

export function getStrategyPrompt(userId: string = "local", connectedAccountId?: string): string {
  const account = resolveAccount(userId, connectedAccountId);
  if (account) {
    const state = getAccountStrategyStateRow(userId, account.id);
    if (state?.prompt != null) return state.prompt;
  }
  return getActiveStrategyProfile(userId)?.prompt ?? getUserSetting(userId, "strategyPrompt", DEFAULT_STRATEGY_PROMPT);
}

export function setStrategyPrompt(prompt: string, userId: string = "local", connectedAccountId?: string): void {
  setUserSetting(userId, "strategyPrompt", prompt, { auditPolicyChange: false });
  syncActiveProfile({ prompt }, userId);
  const account = resolveAccount(userId, connectedAccountId);
  if (account) {
    const base = getPolicy(userId, account.id);
    writeAccountStrategyState(userId, account.id, { policy: base, prompt, scoringWeights: base.scoringWeights });
    audit("policy_change", { userId, key: "strategyPrompt", value: prompt }, userId, account.id);
  } else {
    audit("policy_change", { userId, key: "strategyPrompt", value: prompt }, userId);
  }
}

export function listStrategyProfiles(userId: string = "local"): StrategyProfile[] {
  const rows = getDb()
    .prepare("SELECT id, name, policy, prompt, scoring_weights, active, created_at, updated_at FROM strategy_profiles WHERE user_id = ? ORDER BY active DESC, name ASC")
    .all(userId) as RawStrategyProfile[];
  return rows.map(toStrategyProfile);
}

export function getActiveStrategyProfile(userId: string = "local"): StrategyProfile | undefined {
  const row = getDb()
    .prepare("SELECT id, name, policy, prompt, scoring_weights, active, created_at, updated_at FROM strategy_profiles WHERE active = 1 AND user_id = ? LIMIT 1")
    .get(userId) as RawStrategyProfile | undefined;
  return row ? toStrategyProfile(row) : undefined;
}

export function createStrategyProfile(input: { name: string; policy?: Partial<TradingPolicy>; prompt?: string; active?: boolean }, userId: string = "local"): StrategyProfile {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const currentPolicy = getPolicy(userId);
  const policy = mergePolicy({ ...currentPolicy, ...(input.policy ?? {}), activeProfileId: id });
  const prompt = input.prompt ?? getStrategyPrompt(userId);
  const database = getDb();
  const create = database.transaction(() => {
    if (input.active) database.prepare("UPDATE strategy_profiles SET active = 0, updated_at = ? WHERE user_id = ?").run(now, userId);
    database
      .prepare(
        "INSERT INTO strategy_profiles (id, user_id, name, policy, prompt, scoring_weights, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, userId, input.name, JSON.stringify(policy), prompt, JSON.stringify(policy.scoringWeights), input.active ? 1 : 0, now, now);
  });
  create();
  if (input.active) {
    writePolicyBlobPreservingUserFields(userId, policy, now);
    setSettingDirect(userId, "strategyPrompt", prompt, now);
    copyPolicyConfigToActiveAccount(userId, policy, prompt, policy.scoringWeights, id);
  }
  audit("profile_change", { action: "create", id, name: input.name, active: Boolean(input.active) }, userId);
  return getStrategyProfile(id, userId)!;
}

export function getStrategyProfile(id: string, userId: string = "local"): StrategyProfile | undefined {
  const row = getDb()
    .prepare("SELECT id, name, policy, prompt, scoring_weights, active, created_at, updated_at FROM strategy_profiles WHERE id = ? AND user_id = ?")
    .get(id, userId) as RawStrategyProfile | undefined;
  return row ? toStrategyProfile(row) : undefined;
}

export function updateStrategyProfile(id: string, patch: { name?: string; policy?: Partial<TradingPolicy>; prompt?: string; scoringWeights?: Partial<ScoringWeights> }, userId: string = "local"): StrategyProfile {
  const existing = getStrategyProfile(id, userId);
  if (!existing) throw new Error("Strategy profile not found.");
  const now = new Date().toISOString();
  const scoringWeights = normalizeScoringWeights({ ...existing.scoringWeights, ...(patch.scoringWeights ?? {}) });
  const policy = mergePolicy({ ...existing.policy, ...(patch.policy ?? {}), scoringWeights, activeProfileId: id });
  const prompt = patch.prompt ?? existing.prompt;
  getDb()
    .prepare("UPDATE strategy_profiles SET name = ?, policy = ?, prompt = ?, scoring_weights = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(patch.name ?? existing.name, JSON.stringify(policy), prompt, JSON.stringify(scoringWeights), now, id, userId);
  if (existing.active) {
    writePolicyBlobPreservingUserFields(userId, policy, now);
    setSettingDirect(userId, "strategyPrompt", prompt, now);
    copyPolicyConfigToActiveAccount(userId, policy, prompt, scoringWeights, id);
  }
  audit("profile_change", { action: "update", id, name: patch.name ?? existing.name }, userId);
  return getStrategyProfile(id, userId)!;
}

export function activateStrategyProfile(id: string, userId: string = "local"): StrategyProfile {
  const profile = getStrategyProfile(id, userId);
  if (!profile) throw new Error("Strategy profile not found.");
  const now = new Date().toISOString();
  const database = getDb();
  const activate = database.transaction(() => {
    database.prepare("UPDATE strategy_profiles SET active = 0, updated_at = ? WHERE user_id = ?").run(now, userId);
    database.prepare("UPDATE strategy_profiles SET active = 1, updated_at = ? WHERE id = ? AND user_id = ?").run(now, id, userId);
    writePolicyBlobPreservingUserFields(userId, mergePolicy({ ...profile.policy, activeProfileId: id }), now);
    setSettingDirect(userId, "strategyPrompt", profile.prompt, now);
  });
  activate();
  // Activating a library strategy copies it into the active account's live state.
  copyPolicyConfigToActiveAccount(userId, mergePolicy({ ...profile.policy, activeProfileId: id }), profile.prompt, profile.policy.scoringWeights, id);
  audit("profile_change", { action: "activate", id, name: profile.name }, userId);
  return getStrategyProfile(id, userId)!;
}

/**
 * PR #7 — write-time account ownership guard (the real safety boundary). Every mutating write that
 * targets a specific connected account must re-validate that the account belongs to the session
 * `userId`. Session identity comes from the verified request header (never the body), so a stale or
 * malicious tab cannot act on an account the user does not own, regardless of the id it supplies.
 * Throws when the account is missing or owned by another user.
 */
export function assertConnectedAccountOwnedByUser(userId: string, connectedAccountId: string): void {
  if (!getConnectedAccount(connectedAccountId, userId)) {
    throw new Error("Connected account not found for this user.");
  }
}

/**
 * PR 2 — copy a saved library strategy into a CHOSEN account's live state (not just the active one,
 * which is what `activateStrategyProfile` does). The library profile and which account is active are
 * left untouched: this only writes the target account's `account_strategy_state` row, stamping
 * `derived_from_profile_id` so the provenance is recorded. Copy, not link — later edits to the
 * library profile do not retro-mutate the account.
 *
 * SAFETY: the target account's current run-state (`systemState`) and authority mode
 * (`strategyAuthority`) are preserved. Applying a strategy is a config change; it must
 * never arm autonomy on a halted account (nor disarm an active one), and must never flip
 * Autopilot on or off — mirroring the per-account autonomy-opt-in guard from PR 1.
 */
export function applyProfileToAccount(
  profileId: string,
  connectedAccountId: string,
  userId: string = "local"
): { profileId: string; connectedAccountId: string } {
  const profile = getStrategyProfile(profileId, userId);
  if (!profile) throw new Error("Strategy profile not found.");
  // PR #7: write-time accountId validation is the real safety boundary. A stale tab
  // cannot commit a write against an account the session user does not own, regardless
  // of the URL/body it supplies.
  assertConnectedAccountOwnedByUser(userId, connectedAccountId);

  const current = getPolicy(userId, connectedAccountId);
  const scoringWeights = normalizeScoringWeights(profile.policy.scoringWeights);
  const policy = mergePolicy({
    ...profile.policy,
    scoringWeights,
    systemState: current.systemState,
    strategyAuthority: current.strategyAuthority,
    activeProfileId: profile.id
  });
  writeAccountStrategyState(userId, connectedAccountId, {
    policy,
    prompt: profile.prompt,
    scoringWeights,
    derivedFromProfileId: profile.id
  });
  audit(
    "profile_change",
    { action: "copy_to_account", id: profileId, name: profile.name, connectedAccountId },
    userId,
    connectedAccountId
  );
  return { profileId, connectedAccountId };
}

/** Distinguishes the expected failure modes of {@link importAccountSettings} so the calling route
 *  can map each to the correct HTTP status without fragile message-string matching. */
export type ImportAccountSettingsErrorCode = "same_account" | "not_found" | "no_source_state";

/** Thrown by {@link importAccountSettings} for every expected validation failure (never a generic
 *  Error, so callers can `instanceof`-check instead of parsing messages). */
export class ImportAccountSettingsError extends Error {
  readonly code: ImportAccountSettingsErrorCode;
  constructor(code: ImportAccountSettingsErrorCode, message: string) {
    super(message);
    this.name = "ImportAccountSettingsError";
    this.code = code;
  }
}

/** Account-identity TradingPolicy fields — always derived from the owning account's own row on
 *  every `getPolicy` read (see the overlay at the end of `getPolicy` above), never copyable data.
 *  Stripped from an imported policy so a stale source-account id can never sit in the target's
 *  stored JSON, mirroring the client-writable-field strip in `PUT /api/policy`. */
const ACCOUNT_IDENTITY_POLICY_FIELDS: Array<keyof TradingPolicy> = ["connectedAccountId", "accountNumber", "activeBroker"];

function stripIdentityFields(policy: Partial<TradingPolicy>): Partial<TradingPolicy> {
  const result: Partial<TradingPolicy> = { ...policy };
  for (const key of ACCOUNT_IDENTITY_POLICY_FIELDS) {
    delete result[key];
  }
  return result;
}

/**
 * Write an imported account_strategy_state row with a DIRECT (non-preserving) overwrite of
 * `derived_from_profile_id`. Unlike `writeAccountStrategyState` (whose ON CONFLICT clause COALESCEs
 * a missing/null value into the row's existing lineage — the right call for incidental policy edits
 * that shouldn't erase "which profile this account reflects"), an account-to-account import is a
 * deliberate full-replace action: the target's lineage must end up matching the source's, including
 * being cleared to NULL when the source itself has none. Leaving stale lineage behind would let the
 * target silently keep claiming derivation from a profile its just-overwritten config no longer
 * reflects.
 */
function writeImportedAccountStrategyState(
  userId: string,
  connectedAccountId: string,
  args: { policy: TradingPolicy; prompt: string; scoringWeights: ScoringWeights; derivedFromProfileId: string | null }
): void {
  getDb()
    .prepare(
      `INSERT INTO account_strategy_state
         (user_id, connected_account_id, policy, prompt, scoring_weights, system_state, derived_from_profile_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, connected_account_id) DO UPDATE SET
         policy = excluded.policy, prompt = excluded.prompt, scoring_weights = excluded.scoring_weights,
         system_state = excluded.system_state,
         derived_from_profile_id = excluded.derived_from_profile_id,
         updated_at = excluded.updated_at`
    )
    .run(
      userId,
      connectedAccountId,
      JSON.stringify(args.policy),
      args.prompt,
      JSON.stringify(args.scoringWeights),
      args.policy.systemState,
      args.derivedFromProfileId,
      new Date().toISOString()
    );
}

/**
 * Copy a CHOSEN connected account's own live strategy settings onto another CHOSEN connected
 * account (any→any — e.g. paper→live, or the reverse). Unlike `applyProfileToAccount` (which copies
 * a saved LIBRARY profile), this reads the SOURCE account's live `account_strategy_state` row and
 * writes it onto the TARGET account's row. Same "copy, not link" semantics: this is a one-time
 * snapshot — later edits to either account do not retro-mutate the other, and neither account's
 * identity, active-account pointer, or broker credentials are touched.
 *
 * SAFETY:
 *  - Both accounts must exist and belong to `userId` (write-time ownership re-validation, the PR #7
 *    pattern — see `assertConnectedAccountOwnedByUser`): a stale/malicious id can never read or
 *    target an account the session user does not own, and the failure looks identical whether the
 *    id is missing entirely or owned by someone else.
 *  - User-level fields (`USER_LEVEL_POLICY_FIELDS`) are stripped from the copied policy — those
 *    already apply identically to both accounts via the `getPolicy` overlay, so copying them
 *    account-to-account would duplicate user-scoped state into account-scoped storage.
 *  - Identity fields (`ACCOUNT_IDENTITY_POLICY_FIELDS`) are stripped — `getPolicy` always overwrites
 *    them from the target account's own row after read, but a stale source-account id must never sit
 *    in the target's stored JSON in the meantime.
 *  - The target's own `systemState` (active/halted/close_only/liquidating) and `strategyAuthority`
 *    (propose/decide) are preserved — importing settings is a config change, never an arm/disarm or
 *    Autopilot flip side effect, mirroring `applyProfileToAccount`.
 *
 * PROVENANCE DECISION: `derived_from_profile_id` is carried over from the SOURCE account's own value
 * (including clearing it to NULL when the source has none), rather than preserved from whatever the
 * target previously had. This extends `applyProfileToAccount`'s "record where this configuration
 * originated" philosophy through one more hop of copying, and — because an import is a deliberate
 * full-replace action, not an incidental edit — a target must not keep silently claiming lineage from
 * a profile its just-overwritten config no longer reflects.
 */
export function importAccountSettings(
  userId: string,
  sourceConnectedAccountId: string,
  targetConnectedAccountId: string
): TradingPolicy {
  if (sourceConnectedAccountId === targetConnectedAccountId) {
    throw new ImportAccountSettingsError("same_account", "Source and target accounts must be different.");
  }
  // Write-time ownership re-validation (PR #7 pattern): missing vs. owned-by-someone-else look
  // identical, so a probing request learns nothing about accounts it doesn't own.
  if (!getConnectedAccount(sourceConnectedAccountId, userId)) {
    throw new ImportAccountSettingsError("not_found", "Source connected account not found for this user.");
  }
  if (!getConnectedAccount(targetConnectedAccountId, userId)) {
    throw new ImportAccountSettingsError("not_found", "Target connected account not found for this user.");
  }

  const sourceState = getAccountStrategyStateRow(userId, sourceConnectedAccountId);
  if (!sourceState) {
    throw new ImportAccountSettingsError("no_source_state", "Source connected account has no strategy settings to import yet.");
  }

  const sourcePolicyRaw = JSON.parse(sourceState.policy) as Partial<TradingPolicy>;
  const sourceScoringWeights = normalizeScoringWeights(
    (sourceState.scoring_weights ? JSON.parse(sourceState.scoring_weights) : sourcePolicyRaw.scoringWeights ?? {}) as Partial<ScoringWeights>
  );
  const derivedFromProfileId = sourceState.derived_from_profile_id ?? null;

  // peekPolicy (not getPolicy): read-only, never seeds/writes — we are about to write the target's
  // row ourselves right below, mirroring copyPolicyConfigToActiveAccount's same "about to overwrite
  // it anyway" use of peekPolicy.
  const targetPolicy = peekPolicy(userId, targetConnectedAccountId);

  const cleaned = stripIdentityFields(stripUserFields(sourcePolicyRaw));
  const policy = mergePolicy({
    ...cleaned,
    scoringWeights: sourceScoringWeights,
    systemState: targetPolicy.systemState, // Guard: preserve target lifecycle state
    strategyAuthority: targetPolicy.strategyAuthority, // Guard: preserve target autonomy
    activeProfileId: derivedFromProfileId ?? undefined
  });

  writeImportedAccountStrategyState(userId, targetConnectedAccountId, {
    policy,
    prompt: sourceState.prompt ?? DEFAULT_STRATEGY_PROMPT,
    scoringWeights: sourceScoringWeights,
    derivedFromProfileId
  });

  audit(
    "profile_change",
    { action: "import_from_account", sourceConnectedAccountId, targetConnectedAccountId },
    userId,
    targetConnectedAccountId
  );

  return getPolicy(userId, targetConnectedAccountId);
}

/**
 * Delete a strategy profile owned by `userId`.
 *
 * Decision (M3, 2026-06-21): if the deleted profile was the active one, the active flag is
 * reassigned to the OLDEST remaining profile (by created_at). If there are no remaining profiles
 * the user is left with none active — callers should create a new profile in that case.
 * The function throws if the profile does not exist or does not belong to `userId`.
 */
export function deleteStrategyProfile(id: string, userId: string = "local"): void {
  const existing = getStrategyProfile(id, userId);
  if (!existing) throw new Error("Strategy profile not found.");
  const database = getDb();
  const now = new Date().toISOString();
  const wasActive = existing.active;
  const del = database.transaction(() => {
    database.prepare("DELETE FROM strategy_profiles WHERE id = ? AND user_id = ?").run(id, userId);
    if (wasActive) {
      // Reassign the active flag to the oldest remaining profile for this user.
      database
        .prepare(
          "UPDATE strategy_profiles SET active = 1, updated_at = ? WHERE id = (SELECT id FROM strategy_profiles WHERE user_id = ? ORDER BY created_at ASC LIMIT 1)"
        )
        .run(now, userId);
    }
  });
  del();
  audit("profile_change", { action: "delete", id, name: existing.name, wasActive }, userId);
}
