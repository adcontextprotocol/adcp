---
---

Expose the brand-hierarchy auto-provisioning toggle to org owners on the team page.

PR #3378 added the `auto_provision_brand_hierarchy_children` flag and all the safety scaffolding (opt-in default off, cohort gate, audit log, etc.) but no UI to actually flip it. Without exposure, the adoption-gating triggers on follow-up issues #3410 (per-subsidiary allowlist) and #3411 (UX hardening) were circular — orgs couldn't adopt what they couldn't toggle.

Changes:
- `GET /api/organizations/:orgId/domains` now returns `auto_provision_brand_hierarchy_children`, `auto_provision_hierarchy_enabled_at`, and `inferred_subsidiaries` (high-confidence brand-registry rows currently classified as children of this org's verified domains, 180-day fresh).
- `PATCH /api/organizations/:orgId/settings` now accepts `auto_provision_brand_hierarchy_children`. Owner-only (admins can't widen org membership unilaterally), audit-logged via `recordAuditLog`.
- `team.html` renders a second toggle row below the verified-domain one. Hidden when there are no inferred subsidiaries AND the flag is off (no use case to expose). Shows the resolved-subsidiary list so the owner can sanity-check the registry before flipping on. Notes that existing employees aren't retroactively added — only new sign-ups after enabling.
- `Organization` interface and `updateOrganization` column map updated to carry the new fields.

Owners can now opt their org into hierarchical auto-provisioning themselves. Direct verified-domain auto-provisioning is unchanged.
