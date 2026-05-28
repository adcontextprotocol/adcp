---
"adcontextprotocol": patch
---

Fix `supported_macros` schema validation for standard universal macro names.

`core/format.supported_macros.items` now uses `anyOf` so universal macro enum
values such as `MEDIA_BUY_ID`, `CREATIVE_ID`, `CACHEBUSTER`, and `CLICK_URL`
validate without conflicting with the custom string branch. Fixes #5099.
