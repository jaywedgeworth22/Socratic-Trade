/**
 * First-call retry for an in-process Alpaca REST read, without treating a real
 * rejection as success.
 *
 * ASC + ops (2026-08-18, process 581467e1 / later d4299bec): there is no Alpaca
 * sidecar.  Paper / Roth are REST `alpaca`.  alpaca-broker was 500/500 ok this
 * process, but 191/500 calls were ≥6s (min 97ms / avg ~3085ms / max 14416ms).
 * Latest ~4:40pm CT 98–413ms ok; ~30s earlier several ok at 6570–6600ms — the
 * SDK finished AFTER the 6s `withDeadline` abort.  Same window also aborted
 * portfolio/positions/orders at 8s and getEquityQuotes at 6s.  `ftsMirrorSlice`
 * held the same event loop 6–12s.  First wait is above the live 14.4s max.
 * A 401 / credential throw still fails immediately (no retry).
 */

export const GET_ACCOUNTS_FIRST_MS = 16_000;
export const GET_ACCOUNTS_RETRY_MS = 8_000;
export const PORTFOLIO_BUNDLE_FIRST_MS = 16_000;
export const PORTFOLIO_BUNDLE_RETRY_MS = 8_000;
export const ALPACA_ACCOUNT_READ_FIRST_MS = 16_000;
export const ALPACA_ACCOUNT_READ_RETRY_MS = 8_000;
export const ALPACA_MCP_FETCH_MS = 8_000;

/** Live first-wait / retry for Alpaca REST `getAccount`.  Read at call time so tests can
 *  mock a short budget without changing the 16s production wait. */
export function alpacaAccountReadBudgetMs(): { firstMs: number; retryMs: number } {
  return { firstMs: ALPACA_ACCOUNT_READ_FIRST_MS, retryMs: ALPACA_ACCOUNT_READ_RETRY_MS };
}
/** Same in-process broker lane as getAccounts.  Live 6s / 8s withDeadline races. */
export const EQUITY_QUOTES_MS = 16_000;
export const OPTION_POSITIONS_MS = 16_000;
/** Inner trackHealth deadline for Alpaca writes and unbounded reads (quotes/place/cancel).
 *  Must exceed read-path first+retry budgets (16s+8s=24s) so awaitWithFirstCallRetry wins the race. */
export const ALPACA_BROKER_IO_DEADLINE_MS = 30_000;
/** Tradier REST fetch ceiling — same lane as Alpaca broker I/O. */
export const TRADIER_BROKER_IO_DEADLINE_MS = 30_000;
/** Default terminal-order lookback for scoped getEquityOrders (open + recent closed). */
export const EQUITY_ORDERS_TERMINAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export function equityOrdersDefaultSinceIso(nowMs = Date.now()): string {
  return new Date(nowMs - EQUITY_ORDERS_TERMINAL_LOOKBACK_MS).toISOString();
}

/**
 * Structural marker for "this wait ran out of time" (2026-09-24, board 687a5fb4).
 *
 * Set on the error `withDeadline` manufactures on expiry and on whatever `onFinalTimeout` throws
 * from `awaitWithFirstCallRetry` (`Timed out waiting for alpaca.getAccount after 16000+8000ms.`).
 * Consumers classify on this flag instead of regexing prose: the broker-health auto-pause needs to
 * know a probe TIMED OUT (streak-eligible — usually a pinned event loop, not a broker outage)
 * without widening `isTransientNetworkError` to match the words "timed out" globally.
 * Duck-typed rather than a subclass because errors cross Next.js HMR module-instance boundaries.
 */
export type DeadlineTimeoutError = Error & { __deadlineTimeout: true };

export function markDeadlineTimeout<E>(error: E): E {
  if (error && typeof error === "object") {
    try {
      (error as { __deadlineTimeout?: boolean }).__deadlineTimeout = true;
    } catch {
      /* frozen / exotic error object — classification falls back to the caller's other checks */
    }
  }
  return error;
}

export function isDeadlineTimeoutError(error: unknown): error is DeadlineTimeoutError {
  return Boolean(error) && typeof error === "object" && (error as { __deadlineTimeout?: unknown }).__deadlineTimeout === true;
}

/** Race a broker promise against a hard timeout.  Lives here (not safety-maintenance) so
 *  alpaca/tradier can import it without a circular broker-gateway load.
 *
 *  Pass `controller` to CANCEL the work on the timeout branch.  Without it this is a pure
 *  `Promise.race`: the caller walks away but the underlying call keeps running and its
 *  socket stays open for the life of the process.  The controller is aborted ONLY when the
 *  deadline wins — a promise that settles in time is never aborted.
 *
 *  MONEY PATH: only pass a controller for idempotent reads.  An aborted order PLACEMENT may
 *  still have reached the broker, and cancelling it destroys the refId reconcile that
 *  `reconcilePlacementError` depends on to tell "never placed" from "placed and live". */
