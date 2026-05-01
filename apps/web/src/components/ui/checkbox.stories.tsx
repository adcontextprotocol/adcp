import type { Story } from "@ladle/react";

import { Section, StoryPage } from "@/stories/_lib";

import { Checkbox } from "./checkbox";
import { Label } from "./label";

export default {
  title: "Components / Checkbox",
};

export const All: Story = () => (
  <StoryPage
    title="Checkbox"
    description="Boolean toggle for binary choices. Pair with a Label for accessibility."
  >
    <Section title="States">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Checkbox id="default" />
          <Label htmlFor="default">Default (unchecked)</Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="checked" defaultChecked />
          <Label htmlFor="checked">Checked</Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="disabled" disabled />
          <Label htmlFor="disabled">Disabled</Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="disabled-checked" disabled defaultChecked />
          <Label htmlFor="disabled-checked">Disabled + checked</Label>
        </div>
      </div>
    </Section>

    <Section title="With description">
      <div className="flex items-start gap-3">
        <Checkbox id="terms" />
        <div className="grid gap-1.5 leading-none">
          <Label htmlFor="terms">Accept terms and conditions</Label>
          <p className="text-xs text-muted-foreground">
            You agree to our Terms of Service and Privacy Policy.
          </p>
        </div>
      </div>
    </Section>
  </StoryPage>
);
