---
"adcontextprotocol": minor
---

Add an experimental verified-identity attestation surface to TMP Identity Match, letting a publisher (or a network/issuer-as-RP) forward a **verifiable** proof about a user — proof-of-personhood and/or age — so the buyer verifies the claim cryptographically instead of trusting an assertion. Issuer-agnostic; World ID is the first scheme.

**Schema changes (additive):**
- `enums/uid-type.json` — adds `world_id_nullifier` (Sybil-resistant, rp-scoped, unlinkable pseudonym; asserts nothing on its own — trust comes from the accompanying attestation).
- `enums/attestation-claim.json` (new) — closed, issuer-agnostic claim set: `unique_human`, `age_over_13/16/18/21`. Age is threshold-only and resolves to eligibility, never a wire attribute.
- `tmp/identity-match-request.json` — adds an optional `attestation` object per `identities[]` entry (`issuer`, `scheme`, `relying_party_id`, `action`, `claims[]`, `verification_level`, `signal_binding`, `proof`, `expires_at`) and an optional top-level `sealed_credentials[]` (`{audience_kid, payload}`, TMPX envelope) for the network-as-RP carrier. `issuer` is a vendor BrandRef (`core/brand-ref.json`, canonical domain) — the same vendor-reference shape as measurement/signals vendors; the relying party is namespaced by the issuer as `(issuer.domain, issuer.brand_id, relying_party_id)`.

**Contract-bearing note:** `identity-match-request.json` is `additionalProperties: false` on purpose (the identity privacy boundary). These fields are a deliberate, reviewed widening — they carry proof *about* the identity (identity side of the boundary), not page context. Shipped as `x-status: experimental`; not subject to deprecation cycles until 3.0.0 GA.

**Conformance invariants (normative):** verify every accepted `scheme`; treat an unverifiable attestation as "no attestation", never as asserted-true; reject on failed `signal_binding`, `relying_party_id` provenance, or `expires_at`; decrypt only `sealed_credentials` whose `audience_kid` you hold; bound attestation + sealed-credential count/size.

**Router handling of `sealed_credentials[]` (normative):** forward each entry only to the provider owning its `audience_kid` (not broadcast); fold `sealed_credentials` into the per-provider re-signature canonical bytes; include a `sealed_credentials_hash` in the dedup cache key.

relying_party_id ownership is published in `brand.json` `identity_relying_parties[]`; age jurisdiction→threshold tables live in the AdCP Policy Registry and resolve to `eligible_package_ids`. Advertised via a new `trusted_match.verified_identity` experimental feature id. Full design: `specs/tmp-verified-identity-attestation.md`.
