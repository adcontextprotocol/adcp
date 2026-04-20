---
---

Truncate WorkOS org names to 255 chars in `syncFromWorkOS` / `ensureOrganizationExists` so one upstream org with an oversized name no longer aborts the whole sync with `value too long for type character varying(255)`.
