"use client";

/** The console's single data layer: one polled GET /api/dashboard snapshot
 *  shared by every screen via context, refreshed on an interval, after every
 *  mutation, and when the tab becomes visible again. Errors never blank the
 *  screen — the last good snapshot stays up and a visible staleness notice is
 *  derived from `error` + `fetchedAt`. */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import type { DashboardSnapshot } from "../../dashboard-types";
import { ConsoleApiError, fetchDashboard } from "./api";
import { deriveConsoleLoadState } from "./console-load-state";
import { SENTENCE_GAP } from "./format";

// Shown the instant a 401 is detected, replacing whatever freshness copy would otherwise
// describe the last-good snapshot as merely "delayed" — see ShellFrame's sessionExpired branch
// in shell.tsx, which renders this instead of the normal dashboard chrome.
export const SESSION_EXPIRED_MESSAGE = `Your session has expired.${SENTENCE_GAP}Redirecting you to sign in…`;

const POLL_MS = 15_000;
const EVENT_REFRESH_DEBOUNCE_MS = 200;
// Reassurance timer, NOT a failure. When it fires the first snapshot still hasn't arrived, so the
// shell adds a "this is taking longer than usual" line UNDER the load animation — it does not set
// `error`, and it must never flip the shell to the error card.
//
// It used to do exactly that (set `error` at 15s), and that was a real bug the owner hit on every
// single production load: getDashboardSnapshot is self-bounded but its broker chain is SEQUENTIAL
// (~24s worst case — see FETCH_DEADLINE_MS below), so any first load in the 15-24s band showed
// "Couldn't load the autonomy desk" while the request was still in flight and about to succeed.
// The native iOS client, which polls the SAME getDashboardSnapshot via /api/mobile/snapshot but
// just waits out its 30s URLSession timeout, loaded fine at the same moment — that split is what
// the owner reported ("iOS said stale for a few minutes, then Updated; the website errors").
//
// The watchdog's original job — "don't sit on the logo forever if the fetch hangs" — is now owned
// by FETCH_DEADLINE_MS, which aborts and retries a genuinely hung attempt. So this timer no longer
// needs to (and must not) manufacture an error to stay safe.
const FIRST_LOAD_SLOW_NOTICE_MS = 15_000;
// Hard per-attempt ceiling, independent of anything the server does. fetchDashboard has no
// built-in timeout, so a request that hangs at the network layer (an open connection that never
// receives data — exactly the kernel TCP-memory-exhaustion failure mode that caused the prod
// incident this file's coalescing logic exists to fix) would otherwise sit in `inFlight` forever:
// every later SSE/poll/visibility trigger only sets `pendingBackgroundRefresh` and returns (by
// design, to avoid resurrecting the old abort-storm), so nothing would ever start a fresh attempt.
// This timer fires ONCE per attempt (not once per event), so it cannot reintroduce that storm — it
// only kills an attempt that has been stuck well past what any real (even fully degraded) response
// should take.
//
// This ceiling MUST sit above the server's own worst-case self-bounded response. getDashboardSnapshot
// races each upstream against its own deadline, but the broker chain is SEQUENTIAL — gateway.getAccounts
// (6s) → portfolio/positions/orders (8s) → getEquityQuotes (6s) = 20s — and computeSpyBenchmark (4s) runs
// after it, so a slow-but-not-hung account with held symbols can legitimately take ~24s to return a fully
// degraded snapshot. A client ceiling at/below that would abort right as the server is about to respond,
// retry, and keep the console stuck on the watchdog/retry path even though the server deadlines are
// working as designed. 35s leaves headroom over that 24s server bound (plus sync DB work) while still
// killing a genuine network hang, which never resolves at all.
const FETCH_DEADLINE_MS = 35_000;
// Sentinel abort reason so a deadline-triggered abort can be told apart from an explicit refresh()
// superseding this attempt (which aborts with no reason / the default AbortError).
const DEADLINE_REASON = Symbol("dashboard-fetch-deadline");
// Shown while a deadline-aborted attempt is retrying. Setting `error` here is what makes the
// freshness strip flip to "delayed" — without it, a request that keeps hanging past
// FETCH_DEADLINE_MS would retry every ~35s forever with `error` still null, so the console would
// keep labeling an old snapshot "fresh" even though no refresh has actually landed.
const DEADLINE_ERROR_MESSAGE = "The dashboard is taking too long to respond.  Retrying…";

export type ConsoleStreamStatus = "unsupported" | "connecting" | "live" | "reconnecting";

export interface ConsoleStreamHealth {
  status: ConsoleStreamStatus;
  connectedAt: Date | null;
  lastEventAt: Date | null;
  lastEventType: string | null;
  lastErrorAt: Date | null;
}

