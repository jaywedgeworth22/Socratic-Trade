"use client";

/** Positions table with a per-position protection column derived honestly
 *  from the snapshot (resting broker stop order, app-managed stop rule, or
 *  "—" when nothing protects). Money in tabular numerals; missing = "—". */

import { memo } from "react";
import Link from "next/link";
import type { DashboardSnapshot } from "../../dashboard-types";
import type { OptionPosition } from "@/lib/types";
import { deriveProtection, deriveUnmanagedShorts, grossExposure, grossExposureWeightPct, unmanagedShortNotice } from "../lib/derive";
import { fmtMoney, fmtPct, fmtQty, EM_DASH } from "../lib/format";
import { Card, Dash, Empty, SignedText , Table, Th, Td} from "../ui/primitives";
import { SymbolButton } from "../ui/symbol-drilldown";

/** Concentration cue for a position's weight vs. policy.maxSymbolExposurePct.
 *  Text-first (the label always names "over cap"), color only reinforces —
 *  a colorblind or screen-reader user still gets the same information. */
interface ExposureCue {
  tone?: "warn" | "neg";
  label?: string;
  title?: string;
}

function exposureCue(weightPct: number | undefined, capPct: number | undefined): ExposureCue {
  if (weightPct === undefined || !capPct || capPct <= 0 || weightPct <= capPct) return {};
  const ratio = weightPct / capPct;
  const grossly = ratio >= 1.5;
  return {
    tone: grossly ? "neg" : "warn",
    label: grossly ? "well over cap" : "over cap",
    title: `${fmtPct(weightPct, 1)} of account value exceeds the ${capPct}% max-single-symbol exposure cap (${ratio.toFixed(1)}x).`
  };
}

