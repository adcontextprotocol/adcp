---
---

Set `organizations.email_domain` and mirror `organization_domains` synchronously from the four prospect-creation paths (admin/domains.ts × 3 + on-demand WorkOS sync in billing-public.ts), instead of waiting for the WorkOS `organization.updated` webhook to backfill. Closes the leak that left Voise Tech Ltd orphaned for 80 days.
