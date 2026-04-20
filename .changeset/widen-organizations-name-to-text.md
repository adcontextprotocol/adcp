---
---

Widen `organizations.name` from `VARCHAR(255)` to `TEXT` so WorkOS org names longer than 255 chars no longer crash `syncFromWorkOS`. Unblocks re-landing #2484 (paginated WorkOS sync + lazy local-org creation).
