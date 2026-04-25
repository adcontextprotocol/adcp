---
---

Two follow-ons to #3152's transfer-tool work:

- **Brand-ownership disputes file an escalation instead of dead-ending.** When `updateBrandIdentity` rejects a write because the domain is owned by another org, both the web `PUT /api/me/member-profile/brand-identity` route and the `update_company_logo` member tool now create a `category: needs_human_action` escalation with the caller org, owner org, and brand domain in `addie_context`. Admins resolve via the existing `transfer_brand_ownership` tool (#3159). Web returns 409 + escalation_id; chat returns a "we filed it" message + ticket number.

- **Relinquishing a hosted brand clears the brand_manifest.** `deleteHostedBrand` previously cleared ownership but left the prior org's `brand_manifest` (logos, colors, agents, narrative copy) on the row, so a later soft-claim silently inherited the visual identity. The row is now reset to a clean discovered state on relinquish. `BrandIdentityError` gained a discriminator field (`code` + `meta`) so callers can tell `cross_org_ownership` apart from validation errors.

Closes the second part of #3152. The remaining "soft-claim with verified-domain takeover" piece is parked until challenge/response domain verification lands — pointer-only verification is currently the only ownership signal and isn't strong enough to gate provenance changes on its own.
