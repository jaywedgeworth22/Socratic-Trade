"use client";

/** First-run readiness checklist hero (UX PR-A3).
 *  When incomplete: dominant Thesis surface with one CTA per unfinished step.
 *  When ready: collapsed non-dominant "You're set" (or hidden via prop).
 *  Pattern mirrors needs-attention.tsx; data from deriveReadinessChecklist. */

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Circle, ListChecks } from "lucide-react";
import type { DashboardSnapshot } from "../../dashboard-types";
import { deriveReadinessChecklist, type ReadinessStep } from "../lib/derive";
import { Card } from "../ui/primitives";

function StepRow({ step, isNext }: { step: ReadinessStep; isNext: boolean }) {
  const body = (
    <div
      className="flex items-start gap-2.5 rounded-control border p-3 transition-colors"
      style={{
        borderColor: step.complete
          ? "var(--con-pos-border)"
          : isNext
            ? "var(--con-accent-border)"
            : "var(--con-line)"
      }}
    >
      <span className="sr-only">
        {step.complete ? "Completed" : isNext ? "Next step" : "Pending"}
      </span>
      {step.complete ? (
        <Check size={15} className="mt-0.5 shrink-0" style={{ color: "var(--con-pos)" }} aria-hidden="true" />
      ) : (
        <Circle
          size={15}
          className="mt-0.5 shrink-0"
          style={{ color: isNext ? "var(--con-accent)" : "var(--con-faint)" }}
          aria-hidden="true"
        />
      )}
      <div className="min-w-0 flex-1">
        <div
          className="text-[length:var(--con-fs-sm)] font-semibold"
          style={step.complete ? { color: "var(--con-muted)" } : undefined}
        >
          {step.title}
        </div>
        <p className="mt-0.5 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
          {step.detail}
        </p>
        {!step.complete && step.ctaLabel && step.href && step.id !== "run-once" && (
          <span className="mt-1.5 inline-flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]">
            {step.ctaLabel} <ArrowRight size={12} />
          </span>
        )}
      </div>
      {!step.complete && step.href && step.id !== "run-once" && (
        <ArrowRight size={14} className="mt-1 shrink-0 text-[color:var(--con-faint)]" />
      )}
    </div>
  );

  // Run-once step: chrome owns the single Run once control (no second button in this card).
  // Other incomplete steps deep-link to the fix destination.
  if (!step.complete && step.href && step.id !== "run-once") {
    return (
      <Link href={step.href} className="block hover:opacity-90">
        {body}
      </Link>
    );
  }
  return <div>{body}</div>;
}

export function ReadinessChecklistHero({
  snapshot,
  /** When ready, hide entirely instead of collapsed "You're set". Default: show collapsed. */
  hideWhenReady = false
}: {
  snapshot: DashboardSnapshot;
  hideWhenReady?: boolean;
}) {
  const checklist = deriveReadinessChecklist(snapshot);
  const [dismissedReady, setDismissedReady] = useState(false);

  if (checklist.ready) {
    if (hideWhenReady || dismissedReady) return null;
    return (
      <Card
        collapsible
        defaultOpen={false}
        title={
          <span className="flex items-center gap-1.5">
            <Check size={13} style={{ color: "var(--con-pos)" }} /> You&apos;re set
          </span>
        }
        action={
          <button
            type="button"
            className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)] hover:text-[color:var(--con-muted)]"
            onClick={() => setDismissedReady(true)}
          >
            Dismiss
          </button>
        }
      >
        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          Broker, account, universe, LLM, and a first run are in place. Open{" "}
          <Link href="/console/approvals" className="font-semibold text-[color:var(--con-accent)]">
            Proposals
          </Link>{" "}
          anytime, or keep refining Strategy and Guardrails.
        </p>
      </Card>
    );
  }

  const nextIncomplete = checklist.steps.find((s) => !s.complete);

  return (
    // data-intro-shield: the splash canvas (intro-canvas.tsx) clips this rect out of
    // its draw region once its backdrop dissolves, so flying candles pass behind the
    // checklist instead of drawing through its text (visible around ~800px widths).
    <div data-intro-shield>
      <Card
        title={
          <span className="flex items-center gap-1.5">
            <ListChecks size={13} /> Get ready to trade
            <span className="font-normal text-[color:var(--con-muted)]">
              · {checklist.completedCount}/{checklist.totalCount}
            </span>
          </span>
        }
      >
        <p className="mb-3 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          Finish these steps so the strategy can scan, propose, and place through your broker. Each
          row goes straight to the fix. When you&apos;re ready for a cycle, use{" "}
          <strong className="font-semibold text-[color:var(--con-fg)]">Run Once</strong> in the top
          bar.
        </p>
        <div className="flex flex-col gap-2">
          {checklist.steps.map((step) => (
            <StepRow key={step.id} step={step} isNext={nextIncomplete?.id === step.id} />
          ))}
        </div>
      </Card>
    </div>
  );
}
