// learning-review.test.ts — the daily LLM learning-review job (src/lib/learning-review.ts).
//
// Covers the pure/deterministic parts per the repo convention (temp SQLite per run, no network):
//   - once-per-day dedup (isLearningReviewDue + marker advance, incl. on failure)
//   - verdict schema parsing/validation (parseLearningReviewVerdicts)
//   - mode gating: "annotate" NEVER mutates; "decide" applies via the existing learned-context
//     mutation paths; any LLM failure NEVER mutates.
// The LLM itself is injected through runDailyLearningReview's `llm` seam — no transport is hit.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { LearnedContextPendingRow, LearnedContextRow } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-learning-review-${randomUUID()}.db`)}`;
});

import {
  activateStrategyProfile,
  createStrategyProfile,
  deleteConnectedAccount,
  getDb,
  getPendingLearnedContext,
  getPolicy,
  insertLearnedContext,
  insertPendingLearnedContext,
  listAuditByKind,
  listLearnedContext,
  listLearnedContextForDecision,
  setPolicy,
  setUserSetting,
  updateStrategyProfile,
  upsertConnectedAccount
} from "../src/lib/db";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import {
  applyLearningReviewVerdicts,
  buildLearningReviewContextPack,
  evaluateLearningReviewTrigger,
  isLearningReviewDue,
  PAPER_ACCOUNT_LEARNING_PARITY_RULE,
  parseLearningReviewVerdicts,
  runDailyLearningReview,
  runDailyLearningReviewIfDue,
  type LearningReviewVerdict
} from "../src/lib/learning-review";

const NOW = Date.now();

function seedLearnedRow(userId: string, overrides: Partial<LearnedContextRow> = {}): LearnedContextRow {
  const row: LearnedContextRow = {
    id: randomUUID(),
    userId,
    scope: "private",
    kind: "pattern",
    subject: `track_record:test-${randomUUID().slice(0, 8)}`,
    symbol: "MU",
    value: 'The "momentum-breakout" thesis has repeatedly lost on a realized basis.',
    source: "inferred",
    origin: "autonomous",
    riskTier: "fact",
    confidence: 0.6,
    contributorUserId: userId,
    assertedAt: new Date(NOW - 2 * 86_400_000).toISOString(),
    supersededBy: null,
    expiresAt: null,
    ...overrides,
    connectedAccountId: overrides.connectedAccountId ?? null,
    accountEnvironment: overrides.accountEnvironment ?? null,
    learningScope: overrides.learningScope ?? "portfolio",
    transferState: overrides.transferState ?? "not_applicable"
  };
  insertLearnedContext(row);
  return row;
}

function seedPendingRow(userId: string, overrides: Partial<LearnedContextPendingRow> = {}): LearnedContextPendingRow {
  const row: LearnedContextPendingRow = {
    id: randomUUID(),
    userId,
    scope: "private",
    kind: "decision",
    subject: `risk:test-${randomUUID().slice(0, 8)}`,
    value: "Avoid adding to positions when the exit pipeline is degraded.",
    symbol: null,
    source: "inferred",
    origin: "autonomous",
    riskTier: "risk",
    classifierReason: "classified 'risk' (fail-closed); queued for human confirmation",
    createdAt: new Date(NOW - 86_400_000).toISOString(),
    status: "pending",
    resolvedAt: null,
    ...overrides,
    connectedAccountId: overrides.connectedAccountId ?? null,
    accountEnvironment: overrides.accountEnvironment ?? null,
    learningScope: overrides.learningScope ?? "portfolio",
    transferState: overrides.transferState ?? "not_applicable"
  };
  insertPendingLearnedContext(row);
  return row;
}

function enableReview(userId: string, mode: "annotate" | "decide") {
  setPolicy({ ...getPolicy(userId), learningReviewEnabled: true, learningReviewMode: mode }, userId);
}

function verdictJson(reviews: LearningReviewVerdict[], summary = "Daily review summary."): string {
  return JSON.stringify({ reviews, summary });
}

/** Injectable llm that answers "keep" for EVERY item it was shown (full coverage). */
function keepAllLlm(onCall?: () => void) {
  return async (spec: { userContent: string }) => {
    onCall?.();
    const items = (JSON.parse(spec.userContent) as { reviewItems: Array<{ id: string; table: LearningReviewVerdict["table"] }> }).reviewItems;
    return verdictJson(items.map((it) => ({ id: it.id, table: it.table, verdict: "keep" as const, confidence: 90, reasoning: "sound" })));
  };
}

// ── Verdict parsing ─────────────────────────────────────────────────────────────

describe("parseLearningReviewVerdicts", () => {
  it("parses a valid verdict payload and clamps confidence to 1-100", () => {
    const text = verdictJson([
      { id: "a", table: "learned_context", verdict: "keep", confidence: 250 as number, reasoning: "sample ok" },
      { id: "b", table: "learned_context_pending", verdict: "reject", confidence: 0 as number, reasoning: "attribution" }
    ]);
    const parsed = parseLearningReviewVerdicts(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.reviews).toHaveLength(2);
    expect(parsed!.reviews[0].confidence).toBe(100);
    expect(parsed!.reviews[1].confidence).toBe(1);
    expect(parsed!.summary).toBe("Daily review summary.");
  });

  it("tolerates code fences / surrounding prose around the JSON object", () => {
    const inner = verdictJson([{ id: "a", table: "learned_context", verdict: "expire", confidence: 70, reasoning: "still-true fails" }]);
    const parsed = parseLearningReviewVerdicts("Here you go:\n```json\n" + inner + "\n```\nDone.");
    expect(parsed?.reviews).toHaveLength(1);
    expect(parsed?.reviews[0].verdict).toBe("expire");
  });

  it("drops individually malformed entries instead of failing the whole run", () => {
    const text = JSON.stringify({
      reviews: [
        { id: "good", table: "learned_context", verdict: "keep", confidence: 80, reasoning: "ok" },
        { id: "bad-verdict", table: "learned_context", verdict: "nuke", confidence: 80, reasoning: "x" },
        { id: "bad-table", table: "policies", verdict: "keep", confidence: 80, reasoning: "x" },
        { table: "learned_context", verdict: "keep", confidence: 80, reasoning: "no id" },
        "not-an-object"
      ],
      summary: "s"
    });
    const parsed = parseLearningReviewVerdicts(text);
    expect(parsed?.reviews.map((r) => r.id)).toEqual(["good"]);
  });

  it("returns null for garbage, empty, and reviews-less payloads", () => {
    expect(parseLearningReviewVerdicts(undefined)).toBeNull();
    expect(parseLearningReviewVerdicts("")).toBeNull();
    expect(parseLearningReviewVerdicts("not json at all")).toBeNull();
    expect(parseLearningReviewVerdicts('{"summary":"no reviews"}')).toBeNull();
    expect(parseLearningReviewVerdicts('["array-root"]')).toBeNull();
  });

  it("accepts a 'defer' verdict carrying a non-empty reasoning note", () => {
    const text = verdictJson([
      { id: "unsure-1", table: "learned_context_pending", verdict: "defer", confidence: 40, reasoning: "Conflicts with a recent rollout note; a human should judge which is current." }
    ]);
    const parsed = parseLearningReviewVerdicts(text);
    expect(parsed?.reviews).toHaveLength(1);
    expect(parsed?.reviews[0].verdict).toBe("defer");
    expect(parsed?.reviews[0].reasoning).toContain("rollout note");
  });

  it("drops a 'defer' verdict with blank or missing reasoning (a note is required)", () => {
    const text = JSON.stringify({
      reviews: [
        { id: "blank-note", table: "learned_context_pending", verdict: "defer", confidence: 40, reasoning: "   " },
        { id: "missing-note", table: "learned_context_pending", verdict: "defer", confidence: 40 },
        { id: "has-note", table: "learned_context_pending", verdict: "defer", confidence: 40, reasoning: "genuinely ambiguous evidence" }
      ],
      summary: "s"
    });
    const parsed = parseLearningReviewVerdicts(text);
    expect(parsed?.reviews.map((r) => r.id)).toEqual(["has-note"]);
  });
});

// ── Once-per-day dedup ──────────────────────────────────────────────────────────

