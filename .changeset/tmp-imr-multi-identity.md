---
"adcontextprotocol": minor
---

feat: TMP Identity Match supports multiple identity tokens per request

Replaces the single `user_token` + `uid_type` fields on `identity-match-request` with an `identities` array of `{user_token, uid_type}` pairs (`minItems: 1`, `maxItems: 3`). The cap matches the TMPX plaintext budget — three 32-byte tokens fit within the ~120-byte post-HPKE budget without forcing buyer-side truncation. Publishers SHOULD send every identity token they have available (up to the cap) — the buyer resolves on whichever graph matches, maximizing match rate across heterogeneous buyer identity graphs. Entry order is not semantically significant; buyers use their own preference order. Duplicate `(uid_type, user_token)` pairs MUST NOT appear.

Router filtering selects providers whose `uid_types` overlaps with any `uid_type` in the request's `identities` array. The router filters `identities` per provider before forwarding (minimum-necessary-data) and MUST NOT add, substitute, or transform identity tokens — the forwarded set MUST be a subset of the publisher-origin array. If the intersection is empty, the router MUST skip the provider rather than forwarding with side-channel telemetry. The router re-signs per outbound forward; providers verify against the router's public key.

Signature and cache key share one canonicalization discipline. Signed input is the hex-encoded SHA-256 of the RFC 8785 JCS serialization of `{type, request_id, identities_hash, consent, package_ids, daily_epoch}`. `identities_hash` is SHA-256 over JCS of the deduplicated, sorted `identities` array (computed over the per-provider filtered subset). The cache key `{identities_hash, provider_id, package_ids_hash, consent_hash}` uses SHA-256 over JCS of the sorted `package_ids` and the `consent` object (or JCS `null` when absent, distinguishing "consent unknown" from explicit-empty). JCS framing eliminates delimiter-injection risk — raw consent strings or package IDs containing `|`, `,`, or `\n` cannot collide two distinct inputs.

Buyers SHOULD prefer opaque provider IDs over `hashed_email` and other strongly re-identifying tokens when multiple identities are present, neutralizing scenarios where a misconfigured or compromised router strips everything except the highest-risk token.

Adds `rampid_derived` to the `uid-type` enum (aligns with the TMPX binary Type ID registry — maintained RampID is 32 bytes, derived RampID is 48 bytes).

Documents that multi-token IMRs disclose cross-identity equivalence to the buyer (e.g., "this UID2 and this ID5 resolve to the same user from this publisher's view"). Publishers who want to avoid this can send a single identity per IMR at the cost of match rate. `hashed_email` carries higher re-identification risk than opaque provider IDs; publishers SHOULD treat inclusion as a deployment decision. TEE-attested deployments close the offline-retention vector.

Privacy documentation now explicitly states the router's trust boundary for identity filtering, the non-transformation invariant, and the code-audit / TEE-attestation trust model.

TMPX truncation policy when resolved identities exceed the ~120-byte plaintext budget is buyer deployment configuration, not protocol-level. Buyers MUST configure an explicit priority list; the default implementation MUST NOT truncate arbitrarily.

Breaking change relative to prior TMP drafts. TMP is an [experimental surface](/docs/reference/experimental-status) in AdCP 3.0 (feature id `trusted_match.core`) — it may change between 3.x releases with at least 6 weeks' notice; see the 3.1.0 roadmap for planned changes on the path to stable.
