import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  openSentryFeedback,
  SENTRY_CLIENT_DENY_URLS,
  SENTRY_CLIENT_IGNORE_ERRORS
} from "../instrumentation-client";

describe("instrumentation-client Sentry feedback", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("exports openSentryFeedback function", () => {
    expect(typeof openSentryFeedback).toBe("function");
  });

  it("safely handles openSentryFeedback when Sentry.getFeedback is absent", () => {
    expect(() => openSentryFeedback()).not.toThrow();
  });

  it("triggers createForm and opens feedback when window.Sentry.getFeedback is present", async () => {
    const openMock = vi.fn();
    const appendToDomMock = vi.fn();
    const createFormMock = vi.fn().mockResolvedValue({
      appendToDom: appendToDomMock,
      open: openMock
    });

    (globalThis as unknown as { window: unknown }).window = {
      Sentry: {
        getFeedback: () => ({
          createForm: createFormMock
        })
      }
    };

    openSentryFeedback();
    expect(createFormMock).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    expect(appendToDomMock).toHaveBeenCalledTimes(1);
    expect(openMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * These filters exist to drop THIRD-PARTY browser noise (SOCRATIC-TRADE-2J: a
 * Cloudflare edge beacon reading the Chromium-only `chrome` global, which throws
 * on Safari). The real hazard is not that a pattern is missing — it is that
 * someone later broadens one and silently swallows a genuine client error on a
 * live trading app. These tests pin both the intended matches and, more
 * importantly, the non-matches.
 */
describe("instrumentation-client Sentry noise filters", () => {
  const matchesAny = (patterns: RegExp[], value: string) =>
    patterns.some((p) => p.test(value));

  it("drops the Cloudflare beacon's Safari ReferenceError", () => {
    expect(matchesAny(SENTRY_CLIENT_IGNORE_ERRORS, "ReferenceError: Can't find variable: chrome")).toBe(true);
    expect(matchesAny(SENTRY_CLIENT_IGNORE_ERRORS, "ReferenceError: chrome is not defined")).toBe(true);
  });

  it("drops benign ResizeObserver layout-loop notices", () => {
    expect(matchesAny(SENTRY_CLIENT_IGNORE_ERRORS, "ResizeObserver loop limit exceeded")).toBe(true);
    expect(matchesAny(SENTRY_CLIENT_IGNORE_ERRORS, "ResizeObserver loop completed with undelivered notifications.")).toBe(true);
  });

  it("does NOT swallow our own errors", () => {
    for (const ours of [
      "TypeError: Cannot read properties of undefined (reading 'frac')",
      "Error: order placement failed: broker rejected",
      "TypeError: Failed to fetch",
      "Error: chrome://flags is not a valid account number",
      "Error: ResizeObserver is not defined"
    ]) {
      expect(matchesAny(SENTRY_CLIENT_IGNORE_ERRORS, ours)).toBe(false);
    }
  });

  it("denies extension origins without denying our own", () => {
    for (const ext of [
      "chrome-extension://abcdef/content.js",
      "moz-extension://abcdef/content.js",
      "safari-web-extension://abcdef/content.js",
      "safari-extension://abcdef/content.js"
    ]) {
      expect(matchesAny(SENTRY_CLIENT_DENY_URLS, ext)).toBe(true);
    }
    for (const ours of [
      "https://socratictrade.com/_next/static/chunks/main.js",
      "https://socratictrade.com/console"
    ]) {
      expect(matchesAny(SENTRY_CLIENT_DENY_URLS, ours)).toBe(false);
    }
  });

  it("stays a short, deliberate list", () => {
    expect(SENTRY_CLIENT_IGNORE_ERRORS.length).toBeLessThanOrEqual(6);
    expect(SENTRY_CLIENT_DENY_URLS.length).toBeLessThanOrEqual(6);
  });
});
