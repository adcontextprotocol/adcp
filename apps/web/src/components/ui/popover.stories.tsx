import type { Story } from "@ladle/react";

import { Section, StoryPage } from "@/stories/_lib";

import { Button } from "./button";
import { Input } from "./input";
import { Label } from "./label";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

export default {
  title: "Components / Popover",
};

export const All: Story = () => (
  <StoryPage
    title="Popover"
    description="Floating panel anchored to a trigger. Less heavyweight than a Dialog — use for inline forms, quick edits, or info reveals."
  >
    <Section title="With form fields">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">Open dimensions</Button>
        </PopoverTrigger>
        <PopoverContent className="w-80">
          <div className="grid gap-4">
            <div>
              <h4 className="font-medium">Dimensions</h4>
              <p className="text-xs text-muted-foreground">Set the dimensions for the layer.</p>
            </div>
            <div className="grid gap-2">
              <div className="grid grid-cols-3 items-center gap-4">
                <Label htmlFor="width">Width</Label>
                <Input id="width" defaultValue="100%" className="col-span-2 h-8" />
              </div>
              <div className="grid grid-cols-3 items-center gap-4">
                <Label htmlFor="height">Height</Label>
                <Input id="height" defaultValue="25px" className="col-span-2 h-8" />
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </Section>

    <Section title="Info popover">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm">
            What&apos;s this?
          </Button>
        </PopoverTrigger>
        <PopoverContent className="text-sm">
          A Popover is a non-modal floating panel. Click outside or press ESC to close.
        </PopoverContent>
      </Popover>
    </Section>
  </StoryPage>
);
