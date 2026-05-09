---
---

Stage 1.4 of #4159: migrate the remaining read sites that referenced `member_profiles.primary_brand_domain` directly to use `getBrandPrimaryDomain[sForOrgs]` from the Stage 1 resolver. Touches `services/brand-identity.ts`, `services/brand-property-parse.ts`, `addie/jobs/announcement-trigger.ts` and `profile-completion-nudge.ts` (SQL queries now JOIN `organization_domains.is_primary` instead of selecting from `member_profiles`), `addie/mcp/member-tools.ts`, `routes/si-chat.ts`, `routes/referrals.ts`, and the remaining `routes/member-profiles.ts` GET-resolution + cosmetic-logo paths. After this lands, every legacy READ of `primary_brand_domain` is gone — only writes (dual-writing during transition) and the response-shape field remain. Stage 2 drops both.
