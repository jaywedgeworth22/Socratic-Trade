"use client";

/** The console Assistant: chat with the trading copilot (POST /api/chat).
 *
 *  Ported from the legacy assistant console and improved:
 *  - drafts hand off to the console's Approvals screen (one decision surface)
 *    with an automatic policy dry-run preview — see draft-card.tsx;
 *  - failed sends keep your message and offer Retry instead of fabricating an
 *    apologetic assistant turn;
 *  - the missing-key gate is per-provider: it warns about the key the SELECTED
 *    model actually needs (mirrors the server's 412), not "any provider";
 *  - conversation can be cleared (DELETE /api/chat-history);
 *  - errors surface as toasts + inline notices — the screen never blanks.
 *
 *  The transcript persists server-side (the chat orchestrator records both
 *  turns), so this screen only ever READS /api/chat-history. Draft tickets are
 *  not part of the persisted transcript — they exist on live replies only. */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, RotateCcw, Send, Sparkles, Trash2 } from "lucide-react";
import type { ChatDraft } from "@/lib/chat/types";
import type { LlmReasoningEffort } from "@/lib/types";
import { humanizeLlmError } from "@/lib/llm-errors";
import { catalogEntryFor } from "@/lib/llm-model-catalog";
import { ALL_LLM_REASONING_EFFORTS, normalizeReasoningEffortForModel, reasoningCapabilityForModel } from "@/lib/llm-request";
import { reasoningAdviceForModel, recommendedReasoningEffortForModel } from "@/lib/model-reasoning-recommendations";
import { deriveReality } from "../lib/derive";
import { cx, fmtExact } from "../lib/format";
import { redirectToLogin } from "../lib/api";
import { useConsoleData } from "../lib/useConsoleData";
import { ModelBadge } from "../ui/provider-logo";
import { Chip, Select, TextInput, Tooltip } from "../ui/primitives";
import { useToast } from "../ui/toast";
import { DraftTicket } from "./draft-card";
import { AssistantMarkdown } from "./markdown";
import {
  CATALOG_MODEL_IDS,
  CHAT_MODEL_STORAGE_KEY,
  CHAT_REASONING_STORAGE_KEY,
  CUSTOM_MODEL_VALUE,
  MODEL_GROUPS,
  providerDisplayName,
  providerForModel
} from "./models";

interface MsgCitation {
  label: string;
  url?: string;
}

interface Msg {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  model?: string;
  citations?: MsgCitation[];
  draft?: ChatDraft | null;
  /** Set on a user message whose send failed — shows the Retry affordance. */
  failed?: boolean;
}

interface HistoryTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  citations?: string[];
  model?: string | null;
  createdAt?: string;
}

interface LiveCitation {
  source: string;
  chunk_id?: string;
  url?: string;
}

interface LiveReply {
  text: string;
  draft: ChatDraft | null;
  citations?: LiveCitation[];
  model?: string;
}

type ChatProviderStatus = Partial<Record<string, boolean>>;

/** Credential service the selected model will actually use: OpenRouter first when connected,
 *  otherwise the native provider.  Meta and catalog entries without a native transport always
 *  require OpenRouter, matching modelCredentialService / llmForModel on the server. */
export function chatCredentialServiceForModel(model: string, providerStatus: ChatProviderStatus): string {
  const nativeProvider = providerForModel(model);
  if (/^openrouter\//i.test(model.trim()) || nativeProvider === "meta" || catalogEntryFor(model)?.openRouterOnly === true) {
    return "openrouter";
  }
  return providerStatus.openrouter === true ? "openrouter" : nativeProvider;
}

/** Fail open while status is absent or partial; the API remains the authoritative credential gate. */
export function chatModelHasCredential(model: string, providerStatus: ChatProviderStatus): boolean {
  if (Object.keys(providerStatus).length === 0) return true;
  if (providerStatus.openrouter === undefined) return true;
  return providerStatus[chatCredentialServiceForModel(model, providerStatus)] !== false;
}

/** Router-matched suggested prompts (co-versioned with the chat orchestrator's
 *  intent classifier so a chip never dead-ends). */
