import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimiter } from "../src/lib/rate-limit";

describe("API security hardening & defensive JSON parsing", () => {
  beforeEach(() => {
    resetRateLimiter();
    vi.clearAllMocks();
  });

  describe("POST /api/orders/cancel", () => {
    it("returns HTTP 400 on malformed JSON body", async () => {
      const { POST } = await import("../app/api/orders/cancel/route");
      const request = new Request("http://localhost/api/orders/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "invalid-json{"
      });
      const response = await POST(request);
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Invalid JSON body");
    });
  });

  describe("POST /api/profiles", () => {
    it("returns HTTP 400 on malformed JSON body", async () => {
      const { POST } = await import("../app/api/profiles/route");
      const request = new Request("http://localhost/api/profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-valid-json"
      });
      const response = await POST(request);
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Invalid JSON body");
    });
  });

  describe("POST /api/consent", () => {
    it("returns HTTP 400 on malformed JSON body", async () => {
      const { POST } = await import("../app/api/consent/route");
      const request = new Request("http://localhost/api/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json"
      });
      const response = await POST(request);
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Invalid JSON body");
    });
  });

  describe("POST /api/mobile/auth/exchange", () => {
    it("returns HTTP 400 on malformed JSON body", async () => {
      const { POST } = await import("../app/api/mobile/auth/exchange/route");
      const request = new Request("http://localhost/api/mobile/auth/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "bad-json{"
      });
      const response = await POST(request);
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Malformed JSON body");
    });

    it("returns HTTP 413 on oversized request payload", async () => {
      const { POST } = await import("../app/api/mobile/auth/exchange/route");
      const oversized = JSON.stringify({ code: "x".repeat(64 * 1024), codeVerifier: "y" });
      const request = new Request("http://localhost/api/mobile/auth/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: oversized
      });
      const response = await POST(request);
      expect(response.status).toBe(413);
      const json = await response.json();
      expect(json.error).toBe("Request body too large");
    });

    it("returns HTTP 429 when client IP exceeds oauth rate limit", async () => {
      const { POST } = await import("../app/api/mobile/auth/exchange/route");
      const clientIp = "192.0.2.1";

      for (let i = 0; i < 10; i++) {
        const req = new Request("http://localhost/api/mobile/auth/exchange", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": clientIp },
          body: JSON.stringify({ code: "c", codeVerifier: "v" })
        });
        const res = await POST(req);
        // Expect 401 (invalid/expired code) because body is valid under limit
        expect(res.status).toBe(401);
      }

      // 11th request from same IP must be rate limited
      const req = new Request("http://localhost/api/mobile/auth/exchange", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": clientIp },
        body: JSON.stringify({ code: "c", codeVerifier: "v" })
      });
      const res = await POST(req);
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBeTruthy();
    });
  });

  describe("POST /api/mobile/auth/apple rate limiting", () => {
    it("returns HTTP 429 when client IP exceeds rate limit", async () => {
      const { POST } = await import("../app/api/mobile/auth/apple/route");
      const clientIp = "192.0.2.2";

      for (let i = 0; i < 10; i++) {
        const req = new Request("http://localhost/api/mobile/auth/apple", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": clientIp },
          body: JSON.stringify({ identityToken: "fake-jwt", name: "User" })
        });
        await POST(req);
      }

      // 11th request should be blocked with 429
      const req = new Request("http://localhost/api/mobile/auth/apple", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": clientIp },
        body: JSON.stringify({ identityToken: "fake-jwt", name: "User" })
      });
      const res = await POST(req);
      expect(res.status).toBe(429);
    });
  });

  describe("POST /api/proposals/from-draft rate limiting", () => {
    it("returns HTTP 429 when user exceeds orders rate limit", async () => {
      const { POST } = await import("../app/api/proposals/from-draft/route");
      const userId = "test-user-rate-limit";

      for (let i = 0; i < 20; i++) {
        const req = new Request("http://localhost/api/proposals/from-draft", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId, draft: { draft_id: `d-${i}`, symbol: "AAPL", side: "buy", quantity: 1 } })
        });
        await POST(req);
      }

      // 21st request from same user should be blocked
      const req = new Request("http://localhost/api/proposals/from-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, draft: { draft_id: "d-21", symbol: "AAPL", side: "buy", quantity: 1 } })
      });
      const res = await POST(req);
      expect(res.status).toBe(429);
    });
  });

  describe("/api/chat error reflection sanitization", () => {
    it("safeErrorMessage strips Bearer tokens and API keys", async () => {
      const { safeErrorMessage } = await import("../src/lib/telemetry-sanitize");
      const errorWithSecret = new Error("Failed to connect: Bearer sk-ant-api03-1234567890abcdef123456 at https://api.anthropic.com");
      const sanitized = safeErrorMessage(errorWithSecret);
      expect(sanitized).not.toContain("sk-ant-api03-1234567890abcdef123456");
      expect(sanitized).toContain("[redacted]");
    });
  });
});
