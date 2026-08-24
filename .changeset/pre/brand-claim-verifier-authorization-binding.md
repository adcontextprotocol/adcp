---
"adcontextprotocol": minor
---

Add the 3.2 advisory brand-authorization binding for `verify_brand_claim` and `verify_brand_claims`. A verifier can now report a cryptographically valid but unbound response as `untrusted` through the new `brand-response-authorization-result` schema instead of treating the brand-agent's assertion or rejection as authoritative.

The security and task docs define the advisory lookup, canonical agent-URL matching, authorized-JWKS scoping, batch deduplication, and safe failure behavior. Conformance vectors plus an executable reference evaluator cover authorized, unavailable, ambiguous, wrong-agent, wrong-key, and forged rejection cases. Mandatory cryptographic brand authorization and hard rejection remain deferred to 4.0.
