import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isBlockedProxyHost,
  validateProxySettingsInput
} from "../src/lib/user-proxy-settings";

describe("validateProxySettingsInput", () => {
  it("accepts a minimal valid config", () => {
    const r = validateProxySettingsInput({ host: "10.99.0.2", port: 8888 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.protocol).toBe("http");
      expect(r.value.failureMode).toBe("fail_soft");
      expect(r.value.enabled).toBe(true);
    }
  });
  it("rejects bad protocol / port / failure mode", () => {
    expect(validateProxySettingsInput({ host: "h", protocol: "socks5" }).ok).toBe(false);
    expect(validateProxySettingsInput({ host: "h", port: 0 }).ok).toBe(false);
    expect(validateProxySettingsInput({ host: "h", port: 70000 }).ok).toBe(false);
    expect(validateProxySettingsInput({ host: "h", failureMode: "ignore" }).ok).toBe(false);
  });
  it("rejects a host with scheme/path/credentials embedded", () => {
    expect(validateProxySettingsInput({ host: "http://10.99.0.2" }).ok).toBe(false);
    expect(validateProxySettingsInput({ host: "u:p@10.99.0.2" }).ok).toBe(false);
    expect(validateProxySettingsInput({ host: "10.99.0.2/x" }).ok).toBe(false);
  });
  it("blocks loopback, link-local and localhost but allows RFC1918 (WireGuard mesh)", () => {
    for (const host of ["localhost", "x.localhost", "127.0.0.1", "169.254.169.254", "::1"]) {
      expect(isBlockedProxyHost(host), host).toBe(true);
      expect(validateProxySettingsInput({ host }).ok, host).toBe(false);
    }
    for (const host of ["10.99.0.2", "192.168.8.1", "mango.lan"]) {
      expect(isBlockedProxyHost(host), host).toBe(false);
    }
  });
  it("requires a username when a password is set", () => {
    expect(validateProxySettingsInput({ host: "h", password: "p" }).ok).toBe(false);
    expect(validateProxySettingsInput({ host: "h", username: "u", password: "p" }).ok).toBe(true);
  });
});

describe("user proxy settings storage (real temp DB)", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-user-proxy-${randomUUID()}.db`)}`;
  });

  it("round-trips upsert/view/resolve/delete with the password never exposed in the view", async () => {
    const mod = await import("../src/lib/user-proxy-settings");
    const parsed = validateProxySettingsInput({
      host: "10.99.0.2",
      port: 8888,
      username: "jay",
      password: "s3cret",
      failureMode: "fail_closed"
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const view = mod.upsertUserProxySettings("user-a", parsed.value);
    expect(view.hasPassword).toBe(true);
    expect(JSON.stringify(view)).not.toContain("s3cret");

    const resolved = mod.resolveUserProxy("user-a");
    expect(resolved?.proxyUrl).toBe("http://jay:s3cret@10.99.0.2:8888");
    expect(resolved?.failureMode).toBe("fail_closed");

    mod.deleteUserProxySettings("user-a");
    expect(mod.getUserProxySettingsView("user-a")).toBeUndefined();
    expect(mod.resolveUserProxy("user-a")).toBeUndefined();
  });

  it("returns undefined for unknown or disabled users", async () => {
    const mod = await import("../src/lib/user-proxy-settings");
    expect(mod.resolveUserProxy("nobody")).toBeUndefined();
    const parsed = validateProxySettingsInput({ host: "10.99.0.2", enabled: false });
    if (parsed.ok) mod.upsertUserProxySettings("user-b", parsed.value);
    expect(mod.resolveUserProxy("user-b")).toBeUndefined();
  });
});