const SUGGESTIONS: Array<{ category: string; prompt: string }> = [
  { category: "Critique", prompt: "Critique Socratic Trade's latest thesis and name what would falsify it." },
  { category: "Refocus", prompt: "Refocus the next run toward quality balance sheets and away from crowded momentum." },
  { category: "Memory", prompt: "What prior wins or failures should influence the next thesis?" },
  { category: "Evidence", prompt: "Which RAG evidence most changed the latest decision?" },
  { category: "Framework", prompt: "Suggest one framework improvement Socratic Trade should propose to itself." },
  { category: "Portfolio", prompt: "How do my current positions fit or conflict with the live thesis?" },
  { category: "Draft", prompt: "Draft a candidate trade that expresses the current thesis, then route it to Approvals." }
];

/** Pull the most useful plain-language message out of an API error response. */
async function apiErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: unknown; error?: unknown };
  const raw =
    typeof body.message === "string" && body.message.trim()
      ? body.message.trim()
      : typeof body.error === "string" && body.error.trim()
        ? body.error.trim()
        : "";
  // 5xx bodies carry the raw provider error (e.g. "gemini 401: API key not valid") —
  // translate it; 4xx messages from our own routes are already plain English.
  if (res.status >= 500) return humanizeLlmError(raw);
  return raw || `${fallback} (${res.status}).`;
}

