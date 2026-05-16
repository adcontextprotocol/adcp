import type { Story } from "@ladle/react";

import { Section, StoryPage } from "./_lib";

const RADIUS_TOKENS = [
  { class: "rounded-none", token: "0", desc: "No rounding" },
  { class: "rounded-[var(--radius)]", token: "--radius", desc: "Root token (0.25rem)" },
  { class: "rounded-sm", token: "--radius-sm", desc: "max(0, --radius - 4px)" },
  { class: "rounded-md", token: "--radius-md", desc: "= --radius" },
  { class: "rounded-lg", token: "--radius-lg", desc: "= --radius + 4px" },
  { class: "rounded-xl", token: "--radius-xl", desc: "= --radius + 8px" },
  { class: "rounded-full", token: "9999px", desc: "Fully rounded (pill / circle)" },
];

export default {
  title: "Design tokens / Border radius",
};

export const All: Story = () => (
  <StoryPage
    title="Border radius"
    description={
      <>
        Radius values derive from the <code className="text-xs">--radius</code> root token. Adjust
        it once to scale the whole system.
      </>
    }
  >
    <Section title="Scale">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {RADIUS_TOKENS.map((item) => (
          <div
            key={item.class}
            className="flex flex-col items-center gap-3 rounded-md border border-border bg-card p-4"
          >
            <div className={`h-20 w-20 bg-primary ${item.class}`} />
            <div className="text-center">
              <code className="text-sm font-mono text-foreground block">{item.class}</code>
              <code className="text-xs font-mono text-foreground block mt-1">{item.token}</code>
              <p className="text-xs text-body-foreground mt-1">{item.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </Section>
  </StoryPage>
);
