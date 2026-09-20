import { beforeAll, afterAll } from "vitest";

const originalFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = async (...args) => {
    const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].toString() : (args[0] as Request).url;
    // We can allow some local fetches if needed, but for now block all
    if (url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")) {
      return originalFetch(...args);
    }
    throw new Error(`Unmocked outbound fetch to ${url}`);
  };
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});
