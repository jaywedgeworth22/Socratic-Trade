"use client";
import { Table, Th, Td } from "../ui/primitives";

/** Read-only preview of GET /api/admin/tuning-dry-run.  Does not apply weights. */

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Ago, Btn, Card, Chip , Table, Th, Td} from "../ui/primitives";
import { SENTENCE_GAP } from "../lib/format";
import {
  fetchTuningDryRun,
  formatIc,
  formatSigned,
  formatWeight,
  invariantViolationText,
  OperatorDiagnosticError,
  weightCompareRows,
  type TuningDryRunDecision,
  type TuningDryRunResponse
} from "../lib/operator-diagnostics";

export function TuningDryRunPanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TuningDryRunResponse | null>(null);

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await fetchTuningDryRun());
    } catch (err) {
      setResult(null);
      setError(err instanceof OperatorDiagnosticError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Weight Tuning Preview"
      action={
        <Btn variant="outline" size="sm" disabled={busy} onClick={() => void runPreview()}>
          {busy ? "Previewing..." : "Preview Auto-Tune"}
        </Btn>
      }
    >
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Runs the same autonomous weight-tuning gates a real auto-apply would, then shows what would
        change.{SENTENCE_GAP}Nothing is written.{SENTENCE_GAP}
        <Link href="/admin/backtest-ic" className="underline underline-offset-2">
          Open Factor Backtest
        </Link>{" "}
        for the information-coefficient diagnostic.
      </p>
      {error && (
        <div className="mb-3 flex items-start gap-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {result && <DryRunResult result={result} />}
    </Card>
  );
}

function DryRunResult({ result }: { result: TuningDryRunResponse }) {
  const decision = result.decision;
  const rows = weightCompareRows(decision.before, decision.after);
  const changed = new Set(decision.changedFactors ?? []);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={decision.wouldApply ? "pos" : "warn"}>
          {decision.wouldApply ? "would apply" : "would not apply"}
        </Chip>
        {decision.reason && (
          <span className="con-mono text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
            {decision.reason}
          </span>
        )}
        {decision.generatedBy && (
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            {decision.generatedBy}
          </span>
        )}
      </div>
      {result.note && (
        <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">{result.note}</p>
      )}
      {decision.invariantViolations && decision.invariantViolations.length > 0 && (
        <div className="rounded-control border border-[color:var(--con-neg-border)] bg-[color:var(--con-neg-soft)] px-3 py-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-neg)]">
          {decision.invariantViolations.map((violation, index) => (
            <div key={`${index}-${invariantViolationText(violation)}`}>{invariantViolationText(violation)}</div>
          ))}
        </div>
      )}
      {decision.cautions && decision.cautions.length > 0 && (
        <ul className="list-disc space-y-1 pl-4 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          {decision.cautions.map((caution) => (
            <li key={caution}>{caution}</li>
          ))}
        </ul>
      )}
      <OosReadout decision={decision} />
      <div className="overflow-x-auto">
        <Table caption="Data table" className="w-full text-left text-[length:var(--con-fs-xs)]">
          <thead className="text-[color:var(--con-faint)]">
            <tr>
              <Th className="py-1 font-medium">Factor</Th>
              <Th className="py-1 font-medium">Before</Th>
              <Th className="py-1 font-medium">After</Th>
              <Th className="py-1 font-medium">Delta</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-[color:var(--con-line)]">
                <Td className="py-1.5">
                  {row.label}
                  {changed.has(row.key) && (
                    <Chip tone="accent" className="ml-2">
                      changed
                    </Chip>
                  )}
                </Td>
                <Td className="con-num py-1.5">{formatWeight(row.before)}</Td>
                <Td className="con-num py-1.5">{formatWeight(row.after)}</Td>
                <Td className="con-num py-1.5">{formatSigned(row.delta)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </div>
  );
}

function OosReadout({ decision }: { decision: TuningDryRunDecision }) {
  const readout = decision.oosReadout;
  if (!readout && decision.oosICCandidate === undefined && decision.oosICBaseline === undefined) {
    return null;
  }
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <Readout label="Candidate IC" value={formatIc(decision.oosICCandidate)} />
      <Readout label="Baseline IC" value={formatIc(decision.oosICBaseline)} />
      <Readout label="IC Delta" value={formatSigned(readout?.icDelta, 3)} />
      <Readout label="ICIR" value={formatIc(readout?.icir)} />
      <Readout label="Test Dates" value={readout?.testDates === undefined ? "—" : String(readout.testDates)} />
      <Readout
        label="Paired t"
        value={readout?.pairedTStat === undefined ? "—" : formatIc(readout.pairedTStat)}
      />
      {readout?.evidenceCutoffDate && (
        <div className="sm:col-span-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Evidence cutoff <Ago iso={readout.evidenceCutoffDate} />
        </div>
      )}
      {readout?.partiallyInSampleCaveat && (
        <div className="sm:col-span-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">
          {readout.partiallyInSampleCaveat}
        </div>
      )}
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="con-tile">
      <div className="text-[color:var(--con-muted)]">{label}</div>
      <div className="con-num mt-0.5 font-semibold">{value}</div>
    </div>
  );
}
