/*
 * Shared helpers for story pages. Filename has a leading underscore so it
 * does not match Ladle's `*.stories.tsx` glob.
 */

import { useEffect, useState, type ReactNode } from "react";

export type LadleMode = "light" | "dark";

export function useLadleMode(): LadleMode {
  const [mode, setMode] = useState<LadleMode>("light");

  useEffect(() => {
    function read(): LadleMode {
      const attr = document.documentElement.getAttribute("data-theme");
      if (attr === "dark") return "dark";
      if (attr === "light") return "light";
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    setMode(read());
    const observer = new MutationObserver(() => setMode(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setMode(read());
    media.addEventListener("change", onChange);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", onChange);
    };
  }, []);

  return mode;
}

export function StoryPage({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="p-8 font-sans max-w-5xl">
      <header className="mb-10">
        <h1 className="text-3xl font-semibold text-foreground">{title}</h1>
        {description ? (
          <p className="mt-2 text-sm text-body-foreground max-w-prose">{description}</p>
        ) : null}
      </header>
      {children}
    </div>
  );
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-border pt-8 mt-8 first:border-t-0 first:pt-0 first:mt-0">
      <h2 className="text-xl font-semibold text-foreground mb-4">{title}</h2>
      {children}
    </section>
  );
}
