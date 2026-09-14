/** Typed client for the console's mutations. Every function talks to the REAL
 *  existing endpoints — nothing here simulates. Errors are thrown as
 *  ConsoleApiError (human-readable message) so callers can surface them in a
 *  non-blocking notice. The live-approval typed-confirmation contract mirrors
 *  app/api/proposals/[id]/approve/route.ts exactly. */

import { beginConsoleMutation, endConsoleMutation, isConsoleMutationMethod } from "./mutation-busy";
import type { LookaheadAuditFindingRow } from "@/lib/db-lookahead-audit";
import type { SignalHealthSnapshotRow } from "@/lib/db-signal-health";
import type { LookaheadVerdict } from "@/lib/lookahead-audit";
import type { LlmReasoningEffort, PerformanceSummary, ScoringWeights, StrategyProfile, StrategyTuningProposal, SystemState, TradingPolicy } from "@/lib/types";

export class ConsoleApiError extends Error {
  status: number;
  payload?: unknown;

  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = "ConsoleApiError";
    this.status = status;
    this.payload = payload;
  }
}

// ── Session-expiry → login redirect ─────────────────────────────────────────
//
// middleware.ts already fails closed on an unauthenticated PAGE navigation (redirect to
// /login) and on an unauthenticated /api/* request (plain 401). What it cannot do is notice a
// session that expires WHILE the console is already open: every console screen reads live data
// from one polled GET /api/dashboard snapshot (useConsoleData.tsx) plus one-off mutations
// through `request` below, and a 401 from either used to be handled exactly like a network
// blip — logged as a generic error string while the last-good snapshot kept rendering as if it
// were still live. On a trading desk that is dangerous: the user keeps looking at stale
// positions/orders that stopped updating the moment their session died, with no signal that
// anything is wrong beyond a small "delayed" chip.
//
// Fix: ANY 401 that reaches this client's fetch wrapper sends the browser to the SAME /login
// page middleware already uses for a page-level fail-closed redirect (no second auth-redirect
// mechanism invented), preserving the current location as `callbackUrl` so a fresh sign-in
// returns the user where they were.
let redirectingToLogin = false;

/** True once a 401 has been seen and the browser is being sent to /login. useConsoleData reads
 *  this so it can stop treating the in-memory snapshot as live and stop scheduling further
 *  background fetches once the session is known dead — the redirect itself is not instant. */
export function isRedirectingToLogin(): boolean {
  return redirectingToLogin;
}

/** Idempotent: a second 401 arriving while the navigation is already underway (e.g. the
 *  dashboard poll and a mutation both fail around the same time) is a no-op, and this refuses
 *  to fire at all from /login itself — the one guard that keeps a 401 from an auth-adjacent
 *  page from ever bouncing back to itself in a loop. Exported so the console's OTHER
 *  self-contained request clients (settings/lib.ts, orders/api.ts — deliberately not merged
 *  into this file's own `request<T>`, see those files' headers) can fail closed on a 401
 *  through the same one destination instead of leaving the user on a dead session until the
 *  next dashboard poll notices. */
export function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  if (redirectingToLogin) return;
  if (window.location.pathname === "/login" || window.location.pathname.startsWith("/login/")) return;
  redirectingToLogin = true;
  // Fragment-driven console views (app/console/guardrails#autonomy, app/console/strategy#models,
  // settings/connections anchors) read window.location.hash to pick or scroll to a subsection —
  // dropping it here would land a fresh sign-in back on the route's default view instead of
  // where the user actually was.
  const callbackUrl = `${window.location.pathname}${window.location.search}${window.location.hash || ""}`;
  // A hard navigation (not useRouter().push()/next/navigation's redirect(), which need a
  // component render/event-handler context this plain client module doesn't have) is the
  // correct choice here, not a shortcut: it forces a fresh request through middleware.ts's own
  // fail-closed auth gate rather than trusting any client-side router cache, matching the same
  // window.location.href pattern this codebase already uses for auth-adjacent navigation (e.g.
  // settings/danger.tsx's sign-out redirect, settings/brokers.tsx's OAuth start).
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- intentional hard navigation, see above
  window.location.href = `/login?callbackUrl=${encodeURIComponent(callbackUrl)}`;
}

