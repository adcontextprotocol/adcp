---
---

`apps/web/`: migrate descriptive copy and de-emphasized text from `--muted-foreground` to `--body-foreground` per the token roles documented in the Color story. Production components updated: TableCaption, Tabs (inactive triggers), Select (group label, item icons, trigger icons), DropdownMenu (item/sub-trigger icons, shortcut hints), Dialog (close button). Story examples updated: Card, Checkbox, Popover, Radio Group, Separator, Switch, Tooltip. `--muted-foreground` is retained for placeholders (Input, Textarea, Select empty state) and shadcn paired tokens (Avatar fallback, Badge neutral). Adds a "Muted-foreground audit" Ladle story documenting the remaining intentional uses.
