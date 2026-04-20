---
---

Fix webhook-signing positive vectors 004 and 005 to apply full `@target-uri`
canonicalization per the shared rules in `request-signing/canonicalization.json`.
Previously both vectors signed the as-received URL instead of the canonical one,
contradicting step 4 (strip default ports) and step 6 (uppercase `%xx` hex /
decode percent-encoded unreserved).

- 004-default-port-stripped: signature base now uses
  `https://buyer.example.com/...` (`:443` stripped) instead of
  `https://buyer.example.com:443/...`. Signature regenerated.
- 005-percent-encoded-path: input URL changed from `op%2dabc` (where `%2d` is
  unreserved `-` and by step 6 MUST decode rather than just uppercase — the
  previous encoding overloaded the test) to `op_%e2%98%83` (reserved UTF-8
  bytes), matching the pattern in request-signing vector 008. Signature base
  uppercases hex to `%E2%98%83`. Signature regenerated.

Both new Ed25519 signatures are deterministic and verify against the published
`test-ed25519-webhook-2026` keypair.

**Implementor note.** Any verifier that previously passed the old 004/005
signatures has a latent canonicalization bug: it accepted signatures produced
over the as-received URL rather than the canonical `@target-uri`. That verifier
will silently disagree with a correctly-canonicalizing producer on any URL
containing `:443`, `:80`, or lowercase `%xx` in the path, causing
`webhook_signature_invalid` at step 10. Re-run the positive suite after
pulling — vectors are frozen on commit and the fixed pair will not round-trip
against a broken verifier.
