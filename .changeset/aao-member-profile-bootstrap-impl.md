---
---

feat(registry): implement the `POST /api/me/member-profile` REST bootstrap handler

Companion to the spec landed in `aao-member-profile-create-endpoint.md` — that change defined the contract but explicitly punted the backend implementation. This change wires it up.

The route at `/api/me/member-profile` already had a handler used by the dashboard's profile-edit page (body shape: `display_name`, `slug`, agents, …; `409` on conflict). Rather than break that flow, the POST handler now dispatches on body shape: when the request body matches the spec contract (`organization_name` + `corporate_domain`, no `display_name`/`slug`), the new bootstrap branch runs; otherwise the existing dashboard handler runs unchanged.

The bootstrap branch:

- validates `organization_name`, `company_type`, `corporate_domain`, optional `revenue_tier`/`membership_tier`/`primary_brand_domain` against the actual `COMPANY_TYPE_VALUES`, `VALID_REVENUE_TIERS`, `VALID_MEMBERSHIP_TIERS` constants used elsewhere in the codebase;
- enforces the email-domain invariant (rejects personal email domains and any mismatch between the caller's verified email domain and the supplied `corporate_domain`);
- resolves the target org from `?org=` or the caller's primary WorkOS organization (admin/owner only);
- returns `200` with a `profile_already_exists` warning when a profile already exists for the org, instead of `409`, matching the spec's idempotency contract;
- on first-time create, persists `organization_name`/`company_type`/`revenue_tier`/`membership_tier` on the organization row, inserts an email-verified record into `organization_domains`, generates a unique slug, creates the member profile (`is_public: false` by default — the visibility PUT is the explicit knob for going public), records the marketing opt-in best-effort, and returns the spec-shape `MemberProfile` body.

Also corrects the published OpenAPI to match the actual database value sets — the original spec listed enum values (`MemberCompanyType: dsp/ssp/measurement/identity/infrastructure/...`, `MemberRevenueTier: 1m_to_10m/...`, `membership_tier: free/builder/professional`) that don't exist anywhere in the codebase. Replaced with the real values: `[adtech, agency, brand, publisher, data, ai, other]`, `[under_1m, 1m_5m, 5m_50m, 50m_250m, 250m_1b, 1b_plus]`, and `[individual_professional, individual_academic, company_standard, company_icl, company_leader]`. `membership_tier` on the response is now optional (omitted entirely for orgs on the free Explorer baseline) since `null` is the predominant state.
