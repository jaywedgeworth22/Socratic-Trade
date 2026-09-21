"use client";

/** Guardrails — the deterministic cage: essentials first (max order, daily
 *  caps, daily-loss breaker, autonomy, schedule, short selling), then EVERY
 *  protective stop rule together under the stop-flow diagram (distance
 *  fallback chain, trailing overlay, broker-held → app-monitor enforcement),
 *  then Tax treatment (moved here from Strategy in the 2026-07-16 IA
 *  restructure — self-contained, own auto-save), then the advanced rulebook
 *  grouped the way the domain groups it. Editing uses a review-and-commit
 *  model with asymmetric friction: tightening is one click, loosening
 *  brokerage-account authority requires typing CONFIRM. Autonomy has its own
 *  ritual: Autopilot costs a typed word, going back to Ask-first is one tap. */

import { GUARDRAILS_HEADER_SUFFIX } from "@/lib/guardrail-copy";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { formatIndexUniverseList, toggleIncludedIndex } from "@/lib/index-universes";
import { getBrokerMarketHours } from "@/lib/market-hours";
import type { OrderType, TaxationType, TradingPolicy } from "@/lib/types";
import { mergeAccountCapabilities } from "@/lib/venue-contract-pure";
import type { DashboardSnapshot } from "../../dashboard-types";
import { savePolicy, ConsoleApiError, type PolicyPatchBody } from "../lib/api";
import {
  activeConnectedAccount,
  deriveReality,
  deriveRiskUtilization,
  deriveStateInfo,
  deriveUnmanagedShorts,
  unmanagedShortNotice,
  type UtilizationMeter
} from "../lib/derive";
import { fmtExact, fmtMoney, fmtMoneyWhole, fmtNum, fmtPct, timeUntil } from "../lib/format";
import { isBlank } from "../lib/policy-diff";
import { CONSOLE_PAGE_WIDTH } from "../lib/page-width";
import { useConsoleData } from "../lib/useConsoleData";
import { useToast } from "../ui/toast";
import { Btn, Card, Chip, Dash, Field, Meter, Select, TextInput } from "../ui/primitives";
import { deriveRunBlock, RunStateButton, TypedConfirm } from "../components/chrome";
import { orderTypeLabel } from "../orders/lib";
import {
  AdvancedGroup,
  PolicyDualModeRow,
  PolicyFieldRow,
  PolicySaveBar,
  usePolicyDraft
} from "../components/policy-form";
import { TaxSettingsCard } from "../strategy/tax-settings";
import {
  ALL_DEFS,
  ENTRY_QUALITY,
  ESSENTIALS,
  EXPOSURE,
  HYGIENE,
  INDICES,
  ORDER_TYPES,
  PANIC_BRAKE,
  PROTECTIVE_STOPS,
  SOCRATIC_OVERRIDE,
  OPTIONS,
  SHORTS,
  TAX_RULES,
  TRIGGERS,
  UNIVERSE_FLOOR,
  VOL_TARGETING
} from "./field-defs";
import { StopFlowDiagram } from "./stop-flow";
import {

  buildUniverseExtraPatch,
  discardAllDrafts,
  emptyUniverseDraft,
  type UniverseDraft
} from "./universe-draft";

export const metadata = { title: "Guardrails" };


function isIraTaxation(taxationType: TaxationType | undefined): boolean {
  return taxationType === "roth_ira" || taxationType === "traditional_ira";
}

/** "market" → "Market", "stop_market" → "Stop-market". orderTypeLabel (../orders/lib)
 *  already does the underscore→hyphen swap; this only capitalizes the leading letter,
 *  matching the decided plain-English order-type vocabulary. */
function orderTypeChoiceLabel(type: string): string {
  const label = orderTypeLabel(type);
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : label;
}

function orderTypeChoiceTitle(type: OrderType): string {
  const label = orderTypeChoiceLabel(type);
  if (type === "market") return "Allow market orders when immediacy is more important than a limit price.";
  if (type === "limit") return "Allow limit orders that cap the acceptable fill price.";
  if (type === "stop_market") return "Allow stop-market orders for protective exits and stop-triggered trades.";
  if (type === "stop_limit") return "Allow stop-limit orders that require both a stop trigger and a limit price.";
  return `Allow ${label} orders when the broker supports them.`;
}

