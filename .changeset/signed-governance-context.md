---
"adcontextprotocol": minor
---

Define a signed format for `governance_context`. In 3.0 governance agents MUST emit a compact JWS per the AdCP JWS profile; sellers MAY verify and MUST persist and forward the token unchanged even when not yet verifying. 3.1 will require all sellers to verify. The field shape (single string, ≤4096 chars) is unchanged — sellers that treat the value as an opaque correlation key keep working, and sellers that want cryptographic accountability opt in by implementing the 15-step verification checklist.

Key design properties now specified:

- **Anti-spoofing via brand.json cross-check**, with explicit buyer-identity resolution rules (mTLS, pre-provisioned identity, or #2307 signed requests). Sellers MUST NOT derive buyer identity from unauthenticated request fields.
- **SSRF hardening** for `jwks_uri` and revocation-list fetches, reusing existing Webhook URL validation rules.
- **Signed revocation list** at `/.well-known/governance-revocations.json` with `next_update` cadence capped to 15 minutes for execution-phase tokens and explicit fail-closed behavior on fetch failure + grace.
- **RFC 7515 `crit` header** required for any semantic claim, preventing silent downgrade attacks when future profile versions add claims.
- **Per-tenant JWKS isolation** for SaaS governance agents — `iss` byte-match including path; shared-origin key pooling forbidden for `spend_authority` scope.
- **Key-purpose separation**: governance signing keys share JWKS discovery with #2307 transport signing but MUST use distinct `kid` with `key_ops: ["verify"]` and `use: "sig"`. Verifiers enforce separation.
- **Bounded replay-dedup**: execution-token `exp` capped to 30 days; bloom filter + authoritative lookup recommended.
- **`policy_decisions` privacy**: optional, with `policy_decision_hash` as the privacy-preserving default; full evidence behind `audit_log_pointer`.
- **Error taxonomy**: stable codes for verification failure (`governance_jwks_unavailable`, `_issuer_not_authorized`, `_token_revoked`, etc.) so client libraries can expose typed errors.
- **Reference implementation**: decoded JWT example and ~30-line `jose`-based TypeScript verifier in security.mdx.
- **Forward compatibility**: optional `nbf` (registered claim) and optional `status` claim for future IETF JWT Status List migration.
- **Edge-runtime guidance**: ES256 recommended where Ed25519 requires runtime configuration (Cloudflare Workers, Vercel Edge).

brand.json governance agents gain optional `jwks_uri` and `scope` fields so sellers and auditors can discover signing keys and disambiguate multi-agent houses.

The safety-model doc gains a "Verifiable approvals" section positioned immediately after the three-party trust model, emphasizing that regulators and auditors can verify tokens independently without vendor cooperation — the core accountability property the profile exists to deliver.

Scope for 3.0 is buy-side governance only. Seller-side governance authorities (CTV political-ad rules, publisher content policies) remain expressed via `conditions` responses; a future RFC may extend this profile to cover seller-side signed decisions. Governance attestation terminates at the AdCP media buy boundary and does not propagate into OpenRTB bid streams.

Resolves #2306. Incorporates feedback from security, ad-tech-protocol, product, and TypeScript implementation reviews.
