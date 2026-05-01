import type { Story } from "@ladle/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Section, StoryPage } from "@/stories/_lib";

import { Button } from "./button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "./form";
import { Input } from "./input";

const profileSchema = z.object({
  username: z
    .string()
    .min(2, "Must be at least 2 characters.")
    .max(30, "Must be 30 characters or fewer."),
  email: z.string().email("Must be a valid email."),
});

type ProfileValues = z.infer<typeof profileSchema>;

function ProfileForm() {
  const form = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: { username: "", email: "" },
  });

  function onSubmit(values: ProfileValues) {
    // eslint-disable-next-line no-alert
    alert(JSON.stringify(values, null, 2));
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6 max-w-sm">
        <FormField
          control={form.control}
          name="username"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Username</FormLabel>
              <FormControl>
                <Input placeholder="shadcn" {...field} />
              </FormControl>
              <FormDescription>This is your public display name.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input type="email" placeholder="you@example.com" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit">Submit</Button>
      </form>
    </Form>
  );
}

export default {
  title: "Components / Form",
};

export const All: Story = () => (
  <StoryPage
    title="Form"
    description="shadcn's Form component is the integration layer between react-hook-form and the field primitives. It auto-wires field IDs, error messages, and aria attributes."
  >
    <Section title="With zod validation">
      <ProfileForm />
    </Section>
  </StoryPage>
);
