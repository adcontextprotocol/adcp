---
---

Server: migrate WorkOS webhook (`syncOrganizationDomains`, `upsertOrganizationDomain`, `deleteSingleOrganizationDomain`) to use new canonical writers in `db/organization-domains-db.ts` — `upsertDomainFromWorkos`, `autoPromotePrimaryIfNone`, `removeWorkosDomainAndReselectPrimary`. The new primitives accept an optional `Queryable` so the webhook can compose them under its existing `FOR UPDATE` lock. Stage 3b of #4159.
