---
"adcontextprotocol": minor
---

spec(adagents): add `encryption_keys_uri` to `authorized_agents` entries — JWKS-style indirection that lets the cluster-master operator rotate TMPX HPKE encryption keys without coordinating edits across every downstream `adagents.json` that authorizes the agent. Inline `encryption_keys` is now marked deprecated (planned removal in AdCP 4.0); inline keys force rotation propagation to track downstream edit cycles, which is unacceptable for compromise response.

The URI serves an RFC 7517 JWKS document conforming to a new `/schemas/core/agent-encryption-keys-set.json`. The URI MAY point to any HTTPS host the publisher trusts — typically the cluster master's own domain. The cluster master is often a third-party decryption-as-a-service provider that operates the X25519 private key on behalf of many sales agents, so the JWKS hostname commonly differs from the agent's `url`. The publisher's choice to include this URI in `adagents.json` is the trust attestation. Encryption-side consumers cache the JWKS with a 5-minute TTL — that TTL bounds rotation propagation latency.

Adds new "Encryption key rotation" subsection to the trusted-match specification with explicit cadence guidance: rotate at least every 90 days, immediate rotation on suspected compromise. The operator rotates by removing the retired kid and publishing the successor in one JWKS edit — there is no in-band revocation marker on individual keys, because for encryption keys (unlike signing keys) JWKS removal plus the 5-minute TTL is sufficient. The master internally retains old private keys long enough to decrypt in-flight TMPX tokens (master-side concern, not reflected in the JWKS). Operators store private keys in HSM/KMS.

Backward compatible: `encryption_keys` remains valid and parses identically; new field is additive. Both fields may appear simultaneously, with `encryption_keys_uri` authoritative.
