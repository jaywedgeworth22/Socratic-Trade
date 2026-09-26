import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Alert lifecycle (acknowledge / auto-ack sweep / repeat-dedup) added on top of notification_events.
// Each test gets its own temp SQLite file + vi.resetModules() so the module-level `db` singleton in
// src/lib/db.ts doesn't leak across tests (same idiom as test/policy-notification-events.test.ts).
beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-notify-lifecycle-${randomUUID()}.db`)}`;
});

describe("notification acknowledge + bulk ack scoping", () => {
  it("acknowledges only the requesting user's rows, never another user's", async () => {
    const { insertNotificationEvent, acknowledgeNotificationEvents, listNotificationEvents } = await import("../src/lib/db");
    const userA = `user-a-${randomUUID()}`;
    const userB = `user-b-${randomUUID()}`;

    const eventA = insertNotificationEvent({ userId: userA, type: "fill", title: "A fill", status: "skipped", payload: {} });
    const eventB = insertNotificationEvent({ userId: userB, type: "fill", title: "B fill", status: "skipped", payload: {} });

    // User A tries to acknowledge both their own row AND user B's row id.
    const changed = acknowledgeNotificationEvents(userA, [eventA.id, eventB.id]);
    expect(changed).toBe(1);

    expect(listNotificationEvents(userA).find((e) => e.id === eventA.id)?.acknowledgedAt).toBeTruthy();
    expect(listNotificationEvents(userB).find((e) => e.id === eventB.id)?.acknowledgedAt).toBeUndefined();
  });

  it("is idempotent — re-acking an already-acked row changes nothing", async () => {
    const { insertNotificationEvent, acknowledgeNotificationEvents } = await import("../src/lib/db");
    const userId = `user-${randomUUID()}`;
    const event = insertNotificationEvent({ userId, type: "fill", title: "Fill", status: "skipped", payload: {} });

    expect(acknowledgeNotificationEvents(userId, [event.id])).toBe(1);
    expect(acknowledgeNotificationEvents(userId, [event.id])).toBe(0);
  });

  it("bulk-acknowledges only the attention-matching rows for the requesting user", async () => {
    const { insertNotificationEvent, acknowledgeAllNotificationEvents, listNotificationEvents } = await import("../src/lib/db");
    const userA = `user-a-${randomUUID()}`;
    const userB = `user-b-${randomUUID()}`;

    const runFailedA = insertNotificationEvent({ userId: userA, type: "run_failed", title: "Run failed A", status: "skipped", payload: { summary: "boom" } });
    const fillA = insertNotificationEvent({ userId: userA, type: "fill", title: "Fill A", status: "skipped", payload: {} });
    const runFailedB = insertNotificationEvent({ userId: userB, type: "run_failed", title: "Run failed B", status: "skipped", payload: { summary: "boom" } });

    const changed = acknowledgeAllNotificationEvents(userA, "attention");
    expect(changed).toBe(1);

    const eventsA = listNotificationEvents(userA);
    expect(eventsA.find((e) => e.id === runFailedA.id)?.acknowledgedAt).toBeTruthy();
    // "fill" is not an attention type/status — untouched by the bulk attention ack.
    expect(eventsA.find((e) => e.id === fillA.id)?.acknowledgedAt).toBeUndefined();
    // User B's matching row is completely unaffected by user A's bulk ack.
    const eventsB = listNotificationEvents(userB);
    expect(eventsB.find((e) => e.id === runFailedB.id)?.acknowledgedAt).toBeUndefined();
  });

  it("bulk-acknowledges only rows in the given connectedAccountId (plus account-less rows), leaving other-account rows untouched", async () => {
    const { insertNotificationEvent, acknowledgeAllNotificationEvents, listNotificationEvents } = await import("../src/lib/db");
    const userId = `user-${randomUUID()}`;
    const accountX = randomUUID();
    const accountY = randomUUID();

    const runFailedX = insertNotificationEvent({ userId, connectedAccountId: accountX, type: "run_failed", title: "Run failed X", status: "skipped", payload: { summary: "boom x" } });
    const runFailedY = insertNotificationEvent({ userId, connectedAccountId: accountY, type: "run_failed", title: "Run failed Y", status: "skipped", payload: { summary: "boom y" } });
    const runFailedNoAccount = insertNotificationEvent({ userId, type: "run_failed", title: "Run failed, no account", status: "skipped", payload: { summary: "boom none" } });

    const changed = acknowledgeAllNotificationEvents(userId, "attention", accountX);
    // accountX's own row + the account-less row — but NOT accountY's row.
    expect(changed).toBe(2);

    const events = listNotificationEvents(userId);
    expect(events.find((e) => e.id === runFailedX.id)?.acknowledgedAt).toBeTruthy();
    expect(events.find((e) => e.id === runFailedNoAccount.id)?.acknowledgedAt).toBeTruthy();
    expect(events.find((e) => e.id === runFailedY.id)?.acknowledgedAt).toBeUndefined();
  });
});

