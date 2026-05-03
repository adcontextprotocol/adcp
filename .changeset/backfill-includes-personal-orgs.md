---
---

`backfillOrganizationDomains` now iterates all orgs instead of filtering out personal-tier ones. PR #3966 fixed `syncOrganizationDomains` to correctly handle the personal-vs-company split (mirror org_domains row + brand registry for everyone; gate `is_primary`/`email_domain` to non-personal), but the outer backfill helper still skipped personal orgs entirely — so the recovery path for missed-webhook personal-tier brand claims (e.g. vastlint.org) couldn't reach them. Filter dropped.
