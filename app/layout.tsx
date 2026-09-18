import "./globals.css";
import type { Metadata, Viewport } from "next";
import { lato } from "./fonts/lato";
import { ThemeProvider, themeInitScript } from "./ui/theme";
import { ThemedToaster } from "./ui/toaster";
import { GlobalErrorToasts } from "./ui/global-error-toasts";
import { pwaUnregisterScript } from "@/lib/pwa-unregister";
import { resolvePublicRumConfig } from "@/lib/datadog-env";
import { DatadogRumBoot } from "./ui/datadog-rum-boot";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://socratictrade.com"),
  title: {
    default: "Socratic Trade",
    template: "%s · Socratic Trade"
  },
  description:
    "Socratic Trade is an autonomous market-reasoning system that forms theses, acts within delegated authority, shows its evidence and dissent, and learns from outcomes.  Not investment advice.",
  applicationName: "Socratic Trade",
  // PWA retired: no web-app manifest and no standalone Add-to-Home-Screen.
  appleWebApp: false,
  icons: {
    icon: [
      { url: "/icons/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon.png", type: "image/png", sizes: "1024x1024" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }
    ],
    apple: [{ url: "/icons/apple-touch-icon-180.png", sizes: "180x180", type: "image/png" }]
  },
  keywords: [
    "AI trading agent",
    "autonomous trading software",
    "algorithmic trading system",
    "market reasoning tool",
    "trading decision journal"
  ],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "Socratic Trade",
    url: "/",
    title: "Socratic Trade",
    description:
      "Autonomous market reasoning with visible theses, evidence, dissent, actions, and outcome learning.  Not investment advice."
  },
  twitter: {
    card: "summary_large_image",
    title: "Socratic Trade",
    description: "Autonomous market reasoning with visible decisions and outcome learning.  Not investment advice."
  },
  // Default = NOINDEX. Only allow indexing when explicitly opted in (the app is private by default).
  robots:
    process.env.NEXT_PUBLIC_ALLOW_INDEXING === "true"
      ? { index: true, follow: true }
      : { index: false, follow: false, nocache: true }
};

// viewport-fit=cover lets the page extend under the notch/home indicator; the
// safe-area-inset padding in globals.css then keeps content clear of them.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#ffffff"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // lato.variable puts --font-lato on <html>, so both globals.css (--font-sans) and console.css
  // (--con-font-lato) can resolve it — the console mounts deep inside <body>, not here.
  return (
    <html lang="en" className={lato.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <script dangerouslySetInnerHTML={{ __html: pwaUnregisterScript }} />
      </head>
      <body>
        <ThemeProvider>
          {children}
          <DatadogRumBoot config={resolvePublicRumConfig()} />
          <GlobalErrorToasts />
          <ThemedToaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
