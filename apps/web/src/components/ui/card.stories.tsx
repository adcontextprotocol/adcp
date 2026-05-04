import type { Story } from "@ladle/react";

import { Section, StoryPage } from "@/stories/_lib";

import { Button } from "./button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./card";

export default {
  title: "Components / Card",
};

export const All: Story = () => (
  <StoryPage
    title="Card"
    description="Container for grouping related content. Composes title, description, content, footer, and action subcomponents."
  >
    <Section title="Basic">
      <Card className="max-w-sm">
        <CardHeader>
          <CardTitle>Card title</CardTitle>
          <CardDescription>Short supporting text describing this card.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            The card body holds the main content. Use for forms, lists, summaries, or whatever the
            card represents.
          </p>
        </CardContent>
        <CardFooter className="gap-2">
          <Button variant="outline">Cancel</Button>
          <Button>Save</Button>
        </CardFooter>
      </Card>
    </Section>

    <Section title="With action in header">
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>Account settings</CardTitle>
          <CardDescription>Manage your account preferences and billing.</CardDescription>
          <CardAction>
            <Button variant="ghost" size="sm">
              Edit
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-muted-foreground">Plan</dt>
            <dd>Pro</dd>
            <dt className="text-muted-foreground">Renewal</dt>
            <dd>Mar 12, 2026</dd>
          </dl>
        </CardContent>
      </Card>
    </Section>

    <Section title="Content only">
      <Card className="max-w-md">
        <CardContent>
          <p className="text-sm">
            A card without a header or footer — just a styled surface. Useful as a stat tile or
            simple grouping.
          </p>
        </CardContent>
      </Card>
    </Section>
  </StoryPage>
);
