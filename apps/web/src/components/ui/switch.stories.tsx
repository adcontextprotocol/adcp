import type { Story } from "@ladle/react";

import { Section, StoryPage } from "@/stories/_lib";

import { Label } from "./label";
import { Switch } from "./switch";

export default {
  title: "Components / Switch",
};

export const All: Story = () => (
  <StoryPage
    title="Switch"
    description="Boolean toggle for settings that take effect immediately. Use Checkbox instead for staged form input."
  >
    <Section title="States">
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Switch id="off" />
          <Label htmlFor="off">Off (default)</Label>
        </div>
        <div className="flex items-center gap-3">
          <Switch id="on" defaultChecked />
          <Label htmlFor="on">On</Label>
        </div>
        <div className="flex items-center gap-3">
          <Switch id="disabled-off" disabled />
          <Label htmlFor="disabled-off">Disabled off</Label>
        </div>
        <div className="flex items-center gap-3">
          <Switch id="disabled-on" disabled defaultChecked />
          <Label htmlFor="disabled-on">Disabled on</Label>
        </div>
      </div>
    </Section>

    <Section title="With description (settings pattern)">
      <div className="flex items-start justify-between gap-6 max-w-md rounded-md border border-border p-4">
        <div className="space-y-0.5">
          <Label htmlFor="notifications">Email notifications</Label>
          <p className="text-xs text-muted-foreground">
            Receive an email when something happens that needs your attention.
          </p>
        </div>
        <Switch id="notifications" defaultChecked />
      </div>
    </Section>
  </StoryPage>
);
