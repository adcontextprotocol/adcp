---
---

fix(addie): raise get_schema display limit from 6K to 20K chars and fix misleading truncation note

The previous 6,000-char hard cut silently hid entire oneOf branches in
schemas like creative/preview-render.json (~7.7K) and
creative/preview-creative-response.json (~11K), causing Addie to report
incomplete or structurally incorrect schema information. The truncation
note incorrectly suggested using the `property` parameter, which only
works for schema.properties — not for oneOf/allOf/anyOf union schemas.

Fixes #4397.
