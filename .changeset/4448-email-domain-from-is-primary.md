---
"adcontextprotocol": patch
---

Fix `syncOrganizationDomains` (WorkOS `organization.updated` webhook) so `organizations.email_domain` is sourced from `organization_domains.is_primary=true` rather than `org.domains[0]`. WorkOS's domain-array order is not stable — orgs with a verified root + a `failed` www variant could have WorkOS list www first, overwriting `email_domain` to the wrong value on every webhook fire even though our table's `is_primary` row was correct. Scope3 hit this in prod: `email_domain` had drifted to `www.scope3.com` while `is_primary=true` was on `scope3.com`, causing downstream lookups like `brand-enrichment.ts`'s `WHERE email_domain = $1` to miss the org row entirely. Adds `server/src/scripts/sync-email-domain-from-is-primary.ts` (dry-run + `--apply`) to clear the pre-fix backlog and an integration test pinning the new behavior.
