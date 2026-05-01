import type { Story } from "@ladle/react";

import { Section, StoryPage, useLadleMode } from "./_lib";

/*
 * Snapshot of color tokens defined in server/public/design-system.css.
 * Hardcoded (not imported) to avoid CSS variable collisions with the shadcn
 * theme tokens that live in app.css. Update manually if design-system.css changes.
 */

interface Swatch {
  name: string;
  hex: string;
  note?: string;
}

const SURFACES_LIGHT: Swatch[] = [
  { name: "--color-bg-page", hex: "#f3f4f6", note: "App page background" },
  { name: "--color-text", hex: "#1d1d1d", note: "Default text on page" },
  { name: "--color-bg-card", hex: "#ffffff", note: "Card / popover surface" },
  { name: "--color-text-heading", hex: "#2d3748", note: "Heading text" },
  { name: "--color-bg-subtle", hex: "#f9fafb", note: "Subtle bg / table header" },
];

const SURFACES_DARK: Swatch[] = [
  { name: "--color-bg-page", hex: "#111827" },
  { name: "--color-text", hex: "#f9fafb" },
  { name: "--color-bg-card", hex: "#1f2937" },
  { name: "--color-text-heading", hex: "#f9fafb" },
  { name: "--color-bg-subtle", hex: "#1f2937" },
  { name: "--color-surface-raised", hex: "#374151", note: "Elevated surface" },
];

const SEMANTIC_LIGHT: Swatch[] = [
  { name: "--color-brand", hex: "#1a36b4", note: "Primary brand action" },
  { name: "--color-brand-hover", hex: "#2d4fd6", note: "Brand hover" },
  { name: "--color-brand-bg", hex: "#eef4fc", note: "Brand-tinted surface" },
  { name: "--color-text-secondary", hex: "#6b7280", note: "Muted/secondary text" },
  { name: "--color-text-muted", hex: "#9ca3af" },
  { name: "--color-bg-button-secondary", hex: "#e5e7eb", note: "Secondary button bg" },
  { name: "--color-bg-button-secondary-hover", hex: "#d1d5db" },
];

const SEMANTIC_DARK: Swatch[] = [
  { name: "--color-brand", hex: "#6b8cef" },
  { name: "--color-brand-hover", hex: "#8aa3f4" },
  { name: "--color-brand-bg", hex: "rgba(107, 140, 239, 0.1)" },
  { name: "--color-text-secondary", hex: "#d1d5db" },
  { name: "--color-text-muted", hex: "#9ca3af" },
  { name: "--color-bg-button-secondary", hex: "#4b5563" },
  { name: "--color-bg-button-secondary-hover", hex: "#6b7280" },
];

const BORDERS_LIGHT: Swatch[] = [
  { name: "--color-border", hex: "#e5e7eb", note: "Default border / input" },
  { name: "--color-border-strong", hex: "#d1d5db", note: "Stronger border" },
];

const BORDERS_DARK: Swatch[] = [
  { name: "--color-border", hex: "#374151" },
  { name: "--color-border-strong", hex: "#4b5563" },
];

const STATUS_LIGHT: Swatch[] = [
  { name: "--color-success-bg", hex: "#d1fae5" },
  { name: "--color-success-fg", hex: "#047857" },
  { name: "--color-warning-bg", hex: "#fef3c7" },
  { name: "--color-warning-fg", hex: "#b45309" },
  { name: "--color-error-bg", hex: "#fee2e2" },
  { name: "--color-error-fg", hex: "#b91c1c" },
  { name: "--color-info-bg", hex: "#dbe8fc" },
  { name: "--color-info-fg", hex: "#1a36b4" },
];

const STATUS_DARK: Swatch[] = [
  { name: "--color-success-bg", hex: "rgba(16, 185, 129, 0.18)" },
  { name: "--color-success-fg", hex: "#6ee7b7" },
  { name: "--color-warning-bg", hex: "rgba(245, 158, 11, 0.18)" },
  { name: "--color-warning-fg", hex: "#fcd34d" },
  { name: "--color-error-bg", hex: "rgba(239, 68, 68, 0.18)" },
  { name: "--color-error-fg", hex: "#fca5a5" },
  { name: "--color-info-bg", hex: "rgba(107, 140, 239, 0.18)" },
  { name: "--color-info-fg", hex: "#a4c2f4" },
];

const PRIMARY: Swatch[] = [
  { name: "--color-primary-50", hex: "#eef4fc", note: "Near white blue — cards" },
  { name: "--color-primary-100", hex: "#dbe8fc", note: "Lightest blue — subtle bg" },
  { name: "--color-primary-200", hex: "#c5d9f7", note: "Light blue — backgrounds" },
  { name: "--color-primary-300", hex: "#a4c2f4", note: "Accent blue — highlights" },
  { name: "--color-primary-400", hex: "#6b8cef" },
  { name: "--color-primary-500", hex: "#4169e1", note: "Mid blue" },
  { name: "--color-primary-600", hex: "#2d4fd6", note: "Hover states" },
  { name: "--color-primary-700", hex: "#1a36b4", note: "PRIMARY — main brand" },
  { name: "--color-primary-800", hex: "#142782" },
  { name: "--color-primary-900", hex: "#0f1f6b", note: "Darkest — sparingly" },
];

