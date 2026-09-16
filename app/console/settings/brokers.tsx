"use client";

/** Broker connections — connect (Robinhood OAuth, Alpaca keys), inspect,
 *  activate, and disconnect brokerage accounts. Every row states its
 *  money-reality in words; disconnecting always asks first and says exactly
 *  what it does (removes the connection from this app — never touches the
 *  broker). Improves on the legacy IntegrationsSection: same endpoints,
 *  console visual grammar, honest copy, tooltips on everything. */

import { useCallback, useEffect, useState } from "react";
import type { ConnectedAccount, TaxationType } from "@/lib/types";
import { mergeAccountCapabilities } from "@/lib/venue-contract-pure";
import { activateAccount, ConsoleApiError } from "../lib/api";
import { deriveStateInfo, realityForAccount } from "../lib/derive";
import {
  accountFractionalSharesLabel,
  accountOptionsTradingLabel,
  accountSessionHoursLabel
} from "../lib/labels";
import { useConsoleData } from "../lib/useConsoleData";
import { useToast } from "../ui/toast";
import { Sheet } from "../ui/sheet";
import { Btn, Card, Chip, Field, LiveTag, Select, TextInput } from "../ui/primitives";
import { Briefcase, ArrowDown, Zap, Scale, AlertTriangle, Pencil, Check, X, Info } from "lucide-react";
import {
  connectAlpacaAccount,
  connectKalshiAccount,
  connectKeyPairBroker,
  connectTradierAccount,
  disconnectAccount,
  fetchRobinhoodHealth,
  renameAccount,
  syncRobinhoodAccount,
  ROBINHOOD_OAUTH_START_URL,
  type RobinhoodMcpHealth
} from "./lib";

function brokerName(broker: ConnectedAccount["broker"]): string {
  switch (broker) {
    case "alpaca":
      return "Alpaca";
    case "alpaca-mcp":
      return "Alpaca MCP";
    case "robinhood":
      return "Robinhood";
    case "tradier":
      return "Tradier";
    case "kalshi":
      return "Kalshi";
    case "etoro":
      return "eToro";
    case "public":
      return "Public";
    case "webull":
      return "Webull";
    default:
      return broker;
  }
}

const TAXATION_WORD: Record<TaxationType, string> = {
  taxable: "taxable",
  roth_ira: "Roth IRA",
  traditional_ira: "traditional IRA"
};

const BROKER_ROADMAP = [
  {
    name: "IBKR",
    status: "Gateway required",
    detail:
      "Interactive Brokers needs an IB Gateway or TWS session plus a dedicated broker adapter before it can be connected here."
  }
] as const;