describe("Alert Center attention filter excludes acknowledged rows", () => {
  it("matchesFilter('attention', ...) drops a row once acknowledgedAt is set", async () => {
    const { matchesFilter } = await import("../app/console/components/alert-center");
    const base = {
      id: "n1",
      createdAt: new Date().toISOString(),
      type: "run_failed" as const,
      title: "Strategy run failed",
      status: "skipped" as const,
      payload: {}
    };

    expect(matchesFilter(base, "attention")).toBe(true);
    expect(matchesFilter({ ...base, acknowledgedAt: new Date().toISOString() }, "attention")).toBe(false);
    // "all" stays unconditional on acknowledgedAt — acked rows remain visible under All.
    expect(matchesFilter({ ...base, acknowledgedAt: new Date().toISOString() }, "all")).toBe(true);
  });
});

describe("auto-ack sweep", () => {
  it("clears a pending_approval alert once its proposal leaves 'proposed' status", async () => {
    const { insertNotificationEvent, insertProposal, updateProposalStatus, sweepAutoAcknowledgeNotifications, listNotificationEvents } = await import(
      "../src/lib/db"
    );
    const userId = `user-${randomUUID()}`;
    const proposalId = randomUUID();

    insertProposal({
      id: proposalId,
      userId,
      runId: "run-1",
      accountNumber: "ACC-1",
      proposal: { symbol: "AAPL", side: "buy", type: "market", timeInForce: "gfd", marketHours: "regular_hours", rationale: "test" },
      decision: { approved: true, reasons: [] },
      status: "proposed"
    });
    const event = insertNotificationEvent({
      userId,
      type: "pending_approval",
      title: "AAPL awaiting approval",
      status: "skipped",
      payload: { proposalId }
    });

    // Still pending — the sweep must leave it alone.
    expect(sweepAutoAcknowledgeNotifications(userId)).toBe(0);
    expect(listNotificationEvents(userId).find((e) => e.id === event.id)?.acknowledgedAt).toBeUndefined();

    // Proposal leaves "proposed" (e.g. approved and placed) — now the alert is an orphan.
    updateProposalStatus(proposalId, "placed", undefined, undefined, undefined, userId);
    expect(sweepAutoAcknowledgeNotifications(userId)).toBe(1);
    expect(listNotificationEvents(userId).find((e) => e.id === event.id)?.acknowledgedAt).toBeTruthy();
  });

  it("clears a run_failed alert once the account's latest run completes successfully", async () => {
    const { insertNotificationEvent, insertStrategyRun, finishStrategyRun, sweepAutoAcknowledgeNotifications, listNotificationEvents } = await import(
      "../src/lib/db"
    );
    const userId = `user-${randomUUID()}`;
    const connectedAccountId = randomUUID();

    const event = insertNotificationEvent({
      userId,
      connectedAccountId,
      type: "run_failed",
      title: "Strategy run failed",
      status: "skipped",
      payload: { summary: "Green Team proposal failed using Google (Gemini) gemini-3.5-flash: INVALID_ARGUMENT" }
    });

    // No completed run yet for this account — nothing to prove resolution.
    expect(sweepAutoAcknowledgeNotifications(userId)).toBe(0);

    const runId = randomUUID();
    insertStrategyRun(runId, userId, connectedAccountId);
    finishStrategyRun(runId, "completed", "no-op run", userId);

    expect(sweepAutoAcknowledgeNotifications(userId)).toBe(1);
    expect(listNotificationEvents(userId).find((e) => e.id === event.id)?.acknowledgedAt).toBeTruthy();
  });

  it("leaves a run_failed alert unacknowledged when the account's latest run also failed", async () => {
    const { insertNotificationEvent, insertStrategyRun, finishStrategyRun, sweepAutoAcknowledgeNotifications, listNotificationEvents } = await import(
      "../src/lib/db"
    );
    const userId = `user-${randomUUID()}`;
    const connectedAccountId = randomUUID();

    const event = insertNotificationEvent({
      userId,
      connectedAccountId,
      type: "run_failed",
      title: "Strategy run failed",
      status: "skipped",
      payload: { summary: "boom" }
    });

    const runId = randomUUID();
    insertStrategyRun(runId, userId, connectedAccountId);
    finishStrategyRun(runId, "failed", "still broken", userId);

    expect(sweepAutoAcknowledgeNotifications(userId)).toBe(0);
    expect(listNotificationEvents(userId).find((e) => e.id === event.id)?.acknowledgedAt).toBeUndefined();
  });

  it("never sweeps a broker-verification run_failed alert, even once the account's latest run succeeds — a plain LLM run_failed alert IS swept", async () => {
    const { insertNotificationEvent, insertStrategyRun, finishStrategyRun, sweepAutoAcknowledgeNotifications, listNotificationEvents } = await import(
      "../src/lib/db"
    );
    const userId = `user-${randomUUID()}`;
    const connectedAccountId = randomUUID();

    // "placement uncertain — verify with broker" (src/lib/strategy.ts:1990 / :3615): a later
    // successful run does NOT prove the broker never accepted this specific order — a human must
    // still verify. Must never be auto-acked by the "latest run succeeded" heuristic.
    const brokerVerification = insertNotificationEvent({
      userId,
      connectedAccountId,
      type: "run_failed",
      title: "TSLA order placement uncertain — verify with broker",
      status: "skipped",
      payload: { proposalId: randomUUID(), refId: randomUUID(), error: "timeout contacting broker" }
    });
    // "declined by broker" (src/lib/strategy.ts:2016 / :3629): also references a specific order via
    // proposalId/orderId — same rule applies.
    const brokerDecline = insertNotificationEvent({
      userId,
      connectedAccountId,
      type: "run_failed",
      title: "TSLA order declined by broker (rejected)",
      status: "skipped",
      payload: { proposalId: randomUUID(), refId: randomUUID(), orderId: randomUUID(), state: "rejected" }
    });
    // Plain run-level failure (src/lib/strategy.ts:2161): no proposalId/orderId, no broker-verify
    // language — an LLM/provider failure with no order at stake. This one SHOULD stay sweepable.
    const plainRunFailure = insertNotificationEvent({
      userId,
      connectedAccountId,
      type: "run_failed",
      title: "Strategy run failed",
      status: "skipped",
      payload: { summary: "LLM provider error: 500 Internal Server Error" }
    });

    // The sweep requires the run to have finished strictly AFTER the alert was created (string
    // comparison of ISO timestamps) — force the clock forward a tick so this isn't a same-millisecond
    // coin flip (same idiom as test/rag-query-embed-cache.test.ts, test/llm-request.test.ts).
    await new Promise((resolve) => setTimeout(resolve, 5));

    const runId = randomUUID();
    insertStrategyRun(runId, userId, connectedAccountId);
    finishStrategyRun(runId, "completed", "no-op run", userId);

    expect(sweepAutoAcknowledgeNotifications(userId)).toBe(1);

    const events = listNotificationEvents(userId);
    expect(events.find((e) => e.id === brokerVerification.id)?.acknowledgedAt).toBeUndefined();
    expect(events.find((e) => e.id === brokerDecline.id)?.acknowledgedAt).toBeUndefined();
    expect(events.find((e) => e.id === plainRunFailure.id)?.acknowledgedAt).toBeTruthy();
  });
});

