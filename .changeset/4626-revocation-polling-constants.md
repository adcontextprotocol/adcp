---
---

spec(security): raise revocation polling ceiling 15→30 min and grace 2×→4× (#4626).

Operators at the ceiling now get ~2.5 h of revocation-endpoint outage tolerance (30 min poll + 4× grace) before fail-closed, up from ~45 min. Floor stays at 1 min so operators that prioritize fast `revoked_kids` propagation over DoS tolerance can opt in to the tighter window. Applies symmetrically to the governance profile (`#revocation`) and the request-signing transport profile (`#transport-revocation`); JWKS-cache TTL upper bound updated to match. No schema change; addresses the DoS surface explored in #2325 without introducing a heartbeat endpoint or separate signing keys.
