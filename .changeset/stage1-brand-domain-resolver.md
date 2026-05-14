---
---

Stage 1 of #4159: introduce `getBrandPrimaryDomain(orgId)` and `getBrandPrimaryDomainsForOrgs(orgIds)` in `server/src/services/brand-domain-resolver.ts`. Reads `organization_domains.is_primary=true` first, falls back to `member_profiles.primary_brand_domain` (logs a warn). Single read surface for the brand-identity facet ahead of Stage 2 dropping the column. No call site changes — those land in subsequent PRs.
