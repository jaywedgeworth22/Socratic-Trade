/**
 * Human copy for the `?error=` code Auth.js appends when it redirects a failed sign-in to
 * `pages.error` (which is `/login`, see src/lib/auth/auth.ts).  Before this existed the login page
 * ignored the parameter, so a rejected sign-in (unverified email, address not on the allowlist, an
 * OAuth misconfiguration) just re-rendered the sign-in buttons with no explanation.
 *
 * Returns sentences, not a joined string: the caller joins with SENTENCE_GAP so the two-space
 * sentence rule survives HTML rendering.  Unknown or absent codes return null for "nothing to say";
 * any other non-empty code gets a generic retry line rather than echoing user-controllable text.
 */
export function loginErrorSentences(code: unknown): string[] | null {
  const value = Array.isArray(code) ? code[0] : code;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;

  switch (normalized) {
    case "AccessDenied":
      return [
        "Your account isn't permitted to use this app.",
        "If you think this is a mistake, ask the owner to add your email to the allowlist."
      ];
    case "Configuration":
      return [
        "Sign-in isn't configured correctly on this server.",
        "Try a different sign-in method, or ask the owner to check the auth provider settings."
      ];
    case "Verification":
      return ["That sign-in link is no longer valid.", "Start again from the button below."];
    default:
      return ["Sign-in didn't complete.", "Try again, or use a different sign-in method."];
  }
}
