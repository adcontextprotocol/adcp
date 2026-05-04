import type { Story } from "@ladle/react";

import { Section, StoryPage } from "./_lib";

const SPACING = [
  { token: "0.5", rem: "0.125rem", px: "2px" },
  { token: "1", rem: "0.25rem", px: "4px" },
  { token: "2", rem: "0.5rem", px: "8px" },
  { token: "3", rem: "0.75rem", px: "12px" },
  { token: "4", rem: "1rem", px: "16px" },
  { token: "5", rem: "1.25rem", px: "20px" },
  { token: "6", rem: "1.5rem", px: "24px" },
  { token: "8", rem: "2rem", px: "32px" },
  { token: "10", rem: "2.5rem", px: "40px" },
  { token: "12", rem: "3rem", px: "48px" },
  { token: "16", rem: "4rem", px: "64px" },
  { token: "20", rem: "5rem", px: "80px" },
  { token: "24", rem: "6rem", px: "96px" },
];

export default {
  title: "Design tokens / Spacing",
};

export const All: Story = () => (
  <StoryPage
    title="Spacing"
    description={
      <>
        Tailwind&apos;s default spacing scale. Use these tokens with{" "}
        <code className="text-xs">p-*</code>, <code className="text-xs">m-*</code>,{" "}
        <code className="text-xs">gap-*</code>, <code className="text-xs">w-*</code>, etc.
      </>
    }
  >
    <Section title="Scale">
      <div className="space-y-2">
        {SPACING.map((item) => (
          <div key={item.token} className="flex items-center gap-6">
            <code className="text-xs font-mono text-foreground w-12 shrink-0">{item.token}</code>
            <code className="text-xs font-mono text-foreground w-20 shrink-0">{item.rem}</code>
            <code className="text-xs font-mono text-foreground w-12 shrink-0">{item.px}</code>
            <div className="h-4 bg-primary rounded-sm" style={{ width: item.rem }} />
          </div>
        ))}
      </div>
    </Section>
  </StoryPage>
);
