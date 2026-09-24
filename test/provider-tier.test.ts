import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateDataProviderHonesty,
  isDataProvidersDegraded,
  isProviderTierCheckDue,
  probeFmpTier,
  probeMassiveTier,
  runProviderTierCheck,
  getProviderTierStatus,
  tierChangeMessage
} from "../src/lib/provider-tier";
import { registerPlanTierLookupForTests } from "../src/lib/provider-tier-plan";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-provtier-${randomUUID()}.db`)}`;
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const isOld = (url: string) => {
  // The history probe queries a ~2.5yr-old window; detect by the `from` date being well in the past.
  const m = url.match(/range\/1\/day\/(\d{4})-/);
  if (!m) return false;
  return Number(m[1]) <= new Date().getUTCFullYear() - 2;
};

describe("probeMassiveTier", () => {
  it("classifies paid when >2yr history is returned", async () => {
    const fetcher = (async (u: string) => jsonRes({ results: isOld(u) ? [{ c: 1 }, { c: 2 }] : [{ c: 9 }] })) as unknown as typeof fetch;
    const r = await probeMassiveTier("k", Date.now(), fetcher);
    expect(r.tier).toBe("paid");
    // Item 24: the structured signal names WHAT WAS TESTED (plan history-depth access), decoupled
    // from availability/freshness — and the prose must say it's a plan-capability check, never a
    // claim about how fresh today's served data is.
    expect(r.signal).toBe("history_depth_confirmed");
    expect(r.reason).toMatch(/plan|capability|access/i);
    expect(r.reason).toMatch(/not today's data freshness/i);
  });
  it("classifies free when the >2yr window comes back empty (2-year cap)", async () => {
    const fetcher = (async (u: string) => jsonRes({ results: isOld(u) ? [] : [{ c: 9 }] })) as unknown as typeof fetch;
    const r = await probeMassiveTier("k", Date.now(), fetcher);
    expect(r.tier).toBe("free");
    expect(r.signal).toBe("history_cap_empty");
  });
  it("classifies free on a single-call 429 (free 5/min cap)", async () => {
    const fetcher = (async () => jsonRes("rate", 429)) as unknown as typeof fetch;
    const r = await probeMassiveTier("k", Date.now(), fetcher);
    expect(r.tier).toBe("free");
    expect(r.signal).toBe("rate_limited_429");
  });
  it("classifies free when >2yr history is 403-blocked", async () => {
    const fetcher = (async (u: string) => (isOld(u) ? jsonRes("forbidden", 403) : jsonRes({ results: [{ c: 9 }] }))) as unknown as typeof fetch;
    const r = await probeMassiveTier("k", Date.now(), fetcher);
    expect(r.tier).toBe("free");
    expect(r.signal).toBe("history_cap_blocked");
  });
  it("stays unknown on a bad-key 401 (not a tier signal) or network error", async () => {
    const badKey = (async () => jsonRes("nope", 401)) as unknown as typeof fetch;
    const r1 = await probeMassiveTier("k", Date.now(), badKey);
    expect(r1.tier).toBe("unknown");
    expect(r1.signal).toBe("probe_error");
    const netErr = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    expect((await probeMassiveTier("k", Date.now(), netErr)).tier).toBe("unknown");
  });
  it("is unknown with no key", async () => {
    const r = await probeMassiveTier(undefined);
    expect(r.tier).toBe("unknown");
    expect(r.signal).toBe("no_key");
  });
});

describe("probeFmpTier", () => {
  it("never issues a network probe (FMP direct access retired)", async () => {
    const fetcher = vi.fn(async () => jsonRes([{ priceToEarningsRatioTTM: 30 }])) as unknown as typeof fetch;
    const r = await probeFmpTier("k", fetcher);
    expect(r.tier).toBe("unknown");
    expect(r.signal).toBe("no_key");
    expect(r.reason).toMatch(/retired/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("stays unknown with no key", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const r = await probeFmpTier(undefined, fetcher);
    expect(r.tier).toBe("unknown");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("isProviderTierCheckDue", () => {
  // Note: nothing earlier in this file sets providerTier:lastCheckAt:local, so the first case sees it absent.
  it("is due when never run", () => {
    expect(isProviderTierCheckDue(Date.now(), "local")).toBe(true);
  });
  it("is not due before the interval elapses", async () => {
    const { setInternalSetting } = await import("../src/lib/db");
    const now = Date.now();
    setInternalSetting("providerTier:lastCheckAt:local", new Date(now - 3 * 3600_000).toISOString()); // 3h ago
    expect(isProviderTierCheckDue(now, "local")).toBe(false);
  });
  it("catches up (runs regardless of hour) once 1.5x the interval has elapsed", async () => {
    const { setInternalSetting } = await import("../src/lib/db");
    const now = Date.now();
    setInternalSetting("providerTier:lastCheckAt:local", new Date(now - 40 * 3600_000).toISOString()); // 40h ago > 36h
    expect(isProviderTierCheckDue(now, "local")).toBe(true);
  });
});

describe("data-provider honesty", () => {
  const at = "2026-08-13T12:00:00.000Z";

  it("free + expected-free is not degraded (history_cap_blocked is expected)", () => {
    const observed = {
      tier: "free" as const,
      at,
      reason: "plan-access probe: ~2.5y blocked",
      signal: "history_cap_blocked" as const
    };
    expect(evaluateDataProviderHonesty("massive", observed, "free")).toEqual(
      expect.objectContaining({ degraded: false, cause: "ok" })
    );
    expect(evaluateDataProviderHonesty("massive", observed, "unknown")).toEqual(
      expect.objectContaining({ degraded: false, cause: "ok" })
    );
    expect(evaluateDataProviderHonesty("massive", observed, null)).toEqual(
      expect.objectContaining({ degraded: false, cause: "ok" })
    );
    expect(isDataProvidersDegraded({ massive: observed }, { massive: "free" })).toBe(false);
  });

  it("paid-but-capped is degraded (configured plan should allow the ~2.5y window)", () => {
    const observed = {
      tier: "free" as const,
      at,
      reason: "plan-access probe: ~2.5y blocked HTTP 403",
      signal: "history_cap_blocked" as const
    };
    for (const plan of ["starter", "developer", "advanced"] as const) {
      const honesty = evaluateDataProviderHonesty("massive", observed, plan);
      expect(honesty.degraded).toBe(true);
      expect(honesty.cause).toBe("tier_mismatch");
    }
    expect(isDataProvidersDegraded({ massive: observed }, { massive: "starter" })).toBe(true);
  });

  it("probe failure is degraded (provider is not working)", () => {
    const observed = {
      tier: "unknown" as const,
      at,
      reason: "recent probe network/timeout error",
      signal: "probe_error" as const
    };
    const honesty = evaluateDataProviderHonesty("massive", observed, "free");
    expect(honesty.degraded).toBe(true);
    expect(honesty.cause).toBe("probe_failure");
    expect(isDataProvidersDegraded({ massive: observed }, { massive: "free" })).toBe(true);
    expect(isDataProvidersDegraded({ massive: observed }, { massive: "starter" })).toBe(true);
  });

  it("a lower paid SKU that still matches the probe is healthy", () => {
    const observed = {
      tier: "paid" as const,
      at,
      reason: "plan-access probe: ~2.5y fetched",
      signal: "history_depth_confirmed" as const
    };
    expect(evaluateDataProviderHonesty("massive", observed, "starter").degraded).toBe(false);
    expect(evaluateDataProviderHonesty("massive", observed, "advanced").degraded).toBe(false);
    expect(isDataProvidersDegraded({ massive: observed }, { massive: "starter" })).toBe(false);
  });

  it("does not treat leftover FMP free rows as degraded", () => {
    const observed = {
      tier: "free" as const,
      at,
      reason: "legacy",
      signal: "premium_gated_error" as const
    };
    expect(evaluateDataProviderHonesty("fmp", observed, "premium").degraded).toBe(false);
    expect(isDataProvidersDegraded({ fmp: observed }, { fmp: "premium" })).toBe(false);
  });

  it("does not lapse-alert when the configured plan is free and the probe agrees", () => {
    const msg = tierChangeMessage(
      "massive",
      "paid",
      { tier: "free", reason: "history cap", signal: "history_cap_blocked" },
      "free"
    );
    expect(msg).toBeNull();
  });

  it("lapse-alerts when a paid configured plan is capped", () => {
    const msg = tierChangeMessage(
      "massive",
      "paid",
      { tier: "free", reason: "history cap HTTP 403", signal: "history_cap_blocked" },
      "starter"
    );
    expect(msg?.title).toMatch(/not working at the paid starter plan/i);
  });
});

describe("runProviderTierCheck", () => {
  beforeEach(() => {
    process.env.MASSIVE_API_KEY = "massive-test";
    process.env.FMP_API_KEY = "fmp-test";
    registerPlanTierLookupForTests((service) => (service === "massive" ? "starter" : null));
  });
  afterEach(async () => {
    delete process.env.MASSIVE_API_KEY;
    delete process.env.FMP_API_KEY;
    const { getUserApiKey, LOCAL_USER } = await import("../src/lib/db");
    registerPlanTierLookupForTests((service) => {
      try {
        return getUserApiKey(LOCAL_USER, service)?.planTier ?? null;
      } catch {
        return null;
      }
    });
  });

  it("persists Massive tier and records a provider_degraded alert on a lapse (FMP probe retired)", async () => {
    const { listNotificationEvents } = await import("../src/lib/db");
    // Massive → free (old window empty). FMP is never probed from this app.
    const fetcher = (async (u: string) => {
      if (u.includes("financialmodelingprep.com")) {
        throw new Error("FMP must not be probed from Socratic-Trade");
      }
      return jsonRes({ results: isOld(u) ? [] : [{ c: 9 }] });
    }) as unknown as typeof fetch;

    await runProviderTierCheck({ userId: "local", fetcher });
    const status = getProviderTierStatus("local");
    expect(status.massive?.tier).toBe("free");
    expect(status.fmp).toBeUndefined();
    // Item 24: the structured probe-evidence signal is persisted alongside tier/reason so health
    // consumers can distinguish capability probes from freshness without parsing prose.
    expect(status.massive?.signal).toBe("history_cap_empty");

    const events = listNotificationEvents("local", 50).filter((e) => e.type === "provider_degraded");
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => /not working at the paid starter plan/i.test(e.title))).toBe(true);
  });

  it("does not lapse-alert when Settings already says free and the probe agrees", async () => {
    registerPlanTierLookupForTests((service) => (service === "massive" ? "free" : null));
    const { listNotificationEvents, getDb } = await import("../src/lib/db");
    getDb().prepare("DELETE FROM notification_events").run();
    const fetcher = (async (u: string) => {
      if (u.includes("financialmodelingprep.com")) {
        throw new Error("FMP must not be probed from Socratic-Trade");
      }
      return jsonRes({ results: isOld(u) ? [] : [{ c: 9 }] });
    }) as unknown as typeof fetch;

    await runProviderTierCheck({ userId: "local", fetcher });
    expect(getProviderTierStatus("local").massive?.tier).toBe("free");
    const events = listNotificationEvents("local", 50).filter((e) => e.type === "provider_degraded");
    expect(events).toHaveLength(0);
  });

  it("alerts again when a Massive key is restored to paid (change in either direction)", async () => {
    const { listNotificationEvents, setInternalSetting } = await import("../src/lib/db");
    setInternalSetting("providerTier:status:local", {
      massive: { tier: "free", at: new Date().toISOString(), reason: "prior cap", signal: "history_cap_blocked" }
    });
    const fetcher = (async (u: string) => {
      if (u.includes("financialmodelingprep.com")) {
        throw new Error("FMP must not be probed from Socratic-Trade");
      }
      return jsonRes({ results: [{ c: 9 }] }); // both windows return data → paid
    }) as unknown as typeof fetch;

    await runProviderTierCheck({ userId: "local", fetcher });
    expect(getProviderTierStatus("local").massive?.tier).toBe("paid");
    expect(getProviderTierStatus("local").fmp).toBeUndefined();
    const restored = listNotificationEvents("local", 50).filter((e) => e.type === "provider_degraded" && e.title.includes("PAID"));
    expect(restored.length).toBeGreaterThanOrEqual(1);
  });
});

describe("massive limiter auto-clamp on detected free tier", () => {
  beforeEach(async () => {
    process.env.MASSIVE_REST_MAX_CALLS_PER_MINUTE = "100";
    const massive = await import("../src/lib/market-signals/massive");
    massive.clearMassiveRestBudgetForTests();
    massive.clearMassiveTierClampCacheForTests();
  });
  afterEach(() => { delete process.env.MASSIVE_REST_MAX_CALLS_PER_MINUTE; });

  it("clamps to 5/min when the watchdog flagged Massive as free, despite env=100", async () => {
    const { setInternalSetting } = await import("../src/lib/db");
    const massive = await import("../src/lib/market-signals/massive");
    setInternalSetting("providerTier:status:local", { massive: { tier: "free", at: new Date().toISOString(), reason: "test" } });
    massive.clearMassiveTierClampCacheForTests();
    massive.clearMassiveRestBudgetForTests();
    const now = Date.now();
    let allowed = 0;
    for (let i = 0; i < 8; i++) if (massive.reserveMassiveRestCall(now)) allowed++;
    expect(allowed).toBe(5);
  });

  it("allows the full env limit when Massive is paid", async () => {
    const { setInternalSetting } = await import("../src/lib/db");
    const massive = await import("../src/lib/market-signals/massive");
    setInternalSetting("providerTier:status:local", { massive: { tier: "paid", at: new Date().toISOString(), reason: "test" } });
    massive.clearMassiveTierClampCacheForTests();
    massive.clearMassiveRestBudgetForTests();
    const now = Date.now();
    let allowed = 0;
    for (let i = 0; i < 20; i++) if (massive.reserveMassiveRestCall(now)) allowed++;
    expect(allowed).toBe(20); // well under 100
  });
});
