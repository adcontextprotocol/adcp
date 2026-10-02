---
"adcontextprotocol": minor
---

Add the Web Bot Auth request-signing profile proposed for 3.3 in RFC #7878, published alongside the AdCP RFC 9421 profile, which stays as written. The page `docs/building/by-layer/L1/wba-profile.mdx` defines the profile: a signer names its origin in a covered `Signature-Agent` header, and the verifier resolves the signer's keys in one step from that origin's `/.well-known/http-message-signatures-directory`. An identity is an origin with one key directory, `keyid` is the JWK thumbprint, every signed request carries an RFC 9421 `nonce` that the seller's verifier MUST check, and signature failures are reported with `400`, `403` with `Accept-Signature`, and `429`. Several signers add their own signatures, each later signer covering the earlier ones, so a seller verifies every party in a relay chain. Webhooks under the profile are ordinary signed requests from the seller's identity. The profile selects options Web Bot Auth and RFC 9421 already define and adds nothing to the wire.

A verified identity the seller has not approved gets no account access, reads included. After approval, the identity maps to a principal and the principal to its accounts, so onboarding becomes approving a verified identity instead of issuing a credential.

Additive schema changes: `request_signing.profiles` and `webhook_signing.profiles` on `get_adcp_capabilities` let a seller say which signing profiles it accepts and emits, and an optional `signing_profile` on `push-notification-config`, `notification-config`, and `agent-notification-config` lets a webhook subscriber select the profile it verifies. Omitting every new field keeps the 3.0 to 3.2 behavior.

Adds the `wba-profile` conformance vectors: three positive vectors (single signer, relay with two signatures, signed directory response) and seven negative vectors (missing nonce, replayed nonce, uncovered `Signature-Agent`, relay not covering the inner signature, inner signature altered after the relay signed, key absent from the named directory, unparseable header), each stating its expected status code.