/** Thrown when the approve endpoint answers 409 LIVE_CONFIRMATION_REQUIRED.
 *  `expectedText` is the server-authoritative phrase (e.g. "APPROVE LIVE NVDA"). */
export class LiveConfirmationRequiredError extends Error {
  reasons: string[];
  expectedText: string;

  constructor(reasons: string[], expectedText: string) {
    super(reasons.join(" ") || "Typed confirmation required.");
    this.name = "LiveConfirmationRequiredError";
    this.reasons = reasons;
    this.expectedText = expectedText;
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json().catch(() => undefined);
  }
  return res.text().catch(() => undefined);
}

function messageFrom(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (typeof p.message === "string" && p.message) return p.message;
    if (typeof p.summary === "string" && p.summary) return p.summary;
    if (typeof p.error === "string" && p.error) return p.error;
  }
  return fallback;
}

/** True when a non-ok response's body is an HTML error page rather than this API's normal
 *  JSON/plain-text contract — e.g. Cloudflare's raw 524 "edge timeout" interstitial, or any other
 *  proxy/edge error page. Checked on BOTH the header and the body's own leading bytes: an edge
 *  proxy's error page can arrive with a missing or misleading content-type, so header-only
 *  detection isn't enough — this is what let a raw Cloudflare 524 page reach `messageFrom` before
 *  (a non-empty string payload was returned verbatim as the "message"). */
function looksLikeHtml(contentType: string, payload: unknown): boolean {
  if (contentType.includes("text/html")) return true;
  if (typeof payload !== "string") return false;
  const head = payload.trimStart().slice(0, 15).toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html");
}

/** Clean, human message for a non-2xx response whose body is a raw HTML error page — this is
 *  NEVER rendered verbatim to the user. Cloudflare's edge timeout (524) is called out by name
 *  since a slow LLM-driven strategy run routinely triggers it in production (Coolify migration —
 *  the origin keeps running past the ~100s edge budget); other 5xx-range edge statuses and any
 *  other HTML error page get a generic "edge/proxy error" framing that still surfaces the code. */
function edgeErrorMessage(status: number): string {
  if (status === 524) {
    return "The server took too long to respond at the edge (524).  The operation may still be running — check the Activity feed.";
  }
  if (status >= 520 && status <= 530) {
    return `The edge network returned an error (${status}) instead of reaching the app.  The operation may still be running — check the Activity feed.`;
  }
  return `The server returned an unexpected error page (${status}) instead of a normal response.  The operation may still be running — check the Activity feed.`;
}

/** Shared by every helper below so a raw HTML error page is never surfaced as an error message —
 *  applying this at the ONE shared response-error builder (rather than per-caller) means every
 *  dialog that goes through `request<T>` or `fetchDashboard` benefits automatically. */
function buildResponseError(res: Response, payload: unknown, fallback: string): ConsoleApiError {
  const contentType = res.headers.get("content-type") ?? "";
  if (looksLikeHtml(contentType, payload)) {
    return new ConsoleApiError(edgeErrorMessage(res.status), res.status, payload);
  }
  return new ConsoleApiError(messageFrom(payload, fallback), res.status, payload);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const track = isConsoleMutationMethod(init?.method);
  if (track) beginConsoleMutation();
  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
    });
  } catch {
    throw new ConsoleApiError("Network error — the server could not be reached.", 0);
  } finally {
    if (track) endConsoleMutation();
  }
  const payload = await parseBody(res);
  if (!res.ok) {
    if (res.status === 401) redirectToLogin();
    throw buildResponseError(res, payload, `Request failed (${res.status}).`);
  }
  return payload as T;
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

