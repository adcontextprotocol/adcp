import type { Story } from "@ladle/react";

import { Section, StoryPage } from "./_lib";

const TYPE_SCALE = [
  { class: "text-xs", size: "12px / 16px" },
  { class: "text-sm", size: "14px / 20px" },
  { class: "text-base", size: "16px / 24px" },
  { class: "text-lg", size: "18px / 28px" },
  { class: "text-xl", size: "20px / 28px" },
  { class: "text-2xl", size: "24px / 32px" },
  { class: "text-3xl", size: "30px / 36px" },
  { class: "text-4xl", size: "36px / 40px" },
];

const FONT_WEIGHTS = [
  { class: "font-normal", label: "font-normal (400)" },
  { class: "font-medium", label: "font-medium (500)" },
  { class: "font-semibold", label: "font-semibold (600)" },
  { class: "font-bold", label: "font-bold (700)" },
];

export default {
  title: "Design tokens / Typography",
};

export const All: Story = () => (
  <StoryPage
    title="Typography"
    description="Tailwind's default text-size scale and font weights."
  >
    <Section title="Type scale">
      <div className="space-y-3">
        {TYPE_SCALE.map((item) => (
          <div
            key={item.class}
            className="flex items-baseline gap-6 border-b border-border pb-3"
          >
            <code className="text-xs font-mono text-foreground w-24 shrink-0">{item.class}</code>
            <code className="text-xs font-mono text-foreground w-28 shrink-0">{item.size}</code>
            <span className={`${item.class} text-foreground`}>The quick brown fox</span>
          </div>
        ))}
      </div>
    </Section>

    <Section title="Font weights">
      <div className="space-y-3">
        {FONT_WEIGHTS.map((item) => (
          <div key={item.class} className="flex items-baseline gap-6 border-b border-border pb-3">
            <code className="text-xs font-mono text-foreground w-44 shrink-0">{item.label}</code>
            <span className={`text-base ${item.class} text-foreground`}>The quick brown fox</span>
          </div>
        ))}
      </div>
    </Section>
  </StoryPage>
);
