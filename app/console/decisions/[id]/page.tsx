"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, BookOpen, Brain, Database, GitBranch, MessageSquare, Swords, TrendingUp } from "lucide-react";
import type { ProposalScorecard, SocraticDecisionCase, SocraticDecisionTrace, SocraticEvidenceItem, SocraticFrameworkProposal, SocraticRagAttribution, StrategyRunRow } from "@/lib/types";
import { ProposalScorecardBlock } from "../../components/proposal-scorecard";
import { fmtExact, fmtMoney, fmtPct, timeAgo, EM_DASH } from "../../lib/format";
import { authorityLabel, decisionStatusLabel, evidenceKindLabel, feedStatusLabel, frameworkStatusLabel, plainLabel, thesisTagLabel } from "../../lib/labels";
import { dissentItemsForDisplay } from "../../lib/dissent";
import { CONSOLE_PAGE_WIDTH } from "../../lib/page-width";
import { redTeamFailureMeta, redTeamVerdictLabel } from "../../lib/red-team";
import { Btn, Card, Chip, SignedText, TextArea } from "../../ui/primitives";
import { ModelBadge } from "../../ui/provider-logo";
import { SymbolButton } from "../../ui/symbol-drilldown";

export const metadata = { title: "Decision Details" };

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; decision: SocraticDecisionCase; framework: SocraticFrameworkProposal[]; run?: StrategyRunRow; scorecard?: ProposalScorecard };

const SIDE_LABEL: Record<string, string> = { buy: "BUY", sell: "SELL", short: "SHORT", cover: "COVER" };

