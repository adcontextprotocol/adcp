---
"adcontextprotocol": minor
---

feat: TMP Identity Match supports multiple identity tokens per request

Replaces the single `user_token` + `uid_type` fields on `identity-match-request` with an `identities` array of `{user_token, uid_type}` pairs (`minItems: 1`, `maxItems: 10`). Publishers SHOULD send every identity token they have available — the buyer resolves on whichever graph matches, maximizing match rate across heterogeneous buyer identity graphs. Entry order is not semantically significant; buyers use their own preference order. Duplicate `(uid_type, user_token)` pairs MUST NOT appear.

Router filtering selects providers whose `uid_types` overlaps with any `uid_type` in the request's `identities` array. The router filters `identities` per provider before forwarding (minimum-necessary-data) and re-signs per outbound forward — each provider only sees the identity subset it can resolve.

Signature and cache key share one canonicalization: deduplicate `identities`, sort by `uid_type` then `user_token` in UTF-8 byte order, serialize as RFC 8785 JCS, and SHA-256. The resulting `identities_hash` is computed over the per-provider filtered subset and used in the Identity Match signed fields and in the cache key `{identities_hash, provider_id, hash(package_ids), consent_hash}`. Including `consent_hash = SHA-256(consent.gdpr || "|" || consent.tcf_consent || "|" || consent.gpp || "|" || consent.us_privacy)` prevents eligibility decisions taken under one consent state from being served under another.

Adds `rampid_derived` to the `uid-type` enum (aligns with the TMPX binary Type ID registry — maintained RampID is 32 bytes, derived RampID is 48 bytes).

Documents that multi-token IMRs disclose cross-identity equivalence to the buyer (e.g., "this UID2 and this ID5 resolve to the same user from this publisher's view"). Publishers who want to avoid this can send a single identity per IMR at the cost of match rate. `hashed_email` carries higher re-identification risk than opaque provider IDs; publishers SHOULD treat inclusion as a deployment decision. TEE-attested deployments close the offline-retention vector.

TMPX truncation policy when resolved identities exceed the ~120-byte plaintext budget is buyer deployment configuration, not protocol-level. Buyers MUST configure an explicit priority list; the default implementation MUST NOT truncate arbitrarily.

Breaking change relative to prior pre-release TMP drafts. TMP remains pre-release in AdCP 3.0; see the 3.1.0 roadmap for the stable surface.
