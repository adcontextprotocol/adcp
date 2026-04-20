---
"adcontextprotocol": patch
---

Introduce `hmac_sha256` as the 3.x privacy-hardened scheme for `hashed_email` / `hashed_phone` in audience-member payloads, alongside the legacy `sha256_plain` default. Sellers negotiate accepted schemes via a new top-level `privacy.audience_hash_schemes` capability on `get_adcp_capabilities`; buyers MUST use the declared scheme and SHOULD prefer `hmac_sha256` when both are offered. The HMAC scheme uses a per-seller key (≥256-bit CSPRNG, rotated ≥annually, exchanged out-of-band at onboarding), giving cross-seller-correlation resistance while making explicit that hashing is pseudonymization under GDPR Art. 4(5) — not anonymization. 4.0 will make `hmac_sha256` mandatory and remove `sha256_plain`. Glossary, known-limitations, privacy-considerations, and audience-member / sync-audiences-request schemas updated accordingly; match-block schemas now set `additionalProperties: false` to close structural leaks.
