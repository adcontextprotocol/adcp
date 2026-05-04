import type { Story } from "@ladle/react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";

import { type LadleMode, Section, StoryPage, useLadleMode } from "./_lib";

const SEMANTIC_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "body-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "destructive-on-color",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
  "info",
  "info-foreground",
  "border",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
] as const;

type SemanticToken = (typeof SEMANTIC_TOKENS)[number];

/*
 * Mirror of the references in app.css. Update whenever app.css changes so the
 * "→ primitive" labels stay accurate.
 */
const PRIMITIVE_REF: Record<LadleMode, Partial<Record<SemanticToken, string>>> = {
  light: {
    background: "white",
    foreground: "neutral-950",
    card: "white",
    "card-foreground": "neutral-950",
    popover: "white",
    "popover-foreground": "neutral-950",
    primary: "brand-blue-700",
    "primary-foreground": "white",
    secondary: "slate-900 @ 6%",
    "secondary-foreground": "neutral-900",
    muted: "slate-100",
    "muted-foreground": "slate-500",
    "body-foreground": "neutral-600",
    accent: "slate-100",
    "accent-foreground": "slate-900",
    destructive: "red-600",
    "destructive-foreground": "red-700",
    "destructive-on-color": "white",
    success: "emerald-600",
    "success-foreground": "emerald-700",
    warning: "yellow-400",
    "warning-foreground": "yellow-700",
    info: "blue-600",
    "info-foreground": "blue-700",
    border: "neutral-200",
    input: "neutral-200",
    ring: "neutral-400",
    "chart-1": "orange-500",
    "chart-2": "cyan-500",
    "chart-3": "blue-700",
    "chart-4": "yellow-400",
    "chart-5": "amber-500",
  },
  dark: {
    background: "slate-950",
    foreground: "slate-50",
    card: "slate-900",
    "card-foreground": "slate-50",
    popover: "slate-900",
    "popover-foreground": "slate-50",
    primary: "brand-blue-500",
    "primary-foreground": "white",
    secondary: "raw — oklch(1 0 0 / 12%)",
    "secondary-foreground": "slate-50",
    muted: "slate-800",
    "muted-foreground": "slate-400",
    "body-foreground": "slate-300",
    accent: "slate-800",
    "accent-foreground": "slate-50",
    destructive: "red-400",
    "destructive-foreground": "red-400",
    "destructive-on-color": "white",
    success: "emerald-400",
    "success-foreground": "emerald-300",
    warning: "yellow-400",
    "warning-foreground": "yellow-300",
    info: "blue-400",
    "info-foreground": "blue-300",
    border: "raw — oklch(1 0 0 / 10%)",
    input: "raw — oklch(1 0 0 / 15%)",
    ring: "slate-500",
    "chart-1": "orange-500",
    "chart-2": "cyan-500",
    "chart-3": "blue-700",
    "chart-4": "yellow-400",
    "chart-5": "amber-500",
  },
};

/*
 * What each semantic token does in shadcn. Mode-agnostic.
 *
 * shadcn pairs every "surface" token with a "-foreground" sibling — they're
 * always used together (e.g., bg-primary + text-primary-foreground in Button).
 * That's why you see the same components listed under both halves of the pair.
 */
