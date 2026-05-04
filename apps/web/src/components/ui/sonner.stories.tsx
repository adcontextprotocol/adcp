import type { Story } from "@ladle/react";
import { toast } from "sonner";

import { Section, StoryPage } from "@/stories/_lib";

import { Button } from "./button";

export default {
  title: "Components / Toast (sonner)",
};

export const All: Story = () => (
  <StoryPage
    title="Toast (sonner)"
    description="Transient notification anchored to a screen edge. Use for success/error feedback after an action. Mounted globally via Provider — call toast() from anywhere."
  >
    <Section title="Variants">
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => toast("Event created", { description: "Saved to database." })}>
          Default
        </Button>
        <Button
          onClick={() =>
            toast.success("Saved successfully", { description: "Your changes are live." })
          }
        >
          Success
        </Button>
        <Button onClick={() => toast.warning("Heads up", { description: "Check the audit log." })}>
          Warning
        </Button>
        <Button
          variant="destructive"
          onClick={() => toast.error("Something went wrong", { description: "Try again later." })}
        >
          Error
        </Button>
        <Button
          variant="outline"
          onClick={() => toast.info("FYI", { description: "Tip: keyboard shortcuts available." })}
        >
          Info
        </Button>
      </div>
    </Section>

    <Section title="With action">
      <Button
        onClick={() =>
          toast("Item deleted", {
            description: "Moved to trash.",
            action: { label: "Undo", onClick: () => toast.success("Restored") },
          })
        }
      >
        Delete with undo
      </Button>
    </Section>

    <Section title="Promise">
      <Button
        onClick={() => {
          const promise = new Promise<{ name: string }>((resolve) =>
            setTimeout(() => resolve({ name: "Project" }), 1500),
          );
          toast.promise(promise, {
            loading: "Saving...",
            success: (data) => `${data.name} saved`,
            error: "Save failed",
          });
        }}
      >
        Trigger async save
      </Button>
    </Section>
  </StoryPage>
);
