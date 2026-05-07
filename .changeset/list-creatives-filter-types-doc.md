---
"adcontextprotocol": patch
---

docs(creative): tighten type column in the `list_creatives` filtering options table to match `core/creative-filters.json`. `accounts` now shows `AccountRef[]` (was `array`), `format_ids` shows `FormatID[]` (was `format_id[]`, matching the casing used in `list_creative_formats`, `get_products`, and `create_media_buy`), and `statuses` links to `CreativeStatus` rather than the under-specified `string[]`. Docs only — no schema or wire-format change. Patch-eligible per the non-normative-docs rule in `.agents/playbook.md`.