describe("repeat-dedup for run_failed", () => {
  it("auto-acknowledges the older row on a matching repeat, keeping exactly one live attention row", async () => {
    const { insertNotificationEvent, listNotificationEvents } = await import("../src/lib/db");
    const { matchesFilter } = await import("../app/console/components/alert-center");
    const userId = `user-${randomUUID()}`;
    const connectedAccountId = randomUUID();
    const summary = "Green Team proposal failed using Google (Gemini) gemini-3.5-flash: 400 INVALID_ARGUMENT";

    const first = insertNotificationEvent({
      userId,
      connectedAccountId,
      type: "run_failed",
      title: "Strategy run failed",
      status: "skipped",
      payload: { runId: randomUUID(), summary }
    });
    const second = insertNotificationEvent({
      userId,
      connectedAccountId,
      type: "run_failed",
      title: "Strategy run failed",
      status: "skipped",
      payload: { runId: randomUUID(), summary }
    });

    const events = listNotificationEvents(userId);
    const firstRow = events.find((e) => e.id === first.id)!;
    const secondRow = events.find((e) => e.id === second.id)!;

    expect(firstRow.acknowledgedAt).toBeTruthy();
    expect(secondRow.acknowledgedAt).toBeUndefined();

    const liveAttentionRows = events.filter((e) => matchesFilter(e, "attention"));
    expect(liveAttentionRows).toHaveLength(1);
    expect(liveAttentionRows[0]?.id).toBe(second.id);
  });

  it("does not dedupe across different accounts or different error signatures", async () => {
    const { insertNotificationEvent, listNotificationEvents } = await import("../src/lib/db");
    const userId = `user-${randomUUID()}`;
    const accountX = randomUUID();
    const accountY = randomUUID();

    const sameAccountDifferentError = [
      insertNotificationEvent({ userId, connectedAccountId: accountX, type: "run_failed", title: "Strategy run failed", status: "skipped", payload: { summary: "error one" } }),
      insertNotificationEvent({ userId, connectedAccountId: accountX, type: "run_failed", title: "Strategy run failed", status: "skipped", payload: { summary: "error two" } })
    ];
    const differentAccountSameError = insertNotificationEvent({
      userId,
      connectedAccountId: accountY,
      type: "run_failed",
      title: "Strategy run failed",
      status: "skipped",
      payload: { summary: "error one" }
    });

    const events = listNotificationEvents(userId);
    for (const event of sameAccountDifferentError) {
      expect(events.find((e) => e.id === event.id)?.acknowledgedAt).toBeUndefined();
    }
    expect(events.find((e) => e.id === differentAccountSameError.id)?.acknowledgedAt).toBeUndefined();
  });

  it("does not dedupe two different-symbol alerts that share the same generic error message", async () => {
    // Regression for: normalizeRunFailedSignature used to base its signature on summary/error ALONE.
    // "fetch failed" is identical across symbols, so an AAPL and a TSLA placement failure in the
    // same account/window used to collapse into one signature and wrongly auto-ack one of them. The
    // title (which carries the symbol) must now always be part of the signature.
    const { insertNotificationEvent, listNotificationEvents } = await import("../src/lib/db");
    const userId = `user-${randomUUID()}`;
    const connectedAccountId = randomUUID();
    const genericError = "fetch failed";

    const aapl = insertNotificationEvent({
      userId,
      connectedAccountId,
      type: "run_failed",
      title: "AAPL order placement uncertain — verify with broker",
      status: "skipped",
      payload: { proposalId: randomUUID(), error: genericError }
    });
    const tsla = insertNotificationEvent({
      userId,
      connectedAccountId,
      type: "run_failed",
      title: "TSLA order placement uncertain — verify with broker",
      status: "skipped",
      payload: { proposalId: randomUUID(), error: genericError }
    });

    const events = listNotificationEvents(userId);
    expect(events.find((e) => e.id === aapl.id)?.acknowledgedAt).toBeUndefined();
    expect(events.find((e) => e.id === tsla.id)?.acknowledgedAt).toBeUndefined();
  });
});

