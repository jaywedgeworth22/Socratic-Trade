import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { ALPACA_BROKER_IO_DEADLINE_MS } from "../src/lib/inflight-deadline";

// Alpaca's SDK calls the CommonJS axios build with no timeout (axios default 0 = wait forever), so a
// half-open broker socket can hang a request indefinitely.  src/lib/alpaca.ts bounds that by setting
// `defaults.timeout` on the CJS axios instance the SDK itself `require()`s.  This pins that the bound
// is actually applied to the instance the SDK sees, and that alpaca.ts does not reach for the
// `module` builtin (webpack cannot resolve it in the edge compile of instrumentation.ts, which
// broke `next build` on PR #3313).
describe("Alpaca SDK axios timeout", () => {
  it("applies the broker I/O deadline to the CJS axios instance the SDK requires", async () => {
    await import("../src/lib/alpaca");
    const sdkRequire = createRequire(import.meta.url);
    const axios = sdkRequire("axios") as { defaults: { timeout?: number } };
    expect(axios.defaults.timeout).toBe(ALPACA_BROKER_IO_DEADLINE_MS);
    expect(ALPACA_BROKER_IO_DEADLINE_MS).toBeGreaterThan(0);
  });

  it("does not import the node 'module' builtin (unresolvable in the edge instrumentation bundle)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), "src/lib/alpaca.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["'](?:node:)?module["']/);
    expect(source).not.toMatch(/createRequire\s*\(/);
  });
});
