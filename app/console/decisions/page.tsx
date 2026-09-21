"use client";

/** All-decisions index — the landing page for the console Home "All Decisions"
 *  link (this route 404'd before; issue #2556). A simple reverse-chron list of
 *  recent Socratic decision cases (symbol, side, thesis tag, status, age), each
 *  row linking into its full trace at /console/decisions/[id]. Data comes from
 *  the same API the trace page uses (/api/socratic/decisions, already
 *  reverse-chron by created_at); this page owns its own loading/error state
 *  like the [id] page does. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Brain } from "lucide-react";
import type { SocraticDecisionCase } from "@/lib/types";
import { CONSOLE_PAGE_WIDTH } from "../lib/page-width";
import { useConsoleDataOptional } from "../lib/useConsoleData";
import { Card } from "../ui/primitives";
import { DecisionsList } from "./decisions-list";

export const metadata = { title: "Decisions" };

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; decisions: SocraticDecisionCase[] };

export default function DecisionsIndexPage() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // Optional (non-throwing): this page is always mounted inside ConsoleShell's
  // ConsoleDataProvider in production, so the real snapshot is available there — the Optional
  // variant only matters for the route smoke test, which renders this page bare. Used purely to
  // label WHICH account each decision belongs to (per-account-visibility, pages-04); the
  // decisions themselves still come from their own fetch below, unfiltered by account, matching
  // the console's other "every account, honestly labeled" surfaces (Activity's "Account: ..." rows).
  const consoleData = useConsoleDataOptional();
  const connectedAccounts = consoleData?.snapshot?.connectedAccounts;
  const accountLabelById = useMemo(
    () => Object.fromEntries((connectedAccounts ?? []).map((account) => [account.id, account.label || account.broker])),
    [connectedAccounts]
  );

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/socratic/decisions?limit=100", { cache: "no-store" });
      if (!response.ok) throw new Error(await response.text());
      const decisions = (await response.json()) as SocraticDecisionCase[];
      setState({ status: "ready", decisions });
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : "Could not load decisions." });
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  return (
    <div className={`${CONSOLE_PAGE_WIDTH} flex flex-col gap-4`}>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-2 text-[length:var(--con-fs-lg)] font-bold">
          <Brain size={16} /> Decisions
        </h1>
        {state.status === "ready" && (
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            {state.decisions.length} recent decision {state.decisions.length === 1 ? "case" : "cases"}, newest first
          </span>
        )}
      </div>

      {state.status === "loading" && (
        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">Loading decisions…</p>
      )}

      {state.status === "error" && (
        <Card>
          <p className="text-[color:var(--con-warn)]">{state.message}</p>
        </Card>
      )}

      {state.status === "ready" && <DecisionsList decisions={state.decisions} accountLabelById={accountLabelById} />}
    </div>
  );
}

