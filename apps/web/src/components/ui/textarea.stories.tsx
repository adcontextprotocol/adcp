import type { Story } from "@ladle/react";

import { Section, StoryPage } from "@/stories/_lib";

import { Label } from "./label";
import { Textarea } from "./textarea";

export default {
  title: "Components / Textarea",
};

export const All: Story = () => (
  <StoryPage
    title="Textarea"
    description="Multi-line text input. Use for free-form content like comments, descriptions, or long-form fields."
  >
    <Section title="States">
      <div className="grid gap-4 max-w-md">
        <div className="grid gap-1.5">
          <Label htmlFor="default-ta">Default</Label>
          <Textarea id="default-ta" placeholder="Type your message here." />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="filled-ta">With value</Label>
          <Textarea
            id="filled-ta"
            defaultValue={
              "This is a multi-line value.\nNewlines are preserved.\nGood for descriptions and free-form input."
            }
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="disabled-ta">Disabled</Label>
          <Textarea id="disabled-ta" disabled placeholder="Disabled" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="invalid-ta">Invalid</Label>
          <Textarea id="invalid-ta" aria-invalid="true" defaultValue="too short" />
          <p className="text-xs text-destructive-foreground">
            Description must be at least 20 characters.
          </p>
        </div>
      </div>
    </Section>
  </StoryPage>
);
