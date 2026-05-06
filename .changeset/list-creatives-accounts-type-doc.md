---
---

docs(creative): document `accounts` filter item type as `AccountRef[]` in `list_creatives` filtering options table. The type column previously showed `array` without indicating the item shape; the schema (`core/creative-filters.json`) uses `$ref: account-ref.json`. Follows the existing `AccountRef` link pattern used for the top-level `account` parameter in the same file.
