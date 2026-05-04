import "@fontsource-variable/inter";

import type { GlobalProvider } from "@ladle/react";

import { Toaster } from "../src/components/ui/sonner";
import { TooltipProvider } from "../src/components/ui/tooltip";

import "../src/styles/app.css";

/*
 * Ladle sets data-theme="light"|"dark" on <html>, which app.css responds to
 * via :root[data-theme="light"] and :root[data-theme="dark"] selectors.
 *
 * TooltipProvider is required by shadcn's tooltip primitive.
 * Toaster (sonner) is mounted globally so any story can fire toast().
 */
export const Provider: GlobalProvider = ({ children }) => (
  <TooltipProvider>
    <div className="min-h-screen bg-background text-foreground p-6">{children}</div>
    <Toaster />
  </TooltipProvider>
);
