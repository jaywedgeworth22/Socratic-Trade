// Secrets-source marker + boot guard.
//
// The secrets-manager runner (scripts/infisical-run.mjs) injects `SECRETS_SOURCE` into the process
// env when it launches the app, recording that secrets came from a manager rather than a plain
// `npm run dev`. When `REQUIRE_SECRETS_MANAGER` is set, the app refuses to boot unless that marker
// is present — so a credential can never silently be served out of a local dotenv file (or any non-
// Infisical path) in a deployment that's supposed to source everything from Infisical.  Default
// OFF → zero behavior change for local dev (where `npm run dev:secrets` is the canonical start
// path), CI, and tests. Owner directive 2026-09-18: prod INFISICAL is the sole source of truth —
// no `.env` files. See docs/secrets.md + docs/rollouts/2026-09-18-strict-infisical-no-env-files.md.

export type SecretsSource = "infisical" | "env";

/** Which runner launched the app, or "env" when started plainly (no secrets manager). */
export function secretsSource(): SecretsSource {
  const raw = (process.env.SECRETS_SOURCE ?? "").trim().toLowerCase();
  if (raw === "infisical") return raw;
  return "env";
}

function isManagerRequired(): boolean {
  const v = (process.env.REQUIRE_SECRETS_MANAGER ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/**
 * Returns a human-readable problem string when the secrets-manager requirement is violated, else
 * null. Pure (reads only env) so it's directly unit-testable.
 */
export function secretsManagerProblem(): string | null {
  if (!isManagerRequired()) return null;
  if (secretsSource() === "env") {
    return (
      "REQUIRE_SECRETS_MANAGER is set, but the app was NOT launched through a secrets-manager runner " +
      "(SECRETS_SOURCE is unset). Start it via `npm run start:secrets` (or `npm run dev:secrets` for " +
      "local dev) so secrets come from Infisical and not a local `.env` file. To intentionally " +
      "disable this guard, unset REQUIRE_SECRETS_MANAGER. See docs/secrets.md."
    );
  }
  return null;
}

/** Boot guard — throws when the secrets-manager requirement is violated. Call once at server start. */
export function assertSecretsManagerIfRequired(): void {
  const problem = secretsManagerProblem();
  if (problem) throw new Error(`[secrets] ${problem}`);
}