"use client";

import { useTheme } from "../../ui/theme";

export type ConsoleTheme = "system" | "light" | "dark";

export function useConsoleTheme(): {
  theme: ConsoleTheme;
  /** Value for the console root's data-theme attribute (undefined = follow system). */
  dataTheme: "light" | "dark" | undefined;
  cycle: () => void;
  set: (next: ConsoleTheme) => void;
} {
  const { theme, toggle, set } = useTheme();

  return {
    theme,
    dataTheme: theme === "system" ? undefined : theme,
    cycle: toggle,
    set,
  };
}
