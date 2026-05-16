---
---

Surface sales-touched prospect orgs at signup. When `/auth/callback` resolves a user with zero memberships, look up an unmembered prospect org owned by their email domain and redirect to `/onboarding.html?claim_org=<id>` with a "Claim this organization" banner. New `POST /api/organizations/:orgId/claim` endpoint completes the claim under a row lock with anti-hijack guards: domain match, no active subscription, zero existing members. Closes the gap that left Voise Tech employees on personal workspaces while their company's prospect org sat orphaned.