describe("POST /api/notifications/ack — user-scoped", () => {
  it("acknowledges by ids only for the authenticated requester, never cross-user", async () => {
    const { insertNotificationEvent, listNotificationEvents } = await import("../src/lib/db");
    const { POST } = await import("../app/api/notifications/ack/route");

    const emailA = `ack-user-a-${randomUUID()}@example.test`;
    const emailB = `ack-user-b-${randomUUID()}@example.test`;
    const { userIdForEmail } = await import("../src/lib/auth/identity");
    const userA = userIdForEmail(emailA);
    const userB = userIdForEmail(emailB);

    const eventA = insertNotificationEvent({ userId: userA, type: "fill", title: "A fill", status: "skipped", payload: {} });
    const eventB = insertNotificationEvent({ userId: userB, type: "fill", title: "B fill", status: "skipped", payload: {} });

    const response = await POST(
      new Request("http://localhost/api/notifications/ack", {
        method: "POST",
        headers: { "content-type": "application/json", "x-authenticated-user-email": emailA },
        // Attempt to ack both — a client-supplied userId/id for another user must never take effect.
        body: JSON.stringify({ ids: [eventA.id, eventB.id] })
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.acknowledged).toBe(1);
    expect(listNotificationEvents(userA).find((e) => e.id === eventA.id)?.acknowledgedAt).toBeTruthy();
    expect(listNotificationEvents(userB).find((e) => e.id === eventB.id)?.acknowledgedAt).toBeUndefined();
  });

  it("bulk-acknowledges only the requester's attention-matching rows via { all: true, filter: 'attention' }", async () => {
    const { insertNotificationEvent, listNotificationEvents } = await import("../src/lib/db");
    const { POST } = await import("../app/api/notifications/ack/route");

    const emailA = `ack-bulk-a-${randomUUID()}@example.test`;
    const emailB = `ack-bulk-b-${randomUUID()}@example.test`;
    const { userIdForEmail } = await import("../src/lib/auth/identity");
    const userA = userIdForEmail(emailA);
    const userB = userIdForEmail(emailB);

    const runFailedA = insertNotificationEvent({ userId: userA, type: "run_failed", title: "Run failed A", status: "skipped", payload: { summary: "boom" } });
    const runFailedB = insertNotificationEvent({ userId: userB, type: "run_failed", title: "Run failed B", status: "skipped", payload: { summary: "boom" } });

    const response = await POST(
      new Request("http://localhost/api/notifications/ack", {
        method: "POST",
        headers: { "content-type": "application/json", "x-authenticated-user-email": emailA },
        body: JSON.stringify({ all: true, filter: "attention" })
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.acknowledged).toBe(1);
    expect(listNotificationEvents(userA).find((e) => e.id === runFailedA.id)?.acknowledgedAt).toBeTruthy();
    expect(listNotificationEvents(userB).find((e) => e.id === runFailedB.id)?.acknowledgedAt).toBeUndefined();
  });

  it("bulk-acknowledges scoped to connectedAccountId, leaving the requester's OTHER connected account untouched", async () => {
    // Regression: the Alert Center's attention list is filtered to the active account (+ account-less
    // rows), but the old ack-all path was only user-scoped — "Acknowledge all" would silently ack
    // hidden other-account alerts the owner never saw in that view.
    const { insertNotificationEvent, listNotificationEvents } = await import("../src/lib/db");
    const { POST } = await import("../app/api/notifications/ack/route");

    const email = `ack-scoped-${randomUUID()}@example.test`;
    const { userIdForEmail } = await import("../src/lib/auth/identity");
    const userId = userIdForEmail(email);
    const accountX = randomUUID();
    const accountY = randomUUID();

    const runFailedX = insertNotificationEvent({ userId, connectedAccountId: accountX, type: "run_failed", title: "Run failed X", status: "skipped", payload: { summary: "boom x" } });
    const runFailedY = insertNotificationEvent({ userId, connectedAccountId: accountY, type: "run_failed", title: "Run failed Y", status: "skipped", payload: { summary: "boom y" } });

    const response = await POST(
      new Request("http://localhost/api/notifications/ack", {
        method: "POST",
        headers: { "content-type": "application/json", "x-authenticated-user-email": email },
        body: JSON.stringify({ all: true, filter: "attention", connectedAccountId: accountX })
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.acknowledged).toBe(1);
    expect(listNotificationEvents(userId).find((e) => e.id === runFailedX.id)?.acknowledgedAt).toBeTruthy();
    expect(listNotificationEvents(userId).find((e) => e.id === runFailedY.id)?.acknowledgedAt).toBeUndefined();
  });
});

describe("broker-verification alert resolution + reconcile-marker sweepability", () => {
  it("resolveBrokerVerificationNotifications acks an uncertain alert by proposalId — never a declined one", async () => {
    const { insertNotificationEvent, resolveBrokerVerificationNotifications, listNotificationEvents } = await import("../src/lib/db");
    const userId = `resolve-${randomUUID()}`;
    const pX = randomUUID();

    const uncertain = insertNotificationEvent({
      userId, type: "run_failed", status: "sent",
      title: "AAPL order placement uncertain — verify with broker",
      payload: { proposalId: pX, refId: randomUUID(), reconcile: "uncertain" }
    });
    const pDeclined = randomUUID();
    const declined = insertNotificationEvent({
      userId, type: "run_failed", status: "sent",
      title: "TSLA order declined by broker (rejected)",
      payload: { proposalId: pDeclined, reconcile: "declined" }
    });

    const resolved = resolveBrokerVerificationNotifications(userId, { proposalId: pX, resolution: "recovered" });
    expect(resolved).toBe(1);

    const notifs = listNotificationEvents(userId);
    expect(notifs.find((n) => n.id === uncertain.id)?.acknowledgedAt).toBeTruthy();
    // A declined alert is a standing fact — never auto-resolved, even if we (wrongly) key it.
    const declinedAgain = resolveBrokerVerificationNotifications(userId, { proposalId: pDeclined, resolution: "recovered" });
    expect(declinedAgain).toBe(0);
    expect(listNotificationEvents(userId).find((n) => n.id === declined.id)?.acknowledgedAt).toBeUndefined();
  });

  it("an unresolved uncertain alert stays perpetual — the sweep never clears it even after a later completed run", async () => {
    const { insertNotificationEvent, insertStrategyRun, finishStrategyRun, sweepAutoAcknowledgeNotifications, listNotificationEvents } = await import("../src/lib/db");
    const userId = `perpetual-${randomUUID()}`;
    const acct = randomUUID();

    const uncertain = insertNotificationEvent({
      userId, connectedAccountId: acct, type: "run_failed", status: "sent",
      title: "AAPL order placement uncertain — verify with broker",
      payload: { proposalId: randomUUID(), refId: randomUUID(), reconcile: "uncertain" }
    });
    // A later completed run for the same account — which WOULD clear a plain run_failed row.
    const runId = randomUUID();
    insertStrategyRun(runId, userId, acct);
    finishStrategyRun(runId, "completed", "ok", userId);

    const acked = sweepAutoAcknowledgeNotifications(userId);
    expect(acked).toBe(0);
    expect(listNotificationEvents(userId).find((n) => n.id === uncertain.id)?.acknowledgedAt).toBeUndefined();
  });

  // Lane G3 (2026-09-25): the Robinhood account-questionnaire hold is a STANDING account-level
  // gate (broker-account-questionnaire.ts) — a later run completing successfully (e.g. a sell)
  // does not prove entries are unblocked, so this must stay perpetual like "uncertain"/"declined".
  it("an account-questionnaire hold alert stays perpetual — the sweep never clears it even after a later completed run", async () => {
    const { insertNotificationEvent, insertStrategyRun, finishStrategyRun, sweepAutoAcknowledgeNotifications, listNotificationEvents } = await import("../src/lib/db");
    const userId = `account-action-required-${randomUUID()}`;
    const acct = randomUUID();

    const held = insertNotificationEvent({
      userId, connectedAccountId: acct, type: "run_failed", status: "sent",
      title: "RH-ACCOUNT needs your action on Robinhood",
      payload: { proposalId: randomUUID(), refId: randomUUID(), reconcile: "account_action_required" }
    });
    const runId = randomUUID();
    insertStrategyRun(runId, userId, acct);
    finishStrategyRun(runId, "completed", "ok", userId);

    const acked = sweepAutoAcknowledgeNotifications(userId);
    expect(acked).toBe(0);
    expect(listNotificationEvents(userId).find((n) => n.id === held.id)?.acknowledgedAt).toBeUndefined();
  });

  it("a not_placed alert IS sweepable — self-clears once the account's latest completed run post-dates it", async () => {
    const { insertNotificationEvent, insertStrategyRun, finishStrategyRun, sweepAutoAcknowledgeNotifications, listNotificationEvents } = await import("../src/lib/db");
    const userId = `notplaced-${randomUUID()}`;
    const acct = randomUUID();

    const notPlaced = insertNotificationEvent({
      userId, connectedAccountId: acct, type: "run_failed", status: "sent",
      title: "AAPL order was NOT placed — safe to retry",
      payload: { proposalId: randomUUID(), refId: randomUUID(), reconcile: "not_placed" }
    });
    const runId = randomUUID();
    insertStrategyRun(runId, userId, acct);
    finishStrategyRun(runId, "completed", "ok", userId);

    const acked = sweepAutoAcknowledgeNotifications(userId);
    expect(acked).toBe(1);
    expect(listNotificationEvents(userId).find((n) => n.id === notPlaced.id)?.acknowledgedAt).toBeTruthy();
  });

  it("legacy uncertain row (no reconcile marker) is still sweep-protected AND resolvable by proposalId", async () => {
    const { insertNotificationEvent, insertStrategyRun, finishStrategyRun, sweepAutoAcknowledgeNotifications, resolveBrokerVerificationNotifications, listNotificationEvents } = await import("../src/lib/db");
    const userId = `legacy-${randomUUID()}`;
    const acct = randomUUID();
    const pLegacy = randomUUID();

    const legacy = insertNotificationEvent({
      userId, connectedAccountId: acct, type: "run_failed", status: "sent",
      title: "AAPL order placement uncertain — verify with broker",
      payload: { proposalId: pLegacy } // no reconcile marker — persisted before the marker existed
    });
    const runId = randomUUID();
    insertStrategyRun(runId, userId, acct);
    finishStrategyRun(runId, "completed", "ok", userId);

    // The sweep must NOT clear it (text fallback keeps it protected).
    expect(sweepAutoAcknowledgeNotifications(userId)).toBe(0);
    expect(listNotificationEvents(userId).find((n) => n.id === legacy.id)?.acknowledgedAt).toBeUndefined();

    // But a confirmed recovery still resolves it via the legacy title fallback.
    expect(resolveBrokerVerificationNotifications(userId, { proposalId: pLegacy, resolution: "recovered" })).toBe(1);
    expect(listNotificationEvents(userId).find((n) => n.id === legacy.id)?.acknowledgedAt).toBeTruthy();
  });
});
