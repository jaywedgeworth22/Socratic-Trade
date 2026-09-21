import { LlmUsageClient } from "../../admin/llm-usage/llm-usage-client";

export const metadata = { title: "Usage" };

// Literal "Usage", not destinationLabel(): this page is a SERVER component and nav.tsx is
// "use client" — calling its function here would throw (same trap documented in
// app/console/assistant/page.tsx). Keep in lockstep with DESTINATIONS ("/console/usage") in
// components/nav.tsx. h1 === rail label (2026-07-16 naming canon) — the rail calls this
// destination "Usage", so the h1 must too, even though the shared client's own default h1
// ("LLM usage & cost") is correct for the /admin/llm-usage mount.
export default function ConsoleUsagePage() {
  return <LlmUsageClient endpoint="/api/llm-usage" scope="user" title="Usage" />;
}
