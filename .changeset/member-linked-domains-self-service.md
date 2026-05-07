---
---

Member self-service for org-linked domains: GET /api/me/organization/domains and PUT /api/me/organization/domains/:domain/primary. The PUT writes BOTH `organization_domains.is_primary` and `member_profiles.primary_brand_domain` in a single transaction so members don't have to know about the two-primary distinction. Adds a Linked Domains card to the member-profile UI for company orgs. Closes #4158 (Stage 2 of the domain-cleanup series). POST/DELETE deferred to a follow-up since they require WorkOS verification-flow integration.
