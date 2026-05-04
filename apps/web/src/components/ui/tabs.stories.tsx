import type { Story } from "@ladle/react";

import { Section, StoryPage } from "@/stories/_lib";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

export default {
  title: "Components / Tabs",
};

export const All: Story = () => (
  <StoryPage
    title="Tabs"
    description="Group of related views in the same context. Use for settings sections, multi-tab forms, or detail views."
  >
    <Section title="Basic">
      <Tabs defaultValue="account" className="max-w-md">
        <TabsList>
          <TabsTrigger value="account">Account</TabsTrigger>
          <TabsTrigger value="password">Password</TabsTrigger>
          <TabsTrigger value="api">API</TabsTrigger>
        </TabsList>
        <TabsContent value="account" className="rounded-md border border-border bg-card p-4">
          <p className="text-sm">Account settings — name, email, profile picture.</p>
        </TabsContent>
        <TabsContent value="password" className="rounded-md border border-border bg-card p-4">
          <p className="text-sm">Change password and 2FA settings.</p>
        </TabsContent>
        <TabsContent value="api" className="rounded-md border border-border bg-card p-4">
          <p className="text-sm">API keys, webhooks, rate limits.</p>
        </TabsContent>
      </Tabs>
    </Section>
  </StoryPage>
);
