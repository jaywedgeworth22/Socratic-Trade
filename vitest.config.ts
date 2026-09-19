import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Per-run temp root for everything the test runtime derives from os.tmpdir() /
// $TMPDIR — most importantly the per-file temp SQLite databases
// (`DATABASE_URL=file:<tmpdir>/agentic-*.db`), which historically leaked into the
// shared OS temp dir forever. Overriding TMPDIR/TMP/TEMP for the test env funnels
// all of it into this one directory; test/global-setup.ts creates it, removes it on
// teardown, and reaps stale leftovers from crashed runs. The pid+time name keeps
// concurrent runs on the same machine fully isolated.
const runTmpRoot = join(
  tmpdir(),
  `agentic-vitest-${process.pid.toString(36)}-${Date.now().toString(36)}`
);
// Same-process handoff to test/global-setup.ts (its primary channel is the resolved
// config env; this is the fallback).
process.env.AGENTIC_VITEST_TMPDIR = runTmpRoot;

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@/": resolve(__dirname, "./src/"),
      "server-only": resolve(__dirname, "./test/mocks/server-only.ts")
    }
  },
  test: {
    maxWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Skip Vitest's console spy.  `onConsoleLog: () => false` still forwards every
    // log over RPC (`onUserConsoleLog`); if the worker tears down while one is in
    // flight, CI fails with EnvironmentTeardownError even when every test passed
    // (hit on main after #3162, attributed to economic-calendar-prompt-wiring).
    disableConsoleIntercept: true,
    globalSetup: "./test/global-setup.ts",
    setupFiles: ["./test/setup-peer-lane-cleanup.ts", "./test/setup-fetch-mock.ts"],
    // Force isTradingDay()'s no-argument "today" check true so strategy/scheduler tests don't flake
    // on real market holidays/weekends (see isTradingDay in src/lib/market-calendar.ts). The override
    // there is additionally gated on process.env.VITEST, so a stray copy of this flag in a dev/prod
    // shell can never defeat the real market-closed guard. Explicit-date calendar calls ignore it.
    // TMPDIR/TMP/TEMP: os.tmpdir() honors TMPDIR on unix and TMP/TEMP on Windows, and several tests
    // read process.env.TMPDIR directly — all three point at the per-run root above so no temp DB can
    // land loose in the shared OS temp dir.
    env: {
      AGENTIC_TEST_FORCE_TRADING_DAY: "1",
      OPENROUTER_API_URL: "https://openrouter.ai/api/v1/chat/completions",
      TMPDIR: runTmpRoot,
      TMP: runTmpRoot,
      TEMP: runTmpRoot,
      // Optional FilingAPI key must not leak from the Cloud/CI shell into the
      // cascade (a dead 401 key would open real sockets and time out strategy tests).
      FILINGAPI: "",
      FILINGAPI_KEY: "",
      FILING_API_KEY: ""
    },
    exclude: [
      "node_modules/**",
      ".next/**",
      ".claude/**",
      ".agents/**",
      ".cursor/**",
      ".codex/**",
      "test/e2e/**",
      "reference/**",
      ".worktrees/**",
      // node:test suites (run via `node --test` in ci.yml).  Vitest's default
      // **/*.test.mjs include otherwise loads them and fails "No test suite found".
      "scripts/**/*.test.mjs"
    ]
  }
});
