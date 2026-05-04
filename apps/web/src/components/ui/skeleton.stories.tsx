import type { Story } from "@ladle/react";

import { Section, StoryPage } from "@/stories/_lib";

import { Skeleton } from "./skeleton";

export default {
  title: "Components / Skeleton",
};

export const All: Story = () => (
  <StoryPage
    title="Skeleton"
    description="Loading placeholder. Use shapes that approximate the real content so the layout doesn't shift when data arrives."
  >
    <Section title="Card placeholder">
      <div className="flex items-center gap-4">
        <Skeleton className="h-12 w-12 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-[250px]" />
          <Skeleton className="h-4 w-[200px]" />
        </div>
      </div>
    </Section>

    <Section title="List placeholder">
      <div className="space-y-3 max-w-md">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-4">
            <Skeleton className="h-10 w-10 rounded-md" />
            <div className="space-y-2 flex-1">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </Section>

    <Section title="Article placeholder">
      <div className="space-y-3 max-w-md">
        <Skeleton className="h-32 w-full rounded-md" />
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
      </div>
    </Section>
  </StoryPage>
);
