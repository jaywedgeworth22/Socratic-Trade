/** On-demand `/api/quote` cascade timers.  Kept out of the route file so Next does not
 * treat helper exports as route handlers (tsc `.next/types` `{ [x: string]: never }`). */

export const CASCADE_BUDGET_MS = 6_000;
/** After the Yahoo chart floor is in, wait this long for quoteSummary PE/EPS.  Do not wait the 6s cascade. */
export const YAHOO_SUMMARY_GRACE_MS = 1_500;
/** After the Yahoo chart floor is in, wait this long for the live quote cascade to
 *  produce an overlay before returning the floor.  The response never waits for the
 *  full cascade — the live overlay is opportunistic (Codex P1 review). */
export const LIVE_CASCADE_OVERLAY_GRACE_MS = 1_500;

/** AbortController + timer for the on-demand enrichment cascade budget. */
export function startCascadeBudget(budgetMs: number = CASCADE_BUDGET_MS): {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
  clear: () => void;
} {
  const controller = new AbortController();
  const abort = (reason?: unknown) => {
    if (controller.signal.aborted) return;
    const err =
      reason instanceof Error
        ? reason
        : Object.assign(new Error(String(reason ?? "cascade aborted")), { name: "AbortError" });
    controller.abort(err);
  };
  const timer = setTimeout(() => abort(new Error("cascade budget elapsed")), budgetMs);
  return {
    signal: controller.signal,
    abort,
    clear: () => clearTimeout(timer)
  };
}

/** Resolve when the promise settles, the budget elapses, or `signal` aborts — whichever first. */
export function withinBudget<T>(
  promise: Promise<T>,
  budgetMs: number,
  signal?: AbortSignal
): Promise<T | { status: "timed-out" }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: T | { status: "timed-out" }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ status: "timed-out" }), budgetMs);
    const onAbort = () => finish({ status: "timed-out" });
    if (signal) {
      if (signal.aborted) {
        finish({ status: "timed-out" });
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    void promise.then((outcome) => finish(outcome));
  });
}
