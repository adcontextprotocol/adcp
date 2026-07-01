import type { Story } from "@ladle/react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import { Section, StoryPage } from "./_lib";

export default {
  title: "Design tokens / Muted-foreground audit",
};

function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-xs text-body-foreground max-w-prose">{children}</p>;
}

export const All: Story = () => (
  <StoryPage
    title="muted-foreground audit"
    description={
      <>
        The two contexts where <code className="text-xs">text-muted-foreground</code> remains in the
        design system. Everywhere else (descriptions, helper text, icons, de-emphasized labels,
        shortcut hints, faint metadata) uses <code className="text-xs">text-body-foreground</code>.
      </>
    }
  >
    <Section title="Paired with bg-muted (shadcn convention)">
      <div className="flex items-center gap-6">
        <Avatar>
          <AvatarFallback>KC</AvatarFallback>
        </Avatar>
        <Badge variant="neutral">Neutral badge</Badge>
      </div>
      <Note>
        Avatar fallback initials and Badge `neutral` variant pair a muted surface with muted text —
        the canonical shadcn use of the `--muted` / `--muted-foreground` token pair. Both halves
        travel together; changing only the foreground breaks the pairing.
      </Note>
    </Section>

    <Section title="Placeholders">
      <div className="grid gap-3 max-w-sm">
        <Input placeholder="Search organizations…" />
        <Textarea placeholder="Tell us what happened…" rows={3} />
        <Select>
          <SelectTrigger>
            <SelectValue placeholder="Pick an option" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">Option A</SelectItem>
            <SelectItem value="b">Option B</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Note>
        Input, Textarea, and Select empty-state all use{" "}
        <code className="text-xs">placeholder:text-muted-foreground</code> /{" "}
        <code className="text-xs">data-[placeholder]:text-muted-foreground</code>. Placeholders must
        look distinctly fainter than typed text — body-foreground is brighter than muted-foreground
        in dark mode, which would draw attention away from typed content.
      </Note>
    </Section>
  </StoryPage>
);