const GRAY: Swatch[] = [
  { name: "--color-gray-50", hex: "#f9fafb", note: "Subtle backgrounds" },
  { name: "--color-gray-100", hex: "#f3f4f6", note: "Light backgrounds" },
  { name: "--color-gray-200", hex: "#e5e7eb", note: "Light borders" },
  { name: "--color-gray-300", hex: "#d1d5db", note: "Borders" },
  { name: "--color-gray-400", hex: "#9ca3af", note: "Placeholder, disabled" },
  { name: "--color-gray-500", hex: "#6b7280", note: "Secondary text" },
  { name: "--color-gray-600", hex: "#4b5563", note: "Body text" },
  { name: "--color-gray-700", hex: "#374151", note: "Secondary text dark" },
  { name: "--color-gray-800", hex: "#2d3748", note: "Headings" },
  { name: "--color-gray-900", hex: "#1d1d1d", note: "Primary text" },
  { name: "--color-gray-950", hex: "#0a0a0a", note: "Near black" },
];

const SUCCESS: Swatch[] = [
  { name: "--color-success-50", hex: "#ecfdf5" },
  { name: "--color-success-100", hex: "#d1fae5" },
  { name: "--color-success-200", hex: "#a7f3d0" },
  { name: "--color-success-300", hex: "#6ee7b7" },
  { name: "--color-success-400", hex: "#34d399" },
  { name: "--color-success-500", hex: "#10b981", note: "Primary success" },
  { name: "--color-success-600", hex: "#059669" },
  { name: "--color-success-700", hex: "#047857" },
  { name: "--color-success-800", hex: "#065f46" },
  { name: "--color-success-900", hex: "#064e3b" },
];

const WARNING: Swatch[] = [
  { name: "--color-warning-50", hex: "#fffbeb" },
  { name: "--color-warning-100", hex: "#fef3c7" },
  { name: "--color-warning-200", hex: "#fde68a" },
  { name: "--color-warning-300", hex: "#fcd34d" },
  { name: "--color-warning-400", hex: "#fbbf24" },
  { name: "--color-warning-500", hex: "#f59e0b", note: "Primary warning" },
  { name: "--color-warning-600", hex: "#d97706" },
  { name: "--color-warning-700", hex: "#b45309" },
  { name: "--color-warning-800", hex: "#92400e" },
  { name: "--color-warning-900", hex: "#78350f" },
];

const ERROR: Swatch[] = [
  { name: "--color-error-50", hex: "#fef2f2" },
  { name: "--color-error-100", hex: "#fee2e2" },
  { name: "--color-error-200", hex: "#fecaca" },
  { name: "--color-error-300", hex: "#fca5a5" },
  { name: "--color-error-400", hex: "#f87171" },
  { name: "--color-error-500", hex: "#ef4444", note: "Primary error" },
  { name: "--color-error-600", hex: "#dc2626" },
  { name: "--color-error-700", hex: "#b91c1c" },
  { name: "--color-error-800", hex: "#991b1b" },
  { name: "--color-error-900", hex: "#7f1d1d" },
];

function Grid({ swatches }: { swatches: Swatch[] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {swatches.map((s) => (
        <div
          key={s.name}
          className="flex items-center gap-4 rounded-md border border-border bg-card p-3"
        >
          <div
            className="h-12 w-12 shrink-0 rounded border border-border"
            style={{ backgroundColor: s.hex }}
          />
          <div className="flex flex-col gap-0.5 min-w-0 flex-1">
            <code className="text-sm font-mono text-card-foreground truncate">{s.name}</code>
            <code className="text-xs font-mono text-body-foreground truncate">{s.hex}</code>
            {s.note ? <p className="text-xs text-body-foreground truncate">{s.note}</p> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function ThemedGrid({ light, dark }: { light: Swatch[]; dark: Swatch[] }) {
  const mode = useLadleMode();
  return <Grid swatches={mode === "dark" ? dark : light} />;
}

export default {
  title: "Design tokens / Legacy",
};

export const All: Story = () => (
  <StoryPage
    title="Legacy color tokens"
    description={
      <>
        Snapshot of <code className="text-xs">server/public/design-system.css</code>. Reference for
        mapping legacy palette into the new shadcn theme. These tokens are NOT loaded into the React
        app — they only power the legacy HTML pages until Stage 5 of the migration. Use Ladle&apos;s
        theme toggle (top-right) to switch between light and dark snapshots.
      </>
    }
  >
    <Section title="Surfaces">
      <ThemedGrid light={SURFACES_LIGHT} dark={SURFACES_DARK} />
    </Section>

    <Section title="Semantic">
      <ThemedGrid light={SEMANTIC_LIGHT} dark={SEMANTIC_DARK} />
    </Section>

    <Section title="Borders & inputs">
      <ThemedGrid light={BORDERS_LIGHT} dark={BORDERS_DARK} />
    </Section>

    <Section title="Status">
      <ThemedGrid light={STATUS_LIGHT} dark={STATUS_DARK} />
    </Section>

    <Section title="Primitive — Brand (primary) scale">
      <Grid swatches={PRIMARY} />
    </Section>

    <Section title="Primitive — Gray neutrals">
      <Grid swatches={GRAY} />
    </Section>

    <Section title="Primitive — Success">
      <Grid swatches={SUCCESS} />
    </Section>

    <Section title="Primitive — Warning">
      <Grid swatches={WARNING} />
    </Section>

    <Section title="Primitive — Error">
      <Grid swatches={ERROR} />
    </Section>
  </StoryPage>
);
