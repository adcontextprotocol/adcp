---
---

Personal-tier orgs (Individual Professional) can now have their verified brand domains mirrored into `organization_domains` and the `brands` registry from WorkOS webhook events. Previously, the `is_personal` early-return in `upsertOrganizationDomain` and `syncOrganizationDomains` blocked the entire write path, conflating brand-identity ownership (no squeeze risk) with email-domain auto-membership inference (real squeeze risk). The split now: ownership rows mirror reality for all orgs; `is_primary` and `organizations.email_domain` (the actual auto-membership inference keys) remain gated to non-personal orgs. Defense-in-depth check added so shared platforms / public-suffix domains can't slip into the brand registry even via a manual WorkOS dashboard flip.
