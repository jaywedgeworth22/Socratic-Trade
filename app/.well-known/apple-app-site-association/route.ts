import { NextResponse } from "next/server";

/**
 * Apple App Site Association — the domain half of universal links.
 *
 * Apple's CDN fetches https://socratictrade.com/.well-known/apple-app-site-association with NO
 * file extension and requires `application/json`, which is exactly why this is a route handler
 * (a `public/` file would need the extension to get the right content type). It must also be
 * anonymously reachable: the edge middleware's PUBLIC_PREFIXES carries this path, otherwise
 * every fetch would 307 to /login and the domain would silently never claim the app.
 *
 * `paths` is limited to the routes the iOS app actually handles (ios/SocraticTrade/
 * DeepLink.swift). Claiming more would swallow links into Safari-only pages.
 */
export const APPLE_APP_SITE_ASSOCIATION = {
  applinks: {
    details: [
      {
        appIDs: ["CC8UTF7ATG.trade.socratic.ios"],
        components: [
          { "/": "/console/approvals", comment: "Proposals tab" },
          { "/": "/console/approvals/*", comment: "One specific proposal" },
          { "/": "/console/orders", comment: "Assets tab (orders)" },
          { "/": "/console/watchlist", comment: "Assets tab (watchlist)" },
          { "/": "/console/activity", comment: "Activity tab" },
          { "/": "/console/assistant", comment: "Coach chat" },
          { "/": "/console/scan", comment: "Scan table" },
          { "/": "/console/guardrails", comment: "Guardrails" },
          { "/": "/console/results", comment: "Results" }
        ]
      }
    ]
  }
} as const;

export const dynamic = "force-static";

export function GET() {
  return NextResponse.json(APPLE_APP_SITE_ASSOCIATION, {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=3600"
    }
  });
}
