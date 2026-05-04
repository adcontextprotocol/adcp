import type { Story } from "@ladle/react";
import { Info } from "lucide-react";

import { Section, StoryPage } from "@/stories/_lib";

import { Button } from "./button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

export default {
  title: "Components / Tooltip",
};

export const All: Story = () => (
  <StoryPage
    title="Tooltip"
    description="Hover/focus reveal for short, supplementary text. Don't use for critical info — keyboard users may miss it. TooltipProvider is mounted globally in .ladle/components.tsx."
  >
    <Section title="On a button">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline">Hover me</Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>Add to library</p>
        </TooltipContent>
      </Tooltip>
    </Section>

    <Section title="Info icon (common pattern)">
      <div className="flex items-center gap-2">
        <span className="text-sm">Active brands</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="text-muted-foreground hover:text-foreground">
              <Info className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p className="max-w-xs">
              A brand is &quot;active&quot; if its agent has responded to at least one signal in the
              last 30 days.
            </p>
          </TooltipContent>
        </Tooltip>
      </div>
    </Section>

    <Section title="Different sides">
      <div className="flex flex-wrap gap-3">
        {(["top", "right", "bottom", "left"] as const).map((side) => (
          <Tooltip key={side}>
            <TooltipTrigger asChild>
              <Button variant="outline">{side}</Button>
            </TooltipTrigger>
            <TooltipContent side={side}>
              <p>Tooltip from the {side}</p>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </Section>
  </StoryPage>
);