export const PositionsCard = memo(function PositionsCard({ snapshot }: { snapshot: DashboardSnapshot }) {
  const positions = snapshot.positions ?? [];
  const equity = snapshot.portfolio?.totalMarketValue;
  const exposureCap = snapshot.policy.maxSymbolExposurePct;
  // Advisory only (mirrors the per-row muted protection state): shorts the app's stop
  // monitors deliberately skip while short selling is off. Same copy as Guardrails.
  const unmanaged = deriveUnmanagedShorts(positions, snapshot.policy);
  const unmanagedShorts = unmanagedShortNotice(unmanaged.count, unmanaged.reason ?? undefined);

  // Computed once per position and shared by both the ≥lg table and the
  // <lg card list below, so the two layouts can never drift out of sync.
  // Weight is the UNSIGNED share of gross exposure (owner decision 2026-08-08):
  // a signed weight rendered "-0.0%"/"-1.8%" artifacts for shorts, whose
  // direction the SHORT tag already carries.
  const grossTotal = grossExposure(positions);
  const rows = positions.map((p) => {
    const short = p.quantity < 0;
    const costBasis = p.averageCost * p.quantity;
    const unrealized =
      Number.isFinite(p.marketValue) && Number.isFinite(costBasis) ? p.marketValue - costBasis : undefined;
    const unrealizedPct =
      unrealized !== undefined && costBasis !== 0 ? (unrealized / Math.abs(costBasis)) * 100 : undefined;
    const weightPct = grossExposureWeightPct(p.marketValue, grossTotal);
    // The over-cap cue keeps the policy cap's own basis — |value| as a share of ACCOUNT
    // value (maxSymbolExposurePct is defined against account value, not gross exposure);
    // its tooltip spells out that percentage.
    const equitySharePct =
      equity && equity !== 0 && Number.isFinite(p.marketValue) ? (Math.abs(p.marketValue) / Math.abs(equity)) * 100 : undefined;
    const protection = deriveProtection(p, snapshot.orders ?? [], snapshot.policy, snapshot.stopPlanBySymbol?.[p.symbol]);
    const meta = snapshot.symbolMetaBySymbol?.[p.symbol];
    const exposure = exposureCue(equitySharePct, exposureCap);
    return { p, short, unrealized, unrealizedPct, weightPct, protection, meta, exposure };
  });

  return (
    <>
      <Card title={`Positions (${positions.length})`} padded={false}>
        {unmanagedShorts && (
          <div className="border-b border-[color:var(--con-line)] px-4 py-2 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-warn)]">
            {unmanagedShorts}{" "}
            <Link href="/console/guardrails" className="font-semibold text-[color:var(--con-accent)]">
              Open Guardrails
            </Link>
          </div>
        )}
        {positions.length === 0 ? (
        <Empty>No open positions in this account.</Empty>
      ) : (
        <>
          <div className="hidden overflow-x-auto lg:block">
            <Table caption="Data table" className="con-table">
              <thead>
                <tr>
                  <Th title="Ticker — click a symbol to open its price history and details.">Symbol</Th>
                  <Th className="num" title="Shares held; negative means a short position.">Qty</Th>
                  <Th className="num" title="Average price paid per share.">Avg cost</Th>
                  <Th className="num" title="Current market value of the position.">Value</Th>
                  <Th className="num" title="Share of gross exposure (absolute): this position's |market value| as a percent of the sum of |market value| across all open positions.  Direction is carried by the SHORT tag, so shorts never show a negative weight.">Weight</Th>
                  <Th className="num" title="Market value minus cost basis — the gain or loss if you closed now.">Unrealized</Th>
                  <Th title="What protects this position: a resting broker stop order, an app-managed stop rule, or nothing (—).">Protection</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ p, short, unrealized, unrealizedPct, weightPct, protection, meta, exposure }) => (
                  <tr key={p.symbol}>
                    <Td>
                      <SymbolButton symbol={p.symbol} />
                      {short && (
                        <span className="ml-1.5 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-warn)]">SHORT</span>
                      )}
                      {meta?.companyName && (
                        <span className="block max-w-44 truncate pl-[26px] text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                          {meta.companyName}
                        </span>
                      )}
                    </Td>
                    <Td className="num con-num">{fmtQty(p.quantity)}</Td>
                    <Td className="num con-num">{fmtMoney(p.averageCost)}</Td>
                    <Td className="num con-num">{fmtMoney(p.marketValue)}</Td>
                    <Td className="num con-num" title={exposure.title}>
                      {weightPct === undefined ? (
                        <Dash />
                      ) : (
                        <span style={exposure.tone ? { color: exposure.tone === "neg" ? "var(--con-neg)" : "var(--con-warn)" } : undefined}>
                          {fmtPct(weightPct, 1, false)}
                          {exposure.label && (
                            <span className="ml-1 text-[length:var(--con-fs-xs)] font-semibold">({exposure.label})</span>
                          )}
                        </span>
                      )}
                    </Td>
                    <Td className="num">
                      {unrealized === undefined ? (
                        <Dash />
                      ) : (
                        <SignedText value={unrealized}>
                          {`${unrealized > 0 ? "+" : ""}${fmtMoney(unrealized)}`}
                          {unrealizedPct !== undefined ? ` (${fmtPct(unrealizedPct, 1, true)})` : ""}
                        </SignedText>
                      )}
                    </Td>
                    <Td title={protection.detail}>
                      {protection.label === null ? (
                        <span className="text-[color:var(--con-faint)]">{EM_DASH}</span>
                      ) : (
                        <span
                          className="text-[length:var(--con-fs-xs)] font-semibold"
                          style={{ color: protection.tone === "warn" ? "var(--con-warn)" : protection.tone === "pos" ? "var(--con-pos)" : "var(--con-muted)" }}
                        >
                          {protection.label}
                        </span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>

          {/* <lg: the table's horizontal scroll isn't a good hand-held experience —
              one card per position instead, same fields plus the same honest
              protection/exposure cues. */}
          <div className="flex flex-col divide-y divide-[color:var(--con-line)] lg:hidden">
            {rows.map(({ p, short, unrealized, unrealizedPct, weightPct, protection, meta, exposure }) => (
              <div key={p.symbol} className="flex flex-col gap-2 px-4 py-3 text-[length:var(--con-fs-sm)]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <SymbolButton symbol={p.symbol} />
                      {short && <span className="text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-warn)]">SHORT</span>}
                      {meta?.companyName && (
                        <span className="truncate text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                          {meta.companyName}
                        </span>
                      )}
                    </div>
                  </div>
                  {weightPct !== undefined && (
                    <span
                      className="con-num shrink-0 text-right font-semibold"
                      style={exposure.tone ? { color: exposure.tone === "neg" ? "var(--con-neg)" : "var(--con-warn)" } : undefined}
                      title={exposure.title}
                    >
                      <span className="font-normal text-[color:var(--con-faint)]">Weight:</span>&nbsp;&nbsp;{fmtPct(weightPct, 1, false)}
                      {exposure.label && <span className="block text-[length:var(--con-fs-xs)]">{exposure.label}</span>}
                    </span>
                  )}
                </div>
                <div className="con-num grid grid-cols-2 gap-x-3 gap-y-1.5 mt-1">
                  <div>
                    <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">Qty:</span>&nbsp;&nbsp;<span>{fmtQty(p.quantity)}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">P&amp;L:</span>&nbsp;&nbsp;<span>
                      {unrealized === undefined ? (
                        <Dash />
                      ) : (
                        <SignedText value={unrealized}>
                          {`${unrealized > 0 ? "+" : ""}${fmtMoney(unrealized)}`}
                          {unrealizedPct !== undefined ? ` (${fmtPct(unrealizedPct, 1, true)})` : ""}
                        </SignedText>
                      )}
                    </span>
                  </div>
                  <div>
                    <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">Value:</span>&nbsp;&nbsp;<span>{fmtMoney(p.marketValue)}</span>
                  </div>
                  <div className="text-right" title={protection.detail}>
                    <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">Protection:</span>&nbsp;&nbsp;<span>
                      {protection.label === null ? (
                        <span className="text-[color:var(--con-faint)]">{EM_DASH}</span>
                      ) : (
                        <span
                          className="font-semibold"
                          style={{ color: protection.tone === "warn" ? "var(--con-warn)" : protection.tone === "pos" ? "var(--con-pos)" : "var(--con-muted)" }}
                        >
                          {protection.label}
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
    {snapshot.options && snapshot.options.length > 0 && (
      <Card title="Unmanaged Options (no automated exit protection)" padded={false} className="mt-4">
        <div className="hidden overflow-x-auto lg:block">
          <Table caption="Data table" className="con-table">
            <thead>
              <tr>
                <Th title="OCC option symbol.">Symbol</Th>
                <Th title="Underlying symbol.">Underlying</Th>
                <Th title="Option type (Call/Put) and strike price.">Strike / Type</Th>
                <Th title="Expiration date.">Expiration</Th>
                <Th className="num" title="Number of contracts held; negative means short/written.">Qty</Th>
                <Th className="num" title="Average price paid per contract (not multiplier-adjusted).">Avg cost</Th>
                <Th className="num" title="Current market value of the option position (multiplier-adjusted).">Value</Th>
                <Th className="num" title="Gain or loss if closed now.">Unrealized P&amp;L</Th>
              </tr>
            </thead>
            <tbody>
              {snapshot.options.map((opt) => {
                const qty = opt.quantity;
                const costBasis = opt.averageCost * qty * 100;
                const unrealized = opt.marketValue - costBasis;
                const unrealizedPct = costBasis !== 0 ? (unrealized / Math.abs(costBasis)) * 100 : undefined;

                return (
                  <tr key={opt.symbol}>
                    <Td className="font-mono text-xs">{opt.symbol}</Td>
                    <Td>
                      <SymbolButton symbol={opt.underlyingSymbol} />
                    </Td>
                    <Td>
                      <span className="font-semibold">${opt.strikePrice}</span>{" "}
                      <span className={opt.optionType === "call" ? "text-indigo-400" : "text-pink-400"}>
                        {opt.optionType.toUpperCase()}
                      </span>
                    </Td>
                    <Td>{opt.expirationDate}</Td>
                    <Td className="num con-num">{fmtQty(qty)}</Td>
                    <Td className="num con-num">{fmtMoney(opt.averageCost)}</Td>
                    <Td className="num con-num">{fmtMoney(opt.marketValue)}</Td>
                    <Td className="num">
                      <SignedText value={unrealized}>
                        {`${unrealized > 0 ? "+" : ""}${fmtMoney(unrealized)}`}
                        {unrealizedPct !== undefined ? ` (${fmtPct(unrealizedPct, 1, true)})` : ""}
                      </SignedText>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>

        <div className="flex flex-col divide-y divide-[color:var(--con-line)] lg:hidden">
          {snapshot.options.map((opt) => {
            const qty = opt.quantity;
            const short = qty < 0;
            const costBasis = opt.averageCost * qty * 100;
            const unrealized = opt.marketValue - costBasis;
            const unrealizedPct = costBasis !== 0 ? (unrealized / Math.abs(costBasis)) * 100 : undefined;

            return (
              <div key={opt.symbol} className="flex flex-col gap-2 px-4 py-3 text-[length:var(--con-fs-sm)]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-xs">{opt.symbol}</span>
                      {short && <span className="text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-warn)]">SHORT</span>}
                    </div>
                    <div className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)] flex items-center gap-1">
                      <span>Underlying:</span>
                      <SymbolButton symbol={opt.underlyingSymbol} />
                      <span>| Strike: ${opt.strikePrice} | {opt.optionType.toUpperCase()} | Exp: {opt.expirationDate}</span>
                    </div>
                  </div>
                </div>
                <div className="con-num grid grid-cols-2 gap-x-3 gap-y-1.5 mt-1">
                  <div>
                    <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">Qty:</span>&nbsp;&nbsp;<span>{fmtQty(qty)}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">P&amp;L:</span>&nbsp;&nbsp;<span>
                      <SignedText value={unrealized}>
                        {`${unrealized > 0 ? "+" : ""}${fmtMoney(unrealized)}`}
                        {unrealizedPct !== undefined ? ` (${fmtPct(unrealizedPct, 1, true)})` : ""}
                      </SignedText>
                    </span>
                  </div>
                  <div>
                    <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">Value:</span>&nbsp;&nbsp;<span>{fmtMoney(opt.marketValue)}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">Avg Cost:</span>&nbsp;&nbsp;<span>{fmtMoney(opt.averageCost)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    )}
  </>
);
});