describe("once-per-day dedup", () => {
  it("is due for a fresh user, then not due after a successful run advances the marker", async () => {
    const userId = `lr-dedup-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    const row = seedLearnedRow(userId);
    expect(isLearningReviewDue(userId, NOW)).toBe(true);

    const summary = await runDailyLearningReview(userId, {
      now: NOW,
      llm: async () => verdictJson([{ id: row.id, table: "learned_context", verdict: "keep", confidence: 90, reasoning: "sound" }])
    });
    expect(summary.ok).toBe(true);
    expect(isLearningReviewDue(userId, NOW)).toBe(false);
    // A second same-day run skips as not-due; the next UTC day is due again.
    const again = await runDailyLearningReview(userId, { now: NOW, llm: async () => "should-not-be-called" });
    expect(again.skipped).toBe(true);
    expect(again.reason).toBe("not-due");
    expect(isLearningReviewDue(userId, NOW + 86_400_000)).toBe(true);
  });

  it("runDailyLearningReviewIfDue is a no-op when the policy flag is off", async () => {
    const userId = `lr-off-${randomUUID().slice(0, 8)}`;
    seedLearnedRow(userId);
    expect(await runDailyLearningReviewIfDue(userId, NOW)).toBeNull();
    expect(isLearningReviewDue(userId, NOW)).toBe(true); // marker untouched
  });

  it("an empty learning store terminally skips for the day (no-items)", async () => {
    const userId = `lr-empty-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    const summary = await runDailyLearningReview(userId, { now: NOW, llm: async () => "should-not-be-called" });
    expect(summary.skipped).toBe(true);
    expect(summary.reason).toBe("no-items");
    expect(isLearningReviewDue(userId, NOW)).toBe(false);
  });
});

// ── Run trigger: min-new-lessons threshold OR max-wait sweep ────────────────────

