// Per-user conversation transcript: powers chat reload + auditability, distinct from durable
// preferences (which go through src/lib/memory). Every turn is redacted ON WRITE — a failed
// redaction never reaches disk — and flagged. Ported from reference/atlas-public-src/bff/history.
// (NB: src/lib/history.ts is the unrelated OHLC price-history module.)

import { randomUUID } from "crypto";
import { clearChatTurns, insertChatTurn, listAllChatTurns, listChatTurns, trimChatTurns } from "./db";
import type { ChatTurn, ChatTurnRole } from "./types";
import { captureUserWriteEpoch, runWithUserWriteEpoch, type UserWriteEpoch } from "./user-write-fence";

export const MAX_TURNS = 100;

/**
 * Cap for the admin-only cross-user read. Higher than `MAX_TURNS` because that constant is the
 * per-user retention cap (`trimChatTurns`), while this window spans every user at once.
 */
export const MAX_ADMIN_TURNS = 500;

type RedactionKind = "plain" | "keyed" | "bearer";

const REDACTIONS: Array<{ re: RegExp; kind: RedactionKind }> = [
  { re: /\b\d{3}-\d{2}-\d{4}\b/g, kind: "plain" }, // SSN
  { re: /\b(?:\d[ -]?){13,16}\b/g, kind: "plain" }, // payment-card-ish
  { re: /\bsk-ant-[A-Za-z0-9_-]+\b/g, kind: "plain" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, kind: "plain" },
  { re: /\b(bearer)\s+[A-Za-z0-9._-]+\b/gi, kind: "bearer" },
  { re: /\b(api[_ -]?key|secret|token|password)(\s*(?:is|=|:)\s*)\S+/gi, kind: "keyed" }
];

/** Strip SSNs, card numbers, keys, bearer tokens, and `key = value` secrets; flag if anything matched. */
export function sanitizeTranscriptText(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  let out = String(text ?? "");
  for (const { re, kind } of REDACTIONS) {
    out = out.replace(re, (_match: string, g1?: string, g2?: string) => {
      redacted = true;
      if (kind === "keyed") return `${g1}${g2}[redacted]`;
      if (kind === "bearer") return `${g1} [redacted]`;
      return "[redacted]";
    });
  }
  return { text: out.slice(0, 4000), redacted };
}

export function appendTurn(
  userId: string,
  input: { role: ChatTurnRole; text: string; citations?: string[]; intent?: string | null; model?: string | null; clientTurnId?: string | null; connectedAccountId?: string | null },
  writeEpoch?: UserWriteEpoch
): ChatTurn {
  if (input.role !== "user" && input.role !== "assistant") throw new Error("role must be 'user' or 'assistant'");
  const sanitized = sanitizeTranscriptText(input.text);
  const turn: ChatTurn = {
    id: randomUUID(),
    userId,
    role: input.role,
    text: sanitized.text,
    citations: Array.isArray(input.citations) ? input.citations.slice(0, 8) : [],
    intent: input.intent ?? null,
    redacted: sanitized.redacted,
    model: input.model ?? null,
    clientTurnId: input.clientTurnId ?? null,
    connectedAccountId: input.connectedAccountId ?? null,
    createdAt: new Date().toISOString()
  };
  const epoch = writeEpoch ?? captureUserWriteEpoch(userId);
  return runWithUserWriteEpoch(userId, epoch, () => {
    insertChatTurn(turn);
    trimChatTurns(userId, MAX_TURNS);
    return turn;
  });
}

export function listTurns(userId: string, limit: number = MAX_TURNS, connectedAccountId?: string | null): ChatTurn[] {
  const n = Math.max(1, Math.min(Number(limit) || MAX_TURNS, MAX_TURNS));
  return listChatTurns(userId, n, connectedAccountId);
}

/**
 * EVERY user's turns, newest `limit` across all users, chronological. Admin-only — the one caller is
 * the requireAdmin-gated `/api/admin/transcript`, which backs the Admin > Chat Transcript page whose
 * label promises "every chat turn". Never call this from a per-caller route; use `listTurns`.
 */
export function listAllTurns(limit: number = MAX_ADMIN_TURNS): ChatTurn[] {
  const n = Math.max(1, Math.min(Number(limit) || MAX_ADMIN_TURNS, MAX_ADMIN_TURNS));
  return listAllChatTurns(n);
}

export function clearTurns(userId: string): number {
  const epoch = captureUserWriteEpoch(userId);
  return runWithUserWriteEpoch(userId, epoch, () => clearChatTurns(userId));
}
