"use client";

/** Console-native toast notices: visible, non-blocking, self-dismissing.
 *  Used for every mutation error/success so failures never block the screen. */

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "../lib/format";

export type ToastKind = "info" | "pos" | "neg" | "warn";

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
}

interface ToastApi {
  push: (kind: ToastKind, title: string, detail?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const KIND_CLASS: Record<ToastKind, string | undefined> = {
  info: undefined,
  pos: "con-toast-pos",
  neg: "con-toast-neg",
  warn: "con-toast-warn"
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((kind: ToastKind, title: string, detail?: string) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev.slice(-3), { id, kind, title, detail }]);
    if (kind !== "neg") {
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
    }
  }, []);

  const api = useMemo<ToastApi>(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="con-toasts">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx("con-toast", KIND_CLASS[t.kind])}
            role={t.kind === "neg" ? "alert" : "status"}
            aria-live={t.kind === "neg" ? "assertive" : "polite"}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold">{t.title}</div>
                {t.detail && <div className="mt-0.5 text-[color:var(--con-muted)]">{t.detail}</div>}
              </div>
              <button
                type="button"
                aria-label="Dismiss"
                className="con-icon-btn con-toast-dismiss shrink-0"
                onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}
