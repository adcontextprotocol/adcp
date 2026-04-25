---
---

Self-service brand-claim challenge for the verified-domain takeover path.

A member who actually controls a domain can now prove it without filing an escalation: call `POST /api/me/member-profile/brand-claim/issue` with `{domain}` to receive a token + placement URL, publish the token at `https://{domain}/.well-known/adcp-claim/{token}`, then call `POST /api/me/member-profile/brand-claim/verify`. On success the server claims (or transfers) ownership atomically — clearing any orphan flag, marking domain_verified, and resetting the prior manifest unless `adopt_prior_manifest: true` is passed.

Cross-org disputes from #3168 now mention this path in their 409 response so a member who hits "managed by another organization" knows there's a self-serve route. If a verified incumbent ALSO holds the domain (both parties pass the file-placement challenge), the verify endpoint refuses to auto-transfer and routes to a `sensitive_topic` escalation instead — verified-vs-verified is a governance call, not a one-shot resolution.

Closes the policy half of #3176. The "auto-transfer after N-day cooldown when the incumbent doesn't refresh their challenge" piece can layer on top later if needed.