export async function fetchDashboard<T>(signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch("/api/dashboard", { cache: "no-store", signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ConsoleApiError("Network error — the server could not be reached.", 0);
  }
  if (!res.ok) {
    if (res.status === 401) redirectToLogin();
    const payload = await parseBody(res);
    throw buildResponseError(res, payload, `Snapshot failed (${res.status}).`);
  }
  return (await res.json()) as T;
}

// ── Strategy run-state ───────────────────────────────────────────────────────

export interface RunOnceResult {
  runId: string;
  /** "started": the route launched the run and returned before it finished (real runs can take
   *  several minutes on LLM-heavy steps) — the run keeps executing server-side; track it via the
   *  existing Activity/snapshot polling, not this response. */
  status: "completed" | "failed" | "started" | "queued";
  summary: string;
}

/** Manual run — the server forces manual runs to propose-only authority. Async: the route
 *  persists a run id and returns `status: "queued"` (202) before executing.
 *
 *  Singleflighted: if two callers (e.g. the dual desktop+mobile RunOnceButton instances that
 *  both listen to the same `console:run-once` window event) call runOnce() concurrently, they
 *  share the exact same in-flight Promise so only one POST is ever issued per event cycle. The
 *  server also dedupes via queueStrategyRunRequest, but this eliminates the duplicate request
 *  and the duplicate toast/busy-state pair on the client. */
let _runOnceInFlight: Promise<RunOnceResult> | null = null;
export function runOnce(): Promise<RunOnceResult> {
  if (_runOnceInFlight) return _runOnceInFlight;
  const p = request<RunOnceResult>("/api/strategy/run", { method: "POST", body: JSON.stringify({ manual: true }) });
  _runOnceInFlight = p;
  p.finally(() => { _runOnceInFlight = null; });
  return p;
}

/** STOP everything: systemState → halted. Never sells anything. */
export function stopEverything(): Promise<TradingPolicy> {
  return request<TradingPolicy>("/api/strategy/pause", { method: "POST" });
}

/** Start scheduled runs: systemState → active (server verifies account + universe + agenticAllowed). */
export function startStrategy(): Promise<TradingPolicy> {
  return request<TradingPolicy>("/api/strategy/enable", { method: "POST" });
}

/** Set close_only / liquidating via the policy endpoint (halted goes through stopEverything,
 *  active through startStrategy so the server's arming preconditions run). */
let policyWriteTail: Promise<void> = Promise.resolve();

/** Serialize every policy PUT in this browser module, not merely saves issued by one card's
 *  useAutoSave instance. The endpoint performs a read/merge/write; cross-card concurrency would
 *  otherwise let the last response overwrite a sibling card's freshly persisted field. */
function enqueuePolicyWrite<T>(run: () => Promise<T>): Promise<T> {
  const result = policyWriteTail.then(run, run);
  policyWriteTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function targetedPolicyBody(patch: PolicyPatchBody, targetConnectedAccountId?: string): string {
  return JSON.stringify({
    ...patch,
    ...(targetConnectedAccountId ? { targetConnectedAccountId } : {})
  });
}

export function setSystemState(
  state: Exclude<SystemState, "active" | "halted">,
  targetConnectedAccountId?: string
): Promise<TradingPolicy> {
  return enqueuePolicyWrite(() =>
    request<TradingPolicy>("/api/policy", {
      method: "PUT",
      body: targetedPolicyBody({ systemState: state }, targetConnectedAccountId)
    })
  );
}

// ── Policy / prompt ──────────────────────────────────────────────────────────

export type PolicyPatchBody = Record<string, unknown> & { strategyPrompt?: string };

export function savePolicy(patch: PolicyPatchBody, targetConnectedAccountId?: string): Promise<TradingPolicy> {
  return enqueuePolicyWrite(() =>
    request<TradingPolicy>("/api/policy", {
      method: "PUT",
      body: targetedPolicyBody(patch, targetConnectedAccountId)
    })
  );
}

/** AI strategy review (#12): POST the existing tune endpoint. The server builds
 *  the evidence pack (performance, missed opportunities, factor scorecard,
 *  macro) and returns a reviewed proposal; nothing is applied until the user
 *  commits it through savePolicy. `tuningConfigWarnings` piggybacks on the
 *  manual path as cautions (never blocks). The server now ALSO persists every
 *  generated review (so an unapplied one can be restored after a reload/crash —
 *  see fetchLatestTuneReview/resolveTuneReview below) and returns its id as
 *  `reviewId`. */
export interface StrategyTuneResult extends StrategyTuningProposal {
  tuningConfigWarnings?: Array<{ message: string }>;
  /** Id of the persisted review row — pass to resolveTuneReview once the user applies or
   *  dismisses it (including a review restored via fetchLatestTuneReview). */
  /** Present on fresh POST /api/strategy/tune responses; ABSENT inside the persisted `result`
   *  blob returned by GET (the row id is `LatestTuneReview.id` there). */
  reviewId?: string;
}

/** `targetConnectedAccountId` pins the review to the account it was actually generated for — the
 *  same evidence/cost/account-scoping every other strategy write already applies (savePolicy,
 *  copyProfileToAccount, etc.). Without it the server used to default to whichever account was
 *  globally active, which could silently attribute cost/evidence to the wrong account. */
export function tuneStrategy(
  model?: string,
  reasoningEffort?: LlmReasoningEffort,
  targetConnectedAccountId?: string
): Promise<StrategyTuneResult> {
  return request<StrategyTuneResult>("/api/strategy/tune", {
    method: "POST",
    body: JSON.stringify({
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(targetConnectedAccountId ? { targetConnectedAccountId } : {})
    })
  });
}

/** One persisted-but-not-yet-resolved (or just-resolved) AI review row, as returned by
 *  GET /api/strategy/tune. `result` is the exact same shape tuneStrategy's POST resolves with. */
export interface LatestTuneReview {
  id: string;
  createdAt: string;
  model: string;
  reasoningEffort?: LlmReasoningEffort;
  generatedBy: StrategyTuneResult["generatedBy"];
  status: string;
  result: StrategyTuneResult;
}

/** Fetch the latest OPEN (unapplied, undismissed) AI review for an account, if any — used to
 *  restore an in-progress review after a reload/crash so it isn't silently lost. Resilient by
 *  design: the server side of this contract may not exist yet / may be mid-rollout, and a restore
 *  is a nice-to-have, not a blocking requirement — any failure (network, 404, 500) resolves to
 *  `null` rather than throwing, so callers never need their own try/catch for this. */
export async function fetchLatestTuneReview(connectedAccountId?: string): Promise<LatestTuneReview | null> {
  try {
    const qs = connectedAccountId ? `?connectedAccountId=${encodeURIComponent(connectedAccountId)}` : "";
    const { review } = await request<{ review: LatestTuneReview | null }>(`/api/strategy/tune${qs}`);
    return review ?? null;
  } catch {
    return null;
  }
}

/** Mark a persisted AI review applied or dismissed (Discard, or dismissing the "restored review"
 *  banner). Best-effort from the caller's perspective — see page.tsx, which never blocks the UI
 *  on this resolving. */
export function resolveTuneReview(reviewId: string, status: "applied" | "dismissed"): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/strategy/tune", {
    method: "PATCH",
    body: JSON.stringify({ reviewId, status })
  });
}

