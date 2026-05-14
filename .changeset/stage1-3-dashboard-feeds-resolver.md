---
---

Stage 1.3 of #4159: migrate the public member-list endpoints (`/api/members`, `/api/members/carousel`, `/api/members/:slug` in `server/src/http.ts`) and the brand-feeds ownership check (`server/src/routes/brand-feeds.ts`) from direct `primary_brand_domain` reads to `getBrandPrimaryDomain[sForOrgs]`. List endpoints exercise the batched variant introduced in PR #4299. No behavioral change post-Stage-0; brand-primary now resolves from `organization_domains.is_primary` (canonical) with `member_profiles` fallback.
