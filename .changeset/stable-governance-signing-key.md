---
---

fix(training-agent): derive the governance-signing key deterministically so its `kid` is stable across restarts and always matches the public JWK published at `/.well-known/jwks.json`. Previously the key was ephemeral per process, so a buyer (or the S6 cert lab) could not reliably resolve a `governance_context` token's `iss`→JWKS→`kid` to verify its signature. Sandbox-only derivation; production governance agents use KMS-backed keys. No published-package or schema change.
