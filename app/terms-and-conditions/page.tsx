import type { Metadata } from "next";
import { Card } from "../ui/primitives";

// The CDN-cached prerender (`s-maxage=31536000`) was leaving a deployed docs edit stale
// for up to a year. A docs-only deploy can change the terms the consent gate links to
// without invalidating the CDN copy. Background-revalidate hourly.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Terms and Conditions",
  description: "The terms governing use of Socratic Trade, including SMS notification terms. Not investment advice.",
  alternates: { canonical: "/terms-and-conditions" },
  openGraph: {
    type: "website",
    siteName: "Socratic Trade",
    url: "/terms-and-conditions",
    title: "Socratic Trade Terms and Conditions",
    description: "The terms governing use of Socratic Trade, including SMS notification terms. Not investment advice."
  },
  robots:
    process.env.NEXT_PUBLIC_ALLOW_INDEXING === "true"
      ? { index: true, follow: true }
      : { index: false, follow: false, nocache: true }
};

const PRIMARY_LINK_SM =
  "inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-fg shadow-sm transition-colors hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 max-sm:min-h-11";

const SECTIONS: Array<{ title: string; body: string[] }> = [
  {
    title: "1. Acceptance of terms",
    body: [
      "By accessing or using Socratic Trade (socratictrade.com), you agree to these Terms and Conditions and to our Privacy Policy.  If you do not agree, do not use the service."
    ]
  },
  {
    title: "2. Description of service",
    body: [
      "Socratic Trade is software for market research, autonomous reasoning, and trade execution when connected to brokerage accounts you configure.  It is not investment advice, a broker-dealer, a bank, or a registered investment adviser, and nothing in the service is a recommendation to buy or sell any security.",
      "Trading and investing involve substantial risk of loss.  Simulated, hypothetical, or historical performance has inherent limitations and does not guarantee future results.  You are solely responsible for your own investment decisions and for any authority you grant to a connected trading system."
    ]
  },
  {
    title: "3. Eligibility and accounts",
    body: [
      "You must be at least 18 years old and able to form a binding contract to use the service.  You are responsible for maintaining the confidentiality of your login credentials and for all activity under your account."
    ]
  },
  {
    title: "4. SMS / text message notifications",
    body: [
      "If you opt in to SMS notifications, you consent to receive text messages at the phone number you provide for the account and trading alerts you configure.  Consent to receive SMS is not a condition of using the service — SMS is one of several optional notification channels.",
      "Message frequency varies with your account activity and the alert types you enable.  Message and data rates may apply.",
      "Text STOP to any message to opt out, or disable the SMS channel in Settings at any time.  Text HELP for assistance.",
      "Carriers are not liable for delayed or undelivered messages."
    ]
  },
  {
    title: "5. Connected broker accounts",
    body: [
      "When you connect a broker or exchange account, you authorize Socratic Trade to read account data and, where you configure delegated authority, place orders on your behalf, subject to the guardrails you set.  You can disconnect an account or revoke authority at any time.  You remain responsible for the account and for complying with your broker's own terms."
    ]
  },
  {
    title: "6. Acceptable use",
    body: [
      "You agree not to misuse the service: no attempting to circumvent security, no reverse-engineering, no using the service to violate applicable law or a third party's rights, and no interfering with the service's normal operation."
    ]
  },
  {
    title: "7. Disclaimers",
    body: [
      "The service is provided \"as is\" and \"as available,\" without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose, and non-infringement.  We do not warrant that the service will be uninterrupted, error-free, or that any analysis, thesis, or automated action will be accurate or profitable."
    ]
  },
  {
    title: "8. Shared market-data pool",
    body: [
      "Using the app requires contributing general market data — quotes, fundamentals, price history, and news pulled through your keys or broker — to a shared pool that other accepted users can read.  Personal account data (positions, orders, balances, P&L, credentials, watchlists, and strategy settings) is never pooled.",
      "A shared research corpus may include fact-level notes you choose to contribute.  Risk rules and strategy instructions stay private and are never written to the shared corpus.  See the Privacy Policy for retention and deletion details."
    ]
  },
  {
    title: "9. Limitation of liability",
    body: [
      "To the maximum extent permitted by law, Socratic Trade and its operator are not liable for any indirect, incidental, special, consequential, or punitive damages, or any loss of profits, revenue, data, or trading losses, arising from or related to your use of the service."
    ]
  },
  {
    title: "10. Changes to the service and these terms",
    body: [
      "We may modify or discontinue the service, in whole or part, at any time.  We may update these terms as the service evolves; continued use after an update constitutes acceptance of the revised terms."
    ]
  },
  {
    title: "11. Termination",
    body: [
      "You may stop using the service and disconnect your accounts at any time.  We may suspend or terminate access for violation of these terms or for any reason at our discretion."
    ]
  },
  {
    title: "12. Contact",
    body: ["Questions about these terms: mail@jays.services."]
  }
];

export default function TermsAndConditionsPage() {
  return (
    <div className="min-h-screen bg-bg text-fg">
      <header className="border-b border-line bg-surface/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <span className="text-base font-semibold text-fg">Socratic Trade</span>
          <a href="/welcome" className={PRIMARY_LINK_SM}>
            Home
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-14 space-y-10">
        <section className="space-y-3">
          <h1 className="text-3xl font-bold tracking-tight text-fg sm:text-4xl">Terms and Conditions</h1>
          <p className="text-sm text-faint">Effective date: August 19, 2026</p>
        </section>

        {SECTIONS.map((section) => (
          <section key={section.title} className="space-y-3">
            <h2 className="text-lg font-semibold text-fg">{section.title}</h2>
            <div className="space-y-2">
              {section.body.map((paragraph) => (
                <p key={paragraph} className="text-sm leading-relaxed text-muted">
                  {paragraph}
                </p>
              ))}
            </div>
          </section>
        ))}

        <Card className="p-6 space-y-2 border-line-strong">
          <p className="text-sm leading-relaxed text-muted">
            See also our{" "}
            <a href="/privacy-policy" className="underline underline-offset-2 hover:text-fg">
              Privacy Policy
            </a>
            .
          </p>
        </Card>
      </main>

      <footer className="border-t border-line mt-8">
        <div className="mx-auto max-w-3xl px-6 py-8 flex flex-col items-center gap-2 text-center sm:flex-row sm:justify-between">
          <p className="text-xs text-faint">
            Not investment advice. Trading involves risk of loss.{" "}
            <a href="/welcome" className="underline underline-offset-2 hover:text-muted">
              Home
            </a>
          </p>
          <p className="text-xs text-faint">
            &copy; 2026 Socratic Trade &middot;{" "}
            <a href="mailto:mail@jays.services" className="underline underline-offset-2 hover:text-muted">
              mail@jays.services
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
