---
"adcontextprotocol": minor
---

Define a signed format for `governance_context`. In 3.0 the value SHOULD be a compact JWS issued by the governance agent; 3.1 will require it. The field shape (single string, ≤4096 chars) is unchanged — sellers that treat the value as an opaque correlation key keep working unchanged, and sellers that want cryptographic accountability opt in by verifying per the new AdCP JWS profile in Security. brand.json governance agents gain optional `jwks_uri` and `scope` fields so sellers and auditors can discover signing keys and disambiguate multi-agent houses. Defines well-known paths `/.well-known/jwks.json` for key discovery and `/.well-known/governance-revocations.json` for revocation, addressing the long-lived-execution-token problem that expiration alone cannot solve. Resolves #2306.
