import type { Story } from "@ladle/react";

import { Section, StoryPage } from "@/stories/_lib";

import { Checkbox } from "./checkbox";
import { Input } from "./input";
import { Label } from "./label";

export default {
  title: "Components / Label",
};

export const All: Story = () => (
  <StoryPage
    title="Label"
    description="Accessible label for form controls. Always pair with Input, Checkbox, RadioGroup, etc. via htmlFor."
  >
    <Section title="With Input">
      <div className="grid gap-1.5 max-w-sm">
        <Label htmlFor="email-label">Email</Label>
        <Input id="email-label" type="email" placeholder="you@example.com" />
      </div>
    </Section>

    <Section title="With Checkbox">
      <div className="flex items-center gap-2">
        <Checkbox id="newsletter" />
        <Label htmlFor="newsletter">Subscribe to newsletter</Label>
      </div>
    </Section>

    <Section title="With required indicator">
      <div className="grid gap-1.5 max-w-sm">
        <Label htmlFor="required-field">
          Full name <span className="text-destructive-foreground">*</span>
        </Label>
        <Input id="required-field" required />
      </div>
    </Section>
  </StoryPage>
);
