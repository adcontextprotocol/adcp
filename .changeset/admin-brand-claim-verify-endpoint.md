---
---

Add `POST /api/admin/organizations/:orgId/brand-claim/verify` for admin-triggered brand-claim sync. Wraps the existing `verifyDomainChallenge` service with an explicit orgId so it can be invoked with `ADMIN_API_KEY` to recover from missed `organization_domain.verified` webhooks (e.g. WorkOS dashboard manual flips that didn't propagate). When WorkOS already reports the domain as verified, the service short-circuits the DNS check and runs `applyVerifiedBrandClaim` directly.