export function AssistantChat() {
  const { snapshot } = useConsoleData();
  const toast = useToast();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [historyState, setHistoryState] = useState<"loading" | "ready" | "failed">("loading");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [inFlightClientTurnId, setInFlightClientTurnId] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<LlmReasoningEffort>("medium");
  /** Per-provider key availability ({} until loaded — treated as available so
   *  the gate never flashes before the check resolves). */
  const [providerStatus, setProviderStatus] = useState<ChatProviderStatus>({});
  /** True when the availability check itself failed, so "no 'no key' badges" means
   *  "we couldn't check" rather than "every provider has a key". */
  const [statusUnknown, setStatusUnknown] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);
  const [clearing, setClearing] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const seq = useRef(0);
  /** True once the user has locally changed the conversation (sent a message or
   *  cleared) — a late initial-history response must not clobber that. */
  const localEchoRef = useRef(false);
  /** Bumped on every successful Clear; an in-flight send compares against it so
   *  a late reply can't repopulate a transcript the user just cleared. */
  const clearGenRef = useRef(0);
  /** Idempotency keys by local user-message id: generated per send, REUSED on
   *  Retry so the server records the user turn exactly once (clientTurnId). */
  const clientTurnIdsRef = useRef<Record<string, string>>({});

  const reality = snapshot ? deriveReality(snapshot) : null;

  // ── Sticky model choice ────────────────────────────────────────────────────
  useEffect(() => {
    const saved = window.localStorage.getItem(CHAT_MODEL_STORAGE_KEY);
    const selected = saved || "";
    if (saved) setModel(saved);
    const savedEffort = window.localStorage.getItem(CHAT_REASONING_STORAGE_KEY) as LlmReasoningEffort | null;
    setReasoningEffort(
      savedEffort && ALL_LLM_REASONING_EFFORTS.includes(savedEffort)
        ? savedEffort
        : recommendedReasoningEffortForModel(selected, "chat")
    );
  }, []);
  const pickModel = (m: string) => {
    setModel(m);
    window.localStorage.setItem(CHAT_MODEL_STORAGE_KEY, m);
    const recommended = recommendedReasoningEffortForModel(m, "chat");
    setReasoningEffort(recommended);
    window.localStorage.setItem(CHAT_REASONING_STORAGE_KEY, recommended);
  };
  const pickReasoningEffort = (effort: LlmReasoningEffort) => {
    setReasoningEffort(effort);
    window.localStorage.setItem(CHAT_REASONING_STORAGE_KEY, effort);
  };

  // ── Server-persisted transcript ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/chat-history?limit=100");
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { turns: HistoryTurn[] };
        if (cancelled) return;
        if (localEchoRef.current) {
          // The user already sent (or cleared) while this load was in flight —
          // the fetched snapshot is older than what's on screen. Keep the live
          // conversation instead of clobbering it (their turns persist
          // server-side and will be in the next full load anyway).
          setHistoryState("ready");
          return;
        }
        setMessages(
          body.turns.map((t) => ({
            id: t.id,
            role: t.role,
            text: t.text,
            at: t.createdAt ?? "",
            model: t.model ?? undefined,
            citations: (t.citations ?? []).map((label) => ({ label }))
          }))
        );
        setHistoryState("ready");
      } catch {
        if (!cancelled) setHistoryState("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Provider key availability (re-checked on focus/visibility so connecting
  //    a key in Settings unlocks chat without a reload) ───────────────────────
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/chat/providers");
        if (!res.ok) {
          if (!cancelled) setStatusUnknown(true);
          return;
        }
        const body = (await res.json()) as { providers?: Partial<Record<string, boolean>> };
        if (cancelled) return;
        if (body.providers) {
          setProviderStatus(body.providers);
          setStatusUnknown(false);
        } else {
          setStatusUnknown(true);
        }
      } catch {
        // Availability stays FAIL-OPEN: every model remains selectable. Failing closed here
        // would mean one flaky /api/chat/providers response locks the user out of Coach
        // entirely, which is a far worse outcome than letting them pick a provider whose key
        // is missing — that case already surfaces a clear error on send. What we must NOT do
        // is keep quiet about it, because an empty status map is indistinguishable from
        // "everything has a key". `statusUnknown` makes the difference visible instead.
        if (!cancelled) setStatusUnknown(true);
      }
    };
    void load();
    const onFocus = () => void load();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // ── Keep the newest message in view ────────────────────────────────────────
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending, historyState]);

  // ── Gate: does the SELECTED model's provider have a usable key? ────────────
  const modelUnselected = !model;
  const provider = providerForModel(model || "");
  const credentialService = chatCredentialServiceForModel(model || "", providerStatus);
  const statusLoaded = Object.keys(providerStatus).length > 0;
  const keyMissing = modelUnselected || !chatModelHasCredential(model, providerStatus);
  const customPending = model === CUSTOM_MODEL_VALUE;

  const send = useCallback(
    async (override?: string, retryId?: string) => {
      const text = (override ?? input).trim();
      if (!text || sending || clearing || keyMissing) return;
      if (modelUnselected) {
        toast.push("warn", "Choose a model", "Coach has no hidden model default.  Pick the model you want to answer.");
        return;
      }
      if (customPending) {
        toast.push("warn", "Enter a model id", "Type a model id next to the picker, or choose a listed model.");
        return;
      }
      if (override === undefined) setInput("");
      const stamp = `${Date.now()}-${seq.current++}`;
      const userId = retryId ?? `u-${stamp}`;
      // Reuse the failed send's idempotency key on Retry — the server dedupes the
      // user turn on it, so the saved transcript records this prompt exactly once.
      const clientTurnId = clientTurnIdsRef.current[userId] ?? crypto.randomUUID();
      clientTurnIdsRef.current[userId] = clientTurnId;
      localEchoRef.current = true;
      const gen = clearGenRef.current;
      setMessages((m) =>
        retryId
          ? m.map((x) => (x.id === retryId ? { ...x, failed: false } : x))
          : [...m, { id: userId, role: "user", text, at: new Date().toISOString() }]
      );
      setSending(true);
      setInFlightClientTurnId(clientTurnId);
      try {
        // clientTurnId is the retry-safety rail: the server records the user turn
        // BEFORE calling the provider, and dedupes on this id — so a Retry gets a
        // fresh answer without recording the prompt a second time in the saved
        // transcript. (This replaced the old "history will show this twice" probe.)
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: text,
            model,
            clientTurnId,
            ...(reasoningCapabilityForModel(model)
              ? { reasoningEffort: normalizeReasoningEffortForModel(model, reasoningEffort) }
              : {})
          })
        });
        if (res.status === 401) {
          redirectToLogin();
          throw new Error("Session expired.");
        }
        if (!res.ok) throw new Error(await apiErrorMessage(res, "Chat request failed"));
        const reply = (await res.json()) as LiveReply;
        // If the user cleared the conversation while this was in flight, drop
        // the late reply instead of repopulating the transcript they deleted.
        if (clearGenRef.current !== gen) return;
        setMessages((m) => [
          ...m,
          {
            id: `a-${stamp}`,
            role: "assistant",
            text: reply.text,
            at: new Date().toISOString(),
            model: reply.model,
            citations: (reply.citations ?? []).map((c) => ({ label: c.chunk_id ?? c.source, url: c.url })),
            draft: reply.draft
          }
        ]);
      } catch (e) {
        if (clearGenRef.current !== gen) return;
        const message = e instanceof Error ? e.message : "Chat request failed.";
        setMessages((m) => m.map((x) => (x.id === userId ? { ...x, failed: true } : x)));
        toast.push("neg", "Message not answered", message);
      } finally {
        setSending(false);
        setInFlightClientTurnId(null);
      }
    },
    [input, sending, clearing, keyMissing, customPending, modelUnselected, model, reasoningEffort, toast]
  );

  const clearConversation = async () => {
    // Disabled while a reply is in flight (see the button), but guard anyway:
    // deleting mid-turn would race the server, which persists the in-flight
    // turn's messages around the DELETE and would orphan/repopulate history.
    if (sending || clearing) return;
    if (!clearArmed) {
      setClearArmed(true);
      window.setTimeout(() => setClearArmed(false), 4000);
      return;
    }
    setClearArmed(false);
    setClearing(true);
    try {
      const res = await fetch("/api/chat-history", { method: "DELETE" });
      if (!res.ok) throw new Error(String(res.status));
      clearGenRef.current += 1; // any still-unfinished send drops its late reply
      localEchoRef.current = true;
      setMessages([]);
      toast.push(
        "info",
        "Conversation cleared",
        "Your whole assistant transcript was deleted — it is one conversation shared across all your accounts.  Staged proposals are untouched."
      );
    } catch {
      toast.push("neg", "Could not clear", "The transcript is unchanged — try again.");
    } finally {
      setClearing(false);
    }
  };

  const autoResize = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  };

  const canSend = !sending && !clearing && !keyMissing && !customPending && !modelUnselected && input.trim().length > 0;

  return (
    // Mobile height budgets the fixed bottom tab bar (~4rem incl. safe area) on top of the
    // top chrome — 14rem left the composer pinned UNDER the bar. lg has no bottom bar.
    <section className="con-card flex h-[calc(100dvh-18rem)] min-h-[24rem] flex-col overflow-hidden lg:h-[calc(100dvh-12rem)]">
      {/* Header */}
      {/* No heading here: the page h1 ("Coach") above this card is the one title —
          a second in-card h1 ("Assistant") gave the surface two competing names. */}
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-[color:var(--con-line)] px-3 py-2 sm:px-4">
        <Sparkles size={15} className="shrink-0 text-[color:var(--con-accent)]" aria-hidden />
        <Tooltip
          content="The assistant can answer questions and draft orders, but it has no way to place one — every order goes through Approvals.">
          <span
            className="hidden text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)] md:inline">
            drafts orders you approve — it never places on its own
          </span>
        </Tooltip>
        <div className="ml-auto flex items-center gap-2">
          {reasoningCapabilityForModel(model) && (
            <div className="w-24 sm:w-28">
              <Select
                value={normalizeReasoningEffortForModel(model, reasoningEffort) ?? "medium"}
                onChange={(event) => pickReasoningEffort(event.target.value as LlmReasoningEffort)}
                style={{ padding: "3px 8px", fontSize: "var(--con-fs-xs)" }}
                title={reasoningAdviceForModel(model) ?? "Provider-side reasoning effort for this Coach response."}
                aria-label="Chat reasoning effort"
              >
                {reasoningCapabilityForModel(model)!.options.map((option) => (
                  <option key={option.value} value={option.value} title={option.hint}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {customPending || (model.length > 0 && !CATALOG_MODEL_IDS.has(model)) ? (
            <div className="w-36">
              <TextInput
                value={customPending ? "" : model}
                placeholder="model id, e.g. gpt-5.6-terra"
                className="con-mono"
                style={{ padding: "3px 8px", fontSize: "var(--con-fs-xs)" }}
                title="Type any model id your provider serves.  It is routed by name: claude-* to Anthropic, grok-* to xAI, gemini-* to Gemini, mistral-* to Mistral, deepseek-* to DeepSeek, anything else to OpenAI."
                onChange={(e) => pickModel(e.target.value.trim() || CUSTOM_MODEL_VALUE)}
              />
            </div>
          ) : null}
          <div className="w-40 sm:w-56">
            <Select
              value={modelUnselected ? "" : CATALOG_MODEL_IDS.has(model) ? model : CUSTOM_MODEL_VALUE}
              onChange={(e) => {
                pickModel(e.target.value);
                inputRef.current?.focus();
              }}
              style={{ padding: "3px 8px", fontSize: "var(--con-fs-xs)" }}
              title={
                statusUnknown
                  ? "Which AI model answers. $ signs are relative cost within the provider.  Key availability could NOT be checked right now, so no model is marked 'no key' — a provider without a key will fail on send."
                  : "Which AI model answers.  $ signs are relative cost within the provider.  'no key' means that provider has no key in Connections."
              }
              aria-label="Chat model"
            >
              <option value="" disabled>Choose a model…</option>
              {MODEL_GROUPS.map((g) => {
                const noKey = statusLoaded && g.options.every((o) => !chatModelHasCredential(o.value, providerStatus));
                return (
                  <optgroup key={g.provider} label={`${g.label}${noKey ? " — no key" : ""}`}>
                    {g.options.map((o) => {
                      const optionNoKey = statusLoaded && !chatModelHasCredential(o.value, providerStatus);
                      return (
                        <option key={o.value} value={o.value} disabled={optionNoKey}>
                          {o.label}
                          {o.tier ? ` (${o.tier})` : ""}
                          {optionNoKey ? " — no key" : ""}
                        </option>
                      );
                    })}
                  </optgroup>
                );
              })}
            </Select>
          </div>
          <Tooltip
            content={
              sending
                ? "Wait for the current reply to finish — clearing mid-reply could orphan it in the saved history."
                : "Deletes your ENTIRE saved assistant conversation — one transcript shared across all your accounts, not just the one selected.  Staged proposals, orders, and positions are untouched.  Click twice to confirm."
            }>
            <button
              type="button"
              onClick={() => void clearConversation()}
              disabled={sending || clearing}
              className={cx(
                "flex h-7 items-center gap-1 rounded-control border px-2 text-[length:var(--con-fs-xs)] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                clearArmed
                  ? "border-[color:var(--con-neg-border)] bg-[color:var(--con-neg-soft)] text-[color:var(--con-neg)]"
                  : "border-[color:var(--con-line-strong)] text-[color:var(--con-muted)] hover:bg-[color:var(--con-surface-2)] hover:text-[color:var(--con-fg)]"
              )}>
              <Trash2 size={13} aria-hidden />
              {clearArmed ? "Really clear?" : clearing ? "Clearing…" : "Clear"}
            </button>
          </Tooltip>
        </div>
      </header>
      {/* Transcript */}
      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3 sm:px-4" role="log" aria-live="polite" aria-label="Conversation">
        {historyState === "loading" && (
          <div className="flex items-center gap-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            <Loader2 size={13} className="animate-spin" aria-hidden /> Loading earlier conversation…
          </div>
        )}
        {historyState === "failed" && (
          <Tooltip
            content="Only loading old messages failed — sending new ones still works.">
            <div
              className="rounded-control bg-[color:var(--con-warn-soft)] px-3 py-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">Couldn't load the earlier conversation. New messages still work; reload the page to retry.
                        </div>
          </Tooltip>
        )}
        {historyState === "ready" && messages.length === 0 && (
          <div className="grid h-full place-items-center">
            <div className="max-w-xl px-2 text-center">
              <Sparkles size={20} className="mx-auto text-[color:var(--con-accent)]" aria-hidden />
              <p className="mt-2 font-semibold">Coach the strategy</p>
              <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                Challenge the thesis, steer the next run, preserve lessons, inspect evidence, or draft an order for
                Approvals.
              </p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <Tooltip key={s.prompt} content={`Sends: "${s.prompt}"`}>
                    <button
                      type="button"
                      onClick={() => void send(s.prompt)}
                      disabled={sending || keyMissing}
                      className="rounded-full border border-[color:var(--con-line-strong)] bg-[color:var(--con-surface)] px-3 py-1.5 text-[length:var(--con-fs-xs)] transition-colors hover:border-[color:var(--con-accent)] hover:bg-[color:var(--con-surface-2)] disabled:cursor-not-allowed disabled:opacity-50">
                      <span className="uppercase tracking-wide text-[color:var(--con-faint)]">{s.category}</span>
                      <span className="ml-1.5">{s.prompt}</span>
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={cx("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div className="max-w-[88%] sm:max-w-[36rem]">
              <Tooltip content={m.at ? fmtExact(m.at) : undefined}>
                <div
                  className={cx(
                    "rounded-card px-3 py-2 text-[length:var(--con-fs-sm)]",
                    m.role === "user" ? "bg-[color:var(--con-accent-soft)]" : "bg-[color:var(--con-surface-2)]",
                    m.failed && "border border-[color:var(--con-warn-border)]"
                  )}>
                  {m.role === "assistant" ? (
                    <AssistantMarkdown>{m.text}</AssistantMarkdown>
                  ) : (
                    <p className="whitespace-pre-wrap leading-relaxed">{m.text}</p>
                  )}
                  {m.citations && m.citations.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {m.citations.map((c, i) =>
                        c.url ? (
                          <Tooltip key={i} content={`Source this answer cited — opens ${c.url}`}>
                            <a href={c.url} target="_blank" rel="noopener noreferrer">
                              <Chip tone="muted" className="underline decoration-dotted">
                                {c.label}
                              </Chip>
                            </a>
                          </Tooltip>
                        ) : (
                          <Chip key={i} tone="muted" title="Source this answer cited.">
                            {c.label}
                          </Chip>
                        )
                      )}
                    </div>
                  )}
                  {m.draft && reality && <DraftTicket draft={m.draft} reality={reality} />}
                </div>
              </Tooltip>
              {m.role === "assistant" && m.model && (
                <div className="mt-0.5 px-1 text-[length:var(--con-fs-2xs)] text-[color:var(--con-faint)]">
                  <ModelBadge modelId={m.model} size="sm" className="font-normal" title="The model that produced this answer." />
                </div>
              )}
              {m.failed && (
                <div className="mt-1 flex items-center justify-end gap-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">
                  <AlertTriangle size={12} aria-hidden /> Not answered
                  <Tooltip content="Send this message again.">
                    <button
                      type="button"
                      onClick={() => void send(m.text, m.id)}
                      disabled={sending || clearing}
                      className="flex items-center gap-1 rounded border border-[color:var(--con-line-strong)] px-1.5 py-0.5 font-semibold text-[color:var(--con-fg)] transition-colors hover:bg-[color:var(--con-surface-2)] disabled:opacity-50">
                      <RotateCcw size={11} aria-hidden /> Retry
                    </button>
                  </Tooltip>
                </div>
              )}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex items-center gap-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
            <Loader2 size={13} className="animate-spin" aria-hidden /> Thinking…
          </div>
        )}
      </div>
      {/* Composer */}
      <div className="border-t border-[color:var(--con-line)] px-3 py-2.5 sm:px-4">
        {keyMissing && (
          <p className="mb-2 flex flex-wrap items-center gap-1.5 rounded-control border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] px-3 py-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">
            <AlertTriangle size={13} aria-hidden />
            No {credentialService === "openrouter" ? "OpenRouter" : providerDisplayName(provider)} key is connected — this model can&apos;t answer.
            <Link
              href="/console/connections#api-keys"
              className="font-semibold underline decoration-dotted"
              title="Open Connections to configure an LLM provider API key."
            >
              Connect one in Connections
            </Link>
            or pick a different model above.
          </p>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              autoResize();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={modelUnselected ? "Choose a model above to chat…" : keyMissing ? "Pick a model with a key to chat…" : "Ask a question, or describe an order to draft…"}
            disabled={keyMissing}
            className="con-textarea flex-1 leading-normal"
            style={{ resize: "none", minHeight: "2.25rem", maxHeight: "9rem" }}
            title="Your message to the assistant.  Enter sends; Shift+Enter adds a line break."
            aria-label="Message the assistant"
          />
          <Tooltip
            content={
              keyMissing
                ? "Connect a key for this model's provider, or pick another model."
                : modelUnselected
                  ? "Choose a model first; Coach has no hidden default."
                : customPending
                  ? "Type a model id next to the picker first."
                  : "Send the message (Enter)."
            }>
            <button
              type="button"
              onClick={() => void send()}
              disabled={!canSend}
              className="con-btn con-btn-primary h-9 shrink-0">
              <Send size={14} aria-hidden /> Send
            </button>
          </Tooltip>
          {sending && inFlightClientTurnId ? (
            <button
              type="button"
              className="con-btn h-9 shrink-0"
              title="Cancel this turn.  In-flight work is kept as a partial reply."
              onClick={() => {
                void fetch("/api/chat/cancel", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ clientTurnId: inFlightClientTurnId })
                });
              }}
            >
              Cancel
            </button>
          ) : null}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[length:var(--con-fs-2xs)] text-[color:var(--con-faint)]">
          <Tooltip
            content="The assistant reads real quotes and your real account data.  When it can't know something, it says so instead of inventing a number.">
            <span>
              Answers use live data and your account.  Orders come back as drafts — nothing places without your approval.
            </span>
          </Tooltip>
          <span className="hidden sm:inline">Enter to send · Shift+Enter for a line break</span>
        </div>
      </div>
    </section>
  );
}
