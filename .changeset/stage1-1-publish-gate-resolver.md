---
---

Stage 1.1 of #4159: migrate the publish-agent gate (`applyAgentVisibility` in `server/src/routes/member-profiles.ts`) from direct `member_profiles.primary_brand_domain` reads to `getBrandPrimaryDomain(orgId)`. Drops the column from the FOR-UPDATE SELECT; brand-primary lookup now goes through the resolver. Behavior unchanged — reads org_domains.is_primary first, falls back to member_profiles for orgs Stage 0 missed.
