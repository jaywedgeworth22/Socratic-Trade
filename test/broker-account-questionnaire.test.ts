import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Root cause (2026-09-25, board 687a5fb4, lane G3): production evidence on the live Robinhood
// "Agentic" account showed 3 `placing_failed` rejections for "We're required to have you answer
// some questions about y[our...]" — an ACCOUNT-level Robinhood compliance gate, not a per-order
// sizing problem. This suite covers detection of that specific error text and the durable
// account-level hold it sets, independent of the strategy-loop wiring (covered by
// final-size-red-autonomous.test.ts-style integration elsewhere).
beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-account-questionnaire-${randomUUID()}.db`)}`;
});

describe("detectRobinhoodAccountQuestionnaireError", () => {
  it("matches the exact production error text (truncated mid-sentence)", async () => {
    const { detectRobinhoodAccountQuestionnaireError } = await import("../src/lib/broker-account-questionnaire");
    const message =
      'Robinhood place_equity_order response had no order id: {"text":"API error 400: {\\"non_field_errors\\":[\\"We\'re required to have you answer some questions about y';
    const reason = detectRobinhoodAccountQuestionnaireError(message);
    expect(reason).toContain("Robinhood");
    expect(reason).toContain("questionnaire");
  });

  it("does not match an unrelated 4xx error", async () => {
    const { detectRobinhoodAccountQuestionnaireError } = await import("../src/lib/broker-account-questionnaire");
    const reason = detectRobinhoodAccountQuestionnaireError("API error 400: Fractional orders must be at least $1.");
    expect(reason).toBeUndefined();
  });

  it("does not match an empty or generic message", async () => {
    const { detectRobinhoodAccountQuestionnaireError } = await import("../src/lib/broker-account-questionnaire");
    expect(detectRobinhoodAccountQuestionnaireError("")).toBeUndefined();
    expect(detectRobinhoodAccountQuestionnaireError("network timeout")).toBeUndefined();
  });
});

describe("account-level action-required state", () => {
  it("is unset until marked, then reads back the reason and a since timestamp", async () => {
    const { getAccountActionRequired, markAccountActionRequired } = await import("../src/lib/broker-account-questionnaire");
    const userId = `questionnaire-user-${randomUUID()}`;
    expect(getAccountActionRequired(userId, "RH-ACCOUNT")).toBeUndefined();

    markAccountActionRequired(userId, "RH-ACCOUNT", "Robinhood requires you to answer account questions.");
    const state = getAccountActionRequired(userId, "RH-ACCOUNT");
    expect(state?.reason).toBe("Robinhood requires you to answer account questions.");
    expect(typeof state?.since).toBe("string");
  });

  it("is scoped per (user, accountNumber) — not global", async () => {
    const { getAccountActionRequired, markAccountActionRequired } = await import("../src/lib/broker-account-questionnaire");
    const userId = `questionnaire-user-${randomUUID()}`;
    markAccountActionRequired(userId, "RH-ACCOUNT-A", "held A");
    expect(getAccountActionRequired(userId, "RH-ACCOUNT-B")).toBeUndefined();
    expect(getAccountActionRequired(`other-${userId}`, "RH-ACCOUNT-A")).toBeUndefined();
    expect(getAccountActionRequired(userId, "RH-ACCOUNT-A")?.reason).toBe("held A");
  });

  it("clears on clearAccountActionRequired and is a no-op when nothing is held", async () => {
    const { clearAccountActionRequired, getAccountActionRequired, markAccountActionRequired } = await import(
      "../src/lib/broker-account-questionnaire"
    );
    const userId = `questionnaire-user-${randomUUID()}`;
    markAccountActionRequired(userId, "RH-ACCOUNT", "held");
    clearAccountActionRequired(userId, "RH-ACCOUNT");
    expect(getAccountActionRequired(userId, "RH-ACCOUNT")).toBeUndefined();
    expect(() => clearAccountActionRequired(userId, "RH-ACCOUNT")).not.toThrow();
  });

  it("re-marking refreshes the reason and since timestamp (idempotent, not duplicated)", async () => {
    const { getAccountActionRequired, markAccountActionRequired } = await import("../src/lib/broker-account-questionnaire");
    const userId = `questionnaire-user-${randomUUID()}`;
    markAccountActionRequired(userId, "RH-ACCOUNT", "first");
    const first = getAccountActionRequired(userId, "RH-ACCOUNT");
    markAccountActionRequired(userId, "RH-ACCOUNT", "second");
    const second = getAccountActionRequired(userId, "RH-ACCOUNT");
    expect(second?.reason).toBe("second");
    expect(first?.reason).toBe("first");
  });
});

describe("shouldAlertAccountActionRequired cooldown", () => {
  it("alerts once per (user, accountNumber) and suppresses a second call within the cooldown window", async () => {
    const { shouldAlertAccountActionRequired } = await import("../src/lib/broker-account-questionnaire");
    const userId = `questionnaire-alert-${randomUUID()}`;
    expect(shouldAlertAccountActionRequired(userId, "RH-ACCOUNT")).toBe(true);
    expect(shouldAlertAccountActionRequired(userId, "RH-ACCOUNT")).toBe(false);
  });

  it("cooldown is scoped per (user, accountNumber), not global", async () => {
    const { shouldAlertAccountActionRequired } = await import("../src/lib/broker-account-questionnaire");
    const userId = `questionnaire-alert-${randomUUID()}`;
    expect(shouldAlertAccountActionRequired(userId, "RH-ACCOUNT-A")).toBe(true);
    expect(shouldAlertAccountActionRequired(userId, "RH-ACCOUNT-B")).toBe(true);
    expect(shouldAlertAccountActionRequired(`other-${userId}`, "RH-ACCOUNT-A")).toBe(true);
  });
});
