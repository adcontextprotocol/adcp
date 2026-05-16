import type { Story } from "@ladle/react";
import { ArrowRight, Loader2, Trash2 } from "lucide-react";

import { Section, StoryPage } from "@/stories/_lib";

import { Button } from "./button";

export default {
  title: "Components / Button",
};

export const All: Story = () => (
  <StoryPage
    title="Button"
    description="The standard action element. Use for any clickable affordance that triggers an action."
  >
    <Section title="Variants">
      <div className="flex flex-wrap gap-3">
        <Button variant="default">Default</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="link">Link</Button>
        <Button variant="destructive">Destructive</Button>
      </div>
    </Section>

    <Section title="Sizes">
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm">Small</Button>
        <Button size="default">Default</Button>
        <Button size="lg">Large</Button>
        <Button size="icon" aria-label="Delete">
          <Trash2 />
        </Button>
      </div>
    </Section>

    <Section title="With icons">
      <div className="flex flex-wrap gap-3">
        <Button>
          Continue <ArrowRight />
        </Button>
        <Button variant="outline">
          <Trash2 /> Delete
        </Button>
      </div>
    </Section>

    <Section title="Loading & disabled">
      <div className="flex flex-wrap gap-3">
        <Button disabled>
          <Loader2 className="animate-spin" /> Saving
        </Button>
        <Button variant="secondary" disabled>
          Disabled
        </Button>
      </div>
    </Section>
  </StoryPage>
);
