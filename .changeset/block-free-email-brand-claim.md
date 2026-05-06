---
---

fix(server): block free-email provider domains from brand identity claims, unify parallel lists

Extends `SHARED_PLATFORM_DOMAINS` in `identifier-normalization.ts` with 30 high-volume
free-email provider domains (Gmail, Outlook, iCloud, Proton, Yahoo, AOL, Tutanota, etc.)
as defense-in-depth. WorkOS DNS verification makes admin-override exploitation implausible
today; this closes the gap for future trust paths and the new `primary_brand_domain`
auto-populate path added in #4157.

Extracts the list into an exported `FREE_EMAIL_PROVIDER_DOMAINS` constant and replaces
four previously-diverged inline arrays across `admin-tools.ts`, `slack-db.ts`, and
`admin/domains.ts` with imports of the shared constant.

Adds `assertClaimableBrandDomain` unit tests (the function was previously untested).

Closes #4165.
