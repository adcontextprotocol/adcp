---
---

fix(registry): harden the `POST /api/me/member-profile` REST bootstrap surface

Follow-up to `aao-member-profile-bootstrap-impl.md`. The bootstrap handler that change shipped wrote org-level fields and accepted membership tiers without billing or audit trail — fine for the spec contract, risky for a public REST surface a third-party app can hit with only a user's OAuth token. This change closes four concrete gaps:

- **Paid `membership_tier` values are now rejected with `400 "Paid tier requires checkout"`.** The endpoint previously accepted `company_leader` etc. and wrote the value straight to `organizations.membership_tier`. Any downstream code path that gates entitlements on `membership_tier` directly (rather than `subscription_status`) could be fooled into granting paid features without billing. The body now only accepts `individual_academic` (the free Explorer baseline) or omitted; paid tiers must come through Stripe checkout, where the webhook stamps the tier on the org row.
- **Org metadata writes are now first-time-only.** `organization_name`, `company_type`, `revenue_tier`, `membership_tier` are written to the organization row only when the field is currently null. If a value is already set (e.g. an admin curated it via the dashboard), the body value is silently ignored and the response surfaces a `metadata_unchanged` warning naming the affected fields. Without this gate, any caller with a matching email domain could clobber admin-curated metadata on subsequent bootstrap calls.
- **The bootstrap path is rate-limited.** New `memberProfileBootstrapRateLimiter` middleware applies the same envelope as `orgCreationRateLimiter` (15 failed attempts per hour per user; successful calls don't count). The limiter `skip`s requests whose body matches the legacy dashboard `display_name`+`slug` shape, so the `/community/profile-edit` and `/member-profile.html` flows keep their prior unmetered behavior.
- **Audit log entry on success.** Successful bootstraps now write a `member_profile_bootstrapped` row to `registry_audit_log` with the affected user, the slug, the corporate domain, and which org-level fields were updated vs. ignored. Org-level mutations through this surface are now attributable.

Spec updated to document each constraint (paid-tier 400, metadata-unchanged warning, rate-limit envelope) so callers can see them without reading the implementation.
