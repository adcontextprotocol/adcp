---
---

Fix: `GET /api/registry/operator?domain=X` now resolves member profiles by any linked domain on the owning org, not just the primary one.

`MemberDatabase.getProfileByDomain` was the only domain→org lookup in the codebase that filtered on `organization_domains.is_primary = true`. Every other lookup (`organization-domains-db.ts`, `me-organization-domains.ts`, `domain-resolution-db.ts`, brand-feed and registry verified-domain lookups) resolves by any linked domain, relying on `UNIQUE(domain)` in the `organization_domains` table to keep the join unambiguous.

The `is_primary` flag exists to pick a canonical email/enrichment domain (per migration 066), not to gate ownership lookups. With the old filter, an org that had `gumgum.com` linked as a secondary domain — primary on a different parent domain — would silently return `{ "member": null, "agents": [] }` on the operator endpoint, indistinguishable from "no org owns this domain." This blocked legitimate multi-domain orgs (holdcos, multi-brand operators) from being discoverable through the operator API.

The fix drops the `is_primary = true` clause from the join. No schema change; no API contract change beyond the bug.
