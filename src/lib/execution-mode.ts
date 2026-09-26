import type { ConnectedAccount, ExecutionMode, FillSource, TradingPolicy } from "./types";

export type LlmExecutionMode = ExecutionMode;

// taxationType is included so the strategy prompt builder can classify an IRA buyer with the same
// source-of-truth precedence as the wash-sale gate (isIraTaxRegime). The runtime value passed here
// is the full ConnectedAccount row, so this only widens the compile-time view — no call site change.
export type ExecutionAccount = Pick<ConnectedAccount, "id" | "broker" | "environment" | "accountNumber" | "label" | "capabilities" | "taxationType">;

export interface ExecutionState {
  /**
   * Undefined only when there is no connected account. An account is an account: a broker paper
   * account (e.g. Alpaca paper) is `"broker/paper"`, a live account is `"broker/live"` — purely a
   * function of `activeAccount.environment`. There is no local-simulation fallback: with no
   * connected account the app cannot place orders, and callers that execute orders MUST check
   * `mode` and refuse to run rather than synthesize a fake fill.
   */
  mode?: ExecutionMode;
  label: "Paper" | "Brokerage" | "No account";
  broker?: ExecutionAccount["broker"];
  environment?: ExecutionAccount["environment"];
  accountId?: string;
  accountNumber?: string;
  accountLabel?: string;
  /** True once a real (paper or live) broker connection is in play — false only for "No account". */
  submitsBrokerOrders: boolean;
  clarification: string;
  isHealthy: boolean;
  healthReason?: string;
}

export interface HealthSignals {
  isHealthy: boolean;
  reason?: string;
  /**
   * Why the account is unhealthy when `isHealthy` is false. Used by the auto-pause path to
   * label audit/notifications (order_capability = OMS/placement path; equity = unfunded, etc.).
   */
  category?: "connectivity" | "account" | "equity" | "error_rate" | "order_capability";
  /**
   * Structural: the probe got NO answer inside its wait budget (a deadline or the broker read's
   * first+retry budget expired).  Streak-eligible like a dead socket — it takes
   * BROKER_CONNECTIVITY_HALT_STREAK consecutive failures to auto-halt, never one (board 687a5fb4).
   */
  probeTimedOut?: boolean;
  /**
   * The probe timed out while THIS process's event loop was blocked for most of the probe window
   * (lag sampler, event-loop-lag.ts).  The broker is not at fault: skip the tick's strategy launch,
   * never count it toward the halt streak.
   */
  processStall?: { stalledMs: number; elapsedMs: number };
}

type ExecutionPolicy = Pick<TradingPolicy, "accountNumber" | "connectedAccountId" | "activeBroker">;

/**
 * An account is an account: this derives execution state purely from the connected account's
 * `environment` (paper vs live). With no connected account, it returns a "No account" state
 * (`mode: undefined`, `submitsBrokerOrders: false`) — callers that place orders must check `mode`
 * and refuse to run rather than fall back to any local/simulated fill.
 */
export function deriveExecutionState(policy: ExecutionPolicy, activeAccount?: ExecutionAccount, health?: HealthSignals): ExecutionState {
  if (!activeAccount) {
    return {
      mode: undefined,
      label: "No account",
      accountId: policy.connectedAccountId,
      accountNumber: policy.accountNumber,
      submitsBrokerOrders: false,
      clarification:
        "No connected broker account. Connect a broker account (paper or live) before the app can place orders.",
      isHealthy: false,
      healthReason: "No account connected"
    };
  }

  if (activeAccount.environment === "paper") {
    const isTestAccount = activeAccount.broker === "test";
    return {
      mode: "broker/paper",
      label: "Paper",
      broker: activeAccount.broker,
      environment: activeAccount.environment,
      accountId: activeAccount.id,
      accountNumber: activeAccount.accountNumber ?? policy.accountNumber,
      accountLabel: activeAccount.label,
      submitsBrokerOrders: true,
      clarification:
        isTestAccount
          ? "The internal test broker uses deterministic fills and is not a product account."
          : `${brokerLabel(activeAccount.broker)} Paper is a broker-hosted sandbox account; real capital is not at risk.`,
      isHealthy: health?.isHealthy ?? true,
      healthReason: health?.reason
    };
  }

  return {
    mode: "broker/live",
    label: "Brokerage",
    broker: activeAccount.broker,
    environment: activeAccount.environment,
    accountId: activeAccount.id,
    accountNumber: activeAccount.accountNumber ?? policy.accountNumber,
    accountLabel: activeAccount.label,
    submitsBrokerOrders: true,
    clarification:
      `${brokerLabel(activeAccount.broker)} Brokerage is a broker production account. Broker orders can reach real capital only when policy, approval, and risk gates allow them.`,
    isHealthy: health?.isHealthy ?? true,
    healthReason: health?.reason
  };
}

export function llmExecutionMode(state: ExecutionState): LlmExecutionMode | undefined {
  return state.mode;
}

export function llmModeClarification(state: ExecutionState): string {
  return state.clarification;
}

export function llmFillSource(source: FillSource, executionState?: ExecutionState): LlmExecutionMode | undefined {
  if (executionState) return executionState.mode;
  return source === "paper" ? "broker/paper" : "broker/live";
}

export function fillSourceForExecutionMode(stateOrMode: ExecutionState | ExecutionMode | undefined): FillSource {
  const mode = typeof stateOrMode === "string" ? stateOrMode : stateOrMode?.mode;
  return mode === "broker/live" ? "live" : "paper";
}

function brokerLabel(broker: ExecutionAccount["broker"]): string {
  if (broker === "alpaca" || broker === "alpaca-mcp") return "Alpaca";
  if (broker === "test") return "Test";
  if (broker === "tradier") return "Tradier";
  if (broker === "etoro") return "eToro";
  if (broker === "public") return "Public";
  if (broker === "webull") return "Webull";
  if (broker === "kalshi") return "Kalshi";
  return "Robinhood";
}