describe("review trigger (learningReviewMinNewLessons / learningReviewMaxWaitDays)", () => {
  it("stays quiet below the threshold, fires at it, and goes quiet again after a successful review", async () => {
    const userId = `lr-trigger-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    const policy = getPolicy(userId);

    // One fresh lesson: below the default threshold of 5 and younger than the 7-day max wait.
    seedLearnedRow(userId);
    expect(evaluateLearningReviewTrigger(userId, NOW, policy)).toMatchObject({ shouldRun: false, newCount: 1, reason: "below-threshold" });
    // The scheduler entry point respects the trigger: no run, marker untouched.
    expect(await runDailyLearningReviewIfDue(userId, NOW)).toBeNull();
    expect(isLearningReviewDue(userId, NOW)).toBe(true);

    // Four more lessons hit the threshold.
    for (let i = 0; i < 4; i += 1) seedLearnedRow(userId);
    expect(evaluateLearningReviewTrigger(userId, NOW, policy)).toMatchObject({ shouldRun: true, newCount: 5, reason: "threshold" });

    // A successful review stores lastReviewedAt, so the same five lessons no longer count as new.
    const run = await runDailyLearningReview(userId, { now: NOW, llm: keepAllLlm() });
    expect(run.ok).toBe(true);
    expect(evaluateLearningReviewTrigger(userId, NOW + 3_600_000, policy)).toMatchObject({ shouldRun: false, reason: "no-new-items" });
  });

  it("sweeps a slow trickle once the oldest un-reviewed lesson passes the max wait", () => {
    const userId = `lr-maxage-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    // A single pending item (below the count threshold) that has waited 8 days.
    seedPendingRow(userId, { createdAt: new Date(NOW - 8 * 86_400_000).toISOString() });
    const trigger = evaluateLearningReviewTrigger(userId, NOW, getPolicy(userId));
    expect(trigger).toMatchObject({ shouldRun: true, newCount: 1, reason: "max-age" });
    expect(trigger.oldestUnreviewedAgeDays).toBeGreaterThanOrEqual(8);
  });

  it("max-age fires for a LEARNED row older than the 7-day pack window, and the row is ACTUALLY reviewed (deferred findings #2/#3: no more silent self-healing)", async () => {
    const userId = `lr-maxage-learned-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    // A single LEARNED (not pending) lesson asserted 9 days ago — older than LEARNED_WINDOW_DAYS.
    // The trigger has always counted this without a window (8da047aa), so "max-age" fires.
    seedLearnedRow(userId, { assertedAt: new Date(NOW - 9 * 86_400_000).toISOString() });
    const trigger = evaluateLearningReviewTrigger(userId, NOW, getPolicy(userId));
    expect(trigger).toMatchObject({ shouldRun: true, newCount: 1, reason: "max-age" });
    expect(trigger.oldestUnreviewedAgeDays).toBeGreaterThanOrEqual(9);

    // Previously the row was outside the context-pack window and got silently skipped forever via
    // a later unrelated review's "self-healing" marker advance (never actually reviewed) — that was
    // deferred finding #2/#3's own failure mode wearing a different hat. Now buildLearningReviewContextPack
    // treats an un-reviewed row as a candidate regardless of age, so this run actually reviews it.
    const run = await runDailyLearningReview(userId, { now: NOW, llm: keepAllLlm() });
    expect(run.ok).toBe(true);
    expect(run.itemsReviewed).toBe(1);
    const verdictAudits = listAuditByKind("learning_review_verdict", 10, userId);
    expect(verdictAudits).toHaveLength(1);

    // Genuinely reviewed now (not silently swept): the trigger goes quiet immediately, and stays
    // quiet — there's no "unreviewed but never shown" row left hiding behind it.
    expect(evaluateLearningReviewTrigger(userId, NOW + 3_600_000, getPolicy(userId)).reason).toBe("no-new-items");
  });

  it("falls back to the default thresholds when stored knob values are corrupt", () => {
    const userId = `lr-corrupt-${randomUUID().slice(0, 8)}`;
    seedLearnedRow(userId);
    const corrupt = {
      ...getPolicy(userId),
      learningReviewMinNewLessons: Number.NaN,
      learningReviewMaxWaitDays: "banana" as unknown as number
    };
    // NaN knobs must not silently disable the trigger — defaults (5 / 7d) apply.
    expect(evaluateLearningReviewTrigger(userId, NOW, corrupt).reason).toBe("below-threshold");
    for (let i = 0; i < 4; i += 1) seedLearnedRow(userId);
    expect(evaluateLearningReviewTrigger(userId, NOW, corrupt)).toMatchObject({ shouldRun: true, reason: "threshold" });
  });
});

// ── Defaults + no hidden model fallback (owner 2026-07-09) ───────────────────────

describe("defaults and model requirement", () => {
  it("defaults to decide mode and the claude-fable-latest model when nothing was explicitly set", () => {
    const userId = `lr-default-${randomUUID().slice(0, 8)}`;
    const policy = getPolicy(userId);
    // "decide" is the default; only an explicit "annotate" opts out.
    expect(policy.learningReviewMode ?? "decide").not.toBe("annotate");
    // The model default is a real, explicit value — never blank-means-Fable.
    expect(policy.learningReviewModel).toBe("claude-fable-latest");
  });

  it("skips with reason 'no-model' rather than silently substituting a model when blank", async () => {
    const userId = `lr-nomodel-${randomUUID().slice(0, 8)}`;
    setPolicy({ ...getPolicy(userId), learningReviewEnabled: true, learningReviewModel: "" }, userId);
    seedLearnedRow(userId);
    const summary = await runDailyLearningReview(userId, { now: NOW, llm: async () => "should-not-be-called" });
    expect(summary.skipped).toBe(true);
    expect(summary.reason).toBe("no-model");
  });

  it("canonicalizes a legacy catalog alias in review results and audits", async () => {
    const userId = `lr-model-alias-${randomUUID().slice(0, 8)}`;
    setPolicy({ ...getPolicy(userId), learningReviewEnabled: true, learningReviewModel: "claude-fable-5" }, userId);
    seedLearnedRow(userId);
    const summary = await runDailyLearningReview(userId, { now: NOW, llm: keepAllLlm() });
    expect(summary.model).toBe("claude-fable-latest");
    const auditRow = listAuditByKind("learning_review_summary", 1, userId)[0];
    expect((auditRow.payload as { model?: string; modelLabel?: string; servedModel?: string }).model).toBe("claude-fable-latest");
    expect((auditRow.payload as { modelLabel?: string }).modelLabel).toContain("5.1");
    expect((auditRow.payload as { servedModel?: string }).servedModel).toBeUndefined();
  });

  it("records an unlisted catalog model by its canonical identity", async () => {
    const userId = `lr-model-astra-${randomUUID().slice(0, 8)}`;
    setPolicy({ ...getPolicy(userId), learningReviewEnabled: true, learningReviewModel: "openai/gpt-6-astra-pro" }, userId);
    seedLearnedRow(userId);
    const summary = await runDailyLearningReview(userId, { now: NOW, llm: keepAllLlm() });
    expect(summary.model).toBe("gpt-6-astra-pro");
    const auditRow = listAuditByKind("learning_review_summary", 1, userId)[0];
    expect((auditRow.payload as { model?: string; modelLabel?: string }).model).toBe("gpt-6-astra-pro");
    // 2026-09-18 catalog cleanup (docs/rollouts/2026-09-18-model-catalog-cleanup.md) retags the
    // GPT-6 Astra Pro row as `gpt-6-astra-pro — GPT-6 Astra in pro reasoning mode` (pro is a
    // request parameter, not a distinct SKU). The audit label therefore resolves to that
    // canonical entry, not the legacy "GPT-6 Astra Pro" display name.
    expect((auditRow.payload as { modelLabel?: string }).modelLabel).toBe(
      "gpt-6-astra-pro — GPT-6 Astra in pro reasoning mode (more thinking per call)",
    );
  });
});

// ── Skip re-review when nothing changed (no wasted LLM call) ────────────────────

describe("skip unchanged sets", () => {
  it("reviews once, then skips 'unchanged' the next day on an identical set, and re-runs when a new item appears", async () => {
    const userId = `lr-unchanged-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    const row = seedLearnedRow(userId);
    let calls = 0;
    const llm = async () => {
      calls += 1;
      return verdictJson([{ id: row.id, table: "learned_context", verdict: "keep", confidence: 90, reasoning: "sound" }]);
    };

    // Day 1: real review — one LLM call, fingerprint stored.
    const day1 = await runDailyLearningReview(userId, { now: NOW, llm });
    expect(day1.ok).toBe(true);
    expect(day1.skipped).toBeFalsy();
    expect(calls).toBe(1);

    // Day 2: identical item set — skip WITHOUT calling the LLM.
    const day2 = await runDailyLearningReview(userId, { now: NOW + 86_400_000, llm });
    expect(day2.skipped).toBe(true);
    expect(day2.reason).toBe("unchanged");
    expect(calls).toBe(1);

    // Day 3: a new learned fact appears — the set changed, so it runs again.
    seedLearnedRow(userId);
    const day3 = await runDailyLearningReview(userId, { now: NOW + 2 * 86_400_000, llm });
    expect(day3.reason).not.toBe("unchanged");
    expect(calls).toBe(2);
  });

  it("a failed review does NOT store the fingerprint, so the same set is retried the next day", async () => {
    const userId = `lr-fail-retry-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    seedLearnedRow(userId);
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("provider down");
    };
    const day1 = await runDailyLearningReview(userId, { now: NOW, llm: failing });
    expect(day1.ok).toBe(false);
    expect(day1.reason).toBe("llm-failed");
    // Next day, same set — must attempt again (not skipped as unchanged) since day 1 failed.
    const day2 = await runDailyLearningReview(userId, { now: NOW + 86_400_000, llm: failing });
    expect(day2.reason).toBe("llm-failed");
    expect(calls).toBe(2);
  });

  it("a mode or model change forces a fresh review of the same set instead of skipping 'unchanged'", async () => {
    const userId = `lr-config-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    seedLearnedRow(userId);
    let calls = 0;
    const llm = keepAllLlm(() => {
      calls += 1;
    });

    const day1 = await runDailyLearningReview(userId, { now: NOW, llm });
    expect(day1.ok).toBe(true);
    expect(calls).toBe(1);

    // Same set, annotate -> decide: verdicts must now be APPLIED, so the run must not skip.
    enableReview(userId, "decide");
    const day2 = await runDailyLearningReview(userId, { now: NOW + 86_400_000, llm });
    expect(day2.reason).not.toBe("unchanged");
    expect(day2.mode).toBe("decide");
    expect(calls).toBe(2);

    // Same set, different reviewer model: the newly chosen model must actually run.
    setPolicy({ ...getPolicy(userId), learningReviewModel: "openai/gpt-5.5" }, userId);
    const day3 = await runDailyLearningReview(userId, { now: NOW + 2 * 86_400_000, llm });
    expect(day3.reason).not.toBe("unchanged");
    expect(calls).toBe(3);

    // Same model, different reasoning effort is also a materially different review config.
    setPolicy({ ...getPolicy(userId), learningReviewReasoningEffort: "high" }, userId);
    const day4 = await runDailyLearningReview(userId, { now: NOW + 3 * 86_400_000, llm });
    expect(day4.reason).not.toBe("unchanged");
    expect(day4.reasoningEffort).toBe("high");
    expect(calls).toBe(4);
  });

  it("does not cache the fingerprint when some shown items received no verdict (partial coverage)", async () => {
    const userId = `lr-partial-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    const covered = seedLearnedRow(userId);
    seedLearnedRow(userId, { symbol: "NVDA" }); // never receives a verdict
    let calls = 0;
    const llm = async () => {
      calls += 1;
      return verdictJson([{ id: covered.id, table: "learned_context", verdict: "keep", confidence: 90, reasoning: "sound" }]);
    };

    const day1 = await runDailyLearningReview(userId, { now: NOW, llm });
    expect(day1.ok).toBe(true); // parse succeeded and the daily marker advanced...
    // ...but the uncovered item still needs a verdict: day 2 must re-attempt, not skip.
    const day2 = await runDailyLearningReview(userId, { now: NOW + 86_400_000, llm });
    expect(day2.reason).not.toBe("unchanged");
    expect(calls).toBe(2);
  });

  it("does not cache the fingerprint when a decide-mode application failed (failures are surfaced)", async () => {
    const userId = `lr-applyfail-${randomUUID().slice(0, 8)}`;
    const pending = seedPendingRow(userId);
    const pack = await buildLearningReviewContextPack(userId, NOW);
    // Poison the in-memory pending row so applyApprovedPending's insert throws mid-apply.
    pack.pendingById.set(pending.id, { ...pending, subject: undefined as unknown as string });

    const { applied, failures } = applyLearningReviewVerdicts(
      userId,
      [{ id: pending.id, table: "learned_context_pending", verdict: "keep", confidence: 90, reasoning: "sound" }],
      pack
    );

    // The failure is surfaced to the caller (the runner gates the fingerprint store on it) and audited.
    expect(failures).toBe(1);
    expect(applied).toHaveLength(0);
    expect(listAuditByKind("learning_review_apply_error", 10, userId)).toHaveLength(1);
    // The row is untouched and will be re-attempted on the next run.
    expect(getPendingLearnedContext(pending.id, userId)?.status).toBe("pending");
  });
});

// ── PR #1278 review-round hardening (#1 config re-run gate, #5 dup verdicts, #6 approval marker) ──

describe("PR #1278 review-round hardening", () => {
  it("scheduler re-runs on a review-config change even with no new lessons (#1)", async () => {
    const userId = `lr-cfggate-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    seedLearnedRow(userId);
    // Day 1: a successful annotate review stores lastReviewedAt + the config signature.
    expect((await runDailyLearningReview(userId, { now: NOW, llm: keepAllLlm() })).ok).toBe(true);

    const nextDay = NOW + 86_400_000;
    // Control: unchanged config, no new lessons -> the scheduler gate stays quiet (returns null).
    expect(await runDailyLearningReviewIfDue(userId, nextDay)).toBeNull();

    // Change the reviewer model (a config change) with NO new lessons: the gate must now OPEN and
    // invoke the runner instead of short-circuiting — proving the same set is re-reviewed under the
    // new config. A blank model makes the runner take the cheap 'no-model' skip (deterministic, no
    // network), which is enough to prove the gate opened.
    setPolicy({ ...getPolicy(userId), learningReviewModel: "" }, userId);
    const rerun = await runDailyLearningReviewIfDue(userId, nextDay);
    expect(rerun).not.toBeNull();
    expect(rerun?.reason).toBe("no-model");
  });

  it("treats duplicate verdicts for one item as incomplete and never applies them (#5)", async () => {
    const userId = `lr-dup-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "decide");
    const pending = seedPendingRow(userId);
    // The model emits TWO conflicting verdicts for the same pending id (keep + reject).
    const llm = async (spec: { userContent: string }) => {
      const item = (JSON.parse(spec.userContent) as { reviewItems: Array<{ id: string; table: LearningReviewVerdict["table"] }> })
        .reviewItems[0];
      return verdictJson([
        { id: item.id, table: item.table, verdict: "keep", confidence: 90, reasoning: "sound" },
        { id: item.id, table: item.table, verdict: "reject", confidence: 80, reasoning: "corrupt" }
      ]);
    };
    const day1 = await runDailyLearningReview(userId, { now: NOW, llm });
    // Neither verdict is applied: the pending row is not promoted AND not rejected — it stays pending.
    expect(getPendingLearnedContext(pending.id, userId)?.status).toBe("pending");
    expect(day1.applied).toBe(0);
    // The duplicated item counts as UNcovered, so the run is incomplete and re-attempted next day.
    const day2 = await runDailyLearningReview(userId, { now: NOW + 86_400_000, llm });
    expect(day2.reason).not.toBe("unchanged");
  });

  it("does not re-review just-approved pending items the next day (#6)", async () => {
    const userId = `lr-approve-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "decide");
    // Enough pending items to meet the default threshold (5) so a naive re-count WOULD re-trigger.
    Array.from({ length: 5 }, () => seedPendingRow(userId));
    const day1 = await runDailyLearningReview(userId, { now: NOW, llm: keepAllLlm() });
    expect(day1.ok).toBe(true);
    expect(day1.applied).toBe(5);

    // The promoted rows are stamped at the review marker (== lastReviewedAt), so the trigger sees
    // NO new lessons the next day and the scheduler does not spend a call re-reviewing them.
    const nextDay = NOW + 86_400_000;
    expect(evaluateLearningReviewTrigger(userId, nextDay, getPolicy(userId)).reason).toBe("no-new-items");
    expect(await runDailyLearningReviewIfDue(userId, nextDay)).toBeNull();
  });
});

