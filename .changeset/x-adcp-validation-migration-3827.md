---
"adcontextprotocol": minor
---

Migrate prose required-when / cross-field rules to the `x-adcp-validation` extension across `get_adcp_capabilities` (closes #3827). Five fields gain machine-readable normative constraints that the storyboard runner and SDK validators can now enforce programmatically; previously these rules lived only in description prose.

**Fields migrated:**
- `request_signing.required_for` — `subset_of: "request_signing.supported_for"` (an operation can't be required without being supported)
- `request_signing.warn_for` — `disjoint_with: "request_signing.required_for"` plus `subset_of: "request_signing.supported_for"` (mutually exclusive with required_for; both must be subsets of supported)
- `webhook_signing.supported` — `verifier_constraints.must_equal_when: { value: true, any_of: [...] }` keyed on `media_buy.reporting_delivery_methods` including `webhook` or `media_buy.content_standards.supports_webhook_delivery: true` (closes a downgrade vector — emitting state-changing webhooks unsigned)
- `identity.key_origins` — `verifier_constraints.purpose_anchoring` mapping each purpose to the signing posture that must be declared elsewhere on the response (e.g., `request_signing` purpose requires non-empty `request_signing.supported_for`/`required_for`)

**Sub-key vocabulary extended** in `docs/reference/schema-extensions.mdx`:
- `forbidden_when` (inverse of `required_when`)
- `disjoint_with` (item-level mutual exclusion across array fields)
- `subset_of` (item-level subset constraint across array fields)

Codegen consumers and JSON Schema validators ignore `x-` keys, so the wire format is unchanged. Storyboard runners that don't yet recognize a sub-key MUST skip it and emit an "unrecognized validation rule" warning per the existing convention.

**Excluded from migration (already enforced natively):**
- `adcp.idempotency` — the discriminated `oneOf` already requires `replay_ttl_seconds` in the supported branch and forbids it in the unsupported branch.
- `webhook_signing.algorithms` — the `enum` on each item already enforces the allowlist.

Backwards compatibility: strictly additive on the wire. Verifiers that ignore `x-adcp-validation` continue to work; the existing prose descriptions still document the rules. Storyboard runners gain enforceable assertions for invariants that were previously prose-only.
