"use client";

/** Per-user data-source proxy. When set (and enabled), the user's market-data/
 *  provider egress (quotes, enrichment, screeners) exits through their proxy
 *  instead of the operator default. Includes a live canary test that shows the
 *  egress IP data-source traffic currently uses. */

import { useCallback, useEffect, useState } from "react";
import { ConsoleApiError } from "../lib/api";
import { useToast } from "../ui/toast";
import { Btn, Card, Chip, Field, Select, TextInput, Toggle } from "../ui/primitives";
import {
  deleteProxySettings,
  fetchProxySettings,
  saveProxySettings,
  testProxySettings,
  type ProxySettingsPayload,
  type ProxyTestResult
} from "./lib";

export function ProxyCard() {
  const toast = useToast();
  const [data, setData] = useState<ProxySettingsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null);
  const [draft, setDraft] = useState({
    enabled: true,
    protocol: "http" as "http" | "https",
    host: "",
    port: "",
    username: "",
    password: "",
    failureMode: "fail_soft" as "fail_soft" | "fail_closed"
  });

  const load = useCallback(async () => {
    try {
      const next = await fetchProxySettings();
      setData(next);
      setLoadError(null);
      if (next.settings) {
        setDraft({
          enabled: next.settings.enabled,
          protocol: next.settings.protocol,
          host: next.settings.host,
          port: next.settings.port ? String(next.settings.port) : "",
          username: next.settings.username ?? "",
          password: "",
          failureMode: next.settings.failureMode
        });
      }
    } catch (err) {
      setLoadError(err instanceof ConsoleApiError ? err.message : "Could not load proxy settings.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    try {
      const next = await saveProxySettings({
        enabled: draft.enabled,
        protocol: draft.protocol,
        host: draft.host,
        port: draft.port ? Number(draft.port) : null,
        username: draft.username || null,
        // Empty password field = keep the stored password (or none, on first save).
        ...(draft.password ? { password: draft.password } : {}),
        failureMode: draft.failureMode
      });
      setData(next);
      setDraft((d) => ({ ...d, password: "" }));
      toast.push("pos", "Proxy settings saved.");
    } catch (err) {
      toast.push("neg", "Could not save proxy settings", err instanceof ConsoleApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      const next = await deleteProxySettings();
      setData(next);
      setDraft({ enabled: true, protocol: "http", host: "", port: "", username: "", password: "", failureMode: "fail_soft" });
      toast.push("pos", "Proxy override removed", "Using the operator default.");
    } catch (err) {
      toast.push("neg", "Could not remove proxy settings", err instanceof ConsoleApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testProxySettings());
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof ConsoleApiError ? err.message : "Test request failed." });
    } finally {
      setTesting(false);
    }
  };

  const effective = data?.effective;
  return (
    <Card
      title="Data-source proxy"
      action={
        effective ? (
          <Chip tone={effective.source === "none" ? "muted" : effective.source === "user" ? "pos" : "accent"}>
            {effective.source === "user"
              ? `your proxy (${effective.proxyHost})`
              : effective.source === "env"
                ? `operator proxy (${effective.proxyHost})`
                : effective.source === "default"
                  ? `default residential proxy (${effective.proxyHost})`
                  : "direct egress"}
          </Chip>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">
          Route your market-data and provider traffic through your own HTTP proxy. Internal services
          (database, vector store, localhost) never use it. When the proxy is unreachable,{" "}
          <em>fail soft</em> falls back to a direct connection for that request; <em>fail closed</em>{" "}
          treats the provider as down instead.
        </p>
        {loadError && <p className="text-[color:var(--con-neg)]">{loadError}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Host" hint="Bare host or IP — no scheme, no path.">
            <TextInput
              value={draft.host}
              onChange={(e) => setDraft((d) => ({ ...d, host: e.target.value }))}
              placeholder="proxy.example.com or 10.0.0.2"
              autoComplete="off"
            />
          </Field>
          <Field label="Port">
            <TextInput
              value={draft.port}
              onChange={(e) => setDraft((d) => ({ ...d, port: e.target.value }))}
              placeholder="8888"
              inputMode="numeric"
              autoComplete="off"
            />
          </Field>
          <Field label="Protocol">
            <Select
              value={draft.protocol}
              onChange={(e) => setDraft((d) => ({ ...d, protocol: e.target.value as "http" | "https" }))}
            >
              <option value="http">http</option>
              <option value="https">https</option>
            </Select>
          </Field>
          <Field label="When the proxy is down">
            <Select
              value={draft.failureMode}
              onChange={(e) => setDraft((d) => ({ ...d, failureMode: e.target.value as "fail_soft" | "fail_closed" }))}
            >
              <option value="fail_soft">Fail soft — fall back to direct for that request</option>
              <option value="fail_closed">Fail closed — treat the provider as down</option>
            </Select>
          </Field>
          <Field label="Username (optional)">
            <TextInput
              value={draft.username}
              onChange={(e) => setDraft((d) => ({ ...d, username: e.target.value }))}
              autoComplete="off"
            />
          </Field>
          <Field
            label="Password (optional)"
            hint={data?.settings?.hasPassword ? "A password is stored — leave blank to keep it." : undefined}
          >
            <TextInput
              type="password"
              value={draft.password}
              onChange={(e) => setDraft((d) => ({ ...d, password: e.target.value }))}
              autoComplete="new-password"
            />
          </Field>
        </div>
        <div className="flex items-center gap-2">
          <Toggle
            checked={draft.enabled}
            onChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
            label="Use my proxy for my data-source traffic"
          />
          <span className="text-[length:var(--con-fs-sm)]">Use my proxy for my data-source traffic</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Btn variant="primary" onClick={save} disabled={busy || !draft.host.trim()}>
            Save proxy settings
          </Btn>
          <Btn onClick={test} disabled={testing}>
            {testing ? "Testing…" : "Test egress"}
          </Btn>
          {data?.settings && (
            <Btn onClick={clear} disabled={busy}>
              Remove my proxy
            </Btn>
          )}
        </div>
        {testResult && (
          <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">
            {testResult.ok
              ? `Egress OK — data sources see ${testResult.egressIp ?? "an IP"} (${testResult.source}${
                  testResult.proxyHost ? ` via ${testResult.proxyHost}` : ""
                }, ${testResult.latencyMs}ms).`
              : `Egress test failed: ${testResult.error ?? "unknown error"}`}
          </p>
        )}
      </div>
    </Card>
  );
}