const USAGE: Record<SemanticToken, string> = {
  background:
    "Surface — main app/page background. Pairs with --foreground for text. Also: Button (outline bg), Dialog (content surface).",
  foreground:
    "Text on --background. Inherited by all body text via the body rule. Also explicitly used in: Badge, Input.",
  card: "Surface — card/section, slightly raised from --background. Pairs with --card-foreground.",
  "card-foreground": "Text on --card surfaces.",
  popover:
    "Surface — Popover, DropdownMenu, Select, Tooltip floating panels. Pairs with --popover-foreground. (Not used by any currently-installed component.)",
  "popover-foreground": "Text on --popover surfaces.",
  primary:
    "Surface — primary action color. Default Button bg, default Badge bg, the strongest brand emphasis. Pairs with --primary-foreground.",
  "primary-foreground":
    "Text/icon on --primary surfaces (Button label, Badge label). Always paired with --primary; never used standalone.",
  secondary:
    "Surface — alternate action color, less prominent than primary. Button (secondary variant), Badge (secondary). Pairs with --secondary-foreground.",
  "secondary-foreground": "Text on --secondary surfaces. Always paired with --secondary.",
  muted:
    "Surface — subtle/recessed area (Skeleton, disabled states, recessed sections). Pairs with --muted-foreground.",
  "muted-foreground":
    "Tertiary text — helper text, hints, faint metadata, placeholders, and the most de-emphasized labels. For body text and descriptions, use --body-foreground.",
  "body-foreground":
    "Body text — descriptions, paragraph copy. Sits between --foreground (titles) and --muted-foreground (helper / tertiary). Cross-surface: works on --background, --card, --popover.",
  accent:
    "Surface — hover/highlight state (Button ghost hover, DropdownMenu item hover, Tabs trigger hover). Pairs with --accent-foreground.",
  "accent-foreground": "Text on --accent surfaces during hover/highlight states.",
  destructive:
    "Surface — destructive/error actions (delete, validation errors). Button (destructive variant), Badge (destructive). Pairs with --destructive-foreground. Also used as Input aria-invalid ring color.",
  "destructive-foreground":
    "Saturated red text — legible on default backgrounds and on tinted destructive surfaces (e.g. bg-destructive/15 in Badge). Use this when the surface itself isn't a solid red.",
  "destructive-on-color":
    "Text on solid destructive surfaces (e.g. bg-destructive in Button). Inverted (white) for legibility on saturated red. Pair with --destructive when used at full alpha.",
  success:
    "Status color — active, live, approved, completed. Used at /15 alpha as the soft-tint surface for status badges. Pairs with --success-foreground.",
  "success-foreground":
    "Text on tinted success surfaces (e.g. bg-success/15). Saturated to stay legible on the soft tint.",
  warning:
    "Status color — pending, review, processing, draft. Used at /15 alpha for soft-tint warning badges. Pairs with --warning-foreground.",
  "warning-foreground": "Text on tinted warning surfaces (e.g. bg-warning/15).",
  info: "Status color — new, prospect, informational notices. Distinct from --primary so brand emphasis and informational signal don't collide. Pairs with --info-foreground.",
  "info-foreground": "Text on tinted info surfaces (e.g. bg-info/15).",
  border: "Border color — Card outline, Separator, custom borders. Used in: Badge.",
  input:
    "Input field border (separate from --border so they can diverge if you want a different input outline). Used in: Button (outline border), Input.",
  ring: "Focus outline — appears on keyboard-focused interactive elements. Used in: Button, Badge, Input, Dialog (and any focusable element).",
  "chart-1": "Data viz series color #1.",
  "chart-2": "Data viz series color #2.",
  "chart-3": "Data viz series color #3.",
  "chart-4": "Data viz series color #4.",
  "chart-5": "Data viz series color #5.",
};

/*
 * Component states rendered under each system token as child swatches, so the
 * docs reflect what users actually see in Badge / Button surfaces rather than
 * just the saturated source color. Surface tokens get bg-only swatches at the
 * alphas applied in components; foreground tokens get "Aa" rendered on top of
 * the matching bg surface so contrast can be eyeballed.
 */
type ChildSample =
  | { kind: "bg"; bgVar: string; alpha?: number; usage: string }
  | { kind: "fg"; bgVar: string; alpha?: number; fgVar: string; usage: string }
  | { kind: "border"; borderVar: string; alpha?: number; usage: string };

