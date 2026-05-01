import type { Story } from "@ladle/react";
import { Check } from "lucide-react";

import { Section, StoryPage } from "@/stories/_lib";

import { Badge } from "./badge";

export default {
  title: "Components / Badge",
};

export const All: Story = () => (
  <StoryPage
    title="Badge"
    description="Compact label for status, counts, or short descriptors."
  >
    <Section title="Variants">
      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="outline">Outline</Badge>
      </div>
    </Section>

    <Section title="Status colors">
      <div className="flex flex-wrap gap-2">
        <Badge variant="success">Success</Badge>
        <Badge variant="warning">Warning</Badge>
        <Badge variant="info">Info</Badge>
        <Badge variant="neutral">Neutral</Badge>
        <Badge variant="destructive">Destructive</Badge>
      </div>
      <p className="text-xs text-body-foreground mt-3 max-w-prose">
        Canonical mapping: <code className="text-xs">active / live / approved</code> →
        success · <code className="text-xs">pending / review</code> → warning ·
        <code className="text-xs">prospect / new</code> → info ·
        <code className="text-xs">inactive / expired / archived</code> → neutral ·
        <code className="text-xs">error / failed / rejected</code> → destructive.
      </p>
    </Section>

    <Section title="With icon">
      <div className="flex flex-wrap gap-2">
        <Badge>
          <Check /> Verified
        </Badge>
        <Badge variant="success">
          <Check /> Active
        </Badge>
      </div>
    </Section>

    <Section title="Status set">
      <div className="flex flex-wrap gap-2">
        <Badge variant="success">Live</Badge>
        <Badge variant="warning">Pending</Badge>
        <Badge variant="info">New</Badge>
        <Badge variant="neutral">Archived</Badge>
        <Badge variant="destructive">Failed</Badge>
      </div>
    </Section>
  </StoryPage>
);
