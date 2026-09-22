/// The native Sign in with Apple audience must exactly match the app target's
/// registered bundle identifier. A deployment override remains available for
/// staged Apple service identifiers, but blank values cannot break native auth.
export const NATIVE_APPLE_CLIENT_ID = "trade.socratic.ios";

export function resolveAppleClientIds(value = process.env.APPLE_CLIENT_ID): string[] {
  const ids = [NATIVE_APPLE_CLIENT_ID];
  if (value?.trim() && value.trim() !== NATIVE_APPLE_CLIENT_ID) {
    ids.push(value.trim());
  }
  return ids;
}
