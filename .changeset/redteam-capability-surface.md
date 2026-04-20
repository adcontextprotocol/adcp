---
---

spec(capabilities): add `webhook_signing` block, origin-separation guidance (`identity.key_origins`), per-principal key isolation (`identity.per_principal_key_isolation`)

Three capability-surface hardening items, split out of closed PR #2466:

- **W-4 — `webhook_signing` block on `get_adcp_capabilities`.** Restores symmetry with `request_signing`: sellers declare whether they sign outbound webhooks, which profile version, which algorithms, and whether the legacy HMAC fallback is supported. `supported: false` is reserved for the unsafe "emits unsigned webhooks" posture; sellers that emit no webhooks SHOULD omit the block. Buyer onboarding MUST fail when the seller's capability surface advertises mutating-webhook emission and the block is missing or `supported: false`. Algorithm set is constrained to `[ed25519, ecdsa-p256-sha256]` (matching the verifier allowlist) and buyers MUST reject onboarding if an advertised algorithm is outside this set.
- **S-6 — Origin separation for JWKS publishing.** Governance signing keys MUST be served from a separate origin than transport and webhook signing keys. Operators advertise the layout via the `identity.key_origins` capability map (schema landed in the paired capabilities PR). When the field is present, verifiers MUST check origin separation at onboarding and reject on co-tenancy — the MUST is otherwise unverifiable on the wire.
- **R-8 — Per-principal key isolation for multi-tenant operators.** Any operator hosting agents for more than one principal MUST scope signing keys per principal (not a fleet-wide key), bind `keyid` unambiguously to the owning principal, and SHOULD advertise this in `identity.per_principal_key_isolation`. `kid` remains opaque to verifiers per RFC 7517 — operator-side bookkeeping conventions like `{operator}:{principal}:{key_version}` MUST NOT be parsed by verifiers for authorization; owning-principal identity is resolved via the signature → JWKS → agent entry chain, not by parsing `kid` structure. R-8 lives as its own bullet in the security-model threats list (split from the shared-governance-agent bullet for scannability).

Docs-only. Field schemas for `webhook_signing` and `identity.{key_origins,per_principal_key_isolation,compromise_notification}` are defined in the paired `get_adcp_capabilities` capability-blocks PR.