export interface ConsoleData {
  snapshot: DashboardSnapshot | null;
  /** When the current snapshot was fetched (client clock). */
  fetchedAt: Date | null;
  /** True only before the very first snapshot arrives. */
  loading: boolean;
  /** An attempt is in flight right now. Lets the shell tell "still working on it" apart from
   *  "gave up" while there is no snapshot to fall back on. */
  retrying: boolean;
  /** The first snapshot is late (past FIRST_LOAD_SLOW_NOTICE_MS) but still coming. Advisory only —
   *  the shell keeps the load screen up and adds a note; this is never a failure. */
  slowFirstLoad: boolean;
  /** Last fetch error (the previous snapshot stays rendered). */
  error: string | null;
  /** A fetch came back 401. The browser is being sent to /login (api.ts's redirectToLogin) —
   *  this flag exists so the shell can stop rendering the last-good snapshot as live for
   *  whatever brief window the navigation takes, instead of leaving it looking merely "delayed".
   *  Once true it never goes back to false: the page is leaving. */
  sessionExpired: boolean;
  /** Health of the SSE stream used for push refreshes. */
  stream: ConsoleStreamHealth;
  /** Force a refetch now (used after every mutation). */
  refresh: () => Promise<void>;
  /** Browser online state. False means show the last snapshot honestly. */
  online: boolean;
}

const ConsoleDataContext = createContext<ConsoleData | null>(null);

const UNSUPPORTED_STREAM: ConsoleStreamHealth = {
  status: "unsupported",
  connectedAt: null,
  lastEventAt: null,
  lastEventType: null,
  lastErrorAt: null
};