export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  options?: { controller?: AbortController }
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = markDeadlineTimeout(new Error(message));
      options?.controller?.abort(error);
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export type SettleKind = "fulfilled" | "rejected" | "pending";

export type SettleOutcome<T> =
  | { kind: "fulfilled"; value: T }
  | { kind: "rejected"; reason: unknown }
  | { kind: "pending" };

export function getAccountsTimeoutMessage(firstMs = GET_ACCOUNTS_FIRST_MS, retryMs = GET_ACCOUNTS_RETRY_MS): string {
  return `Timed out waiting for gateway.getAccounts after ${firstMs}+${retryMs}ms.`;
}

export function portfolioBundleTimeoutMessage(
  firstMs = PORTFOLIO_BUNDLE_FIRST_MS,
  retryMs = PORTFOLIO_BUNDLE_RETRY_MS
): string {
  return `Timed out waiting for portfolio, positions, and orders after ${firstMs}+${retryMs}ms.`;
}

export async function outcomeOrTimeout<T>(promise: Promise<T>, ms: number): Promise<SettleOutcome<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: "pending" });
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "fulfilled", value });
      },
      (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "rejected", reason });
      }
    );
  });
}

/** First fulfillment wins.  Rejection wins only after every sibling has rejected. */
export async function firstOutcomeOf<T>(promises: readonly Promise<T>[], ms: number): Promise<SettleOutcome<T>> {
  return new Promise((resolve) => {
    let done = false;
    let pendingRejects = promises.length;
    let lastReason: unknown;
    const finish = (outcome: SettleOutcome<T>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: "pending" }), ms);
    for (const promise of promises) {
      promise.then(
        (value) => finish({ kind: "fulfilled", value }),
        (reason) => {
          lastReason = reason;
          pendingRejects -= 1;
          if (pendingRejects === 0) finish({ kind: "rejected", reason: lastReason });
        }
      );
    }
  });
}

function assertNever(value: never): never {
  throw new Error(`unhandled settle kind: ${String(value)}`);
}

/** Handed to each `start()` attempt so the attempt can cancel its own transport work once
 *  this wrapper has stopped waiting on it. */
export type BrokerCallAttempt = { signal: AbortSignal };

/** Attach settle-tracking without changing the promise.  The handlers also mark the promise
 *  as handled, so aborting a loser can never surface as an unhandled rejection. */
function trackSettled<T>(promise: Promise<T>): () => boolean {
  let settled = false;
  const mark = () => {
    settled = true;
  };
  promise.then(mark, mark);
  return () => settled;
}

export async function awaitWithFirstCallRetry<T>(
  start: (attempt: BrokerCallAttempt) => Promise<T>,
  options: {
    firstMs: number;
    retryMs: number;
    onFinalTimeout: () => T;
    label?: string;
    timedOutSections?: string[];
  }
): Promise<T> {
  // One controller per start() attempt so the LOSER of the race can be cancelled.  Before this,
  // a pending first call was never aborted when the retry was issued at firstMs, so every slow
  // poll doubled the outstanding broker calls and left BOTH running for the life of the process.
  // The first attempt is deliberately NOT aborted when the retry starts — either may still win.
  const firstController = new AbortController();
  const first = start({ signal: firstController.signal });
  const firstIsSettled = trackSettled(first);
  const firstOutcome = await outcomeOrTimeout(first, options.firstMs);
  switch (firstOutcome.kind) {
    case "fulfilled":
      return firstOutcome.value;
    case "rejected":
      throw firstOutcome.reason;
    case "pending":
      break;
    default:
      return assertNever(firstOutcome);
  }

  const retryController = new AbortController();
  const retry = start({ signal: retryController.signal });
  const retryIsSettled = trackSettled(retry);
  const raced = await firstOutcomeOf([first, retry], options.retryMs);
  const abortLosers = (reason: Error) => {
    if (!firstIsSettled()) firstController.abort(reason);
    if (!retryIsSettled()) retryController.abort(reason);
  };
  switch (raced.kind) {
    case "fulfilled":
      abortLosers(new Error(`${options.label ?? "broker call"} superseded by the winning attempt`));
      return raced.value;
    case "rejected":
      abortLosers(new Error(`${options.label ?? "broker call"} superseded by a rejected sibling`));
      throw raced.reason;
    case "pending":
      // Nobody won.  Both attempts are abandoned, so both get cancelled rather than left
      // running behind a caller that has already moved on.
      abortLosers(new Error(`${options.label ?? "broker call"} timed out after ${options.firstMs}+${options.retryMs}ms`));
      if (options.label) {
        console.warn(
          `[dashboard] ${options.label} timed out after ${options.firstMs}+${options.retryMs}ms — serving degraded snapshot section`
        );
        options.timedOutSections?.push(options.label);
      }
      try {
        return options.onFinalTimeout();
      } catch (error) {
        // A throwing onFinalTimeout IS this helper's timeout, whatever its prose says.
        throw markDeadlineTimeout(error);
      }
    default:
      return assertNever(raced);
  }
}
