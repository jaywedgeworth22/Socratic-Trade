import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card } from "../ui/primitives";
import { DecisionTraceIllustration } from "./decision-trace-illustration";
import { landingPageEnabled } from "@/lib/landing-page";

// Background-revalidate hourly: same fix as the legal pages — the CDN-cached prerender
// was leaving a deployed docs edit stale for up to a year.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: { absolute: "Socratic Trade" },
  description:
    "Socratic Trade is an autonomous market-reasoning desk for inspecting live theses, delegated actions, RAG evidence, dissent, and outcome learning.  Not investment advice.",
  alternates: { canonical: "/welcome" },
  openGraph: {
    type: "website",
    siteName: "Socratic Trade",
    url: "/welcome",
    title: "Socratic Trade",
    description:
      "Autonomous market reasoning with visible theses, evidence, dissent, actions, coaching, and outcome learning.  Not investment advice."
  },
  twitter: {
    card: "summary_large_image",
    title: "Socratic Trade",
    description: "Autonomous market reasoning with visible decisions and outcome learning.  Not investment advice."
  },
  robots:
    process.env.NEXT_PUBLIC_ALLOW_INDEXING === "true"
      ? { index: true, follow: true }
      : { index: false, follow: false, nocache: true }
};

const ACCESS_HREF =
  "mailto:mail@jays.services?subject=Socratic%20Trade%20access";
const PRIMARY_LINK =
  "inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg shadow-sm transition-colors hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 max-sm:min-h-11";
const GHOST_LINK =
  "inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-line bg-surface px-4 text-sm font-medium text-fg transition-colors hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 max-sm:min-h-11";
const PRIMARY_LINK_SM =
  "inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-fg shadow-sm transition-colors hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 max-sm:min-h-11";
const GHOST_LINK_SM =
  "inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-fg transition-colors hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 max-sm:min-h-11";

const FEATURES: Array<{ title: string; body: string }> = [
  {
    title: "Autonomous thesis formation",
    body: "Builds a market thesis from current regime, portfolio state, scan results, and remembered outcomes before it chooses action or restraint."
  },
  {
    title: "Decision trace",
    body: "Every action is framed as a trace: belief, catalyst, size, status, supporting evidence, dissent, and what would make the agent change its mind."
  },
  {
    title: "Evidence attribution",
    body: "Surfaces which data providers, retrieval memories, prior lessons, and market facts influenced the decision instead of hiding behind a single score."
  },
  {
    title: "Dissent by design",
    body: "Bull case, bear case, gate output, and objections stay visible.  Disagreement is a first-class part of the interface, not a buried log line."
  },
  {
    title: "Outcome learning",
    body: "Scores thesis types, regimes, and model choices against actual outcomes so future runs can learn from both successes and failures."
  },
  {
    title: "Coaching and self-improvement",
    body: "You can suggest refocuses or critiques, and Socratic Trade can propose framework improvements for you to accept, reject, or rewrite."
  }
];

const STEPS: Array<{ n: number; title: string; detail: string }> = [
  {
    n: 1,
    title: "Observe the market",
    detail:
      "Socratic Trade watches the market, active account, regime signals, candidates, and prior lessons to decide what kind of opportunity or danger it is seeing."
  },
  {
    n: 2,
    title: "Form a thesis and act under mandate",
    detail:
      "It turns evidence into a thesis, chooses whether to buy, sell, hold, exit, or stand aside within the authority you have delegated, then records why."
  },
  {
    n: 3,
    title: "Explain, learn, and improve",
    detail:
      "It shows the evidence path, dissent, outcome, coaching notes, and proposed framework changes so the next run has a better memory."
  }
];

