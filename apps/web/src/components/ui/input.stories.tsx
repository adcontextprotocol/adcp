import type { Story } from "@ladle/react";

import { Section, StoryPage } from "@/stories/_lib";

import { Input } from "./input";

export default {
  title: "Components / Input",
};

export const All: Story = () => (
  <StoryPage
    title="Input"
    description="Text input field. Combine with a <label> and react-hook-form for accessible forms."
  >
    <Section title="States">
      <div className="max-w-sm space-y-4">
        <div className="grid gap-1.5">
          <label htmlFor="default" className="text-sm font-medium">
            Default
          </label>
          <Input id="default" placeholder="Type something..." />
        </div>

        <div className="grid gap-1.5">
          <label htmlFor="filled" className="text-sm font-medium">
            With value
          </label>
          <Input id="filled" defaultValue="hello@example.com" />
        </div>

        <div className="grid gap-1.5">
          <label htmlFor="disabled" className="text-sm font-medium">
            Disabled
          </label>
          <Input id="disabled" disabled placeholder="Disabled" />
        </div>

        <div className="grid gap-1.5">
          <label htmlFor="invalid" className="text-sm font-medium">
            Invalid
          </label>
          <Input id="invalid" aria-invalid="true" defaultValue="not-an-email" />
          <p className="text-xs text-destructive-foreground">Please enter a valid email.</p>
        </div>
      </div>
    </Section>

    <Section title="Types">
      <div className="max-w-sm space-y-4">
        <div className="grid gap-1.5">
          <label htmlFor="email" className="text-sm font-medium">
            Email
          </label>
          <Input id="email" type="email" placeholder="you@example.com" />
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="password" className="text-sm font-medium">
            Password
          </label>
          <Input id="password" type="password" placeholder="••••••••" />
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="number" className="text-sm font-medium">
            Number
          </label>
          <Input id="number" type="number" placeholder="0" />
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="search" className="text-sm font-medium">
            Search
          </label>
          <Input id="search" type="search" placeholder="Search..." />
        </div>
      </div>
    </Section>
  </StoryPage>
);
