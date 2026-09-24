// Cash-flow-aware drawdown HWM: broker fetch + ops recompute orchestration.
// Pure adjustment math lives in risk-breaker.ts so unit tests do not need Alpaca.

import { audit, findConnectedAccountById, getInternalSetting } from "./db";
import {
  fetchAlpacaAccountActivities,
  fetchAlpacaAccountEquity
} from "./alpaca-account-insights";
import {
  BROKER_TRANSFER_ACTIVITY_TYPE_LIST,
  listAlpacaTransferFlows
} from "./broker-cash-flows";
import { withDeadline } from "./inflight-deadline";
import {
  impliedDrawdownPct,
  persistDrawdownHighWaterMark,
  readDrawdownHwmObservation,
  recomputeHighWaterMarkFromTransferFlows,
  type ExternalCashFlowForHwm
} from "./risk-breaker";
import type { FillSource } from "./types";

const HWM_KEY = (userId: string, accountNumber: string, source: FillSource) =>
  `risk:hwm:${userId}:${accountNumber}:${source}`;

export interface DrawdownCashFlowLoad {
  externalFlows: ExternalCashFlowForHwm[];
  appliedActivityIds: string[];
  advanceObservation: boolean;
}

function fillSourceForAccountEnvironment(environment: "paper" | "live" | string | undefined): FillSource {
  return environment === "live" ? "live" : "paper";
}

/**
 * Incremental flows for the live recorder. First observation after deploy marks current
 * ledger ids as applied without adjusting HWM (ops recompute heals a stuck historical mark).
 * A broker fetch failure returns advanceObservation: false so the cursor can retry.
 */
export async function loadCashFlowsForDrawdownBreaker(args: {
  userId: string;
  accountNumber: string;
  source: FillSource;
  connectedAccountId?: string;
}): Promise<DrawdownCashFlowLoad | undefined> {
  if (!args.connectedAccountId) return undefined;
  const account = findConnectedAccountById(args.connectedAccountId);
  if (!account || account.userId !== args.userId) return undefined;
  if (account.broker !== "alpaca" && account.broker !== "alpaca-mcp") return undefined;
  if (!account.apiKey) return undefined;

  try {
    const prevObs = readDrawdownHwmObservation(args.userId, args.accountNumber, args.source);
    const after = prevObs?.at?.slice(0, 10);
    const activities = await withDeadline(
      fetchAlpacaAccountActivities(args.userId, {
        connectedAccountId: args.connectedAccountId,
        activityTypes: [...BROKER_TRANSFER_ACTIVITY_TYPE_LIST],
        ...(after ? { after } : {})
      }),
      8_000,
      "drawdown HWM cash-flow fetch timeout"
    );
    const listed = listAlpacaTransferFlows(activities);
    if (!prevObs) {
      return {
        externalFlows: [],
        appliedActivityIds: listed.map((flow) => flow.id).filter(Boolean).slice(-500),
        advanceObservation: true
      };
    }
    const applied = new Set(prevObs.appliedActivityIds ?? []);
    const fresh = listed.filter((flow) => flow.id && !applied.has(flow.id));
    const appliedActivityIds = [...applied, ...fresh.map((flow) => flow.id)].slice(-500);
    return {
      externalFlows: fresh.map((flow) => ({ amount: flow.amount, day: flow.day })),
      appliedActivityIds,
      advanceObservation: true
    };
  } catch {
    return { externalFlows: [], appliedActivityIds: [], advanceObservation: false };
  }
}

export type HwmRecomputeResult =
  | {
      ok: true;
      connectedAccountId: string;
      accountNumber: string;
      source: FillSource;
      oldHwm: number | null;
      newHwm: number;
      equity: number;
      netTransfers: number;
      transferCount: number;
      impliedDrawdownPct: number;
    }
  | { ok: false; error: string; status: number };

export async function recomputeConnectedAccountHighWaterMark(
  connectedAccountId: string
): Promise<HwmRecomputeResult> {
  const account = findConnectedAccountById(connectedAccountId);
  if (!account) return { ok: false, error: "connectedAccountId not found", status: 404 };
  if (account.broker !== "alpaca" && account.broker !== "alpaca-mcp") {
    return { ok: false, error: "connected account is not Alpaca", status: 400 };
  }
  if (!account.apiKey) {
    return { ok: false, error: "connected account has no private Alpaca credentials", status: 400 };
  }
  const accountNumber = account.accountNumber?.trim();
  if (!accountNumber) {
    return { ok: false, error: "connected account has no accountNumber", status: 400 };
  }

  const source = fillSourceForAccountEnvironment(account.environment);
  const userId = account.userId;
  const snapshot = await fetchAlpacaAccountEquity(userId, { connectedAccountId: account.id });
  if (!snapshot || !Number.isFinite(snapshot.equity)) {
    return { ok: false, error: "failed to read Alpaca equity", status: 502 };
  }
  const activities = await fetchAlpacaAccountActivities(userId, {
    connectedAccountId: account.id,
    activityTypes: [...BROKER_TRANSFER_ACTIVITY_TYPE_LIST],
    maxPages: 50
  });
  const flows = listAlpacaTransferFlows(activities);
  const recomputed = recomputeHighWaterMarkFromTransferFlows({
    flows: flows.map((flow) => flow.amount),
    currentEquity: snapshot.equity
  });

  const oldHwmRaw = getInternalSetting<number>(HWM_KEY(userId, accountNumber, source));
  const oldHwm = Number.isFinite(oldHwmRaw) ? (oldHwmRaw as number) : null;
  persistDrawdownHighWaterMark({
    userId,
    accountNumber,
    source,
    highWaterMark: recomputed.highWaterMark,
    observation: {
      equity: snapshot.equity,
      at: new Date().toISOString(),
      appliedActivityIds: flows.map((flow) => flow.id).filter(Boolean).slice(-500)
    }
  });
  audit(
    "risk_hwm_recompute",
    {
      connectedAccountId: account.id,
      accountNumber,
      source,
      oldHwm,
      newHwm: recomputed.highWaterMark,
      equity: snapshot.equity,
      netTransfers: recomputed.netTransfers,
      transferCount: flows.length
    },
    userId,
    account.id
  );

  return {
    ok: true,
    connectedAccountId: account.id,
    accountNumber,
    source,
    oldHwm,
    newHwm: recomputed.highWaterMark,
    equity: snapshot.equity,
    netTransfers: recomputed.netTransfers,
    transferCount: flows.length,
    impliedDrawdownPct: impliedDrawdownPct(snapshot.equity, recomputed.highWaterMark)
  };
}
