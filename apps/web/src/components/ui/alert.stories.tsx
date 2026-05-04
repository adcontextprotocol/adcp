import type { Story } from "@ladle/react";
import { AlertCircle, CheckCircle2, Info, Terminal } from "lucide-react";

import { Section, StoryPage } from "@/stories/_lib";

import { Alert, AlertDescription, AlertTitle } from "./alert";

export default {
  title: "Components / Alert",
};

export const All: Story = () => (
  <StoryPage
    title="Alert"
    description="Inline message for status, info, or errors. Lives in page flow (vs Toast which is transient)."
  >
    <Section title="Default">
      <Alert>
        <Terminal />
        <AlertTitle>Heads up!</AlertTitle>
        <AlertDescription>You can add components and dependencies via the CLI.</AlertDescription>
      </Alert>
    </Section>

    <Section title="Destructive">
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>Your session has expired. Please log in again.</AlertDescription>
      </Alert>
    </Section>

    <Section title="Composing for status (custom)">
      <div className="space-y-3">
        <Alert>
          <CheckCircle2 />
          <AlertTitle>Saved</AlertTitle>
          <AlertDescription>Your changes have been saved successfully.</AlertDescription>
        </Alert>
        <Alert>
          <Info />
          <AlertTitle>Note</AlertTitle>
          <AlertDescription>
            shadcn ships <code className="text-xs">default</code> +{" "}
            <code className="text-xs">destructive</code> only. For success/warning/info we&apos;ll
            add custom variants when needed.
          </AlertDescription>
        </Alert>
      </div>
    </Section>
  </StoryPage>
);
