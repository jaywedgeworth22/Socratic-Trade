"use client";
import { Table, Th, Td } from "../ui/primitives";

/** Admin learning-mutation ledger (GET/POST /api/admin/learning-ledger). */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Ago, Btn, Card, Chip , Table, Th, Td} from "../ui/primitives";
import { SENTENCE_GAP } from "../lib/format";
import {
  FACTOR_LABELS,
  fetchLearningLedger,
  formatWeight,
  OperatorDiagnosticError,
  revertLearningLedgerEntry,
  weightCompareRows,
  type LearningLedgerEntry
} from "../lib/operator-diagnostics";
import type { ScoringWeights } from "@/lib/types";

export function LearningLedgerPanel() {
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<LearningLedgerEntry[]>([]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await fetchLearningLedger({ limit: 50 });
      setEntries(data.entries);
    } catch (err) {
      setEntries([]);
      setError(err instanceof OperatorDiagnosticError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revert = async (entryId: string) => {
    setBusyId(entryId);
    setError(null);
    try {
      await revertLearningLedgerEntry(entryId);
      setConfirmId(null);
      await load();
    } catch (err) {
      setError(err instanceof OperatorDiagnosticError ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card
      title="Learning Ledger"
      action={
        <Btn variant="ghost" size="sm" disabled={loading || busyId !== null} onClick={() => void load()}>
          Refresh
        </Btn>
      }
    >
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Every autonomous scoring-weight mutation, with the before/after vectors and a one-click
        revert.{SENTENCE_GAP}Revert restores prior weights only.
      </p>
      {error && (
        <div className="mb-3 flex items-start gap-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {loading ? (
        <div className="py-6 text-center text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          Loading ledger...
        </div>
      ) : entries.length === 0 && !error ? (
        <div className="py-6 text-center text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          No learning mutations recorded yet.
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <LedgerRow
              key={entry.id}
              entry={entry}
              confirm={confirmId === entry.id}
              busy={busyId === entry.id}
              onAskRevert={() => setConfirmId(entry.id)}
              onCancel={() => setConfirmId(null)}
              onConfirm={() => void revert(entry.id)}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function LedgerRow({
  entry,
  confirm,
  busy,
  onAskRevert,
  onCancel,
  onConfirm
}: {
  entry: LearningLedgerEntry;
  confirm: boolean;
  busy: boolean;
  onAskRevert: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const rows = weightCompareRows(asWeights(entry.beforeState), asWeights(entry.afterState));
  const reverted = Boolean(entry.revertedAt);

  return (
    <div className="rounded-control border border-[color:var(--con-line)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{entry.subsystem.replaceAll("_", " ")}</span>
          {entry.trigger && <Chip tone="muted">{entry.trigger.replaceAll("_", " ")}</Chip>}
          {entry.flag && <Chip tone="accent">{entry.flag}</Chip>}
          {reverted ? <Chip tone="warn">reverted</Chip> : <Chip tone="pos">active</Chip>}
        </div>
        <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          <Ago iso={entry.createdAt} />
        </span>
      </div>
      <div className="mt-2 overflow-x-auto">
        <Table caption="Data table" className="w-full text-left text-[length:var(--con-fs-xs)]">
          <thead className="text-[color:var(--con-faint)]">
            <tr>
              <Th className="py-1 font-medium">Factor</Th>
              <Th className="py-1 font-medium">Before</Th>
              <Th className="py-1 font-medium">After</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-[color:var(--con-line)]">
                <Td className="py-1">{FACTOR_LABELS[row.key]}</Td>
                <Td className="con-num py-1">{formatWeight(row.before)}</Td>
                <Td className="con-num py-1">{formatWeight(row.after)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
      {entry.revertedAt && (
        <div className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Reverted <Ago iso={entry.revertedAt} />
          {entry.revertedBy ? ` by ${entry.revertedBy}` : ""}.
        </div>
      )}
      {!reverted && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {confirm ? (
            <>
              <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                Restore the prior weights for this mutation?
              </span>
              <Btn variant="danger" size="sm" disabled={busy} onClick={onConfirm}>
                {busy ? "Reverting..." : "Confirm Revert"}
              </Btn>
              <Btn variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
                Cancel
              </Btn>
            </>
          ) : (
            <Btn variant="outline" size="sm" onClick={onAskRevert}>
              Revert Mutation
            </Btn>
          )}
        </div>
      )}
    </div>
  );
}

function asWeights(value: unknown): Partial<ScoringWeights> | null {
  if (!value || typeof value !== "object") return null;
  return value as Partial<ScoringWeights>;
}
