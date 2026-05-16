---
---

feat(server): Stage 2 of #4159 — drop `member_profiles.primary_brand_domain`

After Stage 1 routed every read through `getBrandPrimaryDomain` (resolver-first, column-fallback), Stage 2 cuts the column entirely. `organization_domains.is_primary=true` is now the single source of truth for both org-membership inference and brand identity — one row, one write, no more drift.

Removed:

- the `member_profiles.primary_brand_domain` column (migration 472);
- the resolver fallback to `member_profiles` (`getBrandPrimaryDomain` now reads only `organization_domains.is_primary`);
- the WorkOS-webhook auto-populate that wrote `member_profiles.primary_brand_domain` on first verified domain — the auto-promote-to-`is_primary` on `organization_domains` covers the same ground in one row;
- `PUT /api/me/organization/domains/:domain/primary` and the brand-identity service's dual-write to `member_profiles`;
- the `/api/me/agents` POST backfill that set `primary_brand_domain` from agent hostnames;
- the bootstrap endpoint's acceptance of `primary_brand_domain` in the request body (silently ignored — derived from `organization_domains.is_primary`);
- the `Stage0` data-cleanup and backfill scripts (one-shot work complete).

Added:

- a 400 `domain_not_workos_verified` response on `PUT /api/me/organization/domains/:domain/primary` for non-WorkOS sources. With `is_primary` now driving brand identity too, an admin-imported "verified" row shouldn't be promotable via member self-service.

The API response field `primary_brand_domain` on `GET /api/me/member-profile` is preserved for client compatibility, but its value is now derived from the resolver rather than stored on the profile.