// ── User-level scoping: config overlays every account (the review runs once per user) ──

describe("user-level scoping", () => {
  it("learningReview settings set under one account are visible under another (user-level, not per-account)", () => {
    const userId = `lr-scope-${randomUUID().slice(0, 8)}`;
    // Set the review config while account A1 is the scope.
    setPolicy(
      { ...getPolicy(userId, "A1"), learningReviewEnabled: true, learningReviewMode: "annotate", learningReviewModel: "openai/gpt-5.5" },
      userId,
      "A1"
    );
    // Read it back under a different account scope — user-level fields overlay every account.
    const underA2 = getPolicy(userId, "A2");
    expect(underA2.learningReviewEnabled).toBe(true);
    expect(underA2.learningReviewMode).toBe("annotate");
    expect(underA2.learningReviewModel).toBe("openai/gpt-5.5");
  });
});

// ── User-level config must survive account removal, profile ops, and the #1116→#1278 cutover ──

describe("user-level persistence (PR #1278 review fixes)", () => {
  function seedAccount(userId: string, id: string, isActive = true) {
    upsertConnectedAccount({ id, userId, broker: "alpaca", environment: "paper", accountNumber: `PA-${id}`, label: id, isActive });
  }

  it("keeps the review config visible when the user has no active connected account (scheduler path)", () => {
    const userId = `lr-noacct-${randomUUID().slice(0, 8)}`;
    const acct = `acct-${randomUUID().slice(0, 8)}`;
    // An active library profile: its row carries stripped-to-default learningReview values
    // (setPolicy syncs it via pickAccountFields + mergePolicy), so it is the hazardous base.
    createStrategyProfile({ name: "Base", active: true }, userId);
    seedAccount(userId, acct);
    setPolicy({ ...getPolicy(userId), learningReviewEnabled: true, learningReviewModel: "openai/gpt-5.5" }, userId);
    expect(getPolicy(userId).learningReviewEnabled).toBe(true);

    // Remove the only account: getPolicy(userId) falls back to the profile base — the user-level
    // overlay must still apply or the scheduler would read the enabled review as disabled.
    deleteConnectedAccount(acct, userId);
    const policy = getPolicy(userId);
    expect(policy.learningReviewEnabled).toBe(true);
    expect(policy.learningReviewModel).toBe("openai/gpt-5.5");
  });

  it("activating or editing a profile does not clobber the user-level review config", () => {
    const userId = `lr-profile-${randomUUID().slice(0, 8)}`;
    const acct = `acct-${randomUUID().slice(0, 8)}`;
    seedAccount(userId, acct);
    createStrategyProfile({ name: "P1", active: true }, userId);
    const p2 = createStrategyProfile({ name: "P2", active: false }, userId);
    setPolicy({ ...getPolicy(userId), learningReviewEnabled: true, learningReviewMode: "annotate", learningReviewModel: "openai/gpt-5.5" }, userId);

    // Activating another profile writes the full profile policy to user_settings.policy —
    // the stored user-level fields must be preserved through that write.
    activateStrategyProfile(p2.id, userId);
    const afterActivate = getPolicy(userId);
    expect(afterActivate.learningReviewEnabled).toBe(true);
    expect(afterActivate.learningReviewMode).toBe("annotate");
    expect(afterActivate.learningReviewModel).toBe("openai/gpt-5.5");

    // Same for editing the ACTIVE profile.
    updateStrategyProfile(p2.id, { policy: { maxOrderNotional: 1234 } }, userId);
    const afterUpdate = getPolicy(userId);
    expect(afterUpdate.learningReviewEnabled).toBe(true);
    expect(afterUpdate.learningReviewModel).toBe("openai/gpt-5.5");
    expect(afterUpdate.maxOrderNotional).toBe(1234);
  });

  it("seeds pre-cutover account-level learningReview settings into user_settings on first read", () => {
    const userId = `lr-legacy-${randomUUID().slice(0, 8)}`;
    const acct = `acct-${randomUUID().slice(0, 8)}`;
    seedAccount(userId, acct);
    // Simulate a pre-#1278 deploy: the enabled review lives ONLY in the account row's policy
    // blob (the #1116 account-scoped layout); user_settings.policy never carried the keys.
    const legacyPolicy = { ...DEFAULT_POLICY, learningReviewEnabled: true, learningReviewMode: "annotate", learningReviewModel: "openai/gpt-5.5" };
    getDb()
      .prepare(
        `INSERT INTO account_strategy_state
           (user_id, connected_account_id, policy, prompt, scoring_weights, system_state, derived_from_profile_id, updated_at)
         VALUES (?, ?, ?, ?, ?, 'halted', NULL, ?)`
      )
      .run(userId, acct, JSON.stringify(legacyPolicy), "legacy prompt", JSON.stringify(legacyPolicy.scoringWeights), new Date().toISOString());

    // First read after the cutover: reads strip learningReview* from the account row, so the
    // lazy seed must copy the legacy values into user_settings — an already-enabled review
    // survives the deploy instead of silently disabling.
    const policy = getPolicy(userId);
    expect(policy.learningReviewEnabled).toBe(true);
    expect(policy.learningReviewMode).toBe("annotate");
    expect(policy.learningReviewModel).toBe("openai/gpt-5.5");
    // Idempotent: the seed persisted, later reads agree.
    expect(getPolicy(userId).learningReviewEnabled).toBe(true);
  });

  it("recovers an account-level enabled review even when user_settings holds a stale full-blob default (finding #3)", () => {
    const userId = `lr-fullblob-${randomUUID().slice(0, 8)}`;
    const acct = `acct-${randomUUID().slice(0, 8)}`;
    seedAccount(userId, acct);
    // Pre-cutover, the real ENABLED review lives account-scoped (#1116)…
    const accountPolicy = { ...DEFAULT_POLICY, learningReviewEnabled: true, learningReviewMode: "annotate", learningReviewModel: "openai/gpt-5.5" };
    getDb()
      .prepare(
        `INSERT INTO account_strategy_state
           (user_id, connected_account_id, policy, prompt, scoring_weights, system_state, derived_from_profile_id, updated_at)
         VALUES (?, ?, ?, ?, ?, 'halted', NULL, ?)`
      )
      .run(userId, acct, JSON.stringify(accountPolicy), "legacy prompt", JSON.stringify(accountPolicy.scoringWeights), new Date().toISOString());
    // …while user_settings.policy holds a FULL policy blob (e.g. from a pre-cutover profile
    // activation) that stamped the DEFAULT learningReviewEnabled:false. The review keys are PRESENT
    // but stale — the earlier "bail whenever any review key is present" left the review disabled.
    // The seed must recognise the account-level keys as a full blob and still recover the account value.
    setUserSetting(userId, "policy", { ...DEFAULT_POLICY, learningReviewEnabled: false });

    const policy = getPolicy(userId);
    expect(policy.learningReviewEnabled).toBe(true);
    expect(policy.learningReviewMode).toBe("annotate");
    expect(policy.learningReviewModel).toBe("openai/gpt-5.5");
    // One-time + idempotent: later reads agree (the seed persisted onto the same blob).
    expect(getPolicy(userId).learningReviewEnabled).toBe(true);
  });

  it("does NOT clobber a deliberate user-level disable stored as a tiered write (finding #3 guard)", () => {
    const userId = `lr-tiered-${randomUUID().slice(0, 8)}`;
    const acct = `acct-${randomUUID().slice(0, 8)}`;
    seedAccount(userId, acct);
    // A stale account_strategy_state row still carries an ENABLED review…
    const accountPolicy = { ...DEFAULT_POLICY, learningReviewEnabled: true, learningReviewModel: "openai/gpt-5.5" };
    getDb()
      .prepare(
        `INSERT INTO account_strategy_state
           (user_id, connected_account_id, policy, prompt, scoring_weights, system_state, derived_from_profile_id, updated_at)
         VALUES (?, ?, ?, ?, ?, 'halted', NULL, ?)`
      )
      .run(userId, acct, JSON.stringify(accountPolicy), "prompt", JSON.stringify(accountPolicy.scoringWeights), new Date().toISOString());
    // …but the user DELIBERATELY disabled it post-cutover — a TIERED write (only user-level keys).
    // By VALUE this false is indistinguishable from a stale default, so the seed must refuse by
    // STRUCTURE (tiered ⇒ authoritative). A naive "recover the account value whenever it reads false"
    // would wrongly re-enable it and spend LLM budget the owner turned off.
    setUserSetting(userId, "policy", {
      learningReviewEnabled: false,
      learningReviewMode: "decide",
      learningReviewModel: "openai/gpt-5.5",
      notificationSettings: DEFAULT_POLICY.notificationSettings
    });

    expect(getPolicy(userId).learningReviewEnabled).toBe(false);
    // …and it stays disabled on later reads (the one-time marker never re-fires the seed).
    expect(getPolicy(userId).learningReviewEnabled).toBe(false);
  });
});

