---
---

spec(capabilities): add `webhook_signing` block, origin-separation guidance (`identity.key_origins`), per-principal key isolation (`identity.per_principal_key_isolation`)

Three capability-surface hardening items, split out of closed PR #2466:

- **W-4 — `webhook_signing` block on `get_adcp_capabilities`.** Restores symmetry with `request_signing`: sellers declare whether they sign outbound webhooks, which profile version, which algorithms, and whether the legacy HMAC fallback is supported. Buyers MUST fail onboarding if the block is missing or advertises `supported: false`.
- **S-6 — Origin separation for JWKS publishing.** Governance signing keys MUST be served from a separate origin than transport and webhook signing keys. Operators advertise the layout via a new doc-only `identity.key_origins` capability map so buyers can verify origin separation at onboarding.
- **R-8 — Per-principal key isolation for multi-tenant operators.** Any operator hosting agents for more than one principal MUST scope signing keys per principal (not a fleet-wide key), bind `keyid` unambiguously to the owning principal, and SHOULD advertise this in `identity.per_principal_key_isolation`.

Docs-only. No schema change — the new fields are doc-only conventions in 3.x; a schema addition is on the 4.0 track.
