import type { Story } from "@ladle/react";

import { Section, StoryPage } from "@/stories/_lib";

import { Button } from "./button";
import { Input } from "./input";
import { Label } from "./label";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./sheet";

export default {
  title: "Components / Sheet",
};

export const All: Story = () => (
  <StoryPage
    title="Sheet"
    description="Slide-in panel from any edge. Heavier than Popover, lighter than full-page nav. Good for filter panels, side details, mobile nav."
  >
    <Section title="From the right (default)">
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="outline">Open right sheet</Button>
        </SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Edit profile</SheetTitle>
            <SheetDescription>
              Make changes to your profile here. Click save when you&apos;re done.
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-4 px-4">
            <div className="grid gap-2">
              <Label htmlFor="sheet-name">Name</Label>
              <Input id="sheet-name" defaultValue="Pedro Duarte" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sheet-username">Username</Label>
              <Input id="sheet-username" defaultValue="@peduarte" />
            </div>
          </div>
          <SheetFooter>
            <Button>Save changes</Button>
            <SheetClose asChild>
              <Button variant="outline">Cancel</Button>
            </SheetClose>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </Section>

    <Section title="Different sides">
      <div className="flex flex-wrap gap-3">
        {(["top", "right", "bottom", "left"] as const).map((side) => (
          <Sheet key={side}>
            <SheetTrigger asChild>
              <Button variant="outline">From {side}</Button>
            </SheetTrigger>
            <SheetContent side={side}>
              <SheetHeader>
                <SheetTitle>Sheet from the {side}</SheetTitle>
                <SheetDescription>
                  Slide-in panel anchored to the {side} edge of the viewport.
                </SheetDescription>
              </SheetHeader>
            </SheetContent>
          </Sheet>
        ))}
      </div>
    </Section>
  </StoryPage>
);
