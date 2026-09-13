/**
 * Sanitize callbackUrl to ensure it is a safe relative path and never protocol-relative
 * (e.g. //evil.com), Windows-style (/\evil.com), or an absolute cross-origin URL.
 */
export function sanitizeCallbackUrl(url: unknown): string {
  if (typeof url !== "string") return "/";
  const trimmed = url.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.startsWith("/\\")) {
    return "/";
  }
  return trimmed;
}
