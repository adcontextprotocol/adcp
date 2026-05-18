---
---

spec(security): raise revocation polling ceiling 15→30 min and grace 2×→4× (#4626).

Operators at the ceiling now get ~2.5 h of revocation-endpoint outage tolerance (30 min poll + 4× grace) before fail-closed, up from ~45 min. Floor stays at 1 min so operators that prioritize fast `revoked_kids` propagation over DoS tolerance can opt in to the tighter window. Applies symmetrically to the governance profile (`#revocation`), the request-signing transport profile (`#transport-revocation`), and the webhook-signing profile (which consumes the same combined revocation list). JWKS-cache TTL upper bound updated to match.

The propagation-delay tradeoff is bounded: `revoked_kids` invalidates every signature ever produced under the revoked key, so the 30-min worst-case at the ceiling caps acceptance of *new* mutations, not the validity of past spend. Short `exp` on intent (15 min) and execution-phase tokens further bound the fraud window inside grace.

No schema change; addresses the DoS surface explored in #2325 without introducing a heartbeat endpoint or separate signing keys. 4.x may tighten the ceiling for spend-committing operations specifically (#2307).
