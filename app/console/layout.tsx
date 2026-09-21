import "./console.css";
import type { Metadata, Viewport } from "next";
import { ConsoleShell } from "./components/shell";

export const metadata: Metadata = {
  title: {
    template: "%s | Socratic Trade",
    default: "Console | Socratic Trade"
  },
  description: "Socratic Trade autonomy desk: live thesis, decision trace, evidence, coaching, and framework learning."
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  // Keep in lockstep with --con-bg in console.css (light :root / dark override) —
  // a mismatched themeColor tints the phone status bar a different shade than the app.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f1f4f6" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" }
  ]
};

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