const RELATED_STATES: Partial<Record<SemanticToken, ChildSample[]>> = {
  destructive: [
    { kind: "bg", bgVar: "--destructive", alpha: 60, usage: "Button bg (dark mode)" },
    { kind: "bg", bgVar: "--destructive", alpha: 25, usage: "Badge hover bg" },
    {
      kind: "border",
      borderVar: "--destructive",
      alpha: 20,
      usage: "aria-invalid ring (light), focus ring",
    },
    { kind: "bg", bgVar: "--destructive", alpha: 15, usage: "Badge bg · Alert bg" },
    { kind: "bg", bgVar: "--destructive", alpha: 10, usage: "DropdownMenu destructive focus bg" },
  ],
  "destructive-foreground": [
    {
      kind: "fg",
      bgVar: "--card",
      fgVar: "--destructive-foreground",
      usage: "Form error · Label required * · DropdownMenu destructive item",
    },
    {
      kind: "fg",
      bgVar: "--destructive",
      alpha: 15,
      fgVar: "--destructive-foreground",
      usage: "Badge text · Alert title/description",
    },
    {
      kind: "fg",
      bgVar: "--destructive",
      alpha: 25,
      fgVar: "--destructive-foreground",
      usage: "Badge hover text",
    },
  ],
  "destructive-on-color": [
    { kind: "fg", bgVar: "--destructive", fgVar: "--destructive-on-color", usage: "Button text" },
  ],
  success: [
    { kind: "bg", bgVar: "--success", alpha: 25, usage: "Badge hover bg" },
    { kind: "bg", bgVar: "--success", alpha: 15, usage: "Badge bg" },
  ],
  "success-foreground": [
    {
      kind: "fg",
      bgVar: "--success",
      alpha: 15,
      fgVar: "--success-foreground",
      usage: "Badge text",
    },
    {
      kind: "fg",
      bgVar: "--success",
      alpha: 25,
      fgVar: "--success-foreground",
      usage: "Badge hover text",
    },
  ],
  warning: [
    { kind: "bg", bgVar: "--warning", alpha: 25, usage: "Badge hover bg" },
    { kind: "bg", bgVar: "--warning", alpha: 15, usage: "Badge bg" },
  ],
  "warning-foreground": [
    {
      kind: "fg",
      bgVar: "--warning",
      alpha: 15,
      fgVar: "--warning-foreground",
      usage: "Badge text",
    },
    {
      kind: "fg",
      bgVar: "--warning",
      alpha: 25,
      fgVar: "--warning-foreground",
      usage: "Badge hover text",
    },
  ],
  info: [
    { kind: "bg", bgVar: "--info", alpha: 25, usage: "Badge hover bg" },
    { kind: "bg", bgVar: "--info", alpha: 15, usage: "Badge bg" },
  ],
  "info-foreground": [
    { kind: "fg", bgVar: "--info", alpha: 15, fgVar: "--info-foreground", usage: "Badge text" },
    {
      kind: "fg",
      bgVar: "--info",
      alpha: 25,
      fgVar: "--info-foreground",
      usage: "Badge hover text",
    },
  ],
  "primary-foreground": [
    {
      kind: "fg",
      bgVar: "--primary",
      fgVar: "--primary-foreground",
      usage: "Button text · Switch thumb · Avatar status indicator",
    },
  ],
  "secondary-foreground": [
    {
      kind: "fg",
      bgVar: "--secondary",
      fgVar: "--secondary-foreground",
      usage: "Button secondary text · Badge secondary text",
    },
  ],
  "accent-foreground": [
    {
      kind: "fg",
      bgVar: "--accent",
      fgVar: "--accent-foreground",
      usage: "DropdownMenu item focus · Select option focus · Tabs trigger hover",
    },
  ],
  "muted-foreground": [
    {
      kind: "fg",
      bgVar: "--background",
      fgVar: "--muted-foreground",
      usage: "Cross-surface helper text · Tabs trigger inactive · DropdownMenu shortcuts",
    },
    {
      kind: "fg",
      bgVar: "--muted",
      fgVar: "--muted-foreground",
      usage: "Avatar fallback · Skeleton text",
    },
  ],
  "body-foreground": [
    {
      kind: "fg",
      bgVar: "--card",
      fgVar: "--body-foreground",
      usage: "Card description · Alert description · Sheet description",
    },
    {
      kind: "fg",
      bgVar: "--popover",
      fgVar: "--body-foreground",
      usage: "Popover description · Toast description",
    },
  ],
  muted: [
    {
      kind: "bg",
      bgVar: "--muted",
      alpha: 50,
      usage: "Table row hover · Table footer · Has-aria-expanded row",
    },
  ],
  accent: [
    {
      kind: "bg",
      bgVar: "--accent",
      alpha: 50,
      usage: "Button ghost hover (dark) · Dialog close hover",
    },
  ],
  input: [
    { kind: "bg", bgVar: "--input", alpha: 80, usage: "Switch unchecked bg (dark)" },
    { kind: "bg", bgVar: "--input", alpha: 50, usage: "Button outline hover bg (dark)" },
    {
      kind: "bg",
      bgVar: "--input",
      alpha: 30,
      usage: "Input/Textarea bg (dark) · Tabs active bg (dark)",
    },
  ],
  ring: [
    { kind: "border", borderVar: "--ring", alpha: 50, usage: "Focus-visible ring (3px outline)" },
  ],
};

