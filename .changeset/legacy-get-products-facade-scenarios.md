---
"adcontextprotocol": patch
---

Add four storyboards that grade the retained `get_products` facade against the field-specific obligations in the legacy and compact lifecycle compatibility spec (adcp#7403): `filters.format_ids` must match the declaring agent and format parameters, `preferred_delivery_types` must not exclude products, a `fields` projection must keep legacy-only members, and a `refine[]` batch larger than the compact 25-entry limit must be applied whole. In each storyboard, rejecting the input at its original path is the other conformant outcome. The training agent now compares format parameters when it evaluates `filters.format_ids`.
