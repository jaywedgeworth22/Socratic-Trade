/// Native Sign in with Apple audiences MUST match the iOS app target's registered
/// bundle identifier. During the 2026-09-22 bundle rename (`trade.socratic.app` →
/// `trade.socratic.ios`) both native IDs are accepted so old TestFlight installs
/// keep authenticating until they are retired.
///
/// `APPLE_CLIENT_ID` is the *web* Services ID (Sign in with Apple on the website).
/// It is NOT a substitute for the legacy native ID — do not rely on that env alone
/// to keep `trade.socratic.app` working during the migration window.
export const NATIVE_APPLE_CLIENT_ID = "trade.socratic.ios";

/** Legacy native audience — keep until old TestFlight builds are retired. */
export const LEGACY_NATIVE_APPLE_CLIENT_ID = "trade.socratic.app";

/** Both native audiences accepted during the coexistence window. */
export const NATIVE_APPLE_CLIENT_IDS: readonly string[] = [
  NATIVE_APPLE_CLIENT_ID,
  LEGACY_NATIVE_APPLE_CLIENT_ID
];

export function resolveAppleClientIds(value = process.env.APPLE_CLIENT_ID): string[] {
  const ids = [...NATIVE_APPLE_CLIENT_IDS];
  const trimmed = value?.trim();
  // APPLE_CLIENT_ID is the web Service ID — append only when distinct from both natives.
  if (trimmed && !ids.includes(trimmed)) {
    ids.push(trimmed);
  }
  return ids;
}
