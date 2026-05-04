import type { Story } from "@ladle/react";
import { LogOut, Settings, User } from "lucide-react";

import { Section, StoryPage } from "@/stories/_lib";

import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "./dropdown-menu";

export default {
  title: "Components / Dropdown menu",
};

export const All: Story = () => (
  <StoryPage
    title="Dropdown menu"
    description="Contextual menu attached to a trigger. Use for user menus, action menus, and any 'click to reveal options' UI."
  >
    <Section title="Basic">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">Open menu</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>My account</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem>
              <User /> Profile
              <DropdownMenuShortcut>⇧⌘P</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Settings /> Settings
              <DropdownMenuShortcut>⌘,</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive">
            <LogOut /> Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Section>

    <Section title="With checkboxes">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">Toggle columns</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem checked>Status</DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked>Email</DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem>Created at</DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Section>

    <Section title="With radio">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">Select sort</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Sort by</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value="newest">
            <DropdownMenuRadioItem value="newest">Newest</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="oldest">Oldest</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="alpha">A → Z</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </Section>
  </StoryPage>
);