/** Exposure utilization derive.ts doesn't already expose (deriveRiskUtilization only covers
 *  daily notional/orders/invested capital) — computed locally from the same snapshot fields,
 *  mirroring the CURRENT-state formulas the policy engine uses for its own projected checks
 *  (src/lib/policy.ts): gross = Σ|marketValue|, net = Σ marketValue, short = Σ|marketValue|
 *  where quantity < 0, symbol = the single largest |marketValue| among held positions. Missing
 *  equity data renders the band undefined (row shows "—"), never a fabricated 0 — a real empty
 *  portfolio still yields real 0% bands once equity is known. */
function deriveExposureUtilization(snapshot: DashboardSnapshot, policy: TradingPolicy) {
  const positions = snapshot.positions ?? [];
  const equity = snapshot.portfolio?.totalMarketValue;
  const hasEquity = typeof equity === "number" && equity > 0;
  const pctBand = (used: number, limit: number | undefined): UtilizationMeter => ({
    used,
    limit,
    pct: typeof limit === "number" && limit > 0 ? (used / limit) * 100 : undefined
  });

  const largest = positions.reduce<{ symbol: string; value: number } | undefined>((max, p) => {
    const value = Math.abs(p.marketValue);
    return !max || value > max.value ? { symbol: p.symbol, value } : max;
  }, undefined);

  const gross = positions.reduce((sum, p) => sum + Math.abs(p.marketValue), 0);
  const net = positions.reduce((sum, p) => sum + p.marketValue, 0);
  const short = positions.reduce((sum, p) => (p.quantity < 0 ? sum + Math.abs(p.marketValue) : sum), 0);

  return {
    symbolNotional: largest ? { ...pctBand(largest.value, policy.maxSymbolExposureNotional), symbol: largest.symbol } : undefined,
    symbolPct: largest && hasEquity ? { ...pctBand((largest.value / equity!) * 100, policy.maxSymbolExposurePct), symbol: largest.symbol } : undefined,
    grossPct: hasEquity ? pctBand((gross / equity!) * 100, policy.maxGrossExposurePct) : undefined,
    netPct: hasEquity ? pctBand((Math.abs(net) / equity!) * 100, policy.maxNetExposurePct) : undefined,
    shortPct: hasEquity ? pctBand((short / equity!) * 100, policy.maxShortExposurePct) : undefined
  };
}

/** Inline utilization sub-label for a numeric cap row: "used X of Y · pct%" plus a Meter,
 *  matching the Risk utilization card pattern on the dashboard (page.tsx RiskUtilizationCard).
 *  `band` undefined means no current-usage data applies to this cap — renders "—", never a
 *  fabricated 0 (see format.ts convention). */
function CapUtilization({
  band,
  kind,
  note,
  daily,
  label
}: {
  band: (UtilizationMeter & { symbol?: string }) | undefined;
  kind: "money" | "pct" | "count";
  note?: string;
  /** True for caps that reset every day (daily notional/orders) — the sub-label reads
   *  "Used $1,200 of $5,000 today" instead of the point-in-time "Current usage" wording
   *  used for exposure caps, which have no daily reset. */
  daily?: boolean;
  label?: string;
}) {
  const fmtUsed = (v: number) => (kind === "money" ? fmtMoney(v) : kind === "pct" ? fmtPct(v, 1) : fmtNum(v));
  const fmtLimit = (v: number) => (kind === "money" ? fmtMoneyWhole(v) : kind === "pct" ? fmtPct(v, 1) : fmtNum(v));
  const title = band?.symbol ? `Largest position: ${band.symbol}${note ? ` — ${note}` : ""}` : note;

  if (!band) {
    return (
      <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]" title={title}>
        Current usage: <Dash />
      </p>
    );
  }
  // Unclamped: values over the cap must pass through as >100 so Meter's own breach
  // state (hatched fill + "+X% over" tooltip) can surface instead of a solid full bar.
  const ratio = band.pct ?? 0;
  return (
    <div className="mt-1" title={title}>
      <div className="flex items-center justify-between gap-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        <span>{daily ? "Used" : "Current usage"}</span>
        <span className="con-num">
          {fmtUsed(band.used)} of {typeof band.limit === "number" ? fmtLimit(band.limit) : "no cap"}
          {daily ? " today" : ""}
          {band.pct !== undefined ? ` · ${fmtPct(band.pct, 1)}` : ""}
        </span>
      </div>
      <Meter value={ratio} max={100} label={label ?? (daily ? "Used today" : "Current usage")} />
    </div>
  );
}

