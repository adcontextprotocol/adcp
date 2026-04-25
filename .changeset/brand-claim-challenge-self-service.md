---
---

Self-service brand-claim challenge for the verified-domain takeover path, built on the WorkOS Domain Verification API.

A member who controls a domain can claim it (or transfer from a soft-claimed prior owner) without filing an escalation:

1. `POST /api/me/member-profile/brand-claim/issue` with `{domain}` → calls `workos.organizationDomains.create(orgId, domain)` and returns the WorkOS-issued DNS TXT record (`verification_prefix.{domain} = verification_token`).
2. Member publishes the TXT record.
3. `POST /api/me/member-profile/brand-claim/verify` → calls `workos.organizationDomains.verify(domainId)`. On success WorkOS marks the domain Verified, fires the `organization_domain.verified` webhook, AND we mirror the state into the brand registry inline (idempotent with the webhook handler).

Two important properties come for free from WorkOS:
- One verified domain per org enforcement — verified-vs-verified collisions are unreachable. If org A has acme.com Verified, the create call for org B returns a 422 and we surface it as 409 with an escalation hint.
- DNS-TXT proof — registrar-level evidence rather than web-server-level.

Cross-org disputes from #3168 now mention this path in their 409 response so a member hitting "managed by another organization" knows there's a self-service route.

The `organization_domain.verified` webhook handler also calls `applyVerifiedBrandClaim` so admins flipping state via the WorkOS dashboard get the brand registry sync for free.

Closes the policy half of #3176. The "auto-transfer after N-day cooldown when the incumbent doesn't refresh their challenge" piece is moot now — WorkOS gates that at the create level.