interface ResolvedToken {
  name: string;
  cssVar: string;
  raw: string;
}

function useResolved(names: readonly string[]): ResolvedToken[] {
  const namesKey = names.join(",");
  const [tokens, setTokens] = useState<ResolvedToken[]>([]);

  // names array identity isn't stable across renders; namesKey captures the content.
  // biome-ignore lint/correctness/useExhaustiveDependencies: namesKey covers names content
  useEffect(() => {
    const resolved = names.map((name) => ({
      name,
      cssVar: `--${name}`,
      raw: getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim(),
    }));
    setTokens(resolved);
    const observer = new MutationObserver(() => {
      const next = names.map((name) => ({
        name,
        cssVar: `--${name}`,
        raw: getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim(),
      }));
      setTokens(next);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, [namesKey]);

  return tokens;
}

function isTextToken(name: string): boolean {
  return name === "foreground" || name.endsWith("-foreground") || name.endsWith("-on-color");
}

function isBorderToken(name: string): boolean {
  return name === "border" || name === "input" || name === "ring";
}

function SemanticGrid({ filter }: { filter?: (name: SemanticToken) => boolean }) {
  const tokens = useResolved(SEMANTIC_TOKENS);
  const mode = useLadleMode();
  const refs = PRIMITIVE_REF[mode];
  const displayed = filter ? tokens.filter((t) => filter(t.name as SemanticToken)) : tokens;

  return (
    <>
      <div className="mb-3">
        <Badge variant="secondary">{displayed.length} tokens</Badge>
      </div>
      <div className="grid grid-cols-1 gap-3">
        {displayed.map((token) => {
          const ref = refs[token.name as SemanticToken];
          const usage = USAGE[token.name as SemanticToken];
          const related = RELATED_STATES[token.name as SemanticToken];
          return (
            <div
              key={token.name}
              className="flex items-start gap-4 rounded-md border border-border bg-card p-3"
            >
              {isTextToken(token.name) ? (
                <div
                  className="h-12 w-12 shrink-0 rounded border border-border flex items-center justify-center text-2xl font-medium bg-card"
                  style={{ color: `var(${token.cssVar})` }}
                >
                  Aa
                </div>
              ) : isBorderToken(token.name) ? (
                <div
                  className="h-12 w-12 shrink-0 rounded bg-card"
                  style={{
                    borderWidth: "2px",
                    borderStyle: "solid",
                    borderColor: `var(${token.cssVar})`,
                  }}
                />
              ) : (
                <div
                  className="h-12 w-12 shrink-0 rounded border border-border"
                  style={{ backgroundColor: `var(${token.cssVar})` }}
                />
              )}
              <div className="flex flex-col gap-1 min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <code className="text-sm font-mono text-foreground">{token.cssVar}</code>
                  {ref ? <code className="text-xs font-mono text-foreground">→ {ref}</code> : null}
                  <code className="text-xs font-mono text-foreground">{token.raw}</code>
                </div>
                {usage ? <p className="text-xs text-body-foreground">{usage}</p> : null}
                {related ? (
                  <div className="mt-2 flex flex-col gap-1.5 pt-2 border-t border-border">
                    {related.map((sample) => {
                      const sourceVar = sample.kind === "border" ? sample.borderVar : sample.bgVar;
                      const renderAsBorder = sample.kind === "border";
                      const bg = sample.alpha
                        ? `color-mix(in oklab, var(${sourceVar}) ${sample.alpha}%, transparent)`
                        : `var(${sourceVar})`;
                      const label = `${sourceVar}${sample.alpha ? ` / ${sample.alpha}%` : ""}`;
                      const sampleKey = `${sample.kind}-${sourceVar}-${sample.alpha ?? "solid"}`;
                      return (
                        <div key={sampleKey} className="flex items-center gap-3">
                          {renderAsBorder ? (
                            <div
                              className="h-6 w-12 shrink-0 rounded bg-card"
                              style={{
                                borderWidth: "3px",
                                borderStyle: "solid",
                                borderColor: bg,
                              }}
                            />
                          ) : (
                            <div
                              className="h-6 w-12 shrink-0 rounded border border-border flex items-center justify-center text-xs font-medium"
                              style={{
                                background: bg,
                                color: sample.kind === "fg" ? `var(${sample.fgVar})` : undefined,
                              }}
                            >
                              {sample.kind === "fg" ? "Aa" : null}
                            </div>
                          )}
                          <code className="text-xs font-mono text-foreground">{label}</code>
                          <span className="text-xs text-body-foreground">{sample.usage}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

interface PrimitiveSwatch {
  className: string;
  label: string;
  cssVar: string;
}

function PrimitiveScale({ swatches }: { swatches: PrimitiveSwatch[] }) {
  const tokens = useResolved(swatches.map((s) => s.cssVar.replace(/^--/, "")));

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
      {swatches.map((s, i) => (
        <div key={s.className} className="rounded-md border border-border bg-card overflow-hidden">
          <div className={`h-12 w-full ${s.className}`} />
          <div className="p-2 flex flex-col gap-0.5">
            <code className="text-xs font-mono text-foreground">{s.label}</code>
            <code className="text-[10px] font-mono text-body-foreground truncate">
              {tokens[i]?.raw || ""}
            </code>
          </div>
        </div>
      ))}
    </div>
  );
}

const BRAND_BLUE: PrimitiveSwatch[] = [
  { className: "bg-brand-blue-50", label: "brand-blue-50", cssVar: "--color-brand-blue-50" },
  { className: "bg-brand-blue-100", label: "brand-blue-100", cssVar: "--color-brand-blue-100" },
  { className: "bg-brand-blue-200", label: "brand-blue-200", cssVar: "--color-brand-blue-200" },
  { className: "bg-brand-blue-300", label: "brand-blue-300", cssVar: "--color-brand-blue-300" },
  { className: "bg-brand-blue-400", label: "brand-blue-400", cssVar: "--color-brand-blue-400" },
  { className: "bg-brand-blue-500", label: "brand-blue-500", cssVar: "--color-brand-blue-500" },
  { className: "bg-brand-blue-600", label: "brand-blue-600", cssVar: "--color-brand-blue-600" },
  { className: "bg-brand-blue-700", label: "brand-blue-700", cssVar: "--color-brand-blue-700" },
  { className: "bg-brand-blue-800", label: "brand-blue-800", cssVar: "--color-brand-blue-800" },
  { className: "bg-brand-blue-900", label: "brand-blue-900", cssVar: "--color-brand-blue-900" },
  { className: "bg-brand-blue-950", label: "brand-blue-950", cssVar: "--color-brand-blue-950" },
];

const BLUE: PrimitiveSwatch[] = [
  { className: "bg-blue-50", label: "blue-50", cssVar: "--color-blue-50" },
  { className: "bg-blue-100", label: "blue-100", cssVar: "--color-blue-100" },
  { className: "bg-blue-200", label: "blue-200", cssVar: "--color-blue-200" },
  { className: "bg-blue-300", label: "blue-300", cssVar: "--color-blue-300" },
  { className: "bg-blue-400", label: "blue-400", cssVar: "--color-blue-400" },
  { className: "bg-blue-500", label: "blue-500", cssVar: "--color-blue-500" },
  { className: "bg-blue-600", label: "blue-600", cssVar: "--color-blue-600" },
  { className: "bg-blue-700", label: "blue-700", cssVar: "--color-blue-700" },
  { className: "bg-blue-800", label: "blue-800", cssVar: "--color-blue-800" },
  { className: "bg-blue-900", label: "blue-900", cssVar: "--color-blue-900" },
  { className: "bg-blue-950", label: "blue-950", cssVar: "--color-blue-950" },
];

const NEUTRAL: PrimitiveSwatch[] = [
  { className: "bg-neutral-50", label: "neutral-50", cssVar: "--color-neutral-50" },
  { className: "bg-neutral-100", label: "neutral-100", cssVar: "--color-neutral-100" },
  { className: "bg-neutral-200", label: "neutral-200", cssVar: "--color-neutral-200" },
  { className: "bg-neutral-300", label: "neutral-300", cssVar: "--color-neutral-300" },
  { className: "bg-neutral-400", label: "neutral-400", cssVar: "--color-neutral-400" },
  { className: "bg-neutral-500", label: "neutral-500", cssVar: "--color-neutral-500" },
  { className: "bg-neutral-600", label: "neutral-600", cssVar: "--color-neutral-600" },
  { className: "bg-neutral-700", label: "neutral-700", cssVar: "--color-neutral-700" },
  { className: "bg-neutral-800", label: "neutral-800", cssVar: "--color-neutral-800" },
  { className: "bg-neutral-900", label: "neutral-900", cssVar: "--color-neutral-900" },
  { className: "bg-neutral-950", label: "neutral-950", cssVar: "--color-neutral-950" },
];

const GRAY: PrimitiveSwatch[] = [
  { className: "bg-gray-50", label: "gray-50", cssVar: "--color-gray-50" },
  { className: "bg-gray-100", label: "gray-100", cssVar: "--color-gray-100" },
  { className: "bg-gray-200", label: "gray-200", cssVar: "--color-gray-200" },
  { className: "bg-gray-300", label: "gray-300", cssVar: "--color-gray-300" },
  { className: "bg-gray-400", label: "gray-400", cssVar: "--color-gray-400" },
  { className: "bg-gray-500", label: "gray-500", cssVar: "--color-gray-500" },
  { className: "bg-gray-600", label: "gray-600", cssVar: "--color-gray-600" },
  { className: "bg-gray-700", label: "gray-700", cssVar: "--color-gray-700" },
  { className: "bg-gray-800", label: "gray-800", cssVar: "--color-gray-800" },
  { className: "bg-gray-900", label: "gray-900", cssVar: "--color-gray-900" },
  { className: "bg-gray-950", label: "gray-950", cssVar: "--color-gray-950" },
];

const GREEN: PrimitiveSwatch[] = [
  { className: "bg-green-50", label: "green-50", cssVar: "--color-green-50" },
  { className: "bg-green-100", label: "green-100", cssVar: "--color-green-100" },
  { className: "bg-green-200", label: "green-200", cssVar: "--color-green-200" },
  { className: "bg-green-300", label: "green-300", cssVar: "--color-green-300" },
  { className: "bg-green-400", label: "green-400", cssVar: "--color-green-400" },
  { className: "bg-green-500", label: "green-500", cssVar: "--color-green-500" },
  { className: "bg-green-600", label: "green-600", cssVar: "--color-green-600" },
  { className: "bg-green-700", label: "green-700", cssVar: "--color-green-700" },
  { className: "bg-green-800", label: "green-800", cssVar: "--color-green-800" },
  { className: "bg-green-900", label: "green-900", cssVar: "--color-green-900" },
  { className: "bg-green-950", label: "green-950", cssVar: "--color-green-950" },
];

const EMERALD: PrimitiveSwatch[] = [
  { className: "bg-emerald-50", label: "emerald-50", cssVar: "--color-emerald-50" },
  { className: "bg-emerald-100", label: "emerald-100", cssVar: "--color-emerald-100" },
  { className: "bg-emerald-200", label: "emerald-200", cssVar: "--color-emerald-200" },
  { className: "bg-emerald-300", label: "emerald-300", cssVar: "--color-emerald-300" },
  { className: "bg-emerald-400", label: "emerald-400", cssVar: "--color-emerald-400" },
  { className: "bg-emerald-500", label: "emerald-500", cssVar: "--color-emerald-500" },
  { className: "bg-emerald-600", label: "emerald-600", cssVar: "--color-emerald-600" },
  { className: "bg-emerald-700", label: "emerald-700", cssVar: "--color-emerald-700" },
  { className: "bg-emerald-800", label: "emerald-800", cssVar: "--color-emerald-800" },
  { className: "bg-emerald-900", label: "emerald-900", cssVar: "--color-emerald-900" },
  { className: "bg-emerald-950", label: "emerald-950", cssVar: "--color-emerald-950" },
];

const YELLOW: PrimitiveSwatch[] = [
  { className: "bg-yellow-50", label: "yellow-50", cssVar: "--color-yellow-50" },
  { className: "bg-yellow-100", label: "yellow-100", cssVar: "--color-yellow-100" },
  { className: "bg-yellow-200", label: "yellow-200", cssVar: "--color-yellow-200" },
  { className: "bg-yellow-300", label: "yellow-300", cssVar: "--color-yellow-300" },
  { className: "bg-yellow-400", label: "yellow-400", cssVar: "--color-yellow-400" },
  { className: "bg-yellow-500", label: "yellow-500", cssVar: "--color-yellow-500" },
  { className: "bg-yellow-600", label: "yellow-600", cssVar: "--color-yellow-600" },
  { className: "bg-yellow-700", label: "yellow-700", cssVar: "--color-yellow-700" },
  { className: "bg-yellow-800", label: "yellow-800", cssVar: "--color-yellow-800" },
  { className: "bg-yellow-900", label: "yellow-900", cssVar: "--color-yellow-900" },
  { className: "bg-yellow-950", label: "yellow-950", cssVar: "--color-yellow-950" },
];

const AMBER: PrimitiveSwatch[] = [
  { className: "bg-amber-50", label: "amber-50", cssVar: "--color-amber-50" },
  { className: "bg-amber-100", label: "amber-100", cssVar: "--color-amber-100" },
  { className: "bg-amber-200", label: "amber-200", cssVar: "--color-amber-200" },
  { className: "bg-amber-300", label: "amber-300", cssVar: "--color-amber-300" },
  { className: "bg-amber-400", label: "amber-400", cssVar: "--color-amber-400" },
  { className: "bg-amber-500", label: "amber-500", cssVar: "--color-amber-500" },
  { className: "bg-amber-600", label: "amber-600", cssVar: "--color-amber-600" },
  { className: "bg-amber-700", label: "amber-700", cssVar: "--color-amber-700" },
  { className: "bg-amber-800", label: "amber-800", cssVar: "--color-amber-800" },
  { className: "bg-amber-900", label: "amber-900", cssVar: "--color-amber-900" },
  { className: "bg-amber-950", label: "amber-950", cssVar: "--color-amber-950" },
];

const RED: PrimitiveSwatch[] = [
  { className: "bg-red-50", label: "red-50", cssVar: "--color-red-50" },
  { className: "bg-red-100", label: "red-100", cssVar: "--color-red-100" },
  { className: "bg-red-200", label: "red-200", cssVar: "--color-red-200" },
  { className: "bg-red-300", label: "red-300", cssVar: "--color-red-300" },
  { className: "bg-red-400", label: "red-400", cssVar: "--color-red-400" },
  { className: "bg-red-500", label: "red-500", cssVar: "--color-red-500" },
  { className: "bg-red-600", label: "red-600", cssVar: "--color-red-600" },
  { className: "bg-red-700", label: "red-700", cssVar: "--color-red-700" },
  { className: "bg-red-800", label: "red-800", cssVar: "--color-red-800" },
  { className: "bg-red-900", label: "red-900", cssVar: "--color-red-900" },
  { className: "bg-red-950", label: "red-950", cssVar: "--color-red-950" },
];

export default {
  title: "Design tokens / Color",
};

export const All: Story = () => (
  <StoryPage
    title="Color"
    description={
      <>
        Two layers: <strong>Semantic tokens</strong> (defined in{" "}
        <code className="text-xs">src/styles/app.css</code>, what shadcn components reference) and{" "}
        <strong>primitive scales</strong> (Tailwind&apos;s built-in palettes, available as{" "}
        <code className="text-xs">bg-blue-700</code> etc.). Semantic tokens currently reference
        primitives like <code className="text-xs">var(--color-neutral-900)</code> — swap brand by
        retargeting these references.
        <br />
        <br />
        <strong>Surface ↔ foreground pairing:</strong> tokens without a{" "}
        <code className="text-xs">-foreground</code> suffix are{" "}
        <strong>background/surface colors</strong> — use them with{" "}
        <code className="text-xs">bg-*</code>, <code className="text-xs">border-*</code>, or{" "}
        <code className="text-xs">ring-*</code>. Their <code className="text-xs">-foreground</code>{" "}
        sibling is the text/icon color that sits on top. They&apos;re always used together — e.g.,
        Button uses <code className="text-xs">bg-primary</code> +{" "}
        <code className="text-xs">text-primary-foreground</code> as a pair. Don&apos;t use a surface
        token as text (e.g., <code className="text-xs">text-destructive</code>) — reach for the
        foreground sibling instead.
        <br />
        <br />
        <strong>Text hierarchy (cross-surface):</strong>{" "}
        <code className="text-xs">--foreground</code> for titles / primary text,{" "}
        <code className="text-xs">--body-foreground</code> for body and descriptions, and{" "}
        <code className="text-xs">--muted-foreground</code> for helper text, hints, and the most
        de-emphasized labels. These three are intentionally surface-agnostic.
      </>
    }
  >
    <Section title="Semantic — Surfaces">
      <SemanticGrid
        filter={(name) =>
          [
            "background",
            "foreground",
            "body-foreground",
            "card",
            "card-foreground",
            "popover",
            "popover-foreground",
          ].includes(name)
        }
      />
    </Section>

    <Section title="Semantic — Action & emphasis">
      <SemanticGrid
        filter={(name) =>
          [
            "primary",
            "primary-foreground",
            "secondary",
            "secondary-foreground",
            "muted",
            "muted-foreground",
            "accent",
            "accent-foreground",
          ].includes(name)
        }
      />
    </Section>

    <Section title="Semantic — System">
      <SemanticGrid
        filter={(name) =>
          [
            "destructive",
            "destructive-foreground",
            "destructive-on-color",
            "success",
            "success-foreground",
            "warning",
            "warning-foreground",
            "info",
            "info-foreground",
          ].includes(name)
        }
      />
    </Section>

    <Section title="Semantic — Borders & inputs">
      <SemanticGrid filter={(name) => ["border", "input", "ring"].includes(name)} />
    </Section>

    <Section title="Semantic — Charts">
      <SemanticGrid filter={(name) => name.startsWith("chart-")} />
    </Section>

    <Section title="Primitive — Brand blue (custom)">
      <PrimitiveScale swatches={BRAND_BLUE} />
    </Section>

    <Section title="Primitive — Blue (Tailwind)">
      <PrimitiveScale swatches={BLUE} />
    </Section>

    <Section title="Primitive — Neutral (shadcn base)">
      <PrimitiveScale swatches={NEUTRAL} />
    </Section>

    <Section title="Primitive — Gray">
      <PrimitiveScale swatches={GRAY} />
    </Section>

    <Section title="Primitive — Green (success)">
      <PrimitiveScale swatches={GREEN} />
    </Section>

    <Section title="Primitive — Emerald (success alt)">
      <PrimitiveScale swatches={EMERALD} />
    </Section>

    <Section title="Primitive — Yellow (warning)">
      <PrimitiveScale swatches={YELLOW} />
    </Section>

    <Section title="Primitive — Amber (chart-5)">
      <PrimitiveScale swatches={AMBER} />
    </Section>

    <Section title="Primitive — Red (error)">
      <PrimitiveScale swatches={RED} />
    </Section>
  </StoryPage>
);