const DEF_BY_PATH = new Map(ALL_DEFS.map((def) => [def.path, def]));
const ESSENTIAL_FIELD_PATHS = new Set([
  "maxOrderNotional",
  "maxOrderPctOfNav",
  "maxDailyNotional",
  "maxDailyPctOfNav"
]);
// Splits the tail of ESSENTIALS (§field-defs) into its own "Schedule" sub-heading —
// purely visual regrouping, no field-def or behavior changes (see PR notes 2026-07-16).
const SCHEDULE_FIELD_PATHS = new Set(["runCadenceMinutes", "runDuringExtendedHours", "permitExtendedHours"]);
const EXPOSURE_FIELD_PATHS = new Set(["maxSymbolExposureNotional", "maxSymbolExposurePct"]);

export default function GuardrailsPage() {
  const { snapshot } = useConsoleData();
  if (!snapshot) return null;
  return <AccountScopedGuardrailsPage key={snapshot.policy.connectedAccountId ?? "no-account"} />;
}

function AccountScopedGuardrailsPage() {
  const { snapshot } = useConsoleData();
  const draft = usePolicyDraft();
  const [universeDraft, setUniverseDraft] = useState<UniverseDraft>(emptyUniverseDraft);

  const reality = useMemo(() => (snapshot ? deriveReality(snapshot) : null), [snapshot]);
  if (!snapshot || !reality) return null;
  const policy = snapshot.policy;
  const risk = deriveRiskUtilization(snapshot);
  const exposure = deriveExposureUtilization(snapshot, policy);
  // Same advisory copy as the Home positions card (shared helper — never drifts).
  const unmanaged = deriveUnmanagedShorts(snapshot.positions, policy);
  const unmanagedShorts = unmanagedShortNotice(unmanaged.count, unmanaged.reason ?? undefined);

  // Universe / arrays are replace-whole-value fields → extraPatch.
  const extraPatch: PolicyPatchBody = buildUniverseExtraPatch(universeDraft, policy);
  const discardAll = () => discardAllDrafts(() => draft.clear(), setUniverseDraft);

  const indices = universeDraft.includedIndices ?? policy.includedIndices;
  const orderTypes = universeDraft.permittedOrderTypes ?? policy.permittedOrderTypes;
  const taxationType = activeConnectedAccount(snapshot)?.taxationType ?? policy.taxSettings?.taxationType ?? "taxable";
  const isIra = isIraTaxation(taxationType);
  const taxRuleDefs = TAX_RULES.filter((def) => {
    if (isIra) {
      return def.path === "taxSettings.iraWashSaleHandling" || def.path === "taxSettings.washSaleMinLossUsd";
    }
    return def.path !== "taxSettings.iraWashSaleHandling";
  });
  
  const account = activeConnectedAccount(snapshot);
  const broker = account?.broker ?? policy.activeBroker;
  const caps = mergeAccountCapabilities(broker, account?.capabilities);

  return (
    <div className={`${CONSOLE_PAGE_WIDTH} flex flex-col gap-4`}>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">Guardrails</h1>
        <Chip tone={reality.tone}>
          {reality.word} · {reality.phrase}
        </Chip>
        <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          for {reality.account?.label ?? "no connected account"} — {GUARDRAILS_HEADER_SUFFIX}
        </span>
      </div>

      {/* Wave B: single Autonomy surface — deep-link #autonomy or ?focus=autonomy */}
      <div id="autonomy" className="scroll-mt-28">
        <AutonomyCard />
      </div>

      <Card title="Essentials" collapsible defaultOpen>
        <div className="divide-y divide-[color:var(--con-line)]">
          <div>
            <PolicyDualModeRow
              label="Max Per Order"
              moneyDef={DEF_BY_PATH.get("maxOrderNotional")!}
              pctDef={DEF_BY_PATH.get("maxOrderPctOfNav")!}
              policy={policy}
              draft={draft}
              hint="Choose one expression for the per-order opening cap. Switching modes clears the other value before save."
            />
            <CapUtilization
              band={undefined}
              kind="money"
              note="Per-order caps apply to each order individually — no cumulative usage is tracked against this limit."
            />
          </div>
          <div>
            <PolicyDualModeRow
              label="Max Spend Per Day"
              moneyDef={DEF_BY_PATH.get("maxDailyNotional")!}
              pctDef={DEF_BY_PATH.get("maxDailyPctOfNav")!}
              policy={policy}
              draft={draft}
              hint="Choose one daily opening budget. Percent is the account-relative default; switching modes clears the other value before save."
            />
            <CapUtilization band={risk.dailyNotional} kind="money" daily label="Max Spend Per Day" />
          </div>
          {ESSENTIALS.filter((def) => !ESSENTIAL_FIELD_PATHS.has(def.path) && !SCHEDULE_FIELD_PATHS.has(def.path)).map((def) => (
            <div key={def.path}>
              <PolicyFieldRow def={def} policy={policy} draft={draft} />
              {def.path === "maxDailyOrders" && <CapUtilization band={risk.dailyOrders} kind="count" daily label="Max Daily Orders" />}
            </div>
          ))}
          <div className="con-card-title pt-3">Schedule</div>
          {ESSENTIALS.filter((def) => SCHEDULE_FIELD_PATHS.has(def.path)).map((def) => {
            const broker = activeConnectedAccount(snapshot)?.broker ?? policy.activeBroker;
            const brokerHours = getBrokerMarketHours(broker);
            const hint =
              def.path === "permitExtendedHours"
                ? `Permits the agent to place orders configured to fill outside regular market hours (${brokerHours.orderHoursHint}).`
                : def.path === "runDuringExtendedHours"
                  ? `Allows the system to run scheduled or event-triggered strategy scans during extended hours (${brokerHours.scanHoursHint}).`
                  : undefined;
            return (
              <div key={def.path}>
                <PolicyFieldRow def={def} policy={policy} draft={draft} hint={hint} />
              </div>
            );
          })}
          {broker !== "kalshi" && (
            <>
              <div className="con-card-title pt-3 flex items-center justify-between">
                <span>Short selling</span>
                {caps.shortSelling ? (
                  <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-pos)]">Fully Supported</span>
                ) : (
                  <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">Disabled by Broker</span>
                )}
              </div>
              {caps.shortSelling && (
                <>
                  {unmanagedShorts && (
                    <p className="py-2 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-warn)]">
                      {unmanagedShorts}
                    </p>
                  )}
                  {SHORTS.map((def) => (
                    <div key={def.path}>
                      <PolicyFieldRow def={def} policy={policy} draft={draft} />
                      {def.path === "maxShortExposurePct" && <CapUtilization band={exposure.shortPct} kind="pct" label="Max Short Exposure" />}
                    </div>
                  ))}
                </>
              )}

              <div className="con-card-title pt-3 flex items-center justify-between">
                <span>Options trading</span>
                {caps.optionsTrading ? (
                  <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-pos)]">Fully Supported</span>
                ) : (
                  <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">Disabled by Broker</span>
                )}
              </div>
              {caps.optionsTrading && OPTIONS.map((def) => {
                if (def.path !== "optionsTradingEnabled") return null;
                return (
                  <div key={def.path}>
                    <PolicyFieldRow def={def} policy={policy} draft={draft} />
                  </div>
                );
              })}

              <div className="con-card-title pt-3 flex items-center justify-between">
                <span>Macro Data</span>
              </div>
              {OPTIONS.map((def) => {
                if (def.path !== "kalshiMacroEnabled") return null;
                return (
                  <div key={def.path}>
                    <PolicyFieldRow def={def} policy={policy} draft={draft} />
                  </div>
                );
              })}
            </>
          )}
          {broker === "kalshi" && (
            <>
              <div className="con-card-title pt-3">Event Contracts Trading</div>
              <p className="mb-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                Fully Supported. This is a Kalshi event-contract account.
              </p>
              {OPTIONS.map((def) => {
                if (def.path !== "eventContractsEnabled" && def.path !== "kalshiMacroEnabled") return null;
                return (
                  <div key={def.path}>
                    <PolicyFieldRow def={def} policy={policy} draft={draft} />
                  </div>
                );
              })}
            </>
          )}
        </div>
      </Card>

      {broker !== "kalshi" && (
        <Card title="Protective stops" collapsible defaultOpen>
          <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            Every rule that exits a losing (or protects a winning) position, in one place. The diagram shows how they
            compose for this account right now: each lane falls back left → right, trailing runs alongside, and the app
            monitor backstops whatever the broker can&apos;t hold.
          </p>
          <StopFlowDiagram policy={policy} />
          <div className="mt-3 divide-y divide-[color:var(--con-line)]">
            {PROTECTIVE_STOPS.map((def) => {
              const brokerHours = getBrokerMarketHours(broker);
              const hint =
                def.path === "allowExtendedHoursSyntheticStops"
                  ? `Continues monitoring and executing synthetic stop-losses during extended hours (${brokerHours.syntheticStopHoursHint}).`
                  : undefined;
              return (
                <PolicyFieldRow key={def.path} def={def} policy={policy} draft={draft} hint={hint} />
              );
            })}
          </div>
        </Card>
      )}

      {/* Tax treatment — account-scoped like the rest of this page; moved here from
          Strategy in the 2026-07-16 IA restructure, directly above the Advanced
          rulebook's Tax rules group that references it. Self-contained (own
          auto-save) — not wired into the PolicySaveBar draft machinery below.
          The id anchor is a deep-link target. */}
      <div id="tax" className="scroll-mt-28">
        <TaxSettingsCard />
      </div>

      <Card title="Advanced rulebook" padded={false} collapsible defaultOpen={false}>
        <div className="px-4 pb-2">
          <p className="pt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            Everything below ships with safe defaults — you never have to touch it. One rule everywhere: a cap that
            demanded an exit can never block that exit.
          </p>
          <AdvancedGroup title="Exposure caps">
            <div>
              <PolicyDualModeRow
                label="Max In One Stock"
                moneyDef={DEF_BY_PATH.get("maxSymbolExposureNotional")!}
                pctDef={DEF_BY_PATH.get("maxSymbolExposurePct")!}
                policy={policy}
                draft={draft}
                hint="Choose whether the single-symbol exposure cap is a dollar ceiling or a share of portfolio value."
              />
              <CapUtilization
                band={isBlank(policy.maxSymbolExposurePct) ? exposure.symbolNotional : exposure.symbolPct}
                kind={isBlank(policy.maxSymbolExposurePct) ? "money" : "pct"}
                label="Max In One Stock"
              />
            </div>
            {EXPOSURE.filter((def) => !EXPOSURE_FIELD_PATHS.has(def.path)).map((def) => (
              <div key={def.path}>
                <PolicyFieldRow def={def} policy={policy} draft={draft} />
                {def.path === "maxGrossExposurePct" && <CapUtilization band={exposure.grossPct} kind="pct" label="Max Gross Exposure" />}
                {def.path === "maxNetExposurePct" && <CapUtilization band={exposure.netPct} kind="pct" label="Max Net Exposure" />}
              </div>
            ))}
          </AdvancedGroup>
          <AdvancedGroup title="Socratic override">
            {SOCRATIC_OVERRIDE.map((def) => (
              <PolicyFieldRow key={def.path} def={def} policy={policy} draft={draft} />
            ))}
          </AdvancedGroup>
          <AdvancedGroup title="Entry quality gates">
            {ENTRY_QUALITY.map((def) => (
              <PolicyFieldRow key={def.path} def={def} policy={policy} draft={draft} />
            ))}
          </AdvancedGroup>
          <AdvancedGroup title="Volatility targeting & risk receipts">
            {VOL_TARGETING.map((def) => (
              <PolicyFieldRow key={def.path} def={def} policy={policy} draft={draft} />
            ))}
          </AdvancedGroup>
          <AdvancedGroup title="Volatility panic brake">
            {PANIC_BRAKE.map((def) => (
              <PolicyFieldRow key={def.path} def={def} policy={policy} draft={draft} />
            ))}
          </AdvancedGroup>
          <AdvancedGroup title="Proposal hygiene & pace">
            {HYGIENE.map((def) => (
              <PolicyFieldRow key={def.path} def={def} policy={policy} draft={draft} />
            ))}
          </AdvancedGroup>
          <AdvancedGroup title="Event triggers">
            {TRIGGERS.map((def) => (
              <PolicyFieldRow key={def.path} def={def} policy={policy} draft={draft} />
            ))}
          </AdvancedGroup>
          <AdvancedGroup title="Tax rules">
            <p className="pt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              The wash-sale guard itself (on/off, account type, rates) lives in the Tax treatment card above. These
              rules tune what a rebuy lockout means for this account and how strict it is.
            </p>
            <div className="mt-2 rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
              {isIra ? (
                <>
                  <strong className="text-[color:var(--con-fg)]">IRA mode:</strong> same-account wash sales are not a
                  decision gate here because an IRA has no taxable loss deduction to preserve. The relevant choice is
                  whether this IRA should block or ignore a replacement buy after a taxable account sold the same symbol
                  at a loss.
                </>
              ) : (
                <>
                  <strong className="text-[color:var(--con-fg)]">Taxable mode:</strong> Block / Ask / Auto controls
                  what happens when this taxable account wants to rebuy a locked symbol. IRA replacement buys use their
                  own IRA account setting instead.
                </>
              )}
            </div>
            {taxRuleDefs.map((def) => (
              <PolicyFieldRow key={def.path} def={def} policy={policy} draft={draft} />
            ))}
          </AdvancedGroup>
          <AdvancedGroup title="Universe">
            <div className="py-2">
              <div className="con-label">Indices</div>
              <p className="mb-1.5 text-[length:var(--con-fs-sm)] text-[color:var(--con-fg)]">
                {formatIndexUniverseList(indices)}
              </p>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                {INDICES.map((idx) => {
                  const on = indices.includes(idx.id);
                  const title = `Include ${idx.label} in the base scan universe. Overlapping S&P and Nasdaq families replace each other.`;
                  return (
                    <label key={idx.id} title={title} className="flex cursor-pointer items-center gap-2 text-[length:var(--con-fs-sm)]">
                      <input
                        type="checkbox"
                        title={title}
                        checked={on}
                        onChange={(e) => {
                          const checked = e.currentTarget.checked;
                          setUniverseDraft((d) => {
                            const current = d.includedIndices ?? policy.includedIndices;
                            return {
                              ...d,
                              includedIndices: toggleIncludedIndex(current, idx.id, checked)
                            };
                          });
                        }}
                      />
                      {idx.label}
                    </label>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                Overlapping families replace each other: S&amp;P 100 / S&amp;P 500 and Nasdaq 100 / Nasdaq Composite.
              </p>
            </div>
            <div className="grid gap-3 py-2 sm:grid-cols-2">
              <Field label="Always include (symbols)" hint="Comma or space separated. Exempt from the universe floor." htmlFor="add-syms">
                <TextInput
                  id="add-syms"
                  title="Comma or space separated tickers that stay in the scan universe even if they miss the normal universe floor."
                  value={universeDraft.additionalSymbols ?? (policy.additionalSymbols ?? []).join(", ")}
                  onChange={(e) => setUniverseDraft((d) => ({ ...d, additionalSymbols: e.target.value }))}
                />
              </Field>
              <Field label="Never touch (blocklist)" hint="Blocking a stock never blocks selling it — exits are always allowed." htmlFor="block-syms">
                <TextInput
                  id="block-syms"
                  title="Comma or space separated tickers the strategy must not open. Exits are still allowed."
                  value={universeDraft.blocklist ?? (policy.blocklist ?? []).join(", ")}
                  onChange={(e) => setUniverseDraft((d) => ({ ...d, blocklist: e.target.value }))}
                />
              </Field>
            </div>
            {UNIVERSE_FLOOR.map((def) => (
              <PolicyFieldRow key={def.path} def={def} policy={policy} draft={draft} />
            ))}
            <div className="py-2">
              <div className="con-label">Permitted order types</div>
              <div className="flex flex-wrap gap-3">
                {ORDER_TYPES.map((t) => {
                  const on = orderTypes.includes(t);
                  const title = orderTypeChoiceTitle(t);
                  return (
                    <label key={t} title={title} className="flex cursor-pointer items-center gap-2 text-[length:var(--con-fs-sm)]">
                      <input
                        type="checkbox"
                        title={title}
                        checked={on}
                        onChange={() =>
                          setUniverseDraft((d) => ({
                            ...d,
                            permittedOrderTypes: on ? orderTypes.filter((x) => x !== t) : [...orderTypes, t]
                          }))
                        }
                      />
                      {orderTypeChoiceLabel(t)}
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="max-w-xs py-2">
              <Field
                label="Sell to Fund Buys"
                hint="How to raise cash when intended buys exceed buying power. Off = Never."
                htmlFor="stf"
              >
                <Select
                  id="stf"
                  title="Choose how the strategy should raise cash when intended buys exceed buying power. Off means never sell just to fund buys."
                  value={universeDraft.sellToFundBuy ?? policy.sellToFundBuy ?? "off"}
                  onChange={(e) => setUniverseDraft((d) => ({ ...d, sellToFundBuy: e.target.value }))}
                >
                  <option value="off">Off — Never Sell to Fund</option>
                  <option value="suggest">Suggest Only (No Orders)</option>
                  <option value="propose">Propose Sells for Approval</option>
                  <option value="automated">Automated — Sell to Fund</option>
                </Select>
              </Field>
            </div>
          </AdvancedGroup>
        </div>
      </Card>

      <PolicySaveBar
        policy={policy}
        draft={draft}
        defs={ALL_DEFS}
        reality={reality}
        extraPatch={Object.keys(extraPatch).length > 0 ? extraPatch : undefined}
        onDiscard={discardAll}
      />
    </div>
  );
}

/** Single Autonomy surface (Wave B): run state, authority, cadence, Run once /
 *  Start·Stop, and readiness — one place to answer “is the agent on and why not?”
 *  Authority still uses the asymmetric ritual (Ask-first one tap; Autopilot typed).
 *  Deep-link: /console/guardrails#autonomy or ?focus=autonomy. */
function AutonomyCard() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [arming, setArming] = useState(false);
  const [busy, setBusy] = useState(false);

  // Snapshot loads after first paint, so native hash scroll misses — mirror Settings.
  useEffect(() => {
    if (!snapshot || typeof window === "undefined") return;
    const hash = window.location.hash.slice(1);
    const focus = new URLSearchParams(window.location.search).get("focus");
    if (hash !== "autonomy" && focus !== "autonomy") return;
    const timer = setTimeout(() => {
      document.getElementById("autonomy")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
    return () => clearTimeout(timer);
  }, [snapshot]);

  if (!snapshot) return null;
  const reality = deriveReality(snapshot);
  const stateInfo = deriveStateInfo(snapshot.policy);
  const decide = snapshot.policy.strategyAuthority === "decide";
  const cadenceMin = snapshot.policy.runCadenceMinutes;
  const nextRun = snapshot.scheduler?.nextRunAt;
  const runBlock = deriveRunBlock(snapshot);

  const setAuthority = async (authority: "propose" | "decide") => {
    setBusy(true);
    try {
      await savePolicy({ strategyAuthority: authority }, snapshot.policy.connectedAccountId);
      await refresh();
      setArming(false);
      setTyped("");
      toast.push(
        authority === "decide" ? "warn" : "pos",
        authority === "decide" ? "Autopilot on" : "Back to Ask-first",
        authority === "decide"
          ? "The strategy may place orders itself; Socratic overrides can challenge owner-preference gates."
          : "Every trade now waits for your approval."
      );
    } catch (error) {
      toast.push("neg", "Authority not changed", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Autonomy">
      <p className="mb-3 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
        Is the agent on, on what cadence, and can you run it now?{" "}
        <strong className="font-semibold text-[color:var(--con-fg)]">Run Once</strong> and Start/Stop live in the top
        bar only (one control each — this panel explains state and blockers, it does not duplicate those buttons).
      </p>

      {/* Status grid: systemState · authority · cadence */}
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2">
          <div className="con-card-title">Run state</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Chip tone={stateInfo.tone === "warn" ? "warn" : stateInfo.tone === "neg" ? "neg" : stateInfo.tone === "muted" ? "muted" : "pos"} title={stateInfo.detail}>
              {stateInfo.label}
            </Chip>
          </div>
          <p className="mt-1.5 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-faint)]">{stateInfo.detail}</p>
        </div>
        <div className="rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2">
          <div className="con-card-title">Authority</div>
          <div className="mt-1 text-[length:var(--con-fs-md)] font-semibold">{decide ? "Autopilot" : "Ask-first"}</div>
          <p className="mt-1.5 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-faint)]">
            {decide
              ? "May place orders itself inside guardrails."
              : "Suggests and waits — every trade needs approval."}
          </p>
        </div>
        <div className="rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2">
          <div className="con-card-title">Cadence</div>
          <div className="mt-1 text-[length:var(--con-fs-md)] font-semibold">
            {typeof cadenceMin === "number" ? `Every ${cadenceMin} min` : "—"}
          </div>
          <p className="mt-1.5 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-faint)]">
            {snapshot.policy.systemState === "active" && nextRun ? (
              <span title={fmtExact(nextRun)}>Next scheduled run {timeUntil(nextRun)}</span>
            ) : snapshot.policy.systemState === "active" ? (
              "Running; next run time not in this snapshot."
            ) : (
              "Scheduled runs only while Running. Edit interval under Essentials → Schedule."
            )}
          </p>
        </div>
      </div>

      {/* Run once / Start / Stop stay in chrome only (owner: no stacked duplicate CTAs).
          This panel still shows Start/Stop for Autonomy deep-links where the question is
          “is the agent on?” — Run once is deliberately chrome-only. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <RunStateButton snapshot={snapshot} />
        <Link
          href="/console/guardrails#autonomy"
          className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)] underline-offset-2 hover:underline"
          title="Deep link to this Autonomy panel"
        >
          #autonomy
        </Link>
      </div>

      {/* Why can’t I run? — same preflight as chrome Run once */}
      {runBlock ? (
        <div className="mb-4 rounded-control border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone="warn">why can&apos;t I run?</Chip>
            <span className="text-[length:var(--con-fs-sm)] font-semibold">{runBlock.title}</span>
          </div>
          <p className="mt-1.5 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">{runBlock.detail}</p>
          {runBlock.note && (
            <p className="mt-1.5 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-faint)]">{runBlock.note}</p>
          )}
          {runBlock.fixHref && (
            <Link
              href={runBlock.fixHref}
              className="mt-2 inline-flex text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]"
            >
              {runBlock.fixLabel ?? "Go to the fix"}
            </Link>
          )}
        </div>
      ) : (
        <p className="mb-4 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Preflight looks clear for a manual Run Once (LLM key + account readiness). Scheduled autonomy still depends
          on run state above.
        </p>
      )}

      {/* Authority ritual (unchanged) */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--con-line)] pt-3">
        <div>
          <div className="text-[length:var(--con-fs-sm)] font-semibold">Placement authority</div>
          <p className="mt-0.5 max-w-xl text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
            {decide
              ? "The strategy may place orders itself. Socratic overrides can challenge owner-preference gates when the agent gives a structured thesis; broker, account, tax-hard, and integrity refusals still block. Provider failures and unavailable adversarial review still route to you."
              : "The strategy suggests and waits. Switch to Autopilot when this account should act without per-trade approval."}
          </p>
        </div>
        {decide ? (
          <Btn
            variant="pos"
            size="sm"
            disabled={busy}
            title="Switch this account back to Ask-first, so every trade waits for approval."
            onClick={() => void setAuthority("propose")}
          >
            {busy ? "Switching…" : "Switch to Ask-first"}
          </Btn>
        ) : (
          <Btn
            variant="outline"
            size="sm"
            title="Open the typed confirmation for Autopilot on this account."
            onClick={() => setArming((v) => !v)}
          >
            Turn on Autopilot…
          </Btn>
        )}
      </div>
      {!decide && arming && (
        <TypedConfirm
          phrase="AUTOPILOT"
          value={typed}
          onChange={setTyped}
          busy={busy}
          variant="primary"
          confirmLabel="Enable Autopilot"
          note={
            reality.tone === "live"
              ? "Autopilot lets Socratic Trade place orders in this brokerage account without per-trade approval, including approved Socratic overrides of owner-preference gates."
              : "Autopilot lets Socratic Trade place orders itself, including approved Socratic overrides of owner-preference gates."
          }
          onConfirm={() => void setAuthority("decide")}
        />
      )}
    </Card>
  );
}