// ── Proposals ────────────────────────────────────────────────────────────────

export interface LiveApprovalConfirmationBody {
  proposalId: string;
  accountNumber?: string | null;
  executionMode: "broker/live";
  estimatedNotional?: number | null;
  typedText: string;
}

export interface ApproveResult {
  status: string;
  orderId?: string;
  brokerState?: string;
  fillStatus?: string;
  reasons?: string[];
}

// Approval intentionally shares the per-account strategy lock. A long LLM run can therefore
// overlap a click by many seconds (strategy + Red Team often run 30–120s+). Retry only the
// lock's side-effect-free Busy result so the user does not have to guess when the run finished.
// The server remains authoritative on every attempt; total wait is bounded (~3 minutes).
const APPROVAL_BUSY_RETRY_DELAYS_MS = [
  1_000, 2_000, 3_000, 5_000, 5_000, 10_000, 10_000,
  15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000
];

function waitForApprovalRetry(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryRedTeam(id: string): Promise<{ ok: true; proposalId: string }> {
  return request(`/api/proposals/${encodeURIComponent(id)}/retry-red-team`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export async function approveProposal(
  id: string,
  liveConfirmation?: LiveApprovalConfirmationBody
): Promise<ApproveResult> {
  const submit = async (): Promise<ApproveResult> => {
    try {
      return await request<ApproveResult>(`/api/proposals/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        body: JSON.stringify(liveConfirmation ? { liveConfirmation } : {})
      });
    } catch (error) {
      if (error instanceof ConsoleApiError && error.status === 409 && error.payload && typeof error.payload === "object") {
        const p = error.payload as { error?: string; reasons?: string[]; expectedText?: string; message?: string };
        if (p.error === "LIVE_CONFIRMATION_REQUIRED" && typeof p.expectedText === "string") {
          throw new LiveConfirmationRequiredError(Array.isArray(p.reasons) ? p.reasons : [], p.expectedText);
        }
      }
      throw error;
    }
  };

  for (let attempt = 0; ; attempt += 1) {
    const result = await submit();
    if (result.status !== "busy" || attempt >= APPROVAL_BUSY_RETRY_DELAYS_MS.length) return result;
    await waitForApprovalRetry(APPROVAL_BUSY_RETRY_DELAYS_MS[attempt]!);
  }
}

export interface BulkApproveResult extends ApproveResult {
  proposalId: string;
  symbol?: string;
}

export async function bulkApproveProposals(
  proposalIds: string[],
  liveConfirmation?: { typedText: string }
): Promise<{ results: BulkApproveResult[] }> {
  try {
    return await request<{ results: BulkApproveResult[] }>("/api/proposals/bulk-approve", {
      method: "POST",
      body: JSON.stringify({ proposalIds, ...(liveConfirmation ? { liveConfirmation } : {}) })
    });
  } catch (error) {
    if (error instanceof ConsoleApiError && error.status === 409 && error.payload && typeof error.payload === "object") {
      const p = error.payload as { error?: string; reasons?: string[]; expectedText?: string; message?: string };
      if (p.error === "LIVE_CONFIRMATION_REQUIRED" && typeof p.expectedText === "string") {
        throw new LiveConfirmationRequiredError(Array.isArray(p.reasons) ? p.reasons : [], p.expectedText);
      }
    }
    throw error;
  }
}

export function rejectProposal(id: string): Promise<{ status: string }> {
  return request<{ status: string }>(`/api/proposals/${encodeURIComponent(id)}/reject`, { method: "POST" });
}

// ── Accounts / profiles / settings ───────────────────────────────────────────

export function activateAccount(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/connected-accounts/${encodeURIComponent(id)}/activate`, { method: "POST" });
}

export interface AccountPerformanceResult {
  account: { id: string; label: string; broker: string; environment: "paper" | "live" };
  performance: PerformanceSummary | null;
  /** True when `performance`'s unrealized-P&L fields were computed with no live quotes
   *  (this endpoint never fetches them) -- render unrealized as unavailable ("-"), not
   *  as the real $0.00 it would be for an account with genuinely no open positions. */
  pricesUnavailable: boolean;
}

/** Results-page comparison picker: performance for ONE OTHER connected account, by id.
 *  The server resolves accountNumber itself (scoped to the requesting user) — this never
 *  sends an accountNumber from the client. */
export function fetchAccountPerformance(id: string): Promise<AccountPerformanceResult> {
  return request<AccountPerformanceResult>(`/api/connected-accounts/${encodeURIComponent(id)}/performance`);
}

/** Results-page signal-health section: per-horizon snapshot history (newest first) from the daily
 *  signal-health-refresh lane. Read-only; empty series render an honest empty state. */
export interface SignalHealthResponse {
  minObservations: number;
  topK: number;
  /** Round-trip transaction-cost estimate (bps) debited for the "net" figure in the Gross vs net
   *  stat — server-provided so the UI copy never drifts from signal-health.ts's actual constant. */
  costRoundTripBps: number;
  horizons: Array<{ horizon: string; snapshots: SignalHealthSnapshotRow[] }>;
}

export function fetchSignalHealth(): Promise<SignalHealthResponse> {
  return request<SignalHealthResponse>("/api/signal-health");
}

/** Results-page lookahead-audit panel: truncated-replay findings (newest pass first) plus the
 *  aggregate verdict from the weekly lookahead-audit lane. Read-only; 'unverifiable' rows are
 *  deliberate coverage-gap receipts, rendered plainly rather than hidden. */
export interface LookaheadAuditResponse {
  enabled: boolean;
  /** Factor sub-score mismatch tolerance (0-100 points) the classifications used. */
  tolerancePoints: number;
  /** Minimum Jaccard similarity for a clean RAG evidence replay. */
  jaccardMin: number;
  cadenceDays: number;
  verdict: LookaheadVerdict;
  findings: LookaheadAuditFindingRow[];
}

export function fetchLookaheadAudit(): Promise<LookaheadAuditResponse> {
  return request<LookaheadAuditResponse>("/api/lookahead-audit");
}

/** "Import settings from another account" (Strategy page): copies strategy settings — models,
 *  prompt, guardrails, weights, watchlist, tax treatment — from `sourceConnectedAccountId` onto
 *  `targetConnectedAccountId`. Any->any (not paper-only); never touches broker connection,
 *  credentials, or run state. Both accounts are resolved/ownership-checked server-side. */
export function importAccountSettings(
  targetConnectedAccountId: string,
  sourceConnectedAccountId: string
): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/connected-accounts/${encodeURIComponent(targetConnectedAccountId)}/import-settings`, {
    method: "POST",
    body: JSON.stringify({ sourceConnectedAccountId })
  });
}

export function createProfile(input: {
  name: string;
  prompt?: string;
  policy?: Partial<TradingPolicy>;
  active?: boolean;
}): Promise<StrategyProfile> {
  return request<StrategyProfile>("/api/profiles", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateProfile(
  id: string,
  patch: { name?: string; prompt?: string; policy?: Partial<TradingPolicy>; scoringWeights?: Partial<ScoringWeights> }
): Promise<StrategyProfile> {
  return request<StrategyProfile>(`/api/profiles/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch)
  });
}

export function deleteProfile(id: string): Promise<void> {
  return request<void>(`/api/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Library-activate a preset (flips the library's active flag and writes the
 *  user-level base policy — including the preset's stored systemState). Only
 *  used as the fallback when NO connected account exists; prefer
 *  copyProfileToAccount, which preserves the account's run-state. */
export function activateProfile(id: string): Promise<unknown> {
  return request<unknown>(`/api/profiles/${encodeURIComponent(id)}/activate`, { method: "POST" });
}

/** Copy a saved preset onto a CHOSEN connected account's live strategy state
 *  (POST /api/profiles/[id]/copy → applyProfileToAccount). The target
 *  account's current run-state (systemState) is preserved server-side — a
 *  preset can never arm or disarm anything — and the library active flag is
 *  left untouched. */
export function copyProfileToAccount(
  profileId: string,
  connectedAccountId: string
): Promise<{ profileId: string; connectedAccountId: string }> {
  return request<{ profileId: string; connectedAccountId: string }>(
    `/api/profiles/${encodeURIComponent(profileId)}/copy`,
    { method: "POST", body: JSON.stringify({ connectedAccountId }) }
  );
}

export function setAutoResume(enabled: boolean): Promise<{ autoResumeOnBoot: boolean }> {
  return request<{ autoResumeOnBoot: boolean }>("/api/settings/auto-resume", {
    method: "POST",
    body: JSON.stringify({ enabled })
  });
}

export interface NotifyTestResult {
  results: Array<{ channel: string; ok: boolean; skipped?: string; error?: string }>;
}

export function sendTestNotification(): Promise<NotifyTestResult> {
  return request<NotifyTestResult>("/api/notifications/test", { method: "POST", body: JSON.stringify({}) });
}

// ── Alert lifecycle (acknowledge) ───────────────────────────────────────────

export interface AcknowledgeNotificationsResult {
  acknowledged: number;
}

/** Acknowledge specific Alert Center rows by id. */
export function acknowledgeNotifications(ids: string[]): Promise<AcknowledgeNotificationsResult> {
  return request<AcknowledgeNotificationsResult>("/api/notifications/ack", {
    method: "POST",
    body: JSON.stringify({ ids })
  });
}

/** Bulk-acknowledge every currently-unacknowledged row matching the Attention filter. Pass the
 *  active connected account id so the ack is scoped to what the Alert Center is actually showing
 *  (that account + account-less rows) — otherwise a hidden other-account alert the user never saw
 *  would get silently acknowledged too. */
export function acknowledgeAllAttention(connectedAccountId?: string): Promise<AcknowledgeNotificationsResult> {
  return request<AcknowledgeNotificationsResult>("/api/notifications/ack", {
    method: "POST",
    body: JSON.stringify({ all: true, filter: "attention", ...(connectedAccountId ? { connectedAccountId } : {}) })
  });
}

/** Per-condition Alert Center mutes (#2555): conditionKey → mutedUntil ISO. Rendering-only. */
export interface AlertMutesResult {
  mutes: Record<string, string>;
}

export function fetchAlertMutes(): Promise<AlertMutesResult> {
  return request<AlertMutesResult>("/api/notifications/mute");
}

export function setAlertConditionMute(key: string, mute: boolean): Promise<AlertMutesResult> {
  return request<AlertMutesResult>("/api/notifications/mute", {
    method: "POST",
    body: JSON.stringify({ key, mute })
  });
}
