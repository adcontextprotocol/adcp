---
---

fix: eliminate DB pool exhaustion from N+1 queries and untracked background work

- Batch brand lookups in carousel and members endpoints into single `WHERE IN` queries instead of one query per profile
- Batch credential lookups in members endpoint into single query instead of one per org
- Wrap all fire-and-forget enrichOrganization/researchDomain/triageAndNotify calls in trackBackground()
- Drain tracked background work during graceful shutdown before closing DB pool
