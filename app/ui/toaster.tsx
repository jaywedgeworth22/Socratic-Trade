"use client";

import { Toaster as Sonner } from "sonner";
import { useTheme } from "./theme";

export function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return <Sonner theme={resolvedTheme} position="bottom-right" />;
}
