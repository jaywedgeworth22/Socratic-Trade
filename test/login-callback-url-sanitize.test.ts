import { describe, expect, it } from "vitest";
import { sanitizeCallbackUrl } from "../src/lib/auth/callback-url";

describe("sanitizeCallbackUrl", () => {
  it("allows standard relative paths", () => {
    expect(sanitizeCallbackUrl("/console")).toBe("/console");
    expect(sanitizeCallbackUrl("/console/trades?symbol=AAPL")).toBe("/console/trades?symbol=AAPL");
    expect(sanitizeCallbackUrl("/settings")).toBe("/settings");
    expect(sanitizeCallbackUrl("/")).toBe("/");
  });

  it("rejects protocol-relative open redirect URLs", () => {
    expect(sanitizeCallbackUrl("//evil.com")).toBe("/");
    expect(sanitizeCallbackUrl("//evil.com/path")).toBe("/");
    expect(sanitizeCallbackUrl("///evil.com")).toBe("/");
    expect(sanitizeCallbackUrl("//sub.domain.com/test?q=1")).toBe("/");
  });

  it("rejects Windows-style slash redirects", () => {
    expect(sanitizeCallbackUrl("/\\evil.com")).toBe("/");
    expect(sanitizeCallbackUrl("/\\/evil.com")).toBe("/");
  });

  it("rejects absolute URLs and arbitrary protocols", () => {
    expect(sanitizeCallbackUrl("https://evil.com")).toBe("/");
    expect(sanitizeCallbackUrl("http://evil.com")).toBe("/");
    expect(sanitizeCallbackUrl("javascript:alert(1)")).toBe("/");
    expect(sanitizeCallbackUrl("data:text/html,test")).toBe("/");
  });

  it("rejects invalid, nullish, or non-string inputs", () => {
    expect(sanitizeCallbackUrl(null)).toBe("/");
    expect(sanitizeCallbackUrl(undefined)).toBe("/");
    expect(sanitizeCallbackUrl("")).toBe("/");
    expect(sanitizeCallbackUrl("   ")).toBe("/");
    expect(sanitizeCallbackUrl(12345)).toBe("/");
    expect(sanitizeCallbackUrl({})).toBe("/");
  });
});
