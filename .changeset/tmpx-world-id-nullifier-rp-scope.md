---
"adcontextprotocol": minor
---

feat(trusted-match): scope the world_id_nullifier TMPX token to its relying party

Register `world_id_nullifier` in the TMPX Type ID registry, and define its token as relying-party-scoped: a 16-byte digest of the proof's `relying_party_id` followed by the 32-byte nullifier.

A World ID nullifier is meaningful only within the `rp_id` it was minted for, but the `rp_id` rides the request-side `attestation`, which does not round-trip into the `tmpx` exposure token. With only the bare nullifier in the token, the out-of-band impression tracker cannot attribute an exposure to its relying party or reconstruct the `(rp_id, nullifier)` key the buyer caps on. Embedding the `rp_id` digest closes that: the tracker matches the digest against the relying parties it accepts, keys frequency state on `(rp_id, nullifier)`, and no `rp_id` cleartext crosses into the token.

Open (WG): the digest width (16 bytes proposed) and whether a digest-plus-registry lookup suffices versus carrying a registry-assigned relying-party id. `world_id_nullifier` is gated by the experimental `trusted_match.verified_identity` feature, so its token layout is not yet frozen.
