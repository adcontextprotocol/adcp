---
---

Auto-link via verified domain now traverses the brand registry's `house_domain` chain, matching the inheritance rules `resolveEffectiveMembership` already uses for post-link membership.

Pre-fix asymmetry: a child-brand employee (e.g. `someone@analyticsiq.com`) was denied auto-link to a paying parent org (e.g. Alliant) even when `brands.house_domain` knew about the relationship. `resolveEffectiveMembership` walked the hierarchy when computing membership, but `autoLinkByVerifiedDomain` did direct match only. Two code paths answering "does this domain belong to a paying org?" with different rules — exactly the kind of inconsistency that produces hard-to-diagnose escalations.

Fix:
- New `findPayingOrgForDomain(domain)` helper in `org-filters.ts` runs the recursive brand-hierarchy walk (max 5 hops, high-confidence classifications only — same rules as `resolveEffectiveMembership`).
- `autoLinkByVerifiedDomain` calls it. Direct verified-domain matches still win over inherited ones (shallowest match preferred). The `auto_provision_verified_domain` opt-out applies at the resolved (potentially-inherited) paying-org level.
- Audit log line distinguishes inherited from direct matches and includes the matched domain + chain.
