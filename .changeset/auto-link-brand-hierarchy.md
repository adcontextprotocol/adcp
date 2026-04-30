---
---

Auto-link and post-link membership inheritance now walk the brand registry's `house_domain` chain coherently, with consistent trust gates and explicit opt-in. Hierarchical inheritance (a child-brand domain inheriting a paying parent's coverage) is **opt-in** (default off); direct verified-domain auto-provisioning is unchanged.

## What changed

**Two code paths now share the same trust gates.** `findPayingOrgForDomain` (auto-link target resolution) and `resolveEffectiveMembership` (post-link `is_member` resolution) both apply:
- Only `brands.classification.confidence='high'` edges (no implicit trust on `source_type='brand_json'` — brand.json has no parent field today)
- 180-day TTL on `brands.last_validated` (fallback to `discovered_at` / `created_at`) so divestments age out
- Max 4 hops up, cycle protection
- Inherited matches require the paying parent to opt into `auto_provision_brand_hierarchy_children` (default **false**, migration 449)

Pre-fix: the two paths used different rules — `resolveEffectiveMembership` accepted `brand_json` source and had no TTL or opt-in. An org whose admin opted out of hierarchical auto-provisioning still saw their child orgs marked `is_member=true` on the site and in Addie. Fixed.

**Cohort gate (grandfather semantics).** Migration 450 adds `auto_provision_hierarchy_enabled_at` plus a trigger that captures the moment the flag flips to `true`. `autoLinkByVerifiedDomain` only auto-joins users whose `users.created_at >= auto_provision_hierarchy_enabled_at`, so flipping the flag does NOT retroactively graft the existing backlog of child-domain users into the parent — only new joiners flow up. Matches the SaaS norm.

**Admin PATCH audit trail.** `/api/admin/brand-enrichment/brand/:domain` writes a `brand_house_domain_changed` row to `registry_audit_log` whenever `house_domain` changes, with prior + new values + admin email. Snapshot + UPDATE + audit INSERT are wrapped in a single transaction so concurrent admin PATCHes can't produce a torn audit trail.

**Classifier hardening.** The Sonnet-driven brand classifier now whitelists `confidence` against `{high, medium, low}`. A prompt-injected response setting `confidence: "extreme"` collapses to `low` instead of being persisted as auth-relevant.

## Direct auto-provisioning is unchanged

`auto_provision_verified_domain` (default true) still gates direct matches. The two flags are independent.

## Tests

72 integration tests across `find-paying-org-for-domain`, `membership-webhook`, and a new `admin-brand-enrichment-audit` suite cover: cycle protection, max-depth, TTL expiry, opt-in default-off, cohort grandfather, off-by-one chain reconstruction, audit-log INSERT (5 cases), `resolveEffectiveMembership` opt-in gate, trigger behavior on flag transitions.
