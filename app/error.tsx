"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "./ui/primitives";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
    Sentry.captureException(error);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).DD_RUM?.addError(error);
  }, [error]);

  const message = error.message?.trim() || "The dashboard failed to render.";
  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg px-4 text-fg">
      <section className="w-full max-w-lg rounded-lg border border-line bg-surface/80 p-5 text-center shadow-[var(--shadow-lg)]">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-neg/30 bg-neg/10 text-neg">
          <AlertTriangle size={20} />
        </div>
        <h1 className="text-lg font-semibold">Dashboard error</h1>
        <p className="mt-2 text-sm text-muted">{message}</p>
        {error.digest && <p className="mt-2 text-xs text-faint">Reference: {error.digest}</p>}
        <div className="mt-4 flex justify-center">
          <Button onClick={reset} size="sm">
            <RotateCcw size={14} /> Try again
          </Button>
        </div>
      </section>
    </main>
  );
}
