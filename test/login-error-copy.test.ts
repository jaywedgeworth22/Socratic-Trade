import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loginErrorSentences } from "../src/lib/auth/login-error";

describe("loginErrorSentences (Auth.js ?error= on /login)", () => {
  it("explains AccessDenied like the access-denied page does", () => {
    const s = loginErrorSentences("AccessDenied");
    expect(s).not.toBeNull();
    expect(s!.join(" ")).toMatch(/isn't permitted/);
    expect(s!.join(" ")).toMatch(/allowlist/);
  });

  it("has distinct copy for Configuration and Verification", () => {
    expect(loginErrorSentences("Configuration")!.join(" ")).toMatch(/configured/);
    expect(loginErrorSentences("Verification")!.join(" ")).toMatch(/no longer valid/);
  });

  it("returns a generic retry line for unknown codes and never echoes the raw code", () => {
    const s = loginErrorSentences("<script>alert(1)</script>");
    expect(s).toEqual(["Sign-in didn't complete.", "Try again, or use a different sign-in method."]);
    expect(s!.join(" ")).not.toContain("script");
  });

  it("takes the first value of a repeated parameter and ignores absent or blank values", () => {
    expect(loginErrorSentences(["AccessDenied", "Configuration"])).toEqual(loginErrorSentences("AccessDenied"));
    expect(loginErrorSentences(undefined)).toBeNull();
    expect(loginErrorSentences("   ")).toBeNull();
    expect(loginErrorSentences(42)).toBeNull();
  });

  it("keeps every message as separate sentences so the page can join them with SENTENCE_GAP", () => {
    for (const code of ["AccessDenied", "Configuration", "Verification", "Other"]) {
      const s = loginErrorSentences(code)!;
      expect(s.length).toBeGreaterThanOrEqual(2);
      for (const sentence of s) expect(sentence).not.toMatch(/\.\s{2,}\S/);
    }
  });
});

describe("login page wiring (PR #3396 review findings)", () => {
  const page = readFileSync(resolve("app/login/page.tsx"), "utf8");

  it("renders the Auth.js error and joins sentences with SENTENCE_GAP", () => {
    expect(page).toContain("loginErrorSentences(searchParams?.error)");
    expect(page).toContain("errorSentences.join(SENTENCE_GAP)");
    expect(page).toContain('role="alert"');
  });

  it("does not gate on x-authenticated-user-email (stripped on the public /login path)", () => {
    expect(page).not.toContain("AUTHENTICATED_EMAIL_HEADER");
    expect(page).not.toMatch(/headers\(\)/);
  });
});
