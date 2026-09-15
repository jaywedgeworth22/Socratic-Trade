import type { Metadata } from "next";
import { Card } from "../ui/primitives";

// The CDN-cached prerender (`s-maxage=31536000`) was leaving a deployed docs edit stale
// for up to a year. A docs-only deploy can change the policy the consent gate links to
// without invalidating the CDN copy. Background-revalidate hourly: the SSR-generated
// HTML/CDN stamp refreshes; stale-while-revalidate keeps page-loads fast in between.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How Socratic Trade collects, uses, and protects account and usage data, including SMS notification data.",
  alternates: { canonical: "/privacy-policy" },
  openGraph: {
    type: "website",
    siteName: "Socratic Trade",
    url: "/privacy-policy",
    title: "Socratic Trade Privacy Policy",
    description: "How Socratic Trade collects, uses, and protects account and usage data, including SMS notification data."
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
    title: "1. Who we are",
    body: [
      "Socratic Trade (socratictrade.com) is a privately operated software product for market research, autonomous reasoning, and trade execution.  It is not a broker-dealer, bank, or registered investment adviser.  This policy explains what information the service collects, how it is used, and how you can control it."
    ]
  },
  {
    title: "2. Information we collect",
    body: [
      "Account information: your email address, authentication credentials, and any profile details you provide.",
      "Connected-account data: broker/API credentials you supply to connect a trading account (e.g. Alpaca, Robinhood), and the account, position, order, and fill data those connections return.  Credentials are encrypted at rest.",
      "Notification preferences: the delivery channels you enable (push, webhook, email, SMS) and the destination for each — including the phone number you provide if you enable SMS notifications.",
      "Usage data: application logs, audit events, and diagnostic information generated as you use the service, used to operate, secure, and improve it."
    ]
  },
  {
    title: "3. SMS / text message notifications",
    body: [
      "If you opt in to SMS notifications in Settings, we use your phone number solely to send you the account and trading alerts you configure (for example: order fills, risk-guardrail events, or daily review summaries).  SMS is off by default and only activates once you enter a number and enable the channel.",
      "Message frequency varies with your account activity and the alert types you enable.",
      "Message and data rates may apply, per your carrier plan.",
      "Reply STOP at any time to opt out of SMS notifications, or disable the SMS channel in Settings.  Reply HELP for help, or contact us at the email below.",
      "We do not sell or share your phone number with third parties for marketing purposes.  It is used only to route the notifications you request, via our SMS delivery provider."
    ]
  },
  {
    title: "4. How we use information",
    body: [
      "To operate the service: authenticate you, execute the account actions you configure, and deliver the notifications you enable.",
      "To secure the service: detect and prevent unauthorized access, fraud, and abuse.",
      "To maintain and improve the service: diagnose errors, understand usage patterns, and prioritize fixes and features.",
      "We do not use your data to serve third-party advertising, and we do not sell personal information."
    ]
  },
  {
    title: "5. Third-party services",
    body: [
      "The service relies on third-party providers to function: your connected broker(s), market-data and language-model providers for research and analysis, an email provider for email notifications, and an SMS provider for text-message notifications.  Each processes only the data necessary to perform its function and is bound by its own privacy terms."
    ]
  },
  {
    title: "6. Data retention",
    body: [
      "We retain account, connection, and audit data for as long as your account is active and as needed to comply with legal obligations, resolve disputes, and enforce agreements.",
      "Database backups are kept for 7 days, then deleted.  Deleting your account removes this account's app data; leftover backup copies expire at the end of that window.",
      "You can delete your account yourself in Settings → Danger using the typed confirmation.  That permanently removes this account's app data and stored secrets.  Open positions at your broker and sign-in connections with other services are not closed or revoked by this app."
    ]
  },
  {
    title: "7. Your choices",
    body: [
      "You control which notification channels are enabled and can disable any of them, including SMS, at any time in Settings.",
      "You can disconnect a broker account at any time, which stops further data retrieval from that connection.",
      "Account deletion is self-serve: Settings → Danger (or Account & Settings on iOS) with typed confirmation.  You can also contact us at the email below."
    ]
  },
  {
    title: "8. Shared market-data pool and research corpus",
    body: [
      "Using the app requires contributing general market data — quotes, fundamentals, price history, and news pulled through your keys or broker — to a shared pool that other accepted users can read.  Personal account data (positions, orders, balances, P&L, credentials, watchlists, and strategy settings) is never pooled.",
      "A shared research corpus may include fact-level notes you choose to contribute.  Risk rules and strategy instructions stay private and are never written to the shared corpus.",
      "If more than one person uses the service, each account is private.  Positions, orders, credentials, and private settings are not visible across accounts."
    ]
  },
  {
    title: "9. Children's privacy",
    body: ["The service is not directed to, and is not knowingly used by, anyone under 18."]
  },
  {
    title: "10. Changes to this policy",
    body: [
      "We may update this policy as the service evolves.  Material changes will be reflected by updating the effective date below."
    ]
  },
  {
    title: "11. Contact",
    body: ["Questions about this policy or your data: mail@jays.services."]
  }
];

export default function PrivacyPolicyPage() {
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
          <h1 className="text-3xl font-bold tracking-tight text-fg sm:text-4xl">Privacy Policy</h1>
          <p className="text-sm text-faint">Effective date: August 18, 2026</p>
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
            <a href="/terms-and-conditions" className="underline underline-offset-2 hover:text-fg">
              Terms and Conditions
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
