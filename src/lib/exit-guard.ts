/**
 * Production process-exit receipts + the "no spontaneous exit 0" tripwire.
 *
 * Production invariant (docs/rollouts/2026-08-02-exit0-outage-audit.md): NO
 * production code path may exit 0 spontaneously. The server is meant to run
 * forever; a clean exit reads as a graceful/manual stop to the container
 * runtime and to anyone doing forensics, and under an on-failure-style restart
 * policy it becomes a silent full outage. Deliberate exits (the R2 kill-switch
 * 41 / resume 42 in r2-usage.ts) are non-zero by contract.
 *
 * This guard:
 *  - logs EVERY process.exit() call with its code and call-site stack, so the
 *    next incident has receipts in `docker logs` instead of guesswork;
 *  - logs SIGTERM/SIGINT receipt (prepended, so it runs before Next's own
 *    cleanup handler exits 143/130);
 *  - re-tags a spontaneous (signal-less) process.exit(0) to exit 43;
 *  - if the guard's listener turns out to be the ONLY handler for a stop
 *    signal, it performs the default action itself (exit 128+N) so installing
 *    the guard can never make the process unkillable;
 *  - warns when the process is about to exit 0 via event-loop drain (the boot
 *    supervisor in scripts/coolify-prod-start.sh re-tags that case to 40).
 *
 * Active only in production (or when EXIT_GUARD=on / force is set), so dev
 * tooling and the test runner keep their normal exit semantics.
 */

export const EXIT_CODE_SPONTANEOUS_CLEAN_RETAG = 43;

const STOP_SIGNALS = ["SIGTERM", "SIGINT"] as const;
type StopSignal = (typeof STOP_SIGNALS)[number];
const STOP_SIGNAL_EXIT_CODES: Record<StopSignal, number> = { SIGTERM: 143, SIGINT: 130 };

type GuardableProcess = NodeJS.Process & { __exitGuardInstalled?: boolean };

export interface ExitGuardOptions {
  /** Install regardless of NODE_ENV (tests). */
  force?: boolean;
  /** Log sink; defaults to console.error so receipts land in container logs. */
  log?: (line: string) => void;
  /**
   * Called synchronously with the final exit code, the stop signal seen (if any), and the
   * process.exit call-site stack, right before the real exit.  The console receipt above dies with
   * the container (Coolify replaces it on every restart); src/lib/boot-ledger.ts passes a receiver
   * here so the same facts also land on the persistent data volume.  Must not throw; errors are
   * swallowed so a broken receiver can never block an exit.
   */
  receipt?: (detail: { code: number; signal?: string; callSite?: string }) => void;
}

function callSite(): string {
  const stack = new Error("process.exit call site").stack ?? "";
  return stack.split("\n").slice(2, 7).join("\n");
}

/**
 * Idempotent (per-process). Returns true when the guard was installed by this
 * call, false when inactive for this environment or already installed.
 */
export function installProcessExitGuard(
  proc: NodeJS.Process = process,
  options: ExitGuardOptions = {},
): boolean {
  const log = options.log ?? ((line: string) => console.error(line));
  const emitReceipt = (detail: { code: number; signal?: string; callSite?: string }) => {
    try {
      options.receipt?.(detail);
    } catch {
      // a receipt receiver must never block or alter an exit
    }
  };
  const active =
    options.force === true ||
    proc.env.EXIT_GUARD === "on" ||
    (proc.env.NODE_ENV === "production" && proc.env.EXIT_GUARD !== "off");
  if (!active) return false;
  const host = proc as GuardableProcess;
  if (host.__exitGuardInstalled) return false;
  host.__exitGuardInstalled = true;

  const realExit = proc.exit.bind(proc);
  let stopSignalSeen: StopSignal | null = null;

  for (const sig of STOP_SIGNALS) {
    proc.prependListener(sig, () => {
      stopSignalSeen = sig;
      log(`[exit-guard] received ${sig}`);
      // Registering this listener replaced the default die-on-signal action.
      // If nothing else handles the signal, perform the default ourselves so
      // the guard can never make the process unkillable.
      if (proc.listenerCount(sig) <= 1) {
        const code = STOP_SIGNAL_EXIT_CODES[sig];
        log(`[exit-guard] no other ${sig} handler is registered; exiting ${code}`);
        emitReceipt({ code, signal: sig });
        realExit(code);
      }
    });
  }

  const guardedExit = ((code?: number | string | null): never => {
    const numeric =
      typeof code === "number" ? code : code == null ? Number(proc.exitCode ?? 0) : Number(code);
    if (numeric === 0 && !stopSignalSeen) {
      log(
        `[exit-guard] FATAL: spontaneous process.exit(0) -- no production code path may exit 0 ` +
          `(it reads as a clean/manual stop and can strand the container). ` +
          `Re-tagging to exit ${EXIT_CODE_SPONTANEOUS_CLEAN_RETAG}.\n${callSite()}`,
      );
      emitReceipt({ code: EXIT_CODE_SPONTANEOUS_CLEAN_RETAG, callSite: callSite() });
      return realExit(EXIT_CODE_SPONTANEOUS_CLEAN_RETAG);
    }
    log(
      `[exit-guard] process.exit(${numeric})${stopSignalSeen ? ` after ${stopSignalSeen}` : ""}\n${callSite()}`,
    );
    emitReceipt({
      code: numeric,
      ...(stopSignalSeen ? { signal: stopSignalSeen } : {}),
      callSite: callSite(),
    });
    return realExit(code as number);
  }) as typeof proc.exit;
  proc.exit = guardedExit;

  proc.on("exit", (finalCode) => {
    if (finalCode === 0 && !stopSignalSeen) {
      log(
        "[exit-guard] WARNING: process exiting 0 without a stop signal (event-loop drain?) -- " +
          "this violates the production no-exit-0 invariant; the boot supervisor re-tags it to 40.",
      );
    }
  });

  return true;
}
