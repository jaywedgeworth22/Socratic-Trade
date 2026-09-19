import { beforeAll } from "vitest";

const originalFetch = global.fetch;

beforeAll(() => {
  global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("http:") || url.startsWith("https:")) {
      // Allowed local loopback for tests using local servers
      if (url.includes("127.0.0.1") || url.includes("localhost")) {
        return originalFetch(input, init);
      }
      throw new Error(`Network request blocked in test: ${url}`);
    }
    return originalFetch(input, init);
  };
});
