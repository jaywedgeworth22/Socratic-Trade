import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import dns from "node:dns";
import { withSentryConfig } from "@sentry/nextjs";

const require = createRequire(import.meta.url);
const webpack = require("webpack");

dns.setDefaultResultOrder("ipv4first");
const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: __dirname,
  async headers() {
    return [
      {
        // PWA kill-switch: leftover workers must revalidate this file, not a cached old worker.
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }]
      },
      {
        // /framework is human-eyes-only: never indexed, cached, archived, or
        // used for AI training. Enforcement is layered — these headers are the
        // published opt-out; the route itself gates on user-agent and renders
        // content client-side only (see app/framework/).
        source: "/framework",
        headers: [
          {
            key: "X-Robots-Tag",
            value: "noindex, nofollow, noarchive, nosnippet, noimageindex, noai, noimageai"
          },
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          // TDM Reservation Protocol (W3C TDMRep): reserve text-and-data-mining rights.
          { key: "tdm-reservation", value: "1" }
        ]
      }
    ];
  },
  serverExternalPackages: ["better-sqlite3", "@pinecone-database/pinecone", "voyageai", "dd-trace", "@sentry/profiling-node", "undici"],
  webpack: (config, { isServer, nextRuntime }) => {
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@": dirname(fileURLToPath(import.meta.url)) + "/src",
    };
    if (!isServer || nextRuntime === "edge") {
      config.resolve.alias = {
        ...config.resolve.alias,
        "better-sqlite3": false,
        "@pinecone-database/pinecone": false,
        "voyageai": false,
        "dd-trace": false,
        "undici": false,
        "node:fs": false,
        "node:path": false,
        "node:http": false,
        "node:crypto": false,
        "node:zlib": false,
        "node:stream": false,
        "node:dns": false,
        "node:net": false,
        "node:os": false,
        "node:child_process": false,
        "node:async_hooks": false,
      };
      // webpack 5 rejects the node: URI scheme before aliases apply
      // (`UnhandledSchemeError` on node:async_hooks via @sentry/nextjs).
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
          resource.request = resource.request.replace(/^node:/, "");
        })
      );
      config.resolve.fallback = {
        ...(config.resolve.fallback ?? {}),
        fs: false,
        path: false,
        util: false,
        crypto: false,
        zlib: false,
        stream: false,
        dns: false,
        net: false,
        os: false,
        http: false,
        async_hooks: false,
        // node:http2 is the APNs provider transport (src/lib/apns.ts, reachable from the
        // src/lib/db.ts barrel). Server-only — stubbed out for client/edge bundles.
        http2: false,
        // child_process is used by r2-cold-snapshot.ts (VACUUM INTO in a child process),
        // reachable via instrumentation -> background-worker-startup -> scheduler. Server-only
        // — stubbed out for client/edge bundles (same trap as http2 / fs / path).
        child_process: false
      };
    }
    if (isServer && nextRuntime === "nodejs") {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : config.externals ? [config.externals] : []),
        "@datadog/native-metrics",
        "@datadog/pprof",
        "@datadog/native-appsec",
        "@datadog/native-iast-taint-tracking",
        "@datadog/wasm-js-rewriter"
      ];
    }
    return config;
  },
  turbopack: {},
  experimental: {
    serverActions: {
      bodySizeLimit: "1mb"
    }
  },
  async redirects() {
    return [
      // Nav labels this destination 'Proposals' (nav.tsx:58 → /console/approvals).
      // An unaided guess of /console/proposals shows Next's stock 404 with no
      // console chrome (see board da8a93bf). Permanent redirect to /approvals.
      { source: "/console/proposals", destination: "/console/approvals", permanent: true }
    ];
  }
};

// Sentry build wrapper: injects the client/server/edge config imports and (when a
// build-time SENTRY_AUTH_TOKEN is present) uploads source maps so production stack
// traces are de-minified. With no auth token it is inert — no upload, no events.
// Source-map upload only runs when org + project + authToken are all set.
export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: process.env.SENTRY_ORG || "jays-services",

  project: process.env.SENTRY_PROJECT || "socratic-trade",

  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Browser envelopes go through this same-origin rewrite so ad-blockers cannot
  // drop client errors. middleware.ts excludes `/monitoring` from its matcher
  // (and lists it as a public prefix) so the tunnel is never auth-gated.
  tunnelRoute: "/monitoring",

  webpack: {
    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  }
});