export default function DecisionTracePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const decisionId = String(params.id ?? "");
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [coachMode, setCoachMode] = useState<"note" | "lesson" | "framework">("note");

  const load = useCallback(
    async () => {
      try {
        const [decisionRes, frameworkRes] = await Promise.all([
          fetch(`/api/socratic/decisions/${encodeURIComponent(decisionId)}`, { cache: "no-store" }),
          fetch("/api/socratic/framework?limit=100", { cache: "no-store" })
        ]);
        if (!decisionRes.ok) throw new Error(await decisionRes.text());
        const payload = (await decisionRes.json()) as SocraticDecisionTrace;
        const decision = payload.decision;
        const framework = frameworkRes.ok ? ((await frameworkRes.json()) as SocraticFrameworkProposal[]) : [];
        setState({
          status: "ready",
          decision,
          framework: framework.filter((proposal) => proposal.decisionId === decision.id),
          ...(payload.run ? { run: payload.run } : {}),
          ...(payload.scorecard ? { scorecard: payload.scorecard } : {})
        });
      } catch (error) {
        setState({ status: "error", message: error instanceof Error ? error.message : "Could not load decision trace." });
      }
    },
    [decisionId]
  );

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  // Prefer real browser back (returns to whatever list/filter the owner was on) —
  // only fall back to a fixed destination when there's no history to go back to
  // (e.g. this trace was opened directly, in a new tab, or via a deep link).
  const goBack = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push("/console/activity");
    }
  }, [router]);

  const buildCoachPayload = () => {
    const trimmed = note.trim();
    if (!trimmed || state.status !== "ready") return null;
    if (coachMode === "framework") {
      return {
        note: trimmed,
        promoteTo: "framework" as const,
        framework: {
          subsystem: "coaching",
          priority: "medium",
          title: `Coach rewrite for ${state.decision.symbol ?? state.decision.thesis ?? "decision"}`,
          rationale: trimmed,
          proposedChange: trimmed
        }
      };
    }
    if (coachMode === "lesson") {
      return {
        note: trimmed,
        promoteTo: "lesson" as const,
        lessonText: trimmed
      };
    }
    return { note: trimmed };
  };

  const saveNote = async () => {
    const trimmed = note.trim();
    if (!trimmed || state.status !== "ready") return;
    const payload = buildCoachPayload();
    if (!payload) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/socratic/decisions/${encodeURIComponent(state.decision.id)}/coach`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(await response.text());
      setNote("");
      setCoachMode("note");
      setMessage(coachMode === "note" ? "Saved to this decision case." : coachMode === "lesson" ? "Saved and promoted into lessons." : "Saved and promoted into framework review.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save note.");
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "loading") {
    return (
      <div className={CONSOLE_PAGE_WIDTH}>
        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">Loading decision trace...</p>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className={CONSOLE_PAGE_WIDTH}>
        <button
          type="button"
          onClick={goBack}
          className="mb-4 inline-flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]"
        >
          <ArrowLeft size={13} /> Back
        </button>
        <Card>
          <p className="text-[color:var(--con-warn)]">{state.message}</p>
        </Card>
      </div>
    );
  }

  const { decision, framework, run, scorecard } = state;
  const outcome = decision.outcome;
  const visibleDissent = dissentItemsForDisplay(decision);

  // Intentionally wider than CONSOLE_PAGE_WIDTH: this page reuses the
  // con-thesis-hero + xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]
  // two-column trace/aside layout (same shape as the console home page).
  // Squeezing that into CONSOLE_PAGE_WIDTH's 768px would starve the main
  // column to satisfy the aside's 320px floor. See
  // docs/rollouts/2026-07-08-console-page-width-parity.md.
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={goBack}
          className="inline-flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]"
        >
          <ArrowLeft size={13} /> Back
        </button>
        <div className="flex flex-wrap gap-2">
          <Chip tone="accent" title="Decision status persisted on the Socratic case file.">
            {decisionStatusLabel(decision.status)}
          </Chip>
          <Chip tone="muted" title={authorityLabel(decision.authority).title || "Authority mode at decision time."}>
            {authorityLabel(decision.authority).label}
          </Chip>
          {decision.updatedAt && (
            <Chip tone="muted" title={fmtExact(decision.updatedAt)}>
              updated {timeAgo(decision.updatedAt)}
            </Chip>
          )}
        </div>
      </div>

      <section className="con-thesis-hero">
        <div className="min-w-0">
          <div className="con-card-title flex items-center gap-1.5">
            <Brain size={13} /> Decision trace
          </div>
          <h1>{decision.thesis || `${decision.symbol ?? "Portfolio"} decision`}</h1>
          <p>{decision.rationale || "No rationale is attached to this case."}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {decision.symbol && (
              <Chip tone="accent">
                {decision.side ? `${SIDE_LABEL[decision.side] ?? decision.side.toUpperCase()} ` : ""}
                <SymbolButton symbol={decision.symbol} className="text-inherit" />
              </Chip>
            )}
            {decision.thesisTag && <Chip tone="muted">{thesisTagLabel(decision.thesisTag)}</Chip>}
            {decision.regime && <Chip tone="muted">{decision.regime}</Chip>}
            {typeof decision.confidenceScore === "number" && <Chip tone="pos">confidence {decision.confidenceScore}</Chip>}
            {run && <Chip tone="muted">run {timeAgo(run.startedAt)}</Chip>}
          </div>
        </div>

        <div className="con-autonomy-card">
          <div className="con-card-title">Action</div>
          <div className="mt-1 text-[length:var(--con-fs-xl)] font-semibold">{decision.action || EM_DASH}</div>
          <p>{fmtMoney(decision.notional)}</p>
          {decision.model ? (
            <ModelBadge modelId={decision.model} className="mt-1 text-[length:var(--con-fs-xs)]" title="The model that made this decision" />
          ) : (
            <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]" title="Older cases predate served-model persistence; the deciding model was not recorded.">
              deciding model not recorded
            </p>
          )}
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <div className="flex flex-col gap-4">
          <TraceSection icon={<Database size={13} />} title="Evidence">
            <EvidenceList items={decision.evidence} empty="No structured evidence items are attached to this case yet." />
          </TraceSection>

          {/* Read-only render of the linked proposal's persisted decision scorecard (r3). */}
          {scorecard && <ProposalScorecardBlock scorecard={scorecard} defaultOpen />}

          <TraceSection icon={<BookOpen size={13} />} title="Retrieved citations">
            {decision.ragAttributions.length > 0 ? (
              <div className="flex flex-col gap-2">
                {decision.ragAttributions.map((item, index) => (
                  <RagItem key={`${item.chunkId ?? item.title ?? item.source ?? "rag"}-${index}`} item={item} />
                ))}
              </div>
            ) : (
              <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                No retrieved citations are linked to this case yet.
              </p>
            )}
          </TraceSection>

          <TraceSection icon={<Swords size={13} />} title="Dissent">
            {decision.redTeamVerdict?.available && (
              <article className="con-evidence-card con-evidence-warn">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <strong className="flex items-center gap-2">
                    Red Team
                    <ModelBadge
                      modelId={decision.redTeamVerdict.model}
                      className="text-[length:var(--con-fs-xs)]"
                      title="The adversarial reviewer model that produced this verdict"
                    />
                  </strong>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Chip
                      tone={decision.redTeamVerdict.rejected
                        ? "neg"
                        : decision.redTeamVerdict.verdict === "approve-at-half"
                          ? "warn"
                          : "pos"}
                      title="Red Team verdict"
                    >
                      {redTeamVerdictLabel(
                        decision.redTeamVerdict,
                        decision.policyDecision?.socraticOverride?.applied
                      )}
                    </Chip>
                    <span>{redTeamTriggerLabel(decision.redTeamVerdict.trigger)}</span>
                  </div>
                </div>
                <p>{decision.redTeamVerdict.reason}</p>
              </article>
            )}
            {decision.redTeamVerdict && !decision.redTeamVerdict.available && (
              <article className="con-evidence-card con-evidence-warn">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <strong className="flex items-center gap-2">
                    Red Team
                    <ModelBadge
                      modelId={decision.redTeamVerdict.model}
                      className="text-[length:var(--con-fs-xs)]"
                      title="The adversarial reviewer model that failed to produce a verdict"
                    />
                  </strong>
                  <span title={redTeamFailureMeta(decision.redTeamVerdict.failureKind).title}>
                    {redTeamVerdictLabel(
                      decision.redTeamVerdict,
                      decision.policyDecision?.socraticOverride?.applied,
                      decision.status
                    )}{" "}
                    ({redTeamFailureMeta(decision.redTeamVerdict.failureKind).label})
                  </span>
                </div>
                <p>{decision.redTeamVerdict.reason}</p>
              </article>
            )}
            <EvidenceList items={visibleDissent} empty={decision.redTeamVerdict ? "" : "No dissent items are attached to this case yet — no adversarial review was triggered."} />
          </TraceSection>
        </div>

        <aside className="flex flex-col gap-4">
          <Card
            title={
              <span className="flex items-center gap-1.5">
                <TrendingUp size={13} /> Outcome
              </span>
            }
          >
            {outcome ? (
              <div className="grid gap-3 text-[length:var(--con-fs-sm)]">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[color:var(--con-faint)]">Status</span>
                  <strong>{feedStatusLabel(outcome.status)}</strong>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[color:var(--con-faint)]">Return</span>
                  <strong>{typeof outcome.returnPct === "number" ? <SignedText value={outcome.returnPct}>{fmtPct(outcome.returnPct, 2, true)}</SignedText> : EM_DASH}</strong>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[color:var(--con-faint)]">P&amp;L</span>
                  <strong>{fmtMoney(outcome.pnlUsd)}</strong>
                </div>
                {outcome.note && <p className="text-[color:var(--con-muted)]">{outcome.note}</p>}
              </div>
            ) : (
              <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                No matured outcome history is attached to this case yet.
              </p>
            )}
          </Card>

          <Card
            title={
              <span className="flex items-center gap-1.5">
                <MessageSquare size={13} /> Coach on this trace
              </span>
            }
          >
            {run ? (
              <div className="mb-3 rounded-control border border-[color:var(--con-line)] bg-[color:color-mix(in_srgb,var(--con-bg-elev)_80%,transparent)] p-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                Source run {timeAgo(run.startedAt)} · {feedStatusLabel(run.status)} · {run.totalCount} proposal{run.totalCount === 1 ? "" : "s"}
                {run.summary ? ` · ${run.summary}` : ""}
              </div>
            ) : null}
            {decision.coachNotes.length > 0 ? (
              <div className="mb-3 flex flex-col gap-2">
                {decision.coachNotes.slice(-4).map((coachNote, index) => (
                  <p key={`${coachNote}-${index}`} className="rounded-control border border-[color:var(--con-line)] p-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                    {coachNote}
                  </p>
                ))}
              </div>
            ) : null}
            <div className="mb-2 flex flex-wrap gap-2">
              <button type="button" className={`con-chip ${coachMode === "note" ? "con-chip-accent" : ""}`} onClick={() => setCoachMode("note")}>
                Attach note
              </button>
              <button type="button" className={`con-chip ${coachMode === "lesson" ? "con-chip-accent" : ""}`} onClick={() => setCoachMode("lesson")}>
                Promote lesson
              </button>
              <button type="button" className={`con-chip ${coachMode === "framework" ? "con-chip-accent" : ""}`} onClick={() => setCoachMode("framework")}>
                Promote framework
              </button>
            </div>
            <TextArea
              rows={4}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={
                coachMode === "framework"
                  ? "What framework change should this decision propose?"
                  : coachMode === "lesson"
                    ? "What durable lesson should Socratic Trade keep?"
                    : "What should Socratic Trade remember about this decision?"
              }
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Btn variant="primary" size="sm" disabled={busy || !note.trim()} onClick={() => void saveNote()}>
                <MessageSquare size={14} /> Save note
              </Btn>
              {message && <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">{message}</span>}
            </div>
          </Card>

          <Card
            title={
              <span className="flex items-center gap-1.5">
                <GitBranch size={13} /> Framework proposals
              </span>
            }
          >
            {framework.length > 0 ? (
              <div className="flex flex-col gap-2">
                {framework.map((proposal) => (
                  <article key={proposal.id} className="con-evidence-card con-evidence-accent">
                    <div className="flex items-start justify-between gap-3">
                      <strong>{proposal.title}</strong>
                      <span>{frameworkStatusLabel(proposal.status)}</span>
                    </div>
                    <p>{proposal.proposedChange}</p>
                    {proposal.ownerResponse && (
                      <p className="mt-1 text-[color:var(--con-faint)]">
                        {proposal.ownerVerb ? `${proposal.ownerVerb}: ` : "Owner: "}
                        {proposal.ownerResponse}
                      </p>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                No framework proposal is linked to this decision yet.
              </p>
            )}
          </Card>

          <Card title="Lessons">
            {decision.lessons.length > 0 ? (
              <ul className="list-disc pl-4 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                {decision.lessons.map((lesson, index) => (
                  <li key={`${lesson}-${index}`}>{lesson}</li>
                ))}
              </ul>
            ) : (
              <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">No durable lessons are attached yet.</p>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}

function TraceSection({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-1.5">
          {icon} {title}
        </span>
      }
    >
      {children}
    </Card>
  );
}

function EvidenceList({ items, empty }: { items: SocraticEvidenceItem[]; empty: string }) {
  if (items.length === 0) {
    return empty ? <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">{empty}</p> : null;
  }
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, index) => (
        <article key={`${item.kind}-${item.title}-${index}`} className={`con-evidence-card con-evidence-${toneFromSocratic(item.tone)}`}>
          <div className="flex items-start justify-between gap-3">
            <strong>{item.title}</strong>
            <span>{[evidenceKindLabel(item.kind), item.source].filter(Boolean).join(" · ")}</span>
          </div>
          <p>{item.summary}</p>
        </article>
      ))}
    </div>
  );
}

function RagItem({ item }: { item: SocraticRagAttribution }) {
  const meta = [plainLabel(item.docType), item.source, typeof item.score === "number" ? `score ${item.score.toFixed(2)}` : item.symbol]
    .filter(Boolean)
    .join(" · ");
  return (
    <article className="con-evidence-card con-evidence-accent">
      <div className="flex items-start justify-between gap-3">
        <strong>{item.title || item.chunkId || "Retrieved evidence"}</strong>
        <span>{meta}</span>
      </div>
      <p>{item.contribution || item.text}</p>
      {item.url && (
        <a className="mt-2 inline-flex text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]" href={item.url} target="_blank" rel="noreferrer">
          Source
        </a>
      )}
    </article>
  );
}

function toneFromSocratic(tone: SocraticEvidenceItem["tone"]): "pos" | "warn" | "neg" | "accent" {
  if (tone === "positive") return "pos";
  if (tone === "negative") return "neg";
  if (tone === "warning") return "warn";
  return "accent";
}

function redTeamTriggerLabel(trigger: NonNullable<SocraticDecisionCase["redTeamVerdict"]>["trigger"]): string {
  if (trigger === "confidence") return "confidence";
  if (trigger === "notional") return "large notional";
  if (trigger === "live_opening") return "live opening";
  if (trigger === "override_requested") return "override request";
  if (trigger === "escalation_regime") return "risk regime";
  return "legacy trigger";
}
