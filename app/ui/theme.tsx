"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";
const ThemeContext = createContext<{
  theme: Theme;
  resolvedTheme: "light" | "dark";
  toggle: () => void;
  set: (t: Theme) => void;
}>({
  theme: "light",
  resolvedTheme: "light",
  toggle: () => {},
  set: () => {}
});

/**
 * Inline script (run before paint) that applies the saved theme to <html> to
 * avoid a flash. Owner ruling 2026-08-10: default is LIGHT — never invent
 * dark from prefers-color-scheme when the user has not chosen a theme.
 * Only explicit localStorage "dark" (or a future explicit system path) goes dark.
 */
export const themeInitScript = `(function(){try{var t=localStorage.getItem('theme');if(t!=='dark'&&t!=='light'&&t!=='system'){t='light';}var r=t;if(t==='system'){r=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.classList.toggle('dark',r==='dark');document.documentElement.dataset.theme=r;}catch(e){document.documentElement.classList.remove('dark');document.documentElement.dataset.theme='light';}})();`;

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("light");
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    let t = "light" as Theme;
    try {
      t = (localStorage.getItem("theme") as Theme) || "light";
    } catch { /* ignore */ }
    const valid = t === "dark" || t === "light" || t === "system" ? t : "light";
    setThemeState(valid);
    
    const resolve = (themeVal: Theme) => themeVal === "system" ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : themeVal;
    setResolvedTheme(resolve(valid));

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (e: MediaQueryListEvent) => {
      try {
        if (localStorage.getItem("theme") === "system") {
          const newResolved = e.matches ? 'dark' : 'light';
          setResolvedTheme(newResolved);
          document.documentElement.classList.toggle("dark", newResolved === "dark");
          document.documentElement.dataset.theme = newResolved;
        }
      } catch { /* ignore */ }
    };
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, []);

  const set = useCallback((next: Theme) => {
    setThemeState(next);
    const r = next === "system" ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : next;
    setResolvedTheme(r);
    document.documentElement.classList.toggle("dark", r === "dark");
    document.documentElement.dataset.theme = r;
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = useCallback(() => set(theme === "light" ? "dark" : theme === "dark" ? "system" : "light"), [theme, set]);

  return <ThemeContext.Provider value={{ theme, resolvedTheme, toggle, set }}>{children}</ThemeContext.Provider>;
}

/** Currently has no callers — kept as the public API for a future public-page
 *  theme control. \`ThemeToggle\` (the only prior consumer) was deleted 2026-07-16
 *  as dead code. */
export function useTheme() {
  return useContext(ThemeContext);
}