// ── Mode gating ─────────────────────────────────────────────────────────────────

describe("annotate mode", () => {
  it("records verdict + summary audits but NEVER mutates rows, even on reject verdicts", async () => {
    const userId = `lr-annotate-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    const learned = seedLearnedRow(userId);
    const pending = seedPendingRow(userId);

    const summary = await runDailyLearningReview(userId, {
      now: NOW,
      llm: async () =>
        verdictJson([
          { id: learned.id, table: "learned_context", verdict: "reject", confidence: 95, reasoning: "attribution: exit deadlock active" },
          { id: pending.id, table: "learned_context_pending", verdict: "reject", confidence: 90, reasoning: "attribution" }
        ])
    });

    expect(summary.ok).toBe(true);
    expect(summary.applied).toBe(0);
    // Nothing mutated: the learned row is still live, the pending row still pending.
    expect(listLearnedContext(userId).some((r) => r.id === learned.id)).toBe(true);
    expect(getPendingLearnedContext(pending.id, userId)?.status).toBe("pending");
    // Verdicts + summary are auditable.
    const verdictAudits = listAuditByKind("learning_review_verdict", 10, userId);
    expect(verdictAudits).toHaveLength(2);
    const summaryAudit = listAuditByKind("learning_review_summary", 10, userId);
    expect(summaryAudit).toHaveLength(1);
    expect((summaryAudit[0].payload as { mode: string }).mode).toBe("annotate");
    expect(listAuditByKind("learning_review_applied", 10, userId)).toHaveLength(0);
  });
});

describe("decide mode", () => {
  it("applies verdicts through the existing mutation paths, each application audited", async () => {
    const userId = `lr-decide-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "decide");
    const rejected = seedLearnedRow(userId);
    const expired = seedLearnedRow(userId, { symbol: "NVDA" });
    const kept = seedLearnedRow(userId, { symbol: "AAPL" });
    const pendingApproved = seedPendingRow(userId);
    const pendingRejected = seedPendingRow(userId);

    const summary = await runDailyLearningReview(userId, {
      now: NOW,
      llm: async () =>
        verdictJson([
          { id: rejected.id, table: "learned_context", verdict: "reject", confidence: 95, reasoning: "attribution: system defect" },
          { id: expired.id, table: "learned_context", verdict: "expire", confidence: 80, reasoning: "still-true fails post-fix" },
          { id: kept.id, table: "learned_context", verdict: "keep", confidence: 85, reasoning: "sound sample" },
          { id: pendingApproved.id, table: "learned_context_pending", verdict: "keep", confidence: 75, reasoning: "sound" },
          { id: pendingRejected.id, table: "learned_context_pending", verdict: "reject", confidence: 90, reasoning: "under-sampled + defect window" }
        ])
    });

    expect(summary.ok).toBe(true);
    expect(summary.applied).toBe(4); // keep on learned_context is a no-op

    const live = listLearnedContext(userId);
    // reject → deleted
    expect(live.some((r) => r.id === rejected.id)).toBe(false);
    // expire → still stored but expires_at set, and excluded from decision reads
    const expiredRow = live.find((r) => r.id === expired.id);
    expect(expiredRow?.expiresAt).toBeTruthy();
    expect(listLearnedContextForDecision(userId, ["NVDA"]).some((r) => r.id === expired.id)).toBe(false);
    // keep → untouched
    expect(live.find((r) => r.id === kept.id)?.expiresAt).toBeNull();
    // pending keep → approved via applyApprovedPending (risk tier promotes an advisory row)
    expect(getPendingLearnedContext(pendingApproved.id, userId)?.status).toBe("approved");
    expect(live.some((r) => r.subject === pendingApproved.subject && r.riskTier === "risk")).toBe(true);
    // pending reject → rejected
    expect(getPendingLearnedContext(pendingRejected.id, userId)?.status).toBe("rejected");

    expect(listAuditByKind("learning_review_applied", 10, userId)).toHaveLength(4);
  });

  it("never mutates rows the model was not shown (unknown ids are ignored)", async () => {
    const userId = `lr-unshown-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    // Establish a non-zero lastReviewedAt marker via one fully-successful bootstrap review, so a
    // row asserted BEFORE that marker is unambiguously "already reviewed" and excluded from the
    // pack — independent of the un-reviewed-row window widening (deferred findings #2/#3), which
    // only protects rows asserted AFTER the marker, not before it.
    seedLearnedRow(userId, { assertedAt: new Date(NOW - 60 * 86_400_000).toISOString() });
    const bootstrap = await runDailyLearningReview(userId, { now: NOW - 5 * 86_400_000, force: true, llm: keepAllLlm() });
    expect(bootstrap.ok).toBe(true);

    const shown = seedLearnedRow(userId);
    // A live row asserted BEFORE the bootstrap marker (and outside the 7-day window) — real, but
    // already-reviewed by definition, so it's not a pack candidate.
    const unshown = seedLearnedRow(userId, { assertedAt: new Date(NOW - 10 * 86_400_000).toISOString() });

    const pack = await buildLearningReviewContextPack(userId, NOW);
    expect(pack.items.some((i) => i.id === shown.id)).toBe(true);
    expect(pack.items.some((i) => i.id === unshown.id)).toBe(false);

    const { applied, failures } = applyLearningReviewVerdicts(
      userId,
      [
        { id: unshown.id, table: "learned_context", verdict: "reject", confidence: 99, reasoning: "hallucinated target" },
        { id: randomUUID(), table: "learned_context_pending", verdict: "keep", confidence: 99, reasoning: "invented id" }
      ],
      pack
    );
    expect(applied).toHaveLength(0);
    expect(failures).toBe(0);
    expect(listLearnedContext(userId).some((r) => r.id === unshown.id)).toBe(true);
  });
});

// ── "defer" verdict: leave-as-proposal when the reviewer is unsure (owner requirement, 2026-07-10) ──

describe("defer verdict", () => {
  it("decide mode: a deferred pending item stays exactly pending, with the reviewer's note persisted", async () => {
    const userId = `lr-defer-pending-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "decide");
    const pending = seedPendingRow(userId);

    const summary = await runDailyLearningReview(userId, {
      now: NOW,
      llm: async () =>
        verdictJson([
          {
            id: pending.id,
            table: "learned_context_pending",
            verdict: "defer",
            confidence: 40,
            reasoning: "Evidence conflicts with a recent rollout note; a human should judge which is current."
          }
        ])
    });

    expect(summary.ok).toBe(true);
    const row = getPendingLearnedContext(pending.id, userId);
    // Still pending — NOT approved, NOT rejected. This is the "leave it as a proposal" contract.
    expect(row?.status).toBe("pending");
    expect(row?.resolvedAt).toBeNull();
    expect(row?.reviewNote).toContain("rollout note");
    // Audited as an explicit "deferred" application, distinct from approve/reject.
    const applied = listAuditByKind("learning_review_applied", 10, userId);
    expect(applied).toHaveLength(1);
    expect((applied[0].payload as { action: string; verdict: string }).action).toBe("deferred");
    expect((applied[0].payload as { action: string; verdict: string }).verdict).toBe("defer");
  });

  it("a later 'needs_more_data' verdict clears a stale defer note from an earlier review (codex #1351 P2)", async () => {
    const userId = `lr-defer-stale-note-${randomUUID().slice(0, 8)}`;
    const pending = seedPendingRow(userId);

    // Day 1: deferred, note attached. Each day builds its own fresh context pack (as
    // runDailyLearningReview does) — reused-pack.pendingById would otherwise still be the
    // pre-defer snapshot, which is not what a real second run sees.
    const day1Pack = await buildLearningReviewContextPack(userId, NOW);
    applyLearningReviewVerdicts(
      userId,
      [{ id: pending.id, table: "learned_context_pending", verdict: "defer", confidence: 40, reasoning: "Ambiguous on day 1." }],
      day1Pack
    );
    expect(getPendingLearnedContext(pending.id, userId)?.reviewNote).toContain("day 1");

    // Day 2: fresh pack (reflects day 1's persisted note), rides along, but this time the
    // reviewer lands on needs_more_data (not defer) — the stale "Left for you because..."
    // explanation from day 1 must not linger.
    const day2Pack = await buildLearningReviewContextPack(userId, NOW);
    const { applied } = applyLearningReviewVerdicts(
      userId,
      [{ id: pending.id, table: "learned_context_pending", verdict: "needs_more_data", confidence: 55, reasoning: "Still under-sampled." }],
      day2Pack
    );

    const row = getPendingLearnedContext(pending.id, userId);
    expect(row?.status).toBe("pending"); // needs_more_data never mutates status
    expect(row?.reviewNote ?? "").toBe("");
    expect(applied).toHaveLength(1);
    expect(applied[0].action).toBe("cleared_stale_note");
  });

  it("'needs_more_data' with no prior note is a true no-op (no spurious write/audit)", async () => {
    const userId = `lr-needs-more-data-noop-${randomUUID().slice(0, 8)}`;
    const pending = seedPendingRow(userId);
    const pack = await buildLearningReviewContextPack(userId, NOW);

    const { applied } = applyLearningReviewVerdicts(
      userId,
      [{ id: pending.id, table: "learned_context_pending", verdict: "needs_more_data", confidence: 55, reasoning: "Under-sampled." }],
      pack
    );

    expect(applied).toHaveLength(0);
    expect(getPendingLearnedContext(pending.id, userId)?.reviewNote ?? null).toBeNull();
  });

  it("decide mode: 'defer' on a durable learned_context row is a no-op (no queue exists to leave it in)", async () => {
    const userId = `lr-defer-durable-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "decide");
    const learned = seedLearnedRow(userId);

    const summary = await runDailyLearningReview(userId, {
      now: NOW,
      llm: async () =>
        verdictJson([
          { id: learned.id, table: "learned_context", verdict: "defer", confidence: 40, reasoning: "Can't confidently apply the three tests yet." }
        ])
    });

    expect(summary.ok).toBe(true);
    const row = listLearnedContext(userId).find((r) => r.id === learned.id);
    expect(row).toBeTruthy();
    expect(row?.expiresAt).toBeNull();
    // Nothing applied for a durable-row defer (matches needs_more_data's existing no-op behavior).
    expect(listAuditByKind("learning_review_applied", 10, userId)).toHaveLength(0);
  });

  it("annotate mode: a defer verdict is audited but the note is NOT persisted (annotate never mutates rows)", async () => {
    const userId = `lr-defer-annotate-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    const pending = seedPendingRow(userId);

    const summary = await runDailyLearningReview(userId, {
      now: NOW,
      llm: async () =>
        verdictJson([
          { id: pending.id, table: "learned_context_pending", verdict: "defer", confidence: 40, reasoning: "Ambiguous; leaving for a human." }
        ])
    });

    expect(summary.ok).toBe(true);
    // The verdict + reasoning are auditable (learning_review_verdict), but annotate mode never
    // calls applyLearningReviewVerdicts, so review_note stays unset on the row itself.
    const verdictAudits = listAuditByKind("learning_review_verdict", 10, userId);
    expect(verdictAudits).toHaveLength(1);
    expect((verdictAudits[0].payload as { verdict: string; reasoning: string }).reasoning).toContain("Ambiguous");
    expect(getPendingLearnedContext(pending.id, userId)?.reviewNote ?? null).toBeNull();
    expect(getPendingLearnedContext(pending.id, userId)?.status).toBe("pending");
  });

  it("a lone deferred item does not force a same-set re-review the next day (sticks until a human acts or something new arrives)", async () => {
    const userId = `lr-defer-sticky-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "decide");
    const pending = seedPendingRow(userId);
    let calls = 0;
    const deferLlm = async (spec: { userContent: string }) => {
      calls += 1;
      const items = (JSON.parse(spec.userContent) as { reviewItems: Array<{ id: string; table: LearningReviewVerdict["table"] }> }).reviewItems;
      return verdictJson(
        items.map((it) => ({ id: it.id, table: it.table, verdict: "defer" as const, confidence: 40, reasoning: "Still can't decide this one." }))
      );
    };

    // Day 1: real review — the pending item is deferred (left pending, note stored).
    const day1 = await runDailyLearningReview(userId, { now: NOW, llm: deferLlm });
    expect(day1.ok).toBe(true);
    expect(calls).toBe(1);
    expect(getPendingLearnedContext(pending.id, userId)?.status).toBe("pending");

    // Day 2: nothing new arrived — the deferred item is still the whole reviewable set, so the
    // existing fingerprint "unchanged" skip fires and the LLM is NOT called again. It sticks
    // exactly where the reviewer left it, without spending another call re-confirming "still unsure".
    const day2 = await runDailyLearningReview(userId, { now: NOW + 86_400_000, llm: deferLlm });
    expect(day2.skipped).toBe(true);
    expect(day2.reason).toBe("unchanged");
    expect(calls).toBe(1);
    expect(getPendingLearnedContext(pending.id, userId)?.status).toBe("pending");

    // Day 3: a genuinely new lesson appears alongside the still-deferred item — the set changed,
    // so the reviewer runs again and reconsiders BOTH (a "sensible re-review policy": deferred
    // items ride along the next time anything else triggers a review, rather than being permanently
    // excluded or forcing their own retrigger).
    const fresh = seedPendingRow(userId);
    const day3 = await runDailyLearningReview(userId, { now: NOW + 2 * 86_400_000, llm: deferLlm });
    expect(day3.reason).not.toBe("unchanged");
    expect(calls).toBe(2);
    expect(getPendingLearnedContext(pending.id, userId)?.status).toBe("pending");
    expect(getPendingLearnedContext(fresh.id, userId)?.status).toBe("pending");
  });
});

describe("failure fail-safe", () => {
  it("an LLM error never mutates, audits the failure, and advances the marker (no all-day retry hammer)", async () => {
    const userId = `lr-fail-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "decide");
    const learned = seedLearnedRow(userId);
    const pending = seedPendingRow(userId);

    const summary = await runDailyLearningReview(userId, {
      now: NOW,
      llm: async () => {
        throw new Error("provider 500");
      }
    });

    expect(summary.ok).toBe(false);
    expect(summary.reason).toBe("llm-failed");
    expect(listLearnedContext(userId).some((r) => r.id === learned.id)).toBe(true);
    expect(getPendingLearnedContext(pending.id, userId)?.status).toBe("pending");
    expect(listAuditByKind("learning_review_failed", 10, userId)).toHaveLength(1);
    expect(listAuditByKind("learning_review_applied", 10, userId)).toHaveLength(0);
    expect(isLearningReviewDue(userId, NOW)).toBe(false);
  });

  it("unparseable model output never mutates and audits parse-failed", async () => {
    const userId = `lr-parse-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "decide");
    const learned = seedLearnedRow(userId);

    const summary = await runDailyLearningReview(userId, { now: NOW, llm: async () => "this is not json" });
    expect(summary.ok).toBe(false);
    expect(summary.reason).toBe("parse-failed");
    expect(listLearnedContext(userId).some((r) => r.id === learned.id)).toBe(true);
    const failed = listAuditByKind("learning_review_failed", 10, userId);
    expect(failed).toHaveLength(1);
    expect((failed[0].payload as { reason: string }).reason).toBe("parse-failed");
  });
});

// ── Backlog drain when reviewable items exceed MAX_REVIEW_ITEMS (deferred PR #1278 finding #2) ──
//
// Regression for the >80-item orphaning bug: the pack sliced the newest MAX_REVIEW_ITEMS and a
// "complete" review then advanced lastReviewedAt to run-start `now`, so items past the budget stopped
// counting toward BOTH the trigger's newCount AND its max-age — they could never be audited. The fix
// sweeps the OLDEST un-reviewed items first and advances the marker only through the newest shown
// slice on a truncated run, so a large backlog drains across successive daily runs with nothing
// silently marked reviewed.
describe("backlog drain when reviewable items exceed MAX_REVIEW_ITEMS (deferred PR #1278 finding #2)", () => {
  const MAX_REVIEW_ITEMS = 80; // mirrors the (unexported) constant in learning-review.ts

  /** Seed `count` learned rows with strictly-distinct, recent assertedAt timestamps — all inside the
   *  7-day pack window and staying inside it as `now` advances a few simulated days. Returns the ids. */
  function seedManyLearnedRows(userId: string, count: number): Set<string> {
    const ids = new Set<string>();
    for (let i = 0; i < count; i++) {
      const row = seedLearnedRow(userId, { assertedAt: new Date(NOW - (count - i) * 60_000).toISOString() });
      ids.add(row.id);
    }
    return ids;
  }

  it("caps the pack at MAX_REVIEW_ITEMS, flags truncation, and reports a marker just below the oldest dropped item", async () => {
    const userId = `lr-pack-trunc-${randomUUID().slice(0, 8)}`;
    // 90 un-reviewed learned rows (fresh user: nothing reviewed yet) → 10 must be dropped.
    const rows = Array.from({ length: MAX_REVIEW_ITEMS + 10 }, (_, i) =>
      seedLearnedRow(userId, { assertedAt: new Date(NOW - (MAX_REVIEW_ITEMS + 10 - i) * 60_000).toISOString() })
    );
    const pack = await buildLearningReviewContextPack(userId, NOW);

    expect(pack.items).toHaveLength(MAX_REVIEW_ITEMS);
    expect(pack.truncated).toBe(true);
    // Oldest-first selection: the SHOWN items are strictly older than every DROPPED item.
    const shownIds = new Set(pack.items.map((it) => it.id));
    const shownMaxAt = Math.max(...pack.items.map((it) => Date.parse(it.at)));
    const droppedMinAt = Math.min(
      ...rows.filter((r) => !shownIds.has(r.id)).map((r) => Date.parse(r.assertedAt))
    );
    expect(shownMaxAt).toBeLessThan(droppedMinAt);
    // The marker lands just below the oldest DROPPED item, so that item (and everything newer) keeps
    // counting as un-reviewed and gets swept later — never orphaned.
    const oldestFirst = [...rows].sort((a, b) => Date.parse(a.assertedAt) - Date.parse(b.assertedAt));
    expect(pack.reviewedThroughMs).toBe(Date.parse(oldestFirst[MAX_REVIEW_ITEMS].assertedAt) - 1);
    expect(pack.reviewedThroughMs).toBeLessThan(NOW);
  });

  it("a pack that fits the budget is not truncated and reports reviewedThroughMs === now", async () => {
    const userId = `lr-pack-full-${randomUUID().slice(0, 8)}`;
    Array.from({ length: MAX_REVIEW_ITEMS }, (_, i) =>
      seedLearnedRow(userId, { assertedAt: new Date(NOW - (MAX_REVIEW_ITEMS - i) * 60_000).toISOString() })
    );
    const pack = await buildLearningReviewContextPack(userId, NOW);
    expect(pack.items).toHaveLength(MAX_REVIEW_ITEMS);
    expect(pack.truncated).toBe(false);
    expect(pack.reviewedThroughMs).toBe(NOW);
  });

  it.each(["annotate", "decide"] as const)(
    "a >MAX_REVIEW_ITEMS backlog drains fully across successive daily runs in %s mode, with no item silently marked reviewed",
    async (mode) => {
      const userId = `lr-drain-${mode}-${randomUUID().slice(0, 8)}`;
      enableReview(userId, mode);
      const seeded = seedManyLearnedRows(userId, 200);

      const shown = new Set<string>();
      const collectKeepAll = async (spec: { userContent: string }) => {
        const items = (JSON.parse(spec.userContent) as { reviewItems: Array<{ id: string; table: LearningReviewVerdict["table"] }> })
          .reviewItems;
        for (const it of items) shown.add(it.id);
        return verdictJson(
          items.map((it) => ({ id: it.id, table: it.table, verdict: "keep" as const, confidence: 90, reasoning: "sound" }))
        );
      };

      // Drive the real scheduler gate: only run on a day the trigger says to (mirrors production, where
      // runDailyLearningReviewIfDue guards runDailyLearningReview). Each iteration is a new UTC day so
      // the once-per-day marker allows the run.
      let runs = 0;
      let now = NOW;
      while (evaluateLearningReviewTrigger(userId, now, getPolicy(userId)).shouldRun) {
        const res = await runDailyLearningReview(userId, { now, llm: collectKeepAll });
        expect(res.ok).toBe(true);
        expect(res.skipped).toBeFalsy(); // a fresh un-reviewed slice every day — never a no-op skip
        runs += 1;
        now += 86_400_000;
        if (runs > 8) throw new Error("backlog failed to drain (possible re-show loop)");
      }

      // Every seeded item was shown to the LLM at least once — nothing was silently marked reviewed.
      expect(shown.size).toBe(200);
      for (const id of seeded) expect(shown.has(id)).toBe(true);
      // Bounded work: ceil(200 / 80) === 3 LLM runs, then the trigger goes quiet.
      expect(runs).toBe(3);
      expect(evaluateLearningReviewTrigger(userId, now, getPolicy(userId)).reason).toBe("no-new-items");
      // The store was never mutated away (keep is a no-op in both modes), so the drain came purely
      // from the marker advancing — the exact path this fix corrects.
      expect(listLearnedContext(userId)).toHaveLength(200);

      // Observability: the over-budget slices were audited as truncated (first two runs), the final
      // drain was not.
      const truncatedFlags = listAuditByKind("learning_review_summary", 20, userId)
        .map((a) => (a.payload as { truncated?: boolean }).truncated)
        .filter((t) => t !== undefined);
      expect(truncatedFlags.filter((t) => t === true)).toHaveLength(2);
      expect(truncatedFlags.filter((t) => t === false)).toHaveLength(1);
    }
  );
});

// ── Two adjacent gaps found by adversarial re-review of the #1278 finding #2 fix (deferred finding
// #2/#3 hardening): both reproduce the exact "shown to the LLM zero times, silently marked reviewed"
// failure mode PR #1328 was written to eliminate, just reached via different mechanisms than a plain
// MAX_REVIEW_ITEMS count overflow. Neither is covered by the existing drain suite above, which
// deliberately uses strictly-distinct timestamps that stay inside the 7-day pack window.

describe("tied-timestamp boundary (deferred finding #2/#3 hardening)", () => {
  it("a tied-timestamp cluster larger than MAX_REVIEW_ITEMS widens the shown set instead of freezing the drain", async () => {
    const MAX_REVIEW_ITEMS = 80;
    const userId = `lr-tie-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "decide");
    // 90 learned rows sharing the IDENTICAL assertedAt millisecond (e.g. a backfill/batch writer
    // reusing one `now()`). A pure id-ascending tie-break at the MAX_REVIEW_ITEMS boundary would
    // deterministically re-select the same 80 every run forever — this asserts the fix instead:
    // the cut widens to consume the whole tied cluster, so it drains in a single run.
    const tieTs = new Date(NOW - 86_400_000).toISOString();
    const rows = Array.from({ length: MAX_REVIEW_ITEMS + 10 }, () => seedLearnedRow(userId, { assertedAt: tieTs }));

    const pack = await buildLearningReviewContextPack(userId, NOW);
    expect(pack.items).toHaveLength(rows.length);
    expect(pack.truncated).toBe(false);
    expect(pack.reviewedThroughMs).toBe(NOW);

    const run = await runDailyLearningReview(userId, { now: NOW, llm: keepAllLlm() });
    expect(run.ok).toBe(true);
    expect(run.itemsReviewed).toBe(rows.length);
    expect(evaluateLearningReviewTrigger(userId, NOW + 3_600_000, getPolicy(userId)).reason).toBe("no-new-items");
  });
});

