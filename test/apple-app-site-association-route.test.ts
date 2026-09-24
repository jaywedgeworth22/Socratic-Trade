import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * The AASA contract is load-bearing for iOS universal links: a wrong content type, a missing
 * appID, or a path the app does not handle all fail silently (links just open Safari).
 */
describe("GET /.well-known/apple-app-site-association", () => {
  it("serves the app's applinks claim as application/json", async () => {
    const { GET } = await import("../app/.well-known/apple-app-site-association/route");

    const response = GET();

    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body.applinks.details).toHaveLength(1);
    expect(body.applinks.details[0].appIDs).toEqual([
      "CC8UTF7ATG.com.socratictrade.ios",
      "CC8UTF7ATG.trade.socratic.app"
    ]);
    expect(body.webcredentials.apps).toEqual([
      "CC8UTF7ATG.com.socratictrade.ios",
      "CC8UTF7ATG.trade.socratic.app"
    ]);
  });

  it("claims exactly the routes the iOS app routes, and nothing broader", async () => {
    const { APPLE_APP_SITE_ASSOCIATION } = await import(
      "../app/.well-known/apple-app-site-association/route"
    );

    const paths = APPLE_APP_SITE_ASSOCIATION.applinks.details[0].components.map((c) => c["/"]);

    expect(paths).toEqual([
      "/console/approvals",
      "/console/approvals/*",
      "/console/orders",
      "/console/watchlist",
      "/console/activity",
      "/console/assistant",
      "/console/scan",
      "/console/guardrails",
      "/console/results"
    ]);
    // A bare "/*" would hijack every link to the site into the app.
    expect(paths).not.toContain("/*");
    expect(paths).not.toContain("*");
    // Broker connect + strategy universe are Safari handoffs from iOS.  Claiming
    // them here would swallow the tap back into a screen the phone does not have.
    expect(paths).not.toContain("/console/connections");
    expect(paths).not.toContain("/console/strategy");
  });

  it("stays anonymously reachable through the edge middleware once auth is configured", async () => {
    // Without this the request falls through to the auth-unconfigured local fallback and the
    // assertion would pass even if the path were gated.
    vi.stubEnv("AUTH_SECRET", "test-secret");
    const { middleware } = await import("../middleware");

    const response = await middleware(
      new NextRequest("https://socratictrade.com/.well-known/apple-app-site-association", {
        headers: { host: "socratictrade.com" }
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("serves webcredentials with both team-qualified app IDs during coexistence", async () => {
    const { APPLE_APP_SITE_ASSOCIATION } = await import(
      "../app/.well-known/apple-app-site-association/route"
    );
    expect(APPLE_APP_SITE_ASSOCIATION.webcredentials.apps).toEqual([
      "CC8UTF7ATG.com.socratictrade.ios",
      "CC8UTF7ATG.trade.socratic.app"
    ]);
  });
});
