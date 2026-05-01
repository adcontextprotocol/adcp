import type { Story } from "@ladle/react";

import { Section, StoryPage } from "@/stories/_lib";

import { Separator } from "./separator";

export default {
  title: "Components / Separator",
};

export const All: Story = () => (
  <StoryPage
    title="Separator"
    description="Visual divider between content blocks. Horizontal by default; can be vertical."
  >
    <Section title="Horizontal">
      <div className="space-y-4">
        <div>
          <h4 className="text-sm font-medium">Radix primitives</h4>
          <p className="text-xs text-muted-foreground">An open-source UI component library.</p>
        </div>
        <Separator />
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span>Blog</span>
          <Separator orientation="vertical" className="h-4" />
          <span>Docs</span>
          <Separator orientation="vertical" className="h-4" />
          <span>Source</span>
        </div>
      </div>
    </Section>
  </StoryPage>
);