export function BrokerAccountsCard() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [rhHealth, setRhHealth] = useState<RobinhoodMcpHealth | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<ConnectedAccount | null>(null);
  const [capabilitiesAccount, setCapabilitiesAccount] = useState<ConnectedAccount | null>(null);
  const [alpacaOpen, setAlpacaOpen] = useState(false);
  const [tradierOpen, setTradierOpen] = useState(false);
  const [kalshiOpen, setKalshiOpen] = useState(false);
  const [extraOpen, setExtraOpen] = useState<"etoro" | "public" | "webull" | null>(null);
  // Inline rename of an account's cosmetic display name. `renaming` holds the id being edited
  // and the working input value; the broker account number is never touched by this.
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  // Best-effort Robinhood OAuth health — decides whether "Connect Robinhood"
  // starts OAuth or just re-syncs, and flags rows that need a reconnect.
  const loadRhHealth = useCallback(async () => {
    try {
      setRhHealth(await fetchRobinhoodHealth());
    } catch {
      // Health endpoint itself failing = treat as not connected; rows fall
      // back to neutral copy rather than a false "connected".
      setRhHealth(null);
    }
  }, []);

  useEffect(() => {
    void loadRhHealth();
  }, [loadRhHealth]);

  const syncRobinhood = useCallback(async () => {
    setBusy("robinhood");
    try {
      const result = await syncRobinhoodAccount();
      await refresh();
      toast.push("pos", "Robinhood account synced", result.label ? `Linked "${result.label}".` : undefined);
    } catch (error) {
      toast.push("neg", "Robinhood sync failed", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, [refresh, toast]);

  // If the OAuth flow ever returns to this page (?robinhoodMcp=connected),
  // finish the job: pull the agentic account into connected accounts.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("robinhoodMcp") !== "connected") return;
    params.delete("robinhoodMcp");
    const qs = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
    void syncRobinhood().then(() => loadRhHealth());
  }, [syncRobinhood, loadRhHealth]);

  if (!snapshot) return null;

  const accounts = snapshot.connectedAccounts;
  const rhAuthed = Boolean(rhHealth?.configured && rhHealth?.authenticated && rhHealth?.ok);
  const rhNeedsReconnect = (account: ConnectedAccount) =>
    account.broker === "robinhood" && rhHealth !== null && !rhAuthed;
  // Exactly one account carries isActive — hoist it as the "Currently Loaded"
  // account; everything else lists under "Other Accounts". Same isActive flag,
  // no server/query change.
  const loaded = accounts.find((account) => account.isActive);
  const others = accounts.filter((account) => !account.isActive);

  const connectRobinhood = () => {
    if (rhAuthed) {
      void syncRobinhood();
    } else {
      // Full-page redirect into the broker's OAuth. It returns via the app's
      // callback, which lands on the dashboard and completes the sync there.
      window.location.href = ROBINHOOD_OAUTH_START_URL;
    }
  };

  const remove = async (account: ConnectedAccount) => {
    setBusy(account.id);
    try {
      await disconnectAccount(account.id);
      await refresh();
      setConfirmRemove(null);
      toast.push("pos", "Connection removed", `${account.label || brokerName(account.broker)} was disconnected from this app.  Nothing changed at the broker.`);
    } catch (error) {
      toast.push("neg", "Could not disconnect", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const saveRename = async (account: ConnectedAccount) => {
    const next = renaming?.value.trim() ?? "";
    if (!next || next === account.label) {
      setRenaming(null);
      return;
    }
    setBusy(account.id);
    try {
      await renameAccount(account.id, next);
      await refresh();
      setRenaming(null);
      toast.push("pos", "Account renamed", `Now shown as "${next}".`);
    } catch (error) {
      toast.push("neg", "Could not rename", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  // One row renderer, reused for the loaded account and each "Other" account so
  // the two sections stay identical in look and behavior.
  const renderAccountRow = (account: ConnectedAccount) => {
    const r = realityForAccount(account);
    const needsReconnect = rhNeedsReconnect(account);
    // Every row — loaded or not — reads the SAME per-account projection the chrome.tsx
    // account-switcher already trusts (snapshot.connectedAccountPolicies, built read-only in
    // dashboard.ts via peekPolicy for every connected account). The scheduler runs each
    // connected account independently of which one happens to be loaded in this browser tab, so
    // a non-active account (e.g. a live Roth IRA) can genuinely be running Autopilot right now —
    // this used to unconditionally chip every "Other Accounts" row "Inactive" regardless.
    const policyForAccount = snapshot.connectedAccountPolicies?.[account.id];
    const stateInfo = policyForAccount ? deriveStateInfo(policyForAccount) : null;

    // A real per-account pending-proposal count. snapshot.pendingProposals is scoped
    // server-side to the ACTIVE account only (dashboard.ts), so filtering it for another
    // account's id could never find a match — connectedAccountPendingCounts is a dedicated
    // per-account COUNT query that actually covers every connected account.
    const pendingCount = snapshot.connectedAccountPendingCounts?.[account.id] ?? 0;

    const accountTypeWord = account.taxationType
      ? (TAXATION_WORD[account.taxationType] ?? account.taxationType)
      : r.tone === "paper"
      ? "Paper"
      : "Taxable";

    return (
      <div
        key={account.id}
        tabIndex={0}
        className="rounded-control border border-[color:var(--con-line)] p-3 transition-colors hover:bg-[color:var(--con-surface-2)] focus-visible:bg-[color:var(--con-surface-2)] flex flex-col gap-1.5"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {renaming?.id === account.id ? (
              <div className="flex min-w-0 items-center gap-1.5">
                <TextInput
                  autoFocus
                  aria-label="Account name"
                  value={renaming.value}
                  maxLength={120}
                  disabled={busy !== null}
                  onChange={(e) => setRenaming({ id: account.id, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveRename(account);
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  className="h-7 w-44 max-w-full"
                />
                <button
                  type="button"
                  aria-label="Save name"
                  disabled={busy !== null}
                  onClick={() => void saveRename(account)}
                  className="text-[color:var(--con-pos)] hover:opacity-80 disabled:opacity-50"
                  title="Save the new name"
                >
                  <Check className="size-4" />
                </button>
                <button
                  type="button"
                  aria-label="Cancel rename"
                  disabled={busy !== null}
                  onClick={() => setRenaming(null)}
                  className="text-[color:var(--con-faint)] hover:opacity-80 disabled:opacity-50"
                  title="Cancel"
                >
                  <X className="size-4" />
                </button>
              </div>
            ) : (
              <>
                <span className="truncate font-semibold" title={`${brokerName(account.broker)} connection${account.accountNumber ? ` · account ${account.accountNumber}` : ""}`}>
                  {account.label || brokerName(account.broker)}
                </span>
                <button
                  type="button"
                  aria-label="Rename account"
                  disabled={busy !== null}
                  onClick={() => setRenaming({ id: account.id, value: account.label || "" })}
                  className="shrink-0 text-[color:var(--con-faint)] hover:text-[color:var(--con-fg)] disabled:opacity-50"
                  title="Rename this account's display name.  The broker account number is not affected."
                >
                  <Pencil className="size-3.5" />
                </button>
              </>
            )}
            {needsReconnect && (
              <Chip tone="warn" title="The Robinhood OAuth session is missing or expired, so this app can't reach the broker for this account until you reconnect.">
                reconnect needed
              </Chip>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 text-[length:var(--con-fs-xs)]">
              {stateInfo ? (
                <Chip tone={stateInfo.tone} title={stateInfo.detail}>
                  {stateInfo.label}
                </Chip>
              ) : (
                // Reachable only when this account's id is genuinely missing from
                // connectedAccountPolicies (an older-shaped cached snapshot, or a brand-new
                // connection before the next refresh) -- never assert "Inactive" for a state we
                // don't actually know, since the scheduler may be running this account right now.
                <Chip tone="muted" title="This account's run state was not included in the last snapshot.">
                  State unknown
                </Chip>
              )}
              {pendingCount > 0 && (
                <Chip tone="warn" title={`${pendingCount} pending trade proposal(s) awaiting your review.`}>
                  {pendingCount} pending proposal{pendingCount === 1 ? "" : "s"}
                </Chip>
              )}
            </div>
            {needsReconnect && (
              <Btn
                size="sm"
                variant="primary"
                disabled={busy !== null}
                onClick={() => {
                  window.location.href = ROBINHOOD_OAUTH_START_URL;
                }}
                title="Re-run Robinhood's OAuth sign-in to restore this connection."
              >
                Reconnect
              </Btn>
            )}
            {!account.isActive && (
              <Btn
                size="sm"
                variant="outline"
                disabled={busy !== null}
                title="Load this account — the whole console rescopes to it."
                onClick={async () => {
                  setBusy(account.id);
                  let reloading = false;
                  try {
                    await activateAccount(account.id);
                    reloading = true;
                    window.location.reload();
                  } catch (error) {
                    toast.push("neg", "Could not load", error instanceof ConsoleApiError ? error.message : String(error));
                  } finally {
                    if (!reloading) setBusy(null);
                  }
                }}
              >
                {busy === account.id ? "Loading…" : r.tone === "paper" ? (
                  <>
                    Load <Chip tone="paper" className="ml-1 inline-flex items-center px-1.5 py-0 text-[length:var(--con-fs-2xs)] leading-tight uppercase font-semibold">PAPER</Chip>
                  </>
                ) : r.tone === "live" ? (
                  <>
                    Load <LiveTag />
                  </>
                ) : (
                  "Load"
                )}
              </Btn>
            )}
            <Btn
              size="sm"
              variant="outline"
              onClick={() => setCapabilitiesAccount(account)}
              title="Inspect trading capabilities and operational features for this connection."
            >
              Capabilities
            </Btn>
            <Btn
              size="sm"
              variant="dangerOutline"
              disabled={busy !== null}
              onClick={() => setConfirmRemove(account)}
              title="Remove this connection (and its stored credentials) from this app.  The broker account itself is untouched — open positions and resting orders stay at the broker."
            >
              Disconnect
            </Btn>
          </div>
        </div>
        <p
          className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
          title="Broker, environment, account tail, and tax treatment."
        >
          {`${brokerName(account.broker)} · ${account.environment}`}
          {account.accountNumber ? ` · ·· ${account.accountNumber.slice(-4)}` : ""}
          {` · ${accountTypeWord}`}
        </p>
      </div>
    );
  };

  return (
    <Card
      title="Broker connections"
      action={
        // flex-wrap + justify-end: three connect buttons don't fit beside the title on
        // phone widths — wrapping keeps them on-canvas instead of forcing the whole
        // page to scroll horizontally (390px viewport regression).
        <div className="flex flex-wrap justify-end gap-2">
          <Btn
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={connectRobinhood}
            title={
              rhAuthed
                ? "Robinhood OAuth is already connected — this re-syncs the agentic account details from the broker."
                : "Opens Robinhood's own sign-in (OAuth).  This app never sees your Robinhood password."
            }
          >
            {busy === "robinhood" ? "Syncing…" : rhAuthed ? "Sync Robinhood" : "Connect Robinhood"}
          </Btn>
          <Btn
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => setAlpacaOpen(true)}
            title="Link an Alpaca account with its API key pair.  Paper vs live is inferred from the credentials."
          >
            Connect Alpaca
          </Btn>
          <Btn
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => setTradierOpen(true)}
            title="Link a Tradier account with an access token.  Choose Sandbox (paper) or Production (live)."
          >
            Connect Tradier
          </Btn>
          <Btn
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => setKalshiOpen(true)}
            title="Link a Kalshi account with API Key ID & Private Key PEM.  Choose Demo or Live."
          >
            Connect Kalshi
          </Btn>
          <Btn
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => setExtraOpen("public")}
            title="Link Public.com for quotes and history.  Order execution stays off until Settings → Public.com order execution is turned on (account not funded yet)."
          >
            Connect Public
          </Btn>
          <Btn
            size="sm"
            variant="outline"
            disabled
            title="eToro has no API access on this account yet.  Connect will stay off until that exists."
          >
            eToro — No API Yet
          </Btn>
          <Btn
            size="sm"
            variant="outline"
            disabled
            title="Webull official OpenAPI comes later.  Unofficial libraries are not used."
          >
            Webull — Later
          </Btn>
        </div>
      }
    >
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Connections apply to your whole login. Exactly one account is loaded at a time; the whole console is scoped to
        that account, including its authority, strategy, and decision history.
      </p>

      {accounts.length === 0 ? (
        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          No brokerage connected yet. Use the buttons above when you want broker-backed execution — Robinhood connects
          through the broker&apos;s own sign-in, Alpaca through an API key pair.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <section>
            <h3 className="mb-2 text-[length:var(--con-fs-sm)] font-semibold">Currently Loaded Account</h3>
            {loaded ? (
              renderAccountRow(loaded)
            ) : (
              <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                No account loaded — select one below.
              </p>
            )}
          </section>
          <section>
            <h3 className="mb-2 text-[length:var(--con-fs-sm)] font-semibold">Other Accounts</h3>
            {others.length > 0 ? (
              <div className="flex flex-col gap-2">{others.map(renderAccountRow)}</div>
            ) : (
              <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                No other accounts.  Use the buttons above to connect one.
              </p>
            )}
          </section>
        </div>
      )}

      <div className="mt-4 border-t border-[color:var(--con-line)] pt-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-[length:var(--con-fs-sm)] font-semibold">Future Brokers</h3>
        </div>
        <div className="grid gap-2 lg:grid-cols-3">
          {BROKER_ROADMAP.map((broker) => (
            <div
              key={broker.name}
              className="rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] p-3"
              title={broker.detail}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold">{broker.name}</span>
                <Chip tone="warn">{broker.status}</Chip>
              </div>
              <p className="mt-2 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
                {broker.detail}
              </p>
            </div>
          ))}
        </div>
      </div>

      <CapabilitiesSheet
        account={capabilitiesAccount}
        onClose={() => setCapabilitiesAccount(null)}
      />

      {/* Disconnect confirm — explicit about what is and is not affected. */}
      <Sheet
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        title={`Disconnect ${confirmRemove?.label || (confirmRemove ? brokerName(confirmRemove.broker) : "")}?`}
        tone={confirmRemove && realityForAccount(confirmRemove).tone === "live" ? "live" : undefined}
      >
        {confirmRemove && (
          <div className="flex flex-col gap-3 text-[length:var(--con-fs-sm)]">
            <p>
              This removes the connection and its stored credentials from this app.{" "}
              <span className="font-semibold">Nothing changes at the broker</span> — open positions and resting orders
              stay exactly where they are; this app just stops seeing and managing them.
            </p>
            {realityForAccount(confirmRemove).tone === "live" && (
              <p className="rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] p-2.5 text-[length:var(--con-fs-xs)]">
                This is a brokerage connection.  After disconnecting, any app-managed stop rules for its
                positions stop running — only broker-held orders keep protecting them.
              </p>
            )}
            {confirmRemove.isActive && (
              <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">
                This is the currently loaded account.  Disconnecting it rescopes the console to the next loaded account,
                if one remains.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Btn variant="ghost" onClick={() => setConfirmRemove(null)} title="Keep the connection.">
                Cancel
              </Btn>
              <Btn
                variant="danger"
                disabled={busy !== null}
                onClick={() => void remove(confirmRemove)}
                title="Remove the connection from this app now."
              >
                {busy === confirmRemove.id ? "Disconnecting…" : "Disconnect"}
              </Btn>
            </div>
          </div>
        )}
      </Sheet>

      <AlpacaConnectSheet
        open={alpacaOpen}
        onClose={() => setAlpacaOpen(false)}
        onConnected={async () => {
          setAlpacaOpen(false);
          await refresh();
        }}
      />

      <TradierConnectSheet
        open={tradierOpen}
        onClose={() => setTradierOpen(false)}
        onConnected={async () => {
          setTradierOpen(false);
          await refresh();
        }}
      />
      <KalshiConnectSheet
        open={kalshiOpen}
        onClose={() => setKalshiOpen(false)}
        onConnected={async () => {
          setKalshiOpen(false);
          await refresh();
        }}
      />
      <ExtraBrokerConnectSheet
        broker={extraOpen}
        onClose={() => setExtraOpen(null)}
        onConnected={async () => {
          setExtraOpen(null);
          await refresh();
        }}
      />
    </Card>
  );
}

// ── Alpaca connect (API key pair) ────────────────────────────────────────────

function AlpacaConnectSheet({
  open,
  onClose,
  onConnected
}: {
  open: boolean;
  onClose: () => void;
  onConnected: () => Promise<void>;
}) {
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [taxationType, setTaxationType] = useState<"" | TaxationType>("");
  const [busy, setBusy] = useState(false);

  const inferredPaper = accountNumber.trim().toUpperCase().startsWith("PA") || apiKey.trim().toUpperCase().startsWith("PK");

  const submit = async () => {
    if (!accountNumber.trim()) {
      toast.push("warn", "Account number is required");
      return;
    }
    if (!apiKey.trim()) {
      toast.push("warn", "API key is required");
      return;
    }
    setBusy(true);
    try {
      await connectAlpacaAccount({
        label: label.trim() || undefined,
        accountNumber: accountNumber.trim(),
        apiKey: apiKey.trim(),
        apiSecret: apiSecret.trim() || undefined,
        taxationType: taxationType || undefined
      });
      toast.push("pos", "Alpaca account connected", inferredPaper ? "Connected as Alpaca PAPER Account (NOT Real Money)." : "Connected as a brokerage account.");
      setLabel("");
      setAccountNumber("");
      setApiKey("");
      setApiSecret("");
      setTaxationType("");
      await onConnected();
    } catch (error) {
      toast.push("neg", "Could not connect", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Connect Alpaca">
      <div className="flex flex-col gap-3">
        <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Paste the API key pair from your Alpaca dashboard. Paper accounts are inferred from the credentials
          (&quot;PA…&quot; account numbers and &quot;PK…&quot; keys are paper) — currently reading as{" "}
          <span className={inferredPaper ? "font-bold text-[color:var(--con-paper)]" : "font-bold text-[color:var(--con-accent)]"}>
            {inferredPaper ? "Alpaca PAPER Account (NOT Real Money)" : "Brokerage Account"}
          </span>
          .  Credentials are stored server-side and never shown again.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Label (optional)" hint="A name you'll recognize in the account switcher." htmlFor="alp-label">
            <TextInput
              id="alp-label"
              value={label}
              placeholder="Paper, Roth IRA, etc"
              onChange={(e) => setLabel(e.target.value)}
              title="Display name for this connection inside the app."
            />
          </Field>
          <Field label="Account number" hint={'"PA…" means a paper account.'} htmlFor="alp-acct">
            <TextInput
              id="alp-acct"
              value={accountNumber}
              placeholder="e.g. PA12345"
              onChange={(e) => setAccountNumber(e.target.value)}
              title="Your Alpaca account number.  Determines paper vs live together with the key."
            />
          </Field>
          <Field label="API key" hint='"PK…" keys are paper keys.' htmlFor="alp-key">
            <TextInput
              id="alp-key"
              value={apiKey}
              autoComplete="off"
              placeholder="API key or OAuth token"
              onChange={(e) => setApiKey(e.target.value)}
              title="The API key ID from Alpaca.  Sent once to the server, never echoed back."
            />
          </Field>
          <Field label="API secret" hint="Required for key pairs; omit for OAuth tokens." htmlFor="alp-secret">
            <TextInput
              id="alp-secret"
              type="password"
              value={apiSecret}
              autoComplete="off"
              placeholder="Secret key"
              onChange={(e) => setApiSecret(e.target.value)}
              title="The matching secret key.  Stored server-side only."
            />
          </Field>
          <Field
            label="Tax treatment (optional)"
            hint="IRAs zero the estimated tax rates and skip the per-account wash-sale guard."
            htmlFor="alp-tax"
          >
            <Select
              id="alp-tax"
              value={taxationType}
              onChange={(e) => setTaxationType(e.target.value as "" | TaxationType)}
              title="How gains in this account are taxed — drives the tax estimates and wash-sale handling."
            >
              <option value="">not set</option>
              <option value="taxable">taxable brokerage</option>
              <option value="roth_ira">Roth IRA</option>
              <option value="traditional_ira">traditional IRA</option>
            </Select>
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Btn variant="ghost" onClick={onClose} title="Close without connecting.">
            Cancel
          </Btn>
          <Btn
            variant="primary"
            disabled={busy}
            onClick={() => void submit()}
            title="Validate and store this connection server-side."
          >
            {busy ? "Connecting…" : inferredPaper ? "Connect Paper" : (
              <>
                Connect <LiveTag />
              </>
            )}
          </Btn>
        </div>
      </div>
    </Sheet>
  );
}

// ── Tradier connect (single access token) ────────────────────────────────────

function TradierConnectSheet({
  open,
  onClose,
  onConnected
}: {
  open: boolean;
  onClose: () => void;
  onConnected: () => Promise<void>;
}) {
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [environment, setEnvironment] = useState<"paper" | "live">("paper");
  const [accountNumber, setAccountNumber] = useState("");
  const [taxationType, setTaxationType] = useState<"" | TaxationType>("");
  const [busy, setBusy] = useState(false);

  const isLive = environment === "live";

  const submit = async () => {
    if (!apiKey.trim()) {
      toast.push("warn", "Access token is required");
      return;
    }
    setBusy(true);
    try {
      await connectTradierAccount({
        label: label.trim() || undefined,
        apiKey: apiKey.trim(),
        environment,
        accountNumber: accountNumber.trim() || undefined,
        taxationType: taxationType || undefined
      });
      toast.push(
        "pos",
        "Tradier account connected",
        isLive ? "Connected as a Tradier production (live) account." : "Connected as a Tradier sandbox (paper) account."
      );
      setLabel("");
      setApiKey("");
      setEnvironment("paper");
      setAccountNumber("");
      setTaxationType("");
      await onConnected();
    } catch (error) {
      toast.push("neg", "Could not connect", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Connect Tradier">
      <div className="flex flex-col gap-3">
        <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Paste the access token from your Tradier dashboard. A sandbox token only authenticates
          against Tradier&apos;s sandbox and a production token only against the live API, so you
          choose the environment explicitly — currently reading as{" "}
          <span className={isLive ? "font-bold text-[color:var(--con-accent)]" : "font-bold text-[color:var(--con-paper)]"}>
            {isLive ? "Tradier Production (LIVE — Real Money)" : "Tradier Sandbox (Paper — NOT Real Money)"}
          </span>
          .  The token is stored server-side and never shown again.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Label (optional)" hint="A name you'll recognize in the account switcher." htmlFor="trd-label">
            <TextInput
              id="trd-label"
              value={label}
              placeholder="Sandbox, Brokerage, etc"
              onChange={(e) => setLabel(e.target.value)}
              title="Display name for this connection inside the app."
            />
          </Field>
          <Field label="Environment" hint="Sandbox = paper (no real money); Production = live." htmlFor="trd-env">
            <Select
              id="trd-env"
              value={environment}
              onChange={(e) => setEnvironment(e.target.value === "live" ? "live" : "paper")}
              title="Which Tradier venue this token authenticates against."
            >
              <option value="paper">Sandbox (paper)</option>
              <option value="live">Production (live)</option>
            </Select>
          </Field>
          <Field label="Access token" hint="A single Bearer token — no secret." htmlFor="trd-key">
            <TextInput
              id="trd-key"
              type="password"
              value={apiKey}
              autoComplete="off"
              placeholder="Tradier access token"
              onChange={(e) => setApiKey(e.target.value)}
              title="The access token from Tradier.  Sent once to the server, never echoed back."
            />
          </Field>
          <Field label="Account number (optional)" hint="Leave blank to use the token's account." htmlFor="trd-acct">
            <TextInput
              id="trd-acct"
              value={accountNumber}
              placeholder="e.g. VA12345678"
              onChange={(e) => setAccountNumber(e.target.value)}
              title="Your Tradier account number.  Optional — the profile is probed on first use."
            />
          </Field>
          <Field
            label="Tax treatment (optional)"
            hint="IRAs zero the estimated tax rates and skip the per-account wash-sale guard."
            htmlFor="trd-tax"
          >
            <Select
              id="trd-tax"
              value={taxationType}
              onChange={(e) => setTaxationType(e.target.value as "" | TaxationType)}
              title="How gains in this account are taxed — drives the tax estimates and wash-sale handling."
            >
              <option value="">not set</option>
              <option value="taxable">taxable brokerage</option>
              <option value="roth_ira">Roth IRA</option>
              <option value="traditional_ira">traditional IRA</option>
            </Select>
          </Field>
        </div>
        {isLive && (
          <p className="rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] p-2.5 text-[length:var(--con-fs-xs)]">
            <LiveTag /> A production Tradier token trades <span className="font-semibold">real capital</span>.  Orders can
            reach real money only when policy, approval, and risk gates allow them.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Btn variant="ghost" onClick={onClose} title="Close without connecting.">
            Cancel
          </Btn>
          <Btn
            variant="primary"
            disabled={busy}
            onClick={() => void submit()}
            title="Validate and store this connection server-side."
          >
            {busy ? "Connecting…" : isLive ? (
              <>
                Connect <LiveTag />
              </>
            ) : "Connect Sandbox"}
          </Btn>
        </div>
      </div>
    </Sheet>
  );
}

function ExtraBrokerConnectSheet({
  broker,
  onClose,
  onConnected
}: {
  broker: "etoro" | "public" | "webull" | null;
  onClose: () => void;
  onConnected: () => Promise<void>;
}) {
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [environment, setEnvironment] = useState<"paper" | "live">("paper");
  const [busy, setBusy] = useState(false);
  if (!broker) return null;

  const copy =
    broker === "public"
      ? {
          title: "Connect Public",
          hint: "Paste the Individual API secret from public.com Account Settings → Security → API.  This is live-only.  Quotes and history can run now; order execution stays parked until the account is funded and Public.com Order Execution is turned on in Data Sources."
        }
      : broker === "etoro"
        ? {
            title: "Connect eToro",
            hint: "Paste the application x-api-key and the user x-user-key from eToro Settings → Trading → API Key Management.  Demo keys stay paper; Real keys are live."
          }
        : {
            title: "Connect Webull",
            hint: "Paste official OpenAPI App Key + App Secret after Developer Tool approval.  Unofficial Webull libraries are never used for orders."
          };

  const submit = async () => {
    if (broker === "public" && !apiSecret.trim() && !apiKey.trim()) {
      toast.push("warn", "Public API secret is required");
      return;
    }
    if (broker !== "public" && (!apiKey.trim() || !apiSecret.trim())) {
      toast.push("warn", "Both keys are required");
      return;
    }
    setBusy(true);
    try {
      await connectKeyPairBroker(broker, {
        label: label.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
        apiSecret: (apiSecret.trim() || apiKey.trim()) || undefined,
        environment: broker === "public" ? "live" : environment
      });
      toast.push("pos", `${copy.title.replace("Connect ", "")} account connected`);
      setLabel("");
      setApiKey("");
      setApiSecret("");
      setEnvironment("paper");
      await onConnected();
    } catch (error) {
      toast.push("neg", "Could not connect", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={broker !== null} onClose={onClose} title={copy.title}>
      <div className="flex flex-col gap-3">
        <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">{copy.hint}</p>
        <Field label="Label (optional)" htmlFor="extra-label">
          <TextInput id="extra-label" value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        {broker !== "public" && (
          <Field label={broker === "etoro" ? "x-api-key" : "App Key"} htmlFor="extra-key">
            <TextInput id="extra-key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </Field>
        )}
        <Field label={broker === "public" ? "API secret" : broker === "etoro" ? "x-user-key" : "App Secret"} htmlFor="extra-secret">
          <TextInput id="extra-secret" type="password" autoComplete="off" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} />
        </Field>
        {broker !== "public" && (
          <Field label="Environment" htmlFor="extra-env">
            <Select id="extra-env" value={environment} onChange={(e) => setEnvironment(e.target.value === "live" ? "live" : "paper")}>
              <option value="paper">{broker === "etoro" ? "Demo" : "Sandbox"}</option>
              <option value="live">{broker === "etoro" ? "Real" : "Production"}</option>
            </Select>
          </Field>
        )}
        <Btn variant="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? "Connecting…" : "Connect"}
        </Btn>
      </div>
    </Sheet>
  );
}

// ── Kalshi connect (API Key ID + Private Key PEM) ────────────────────────────

function KalshiConnectSheet({
  open,
  onClose,
  onConnected
}: {
  open: boolean;
  onClose: () => void;
  onConnected: () => Promise<void>;
}) {
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [environment, setEnvironment] = useState<"paper" | "live">("paper");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!apiKey.trim()) {
      toast.push("warn", "Kalshi API Key ID (UUID) is required");
      return;
    }
    if (!apiSecret.trim()) {
      toast.push("warn", "Kalshi RSA Private Key PEM is required");
      return;
    }
    setBusy(true);
    try {
      await connectKalshiAccount({
        label: label.trim() || undefined,
        apiKey: apiKey.trim(),
        apiSecret: apiSecret.trim(),
        environment
      });
      toast.push("pos", "Kalshi connected", `Linked Kalshi ${environment === "live" ? "Live" : "Demo"} account.`);
      await onConnected();
    } catch (error) {
      toast.push("neg", "Could not connect Kalshi", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Connect Kalshi"
      tone={environment === "live" ? "live" : undefined}
    >
      <div className="flex flex-col gap-3">
        <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Link a Kalshi account for binary event contracts (CFTC-regulated predictions on macro, politics, economics, and markets). 
          Obtain your API Key ID and RSA Private Key PEM from Kalshi Settings → API Keys.
        </p>

        <Field label="Label (optional)" htmlFor="kalshi-label" hint="Cosmetic display name in the console.">
          <TextInput
            id="kalshi-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={environment === "live" ? "Kalshi Live" : "Kalshi Demo"}
          />
        </Field>

        <Field
          label="Environment"
          htmlFor="kalshi-env"
          hint="Demo practice account or live execution venue."
        >
          <Select
            id="kalshi-env"
            value={environment}
            onChange={(e) => setEnvironment(e.target.value === "live" ? "live" : "paper")}
          >
            <option value="paper">Demo (Practice)</option>
            <option value="live">Live (Real Orders)</option>
          </Select>
        </Field>

        <Field label="API Key ID (UUID)" htmlFor="kalshi-key" hint="The UUID assigned when you generated the key on Kalshi.">
          <TextInput
            id="kalshi-key"
            type="text"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="e.g. 12345678-abcd-1234-abcd-1234567890ab"
          />
        </Field>

        <Field
          label="RSA Private Key PEM"
          htmlFor="kalshi-secret"
          hint="Your private key PEM generated from Kalshi Settings → API Keys."
        >
          <textarea
            id="kalshi-secret"
            className="w-full rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface)] p-2 font-mono text-[length:var(--con-fs-xs)] focus:outline-none focus:ring-1 focus:ring-[color:var(--con-accent)]"
            rows={4}
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
            placeholder="Paste your RSA private key PEM here..."
          />
        </Field>

        <div className="flex justify-end gap-2 mt-2">
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn variant="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? "Connecting…" : "Connect Kalshi"}
          </Btn>
        </div>
      </div>
    </Sheet>
  );
}

// ── Capabilities Modal Sheet ──────────────────────────────────────────────────

function CapabilitiesSheet({
  account,
  onClose
}: {
  account: ConnectedAccount | null;
  onClose: () => void;
}) {
  if (!account) return null;
  const caps = mergeAccountCapabilities(account.broker, account.capabilities);
  const isKalshi = account.broker === "kalshi";
  return (
    <Sheet
      open={account !== null}
      onClose={onClose}
      title={`${brokerName(account.broker)} Capabilities`}
    >
      <div className="flex flex-col gap-3 text-[length:var(--con-fs-sm)]">
        <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Operational capabilities and order execution features for account{" "}
          <span className="font-semibold text-[color:var(--con-fg)]">
            {account.label || brokerName(account.broker)}
          </span>
          {account.accountNumber ? ` (··${account.accountNumber.slice(-4)})` : ""}.
        </p>

        <div className="rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] p-3 flex flex-col gap-2">
          {isKalshi ? (
            <>
              <div className="flex items-center justify-between">
                <span className="font-medium flex items-center gap-1.5"><Zap className="size-4 text-[color:var(--con-accent)]" /> Event Contracts</span>
                <Chip tone="pos">Enabled</Chip>
              </div>
              <div className="flex items-center justify-between border-t border-[color:var(--con-line)] pt-2">
                <span className="font-medium flex items-center gap-1.5"><Scale className="size-4 text-[color:var(--con-accent)]" /> Yes / No Binary Payouts</span>
                <Chip tone="pos">Supported ($0.01–$0.99)</Chip>
              </div>
              <div className="flex items-center justify-between border-t border-[color:var(--con-line)] pt-2">
                <span className="font-medium">Order Types</span>
                <Chip tone="muted">Limit, Market</Chip>
              </div>
              <div className="flex items-center justify-between border-t border-[color:var(--con-line)] pt-2">
                <span className="font-medium">Regulation</span>
                <Chip tone="muted">CFTC Regulated</Chip>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="font-medium flex items-center gap-1.5"><Briefcase className="size-4 text-[color:var(--con-accent)]" /> Stock Trading</span>
                <Chip tone={caps?.equityTrading !== false ? "pos" : "muted"}>
                  {caps?.equityTrading !== false ? "Connected" : "Disabled"}
                </Chip>
              </div>
              <div className="flex items-center justify-between border-t border-[color:var(--con-line)] pt-2">
                <span className="font-medium flex items-center gap-1.5"><ArrowDown className="size-4 text-[color:var(--con-accent)]" /> Short Selling</span>
                <Chip tone={caps?.shortSelling ? "pos" : "muted"}>
                  {caps?.shortSelling ? "Enabled" : "Disabled"}
                </Chip>
              </div>
              <div className="flex items-center justify-between border-t border-[color:var(--con-line)] pt-2">
                <span className="font-medium flex items-center gap-1.5"><Zap className="size-4 text-[color:var(--con-accent)]" /> Options Trading</span>
                <Chip tone={caps?.optionsOrders ? "pos" : "muted"}>
                  {accountOptionsTradingLabel(caps)}
                </Chip>
              </div>
              <div className="flex items-center justify-between border-t border-[color:var(--con-line)] pt-2">
                <span className="font-medium">Fractional Shares</span>
                <Chip tone={caps?.fractional ? "pos" : "muted"}>{accountFractionalSharesLabel(caps?.fractional)}</Chip>
              </div>
              <div className="flex items-center justify-between border-t border-[color:var(--con-line)] pt-2">
                <span className="font-medium">Sessions</span>
                <Chip tone="muted">
                  {accountSessionHoursLabel(caps)}
                </Chip>
              </div>
              <div className="flex items-center justify-between border-t border-[color:var(--con-line)] pt-2">
                <span className="font-medium flex items-center gap-1.5"><Scale className="size-4 text-[color:var(--con-accent)]" /> Margin Account</span>
                <Chip tone={caps?.marginEnabled ? "pos" : "muted"}>
                  {caps?.marginEnabled ? "Enabled" : "Cash Only"}
                </Chip>
              </div>
            </>
          )}
        </div>

        <div className="rounded-control border border-[color:var(--con-line)] p-3 text-[length:var(--con-fs-xs)] flex flex-col gap-1.5">
          <span className="font-semibold text-[color:var(--con-fg)]">Gateway Status</span>
          <p className="text-[color:var(--con-muted)]">
            {caps
              ? "Broker capabilities confirmed via live API probe."
              : "Gateway connected.  Capabilities default to standard equity trading until initial execution probe."}
          </p>
        </div>

        <div className="flex justify-end mt-2">
          <Btn variant="primary" onClick={onClose}>
            Done
          </Btn>
        </div>
      </div>
    </Sheet>
  );
}

 
