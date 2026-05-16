import type { Story } from "@ladle/react";

import { Section, StoryPage } from "@/stories/_lib";

import { Avatar, AvatarFallback, AvatarImage } from "./avatar";

export default {
  title: "Components / Avatar",
};

export const All: Story = () => (
  <StoryPage
    title="Avatar"
    description="User profile picture with fallback initials when image is missing or fails to load."
  >
    <Section title="Image with fallback">
      <div className="flex items-center gap-3">
        <Avatar>
          <AvatarImage src="https://github.com/shadcn.png" alt="@shadcn" />
          <AvatarFallback>CN</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarImage src="https://broken-url.example/photo.png" alt="Broken" />
          <AvatarFallback>JD</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>KC</AvatarFallback>
        </Avatar>
      </div>
    </Section>

    <Section title="Sizes (via className)">
      <div className="flex items-center gap-3">
        <Avatar className="size-6">
          <AvatarFallback className="text-xs">XS</AvatarFallback>
        </Avatar>
        <Avatar className="size-8">
          <AvatarFallback className="text-xs">SM</AvatarFallback>
        </Avatar>
        <Avatar className="size-10">
          <AvatarFallback>MD</AvatarFallback>
        </Avatar>
        <Avatar className="size-14">
          <AvatarFallback className="text-base">LG</AvatarFallback>
        </Avatar>
        <Avatar className="size-20">
          <AvatarFallback className="text-xl">XL</AvatarFallback>
        </Avatar>
      </div>
    </Section>
  </StoryPage>
);