export function ConsoleDataProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  // Mirrors sessionExpired but readable synchronously inside callbacks (state updates are async),
  // so refresh()/backgroundRefresh() can refuse to start another fetch against a session that is
  // already known dead — once the redirect is underway there is nothing left to poll for.
  const sessionExpiredRef = useRef(false);
  const [slowFirstLoad, setSlowFirstLoad] = useState(false);
  // True while runLoop is actively attempting (including its own immediate deadline retries). Only
  // consumed for the no-snapshot case, where it separates "still fetching" from "stopped trying".
  const [fetching, setFetching] = useState(false);
  const [stream, setStream] = useState<ConsoleStreamHealth>(UNSUPPORTED_STREAM);
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const inFlight = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const queuedRefresh = useRef<number | null>(null);
  // Set when a background trigger (SSE event, poll interval, tab becoming visible) arrives while a
  // fetch is already in flight. Consumed once that fetch settles, to run exactly one more
  // (coalesced) fetch instead of a fresh abort-and-refetch per trigger — see backgroundRefresh below.
  const pendingBackgroundRefresh = useRef(false);

  // Returns "deadline" when THIS attempt was killed by our own FETCH_DEADLINE_MS timer (distinct
  // from "aborted", which means something else — an explicit refresh() — superseded it). Callers
  // use that distinction to decide whether to retry immediately.
  const runFetch = useCallback(async (controller: AbortController): Promise<"ok" | "deadline" | "aborted" | "error"> => {
    const deadline = window.setTimeout(() => controller.abort(DEADLINE_REASON), FETCH_DEADLINE_MS);
    try {
      const data = await fetchDashboard<DashboardSnapshot>(controller.signal);
      if (!mounted.current || controller.signal.aborted) return "aborted";
      setSnapshot(data);
      setFetchedAt(new Date());
      setError(null);
      setSlowFirstLoad(false);
      return "ok";
    } catch (err) {
      if (controller.signal.aborted) {
        if (controller.signal.reason !== DEADLINE_REASON) return "aborted";
        // Surface the hung attempt as a refresh error before runLoop retries, so the freshness UI
        // stops calling a stale snapshot "fresh". A successful retry clears this via setError(null).
        if (mounted.current) setError((prev) => prev ?? DEADLINE_ERROR_MESSAGE);
        return "deadline";
      }
      if (err instanceof DOMException && err.name === "AbortError") return "aborted";
      if (!mounted.current) return "error";
      // A 401 is not "refresh failing — showing last good data": the session is gone, not
      // slow. fetchDashboard already kicked off the redirect to /login (api.ts); this only
      // needs to stop the loop from retrying against a dead session and tell the shell to stop
      // presenting the stale snapshot as live for whatever window the navigation takes.
      if (err instanceof ConsoleApiError && err.status === 401) {
        sessionExpiredRef.current = true;
        setSessionExpired(true);
        setError(SESSION_EXPIRED_MESSAGE);
        return "error";
      }
      setError(err instanceof ConsoleApiError ? err.message : "Could not refresh data.");
      return "error";
    } finally {
      window.clearTimeout(deadline);
    }
  }, []);

  // Shared retry loop used by BOTH refresh() and backgroundRefresh() (the caller is responsible for
  // aborting whatever was previously in flight, and for the "already in flight → just mark pending"
  // short-circuit — see below). Each iteration runs one attempt with a fresh AbortController and
  // then decides whether to run another:
  //  - "deadline": THIS attempt hung past FETCH_DEADLINE_MS and was self-aborted — retry immediately
  //    with a fresh connection. This fires once per attempt (never once per SSE event), so it cannot
  //    resurrect the abort-storm that queueRefresh/pendingBackgroundRefresh exist to prevent.
  //  - otherwise: retry only if a background trigger (SSE/poll/visibility) arrived and coalesced
  //    while this attempt was running (pendingBackgroundRefresh) — this also means a trigger that
  //    lands mid-refresh() is drained before refresh()'s own promise resolves, instead of waiting
  //    for the next independent trigger.
  const runLoop = useCallback(async (foreground = false) => {
    if (mounted.current) setFetching(true);
    // Every exit path below must clear `fetching`, EXCEPT the "superseded" one — there the newer
    // loop that replaced us is still running and owns the flag, so clearing it here would falsely
    // report "stopped trying" and drop the shell onto the error card mid-fetch.
    const stop = () => { if (mounted.current) setFetching(false); };
    // Tracks consecutive deadline timeouts for exponential backoff — reset to 0 on any non-deadline
    // result so the backoff only applies to repeated hung attempts.
    let consecutiveDeadlines = 0;
    for (;;) {
      if (!mounted.current) return;
      // If a 401 was detected mid-iteration (sessionExpiredRef set to true by runFetch), halt
      // immediately — there is nothing left to poll for against a dead session.
      if (sessionExpiredRef.current) { stop(); return; }
      const controller = new AbortController();
      inFlight.current = controller;
      const result = await runFetch(controller);
      if (inFlight.current !== controller) return; // superseded by a newer refresh()/backgroundRefresh()
      inFlight.current = null;
      if (result === "deadline") {
        consecutiveDeadlines += 1;
        // An AWAITED foreground refresh() must not stay pending across retries: several mutation
        // flows `await refresh()` before clearing their busy state, and a persistently hung
        // /api/dashboard would otherwise wedge those toasts/`finally` blocks forever. The deadline
        // error is already surfaced by runFetch, so hand the immediate retry to a detached
        // background loop and let this foreground promise resolve. (A background trigger arriving
        // meanwhile still coalesces via pendingBackgroundRefresh — the detached loop drains it.)
        if (foreground) {
          // The detached loop takes over and sets `fetching` itself, so do NOT stop here.
          void runLoop(false);
          return;
        }
        // Exponential backoff: 1s * 2^(consecutiveDeadlines-1) capped at 30s, plus ±20% jitter.
        // This prevents a tight spin-loop hammering a degraded backend every 35s.  After 5+
        // consecutive deadlines the delay is ~16-30s between retries rather than near-zero.
        const backoffMs = Math.min(1_000 * Math.pow(2, consecutiveDeadlines - 1), 30_000);
        const jitter = backoffMs * (0.8 + Math.random() * 0.4);
        await new Promise<void>((res) => window.setTimeout(res, jitter));
        continue;
      }
      consecutiveDeadlines = 0;
      if (!pendingBackgroundRefresh.current) { stop(); return; }
      pendingBackgroundRefresh.current = false;
    }
  }, [runFetch, sessionExpiredRef]);

  // Explicit foreground refresh: the initial load and every user action/mutation (approve/reject,
  // place/cancel an order, save a setting, etc. — everything callers pull `refresh` from
  // useConsoleData() for). The caller wants strictly fresh data right now, so this aborts and
  // replaces whatever is in flight (background or foreground).
  const refresh = useCallback(async () => {
    if (sessionExpiredRef.current) return;
    pendingBackgroundRefresh.current = false;
    inFlight.current?.abort();
    await runLoop(true);
  }, [runLoop]);

  // Background refresh: SSE events, the poll interval, and tab-visibility resync. Must NEVER abort
  // an in-flight fetch — that abort-storm was the root cause of the console taking minutes to
  // first-paint: during an active scan, SSE market-data/run-complete events (and the poll interval)
  // fire every few seconds, so the slow initial fetch kept getting killed and restarted before it
  // could ever finish, until a quiet gap happened to appear. If a fetch is already in flight, just
  // mark that a refresh was requested and let it finish (or hit its own deadline) — runLoop above
  // drains that flag on its own once the in-flight attempt settles, coalescing any number of
  // triggers that arrived in the meantime into a single extra fetch.
  const backgroundRefresh = useCallback(async () => {
    if (sessionExpiredRef.current) return;
    if (inFlight.current) {
      pendingBackgroundRefresh.current = true;
      return;
    }
    await runLoop();
  }, [runLoop]);

  const queueRefresh = useCallback(() => {
    if (typeof window === "undefined") return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (queuedRefresh.current) window.clearTimeout(queuedRefresh.current);
    queuedRefresh.current = window.setTimeout(() => {
      queuedRefresh.current = null;
      void backgroundRefresh();
    }, EVENT_REFRESH_DEBOUNCE_MS);
  }, [backgroundRefresh]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void backgroundRefresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void backgroundRefresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      if (queuedRefresh.current) clearTimeout(queuedRefresh.current);
      inFlight.current?.abort();
    };
  }, [refresh, backgroundRefresh]);

  // First-load slow notice: while no snapshot has arrived, arm a timer; if it fires the load is
  // running long, so let the shell say so UNDER the animation. This deliberately does not touch
  // `error` — see FIRST_LOAD_SLOW_NOTICE_MS above for why setting it here was the false-failure bug.
  // Cleared on the first successful fetch (runFetch), not here, so the note doesn't blink off and
  // on across the deadline retries of one long load.
  useEffect(() => {
    if (snapshot !== null) return;
    const timer = window.setTimeout(() => setSlowFirstLoad(true), FIRST_LOAD_SLOW_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [snapshot]);

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      setStream(UNSUPPORTED_STREAM);
      return;
    }
    setStream((prev) => ({ ...prev, status: "connecting" }));
    const events = new EventSource("/api/events/stream");

    const markConnected = () => {
      if (!mounted.current) return;
      const now = new Date();
      setStream((prev) => ({
        ...prev,
        status: "live",
        connectedAt: now,
        lastErrorAt: null
      }));
    };

    const markEvent = (type: string) => {
      if (!mounted.current) return;
      const now = new Date();
      setStream((prev) => ({
        ...prev,
        status: "live",
        connectedAt: prev.connectedAt ?? now,
        lastEventAt: now,
        lastEventType: type,
        lastErrorAt: null
      }));
      queueRefresh();
    };

    const refreshTypes = ["ready", "run-complete", "order", "proposal", "dirty", "market-data", "pending-learned-change"] as const;
    const handlers = refreshTypes.map((type) => {
      const handler = () => markEvent(type);
      events.addEventListener(type, handler);
      return { type, handler };
    });

    events.onopen = markConnected;
    events.onerror = () => {
      if (!mounted.current) return;
      setStream((prev) => ({
        ...prev,
        status: prev.status === "unsupported" ? "unsupported" : "reconnecting",
        lastErrorAt: new Date()
      }));
    };

    return () => {
      for (const { type, handler } of handlers) events.removeEventListener(type, handler);
      events.close();
    };
  }, [queueRefresh]);

  const value = useMemo<ConsoleData>(() => {
    // The loading/slow/failed decision lives in a pure module so it is actually covered by tests
    // — see console-load-state.ts for why that mattered here.
    const state = deriveConsoleLoadState({
      hasSnapshot: snapshot !== null,
      error,
      fetching,
      slowElapsed: slowFirstLoad
    });
    return {
      snapshot,
      fetchedAt,
      loading: state === "loading" || state === "slow",
      retrying: fetching,
      slowFirstLoad: state === "slow",
      error,
      sessionExpired,
      stream,
      refresh,
      online
    };
  }, [snapshot, fetchedAt, error, sessionExpired, fetching, slowFirstLoad, stream, refresh, online]);

  return <ConsoleDataContext.Provider value={value}>{children}</ConsoleDataContext.Provider>;
}

export function useConsoleData(): ConsoleData {
  const ctx = useContext(ConsoleDataContext);
  if (!ctx) throw new Error("useConsoleData must be used inside ConsoleDataProvider");
  return ctx;
}

/** Non-throwing variant for surfaces mounted outside the console shell (e.g. /admin, which
 *  deliberately skips the dashboard snapshot fetch — see app/admin/layout.tsx). Callers must
 *  treat `null` as "this context has no account data available", not as "no data yet" (that
 *  distinction matters: a section that reads `snapshot` through this hook has to say so
 *  honestly rather than rendering the ordinary "nothing here" empty state a real snapshot's
 *  absence of rows would produce). */
export function useConsoleDataOptional(): ConsoleData | null {
  return useContext(ConsoleDataContext);
}