export default function WelcomePage() {
  if (!landingPageEnabled()) notFound();
  return (
    <>
      {/* JSON-LD structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "Socratic Trade",
            applicationCategory: "FinanceApplication",
            operatingSystem: "Web",
            description:
              "Autonomous market-reasoning desk with visible theses, delegated actions, evidence attribution, dissent, and outcome learning.",
            offers: { "@type": "Offer", price: "0", priceCurrency: "USD" }
          })
        }}
      />

      <div className="min-h-screen bg-bg text-fg">
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <header className="border-b border-line bg-surface/80 backdrop-blur-sm">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
            <span className="text-base font-semibold text-fg">Socratic Trade</span>
            <a href={ACCESS_HREF} className={PRIMARY_LINK_SM}>
              Request access
            </a>
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-6 py-16 space-y-20">
          {/* ── Hero ───────────────────────────────────────────────────────── */}
          <section className="text-center space-y-6">
            <h1 className="text-4xl font-bold tracking-tight text-fg sm:text-5xl">
              Socratic Trade is an autonomy desk for market decisions
            </h1>
            <p className="mx-auto max-w-2xl text-lg text-muted leading-relaxed">
              It watches markets, forms a thesis, can act under delegated authority, and leaves a
              decision trail you can inspect: evidence, memory, dissent, action, outcome, and what it
              thinks should change next.
            </p>
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
              <a href={ACCESS_HREF} className={PRIMARY_LINK}>
                Request access
              </a>
              <a href="/how-it-works" className={GHOST_LINK}>
                Decision framework
              </a>
            </div>
            <p className="text-sm text-faint">Private operator build at socratictrade.com.</p>
          </section>

          {/* ── Features grid ──────────────────────────────────────────────── */}
          <section className="space-y-6">
            <h2 className="text-xl font-semibold text-fg">What it does</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <Card key={f.title} className="p-5 space-y-2">
                  <h3 className="text-sm font-semibold text-fg">{f.title}</h3>
                  <p className="text-sm text-muted leading-relaxed">{f.body}</p>
                </Card>
              ))}
            </div>
            <p className="text-xs text-faint leading-relaxed">
              The core question is visible by design: what did Socratic Trade believe, what changed
              its mind, what did it do, and what should it learn from the result?
            </p>
          </section>

          {/* ── How it works ───────────────────────────────────────────────── */}
          <section className="space-y-6">
            <h2 className="text-xl font-semibold text-fg">How it works</h2>
            <ol className="space-y-4">
              {STEPS.map((s) => (
                <li key={s.n} className="flex gap-4">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg text-sm font-bold">
                    {s.n}
                  </span>
                  <div className="space-y-1 pt-1">
                    <p className="text-sm font-semibold text-fg">{s.title}</p>
                    <p className="text-sm text-muted leading-relaxed">{s.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {/* ── Decision trace illustration ────────────────────────────────── */}
          <section className="space-y-6">
            <div className="space-y-2 text-center">
              <h2 className="text-xl font-semibold text-fg">What a decision trace looks like</h2>
              <p className="mx-auto max-w-2xl text-sm text-muted leading-relaxed">
                A stylized example of the receipt Socratic Trade leaves behind for every proposal:
                who argued for it, who argued against it, and what the policy gate did.
              </p>
            </div>
            <DecisionTraceIllustration />
          </section>

          {/* ── Strategy overview link ─────────────────────────────────────── */}
          <section className="space-y-3 text-center">
            <h2 className="text-xl font-semibold text-fg">How the decision framework works</h2>
            <p className="mx-auto max-w-2xl text-sm text-muted leading-relaxed">
              The interface is organized around a Socratic loop: observe, argue, decide, explain,
              measure, and improve. The agent&apos;s notes should make its judgment inspectable rather
              than asking you to trust a black box.
            </p>
            <a href="/how-it-works" className={GHOST_LINK_SM}>
              Read the full framework overview
            </a>
          </section>

          {/* ── Disclosures ────────────────────────────────────────────────── */}
          <section>
            <Card className="p-6 space-y-4 border-line-strong">
              <h2 className="text-base font-semibold text-fg">Important disclosures</h2>
              <p className="text-sm text-muted leading-relaxed">
                Socratic Trade is software for market research, autonomous reasoning, and trade
                execution when connected to accounts you configure.  It is not investment advice, a
                broker-dealer, or a registered investment adviser.
              </p>
              <p className="text-sm text-muted leading-relaxed">
                Trading and investing involve substantial risk of loss.  Simulated or hypothetical
                performance has inherent limitations and is not a guarantee of future results.
                Nothing here is a recommendation to buy or sell any security.
              </p>
              <p className="text-sm text-muted leading-relaxed">
                You are solely responsible for your own investment decisions.  Consult a licensed
                financial professional before trading.
              </p>
            </Card>
          </section>
        </main>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <footer className="border-t border-line mt-8">
          <div className="mx-auto max-w-5xl px-6 py-8 flex flex-col items-center gap-2 text-center sm:flex-row sm:justify-between">
            <p className="text-xs text-faint">
              Not investment advice.  You set authority.{" "}
              <a href="/terms-and-conditions" className="underline underline-offset-2 hover:text-muted">
                Terms
              </a>
              {" · "}
              <a href="/privacy-policy" className="underline underline-offset-2 hover:text-muted">
                Privacy
              </a>
            </p>
            <p className="text-xs text-faint">
              &copy; 2026 Socratic Trade &middot;{" "}
              <a
                href="mailto:mail@jays.services"
                className="underline underline-offset-2 hover:text-muted"
              >
                mail@jays.services
              </a>
            </p>
          </div>
        </footer>
      </div>
    </>
  );
}
