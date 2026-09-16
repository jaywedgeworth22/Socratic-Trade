"use client";

/** Console 404 surface. Next.js renders this when a /console/* route does not
 *  match — the bare default 404 shows with no console chrome, so users land
 *  on an unstyled page that breaks the multi-tab trust (board da8a93bf).
 *  The console shell still wraps this on most entry paths; this file is the
 *  last-ditch fallback for direct hits to a missing route segment. */

import Link from "next/link";
import { ArrowLeft, Compass } from "lucide-react";

export default function ConsoleNotFound() {
  return (
    <main className="console-root flex min-h-dvh items-center justify-center px-6">
      <section className="con-card max-w-md p-6 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] text-[color:var(--con-muted)]">
          <Compass size={20} />
        </div>
        <h1 className="con-card-title">Page not found</h1>
        <p className="mt-2 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          That console route doesn&apos;t exist.  It may have been renamed or removed.
        </p>
        <p className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Looking for proposals?  They live under &quot;Proposals&quot; in the rail — that route is <code>/console/approvals</code>.
        </p>
        <div className="mt-4 flex justify-center">
          <Link href="/console" className="con-btn con-btn-primary con-btn-sm">
            <ArrowLeft size={14} />
            Back to Home
          </Link>
        </div>
      </section>
    </main>
  );
}