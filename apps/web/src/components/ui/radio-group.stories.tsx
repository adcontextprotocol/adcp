import type { Story } from "@ladle/react";

import { Section, StoryPage } from "@/stories/_lib";

import { Label } from "./label";
import { RadioGroup, RadioGroupItem } from "./radio-group";

export default {
  title: "Components / Radio group",
};

export const All: Story = () => (
  <StoryPage
    title="Radio group"
    description="Mutually-exclusive choice from a small fixed set of options. Use Select instead when there are many options."
  >
    <Section title="Basic">
      <RadioGroup defaultValue="comfortable">
        <div className="flex items-center gap-2">
          <RadioGroupItem value="default" id="r1" />
          <Label htmlFor="r1">Default</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="comfortable" id="r2" />
          <Label htmlFor="r2">Comfortable</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="compact" id="r3" />
          <Label htmlFor="r3">Compact</Label>
        </div>
      </RadioGroup>
    </Section>

    <Section title="With descriptions">
      <RadioGroup defaultValue="pro">
        <div className="flex items-start gap-3">
          <RadioGroupItem value="free" id="plan-free" />
          <div className="grid gap-0.5">
            <Label htmlFor="plan-free">Free</Label>
            <p className="text-xs text-muted-foreground">Up to 3 projects, community support.</p>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <RadioGroupItem value="pro" id="plan-pro" />
          <div className="grid gap-0.5">
            <Label htmlFor="plan-pro">Pro</Label>
            <p className="text-xs text-muted-foreground">Unlimited projects, email support.</p>
          </div>
        </div>
      </RadioGroup>
    </Section>
  </StoryPage>
);