describe("multi-day drain vs. the 7-day pack window (deferred finding #2/#3 hardening)", () => {
  it("a budget-deferred item does not silently age out of the window before its later sweep", async () => {
    const MAX_REVIEW_ITEMS = 80;
    const userId = `lr-drain-window-race-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "decide");
    // 90 rows spanning NOW-6.99d (oldest) .. NOW-6.50d (newest), 8 minutes apart — all inside the
    // 7-day window TODAY, but close enough to its trailing edge that the newest (deferred) ones
    // would age OUT of tomorrow's window before a multi-day drain gets around to sweeping them.
    const rows = Array.from({ length: MAX_REVIEW_ITEMS + 10 }, (_, i) =>
      seedLearnedRow(userId, { assertedAt: new Date(NOW - (6.99 - i * (0.49 / (MAX_REVIEW_ITEMS + 9))) * 86_400_000).toISOString() })
    );

    // Day 0: truncated (90 > 80) — oldest 80 shown, newest 10 deferred.
    const day0 = await runDailyLearningReview(userId, { now: NOW, llm: keepAllLlm() });
    expect(day0.ok).toBe(true);
    expect(day0.itemsReviewed).toBe(MAX_REVIEW_ITEMS);
    const dueAfterDay0 = evaluateLearningReviewTrigger(userId, NOW, getPolicy(userId));
    expect(dueAfterDay0).toMatchObject({ shouldRun: true, newCount: 10 });

    // Day 1: one unrelated new lesson arrives. Without the window-widening fix, the 10 deferred
    // rows (now ~7 days old relative to day 1) would silently exit `candidates` — never shown, yet
    // this non-truncated run would still advance lastReviewedAt past them via reviewedThroughMs=now.
    const day1Now = NOW + 86_400_000;
    seedLearnedRow(userId, { assertedAt: new Date(day1Now).toISOString() });
    const shownDay1 = new Set<string>();
    const day1 = await runDailyLearningReview(userId, {
      now: day1Now,
      llm: async (spec: { userContent: string }) => {
        const items = (JSON.parse(spec.userContent) as { reviewItems: Array<{ id: string; table: LearningReviewVerdict["table"] }> })
          .reviewItems;
        for (const it of items) shownDay1.add(it.id);
        return verdictJson(items.map((it) => ({ id: it.id, table: it.table, verdict: "keep" as const, confidence: 90, reasoning: "sound" })));
      }
    });
    expect(day1.ok).toBe(true);
    // All 10 deferred rows PLUS the 1 new row were actually shown — none silently vanished.
    expect(day1.itemsReviewed).toBe(11);
    for (const r of rows.slice(MAX_REVIEW_ITEMS)) expect(shownDay1.has(r.id)).toBe(true);

    expect(evaluateLearningReviewTrigger(userId, day1Now + 3_600_000, getPolicy(userId)).reason).toBe("no-new-items");
  });

  it("surfaces accountEnvironment on review items and pins paper-parity in the system prompt", async () => {
    const userId = `lr-paper-parity-${randomUUID()}`;
    const paperLesson = seedLearnedRow(userId, {
      subject: "decision_lesson:MSFT:Momentum",
      value: "DeepSeek outperformed Grok on earnings-catalyst entries (paper account closed lots).",
      accountEnvironment: "paper",
      learningScope: "portfolio",
      assertedAt: new Date(NOW - 3_600_000).toISOString()
    });
    seedPendingRow(userId, {
      subject: "model_task:red_team",
      value: "Claude-as-reviewer had higher veto value-add on paper A/B runs.",
      accountEnvironment: "paper",
      learningScope: "portfolio"
    });

    // Contract the Learning Review Board must honor (owner 2026-08-04).
    expect(PAPER_ACCOUNT_LEARNING_PARITY_RULE).toMatch(/FIRST-CLASS/i);
    expect(PAPER_ACCOUNT_LEARNING_PARITY_RULE).toMatch(/PAPER-EXCLUSIVE/i);
    expect(PAPER_ACCOUNT_LEARNING_PARITY_RULE).toMatch(/model/i);

    const pack = await buildLearningReviewContextPack(userId, NOW);
    const paperItem = pack.items.find((it) => it.id === paperLesson.id);
    expect(paperItem).toMatchObject({
      accountEnvironment: "paper",
      learningScope: "portfolio"
    });
    expect(pack.items.some((it) => it.accountEnvironment === "paper" && it.table === "learned_context_pending")).toBe(true);

    // The system prompt (not just a unit-test constant) must carry the rule into the LLM call.
    let systemPromptSeen = "";
    await runDailyLearningReview(userId, {
      now: NOW,
      llm: async (spec) => {
        systemPromptSeen = spec.systemPrompt;
        const items = (JSON.parse(spec.userContent) as { reviewItems: Array<{ id: string; table: LearningReviewVerdict["table"]; accountEnvironment?: string | null }> })
          .reviewItems;
        expect(items.some((it) => it.accountEnvironment === "paper")).toBe(true);
        return JSON.stringify({
          reviews: items.map((it) => ({
            id: it.id,
            table: it.table,
            verdict: "keep",
            confidence: 85,
            reasoning: "Sample/attribution/still-true all pass; paper origin is first-class model evidence, not a defect."
          })),
          summary: "Kept paper-sourced model lessons."
        });
      }
    });
    expect(systemPromptSeen).toContain("PAPER-ACCOUNT PARITY");
    expect(systemPromptSeen).toContain("FIRST-CLASS");
    expect(systemPromptSeen).toMatch(/PAPER-EXCLUSIVE/i);
  });
});
