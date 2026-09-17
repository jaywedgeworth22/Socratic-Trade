"use client";

import { Toaster as Sonner } from "sonner";
import { useTheme } from "./theme";

export function ThemedToaster() {
  const { theme } = useTheme();
  return <Sonner theme={theme} position="bottom-right" />;
}
