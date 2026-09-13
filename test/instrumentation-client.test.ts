import { describe, expect, it, vi, beforeEach } from "vitest";
import { openSentryFeedback } from "../instrumentation-client";

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
