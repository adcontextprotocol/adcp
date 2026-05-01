import type { Story } from "@ladle/react";

import { Section, StoryPage } from "@/stories/_lib";

import { Label } from "./label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "./select";

export default {
  title: "Components / Select",
};

export const All: Story = () => (
  <StoryPage
    title="Select"
    description="Dropdown for choosing one value from a list. Use for many options (5+); use RadioGroup for fewer."
  >
    <Section title="Basic">
      <div className="grid gap-1.5 max-w-sm">
        <Label htmlFor="fruit">Favorite fruit</Label>
        <Select>
          <SelectTrigger id="fruit">
            <SelectValue placeholder="Select a fruit" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="apple">Apple</SelectItem>
            <SelectItem value="banana">Banana</SelectItem>
            <SelectItem value="blueberry">Blueberry</SelectItem>
            <SelectItem value="grapes">Grapes</SelectItem>
            <SelectItem value="pineapple">Pineapple</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </Section>

    <Section title="Grouped">
      <div className="grid gap-1.5 max-w-sm">
        <Label htmlFor="timezone">Timezone</Label>
        <Select>
          <SelectTrigger id="timezone">
            <SelectValue placeholder="Select a timezone" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>North America</SelectLabel>
              <SelectItem value="est">Eastern (EST)</SelectItem>
              <SelectItem value="cst">Central (CST)</SelectItem>
              <SelectItem value="pst">Pacific (PST)</SelectItem>
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>Europe</SelectLabel>
              <SelectItem value="gmt">GMT</SelectItem>
              <SelectItem value="cet">Central European (CET)</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    </Section>

    <Section title="Disabled">
      <div className="grid gap-1.5 max-w-sm">
        <Label htmlFor="disabled-select">Locked</Label>
        <Select disabled defaultValue="locked">
          <SelectTrigger id="disabled-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="locked">Locked value</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </Section>
  </StoryPage>
);
