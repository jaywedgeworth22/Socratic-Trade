// Minimal login page — redirects unauthenticated users here when authConfigured=true.
// Supports Google, GitHub, and/or Apple OAuth. When neither Auth.js nor CF Access is
// configured, this page is unreachable (middleware falls back to PRIMARY_EMAIL).
//
// force-dynamic: provider availability is read from process.env at request time so
// secrets injected after build (e.g. via Infisical at start:secrets) are reflected
// immediately without a rebuild.

import { isAppleWebAuthConfigured } from "../../src/lib/auth/apple-web";
import { signIn } from "../../src/lib/auth/auth";
import { sanitizeCallbackUrl } from "../../src/lib/auth/callback-url";
import { SENTENCE_GAP } from "../console/lib/format";
import { HeaderLogo } from "../console/ui/header-logo";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

const googleConfigured = !!(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
const githubConfigured = !!(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET);
const twitterConfigured = !!(process.env.AUTH_TWITTER_ID && process.env.AUTH_TWITTER_SECRET);
const appleConfigured = isAppleWebAuthConfigured();
const anyProviderConfigured = googleConfigured || githubConfigured || twitterConfigured || appleConfigured;

/** Value props — keep in sync with iOS LoginView feature bullets. */
const LOGIN_VALUE_BULLETS = [
  "Configure framework and guardrails",
  "Review and approve proposals",
  "Track positions, orders, and performance",
  "Control the backend agent without moving credentials onto the device"
] as const;

export default async function LoginPage(props: { searchParams?: Promise<{ callbackUrl?: string | string[] }> }) {
  const searchParams = await props.searchParams;
  const rawCallbackUrl = typeof searchParams?.callbackUrl === "string" ? searchParams.callbackUrl : undefined;
  const callbackUrl = sanitizeCallbackUrl(rawCallbackUrl);

  return (
    <main className="grid min-h-screen place-items-center bg-bg px-6 text-center">
      <div className="w-full max-w-md space-y-6">
        <h1 className="sr-only">Sign in to Socratic Trade</h1>
        <div className="flex justify-center mb-2 px-4 overflow-hidden">
          <HeaderLogo height={30} />
        </div>

        <ul className="mx-auto max-w-sm space-y-2.5 rounded-md border border-line bg-surface px-4 py-3.5 text-left">
          {LOGIN_VALUE_BULLETS.map((text) => (
            <li key={text} className="flex items-start gap-2.5 text-sm text-fg">
              <span
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                aria-hidden
              />
              <span className="leading-snug">{text}</span>
            </li>
          ))}
        </ul>

        {anyProviderConfigured ? (
          /* One family: Google's Light/Dark chrome, brand only in the mark.
             Matches iOS LoginView.providerButton.  Teal Google was a Google Don't. */
          <div className="mx-auto flex w-full max-w-sm flex-col gap-3">
            {googleConfigured && (
              <form
                action={async () => {
                  "use server";
                  await signIn("google", { redirectTo: callbackUrl });
                }}
              >
                <button type="submit" className="login-provider-btn">
                  <span className="login-provider-mark">
                    <GoogleIcon />
                  </span>
                  Sign in with Google
                </button>
              </form>
            )}
            {githubConfigured && (
              <form
                action={async () => {
                  "use server";
                  await signIn("github", { redirectTo: callbackUrl });
                }}
              >
                <button type="submit" className="login-provider-btn">
                  <span className="login-provider-mark login-provider-mark--github">
                    <GitHubIcon />
                  </span>
                  Sign in with GitHub
                </button>
              </form>
            )}
            {twitterConfigured && (
              <form
                action={async () => {
                  "use server";
                  await signIn("twitter", { redirectTo: callbackUrl });
                }}
              >
                <button type="submit" className="login-provider-btn">
                  <span className="login-provider-mark">
                    <XIcon />
                  </span>
                  Sign in with X
                </button>
              </form>
            )}
            {appleConfigured && (
              <>
                <form
                  action={async () => {
                    "use server";
                    await signIn("apple", { redirectTo: callbackUrl });
                  }}
                >
                  <button type="submit" className="login-provider-btn login-provider-btn--apple">
                    <span className="login-provider-mark">
                      <AppleIcon />
                    </span>
                    Sign in with Apple
                  </button>
                </form>
                {!googleConfigured && !githubConfigured && !twitterConfigured && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    Apple is your only sign-in method.  Apple only sends your email on first
                    authorization — if your session expires, you will need to add Google,
                    GitHub, or X as a fallback to sign back in.
                  </p>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="rounded-md border border-line bg-surface px-4 py-3 text-sm text-muted">
            <p>Auth provider not configured.</p>
            <p className="mt-1 text-xs">
              Set <code className="font-mono">AUTH_GOOGLE_ID</code> /{" "}
              <code className="font-mono">AUTH_GOOGLE_SECRET</code> for Google,{" "}
              <code className="font-mono">AUTH_GITHUB_ID</code> /{" "}
              <code className="font-mono">AUTH_GITHUB_SECRET</code> for GitHub,{" "}
              <code className="font-mono">AUTH_TWITTER_ID</code> /{" "}
              <code className="font-mono">AUTH_TWITTER_SECRET</code> for X, or{" "}
              <code className="font-mono">AUTH_APPLE_ID</code> /{" "}
              <code className="font-mono">AUTH_APPLE_SECRET</code> for Apple sign-in.
            </p>
          </div>
        )}

        <div className="space-y-2">
          <p className="text-xs text-muted leading-relaxed">
            By signing in, you agree to the Terms and Privacy Policy linked below.
            {SENTENCE_GAP}AI generated proposals, behaviors, and actions are not guaranteed
            though strategic framework is customizable and defined by each user.
            {SENTENCE_GAP}Site and app do not provide financial or investment advice and were
            made for educational, experimental, and/or informational use only.
          </p>
          <p className="flex justify-center gap-4 text-xs">
            <a href="/terms-and-conditions" className="underline underline-offset-2 hover:text-fg">
              Terms
            </a>
            <a href="/privacy-policy" className="underline underline-offset-2 hover:text-fg">
              Privacy
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z"
        fill="#34A853"
      />
      <path
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z"
        fill="#EA4335"
      />
    </svg>
  );
}

function GitHubIcon() {
  // Official Invertocat from brand.github.com/GitHub_Logos.zip (same asset
  // iOS ships as GitHubMark.imageset).  currentColor so it is black on the
  // light button and white on the dark one — GitHub's only mark constraint.
  return (
    <svg width="18" height="18" viewBox="0 0 98 96" aria-hidden="true" fill="currentColor">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.342-5.867-16.342-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-2.15.334-2.15.334-2.15 4.934.326 7.523 5.052 7.523 5.052 4.367 8.455 11.374 6.002 14.119 4.525.448-3.584 1.697-6.002 3.112-7.412-10.814-1.155-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.555-.08 11.856-.08 13.437 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  );
}
