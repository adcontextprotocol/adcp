---
---

Backfill `organizations.email_domain` from `organization_domains` on non-personal orgs where the column was left NULL by the WorkOS webhook race. Catches the population of "orphaned" prospect orgs that fall outside `findPayingOrgForDomain`'s auto-link path because no `email_domain` is set, even though a verified `organization_domains` row exists. Idempotent; only fills NULL/empty values.
