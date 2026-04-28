---
---

Auto-link via verified domain can now traverse the brand registry's `house_domain` chain to inherit a child-brand employee into a paying parent org's WorkOS membership. Hierarchical inheritance is **opt-in** (default off); direct verified-domain auto-provisioning is unchanged.

Pre-fix asymmetry: `resolveEffectiveMembership` walked the hierarchy when computing post-link membership, but `autoLinkByVerifiedDomain` did direct match only. Two code paths answering "does this domain belong to a paying org?" with different rules — the kind of inconsistency that produces hard-to-diagnose escalations.

Trust gates on the inheritance walk:
- New per-org column `auto_provision_brand_hierarchy_children` (default **false**, migration 449) — orgs must explicitly opt in. Slack/Notion/Linear-style: silent join only on DNS-verified direct matches; hierarchical inheritance requires consent.
- Only edges where the brand classifier emitted `confidence='high'`. (`source_type='brand_json'` is not currently a trust signal — brand.json schema has no parent/house_domain field, so brand_json rows never carry inheritance data.)
- 180-day TTL on `brands.last_validated` (fallback to `discovered_at` / `created_at`) so stale M&A data ages out instead of inheriting forever.
- Max 4 hops up, cycle protection.

New helper `findPayingOrgForDomain(domain)` in `org-filters.ts` is the single source of truth for "which paying org owns this domain (directly or inherited)?" Direct matches always win over hierarchical (shallowest first).

Audit logging: admin PATCH `/api/admin/brand-enrichment/brand/:domain` now writes a `brand_house_domain_changed` row to `registry_audit_log` whenever `house_domain` changes. The change is what grafts a new domain onto a paying org's auto-link reach, so it's traceable.

Direct auto-provisioning (`auto_provision_verified_domain`) is unchanged — same default, same semantics. The two flags are independent: an org can opt out of direct (rare) while opting in to hierarchical, or vice versa.
